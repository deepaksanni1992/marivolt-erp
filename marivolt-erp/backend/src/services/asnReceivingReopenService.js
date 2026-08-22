/**
 * Controlled Reopen Receiving — correct completed receiving while Draft GRN exists.
 * Does not re-prepare RUs, reprint labels, or reverse posted GRNs.
 */
import mongoose from "mongoose";
import GRN from "../models/GRN.js";
import ReceivingSession from "../models/ReceivingSession.js";
import ReceivingSessionUnit from "../models/ReceivingSessionUnit.js";
import StockLedger from "../models/StockLedger.js";
import CustomsLot from "../models/CustomsLot.js";
import { writeAudit } from "./auditService.js";
import { ReceivingInspectionError } from "../utils/receivingInspectionRules.js";
import { isAsnReceivingGrn } from "../utils/receivingDraftGrnRules.js";
import { resolveAsnReceivingSource } from "./asnReceivingSourceResolver.js";

export const RECEIVING_REOPEN_REASON_REQUIRED = "RECEIVING_REOPEN_REASON_REQUIRED";
export const RECEIVING_REOPEN_UNIT_REQUIRED = "RECEIVING_REOPEN_UNIT_REQUIRED";
export const RECEIVING_REOPEN_NOT_ELIGIBLE = "RECEIVING_REOPEN_NOT_ELIGIBLE";
export const RECEIVING_REOPEN_CONFLICT = "RECEIVING_REOPEN_CONFLICT";
export const RECEIVING_REOPEN_BLOCKED_POSTED = "RECEIVING_REOPEN_BLOCKED_POSTED";
export const RECEIVING_REOPEN_BLOCKED_STOCK = "RECEIVING_REOPEN_BLOCKED_STOCK";
export const RECEIVING_REOPEN_BLOCKED_CUSTOMS = "RECEIVING_REOPEN_BLOCKED_CUSTOMS";

function t(v) {
  return String(v ?? "").trim();
}

function actorName(req) {
  return t(req?.user?.email || req?.user?.name || req?.user?.username || "system");
}

function oid(id) {
  if (!id) return null;
  if (id instanceof mongoose.Types.ObjectId) return id;
  const s = String(id);
  return mongoose.Types.ObjectId.isValid(s) ? new mongoose.Types.ObjectId(s) : null;
}

function normalizeSessionUnitIds(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const id of raw) {
    const oidVal = oid(id);
    if (!oidVal) continue;
    const key = String(oidVal);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(oidVal);
  }
  return out;
}

/**
 * Resolve and validate selected session units for selective reopen.
 */
async function resolveReopenSessionUnits({
  companyId,
  receivingSessionId,
  receivingSessionUnitIds,
  session = null,
} = {}) {
  const sid = oid(receivingSessionId);
  const ids = normalizeSessionUnitIds(receivingSessionUnitIds);
  if (!ids.length) {
    throw new ReceivingInspectionError(
      "Select at least one completed Receiving Unit to reopen",
      400,
      RECEIVING_REOPEN_UNIT_REQUIRED,
    );
  }

  const q = ReceivingSessionUnit.find({
    companyId,
    receivingSessionId: sid,
    _id: { $in: ids },
  });
  if (session) q.session(session);
  const units = await q.lean();

  if (units.length !== ids.length) {
    throw new ReceivingInspectionError(
      "One or more selected Receiving Units are not part of this receiving session",
      400,
      RECEIVING_REOPEN_NOT_ELIGIBLE,
    );
  }

  const invalid = units.filter((u) => String(u.status || "").toUpperCase() !== "COMPLETED");
  if (invalid.length) {
    throw new ReceivingInspectionError(
      "Only completed Receiving Units can be reopened for correction",
      409,
      RECEIVING_REOPEN_NOT_ELIGIBLE,
    );
  }

  return { ids, units };
}

/**
 * Pure eligibility (no writes). Backend enforces again inside the transaction.
 */
export async function evaluateReopenReceivingEligibility({
  companyId,
  receivingSessionId,
  session = null,
} = {}) {
  const blockers = [];
  const sid = oid(receivingSessionId);
  if (!sid) {
    return { eligible: false, blockers: [{ code: RECEIVING_REOPEN_NOT_ELIGIBLE, message: "Receiving session is required" }] };
  }

  const qSession = ReceivingSession.findOne({ _id: sid, companyId });
  if (session) qSession.session(session);
  const receivingSession = await qSession.lean();
  if (!receivingSession) {
    return { eligible: false, blockers: [{ code: RECEIVING_REOPEN_NOT_ELIGIBLE, message: "Receiving session not found" }] };
  }
  if (String(receivingSession.status || "").toUpperCase() !== "COMPLETED") {
    blockers.push({
      code: RECEIVING_REOPEN_NOT_ELIGIBLE,
      message: "Reopen Receiving is only allowed when receiving status is COMPLETED",
    });
  }

  const qGrn = GRN.findOne({
    companyId,
    receivingSessionId: sid,
    sourceType: "ASN_RECEIVING",
  }).sort({ createdAt: -1 });
  if (session) qGrn.session(session);
  const grn = await qGrn.lean();

  if (!grn) {
    blockers.push({
      code: RECEIVING_REOPEN_NOT_ELIGIBLE,
      message: "No ASN receiving GRN found for this session",
    });
  } else {
    const st = String(grn.status || "").toUpperCase();
    if (st === "POSTED" || st === "RECEIVED" || st === "PARTIAL_RECEIVED" || st === "CLOSED") {
      blockers.push({
        code: RECEIVING_REOPEN_BLOCKED_POSTED,
        message: "Posted GRNs cannot reopen receiving; use GRN cancellation/reversal",
      });
    } else if (st !== "DRAFT") {
      blockers.push({
        code: RECEIVING_REOPEN_NOT_ELIGIBLE,
        message: `GRN status ${st} cannot reopen receiving (DRAFT required)`,
      });
    }

    if (grn._id) {
      const stockQ = StockLedger.findOne({
        companyId,
        $or: [
          { sourceDocumentId: grn._id, sourceDocumentType: "GRN" },
          { referenceType: "GRN", referenceNo: grn.grnNo },
        ],
      }).select("_id").lean();
      if (session) stockQ.session(session);
      const stockHit = await stockQ;
      if (stockHit) {
        blockers.push({
          code: RECEIVING_REOPEN_BLOCKED_STOCK,
          message: "Stock ledger effects exist for this GRN; reopen is blocked",
        });
      }

      const lotQ = CustomsLot.findOne({
        companyId,
        $or: [{ grnId: grn._id }, { grnNo: grn.grnNo }],
      })
        .select("_id status")
        .lean();
      if (session) lotQ.session(session);
      const lot = await lotQ;
      if (lot && String(lot.status || "").toUpperCase() !== "CANCELLED") {
        blockers.push({
          code: RECEIVING_REOPEN_BLOCKED_CUSTOMS,
          message: "Customs lot exists for this GRN; reopen is blocked",
        });
      }
    }
  }

  return {
    eligible: blockers.length === 0,
    blockers,
    receivingSession,
    draftGrn: grn && String(grn.status || "").toUpperCase() === "DRAFT" ? grn : null,
    grn,
  };
}

/**
 * Atomic selective reopen: cancel Draft GRN → session IN_PROGRESS → selected units editable.
 */
export async function reopenReceivingSession(req, sessionId, { reason, receivingSessionUnitIds } = {}) {
  const reasonText = t(reason);
  if (!reasonText) {
    throw new ReceivingInspectionError(
      "Reason for reopening receiving is required",
      400,
      RECEIVING_REOPEN_REASON_REQUIRED,
    );
  }
  if (reasonText.length > 2000) {
    throw new ReceivingInspectionError("Reopen reason is too long", 400, RECEIVING_REOPEN_REASON_REQUIRED);
  }

  const companyId = req.companyId;
  const sid = oid(sessionId);
  if (!sid) {
    throw new ReceivingInspectionError("Invalid receiving session", 400, RECEIVING_REOPEN_NOT_ELIGIBLE);
  }

  const pre = await evaluateReopenReceivingEligibility({ companyId, receivingSessionId: sid });
  if (!pre.eligible) {
    const top = pre.blockers[0];
    throw new ReceivingInspectionError(top.message, 409, top.code || RECEIVING_REOPEN_NOT_ELIGIBLE);
  }

  await resolveReopenSessionUnits({
    companyId,
    receivingSessionId: sid,
    receivingSessionUnitIds,
  });

  const mongoSession = await mongoose.startSession();
  let result;
  try {
    await mongoSession.withTransaction(async () => {
      const eligibility = await evaluateReopenReceivingEligibility({
        companyId,
        receivingSessionId: sid,
        session: mongoSession,
      });
      if (!eligibility.eligible || !eligibility.draftGrn) {
        const top = eligibility.blockers[0] || {
          code: RECEIVING_REOPEN_CONFLICT,
          message: "Receiving reopen eligibility changed",
        };
        throw new ReceivingInspectionError(top.message, 409, top.code || RECEIVING_REOPEN_CONFLICT);
      }

      const draftGrn = eligibility.draftGrn;
      if (!isAsnReceivingGrn(draftGrn)) {
        throw new ReceivingInspectionError(
          "Only ASN_RECEIVING Draft GRNs can be invalidated by reopen",
          409,
          RECEIVING_REOPEN_NOT_ELIGIBLE,
        );
      }

      const { ids: selectedUnitIds, units: selectedUnits } = await resolveReopenSessionUnits({
        companyId,
        receivingSessionId: sid,
        receivingSessionUnitIds,
        session: mongoSession,
      });

      // Invalidate Draft GRN (CANCELLED leaves unique session slot free for a new DRAFT).
      const cancelled = await GRN.findOneAndUpdate(
        {
          _id: draftGrn._id,
          companyId,
          status: "DRAFT",
          receivingSessionId: sid,
        },
        {
          $set: {
            status: "CANCELLED",
            cancelledAt: new Date(),
            cancellationReason: `REOPEN_RECEIVING: ${reasonText}`.slice(0, 2000),
            updatedBy: actorName(req),
          },
        },
        { new: true, session: mongoSession },
      );
      if (!cancelled) {
        throw new ReceivingInspectionError(
          "Draft GRN changed during reopen; try again",
          409,
          RECEIVING_REOPEN_CONFLICT,
        );
      }

      const actor = actorName(req);
      const now = new Date();
      const sessionDoc = await ReceivingSession.findOneAndUpdate(
        {
          _id: sid,
          companyId,
          status: "COMPLETED",
        },
        {
          $set: {
            status: "IN_PROGRESS",
            completedBy: "",
            completedAt: null,
            lastActivityBy: actor,
            lastActivityAt: now,
          },
        },
        { new: true, session: mongoSession },
      );
      if (!sessionDoc) {
        throw new ReceivingInspectionError(
          "Receiving session is no longer COMPLETED; reopen conflict",
          409,
          RECEIVING_REOPEN_CONFLICT,
        );
      }

      // Reopen only selected completed session units — same RU identities.
      const unitRes = await ReceivingSessionUnit.updateMany(
        {
          companyId,
          receivingSessionId: sid,
          _id: { $in: selectedUnitIds },
          status: "COMPLETED",
        },
        {
          $set: {
            status: "IN_PROGRESS",
            completedBy: "",
            completedAt: null,
            lastSavedBy: actor,
            lastSavedAt: now,
          },
          $inc: { version: 1 },
        },
        { session: mongoSession },
      );

      if (Number(unitRes.modifiedCount) !== selectedUnitIds.length) {
        throw new ReceivingInspectionError(
          "One or more selected Receiving Units changed during reopen; try again",
          409,
          RECEIVING_REOPEN_CONFLICT,
        );
      }

      const units = await ReceivingSessionUnit.find({
        companyId,
        receivingSessionId: sid,
      })
        .session(mongoSession)
        .lean();

      const reopenedRuNos = selectedUnits.map((u) => u.ruNo);

      result = {
        session: {
          _id: sessionDoc._id,
          sessionNo: sessionDoc.sessionNo,
          status: sessionDoc.status,
          asnId: sessionDoc.asnId,
          asnNo: sessionDoc.asnNo,
        },
        invalidatedGrn: {
          _id: cancelled._id,
          grnNo: cancelled.grnNo,
          status: cancelled.status,
        },
        unitsReopened: Number(unitRes.modifiedCount) || 0,
        reopenedSessionUnitIds: selectedUnitIds.map(String),
        reopenedRuNos,
        receivingUnits: units.map((u) => ({
          _id: u._id,
          receivingUnitId: u.receivingUnitId,
          ruNo: u.ruNo,
          status: u.status,
          actualUnitWeightKg: u.actualUnitWeightKg ?? null,
          acceptedQty: u.acceptedQty,
        })),
        reason: reasonText,
        message: "RECEIVING REOPENED FOR CORRECTION",
      };

      await writeAudit(req, {
        action: "RECEIVING_REOPENED",
        module: "STORE",
        entityType: "ReceivingSession",
        entityId: sessionDoc._id,
        documentNo: sessionDoc.sessionNo,
        description: `Receiving ${sessionDoc.sessionNo} reopened; Draft GRN ${cancelled.grnNo} invalidated`,
        metadata: {
          companyId: String(companyId),
          asnId: String(sessionDoc.asnId || ""),
          asnNo: sessionDoc.asnNo || "",
          receivingSessionId: String(sessionDoc._id),
          receivingSessionNo: sessionDoc.sessionNo,
          invalidatedGrnId: String(cancelled._id),
          invalidatedGrnNo: cancelled.grnNo,
          reopenedSessionUnitIds: selectedUnitIds.map(String),
          ruNos: reopenedRuNos,
          reason: reasonText,
          actor,
          timestamp: now.toISOString(),
        },
      });
    });
  } finally {
    await mongoSession.endSession();
  }

  // Ensure ASN source still resolves after reopen (sanity).
  await resolveAsnReceivingSource({
    companyId,
    receivingSessionId: sid,
  });

  return result;
}
