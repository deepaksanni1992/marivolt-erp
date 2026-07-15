/**
 * Shared customer contact / address / commercial payment-terms helpers.
 *
 * Credit Terms (Customer.paymentTerms = ADVANCE|CREDIT) are NEVER mapped here.
 * They remain an internal ERP workflow flag only.
 *
 * Conversion: use copyCustomerTransactionFields / resolveDocumentCustomerFields
 * on source documents only — never reload Customer Master during conversion.
 */

export const CUSTOMER_FIELD_LIMITS = {
  contactPerson: 200,
  attention: 200,
  paymentTerms: 1000,
  billingAddress: 2000,
  shippingAddress: 2000,
};

/** Trim ends only — preserves internal newlines for multiline Payment Terms / addresses. */
export function clampText(value, maxLen) {
  const s = String(value ?? "").replace(/^\s+|\s+$/g, "");
  if (!maxLen || s.length <= maxLen) return s;
  return s.slice(0, maxLen);
}

/**
 * Map Customer Master → transaction snapshot defaults (create / customer-select only).
 * Commercial payment terms come ONLY from documentPaymentTerms (never ADVANCE/CREDIT).
 */
export function mapCustomerMasterToTransactionDefaults(customer = {}) {
  const billing =
    String(customer.billingAddress || "").trim() || String(customer.address || "").trim();
  const shipping =
    String(customer.shippingAddress || "").trim() ||
    String(customer.billingAddress || "").trim() ||
    String(customer.address || "").trim();
  const contactPerson = String(customer.contactName || customer.contactPerson || "").trim();
  const attention =
    String(customer.attention || "").trim() || contactPerson;
  const paymentTerms = String(customer.documentPaymentTerms || "").trim();
  return {
    contactPerson: clampText(contactPerson, CUSTOMER_FIELD_LIMITS.contactPerson),
    attention: clampText(attention, CUSTOMER_FIELD_LIMITS.attention),
    billingAddress: clampText(billing, CUSTOMER_FIELD_LIMITS.billingAddress),
    shippingAddress: clampText(shipping, CUSTOMER_FIELD_LIMITS.shippingAddress),
    paymentTerms: clampText(paymentTerms, CUSTOMER_FIELD_LIMITS.paymentTerms),
  };
}

export function firstNonEmpty(...candidates) {
  for (const c of candidates) {
    const s = String(c ?? "").replace(/^\s+|\s+$/g, "");
    if (s) return s;
  }
  return "";
}

/** Ignore Customer Master ADVANCE/CREDIT flags when resolving commercial payment terms. */
function commercialPaymentText(value) {
  const s = String(value ?? "").replace(/^\s+|\s+$/g, "");
  if (!s) return "";
  const upper = s.toUpperCase();
  if (upper === "ADVANCE" || upper === "CREDIT") return "";
  return s;
}

/**
 * Resolve Contact Person / Attention / Billing / Shipping / Payment Terms from a document
 * using non-destructive fallbacks (never mutates or reloads Customer Master).
 */
export function resolveDocumentCustomerFields(doc = {}, fallbacks = {}) {
  const cust = doc.customer || {};
  const snap = doc.customerSnapshot || {};
  return {
    contactPerson: clampText(
      firstNonEmpty(
        doc.contactPerson,
        snap.contactPerson,
        cust.contactPerson,
        cust.contactName,
        fallbacks.contactPerson
      ),
      CUSTOMER_FIELD_LIMITS.contactPerson
    ),
    attention: clampText(
      firstNonEmpty(doc.attention, snap.attention, cust.attention, fallbacks.attention),
      CUSTOMER_FIELD_LIMITS.attention
    ),
    billingAddress: clampText(
      firstNonEmpty(
        doc.billingAddress,
        doc.billing,
        snap.billingAddress,
        cust.billingAddress,
        doc.customerAddress,
        fallbacks.billingAddress
      ),
      CUSTOMER_FIELD_LIMITS.billingAddress
    ),
    shippingAddress: clampText(
      firstNonEmpty(
        doc.shippingAddress,
        doc.shipping,
        doc.deliveryAddress,
        snap.shippingAddress,
        cust.shippingAddress,
        fallbacks.shippingAddress
      ),
      CUSTOMER_FIELD_LIMITS.shippingAddress
    ),
    paymentTerms: clampText(
      firstNonEmpty(
        commercialPaymentText(doc.paymentTerms),
        commercialPaymentText(doc.paymentTerm),
        commercialPaymentText(doc.termsOfPayment),
        commercialPaymentText(snap.paymentTerms),
        commercialPaymentText(cust.documentPaymentTerms),
        commercialPaymentText(fallbacks.paymentTerms)
      ),
      CUSTOMER_FIELD_LIMITS.paymentTerms
    ),
  };
}

/**
 * Copy transaction snapshot fields for conversion (source → destination).
 * Prefer source document, then linked preceding document.
 * Do NOT pass Customer Master for conversion — keep customerDefaults for create-time only.
 */
export function copyCustomerTransactionFields(source = {}, opts = {}) {
  const { preceding = null, customerDefaults = null } = opts;
  const fromSource = resolveDocumentCustomerFields(source);
  const fromPreceding = preceding ? resolveDocumentCustomerFields(preceding) : {};
  const fromMaster = customerDefaults || {};
  const keys = ["contactPerson", "attention", "billingAddress", "shippingAddress", "paymentTerms"];
  const out = {};
  for (const key of keys) {
    out[key] = clampText(
      firstNonEmpty(fromSource[key], fromPreceding[key], fromMaster[key]),
      CUSTOMER_FIELD_LIMITS[key]
    );
  }
  return out;
}

/** Sanitize/clamp snapshot fields from a request body (optional each). */
export function pickCustomerTransactionFieldsFromBody(body = {}) {
  const out = {};
  if (body.contactPerson !== undefined) {
    out.contactPerson = clampText(body.contactPerson, CUSTOMER_FIELD_LIMITS.contactPerson);
  }
  if (body.attention !== undefined) {
    out.attention = clampText(body.attention, CUSTOMER_FIELD_LIMITS.attention);
  }
  if (body.billingAddress !== undefined) {
    out.billingAddress = clampText(body.billingAddress, CUSTOMER_FIELD_LIMITS.billingAddress);
  }
  if (body.shippingAddress !== undefined) {
    out.shippingAddress = clampText(body.shippingAddress, CUSTOMER_FIELD_LIMITS.shippingAddress);
  }
  if (body.paymentTerms !== undefined) {
    out.paymentTerms = clampText(
      commercialPaymentText(body.paymentTerms),
      CUSTOMER_FIELD_LIMITS.paymentTerms
    );
  }
  return out;
}

export function buildPartySnapshotFromFields(customerName, fields = {}, customer = null) {
  return {
    name: customerName || customer?.name || "",
    billingAddress: fields.billingAddress || customer?.address || "",
    shippingAddress: fields.shippingAddress || fields.billingAddress || customer?.address || "",
    contactPerson: fields.contactPerson || customer?.contactName || "",
    email: customer?.email || "",
    phone: customer?.phone || "",
    country: "",
  };
}

/** Diff snapshot fields for existing audit writeAudit metadata.
 * Returns [{ field, oldValue, newValue }, ...] or null. User/timestamp come from AuditLog.
 */
export function diffCustomerTransactionFields(before = {}, after = {}) {
  const keys = ["contactPerson", "attention", "billingAddress", "shippingAddress", "paymentTerms"];
  const changes = [];
  for (const key of keys) {
    const oldValue = String(before[key] ?? "").replace(/^\s+|\s+$/g, "");
    const newValue = String(after[key] ?? "").replace(/^\s+|\s+$/g, "");
    if (oldValue !== newValue) {
      changes.push({ field: key, oldValue, newValue });
    }
  }
  return changes.length ? changes : null;
}

/** Compact before/after slices for customer snapshot fields in writeAudit payloads. */
export function customerTransactionAuditFieldSlice(doc = {}) {
  return {
    contactPerson: String(doc.contactPerson || ""),
    attention: String(doc.attention || ""),
    billingAddress: String(doc.billingAddress || ""),
    shippingAddress: String(doc.shippingAddress || ""),
    paymentTerms: String(doc.paymentTerms || ""),
  };
}

/** Shared search $or clauses for document lists (no address / payment terms). */
export function customerDetailSearchOr(q, extra = []) {
  const re = new RegExp(String(q || "").trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  return [
    { customerName: re },
    { contactPerson: re },
    { attention: re },
    { customerReference: re },
    { customerPORef: re },
    ...extra.map((field) => ({ [field]: re })),
  ];
}
