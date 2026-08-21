/**
 * ASN / GRN field-ownership helpers (Phase 1).
 *
 * Canonical resolution for:
 * - ASN header supplierInvoices[] (+ legacy scalar compatibility)
 * - ASN line HS Code / Country of Origin (+ legacy header COO fallback)
 * - BOE number normalization for company-scoped lookup
 *
 * Do not scatter line.countryOfOrigin || asn.countryOfOrigin elsewhere.
 */

function t(v) {
  return String(v ?? "").trim();
}

function upper(v) {
  return t(v).toUpperCase();
}

function parseInvoiceDate(value) {
  if (value == null || value === "") return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

function invoiceSortKey(inv = {}) {
  const d = parseInvoiceDate(inv.invoiceDate);
  const ts = d ? d.getTime() : Number.POSITIVE_INFINITY;
  return { ts, number: upper(inv.invoiceNumber) };
}

/**
 * Normalize a legal BOE number for lookup/conflict detection.
 * Trim + stable case fold only — do not strip internal punctuation/spaces.
 */
export function normalizeBoeNumber(value) {
  return upper(value);
}

/**
 * Normalize incoming supplier invoice rows. Drops empty rows.
 */
export function normalizeSupplierInvoiceRows(rows = []) {
  const out = [];
  for (const row of rows || []) {
    const invoiceNumber = t(row?.invoiceNumber ?? row?.supplierInvoiceNumber ?? row?.number);
    const invoiceDate = parseInvoiceDate(row?.invoiceDate ?? row?.supplierInvoiceDate ?? row?.date);
    if (!invoiceNumber && !invoiceDate) continue;
    out.push({ invoiceNumber, invoiceDate });
  }
  return out;
}

/**
 * Canonical ASN supplier invoice list.
 * Prefer supplierInvoices[]; fall back to legacy scalar header fields.
 * Does not mutate the ASN document.
 */
export function resolveAsnSupplierInvoices(asn = {}) {
  const fromArray = normalizeSupplierInvoiceRows(asn?.supplierInvoices);
  if (fromArray.length) return fromArray;
  const invoiceNumber = t(asn?.supplierInvoiceNumber);
  const invoiceDate = parseInvoiceDate(asn?.supplierInvoiceDate);
  if (!invoiceNumber && !invoiceDate) return [];
  return [{ invoiceNumber, invoiceDate }];
}

/**
 * Deterministic scalar snapshot for CustomsLot FIFO (single date required by schema).
 * Rule: earliest invoiceDate; ties broken by invoiceNumber (A–Z).
 * When no dated invoice exists, first remaining row by invoiceNumber.
 */
export function pickAsnSupplierInvoiceFifoSnapshot(asn = {}) {
  const invoices = resolveAsnSupplierInvoices(asn);
  if (!invoices.length) {
    return { invoiceNumber: "", invoiceDate: null, invoices: [] };
  }
  const sorted = [...invoices].sort((a, b) => {
    const ka = invoiceSortKey(a);
    const kb = invoiceSortKey(b);
    if (ka.ts !== kb.ts) return ka.ts - kb.ts;
    return ka.number.localeCompare(kb.number);
  });
  const chosen = sorted[0];
  return {
    invoiceNumber: chosen.invoiceNumber || "",
    invoiceDate: chosen.invoiceDate || null,
    invoices,
  };
}

/**
 * Populate legacy scalar shadow fields from the FIFO snapshot (compatibility write).
 * Does not remove supplierInvoices[].
 */
export function applySupplierInvoiceScalarShadow(asnLike = {}, invoices = null) {
  const list = invoices != null ? normalizeSupplierInvoiceRows(invoices) : resolveAsnSupplierInvoices(asnLike);
  const snap = pickAsnSupplierInvoiceFifoSnapshot({
    ...asnLike,
    supplierInvoices: list,
    supplierInvoiceNumber: "",
    supplierInvoiceDate: null,
  });
  return {
    supplierInvoices: list,
    supplierInvoiceNumber: snap.invoiceNumber,
    supplierInvoiceDate: snap.invoiceDate,
  };
}

/**
 * Authoritative HS Code for an ASN line (no header fallback).
 */
export function resolveAsnLineHsCode(asnLine = {}) {
  return upper(asnLine?.hsCode);
}

/**
 * Authoritative Country of Origin for an ASN line.
 * Legacy: when line COO is absent, fall back to ASN header countryOfOrigin.
 * New/edited lines should carry line.countryOfOrigin.
 */
export function resolveAsnLineCountryOfOrigin(asnLine = {}, asn = {}) {
  const line = t(asnLine?.countryOfOrigin);
  if (line) return upper(line);
  return upper(asn?.countryOfOrigin);
}

export function assertAsnSupplierInvoicesPresent(asn = {}) {
  const invoices = resolveAsnSupplierInvoices(asn);
  const usable = invoices.filter((inv) => t(inv.invoiceNumber) && inv.invoiceDate);
  if (!usable.length) {
    return {
      ok: false,
      code: "ASN_SUPPLIER_INVOICE_REQUIRED",
      message: "Supplier invoice information is missing on this ASN.",
    };
  }
  return { ok: true, invoices: usable };
}

export function assertAsnLineHsCodePresent(asnLine = {}, article = "") {
  const hs = resolveAsnLineHsCode(asnLine);
  if (!hs) {
    const art = upper(article || asnLine?.article) || "UNKNOWN";
    return {
      ok: false,
      code: "ASN_LINE_HS_CODE_REQUIRED",
      message: `HS Code is missing on ASN line for Article ${art}. Update the ASN before posting GRN.`,
    };
  }
  return { ok: true, hsCode: hs };
}

export function assertAsnLineCooPresent(asnLine = {}, asn = {}, article = "") {
  const coo = resolveAsnLineCountryOfOrigin(asnLine, asn);
  if (!coo) {
    const art = upper(article || asnLine?.article) || "UNKNOWN";
    return {
      ok: false,
      code: "ASN_LINE_COO_REQUIRED",
      message: `Country of Origin is missing on ASN line for Article ${art}. Update the ASN before posting GRN.`,
    };
  }
  return { ok: true, countryOfOrigin: coo };
}

/**
 * ASN_RECEIVING BOE link contribution = SUM(GRN line acceptedQty).
 * Ignores customsQty on capture/overrides. Pure helper for tests + docs.
 */
export function asnReceivingBoeLinkQtyFromGrn(grn = {}) {
  return (grn.items || []).reduce((sum, ln) => {
    const q = Number(ln.acceptedQty ?? ln.receivedQty) || 0;
    return sum + (q > 0 ? q : 0);
  }, 0);
}

/**
 * Match GRN line → ASN line by asnLineId, then poLineId, then article.
 */
export function findAsnLineForGrnItem(asn = {}, grnItem = {}) {
  const lines = asn?.lines || [];
  const asnLineId = String(grnItem?.asnLineId || "").trim();
  if (asnLineId) {
    const byId = lines.find((l) => String(l._id || "") === asnLineId);
    if (byId) return byId;
  }
  const poLineId = String(grnItem?.poLineId || "").trim();
  if (poLineId) {
    const byPo = lines.find((l) => String(l.poLineId || "") === poLineId);
    if (byPo) return byPo;
  }
  const article = upper(grnItem?.article);
  if (article) {
    const matches = lines.filter((l) => upper(l.article) === article);
    if (matches.length === 1) return matches[0];
  }
  return null;
}
