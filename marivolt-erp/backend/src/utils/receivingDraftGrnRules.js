/**
 * Phase 4B — Draft GRN from a completed ASN ReceivingSession.
 * Pure grouping, entitlement, excess allocation, and idempotency helpers.
 * Does not post stock.
 *
 * Excess contract (Option A): after capped commercial posting, extra physical qty
 * is inspection evidence only. It is not pending Store/Purchase approval and is
 * not commercially received on this ASN/GRN. Admitting it later requires a new
 * explicit commercial document — not a mutation of this posted GRN.
 */
import { roundAsnQty, receivingQtyEq, ReceivingInspectionError } from "./receivingInspectionRules.js";
import { poLineEntitlement } from "./grnReceiptQty.js";

export const GRN_SOURCE_ASN_RECEIVING = "ASN_RECEIVING";
export const GRN_SOURCE_MANUAL_PO = "MANUAL_PO";

export const ASN_GRN_POST_PHASE4C_REQUIRED = "ASN_GRN_POST_PHASE4C_REQUIRED";
export const RECEIVING_GRN_DRAFT_EXISTS = "RECEIVING_GRN_DRAFT_EXISTS";
export const RECEIVING_NO_ACCEPTED_QTY = "RECEIVING_NO_ACCEPTED_QTY";
export const RECEIVING_GRN_MULTI_PO = "RECEIVING_GRN_MULTI_PO";
export const EXCESS_PENDING_APPROVAL = "EXCESS_EVIDENCE_ONLY";
export const EXCESS_EVIDENCE_ONLY = "EXCESS_EVIDENCE_ONLY";
export const RECEIVING_PO_ENTITLEMENT_EXHAUSTED = "RECEIVING_PO_ENTITLEMENT_EXHAUSTED";
export const ASN_GRN_SOURCE_MISMATCH = "ASN_GRN_SOURCE_MISMATCH";
export const ASN_GRN_EDIT_FORBIDDEN = "ASN_GRN_EDIT_FORBIDDEN";
export const GRN_DRAFT_ENTITLEMENT_CHANGED = "GRN_DRAFT_ENTITLEMENT_CHANGED";
export const GRN_DRAFT_ADDITIONAL_ENTITLEMENT_AVAILABLE = "GRN_DRAFT_ADDITIONAL_ENTITLEMENT_AVAILABLE";

export class ReceivingDraftGrnError extends Error {
  constructor(message, status = 400, code = "RECEIVING_GRN_ERROR") {
    super(message);
    this.name = "ReceivingDraftGrnError";
    this.status = status;
    this.statusCode = status;
    this.code = code;
  }
}

export function isAsnReceivingGrn(grn) {
  if (!grn) return false;
  if (String(grn.sourceType || "").toUpperCase() === GRN_SOURCE_ASN_RECEIVING) return true;
  return Boolean(grn.receivingSessionId);
}

export function assertAsnReceivingGrnPostBlocked(grn) {
  if (!isAsnReceivingGrn(grn)) return grn;
  throw new ReceivingDraftGrnError(
    "ASN receiving Draft GRNs cannot be posted until Phase 4C (stock + customs in one engine).",
    409,
    ASN_GRN_POST_PHASE4C_REQUIRED
  );
}

export function receivingDraftGroupKey({ poLineId, asnLineId, uom } = {}) {
  return `${String(poLineId || "")}|${String(asnLineId || "")}|${String(uom || "PCS").trim().toUpperCase() || "PCS"}`;
}

function idStr(value) {
  if (value == null || value === "") return "";
  return String(value);
}

/** Entitlement for an ASN line: ASN line → PO line → shared PO receipt helper. */
export function entitlementForAsnLine({
  asnLineId,
  poLineByAsnLineId,
  poLineIdByAsnLineId,
  postedByPoLine = new Map(),
  otherDraftByPoLine = new Map(),
} = {}) {
  const key = idStr(asnLineId);
  const poLine = poLineByAsnLineId?.get?.(key);
  if (!poLine) {
    throw new ReceivingDraftGrnError(
      "ASN line has no source PO line for entitlement",
      409,
      ASN_GRN_SOURCE_MISMATCH
    );
  }
  const poLineId = idStr(poLineIdByAsnLineId?.get?.(key) || poLine._id);
  return poLineEntitlement({
    orderedQty: Number(poLine.orderedQty ?? poLine.qty) || 0,
    cancelledQty: Number(poLine.cancelledQty) || 0,
    postedAcceptedQty: postedByPoLine.get(poLineId) || 0,
    otherDraftAcceptedQty: otherDraftByPoLine.get(poLineId) || 0,
  });
}

export function compareRuNo(a, b) {
  return String(a || "").localeCompare(String(b || ""), undefined, { numeric: true, sensitivity: "base" });
}

/**
 * Deterministic excess allocation: fill GRN accepted in ruNo order until entitlement is exhausted.
 * Each source keeps physical acceptedQty plus grnAcceptedQty / excessPendingQty.
 */
export function allocateGrnAcceptedAcrossSources(sources = [], entitlementQty = 0) {
  const ordered = [...(sources || [])].sort((a, b) => compareRuNo(a.ruNo, b.ruNo));
  let remaining = roundAsnQty(entitlementQty);
  return ordered.map((src) => {
    const acceptedQty = roundAsnQty(src.acceptedQty);
    const grnAcceptedQty = roundAsnQty(Math.min(acceptedQty, Math.max(0, remaining)));
    remaining = roundAsnQty(remaining - grnAcceptedQty);
    return {
      receivingUnitId: src.receivingUnitId,
      receivingSessionUnitId: src.receivingSessionUnitId,
      ruNo: src.ruNo,
      acceptedQty,
      grnAcceptedQty,
      excessPendingQty: roundAsnQty(acceptedQty - grnAcceptedQty),
    };
  });
}

export function assertReceivingSourcesMatchLineAccepted(line) {
  const sources = line?.receivingSources || [];
  const sum = roundAsnQty(sources.reduce((s, x) => s + (Number(x.grnAcceptedQty) || 0), 0));
  const accepted = roundAsnQty(line?.acceptedQty);
  if (!receivingQtyEq(sum, accepted)) {
    throw new ReceivingDraftGrnError(
      `receivingSources.grnAcceptedQty (${sum}) must equal GRN line acceptedQty (${accepted})`,
      500,
      "RECEIVING_GRN_SOURCE_QTY_MISMATCH"
    );
  }
  return true;
}

export function assertExcessSourceInvariants(items = [], reportedSessionExcess = null) {
  let sessionExcess = 0;
  for (const line of items || []) {
    for (const src of line.receivingSources || []) {
      const accepted = roundAsnQty(src.acceptedQty);
      const grnAccepted = roundAsnQty(src.grnAcceptedQty);
      const excess = roundAsnQty(src.excessPendingQty);
      if (!receivingQtyEq(roundAsnQty(grnAccepted + excess), accepted)) {
        throw new ReceivingDraftGrnError(
          `receiving source ${src.ruNo}: grnAcceptedQty + excessPendingQty must equal acceptedQty`,
          500,
          "RECEIVING_GRN_SOURCE_QTY_MISMATCH"
        );
      }
      sessionExcess = roundAsnQty(sessionExcess + excess);
    }
    assertReceivingSourcesMatchLineAccepted(line);
  }
  if (reportedSessionExcess != null && !receivingQtyEq(sessionExcess, reportedSessionExcess)) {
    throw new ReceivingDraftGrnError(
      `session excessPendingQty (${reportedSessionExcess}) must equal sum of source excess (${sessionExcess})`,
      500,
      "RECEIVING_GRN_SOURCE_QTY_MISMATCH"
    );
  }
  return { sessionExcessPendingQty: sessionExcess };
}

export function eligibleDraftQtyFromAccepted(acceptedQty, entitlementQty) {
  return roundAsnQty(Math.min(roundAsnQty(acceptedQty), Math.max(0, roundAsnQty(entitlementQty))));
}

export function buildDraftGrnLinesFromReceiving({
  groups = [],
  poLineByAsnLineId = new Map(),
  poLineIdByAsnLineId = new Map(),
  poIdByAsnLineId = new Map(),
  postedByPoLine = new Map(),
  otherDraftByPoLine = new Map(),
  poNo = "",
} = {}) {
  const items = [];
  let totalAcceptedPhysical = 0;
  let totalGrnEligible = 0;
  let totalExcessPending = 0;
  let totalDamaged = 0;
  let totalRejected = 0;
  let totalShort = 0;

  for (const group of groups) {
    const asnLineId = group.asnLineId;
    const poLine = poLineByAsnLineId.get(String(asnLineId));
    if (!poLine) {
      throw new ReceivingDraftGrnError(
        "ASN line has no source PO line; cannot generate a Draft GRN",
        409,
        "RECEIVING_GRN_PO_LINE_MISSING"
      );
    }
    const derivedPoLineId = poLineIdByAsnLineId.get(String(asnLineId)) || poLine._id;
    const derivedPoId = poIdByAsnLineId.get(String(asnLineId)) || null;
    const physicalAccepted = roundAsnQty(
      (group.sources || []).reduce((s, x) => s + (Number(x.acceptedQty) || 0), 0)
    );
    totalAcceptedPhysical = roundAsnQty(totalAcceptedPhysical + physicalAccepted);
    totalDamaged = roundAsnQty(totalDamaged + (Number(group.damagedQty) || 0));
    totalRejected = roundAsnQty(totalRejected + (Number(group.rejectedQty) || 0));
    totalShort = roundAsnQty(totalShort + (Number(group.shortQty) || 0));

    if (!(physicalAccepted > 0)) continue;

    const ordered = Number(poLine.orderedQty ?? poLine.qty) || 0;
    const entitlement = entitlementForAsnLine({
      asnLineId,
      poLineByAsnLineId,
      poLineIdByAsnLineId,
      postedByPoLine,
      otherDraftByPoLine,
    });
    const allocated = allocateGrnAcceptedAcrossSources(group.sources, entitlement);
    const grnAcceptedQty = roundAsnQty(allocated.reduce((s, x) => s + x.grnAcceptedQty, 0));
    const excessPendingQty = roundAsnQty(allocated.reduce((s, x) => s + x.excessPendingQty, 0));
    totalGrnEligible = roundAsnQty(totalGrnEligible + grnAcceptedQty);
    totalExcessPending = roundAsnQty(totalExcessPending + excessPendingQty);

    if (!(grnAcceptedQty > 0)) continue;

    const article = String(poLine.itemCode || poLine.materialCode || poLine.article || "").trim().toUpperCase();
    const uom = String(group.uom || poLine.uom || "PCS").trim().toUpperCase() || "PCS";
    const unitCost = Number(poLine.unitPrice ?? poLine.price ?? poLine.rate) || 0;
    const currency = String(poLine.currency || group.currency || "USD").trim().toUpperCase() || "USD";
    const item = {
      article: article || "—",
      description: poLine.description || poLine.desc || "",
      partNumber: String(poLine.partNumber || poLine.partNo || "").trim().toUpperCase(),
      spn: poLine.spn || poLine.partNo || "",
      materialCode: String(poLine.itemCode || poLine.materialCode || "").trim(),
      drawingNo: poLine.drawingNo || "",
      uom,
      orderedQty: ordered,
      receivedQty: grnAcceptedQty,
      pendingQty: roundAsnQty(Math.max(0, entitlement - grnAcceptedQty)),
      acceptedQty: grnAcceptedQty,
      rejectedQty: 0,
      cancelledQty: 0,
      unitCost,
      lineAmount: roundAsnQty(unitCost * grnAcceptedQty),
      currency,
      warehouse: group.warehouse || "MAIN",
      location: "",
      poId: derivedPoId,
      poLineId: derivedPoLineId,
      asnLineId,
      poNo: poNo || group.poNo || "",
      remarks: "",
      receivingSources: allocated,
    };
    assertReceivingSourcesMatchLineAccepted(item);
    items.push(item);
  }

  assertExcessSourceInvariants(items);

  return {
    items,
    totals: {
      acceptedQty: totalAcceptedPhysical,
      damagedQty: totalDamaged,
      rejectedQty: totalRejected,
      shortQty: totalShort,
      grnEligibleQty: totalGrnEligible,
      excessPendingQty: totalExcessPending,
    },
  };
}

export function groupReceivingUnitsForDraftGrn(rows = []) {
  const map = new Map();
  for (const row of rows || []) {
    const accepted = roundAsnQty(row.acceptedQty);
    const key = receivingDraftGroupKey({
      poLineId: row.poLineId,
      asnLineId: row.asnLineId,
      uom: row.uom,
    });
    if (!map.has(key)) {
      map.set(key, {
        key,
        poId: row.poId,
        poNo: row.poNo,
        poLineId: row.poLineId,
        asnLineId: row.asnLineId,
        uom: String(row.uom || "PCS").toUpperCase(),
        currency: row.currency || "",
        warehouse: row.warehouse || "MAIN",
        damagedQty: 0,
        rejectedQty: 0,
        shortQty: 0,
        sources: [],
      });
    }
    const g = map.get(key);
    g.damagedQty = roundAsnQty(g.damagedQty + (Number(row.damagedQty) || 0));
    g.rejectedQty = roundAsnQty(g.rejectedQty + (Number(row.rejectedQty) || 0));
    g.shortQty = roundAsnQty(g.shortQty + (Number(row.shortQty) || 0));
    if (accepted > 0) {
      g.sources.push({
        receivingUnitId: row.receivingUnitId,
        receivingSessionUnitId: row.receivingSessionUnitId,
        ruNo: row.ruNo,
        acceptedQty: accepted,
      });
    }
  }
  return [...map.values()];
}

export function assertSinglePoForReceivingGrn(poIds = []) {
  const unique = [...new Set((poIds || []).map((id) => String(id || "")).filter(Boolean))];
  if (unique.length > 1) {
    throw new ReceivingDraftGrnError(
      "This receiving session spans more than one purchase order. Phase 4B cannot create a multi-PO GRN.",
      409,
      RECEIVING_GRN_MULTI_PO
    );
  }
  if (!unique.length) {
    throw new ReceivingDraftGrnError("Receiving session has no source purchase order", 409, "RECEIVING_GRN_PO_MISSING");
  }
  return unique[0];
}

export function assertDraftGrnEligibleResult(built) {
  const accepted = roundAsnQty(built?.totals?.acceptedQty);
  const eligible = roundAsnQty(built?.totals?.grnEligibleQty);
  if (!(accepted > 0)) {
    throw new ReceivingDraftGrnError(
      "No accepted quantity to put on a Draft GRN. The receiving session remains as historical evidence.",
      409,
      RECEIVING_NO_ACCEPTED_QTY
    );
  }
  if (!(eligible > 0) || !(built.items || []).length) {
    throw new ReceivingDraftGrnError(
      "PO entitlement is already consumed by posted or other draft GRNs. Extra physical qty remains receiving evidence only.",
      409,
      RECEIVING_PO_ENTITLEMENT_EXHAUSTED
    );
  }
  return built;
}

export function freezeReceivingBecauseDraftGrnExists() {
  throw new ReceivingInspectionError(
    "An ASN GRN already exists for this receiving session. Delete a Draft GRN before correcting receiving. Posted or reversed GRNs keep inspection frozen.",
    409,
    RECEIVING_GRN_DRAFT_EXISTS
  );
}

/**
 * In-memory unique slot used to prove Samsung double-tap / Promise.all generate.
 * Mirrors Mongo unique partial index on companyId + receivingSessionId.
 */
export function claimReceivingDraftGrnSlot(store, { companyId, receivingSessionId, grnNo }) {
  const key = `${String(companyId)}:${String(receivingSessionId)}`;
  if (store.has(key)) {
    return { created: false, reused: true, grnNo: store.get(key) };
  }
  store.set(key, grnNo);
  return { created: true, reused: false, grnNo };
}

export async function generateDraftGrnIdempotent(store, { companyId, receivingSessionId, nextNo }) {
  const existing = store.get(`${String(companyId)}:${String(receivingSessionId)}`);
  if (existing) return { created: false, reused: true, grnNo: existing };
  try {
    return claimReceivingDraftGrnSlot(store, {
      companyId,
      receivingSessionId,
      grnNo: typeof nextNo === "function" ? nextNo() : nextNo,
    });
  } catch (err) {
    if (Number(err?.code) === 11000) {
      const raced = store.get(`${String(companyId)}:${String(receivingSessionId)}`);
      if (raced) return { created: false, reused: true, grnNo: raced };
    }
    throw err;
  }
}

/**
 * Preserve only review-stage fields. Commercial identity and receivingSources are immutable.
 * Tampering throws ASN_GRN_EDIT_FORBIDDEN rather than silently applying.
 */
/**
 * Preserve only review-stage fields. Commercial identity and receivingSources are immutable.
 * Tampering throws ASN_GRN_EDIT_FORBIDDEN rather than silently applying.
 *
 * ASN_RECEIVING customsCapture: operator may set unitWeightKg (+ BOE header fields mirrored per line).
 * HS/COO/SI/line economics are not accepted as authority — post resolves from ASN/BOE.
 */
export function sanitizeAsnReceivingCustomsCapture(incoming = {}, existing = null) {
  if (incoming == null) return existing ?? null;
  const src = typeof incoming === "object" ? incoming : {};
  const prev = existing && typeof existing === "object" ? existing : {};
  return {
    ...prev,
    receivedDate: src.receivedDate ?? prev.receivedDate ?? null,
    boeNumber: src.boeNumber != null ? String(src.boeNumber) : prev.boeNumber || "",
    boeDate: src.boeDate ?? prev.boeDate ?? null,
    blNumber: src.blNumber != null ? String(src.blNumber) : prev.blNumber || "",
    awbNumber: src.awbNumber != null ? String(src.awbNumber) : prev.awbNumber || "",
    customsCurrency: src.customsCurrency != null ? String(src.customsCurrency).toUpperCase() : prev.customsCurrency || "",
    exchangeRateToAED:
      src.exchangeRateToAED != null ? Number(src.exchangeRateToAED) || 0 : Number(prev.exchangeRateToAED) || 0,
    boeDeclaredQty: src.boeDeclaredQty != null ? Number(src.boeDeclaredQty) || 0 : Number(prev.boeDeclaredQty) || 0,
    boeDeclaredValue:
      src.boeDeclaredValue != null ? Number(src.boeDeclaredValue) || 0 : Number(prev.boeDeclaredValue) || 0,
    customsUom: src.customsUom != null ? String(src.customsUom).toUpperCase() : prev.customsUom || "",
    customsRemarks: src.customsRemarks != null ? String(src.customsRemarks) : prev.customsRemarks || "",
    customsBoeId: src.customsBoeId != null ? String(src.customsBoeId) : prev.customsBoeId || "",
    customsBoeRef: src.customsBoeRef != null ? String(src.customsBoeRef) : prev.customsBoeRef || "",
    boeMode: src.boeMode != null ? String(src.boeMode) : prev.boeMode || "",
    // Operator-owned: actual unit weight
    unitWeightKg: src.unitWeightKg != null ? Number(src.unitWeightKg) || 0 : Number(prev.unitWeightKg) || 0,
    totalWeightKg: src.totalWeightKg != null ? Number(src.totalWeightKg) || 0 : Number(prev.totalWeightKg) || 0,
    // Explicitly clear ASN-owned / pooled fields from client write (post stamps from ASN/BOE).
    supplierInvoiceNumber: "",
    supplierInvoiceDate: null,
    countryOfOrigin: "",
    hsCode: "",
    customsQty: 0,
    customsUnitPrice: 0,
    customsUnitValue: 0,
    customsTotalPrice: 0,
    customsValueAED: 0,
  };
}

export function mergeAsnReceivingDraftItems(existingItems = [], incomingItems = []) {
  const incomingByKey = new Map();
  for (const row of incomingItems || []) {
    incomingByKey.set(receivingDraftGroupKey(row), row);
  }
  return (existingItems || []).map((ex) => {
    const raw = typeof ex.toObject === "function" ? ex.toObject() : { ...ex };
    const inc = incomingByKey.get(receivingDraftGroupKey(raw));
    if (!inc) return raw;
    assertAsnReceivingLineEditAllowed(raw, inc);
    return {
      ...raw,
      warehouse: inc.warehouse != null && String(inc.warehouse).trim() ? String(inc.warehouse).trim().toUpperCase() : raw.warehouse,
      location: inc.location != null ? String(inc.location) : raw.location,
      remarks: inc.remarks != null ? String(inc.remarks) : raw.remarks,
      customsCapture:
        inc.customsCapture !== undefined
          ? sanitizeAsnReceivingCustomsCapture(inc.customsCapture, raw.customsCapture)
          : raw.customsCapture,
    };
  });
}

export function assertAsnReceivingLineEditAllowed(existing, incoming) {
  const blocked = [
    ["article", String(existing.article || "").toUpperCase(), String(incoming.article || existing.article || "").toUpperCase()],
    ["asnLineId", idStr(existing.asnLineId), incoming.asnLineId != null ? idStr(incoming.asnLineId) : idStr(existing.asnLineId)],
    ["poLineId", idStr(existing.poLineId), incoming.poLineId != null ? idStr(incoming.poLineId) : idStr(existing.poLineId)],
    ["uom", String(existing.uom || "").toUpperCase(), String(incoming.uom || existing.uom || "").toUpperCase()],
    ["currency", String(existing.currency || "").toUpperCase(), String(incoming.currency || existing.currency || "").toUpperCase()],
  ];
  for (const [field, a, b] of blocked) {
    if (a !== b) {
      throw new ReceivingDraftGrnError(`Cannot change ${field} on an ASN receiving Draft GRN`, 409, ASN_GRN_EDIT_FORBIDDEN);
    }
  }
  const qtyFields = ["acceptedQty", "receivedQty", "rejectedQty", "unitCost"];
  for (const field of qtyFields) {
    if (incoming[field] == null) continue;
    if (!receivingQtyEq(existing[field], incoming[field])) {
      throw new ReceivingDraftGrnError(`Cannot change ${field} on an ASN receiving Draft GRN`, 409, ASN_GRN_EDIT_FORBIDDEN);
    }
  }
  if (incoming.receivingSources != null) {
    if (JSON.stringify(normalizeSources(existing.receivingSources)) !== JSON.stringify(normalizeSources(incoming.receivingSources))) {
      throw new ReceivingDraftGrnError(
        "receivingSources are server-generated and immutable on an ASN receiving Draft GRN",
        409,
        ASN_GRN_EDIT_FORBIDDEN
      );
    }
  }
}

function normalizeSources(sources = []) {
  return (sources || [])
    .map((s) => ({
      receivingUnitId: idStr(s.receivingUnitId),
      receivingSessionUnitId: idStr(s.receivingSessionUnitId),
      ruNo: String(s.ruNo || "").toUpperCase(),
      acceptedQty: roundAsnQty(s.acceptedQty),
      grnAcceptedQty: roundAsnQty(s.grnAcceptedQty),
      excessPendingQty: roundAsnQty(s.excessPendingQty),
    }))
    .sort((a, b) => compareRuNo(a.ruNo, b.ruNo));
}

const ASN_DRAFT_IDENTITY_HEADER = Object.freeze([
  "sourceType",
  "receivingSessionId",
  "receivingSessionNo",
  "asnId",
  "asnNo",
  "poId",
  "poNo",
  "supplierId",
  "supplierName",
  "currency",
]);

export function applyAsnReceivingDraftEdit(grn, body = {}) {
  const incoming = body || {};
  for (const field of ASN_DRAFT_IDENTITY_HEADER) {
    if (incoming[field] == null || incoming[field] === "") continue;
    if (idStr(incoming[field]).toUpperCase() !== idStr(grn[field]).toUpperCase() && String(incoming[field]) !== String(grn[field] ?? "")) {
      throw new ReceivingDraftGrnError(`Cannot change ${field} on an ASN receiving Draft GRN`, 409, ASN_GRN_EDIT_FORBIDDEN);
    }
  }
  if (incoming.remarks != null) grn.remarks = String(incoming.remarks);
  if (incoming.supplierInvoiceNo != null) grn.supplierInvoiceNo = String(incoming.supplierInvoiceNo);
  if (incoming.supplierDeliveryNote != null) grn.supplierDeliveryNote = String(incoming.supplierDeliveryNote);
  if (incoming.transporter != null) grn.transporter = String(incoming.transporter);
  if (incoming.vehicleDetails != null) grn.vehicleDetails = String(incoming.vehicleDetails);
  if (incoming.packingListNo != null) grn.packingListNo = String(incoming.packingListNo);
  if (incoming.blAwbNo != null) grn.blAwbNo = String(incoming.blAwbNo);
  if (incoming.customsDocRef != null) grn.customsDocRef = String(incoming.customsDocRef);
  if (incoming.grnDate) grn.grnDate = incoming.grnDate;
  if (incoming.branchId !== undefined) grn.branchId = incoming.branchId;
  if (incoming.warehouseId !== undefined) grn.warehouseId = incoming.warehouseId;
  if (incoming.exchangeRate != null) grn.exchangeRate = Number(incoming.exchangeRate) || grn.exchangeRate;
  if (incoming.freight != null) grn.freight = Number(incoming.freight) || 0;
  if (incoming.customs != null) grn.customs = Number(incoming.customs) || 0;
  if (incoming.landedAdjustment != null) grn.landedAdjustment = Number(incoming.landedAdjustment) || 0;
  if (Array.isArray(incoming.attachments)) grn.attachments = incoming.attachments;
  if (Array.isArray(incoming.items) && incoming.items.length) {
    grn.items = mergeAsnReceivingDraftItems(grn.items, incoming.items);
  }
  return grn;
}

/**
 * Draft qty is a generation-time snapshot. Do not mutate the GRN.
 * Compare stored acceptedQty to live ASN-line → PO-line entitlement (excluding this draft).
 */
export function computeAsnDraftEntitlementReview(grn, {
  poLineByAsnLineId,
  poLineIdByAsnLineId,
  postedByPoLine = new Map(),
  otherDraftByPoLine = new Map(),
} = {}) {
  let entitlementShortfall = 0;
  let additionalEntitlementAvailable = 0;
  const lines = [];
  for (const item of grn?.items || []) {
    const stored = roundAsnQty(item.acceptedQty);
    const live = roundAsnQty(
      entitlementForAsnLine({
        asnLineId: item.asnLineId,
        poLineByAsnLineId,
        poLineIdByAsnLineId,
        postedByPoLine,
        otherDraftByPoLine,
      })
    );
    const shortfall = roundAsnQty(Math.max(0, stored - live));
    const extra = roundAsnQty(Math.max(0, live - stored));
    entitlementShortfall = roundAsnQty(entitlementShortfall + shortfall);
    additionalEntitlementAvailable = roundAsnQty(additionalEntitlementAvailable + extra);
    lines.push({
      asnLineId: item.asnLineId,
      storedAcceptedQty: stored,
      currentEntitlement: live,
      entitlementShortfall: shortfall,
      additionalEntitlementAvailable: extra,
    });
  }
  const entitlementValid = !(entitlementShortfall > 0);
  return {
    entitlementValid,
    entitlementShortfall,
    additionalEntitlementAvailable,
    code: !entitlementValid
      ? GRN_DRAFT_ENTITLEMENT_CHANGED
      : additionalEntitlementAvailable > 0
        ? GRN_DRAFT_ADDITIONAL_ENTITLEMENT_AVAILABLE
        : undefined,
    lines,
  };
}

export function snapshotUnitVersions(units = []) {
  return (units || [])
    .map((u) => `${String(u._id || u.receivingSessionUnitId)}:${Number(u.version) || 0}`)
    .sort()
    .join("|");
}

export function assertCoherentReceivingSnapshot(beforeUnits, afterUnits) {
  const a = snapshotUnitVersions(beforeUnits);
  const b = snapshotUnitVersions(afterUnits);
  if (a !== b) {
    throw new ReceivingDraftGrnError(
      "Receiving quantities changed while generating the Draft GRN. Retry after receiving is stable.",
      409,
      "RECEIVING_GRN_SNAPSHOT_CHANGED"
    );
  }
}
