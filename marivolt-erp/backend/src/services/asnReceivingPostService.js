/**
 * Phase 4C — post an existing ASN_RECEIVING Draft GRN.
 * Reuses shared GRN stock/PO/customs effects. Authority: GRN → ASN → PO.
 */
import mongoose from "mongoose";
import GRN from "../models/GRN.js";
import AdvanceShipmentNotice from "../models/AdvanceShipmentNotice.js";
import PurchaseOrder from "../models/PurchaseOrder.js";
import { actorName, assertSystemAsnReceivingStatus, roundAsnQty } from "../utils/asnRules.js";
import { releasePoLineAsnQty, restorePoLineAsnQty } from "./asnService.js";
import {
  GRN_POSTED_FOR_RECEIPT_QTY,
  getOpenDraftAcceptedQtyByPoLineMap,
  getPostedAcceptedQtyByPoLineMap,
} from "../utils/grnReceiptQty.js";
import {
  GRN_DRAFT_ENTITLEMENT_CHANGED,
  ReceivingDraftGrnError,
  isAsnReceivingGrn,
} from "../utils/receivingDraftGrnRules.js";
import {
  assertArticleMatchesAsnLine,
  assertAsnDraftEntitlementStillHolds,
  assertAsnGrnReceivingSourcesMatchEvidence,
  assertPostTimeReceivingSession,
  asnReservationReleaseQty,
  buildCustomsPostBodyFromGrn,
  isPostedGrnStatus,
  maybeFailAsnGrnPost,
  stockQtyFromAsnGrnItem,
  summarizeAsnGrnDiscrepancies,
} from "../utils/asnReceivingPostRules.js";
import { PoReceiptClaimError } from "../utils/poReceiptClaim.js";
import {
  assertAsnReceivingGrnSnapshots,
  resolveAsnReceivingSource,
} from "./asnReceivingSourceResolver.js";
import { buildReceivingRows } from "./asnReceivingDraftService.js";
import {
  applyReceiveToPo,
  ensureDefaultGrnStockLocation,
  receiveGrnItemIntoStock,
} from "./grnPostingEffects.js";
import { writeAudit, writeStatusChange } from "./auditService.js";
import {
  createCustomsLotFromGrn,
  hasCustomsPayload,
  isCustomsEnabled,
  reverseCustomsLotForCancelledGrn,
} from "./customsService.js";

function idStr(v) {
  return v == null || v === "" ? "" : String(v);
}

async function loadEntitlementMaps(companyId, poId, { excludeGrnId = null, mongoSession = null } = {}) {
  const postedByPoLine = await getPostedAcceptedQtyByPoLineMap(GRN, {
    companyId,
    poId,
    session: mongoSession,
  });
  const otherDraftByPoLine = await getOpenDraftAcceptedQtyByPoLineMap(GRN, {
    companyId,
    poId,
    excludeGrnId,
    session: mongoSession,
  });
  return { postedByPoLine, otherDraftByPoLine };
}

export async function applySystemAsnStatus({ companyId, asnId, fromStatus, toStatus, session = null }) {
  assertSystemAsnReceivingStatus(fromStatus, toStatus);
  const q = AdvanceShipmentNotice.findOneAndUpdate(
    { _id: asnId, companyId, status: fromStatus },
    { $set: { status: toStatus, updatedAt: new Date() } },
    { new: true }
  );
  if (session) q.session(session);
  const updated = await q;
  if (!updated) {
    throw new ReceivingDraftGrnError(
      `ASN status could not be changed from ${fromStatus} to ${toStatus}`,
      409,
      "ASN_STATUS_CONFLICT"
    );
  }
  return updated;
}

async function releaseAsnReservationForPostedGrn({ source, session }) {
  const po = await PurchaseOrder.findOne({ _id: source.po._id, companyId: source.po.companyId }).session(session);
  if (!po) return { released: [] };
  const released = [];
  for (const asnLine of source.asn.lines || []) {
    const qty = asnReservationReleaseQty(asnLine);
    if (!(qty > 0)) continue;
    await releasePoLineAsnQty({
      po,
      poLineId: asnLine.poLineId,
      qty,
      session,
    });
    released.push({ asnLineId: asnLine._id, poLineId: asnLine.poLineId, qty });
  }
  return { released };
}

async function restoreAsnReservationForCancelledGrn({ source, grn, session }) {
  const po = await PurchaseOrder.findOne({ _id: source.po._id, companyId: source.po.companyId }).session(session);
  if (!po) return;
  const reversalByPoLine = new Map();
  for (const item of grn?.items || []) {
    if (!item.poLineId) continue;
    const key = idStr(item.poLineId);
    reversalByPoLine.set(key, roundAsnQty((reversalByPoLine.get(key) || 0) + (Number(item.acceptedQty) || 0)));
  }
  let working = po;
  for (const asnLine of source.asn.lines || []) {
    const qty = asnReservationReleaseQty(asnLine);
    if (!(qty > 0)) continue;
    working = await restorePoLineAsnQty({
      po: working,
      poLineId: asnLine.poLineId,
      qty,
      receivedReversalQty: reversalByPoLine.get(idStr(asnLine.poLineId)) || 0,
      session,
    });
  }
}

function postingResult(grn, extra = {}) {
  return {
    success: true,
    grnNo: grn.grnNo,
    status: grn.status,
    sourceType: grn.sourceType,
    asnNo: grn.asnNo,
    poNo: grn.poNo,
    ...extra,
  };
}

export async function postAsnReceivingDraftGrn(req, grnNo) {
  const session = await mongoose.startSession();
  let result = null;
  try {
    await session.withTransaction(async () => {
      const grn = await GRN.findOne({
        companyId: req.companyId,
        grnNo: String(grnNo || "").trim().toUpperCase(),
      }).session(session);
      if (!grn) throw new ReceivingDraftGrnError("GRN not found", 404, "GRN_NOT_FOUND");
      if (!isAsnReceivingGrn(grn)) {
        throw new ReceivingDraftGrnError("Not an ASN receiving GRN", 400, "ASN_GRN_REQUIRED");
      }
      if (isPostedGrnStatus(grn.status)) {
        result = postingResult(grn, { idempotent: true });
        return;
      }
      if (String(grn.status || "").toUpperCase() !== "DRAFT") {
        throw new ReceivingDraftGrnError("Only DRAFT GRN can be received", 400, "GRN_NOT_DRAFT");
      }

      maybeFailAsnGrnPost("validate");
      const source = await resolveAsnReceivingSource({
        companyId: req.companyId,
        receivingSessionId: grn.receivingSessionId,
        mongoSession: session,
      });
      assertAsnReceivingGrnSnapshots(grn, source);
      assertPostTimeReceivingSession(source.receivingSession);
      const { rows } = await buildReceivingRows(req.companyId, source);
      assertAsnGrnReceivingSourcesMatchEvidence(grn, rows);
      for (const item of grn.items || []) {
        const asnLine = source.asnLineById.get(idStr(item.asnLineId));
        assertArticleMatchesAsnLine(item, asnLine);
      }

      const maps = await loadEntitlementMaps(req.companyId, source.po._id, {
        excludeGrnId: grn._id,
        mongoSession: session,
      });
      const entitlementReview = assertAsnDraftEntitlementStillHolds(grn, {
        poLineByAsnLineId: source.poLineByAsnLineId,
        poLineIdByAsnLineId: source.poLineIdByAsnLineId,
        ...maps,
      });

      maybeFailAsnGrnPost("claim_po");
      // ASN_RECEIVING never reads STORE_ALLOW_GRN_OVER_PO. Entitlement is hard-capped.
      await applyReceiveToPo({ session, req, grn, allowOverPo: false });

      maybeFailAsnGrnPost("stock");
      await ensureDefaultGrnStockLocation(req, session);
      for (const line of grn.items || []) {
        const stockQty = stockQtyFromAsnGrnItem(line);
        if (!(stockQty > 0)) continue;
        const qtyLine = { ...((typeof line.toObject === "function" ? line.toObject() : line) || {}), acceptedQty: stockQty };
        const { recoveryInfo } = await receiveGrnItemIntoStock({
          session,
          req,
          grn,
          line: qtyLine,
          sourcePo: source.po,
          provenance: {
            asnId: source.asn._id,
            asnNo: source.asn.asnNo,
            receivingSessionId: source.receivingSession._id,
          },
        });
        line.recoveryInfo = recoveryInfo;
      }

      maybeFailAsnGrnPost("customs");
      if (isCustomsEnabled()) {
        const customsBody = buildCustomsPostBodyFromGrn(grn);
        if (hasCustomsPayload(customsBody)) {
          await createCustomsLotFromGrn({
            session,
            req,
            grn,
            body: customsBody,
            poDate: source.po.poDate || source.po.orderDate || null,
          });
        }
      }

      maybeFailAsnGrnPost("grn_status");
      const discrepancies = summarizeAsnGrnDiscrepancies(grn, rows);
      grn.status = "RECEIVED";
      grn.approvalStatus = "APPROVED";
      grn.postedAt = new Date();
      grn.updatedBy = req.user?.email || actorName(req);
      await grn.save({ session });

      maybeFailAsnGrnPost("asn_release");
      const reservation = await releaseAsnReservationForPostedGrn({ source, session });

      maybeFailAsnGrnPost("asn_completed");
      const asnFrom = String(source.asn.status || "").toUpperCase();
      await applySystemAsnStatus({
        companyId: req.companyId,
        asnId: source.asn._id,
        fromStatus: asnFrom,
        toStatus: "COMPLETED",
        session,
      });

      await writeStatusChange(req, {
        module: "STORE",
        entityType: "GRN",
        entityId: grn._id,
        documentNo: grn.grnNo,
        fromStatus: "DRAFT",
        toStatus: grn.status,
        description: `ASN receiving GRN ${grn.grnNo} posted`,
      });
      await writeAudit(req, {
        action: "ASN_RECEIVING_GRN_POSTED",
        module: "STORE",
        entityType: "GRN",
        entityId: grn._id,
        documentNo: grn.grnNo,
        fromStatus: "DRAFT",
        toStatus: grn.status,
        description: `ASN receiving GRN ${grn.grnNo} posted`,
        metadata: {
          receivingSessionId: idStr(grn.receivingSessionId),
          receivingSessionNo: grn.receivingSessionNo,
          asnId: idStr(grn.asnId),
          asnNo: grn.asnNo,
          poId: idStr(grn.poId),
          poNo: grn.poNo,
          acceptedToStock: discrepancies.acceptedToStock,
          damagedQty: discrepancies.damagedQty,
          rejectedQty: discrepancies.rejectedQty,
          shortQty: discrepancies.shortQty,
          excessPendingQty: discrepancies.excessPendingQty,
          asnReservationReleased: reservation.released,
          asnStatus: "COMPLETED",
        },
      });

      result = postingResult(grn, {
        idempotent: false,
        acceptedToStock: discrepancies.acceptedToStock,
        discrepancies,
        asnStatus: "COMPLETED",
        entitlementReview,
      });
    });
    return result;
  } catch (err) {
    if (err instanceof PoReceiptClaimError) {
      throw new ReceivingDraftGrnError(err.message, 409, GRN_DRAFT_ENTITLEMENT_CHANGED);
    }
    throw err;
  } finally {
    await session.endSession();
  }
}

export async function reverseAsnReceivingPostedGrn(req, grn, { session } = {}) {
  maybeFailAsnGrnPost("restore");
  const source = await resolveAsnReceivingSource({
    companyId: req.companyId,
    receivingSessionId: grn.receivingSessionId,
    mongoSession: session,
  });
  assertAsnReceivingGrnSnapshots(grn, source);
  await restoreAsnReservationForCancelledGrn({ source, grn, session });
  const asnFrom = String(source.asn.status || "").toUpperCase();
  if (asnFrom === "COMPLETED") {
    await applySystemAsnStatus({
      companyId: req.companyId,
      asnId: source.asn._id,
      fromStatus: "COMPLETED",
      toStatus: "ARRIVED",
      session,
    });
  }
  await writeAudit(req, {
    action: "ASN_RECEIVING_GRN_REVERSED",
    module: "STORE",
    entityType: "GRN",
    entityId: grn._id,
    documentNo: grn.grnNo,
    description: `ASN receiving GRN ${grn.grnNo} reversed`,
    metadata: {
      receivingSessionId: idStr(grn.receivingSessionId),
      asnId: idStr(grn.asnId),
      asnNo: grn.asnNo,
      poId: idStr(grn.poId),
      poNo: grn.poNo,
      asnStatus: "ARRIVED",
    },
  });
}
