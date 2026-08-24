/**
 * ASN receiving-completeness — canonical gate for RU plan/print and new receiving sessions.
 * Uses customs field-ownership resolvers. Does NOT replace GRN post-readiness (defense-in-depth).
 *
 * Required for receiving eligibility:
 * - per line: article, qty, UOM, HS Code, Country of Origin (header COO fallback allowed)
 * - document: supplier invoice number + date
 *
 * Not required here: BOE, weights, putaway, dispositions, valuation.
 */
import {
  resolveAsnLineCountryOfOrigin,
  resolveAsnLineHsCode,
  resolveAsnSupplierInvoices,
} from "./asnCustomsFieldOwnership.js";
import { ASN_QTY_EPS } from "./asnRules.js";

function t(v) {
  return String(v ?? "").trim();
}

function upper(v) {
  return t(v).toUpperCase();
}

function missingItem({ lineId = "", article = "", field, label, code }) {
  return {
    lineId: lineId ? String(lineId) : "",
    article: article ? upper(article) : "",
    field,
    label,
    code,
  };
}

/**
 * Pure completeness evaluation for ASN receiving eligibility.
 * Returns every missing requirement (not first-only).
 *
 * @param {object} asn
 * @returns {{ complete: boolean, missing: Array<object>, summary: string }}
 */
export function validateAsnReceivingCompleteness(asn = {}) {
  const missing = [];
  const lines = Array.isArray(asn?.lines) ? asn.lines : [];

  if (!lines.length) {
    missing.push(
      missingItem({
        field: "lines",
        label: "ASN lines",
        code: "ASN_LINES_REQUIRED",
      })
    );
  }

  for (const line of lines) {
    const lineId = String(line?._id || line?.id || "");
    const article = upper(line?.article);
    const qty = Number(line?.asnQty ?? line?.qty);
    const uom = t(line?.uom);

    if (!article) {
      missing.push(
        missingItem({
          lineId,
          article: "",
          field: "article",
          label: "Article",
          code: "ASN_LINE_ARTICLE_REQUIRED",
        })
      );
    }
    if (!Number.isFinite(qty) || qty <= ASN_QTY_EPS) {
      missing.push(
        missingItem({
          lineId,
          article,
          field: "asnQty",
          label: "Quantity",
          code: "ASN_LINE_QTY_REQUIRED",
        })
      );
    }
    if (!uom) {
      missing.push(
        missingItem({
          lineId,
          article,
          field: "uom",
          label: "UOM",
          code: "ASN_LINE_UOM_REQUIRED",
        })
      );
    }
    if (!resolveAsnLineHsCode(line)) {
      missing.push(
        missingItem({
          lineId,
          article,
          field: "hsCode",
          label: "HS Code",
          code: "ASN_HS_CODE_REQUIRED",
        })
      );
    }
    if (!resolveAsnLineCountryOfOrigin(line, asn)) {
      missing.push(
        missingItem({
          lineId,
          article,
          field: "countryOfOrigin",
          label: "Country of Origin",
          code: "ASN_COO_REQUIRED",
        })
      );
    }
  }

  const invoices = resolveAsnSupplierInvoices(asn);
  const usable = invoices.filter((inv) => t(inv.invoiceNumber) && inv.invoiceDate);
  if (!usable.length) {
    const anyNumber = invoices.some((inv) => t(inv.invoiceNumber));
    const anyDate = invoices.some((inv) => inv.invoiceDate);
    if (!anyNumber && !anyDate) {
      missing.push(
        missingItem({
          field: "supplierInvoice",
          label: "Supplier Invoice",
          code: "ASN_SUPPLIER_INVOICE_REQUIRED",
        })
      );
    } else {
      if (!anyNumber) {
        missing.push(
          missingItem({
            field: "supplierInvoiceNumber",
            label: "Supplier Invoice Number",
            code: "ASN_SUPPLIER_INVOICE_REQUIRED",
          })
        );
      }
      if (!anyDate) {
        missing.push(
          missingItem({
            field: "supplierInvoiceDate",
            label: "Supplier Invoice Date",
            code: "ASN_SUPPLIER_INVOICE_DATE_REQUIRED",
          })
        );
      }
    }
  }

  const lineFieldMissing = missing.filter((m) => m.lineId || m.article);
  const lineArticles = new Set(lineFieldMissing.map((m) => m.article).filter(Boolean));
  const summary = missing.length
    ? `ASN cannot proceed to receiving. ${missing.length} required field${
        missing.length === 1 ? " is" : "s are"
      } missing${lineArticles.size ? ` across ${lineArticles.size} line${lineArticles.size === 1 ? "" : "s"}` : ""}.`
    : "ASN is complete for receiving.";

  return {
    complete: missing.length === 0,
    missing,
    summary,
  };
}

/**
 * Throw a typed error with code ASN_INCOMPLETE and structured missing[].
 * Prefer ErrorClass that accepts (message, status, code, details?).
 * @param {object} asn
 * @param {{ ErrorClass?: typeof Error, status?: number }} [opts]
 * @returns {{ complete: true, missing: [], summary: string }}
 */
export function assertAsnReceivingComplete(asn, opts = {}) {
  const result = validateAsnReceivingCompleteness(asn);
  if (result.complete) return result;

  const ErrorClass = opts.ErrorClass || Error;
  const status = opts.status ?? 409;
  const details = { missing: result.missing, complete: false };
  let err;
  try {
    err = new ErrorClass(result.summary, status, "ASN_INCOMPLETE", details);
  } catch {
    err = new ErrorClass(result.summary, status, "ASN_INCOMPLETE");
    err.details = details;
  }
  if (!err.details) err.details = details;
  err.missing = result.missing;
  throw err;
}

/**
 * Group missing items by article for UI tables.
 */
export function groupAsnCompletenessMissingByArticle(missing = []) {
  const byArticle = new Map();
  const document = [];
  for (const item of missing || []) {
    if (!item.article) {
      document.push(item);
      continue;
    }
    if (!byArticle.has(item.article)) byArticle.set(item.article, []);
    byArticle.get(item.article).push(item);
  }
  return {
    document,
    lines: [...byArticle.entries()].map(([article, items]) => ({
      article,
      missing: items,
      labels: items.map((i) => i.label),
    })),
  };
}
