/** Frontend helpers for Contact Person / Attention / Billing / Shipping / Payment Terms. */

export const CUSTOMER_FIELD_LIMITS = {
  contactPerson: 200,
  attention: 200,
  paymentTerms: 1000,
  billingAddress: 2000,
  shippingAddress: 2000,
};

/** Trim ends only — preserves internal newlines. */
export function clampText(value, maxLen) {
  const s = String(value ?? "").replace(/^\s+|\s+$/g, "");
  if (!maxLen || s.length <= maxLen) return s;
  return s.slice(0, maxLen);
}

function commercialPaymentText(value) {
  const s = String(value ?? "").replace(/^\s+|\s+$/g, "");
  if (!s) return "";
  const upper = s.toUpperCase();
  if (upper === "ADVANCE" || upper === "CREDIT") return "";
  return s;
}

export function firstNonEmpty(...candidates) {
  for (const c of candidates) {
    const s = String(c ?? "").replace(/^\s+|\s+$/g, "");
    if (s) return s;
  }
  return "";
}

/**
 * Defaults from Customer Master.
 * Payment Terms = documentPaymentTerms only (never ADVANCE/CREDIT Credit Terms).
 */
export function mapCustomerMasterToTransactionDefaults(customer = {}) {
  const billing =
    String(customer.billingAddress || "").trim() || String(customer.address || "").trim();
  const shipping =
    String(customer.shippingAddress || "").trim() ||
    String(customer.billingAddress || "").trim() ||
    String(customer.address || "").trim();
  const contactPerson = String(customer.contactName || customer.contactPerson || "").trim();
  const attention = String(customer.attention || "").trim() || contactPerson;
  const paymentTerms = String(customer.documentPaymentTerms || "").trim();
  return {
    contactPerson: clampText(contactPerson, CUSTOMER_FIELD_LIMITS.contactPerson),
    attention: clampText(attention, CUSTOMER_FIELD_LIMITS.attention),
    billingAddress: clampText(billing, CUSTOMER_FIELD_LIMITS.billingAddress),
    shippingAddress: clampText(shipping, CUSTOMER_FIELD_LIMITS.shippingAddress),
    paymentTerms: clampText(paymentTerms, CUSTOMER_FIELD_LIMITS.paymentTerms),
  };
}

/** Resolve display/print values with historical fallbacks. */
export function resolveDocumentCustomerFields(doc = {}) {
  const cust = doc.customer || {};
  const snap = doc.customerSnapshot || {};
  return {
    contactPerson:
      firstNonEmpty(
        doc.contactPerson,
        snap.contactPerson,
        cust.contactPerson,
        cust.contactName
      ) || "-",
    attention: firstNonEmpty(doc.attention, snap.attention, cust.attention) || "-",
    billingAddress:
      firstNonEmpty(
        doc.billingAddress,
        doc.billing,
        snap.billingAddress,
        cust.billingAddress,
        doc.customerAddress
      ) || "-",
    shippingAddress:
      firstNonEmpty(
        doc.shippingAddress,
        doc.shipping,
        doc.deliveryAddress,
        snap.shippingAddress,
        cust.shippingAddress
      ) || "-",
    paymentTerms:
      firstNonEmpty(
        commercialPaymentText(doc.paymentTerms),
        commercialPaymentText(doc.paymentTerm),
        commercialPaymentText(doc.termsOfPayment),
        commercialPaymentText(snap.paymentTerms),
        commercialPaymentText(cust.documentPaymentTerms)
      ) || "-",
  };
}

export function resolveCustomerRef(doc = {}, explicitRef) {
  return (
    firstNonEmpty(
      explicitRef,
      doc.customerReference,
      doc.customerPORef,
      doc.customerRef
    ) || "-"
  );
}

/**
 * Standard CUSTOMER & ADDRESS INFO rows for print/PDF cards.
 * Payment Terms / addresses marked multiline for pre-wrap rendering.
 */
export function buildCustomerAddressInfoRows(doc = {}, opts = {}) {
  const fields = resolveDocumentCustomerFields(doc);
  const rows = [
    { label: "Customer", value: doc.customerName || "-" },
    { label: "Customer Ref", value: resolveCustomerRef(doc, opts.customerRef) },
    { label: "Contact Person", value: fields.contactPerson },
    { label: "Attention", value: fields.attention },
    { label: "Payment Terms", value: fields.paymentTerms, multiline: true },
  ];
  if (Array.isArray(opts.insertAfterPaymentTerms) && opts.insertAfterPaymentTerms.length) {
    rows.push(...opts.insertAfterPaymentTerms);
  }
  rows.push(
    { label: "Billing Address", value: fields.billingAddress, multiline: true },
    { label: "Shipping Address", value: fields.shippingAddress, multiline: true }
  );
  return rows;
}

function escHtml(v) {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** HTML block for Quotation / OA / PI / SI flow prints (matches existing info-box markup). */
export function buildCustomerAddressInfoBoxHtml(doc = {}, opts = {}) {
  const title = opts.title || "Customer & Address Info";
  const rows = buildCustomerAddressInfoRows(doc, opts)
    .map((r) => {
      const val = escHtml(r.value ?? "-");
      const valueHtml = r.multiline
        ? `<span class="mv-address-block">${val}</span>`
        : val;
      return `<div><b>${escHtml(r.label)}:</b> ${valueHtml}</div>`;
    })
    .join("");
  return `
          <div class="info-box muted">
            <div class="info-box-title">${escHtml(title)}</div>
            ${rows}
          </div>`;
}

export function formatAddressHtml(value, escFn) {
  const raw = String(value ?? "").replace(/^\s+|\s+$/g, "") || "-";
  const escaped = typeof escFn === "function" ? escFn(raw) : escHtml(raw);
  return `<span class="mv-address-block">${escaped}</span>`;
}

export const CUSTOMER_ADDRESS_PRINT_CSS = `
.mv-address-block {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  word-break: break-word;
  display: inline;
}
`;
