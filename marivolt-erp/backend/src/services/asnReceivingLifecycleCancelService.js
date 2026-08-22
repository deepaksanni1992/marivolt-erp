/**
 * Canonical ASN receiving lifecycle cancellation — abandon unposted receiving work
 * and release PO asnActiveQty without hard-deleting audit records.
 */
import mongoose from "mongoose";
import AdvanceShipmentNotice from "../models/AdvanceShipmentNotice.js";
import GRN from "../models/GRN.js";
import ReceivingSession from "../models/ReceivingSession.js";
import ReceivingUnit from "../models/ReceivingUnit.js";
import StockLedger from "../models/StockLedger.js";
import CustomsLot from "../models/CustomsLot.js";
import { cancelAsn as cancelAsnDocument } from "./asnService.js";
import { writeAudit } from "./auditService.js";
import { AsnError } from "../utils/asnRules.js";
import { GRN_SOURCE_ASN_RECEIVING } from "../utils/receivingDraftGrnRules.js";
import {
  RU_ACTIVE_STATUSES,
  retireStatusForRu,
} from "../utils/receivingUnitRules.js";

export const ASN_CANCEL_REASON_REQUIRED = "ASN_CANCEL_REASON_REQUIRED";
export const ASN_CANCEL_ALREADY_POSTED = "ASN_CANCEL_ALREADY_POSTED";
export const ASN_CANCEL_STOCK_EFFECT_EXISTS = "ASN_CANCEL_STOCK_EFFECT_EXISTS";
export const ASN_CANCEL_CUSTOMS_EFFECT_EXISTS = "ASN_CANCEL_CUSTOMS_EFFECT_EXISTS";
export const ASN_CANCEL_RESERVATION_CONFLICT = "ASN_CANCEL_RESERVATION_CONFLICT";
export const ASN_CANCEL_RECEIVING_CONFLICT = "ASN_CANCEL_RECEIVING_CONFLICT";
export const ASN_CANCEL_INVALID_TRANSITION = "ASN_CANCEL_INVALID_TRANSITION";
export const ASN_CANCEL_NOT_FOUND = "ASN_NOT_FOUND";

const POSTED_GRN_STATUSES = Object.freeze(["POSTED", "RECEIVED", "PARTIAL_RECEIVED", "CLOSED"]);
const LIFECYCLE_CANCEL_ASN_STATUSES = Object.freeze(["DRAFT", "SHIPPED", "ARRIVED"]);
const SESSION_OPEN_STATUSES = Object.freeze(["DRAFT", "IN_PROGRESS", "COMPLETED"]);

export class AsnReceivingLifecycleCancelError extends Error {
  constructor(message, status = 409, code = "ASN_RECEIVING_LIFECYCLE_CANCEL_ERROR") {
    super(message);
    this.name = "AsnReceivingLifecycleCancelError";
    this.status = status;
    this.statusCode = status;
    this.code = code;
  }
}

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

function sessionOpts(session) {
  return session ? { session } : {};
}

async function loadAsn(companyId, asnId, mongoSession = null) {
  const q = AdvanceShipmentNotice.findOne({ _id: oid(asnId), companyId });
  if (mongoSession) q.session(mongoSession);
  const doc = await q.lean();
  if (!doc) {
    throw new AsnReceivingLifecycleCancelError("ASN not found", 404, ASN_CANCEL_NOT_FOUND);
  }
  return doc;
}

async function listAsnReceivingGrns(companyId, asnId, mongoSession = null) {
  const q = GRN.find({
    companyId,
    $or: [{ asnId: oid(asnId) }, { asnNo: t((await loadAsn(companyId, asnId, mongoSession)).asnNo) }],
    sourceType: GRN_SOURCE_ASN_RECEIVING,
  }).sort({ grnNo: 1 });
  if (mongoSession) q.session(mongoSession);
  return q.lean();
}

async function hasStockEffectForGrn(companyId, grn, mongoSession = null) {
  if (!grn?._id && !grn?.grnNo) return false;
  const q = StockLedger.findOne({
    companyId,
    $or: [
      ...(grn._id ? [{ sourceDocumentId: grn._id, sourceDocumentType: "GRN" }] : []),
      ...(grn.grnNo ? [{ referenceType: "GRN", referenceNo: grn.grnNo }] : []),
    ],
  })
    .select("_id")
    .lean();
  if (mongoSession) q.session(mongoSession);
  return Boolean(await q);
}

async function hasActiveCustomsEffectForGrn(companyId, grn, mongoSession = null) {
  if (!grn?._id && !grn?.grnNo) return false;
  const q = CustomsLot.findOne({
    companyId,
    $or: [...(grn._id ? [{ grnId: grn._id }] : []), ...(grn.grnNo ? [{ grnNo: grn.grnNo }] : [])],
    status: { $ne: "CANCELLED" },
  })
    .select("_id status")
    .lean();
  if (mongoSession) q.session(mongoSession);
  return Boolean(await q);
}

/**
 * Read-only eligibility for abandoning unposted ASN receiving lifecycle.
 */
export async function evaluateAsnReceivingLifecycleCancelEligibility(companyId, asnId) {
  const asn = await loadAsn(companyId, asnId);
  const blockers = [];
  const asnStatus = String(asn.status || "").toUpperCase();

  if (asnStatus === "CANCELLED") {
    return {
      eligible: true,
      alreadyCancelled: true,
      asn,
      blockers: [],
      grns: await listAsnReceivingGrns(companyId, asnId),
      sessions: await ReceivingSession.find({ companyId, asnId: asn._id }).lean(),
      receivingUnits: await ReceivingUnit.find({ companyId, asnId: asn._id }).sort({ ruNo: 1 }).lean(),
    };
  }

  if (!LIFECYCLE_CANCEL_ASN_STATUSES.includes(asnStatus)) {
    blockers.push({
      code: ASN_CANCEL_INVALID_TRANSITION,
      message: `Cannot abandon receiving lifecycle for ASN in status ${asnStatus}`,
    });
  }

  const grns = await listAsnReceivingGrns(companyId, asnId);
  const posted = grns.filter((g) => POSTED_GRN_STATUSES.includes(String(g.status || "").toUpperCase()));
  if (posted.length) {
    blockers.push({
      code: ASN_CANCEL_ALREADY_POSTED,
      message: `Posted GRN(s) exist (${posted.map((g) => g.grnNo).join(", ")}); use GRN cancellation/reversal`,
    });
  }

  for (const grn of grns) {
    if (await hasStockEffectForGrn(companyId, grn)) {
      blockers.push({
        code: ASN_CANCEL_STOCK_EFFECT_EXISTS,
        message: `Stock ledger effects exist for GRN ${grn.grnNo}`,
      });
      break;
    }
    if (await hasActiveCustomsEffectForGrn(companyId, grn)) {
      blockers.push({
        code: ASN_CANCEL_CUSTOMS_EFFECT_EXISTS,
        message: `Customs lot exists for GRN ${grn.grnNo}`,
      });
      break;
    }
  }

  const sessions = await ReceivingSession.find({ companyId, asnId: asn._id }).sort({ createdAt: 1 }).lean();
  const receivingUnits = await ReceivingUnit.find({ companyId, asnId: asn._id }).sort({ ruNo: 1 }).lean();

  return {
    eligible: blockers.length === 0,
    alreadyCancelled: false,
    asn,
    blockers,
    grns,
    sessions,
    receivingUnits,
  };
}

async function cancelDraftGrnsForAsn({
  req,
  companyId,
  asnId,
  reason,
  mongoSession,
} = {}) {
  const actor = actorName(req);
  const now = new Date();
  const prefix = `ASN_LIFECYCLE_CANCEL: ${reason}`.slice(0, 2000);
  const drafts = await GRN.find({
    companyId,
    asnId: oid(asnId),
    status: "DRAFT",
    sourceType: GRN_SOURCE_ASN_RECEIVING,
  }).session(mongoSession || undefined);

  const cancelled = [];
  for (const draft of drafts) {
    const updated = await GRN.findOneAndUpdate(
      { _id: draft._id, companyId, status: "DRAFT" },
      {
        $set: {
          status: "CANCELLED",
          cancelledAt: now,
          cancellationReason: prefix,
          updatedBy: actor,
        },
      },
      { new: true, ...sessionOpts(mongoSession) },
    );
    if (updated) cancelled.push(updated);
  }
  return cancelled;
}

async function cancelReceivingSessionsForAsn({
  companyId,
  asnId,
  actor,
  mongoSession,
} = {}) {
  const now = new Date();
  const res = await ReceivingSession.updateMany(
    {
      companyId,
      asnId: oid(asnId),
      status: { $in: [...SESSION_OPEN_STATUSES] },
    },
    {
      $set: {
        status: "CANCELLED",
        lastActivityBy: actor,
        lastActivityAt: now,
      },
    },
    sessionOpts(mongoSession),
  );
  return Number(res.modifiedCount) || 0;
}

async function retireReceivingUnitsForAsn({
  companyId,
  asnId,
  reason,
  actor,
  mongoSession,
} = {}) {
  const now = new Date();
  const rus = await ReceivingUnit.find({
    companyId,
    asnId: oid(asnId),
    status: { $in: [...RU_ACTIVE_STATUSES] },
  }).session(mongoSession || undefined);

  const retired = [];
  for (const ru of rus) {
    const nextStatus = retireStatusForRu(ru);
    const updated = await ReceivingUnit.findOneAndUpdate(
      { _id: ru._id, companyId, status: { $in: [...RU_ACTIVE_STATUSES] } },
      {
        $set: {
          status: nextStatus === "SUPERSEDED" ? "CANCELLED" : nextStatus,
          cancelledAt: now,
          cancelledBy: actor,
          cancelReason: `ASN lifecycle cancelled — ${reason}`.slice(0, 2000),
        },
      },
      { new: true, ...sessionOpts(mongoSession) },
    );
    if (updated) retired.push(updated);
  }
  return retired;
}

/**
 * Abandon unposted ASN receiving lifecycle and cancel ASN with PO reservation release.
 */
export async function cancelAsnReceivingLifecycle(req, asnId, body = {}) {
  const companyId = req.companyId;
  const reason = t(body.reason || body.cancellationReason);
  if (!reason) {
    throw new AsnReceivingLifecycleCancelError(
      "Cancellation reason is required",
      400,
      ASN_CANCEL_REASON_REQUIRED,
    );
  }

  const pre = await evaluateAsnReceivingLifecycleCancelEligibility(companyId, asnId);
  if (pre.alreadyCancelled) {
    return {
      alreadyCancelled: true,
      asn: pre.asn,
      grns: pre.grns,
      sessions: pre.sessions,
      receivingUnits: pre.receivingUnits,
      releasedLines: [],
    };
  }
  if (!pre.eligible) {
    const top = pre.blockers[0];
    throw new AsnReceivingLifecycleCancelError(
      top?.message || "ASN receiving lifecycle cannot be cancelled",
      409,
      top?.code || ASN_CANCEL_RECEIVING_CONFLICT,
    );
  }

  const mongoSession = await mongoose.startSession();
  let result;
  try {
    await mongoSession.withTransaction(async () => {
      const eligibility = await evaluateAsnReceivingLifecycleCancelEligibility(companyId, asnId);
      if (!eligibility.eligible) {
        const top = eligibility.blockers[0];
        throw new AsnReceivingLifecycleCancelError(
          top?.message || "ASN receiving lifecycle cannot be cancelled",
          409,
          top?.code || ASN_CANCEL_RECEIVING_CONFLICT,
        );
      }

      const actor = actorName(req);
      const cancelledDraftGrns = await cancelDraftGrnsForAsn({
        req,
        companyId,
        asnId,
        reason,
        mongoSession,
      });
      const sessionsCancelled = await cancelReceivingSessionsForAsn({
        companyId,
        asnId,
        actor,
        mongoSession,
      });
      const retiredRus = await retireReceivingUnitsForAsn({
        companyId,
        asnId,
        reason,
        actor,
        mongoSession,
      });

      let cancelledAsn;
      try {
        cancelledAsn = await cancelAsnDocument(
          req,
          asnId,
          { reason, cancellationReason: reason },
          { guard: "ASN_CANCEL_POLICY", session: mongoSession },
        );
      } catch (err) {
        if (err instanceof AsnError && err.code === "ASN_RESERVATION_RESTORE_CONFLICT") {
          throw new AsnReceivingLifecycleCancelError(err.message, err.status || 409, ASN_CANCEL_RESERVATION_CONFLICT);
        }
        throw err;
      }

      result = {
        alreadyCancelled: false,
        asn: cancelledAsn,
        cancelledDraftGrns: cancelledDraftGrns.map((g) => ({
          grnNo: g.grnNo,
          status: g.status,
        })),
        sessionsCancelled,
        retiredRuNos: retiredRus.map((ru) => ru.ruNo),
        releasedLines: (eligibility.asn.lines || []).map((ln) => ({
          poLineId: String(ln.poLineId || ""),
          article: ln.article,
          releasedQty: Number(ln.asnQty) || 0,
        })),
      };

      await writeAudit(req, {
        action: "ASN_RECEIVING_LIFECYCLE_CANCELLED",
        module: "ASN",
        entityType: "ASN",
        entityId: cancelledAsn._id,
        documentNo: cancelledAsn.asnNo,
        description: `ASN ${cancelledAsn.asnNo} receiving lifecycle cancelled`,
        metadata: {
          reason,
          cancelledDraftGrns: result.cancelledDraftGrns,
          sessionsCancelled,
          retiredRuNos: result.retiredRuNos,
          releasedLines: result.releasedLines,
        },
      });
    });
  } finally {
    await mongoSession.endSession();
  }

  return result;
}
