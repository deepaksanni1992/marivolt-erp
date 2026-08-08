/**
 * Read-model helpers for Allocation packing / picking sheet lineage.
 * Reuses packing customer-reference precedence (OA → PI → Quotation).
 * Does not mutate OrderAllocation or numbering.
 */

function t(v) {
  return String(v ?? "").trim();
}

function displayOrEmpty(v) {
  return t(v) || "";
}

/**
 * Same precedence as storeOutboundController.resolveCustomerSnapshotForAllocation:
 * OA.customerPORef → PI.customerReference → Quotation.customerReference
 *
 * Only uses documents supplied by the caller (company-scoped queries).
 * Missing / cross-company docs must be passed as null/undefined — they are not resolved by number.
 *
 * @param {{ oa?: object|null, pi?: object|null, quotation?: object|null }} lineage
 * @returns {string}
 */
export function resolveCustomerReferenceFromLineage({ oa = null, pi = null, quotation = null } = {}) {
  const candidates = [oa?.customerPORef, pi?.customerReference, quotation?.customerReference];
  for (const c of candidates) {
    const s = t(c);
    if (s) return s;
  }
  return "";
}

/**
 * Normalized document references for packing / picking sheet UI + PDF.
 *
 * @param {{
 *   allocation?: object|null,
 *   oa?: object|null,
 *   pi?: object|null,
 *   quotation?: object|null,
 * }} args
 */
export function buildAllocationDocumentReferences({
  allocation = null,
  oa = null,
  pi = null,
  quotation = null,
} = {}) {
  const allocationNo = displayOrEmpty(allocation?.allocationNo);
  const customerName = displayOrEmpty(allocation?.customerName);
  const warehouse = displayOrEmpty(allocation?.warehouse) || "MAIN";
  const quotationNo = displayOrEmpty(
    allocation?.linkedQuotationNo || quotation?.quotationNo || quotation?.quotationNumber
  );
  const orderAcknowledgementNo = displayOrEmpty(allocation?.linkedOANo || oa?.oaNo);
  const proformaNo = displayOrEmpty(allocation?.linkedProformaNo || pi?.proformaNo);
  const customerReference = resolveCustomerReferenceFromLineage({ oa, pi, quotation });

  return {
    allocationNo,
    customerName,
    customerReference,
    quotationNo,
    orderAcknowledgementNo,
    proformaNo,
    warehouse,
    allocationDate: allocation?.allocationDate || null,
  };
}

/**
 * Display helper: empty string → em dash for UI/PDF.
 * @param {string} v
 */
export function dashIfEmpty(v) {
  return t(v) || "—";
}
