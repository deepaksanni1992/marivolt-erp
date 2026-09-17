/** Shared commercial header fields for Tax Invoice and Packing List. Invoice wins after it exists. */

export const PACKING_INVOICE_SHARED_HEADER_FIELDS = Object.freeze([
  "consignee",
  "loadingPort",
  "dischargePort",
  "customerName",
  "customerReference",
  "contactPerson",
  "attention",
  "paymentTerms",
  "billingAddress",
  "shippingAddress",
  "customerVatNo",
  "vertical",
  "engine",
  "model",
  "config",
  "esn",
  "currency",
]);

export function packingHeaderSetFromInvoice(invoice = {}) {
  const $set = {};
  for (const key of PACKING_INVOICE_SHARED_HEADER_FIELDS) {
    if (invoice[key] === undefined || invoice[key] === null) continue;
    $set[key] = invoice[key];
  }
  return $set;
}

export function mergePackingHeaderFromInvoice(packing = {}, invoice = {}) {
  if (!invoice) return { ...packing };
  const next = { ...packing };
  for (const key of PACKING_INVOICE_SHARED_HEADER_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(invoice, key)) continue;
    next[key] = invoice[key];
  }
  return next;
}
