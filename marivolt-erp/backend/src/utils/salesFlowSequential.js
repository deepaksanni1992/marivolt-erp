/**
 * Strict sequential sales-flow helpers (QTN → OA → PI|ALLOC → Packing → SI).
 * OA.paymentType (ADVANCE|CREDIT) is authoritative for branching — not commercial paymentTerms text.
 */

export const OA_PAYMENT_TYPES = Object.freeze(["ADVANCE", "CREDIT"]);

/**
 * Documents created before this timestamp may belong to the historical
 * QTN→PI workflow that existed before OA became mandatory.
 *
 * Fixed at sequential sales-flow deployment (2026-08-09 UTC start-of-day).
 * All audited live PIs without OA lineage were created on or before 2026-07-15.
 * Deterministic — do not replace with Date.now() or env unless operationally required.
 */
export const STRICT_SALES_FLOW_CUTOFF = new Date("2026-08-09T00:00:00.000Z");

export const SALES_FLOW_ERRORS = Object.freeze({
  QTN_PI: "Order Acknowledgement is required before creating Proforma Invoice.",
  QTN_CIPL: "CIPL can only be created from Sales Invoice.",
  OA_CIPL: "CIPL can only be created from Sales Invoice.",
  PI_CIPL: "CIPL can only be created from Sales Invoice.",
  CREDIT_OA_PI:
    "This Order Acknowledgement has CREDIT payment terms. Create Order Allocation directly.",
  ADVANCE_OA_ALLOC:
    "This Order Acknowledgement requires advance payment. Create Proforma Invoice first.",
  OA_PAYMENT_TYPE_REQUIRED:
    "Order Acknowledgement payment type is not set. Set ADVANCE or CREDIT before converting.",
  OA_PAYMENT_TYPE_LOCKED:
    "Order Acknowledgement payment type cannot be changed after a Proforma Invoice or Order Allocation exists.",
  OA_PAYMENT_TYPE_UNRESOLVED:
    "Unable to determine workflow payment type for this Order Acknowledgement. Select ADVANCE or CREDIT.",
  OA_MUST_FROM_QTN: "Order Acknowledgement must be created from a Quotation.",
  PI_MUST_FROM_ADVANCE_OA: "Proforma Invoice must be created from an ADVANCE Order Acknowledgement.",
  PI_MISSING_OA: "Proforma Invoice is missing required Order Acknowledgement lineage.",
  PI_OA_NOT_ADVANCE:
    "Proforma Invoice Order Acknowledgement must have ADVANCE payment type before Allocation.",
  SI_FROM_PACKING_ONLY: "Sales Invoice can only be created from completed Packing.",
  CIPL_FROM_SI_ONLY: "CIPL can only be created from Sales Invoice.",
});

export function normalizeOaPaymentType(value) {
  const raw = String(value || "").trim().toUpperCase();
  if (raw === "ADVANCE" || raw === "CREDIT") return raw;
  return "";
}

/**
 * @param {object|null|undefined} oa
 * @returns {"ADVANCE"|"CREDIT"|""}
 */
export function resolveOaWorkflowPaymentType(oa) {
  const set = normalizeOaPaymentType(oa?.paymentType);
  if (set) return set;
  // Historical OA without paymentType: infer only from conversions already taken.
  const conv = Array.isArray(oa?.convertedTo)
    ? oa.convertedTo.map((x) => String(x || "").toUpperCase())
    : [];
  if (conv.includes("PROFORMA")) return "ADVANCE";
  if (conv.includes("ORDER_ALLOCATION")) return "CREDIT";
  return "";
}

/**
 * Customer Master workflow Credit Terms (ADVANCE|CREDIT) — default snapshot only.
 * Returns "" when missing/invalid — never silently CREDIT.
 * @param {object|null|undefined} customer
 */
export function resolveCustomerWorkflowPaymentType(customer) {
  return normalizeOaPaymentType(customer?.paymentTerms);
}

/**
 * @param {object|null|undefined} customer
 * @returns {"ADVANCE"|"CREDIT"}
 */
export function requireCustomerWorkflowPaymentType(customer) {
  const pt = resolveCustomerWorkflowPaymentType(customer);
  if (!pt) throw statusError(SALES_FLOW_ERRORS.OA_PAYMENT_TYPE_UNRESOLVED, 422);
  return pt;
}

/**
 * Historical PI without OA: created before strict sequential deployment and missing linkedOAId.
 * Does not invent OA lineage.
 * @param {object|null|undefined} pi
 */
export function isLegacyPiWithoutOa(pi) {
  if (pi?.linkedOAId) return false;
  const created = pi?.createdAt ? new Date(pi.createdAt) : null;
  if (!created || Number.isNaN(created.getTime())) return false;
  return created < STRICT_SALES_FLOW_CUTOFF;
}

/**
 * PI → Allocation lineage gate.
 * STRICT: requires linkedOAId (caller validates ADVANCE OA).
 * LEGACY: missing linkedOAId but created before cutoff — allow blank OA on allocation.
 * @param {object|null|undefined} pi
 * @returns {{ mode: "STRICT"|"LEGACY", legacy: boolean }}
 */
export function assertPiMayConvertToAllocation(pi) {
  if (pi?.linkedOAId) return { mode: "STRICT", legacy: false };
  if (isLegacyPiWithoutOa(pi)) return { mode: "LEGACY", legacy: true };
  throw statusError(SALES_FLOW_ERRORS.PI_MISSING_OA, 422);
}

/**
 * @deprecated Prefer assertPiMayConvertToAllocation for PI→Allocation.
 */
export function assertPiHasExplicitOaLineage(pi) {
  if (!pi?.linkedOAId) throw statusError(SALES_FLOW_ERRORS.PI_MISSING_OA, 422);
}

/**
 * Downstream conversion has started — lock paymentType edits.
 * @param {object|null|undefined} oa
 */
export function isOaPaymentTypeLocked(oa) {
  if (!oa) return false;
  const conv = Array.isArray(oa.convertedTo) ? oa.convertedTo.map((x) => String(x || "").toUpperCase()) : [];
  if (conv.some((x) => ["PROFORMA", "ORDER_ALLOCATION", "SALES_INVOICE", "PACKING"].includes(x))) {
    return true;
  }
  const st = String(oa.status || "").toUpperCase();
  if (
    [
      "PARTIALLY_PI_ISSUED",
      "FULLY_PI_ISSUED",
      "PACKING",
      "COMPLETED",
      "CLOSED",
      "CONVERTED",
    ].includes(st)
  ) {
    return true;
  }
  return false;
}

export function statusError(message, statusCode = 409) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

export function assertOaPaymentTypeSet(oa) {
  const pt = resolveOaWorkflowPaymentType(oa);
  if (!pt) throw statusError(SALES_FLOW_ERRORS.OA_PAYMENT_TYPE_REQUIRED, 422);
  return pt;
}

export function assertAdvanceOaForProforma(oa) {
  const pt = assertOaPaymentTypeSet(oa);
  if (pt !== "ADVANCE") throw statusError(SALES_FLOW_ERRORS.CREDIT_OA_PI, 409);
  return pt;
}

export function assertCreditOaForAllocation(oa) {
  const pt = assertOaPaymentTypeSet(oa);
  if (pt !== "CREDIT") throw statusError(SALES_FLOW_ERRORS.ADVANCE_OA_ALLOC, 409);
  return pt;
}

/**
 * Immediate-next conversion targets for UI/API metadata.
 * @param {object|null|undefined} oa
 */
export function oaImmediateNextActions(oa) {
  const pt = resolveOaWorkflowPaymentType(oa);
  if (pt === "ADVANCE") {
    return { paymentType: pt, convertToProforma: true, convertToAllocation: false };
  }
  if (pt === "CREDIT") {
    return { paymentType: pt, convertToProforma: false, convertToAllocation: true };
  }
  return { paymentType: "", convertToProforma: false, convertToAllocation: false };
}
