/**
 * ASN Phase 1 domain rules (pure). Backend remains authoritative.
 * ASN never posts stock, customs, GRN, or accounting.
 */

export const ASN_STATUSES = Object.freeze([
  "DRAFT",
  "SHIPPED",
  "ARRIVED",
  "PARTIALLY_RECEIVED",
  "COMPLETED",
  "CANCELLED",
]);

/** Statuses users may drive in Phase 1. */
export const ASN_USER_STATUSES = Object.freeze(["DRAFT", "SHIPPED", "ARRIVED", "CANCELLED"]);

/** Future receiving/GRN statuses — stored on the model, never set by users. */
export const ASN_SYSTEM_STATUSES = Object.freeze(["PARTIALLY_RECEIVED", "COMPLETED"]);

export const ASN_ACTIVE_STATUSES = Object.freeze([
  "DRAFT",
  "SHIPPED",
  "ARRIVED",
  "PARTIALLY_RECEIVED",
  "COMPLETED",
]);

export const ASN_SHIPMENT_MODES = Object.freeze(["AIR", "SEA", "COURIER", "ROAD", "LOCAL", "OTHER"]);

export const ASN_QTY_EPS = 1e-6;

export const ALLOWED_ASN_TRANSITIONS = Object.freeze({
  DRAFT: ["SHIPPED", "CANCELLED"],
  SHIPPED: ["ARRIVED", "CANCELLED"],
  ARRIVED: ["CANCELLED"],
  PARTIALLY_RECEIVED: [],
  COMPLETED: [],
  CANCELLED: [],
});

export class AsnError extends Error {
  constructor(message, status = 400, code = "ASN_ERROR") {
    super(message);
    this.name = "AsnError";
    this.status = status;
    this.code = code;
  }
}

export function roundAsnQty(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 1e6) / 1e6;
}

export function qtyGt(a, b, eps = ASN_QTY_EPS) {
  return roundAsnQty(a) - roundAsnQty(b) > eps;
}

export function isActiveAsnStatus(status) {
  return ASN_ACTIVE_STATUSES.includes(String(status || "").toUpperCase());
}

export function canUserSetAsnStatus(status) {
  return ASN_USER_STATUSES.includes(String(status || "").toUpperCase());
}

/** System-only: GRN posting/reversal. Users still cannot PATCH these statuses. */
export function assertSystemAsnReceivingStatus(fromStatus, toStatus) {
  const from = String(fromStatus || "").toUpperCase();
  const to = String(toStatus || "").toUpperCase();
  const postOk =
    ["SHIPPED", "ARRIVED", "PARTIALLY_RECEIVED"].includes(from) && to === "COMPLETED";
  const reverseOk = from === "COMPLETED" && (to === "ARRIVED" || to === "PARTIALLY_RECEIVED");
  if (!postOk && !reverseOk) {
    throw new AsnError(`Cannot apply system ASN status ${from} → ${to}`, 409, "ASN_SYSTEM_STATUS");
  }
  return true;
}

export function assertValidTransition(fromStatus, toStatus) {
  const from = String(fromStatus || "").toUpperCase();
  const to = String(toStatus || "").toUpperCase();
  if (ASN_SYSTEM_STATUSES.includes(to)) {
    throw new AsnError(
      `${to} is a system status and cannot be set manually`,
      400,
      "ASN_SYSTEM_STATUS"
    );
  }
  const allowed = ALLOWED_ASN_TRANSITIONS[from] || [];
  if (!allowed.includes(to)) {
    throw new AsnError(`Cannot change ASN status from ${from} to ${to}`, 400, "ASN_INVALID_TRANSITION");
  }
  return true;
}

export function assertAsnEditable(status, { lines = false } = {}) {
  const s = String(status || "").toUpperCase();
  if (s === "CANCELLED") {
    throw new AsnError("Cancelled ASN is read-only", 400, "ASN_READ_ONLY");
  }
  if (lines) {
    if (s !== "DRAFT") {
      throw new AsnError("ASN line quantities can only be edited in DRAFT", 400, "ASN_LINES_FROZEN");
    }
  } else if (s === "ARRIVED" || s === "PARTIALLY_RECEIVED" || s === "COMPLETED") {
    throw new AsnError("ASN header identity is frozen after arrival", 400, "ASN_FROZEN");
  }
  return true;
}

export function shipmentFieldsEditable(status) {
  const s = String(status || "").toUpperCase();
  return s === "DRAFT" || s === "SHIPPED";
}

export function attachmentsEditable(status) {
  const s = String(status || "").toUpperCase();
  return s === "DRAFT" || s === "SHIPPED" || s === "ARRIVED";
}

export function normalizeArticle(value) {
  return String(value || "")
    .trim()
    .toUpperCase();
}

export function sameCompanyId(a, b) {
  return String(a || "").trim() === String(b || "").trim();
}

export function poLineIdentity(line = {}) {
  return String(line?._id || line?.id || line?.poLineId || "").trim();
}

/**
 * Ordered qty for ASN allocation: PO commercial qty, not GRN received qty.
 */
export function poOrderedQtyForAsn(line = {}) {
  const qty = Number(line?.qty);
  if (Number.isFinite(qty) && qty > 0) return roundAsnQty(qty);
  const ordered = Number(line?.orderedQty);
  if (Number.isFinite(ordered) && ordered > 0) return roundAsnQty(ordered);
  return 0;
}

export function poLineArticle(line = {}) {
  return normalizeArticle(line.article || line.articleNo || line.itemCode || "");
}

export function assertArticleMatchesPoLine(incomingArticle, poLine) {
  const expected = poLineArticle(poLine);
  const sent = normalizeArticle(incomingArticle);
  if (sent && expected && sent !== expected) {
    throw new AsnError(
      `Article ${sent} does not match PO line article ${expected}`,
      400,
      "ASN_ARTICLE_MISMATCH"
    );
  }
  return expected;
}

/**
 * Sum active ASN qty per PO line, excluding one ASN (for edit-in-place).
 * asns: [{ _id, status, lines: [{ poLineId, asnQty }] }]
 */
export function activeAsnQtyByPoLine(asns = [], { excludeAsnId = "" } = {}) {
  const map = new Map();
  const skip = String(excludeAsnId || "").trim();
  for (const asn of asns || []) {
    if (skip && String(asn._id || "") === skip) continue;
    if (!isActiveAsnStatus(asn.status)) continue;
    for (const line of asn.lines || []) {
      const key = String(line.poLineId || "");
      if (!key) continue;
      map.set(key, roundAsnQty((map.get(key) || 0) + (Number(line.asnQty) || 0)));
    }
  }
  return map;
}

export function consolidateAsnLinePayload(lines = []) {
  const byId = new Map();
  for (const raw of lines || []) {
    const poLineId = String(raw?.poLineId || raw?._id || raw?.id || "").trim();
    if (!poLineId) {
      throw new AsnError("Each ASN line must reference a PO line id", 400, "ASN_PO_LINE_REQUIRED");
    }
    const qty = roundAsnQty(raw.asnQty ?? raw.qty);
    const prev = byId.get(poLineId);
    if (prev) {
      prev.asnQty = roundAsnQty(prev.asnQty + qty);
      continue;
    }
    byId.set(poLineId, { ...raw, poLineId, asnQty: qty });
  }
  return [...byId.values()];
}

export function assertPositiveAsnQty(qty, article = "") {
  const n = roundAsnQty(qty);
  if (!Number.isFinite(n) || n <= 0) {
    throw new AsnError(
      `ASN quantity must be greater than 0${article ? ` for ${article}` : ""}`,
      400,
      "ASN_QTY_INVALID"
    );
  }
  return n;
}

/**
 * remaining ASN claim capacity for a PO line:
 * ordered - cancelled - commercially received - existing asnActive.
 */
export function remainingAsnQty(poQty, alreadyActiveQty, receivedQty = 0, cancelledQty = 0) {
  return roundAsnQty(
    Math.max(
      0,
      roundAsnQty(poQty) - roundAsnQty(cancelledQty) - roundAsnQty(receivedQty) - roundAsnQty(alreadyActiveQty)
    )
  );
}

export function poLineReceivedQtyForAsn(line) {
  return roundAsnQty(line?.receivedQty ?? line?.received ?? 0);
}

export function poLineCancelledQtyForAsn(line) {
  return roundAsnQty(line?.cancelledQty ?? line?.cancelled ?? 0);
}

/**
 * Restore of `restoreQty` is allowed iff after reversing `receivedReversalQty`
 * the line still satisfies received + asnActive + restoreQty <= ordered - cancelled.
 * Restore is all-or-nothing for the original ASN line qty (never a partial restore).
 */
export function canRestoreAsnReservation({
  orderedQty,
  cancelledQty = 0,
  receivedQty = 0,
  asnActiveQty = 0,
  restoreQty = 0,
  receivedReversalQty = 0,
} = {}) {
  return asnClaimFitsLine({
    orderedQty,
    cancelledQty,
    receivedQty: Math.max(0, roundAsnQty(receivedQty) - roundAsnQty(receivedReversalQty)),
    asnActiveQty,
    additionalQty: restoreQty,
  });
}

/** True if received + asnActive + additional <= ordered - cancelled. */
export function asnClaimFitsLine({ orderedQty, cancelledQty = 0, receivedQty = 0, asnActiveQty = 0, additionalQty = 0 } = {}) {
  const cap = roundAsnQty(orderedQty) - roundAsnQty(cancelledQty);
  const used = roundAsnQty(receivedQty) + roundAsnQty(asnActiveQty) + roundAsnQty(additionalQty);
  return !qtyGt(used, cap);
}

export function tryClaimAsnQtyInMemory(line, additionalQty) {
  const q = roundAsnQty(additionalQty);
  const nextActive = roundAsnQty((Number(line.asnActiveQty) || 0) + q);
  if (
    !asnClaimFitsLine({
      orderedQty: line.orderedQty ?? line.qty,
      cancelledQty: line.cancelledQty,
      receivedQty: line.receivedQty,
      asnActiveQty: line.asnActiveQty,
      additionalQty: q,
    })
  ) {
    return { ok: false, line };
  }
  return { ok: true, line: { ...line, asnActiveQty: nextActive } };
}

export function assertQtyWithinAvailable({
  article,
  poQty,
  alreadyActive,
  requested,
  receivedQty = 0,
  cancelledQty = 0,
}) {
  const need = assertPositiveAsnQty(requested, article);
  const remaining = remainingAsnQty(poQty, alreadyActive, receivedQty, cancelledQty);
  if (qtyGt(need, remaining)) {
    throw new AsnError(
      `ASN quantity ${need} exceeds remaining ${remaining} for ${article || "PO line"} (PO qty ${roundAsnQty(poQty)}, received ${roundAsnQty(receivedQty)}, already ASN ${roundAsnQty(alreadyActive)})`,
      409,
      "ASN_QTY_EXCEEDED"
    );
  }
  return { requested: need, remaining };
}

/**
 * Sequential claim helper used to prove stale concurrent saves cannot
 * over-allocate the same remaining quantity.
 */
export function applyAsnQtyClaims(remainingByLine, claims = []) {
  const next = { ...remainingByLine };
  for (const claim of claims) {
    const key = String(claim.poLineId || "");
    const remaining = Number(next[key] || 0);
    assertQtyWithinAvailable({
      article: claim.article,
      poQty: remaining,
      alreadyActive: 0,
      requested: claim.qty,
    });
    next[key] = remainingAsnQty(remaining, claim.qty);
  }
  return next;
}

/**
 * Keep embedded ASN line `_id` values when the same PO line is edited.
 * New PO lines get a fresh id from Mongo; existing ones are not recreated.
 */
export function mergeAsnLinesPreservingIds(existingLines = [], nextSnapshots = []) {
  const byPoLine = new Map();
  for (const line of existingLines || []) {
    const key = String(line.poLineId || "");
    if (key) byPoLine.set(key, line);
  }
  return (nextSnapshots || []).map((snap) => {
    const prev = byPoLine.get(String(snap.poLineId || ""));
    if (prev?._id) return { ...snap, _id: prev._id };
    const rest = { ...snap };
    delete rest._id;
    return rest;
  });
}

export function lineQtyDeltas(existingLines = [], nextLines = []) {
  const before = new Map();
  for (const line of existingLines || []) {
    const key = String(line.poLineId || "");
    if (!key) continue;
    before.set(key, roundAsnQty((before.get(key) || 0) + (Number(line.asnQty) || 0)));
  }
  const after = new Map();
  for (const line of nextLines || []) {
    const key = String(line.poLineId || "");
    if (!key) continue;
    after.set(key, roundAsnQty((after.get(key) || 0) + (Number(line.asnQty) || 0)));
  }
  const keys = new Set([...before.keys(), ...after.keys()]);
  const deltas = [];
  for (const key of keys) {
    const delta = roundAsnQty((after.get(key) || 0) - (before.get(key) || 0));
    if (Math.abs(delta) <= ASN_QTY_EPS) continue;
    const sample = (nextLines || []).find((l) => String(l.poLineId) === key) || {};
    deltas.push({
      poLineId: key,
      delta,
      article: sample.article,
      orderedQty: sample.poQty,
    });
  }
  return deltas;
}

/**
 * Concurrent DRAFT edits: the shared counter already includes this ASN's qty,
 * so only the delta is claimed. Two +40 edits against remaining 40: second fails.
 */
export function applyAsnQtyDeltas(claimedByLine, maxByLine, deltas = []) {
  const next = { ...claimedByLine };
  for (const row of deltas) {
    const key = String(row.poLineId || "");
    const current = Number(next[key] || 0);
    const max = Number(maxByLine[key] || 0);
    const projected = roundAsnQty(current + Number(row.delta || 0));
    if (row.delta > ASN_QTY_EPS && qtyGt(projected, max)) {
      throw new AsnError(
        `ASN quantity exceeds remaining available for ${row.article || "PO line"}`,
        409,
        "ASN_QTY_EXCEEDED"
      );
    }
    next[key] = roundAsnQty(Math.max(0, projected));
  }
  return next;
}

export function applyCancelRelease(claimedByLine, lineQtys = [], { alreadyCancelled = false } = {}) {
  if (alreadyCancelled) return { ...claimedByLine };
  const next = { ...claimedByLine };
  for (const line of lineQtys) {
    const key = String(line.poLineId || "");
    next[key] = roundAsnQty(Math.max(0, (Number(next[key]) || 0) - (Number(line.asnQty) || 0)));
  }
  return next;
}

export function validatePoLinesAgainstActiveAsn(mergedLines = [], activeByLine = new Map()) {
  const errors = [];
  const kept = new Set();
  for (const line of mergedLines || []) {
    const id = String(line?._id || "");
    if (id) kept.add(id);
    const active = Number(activeByLine.get(id) || 0);
    const received = poLineReceivedQtyForAsn(line);
    const floor = roundAsnQty(received + active);
    if (floor > ASN_QTY_EPS && poOrderedQtyForAsn(line) + ASN_QTY_EPS < floor) {
      errors.push(
        `${poLineArticle(line) || id}: PO quantity cannot be less than received (${received}) plus the active ASN quantity of ${active}.`
      );
    }
  }
  for (const [id, active] of activeByLine || []) {
    if (Number(active) > ASN_QTY_EPS && !kept.has(String(id))) {
      errors.push(`A purchase order line with active ASN quantity ${active} cannot be removed.`);
    }
  }
  return errors;
}

export const ASN_IMMUTABLE_PATCH_KEYS = Object.freeze([
  "companyId",
  "asnNo",
  "sourcePoId",
  "sourcePoNo",
  "sourcePoDate",
  "poIds",
  "supplierId",
  "supplierName",
  "createdBy",
  "createdByUserId",
  "createdAt",
  "status",
  "shippedAt",
  "shippedBy",
  "arrivedAt",
  "arrivedBy",
  "cancelledAt",
  "cancelledBy",
  "cancellationReason",
]);

export function assertNoImmutableAsnPatch(body = {}) {
  for (const key of ASN_IMMUTABLE_PATCH_KEYS) {
    if (body[key] !== undefined) {
      throw new AsnError(`Cannot change ${key} via PATCH`, 400, "ASN_IMMUTABLE_FIELD");
    }
  }
}

export function actorName(req) {
  return String(req?.user?.name || req?.user?.fullName || req?.user?.email || req?.user?.id || "").trim();
}

export const ASN_SHIPMENT_PATCH_KEYS = Object.freeze([
  "supplierInvoiceNumber",
  "supplierInvoiceDate",
  "supplierPackingListNumber",
  "shipmentMode",
  "forwarder",
  "awbNumber",
  "blNumber",
  "trackingNumber",
  "shipmentDate",
  "expectedArrivalDate",
  "actualArrivalDate",
  "countryOfOrigin",
  "portOfLoading",
  "portOfArrival",
  "numberOfPackages",
  "grossWeight",
  "grossWeightUom",
  "remarks",
  "currency",
]);
