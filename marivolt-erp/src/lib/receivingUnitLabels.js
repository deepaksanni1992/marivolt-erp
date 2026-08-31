/**
 * ASN Receiving Unit label planning helpers.
 * Reuses GRN distribution math — does not fork it.
 */
import {
  distributeByLabelCount,
  formatLabelDistribution,
  parseDistributionInput,
  sumDistribution,
  validateGrnLabelLinePrintConfig,
} from "./grnLabelDistribution.js";

export function suggestedDistribution(asnQty, labelCount) {
  const q = Number(asnQty) || 0;
  const n = Math.max(1, Math.floor(Number(labelCount) || 1));
  return q > 0 ? distributeByLabelCount(q, n) : [];
}

export function validateAsnLabelDistribution(asnQty, { labelCount, labelDistribution, article } = {}) {
  const result = validateGrnLabelLinePrintConfig({
    print: true,
    article,
    receivedQty: asnQty,
    labelCount,
    labelDistribution,
  });
  if (!result.ok) {
    return {
      ...result,
      message: String(result.message || "").replaceAll("GRN Qty", "ASN Qty"),
    };
  }
  return result;
}

export function distributionDifference(asnQty, distribution = []) {
  const total = sumDistribution(distribution);
  const qty = Number(asnQty) || 0;
  return {
    plannedQty: total,
    asnQty: qty,
    difference: Math.round((total - qty) * 1e6) / 1e6,
  };
}

export function defaultLinePlan(line) {
  const asnQty = Number(line?.asnQty) || 0;
  const existing = Array.isArray(line?.receivingUnits) ? line.receivingUnits : [];
  if (existing.length) {
    const dist = existing.map((ru) => Number(ru.plannedQty) || 0);
    return {
      asnLineId: line.asnLineId,
      labelCount: String(dist.length),
      labelDistribution: dist,
      customText: formatLabelDistribution(dist),
      mode: "existing",
    };
  }
  const dist = suggestedDistribution(asnQty, 1);
  return {
    asnLineId: line.asnLineId,
    labelCount: asnQty > 0 ? "1" : "0",
    labelDistribution: dist,
    customText: formatLabelDistribution(dist),
    mode: "count",
  };
}

/** Backend field is `status`. Only SHIPPED and ARRIVED may prepare RU labels. */
export const RU_PLAN_ELIGIBLE_ASN_STATUSES = Object.freeze(["SHIPPED", "ARRIVED"]);

export function normalizeAsnLifecycleStatus(value) {
  return String(value ?? "").trim().toUpperCase();
}

export function isAsnEligibleForRuPlan(status) {
  return RU_PLAN_ELIGIBLE_ASN_STATUSES.includes(normalizeAsnLifecycleStatus(status));
}

/**
 * Fresh ASN detail `status` is authoritative.
 * A missing/stale list-row status must not override a valid fetched detail status.
 */
export function resolveAsnStatusForRuPlan({ detail, listing, listRow } = {}) {
  const fromDetail = normalizeAsnLifecycleStatus(detail?.status);
  if (fromDetail) return fromDetail;
  const fromListing = normalizeAsnLifecycleStatus(listing?.status);
  if (fromListing) return fromListing;
  return normalizeAsnLifecycleStatus(listRow?.status);
}

export function extractReceivingUnitsListing(payload) {
  if (!payload || typeof payload !== "object") return null;
  if (
    Array.isArray(payload.lines) ||
    Array.isArray(payload.receivingUnits) ||
    typeof payload.eligible === "boolean" ||
    payload.asnNo ||
    payload.asnId
  ) {
    return payload;
  }
  if (payload.data && typeof payload.data === "object") return extractReceivingUnitsListing(payload.data);
  if (payload.listing && typeof payload.listing === "object") return extractReceivingUnitsListing(payload.listing);
  return null;
}

export function formatAsnPlanPartNo(line = {}) {
  const part = String(line.partNo || line.partNumber || "").trim();
  const spn = String(line.spn || line.supplierPartNumber || "").trim();
  if (part && spn && part.toUpperCase() !== spn.toUpperCase()) return `${part} / ${spn}`;
  return part || spn || "";
}

export function mapAsnLineToPlanningRow(line = {}) {
  const asnQty = Number(line.asnQty) || 0;
  return {
    asnLineId: line.asnLineId || line._id,
    article: line.article,
    partNo: formatAsnPlanPartNo(line),
    description: line.description || line.itemName || "",
    asnQty,
    remainingQty: asnQty,
    uom: line.uom || "PCS",
    ruPlanVersion: Number(line.ruPlanVersion) || 0,
    currentPlanBatchId: line.currentPlanBatchId || line.ruActivePlanBatchId || null,
    activeRuCount: Number(line.activeRuCount) || 0,
    activePlannedQty: Number(line.activePlannedQty) || 0,
    printedRuCount: Number(line.printedRuCount) || 0,
    receivingUnits: Array.isArray(line.receivingUnits) ? line.receivingUnits : [],
  };
}

/** Receivable = ASN line qty remaining to plan. Never use remainingAvailableQty (PO leftover at ASN create). */
export function isReceivableAsnPlanningLine(line = {}) {
  const id = line.asnLineId || line._id;
  return Boolean(id) && (Number(line.asnQty) || 0) > 0;
}

const RECEIVED_OR_DISPOSITION_QTY_KEYS = Object.freeze([
  "acceptedQty",
  "damagedQty",
  "rejectedQty",
  "shortQty",
  "excessQty",
  "inspectedQty",
  "receivedQty",
  "countedQty",
  "actualQty",
]);

export const RU_PLAN_LISTING_LOAD_ERROR =
  "Receiving Unit plan could not be loaded. Refresh and try again.";

function hasPersistedRef(value) {
  if (value == null) return false;
  if (typeof value === "boolean") return value === true;
  if (typeof value === "number") return Number.isFinite(value) && value > 0;
  if (typeof value === "string") {
    const s = value.trim();
    if (!s || s === "0") return false;
    return s.toLowerCase() !== "null" && s.toLowerCase() !== "undefined";
  }
  if (typeof value === "object") {
    if (Array.isArray(value)) return value.length > 0;
    return Boolean(value._id || value.id || value.grnNo || value.sessionNo || value.ruNo || value.ruActivePlanBatchId);
  }
  return false;
}

function hasReceivedOrDispositionQty(obj) {
  if (!obj || typeof obj !== "object") return false;
  for (const key of RECEIVED_OR_DISPOSITION_QTY_KEYS) {
    if ((Number(obj[key]) || 0) > 0) return true;
  }
  return false;
}

export function isReceivingUnitsListingAuthoritative(listing) {
  const extracted = extractReceivingUnitsListing(listing);
  return Boolean(extracted && Array.isArray(extracted.lines));
}

/**
 * Detail `asnQty` fallback is allowed only for a proven untouched first preparation.
 * PO remainingAvailableQty is not a receiving/disposition signal.
 */
export function isUntouchedFirstPreparationAsn(detail, context = {}) {
  if (!detail || typeof detail !== "object") return false;
  if (!isAsnEligibleForRuPlan(detail.status)) return false;
  const completeness = detail.receivingCompleteness || context.receivingCompleteness;
  if (!completeness || completeness.complete !== true) return false;

  const lines = Array.isArray(detail.lines) ? detail.lines : [];
  for (const line of lines) {
    const version = line?.ruPlanVersion;
    if (version != null && version !== "" && Number(version) > 0) return false;
    if (hasPersistedRef(line?.ruActivePlanBatchId) || hasPersistedRef(line?.currentPlanBatchId)) return false;
    if (Array.isArray(line?.receivingUnits) && line.receivingUnits.length) return false;
    if (hasReceivedOrDispositionQty(line)) return false;
  }

  if (hasPersistedRef(detail.ruActivePlanBatchId) || hasPersistedRef(detail.currentPlanBatchId)) return false;
  if (Array.isArray(detail.receivingUnits) && detail.receivingUnits.length) return false;
  if ((Number(detail.ruCount) || Number(context.ruCount) || 0) > 0) return false;

  const session = context.session || detail.receivingSession || detail.session;
  if (hasPersistedRef(session) || hasPersistedRef(session?.status) || hasPersistedRef(detail.receivingSessionId)) {
    return false;
  }

  const draftGrn = context.draftGrn || detail.draftGrn;
  const postedGrn = context.postedGrn || detail.postedGrn || detail.grn;
  if (hasPersistedRef(draftGrn) || hasPersistedRef(postedGrn)) return false;
  if (hasPersistedRef(detail.grnNo) || hasPersistedRef(detail.grnId) || hasPersistedRef(context.grnNo)) return false;

  const rus = [
    ...(Array.isArray(context.receivingUnits) ? context.receivingUnits : []),
    ...(Array.isArray(context.rus) ? context.rus : []),
  ];
  if (rus.length) return false;

  const progress = context.progress || detail.progress;
  if (progress && typeof progress === "object") {
    if ((Number(progress.ruTotal) || 0) > 0 || (Number(progress.ruCompleted) || 0) > 0) return false;
    if (hasReceivedOrDispositionQty(progress)) return false;
    if (Array.isArray(progress.articles) && progress.articles.some((row) => hasReceivedOrDispositionQty(row))) {
      return false;
    }
  }

  if (hasReceivedOrDispositionQty(detail) || hasReceivedOrDispositionQty(context)) return false;
  return true;
}

export function resolveRuPlanningLines({ listing, detail, context } = {}) {
  const extracted = extractReceivingUnitsListing(listing);
  if (extracted && Array.isArray(extracted.lines)) {
    return extracted.lines.map(mapAsnLineToPlanningRow).filter(isReceivableAsnPlanningLine);
  }
  if (isUntouchedFirstPreparationAsn(detail, context)) {
    return (detail?.lines || []).map(mapAsnLineToPlanningRow).filter(isReceivableAsnPlanningLine);
  }
  return [];
}

export function shouldShowRuListingLoadError({ listing, detail, context, listingFailed } = {}) {
  if (!listingFailed) return false;
  if (isReceivingUnitsListingAuthoritative(listing)) return false;
  return !isUntouchedFirstPreparationAsn(detail, context);
}

export function isPrintedReceivingUnit(ru) {
  return normalizeAsnLifecycleStatus(ru?.status) === "PRINTED";
}

export function isPlannedReceivingUnit(ru) {
  return normalizeAsnLifecycleStatus(ru?.status) === "PLANNED";
}

export function collectListingReceivingUnits(listing) {
  const extracted = extractReceivingUnitsListing(listing);
  const fromRoot = Array.isArray(extracted?.receivingUnits) ? extracted.receivingUnits : [];
  const fromLines = (extracted?.lines || []).flatMap((line) => line.receivingUnits || []);
  const byId = new Map();
  for (const ru of [...fromRoot, ...fromLines]) {
    const key = String(ru?._id || ru?.ruNo || "");
    if (key && !byId.has(key)) byId.set(key, ru);
  }
  return [...byId.values()];
}

/** True reprint only when a persisted printed RU exists — never from a default reason value. */
export function isRuReprintMode(listing) {
  return collectListingReceivingUnits(listing).some(isPrintedReceivingUnit);
}

/** First print only from a loaded listing with no printed RUs. Missing listing is not first print. */
export function isRuFirstPrintMode(listing) {
  if (!extractReceivingUnitsListing(listing)) return false;
  return !isRuReprintMode(listing);
}

export function isValidReceivingUnitPlan(lines, plans = {}) {
  if (!Array.isArray(lines) || !lines.length) return false;
  return lines.every((line) => {
    const plan = plans[String(line.asnLineId)] || defaultLinePlan(line);
    const diff = distributionDifference(line.asnQty, plan.labelDistribution || []);
    return Math.abs(diff.difference) < 1e-6 && (plan.labelDistribution || []).length > 0;
  });
}

export function buildRuFirstPrintRequestBody({ printerCode } = {}) {
  const body = {};
  const code = String(printerCode || "").trim();
  if (code) body.printerCode = code;
  return body;
}

export function buildRuReprintRequestBody({ reason, printerCode } = {}) {
  const r = String(reason || "").trim();
  if (!r) return { ok: false, message: "Reprint reason is required" };
  const body = { reason: r };
  const code = String(printerCode || "").trim();
  if (code) body.printerCode = code;
  return { ok: true, body };
}

export function canPrintSavedRuPlan(previewFaces = []) {
  return (previewFaces || []).some((ru) => isPlannedReceivingUnit(ru));
}

export { formatLabelDistribution, parseDistributionInput, sumDistribution };
