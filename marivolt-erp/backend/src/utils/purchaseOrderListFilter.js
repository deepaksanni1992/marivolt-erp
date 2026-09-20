import { escapeRegex, safeSearchTerm } from "./documentSearch.js";

export const PO_LIST_PO_NUMBER_MAX = 80;
export const PO_LIST_ARTICLE_MAX = 80;
export const PO_LIST_SUPPLIER_MAX = 80;

export const PO_LIST_STATUSES = Object.freeze([
  "DRAFT",
  "SAVED",
  "SENT",
  "REJECTED",
  "PARTIAL_RECEIVED",
  "RECEIVED",
  "CLOSED",
  "CANCELLED",
]);

const PO_STATUS_SET = new Set(PO_LIST_STATUSES);

export function invalidFilter(message) {
  const err = new Error(message);
  err.statusCode = 400;
  err.code = "INVALID_FILTER";
  throw err;
}

/**
 * poNumber and article must be a single string (or omitted/empty).
 * Arrays and objects are rejected so they cannot silently list the full register.
 */
export function assertScalarFilter(value, field) {
  if (value == null || value === "") return;
  if (typeof value === "string") return;
  invalidFilter(`${field} must be a single text value`);
}

export function firstQueryString(value) {
  if (value == null) return "";
  if (Array.isArray(value)) return firstQueryString(value[0]);
  if (typeof value === "object") return "";
  return String(value);
}

export function normalizePoNumberQuery(raw) {
  return safeSearchTerm(typeof raw === "string" || raw == null ? raw : String(raw), {
    maxLen: PO_LIST_PO_NUMBER_MAX,
  });
}

export function normalizeArticleQuery(raw) {
  return String(raw == null ? "" : raw)
    .trim()
    .slice(0, PO_LIST_ARTICLE_MAX);
}

/**
 * Exact match on nested `lines.article`. Anchored, escaped, case-insensitive.
 * Does not uppercase the query; historical rows may not be stored uppercase.
 */
export function articleLineClause(article) {
  const term = normalizeArticleQuery(article);
  if (!term) return null;
  return { "lines.article": new RegExp(`^${escapeRegex(term)}$`, "i") };
}

export function poNumberClause(poNumber) {
  const term = normalizePoNumberQuery(poNumber);
  if (!term) return null;
  const re = new RegExp(escapeRegex(term), "i");
  return { $or: [{ poNo: re }, { poNumber: re }] };
}

/**
 * Company-scoped Purchase Order register filter.
 * Never copies client objects into the Mongo query.
 */
export function buildPurchaseOrderListFilter(companyId, query = {}) {
  if (companyId == null || companyId === "") {
    const err = new Error("Company context is required");
    err.statusCode = 400;
    err.code = "COMPANY_REQUIRED";
    throw err;
  }

  assertScalarFilter(query.poNumber, "poNumber");
  assertScalarFilter(query.article, "article");

  const filter = { companyId };
  const and = [];

  const status = firstQueryString(query.status).trim().toUpperCase();
  if (status && PO_STATUS_SET.has(status)) {
    filter.status = status;
  }

  const approvalStatus = firstQueryString(query.approvalStatus).trim().toUpperCase();
  if (approvalStatus) {
    filter.approvalStatus = approvalStatus;
  }

  const supplierName = safeSearchTerm(firstQueryString(query.supplierName), { maxLen: PO_LIST_SUPPLIER_MAX });
  if (supplierName) {
    filter.supplierName = new RegExp(escapeRegex(supplierName), "i");
  }

  const q = safeSearchTerm(firstQueryString(query.q || query.search), { maxLen: 80 });
  if (q) {
    const re = new RegExp(escapeRegex(q), "i");
    and.push({
      $or: [
        { poNo: re },
        { poNumber: re },
        { supplierName: re },
        { "lines.article": re },
        { "lines.itemCode": re },
        { "lines.partNumber": re },
      ],
    });
  }

  const poClause = poNumberClause(query.poNumber);
  if (poClause) and.push(poClause);

  const artClause = articleLineClause(query.article);
  if (artClause) and.push(artClause);

  if (and.length === 1) {
    Object.assign(filter, and[0]);
  } else if (and.length > 1) {
    filter.$and = and;
  }

  return filter;
}
