/**
 * S1 — Sales Invoice independent state model.
 *
 * documentStatus  — invoice lifecycle only (DRAFT / ISSUED / CANCELLED)
 * paymentStatus   — from receipts only (UNPAID / PARTIALLY_PAID / PAID)
 * dispatchStatus  — from Store Dispatch qty only (NOT / PARTIAL / FULL)
 *
 * Legacy `status` is deprecated compatibility. Do not encode payment or
 * dispatch into it after S1. Prefer reading the three fields.
 */

export const DOCUMENT_STATUSES = Object.freeze(["DRAFT", "ISSUED", "CANCELLED"]);
export const PAYMENT_STATUSES = Object.freeze(["UNPAID", "PARTIALLY_PAID", "PAID"]);
/** Legacy PARTIAL kept for read normalization only. */
export const PAYMENT_STATUS_ALIASES = Object.freeze({ PARTIAL: "PARTIALLY_PAID" });
export const DISPATCH_STATUSES = Object.freeze([
  "NOT_DISPATCHED",
  "PARTIALLY_DISPATCHED",
  "FULLY_DISPATCHED",
]);

export const DEFAULT_TOLERANCE = 1e-4;
export const DEFAULT_QTY_TOLERANCE = 1e-6;

export function normalizePaymentStatus(value) {
  const raw = String(value || "UNPAID").trim().toUpperCase();
  const mapped = PAYMENT_STATUS_ALIASES[raw] || raw;
  return PAYMENT_STATUSES.includes(mapped) ? mapped : "UNPAID";
}

export function normalizeDocumentStatus(value) {
  const raw = String(value || "DRAFT").trim().toUpperCase();
  return DOCUMENT_STATUSES.includes(raw) ? raw : "DRAFT";
}

export function normalizeDispatchStatus(value) {
  const raw = String(value || "NOT_DISPATCHED").trim().toUpperCase();
  return DISPATCH_STATUSES.includes(raw) ? raw : "NOT_DISPATCHED";
}

/**
 * Canonical payment status from financial evidence.
 */
export function computePaymentStatus({
  grandTotal,
  receivedAmount,
  tolerance = DEFAULT_TOLERANCE,
} = {}) {
  const total = Math.max(0, Number(grandTotal) || 0);
  const received = Math.max(0, Number(receivedAmount) || 0);
  if (received <= tolerance) return "UNPAID";
  if (total > 0 && received >= total - tolerance) return "PAID";
  if (received > tolerance) return "PARTIALLY_PAID";
  return "UNPAID";
}

/**
 * Canonical dispatch status from Store Dispatch quantities (physical authority).
 * SalesDispatch logistics alone must not drive this.
 */
export function computeDispatchStatus({
  invoiceQty,
  dispatchedQty,
  tolerance = DEFAULT_QTY_TOLERANCE,
} = {}) {
  const inv = Math.max(0, Number(invoiceQty) || 0);
  const disp = Math.max(0, Number(dispatchedQty) || 0);
  if (disp <= tolerance) return "NOT_DISPATCHED";
  if (inv > 0 && disp >= inv - tolerance) return "FULLY_DISPATCHED";
  return "PARTIALLY_DISPATCHED";
}

/**
 * Deprecated legacy `status` projection for read compatibility only.
 * Never encodes PAID / PARTIALLY_PAID / DISPATCHED after S1 writes.
 */
export function legacyStatusFromDimensions({ documentStatus } = {}) {
  const doc = normalizeDocumentStatus(documentStatus);
  if (doc === "CANCELLED") return "CANCELLED";
  if (doc === "DRAFT") return "DRAFT";
  return "ISSUED";
}

/**
 * Classify a live/legacy invoice for migration (evidence-driven).
 */
export function classifyInvoiceForMigration(inv, evidence = {}) {
  const legacy = String(inv?.status || "").toUpperCase();
  const received = Math.max(0, Number(evidence.receivedAmount) || 0);
  const total = Math.max(0, Number(evidence.grandTotal ?? inv?.grandTotal) || 0);
  const invoiceQty = Math.max(0, Number(evidence.invoiceQty) || 0);
  const storeDispatchedQty = Math.max(0, Number(evidence.storeDispatchedQty) || 0);
  const hasSalesDispatchOnly = Boolean(evidence.hasSalesDispatchOnly);

  let documentStatus = "ISSUED";
  if (legacy === "DRAFT") documentStatus = "DRAFT";
  else if (legacy === "CANCELLED") documentStatus = "CANCELLED";
  else documentStatus = "ISSUED";

  const paymentStatus = computePaymentStatus({ grandTotal: total, receivedAmount: received });
  const dispatchStatus = computeDispatchStatus({
    invoiceQty,
    dispatchedQty: storeDispatchedQty,
  });

  const ambiguous =
    hasSalesDispatchOnly &&
    (legacy === "DISPATCHED" || storeDispatchedQty <= 0) &&
    dispatchStatus === "NOT_DISPATCHED";

  return {
    documentStatus,
    paymentStatus,
    dispatchStatus,
    legacyStatusCompat: legacyStatusFromDimensions({ documentStatus }),
    ambiguous,
    ambiguousReason: ambiguous ? "SALES_DISPATCH_ONLY_WITHOUT_STORE_DISPATCH" : null,
  };
}

/** Invoice is eligible for Store Dispatch when document is issued (not cancelled). */
export function isInvoiceDispatchEligible(invoice) {
  const doc = normalizeDocumentStatus(
    invoice?.documentStatus ||
      (["DRAFT", "CANCELLED"].includes(String(invoice?.status || "").toUpperCase())
        ? invoice.status
        : "ISSUED")
  );
  return doc === "ISSUED";
}

/** Protected fields clients must not mass-assign. */
export const SI_PROTECTED_STATE_FIELDS = Object.freeze([
  "documentStatus",
  "paymentStatus",
  "dispatchStatus",
  "status",
  "totalReceivedAmount",
  "balanceAmount",
  "stockPostedAt",
  "cancelledAt",
  "cancelledBy",
]);

export function rejectProtectedSiStateFields(body = {}) {
  const hit = SI_PROTECTED_STATE_FIELDS.filter((k) => k in (body || {}));
  if (!hit.length) return null;
  const err = new Error(`Protected invoice state fields are not allowed: ${hit.join(", ")}`);
  err.code = "SI_PROTECTED_FIELD_REJECTED";
  err.statusCode = 400;
  err.fields = hit;
  return err;
}
