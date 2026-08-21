/**
 * Phase 4C — ASN receiving GRN post rules (pure).
 * Stock/customs/PO effects are applied by asnReceivingPostService using the
 * existing GRN posting engine. This file does not post.
 */
import { ASN_QTY_EPS, asnClaimFitsLine, canRestoreAsnReservation, roundAsnQty } from "./asnRules.js";
import { receivingQtyEq } from "./receivingInspectionRules.js";
import {
  ASN_GRN_SOURCE_MISMATCH,
  GRN_DRAFT_ENTITLEMENT_CHANGED,
  ReceivingDraftGrnError,
  assertExcessSourceInvariants,
  assertReceivingSourcesMatchLineAccepted,
  computeAsnDraftEntitlementReview,
  entitlementForAsnLine,
} from "./receivingDraftGrnRules.js";
import { isCustomsCaptureActive } from "./customsGrnFieldModel.js";

export const ASN_GRN_POST_STEPS = Object.freeze([
  "validate",
  "claim_po",
  "stock",
  "customs",
  "grn_status",
  "asn_release",
  "asn_completed",
]);

let injectedFailAt = "";

export function setAsnGrnPostFailPoint(step = "") {
  injectedFailAt = String(step || "");
  return injectedFailAt;
}

export function getAsnGrnPostFailPoint() {
  return injectedFailAt;
}

export function maybeFailAsnGrnPost(step) {
  if (injectedFailAt && String(step) === injectedFailAt) {
    throw new ReceivingDraftGrnError(
      `ASN GRN post injected failure at ${step}`,
      500,
      "ASN_GRN_POST_INJECTED_FAILURE"
    );
  }
}

function idStr(value) {
  if (value == null || value === "") return "";
  return String(value);
}

export function isPostedGrnStatus(status) {
  const s = String(status || "").toUpperCase();
  return s === "RECEIVED" || s === "PARTIAL_RECEIVED" || s === "POSTED" || s === "CLOSED";
}

export function stockQtyFromAsnGrnItem(item) {
  return roundAsnQty(
    (item?.receivingSources || []).reduce((s, src) => s + (Number(src.grnAcceptedQty) || 0), 0)
  );
}

export function summarizeAsnGrnDiscrepancies(grn, receivingRows = []) {
  const byRu = new Map((receivingRows || []).map((r) => [idStr(r.receivingUnitId), r]));
  let damagedQty = 0;
  let rejectedQty = 0;
  let shortQty = 0;
  let excessPendingQty = 0;
  let acceptedToStock = 0;
  for (const item of grn?.items || []) {
    acceptedToStock = roundAsnQty(acceptedToStock + stockQtyFromAsnGrnItem(item));
    for (const src of item.receivingSources || []) {
      excessPendingQty = roundAsnQty(excessPendingQty + (Number(src.excessPendingQty) || 0));
      const row = byRu.get(idStr(src.receivingUnitId));
      if (row) {
        damagedQty = roundAsnQty(damagedQty + (Number(row.damagedQty) || 0));
        rejectedQty = roundAsnQty(rejectedQty + (Number(row.rejectedQty) || 0));
        shortQty = roundAsnQty(shortQty + (Number(row.shortQty) || 0));
      }
    }
  }
  return { acceptedToStock, damagedQty, rejectedQty, shortQty, excessPendingQty };
}

export function assertPostTimeReceivingSession(receivingSession) {
  if (String(receivingSession?.status || "").toUpperCase() !== "COMPLETED") {
    throw new ReceivingDraftGrnError(
      "Receiving session must be completed before posting the ASN GRN",
      409,
      "RECEIVING_SESSION_NOT_COMPLETE"
    );
  }
}

export function assertAsnGrnReceivingSourcesMatchEvidence(grn, rows = []) {
  const rowByUnit = new Map((rows || []).map((r) => [idStr(r.receivingUnitId), r]));
  const rowBySessionUnit = new Map((rows || []).map((r) => [idStr(r.receivingSessionUnitId), r]));
  for (const item of grn?.items || []) {
    if (!item.asnLineId) {
      throw new ReceivingDraftGrnError("ASN GRN line is missing asnLineId", 409, ASN_GRN_SOURCE_MISMATCH);
    }
    assertReceivingSourcesMatchLineAccepted(item);
    for (const src of item.receivingSources || []) {
      const live = rowByUnit.get(idStr(src.receivingUnitId)) || rowBySessionUnit.get(idStr(src.receivingSessionUnitId));
      if (!live) {
        throw new ReceivingDraftGrnError(
          `Receiving source ${src.ruNo || src.receivingUnitId} is not on the completed session`,
          409,
          ASN_GRN_SOURCE_MISMATCH
        );
      }
      if (idStr(live.asnLineId) !== idStr(item.asnLineId)) {
        throw new ReceivingDraftGrnError(
          "Receiving source does not belong to this ASN line",
          409,
          ASN_GRN_SOURCE_MISMATCH
        );
      }
      if (String(src.ruNo || "").toUpperCase() !== String(live.ruNo || "").toUpperCase()) {
        throw new ReceivingDraftGrnError("Receiving source RU number does not match evidence", 409, ASN_GRN_SOURCE_MISMATCH);
      }
      if (!receivingQtyEq(src.acceptedQty, live.acceptedQty)) {
        throw new ReceivingDraftGrnError(
          "Receiving source accepted qty no longer matches completed inspection",
          409,
          ASN_GRN_SOURCE_MISMATCH
        );
      }
      const expectedExcess = roundAsnQty((Number(src.acceptedQty) || 0) - (Number(src.grnAcceptedQty) || 0));
      if (!receivingQtyEq(src.excessPendingQty, expectedExcess)) {
        throw new ReceivingDraftGrnError(
          "receivingSources excess invariant failed at post",
          409,
          ASN_GRN_SOURCE_MISMATCH
        );
      }
    }
  }
  assertExcessSourceInvariants(grn.items || []);
}

export function assertArticleMatchesAsnLine(item, asnLine) {
  const a = String(item?.article || "").trim().toUpperCase();
  const b = String(asnLine?.article || "").trim().toUpperCase();
  if (a && b && a !== b) {
    throw new ReceivingDraftGrnError(
      "GRN line article does not match the ASN line snapshot",
      409,
      ASN_GRN_SOURCE_MISMATCH
    );
  }
}

export function assertAsnDraftEntitlementStillHolds(grn, maps) {
  const review = computeAsnDraftEntitlementReview(grn, maps);
  if (!review.entitlementValid) {
    const err = new ReceivingDraftGrnError(
      "PO entitlement changed since this ASN Draft GRN was generated. The draft was not posted or reduced.",
      409,
      GRN_DRAFT_ENTITLEMENT_CHANGED
    );
    err.entitlementReview = review;
    throw err;
  }
  for (const item of grn?.items || []) {
    const live = roundAsnQty(
      entitlementForAsnLine({
        asnLineId: item.asnLineId,
        poLineByAsnLineId: maps.poLineByAsnLineId,
        poLineIdByAsnLineId: maps.poLineIdByAsnLineId,
        postedByPoLine: maps.postedByPoLine,
        otherDraftByPoLine: maps.otherDraftByPoLine,
      })
    );
    const stored = roundAsnQty(item.acceptedQty);
    if (stored - live > ASN_QTY_EPS) {
      const err = new ReceivingDraftGrnError(
        "PO entitlement is below the ASN Draft GRN quantity. The draft was not posted or reduced.",
        409,
        GRN_DRAFT_ENTITLEMENT_CHANGED
      );
      err.entitlementReview = review;
      throw err;
    }
  }
  return review;
}

/** ASN reservation release = ASN line shipped qty, not GRN accepted. */
export function asnReservationReleaseQty(asnLine) {
  return roundAsnQty(asnLine?.asnQty ?? asnLine?.qty ?? 0);
}

export function allowedSystemAsnPostFromStatuses() {
  return ["SHIPPED", "ARRIVED", "PARTIALLY_RECEIVED"];
}

export function allowedSystemAsnReversalFromStatuses() {
  return ["COMPLETED", "PARTIALLY_RECEIVED"];
}

export function buildCustomsPostBodyFromGrn(grn) {
  const items = grn?.items || [];
  const captures = items.map((ln) => ln.customsCapture).filter(Boolean);
  const first = captures[0] || {};
  const header = {
    boeMode: first.boeMode || "",
    customsBoeId: first.customsBoeId || "",
    customsBoeRef: first.customsBoeRef || "",
    boeNumber: first.boeNumber || grn.customsDocRef || "",
    boeDate: first.boeDate || "",
    blNumber: first.blNumber || grn.blAwbNo || "",
    awbNumber: first.awbNumber || "",
    supplierInvoiceNumber: first.supplierInvoiceNumber || grn.supplierInvoiceNo || "",
    supplierInvoiceDate: first.supplierInvoiceDate || "",
    receivedDate: first.receivedDate || grn.grnDate || "",
    countryOfOrigin: first.countryOfOrigin || "",
    hsCode: first.hsCode || "",
    customsCurrency: first.customsCurrency || first.currency || grn.currency || "",
    exchangeRateToAED: first.exchangeRateToAED || 0,
    boeDeclaredQty: first.boeDeclaredQty || 0,
    boeDeclaredValue: first.boeDeclaredValue || 0,
    customsUom: first.customsUom || "",
    unitWeightKg: first.unitWeightKg || 0,
    grossWeightKg: first.grossWeightKg || 0,
    netWeightKg: first.netWeightKg || 0,
    customsRemarks: first.customsRemarks || "",
  };
  const lineOverrides = items
    .filter((ln) => ln.customsCapture)
    .map((ln) => ({
      poLineId: ln.poLineId,
      article: ln.article,
      ...(ln.customsCapture.toObject?.() || ln.customsCapture),
    }));
  const body = { ...header, lineOverrides };
  if (!isCustomsCaptureActive({ header, lineOverrides })) return {};
  return body;
}

function hasCustomsFields(body) {
  if (!body || typeof body !== "object") return false;
  if (body.customs && typeof body.customs === "object") return true;
  return isCustomsCaptureActive({
    header: body,
    lineOverrides: body.lineOverrides || [],
    documents: body.documents,
  });
}

/**
 * Simulated posting pipeline for failure-injection and rollback proofs.
 * Production uses Mongo withTransaction around the same step names.
 */
export function simulateAsnReceivingPostPipeline(initial, { failAt = "" } = {}) {
  const state = {
    grnStatus: "DRAFT",
    stockQty: 0,
    poReceivedQty: Number(initial.poReceivedQty) || 0,
    asnActiveQty: Number(initial.asnActiveQty) || 0,
    asnStatus: initial.asnStatus || "ARRIVED",
    customsLots: 0,
    acceptedToStock: roundAsnQty(initial.acceptedToStock || 0),
    asnReleaseQty: roundAsnQty(initial.asnReleaseQty || 0),
    rolledBack: false,
  };
  const snapshot = { ...state };
  try {
    for (const step of ASN_GRN_POST_STEPS) {
      if (String(failAt) === step) {
        throw new Error(step);
      }
      if (step === "claim_po") state.poReceivedQty = roundAsnQty(state.poReceivedQty + state.acceptedToStock);
      if (step === "stock") state.stockQty = roundAsnQty(state.stockQty + state.acceptedToStock);
      if (step === "customs" && initial.customs) state.customsLots = 1;
      if (step === "grn_status") state.grnStatus = "RECEIVED";
      if (step === "asn_release") state.asnActiveQty = Math.max(0, roundAsnQty(state.asnActiveQty - state.asnReleaseQty));
      if (step === "asn_completed") state.asnStatus = "COMPLETED";
    }
    return state;
  } catch {
    return { ...snapshot, rolledBack: true, failedAt: failAt };
  }
}

/**
 * Post claims receivedQty before releasing asnActiveQty. Intermediate
 * received+active may exceed ordered inside the uncommitted transaction.
 * Concurrent new ASN claims must use persisted fields; they cannot treat
 * still-reserved ASN-1 qty as available, and after commit they may claim only
 * ordered - received - remaining active.
 */
export function simulatePostThenConcurrentAsnClaim({
  orderedQty = 50,
  asn1Qty = 50,
  acceptedQty = 43,
  concurrentAsnQty = 50,
} = {}) {
  const start = { receivedQty: 0, asnActiveQty: asn1Qty };
  const midUncommitted = {
    receivedQty: acceptedQty,
    asnActiveQty: asn1Qty,
  };
  const committed = {
    receivedQty: acceptedQty,
    asnActiveQty: 0,
  };
  return {
    start,
    midUncommitted,
    committed,
    midWouldAllowConcurrent: asnClaimFitsLine({
      orderedQty,
      receivedQty: midUncommitted.receivedQty,
      asnActiveQty: midUncommitted.asnActiveQty,
      additionalQty: concurrentAsnQty,
    }),
    afterWouldAllowConcurrent: asnClaimFitsLine({
      orderedQty,
      receivedQty: committed.receivedQty,
      asnActiveQty: committed.asnActiveQty,
      additionalQty: concurrentAsnQty,
    }),
    remainingAfterPost: roundAsnQty(orderedQty - committed.receivedQty - committed.asnActiveQty),
  };
}

export function simulateAsnReservationRestore({
  orderedQty = 50,
  receivedQty = 43,
  asnActiveQty = 0,
  restoreQty = 50,
  receivedReversalQty = 43,
  failAt = "",
} = {}) {
  const snapshot = {
    grnStatus: "RECEIVED",
    stockQty: receivedQty,
    poReceivedQty: receivedQty,
    asnActiveQty,
    asnStatus: "COMPLETED",
    customsLots: 1,
  };
  if (failAt === "restore" || !canRestoreAsnReservation({
    orderedQty,
    receivedQty,
    asnActiveQty,
    restoreQty,
    receivedReversalQty,
  })) {
    return { ...snapshot, rolledBack: true, code: "ASN_RESERVATION_RESTORE_CONFLICT" };
  }
  return {
    grnStatus: "CANCELLED",
    stockQty: 0,
    poReceivedQty: roundAsnQty(receivedQty - receivedReversalQty),
    asnActiveQty: roundAsnQty(asnActiveQty + restoreQty),
    asnStatus: "ARRIVED",
    customsLots: 0,
    rolledBack: false,
  };
}
