/**
 * Eligible document search helpers for GRN PO + Packing allocation selectors.
 * Pure ranking / pending math — no stock writes.
 */
import {
  clampLimit,
  clampPage,
  escapeRegex,
  paginateArray,
  rankDocumentMatch,
  safeSearchTerm,
} from "./documentSearch.js";

export const GRN_ELIGIBLE_PO_EXCLUDED_STATUSES = ["CANCELLED", "CLOSED", "REJECTED"];
export const GRN_POSTED_RECEIPT_STATUSES = ["POSTED", "RECEIVED", "PARTIAL_RECEIVED", "CLOSED"];
export const PACKING_ELIGIBLE_ALLOC_EXCLUDED_STATUSES = ["CANCELLED", "CLOSED"];

const CANDIDATE_CAP = 250;

export { clampLimit, clampPage, escapeRegex, paginateArray, rankDocumentMatch, safeSearchTerm };

/**
 * Pending receivable for one PO line using posted GRN accepted qty (source of truth).
 */
export function computePoLinePendingReceivable(line, postedAcceptedQty = 0) {
  const ordered = Number(line?.orderedQty ?? line?.qty ?? line?.quantity ?? line?.orderedQuantity) || 0;
  const cancelled = Number(line?.cancelledQty ?? line?.cancelled) || 0;
  const posted = Math.max(0, Number(postedAcceptedQty) || 0);
  const pending = Math.max(0, ordered - posted - cancelled);
  return { ordered, cancelled, posted, pending };
}

/**
 * Summarize pending lines/qty for a PO lean doc + Map(lineId → postedAccepted).
 */
export function summarizePoPendingReceivable(po, postedByLine = new Map()) {
  const lines = Array.isArray(po?.lines) ? po.lines : [];
  let pendingLineCount = 0;
  let pendingQty = 0;
  for (const l of lines) {
    const lid = String(l?._id ?? l?.id ?? "");
    const { pending } = computePoLinePendingReceivable(l, postedByLine.get(lid) || 0);
    if (pending > 0) {
      pendingLineCount += 1;
      pendingQty += pending;
    }
  }
  return { pendingLineCount, pendingQty };
}

export function poArticleFields(line) {
  return [
    line?.article,
    line?.itemCode,
    line?.materialCode,
    line?.partNumber,
    line?.partNo,
    line?.spn,
    line?.sku,
    line?.productCode,
  ]
    .map((x) => String(x || "").trim())
    .filter(Boolean);
}

export function buildEligiblePoMongoFilter({
  companyFilter,
  q = "",
  supplierId = "",
  dateFrom = "",
  dateTo = "",
} = {}) {
  const and = [companyFilter, { status: { $nin: GRN_ELIGIBLE_PO_EXCLUDED_STATUSES } }];
  if (supplierId) and.push({ supplierId });
  if (dateFrom || dateTo) {
    const range = {};
    if (dateFrom) range.$gte = new Date(dateFrom);
    if (dateTo) {
      const end = new Date(dateTo);
      end.setHours(23, 59, 59, 999);
      range.$lte = end;
    }
    and.push({ orderDate: range });
  }
  const term = safeSearchTerm(q);
  if (term) {
    const re = new RegExp(escapeRegex(term), "i");
    and.push({
      $or: [
        { poNo: re },
        { poNumber: re },
        { supplierName: re },
        { supplierReference: re },
        { ref: re },
        { intRef: re },
        { "lines.article": re },
        { "lines.itemCode": re },
        { "lines.materialCode": re },
        { "lines.partNumber": re },
        { "lines.partNo": re },
        { "lines.spn": re },
      ],
    });
  }
  return and.length === 1 ? and[0] : { $and: and };
}

export function rankEligiblePo(q, po) {
  const term = safeSearchTerm(q);
  if (!term) return 100;
  const poNo = String(po?.poNo || po?.poNumber || "");
  const supplier = String(po?.supplierName || "");
  const articles = [];
  for (const l of po?.lines || []) articles.push(...poArticleFields(l));
  return rankDocumentMatch(term, [
    poNo,
    supplier,
    String(po?.supplierReference || ""),
    ...articles.slice(0, 20),
  ]);
}

export function sortEligiblePos(items, q) {
  const term = safeSearchTerm(q);
  return [...items].sort((a, b) => {
    const ra = rankEligiblePo(term, a);
    const rb = rankEligiblePo(term, b);
    if (ra !== rb) return ra - rb;
    const da = new Date(a.poDate || a.orderDate || 0).getTime();
    const db = new Date(b.poDate || b.orderDate || 0).getTime();
    return db - da;
  });
}

export function toEligiblePoItem(po, pending) {
  const poNo = String(po.poNo || po.poNumber || "").trim();
  const poDate = po.orderDate || po.poDate || null;
  return {
    id: String(po._id),
    _id: po._id,
    poNo,
    supplierId: po.supplierId || null,
    supplierName: po.supplierName || "",
    supplierReference: po.supplierReference || "",
    poDate,
    status: po.status || "",
    pendingLineCount: pending.pendingLineCount,
    pendingQty: pending.pendingQty,
    primaryLabel: poNo,
    secondaryLabel: [
      po.supplierName || "",
      poDate
        ? new Date(poDate).toLocaleDateString("en-GB", {
            day: "2-digit",
            month: "short",
            year: "numeric",
          })
        : "",
      pending.pendingLineCount ? `${pending.pendingLineCount} pending lines` : "",
      pending.pendingQty ? `Qty ${Number(pending.pendingQty).toFixed(0)}` : "",
    ]
      .filter(Boolean)
      .join(" · "),
  };
}

export function buildEligibleAllocationMongoFilter({
  companyFilter,
  q = "",
  customerId = "",
  status = "",
  dateFrom = "",
  dateTo = "",
} = {}) {
  const and = [
    companyFilter,
    {
      status: status
        ? String(status).toUpperCase()
        : { $nin: PACKING_ELIGIBLE_ALLOC_EXCLUDED_STATUSES },
    },
  ];
  // OrderAllocation has no customerId field today — ignore unknown customerId to avoid empty results.
  void customerId;
  if (dateFrom || dateTo) {
    const range = {};
    if (dateFrom) range.$gte = new Date(dateFrom);
    if (dateTo) {
      const end = new Date(dateTo);
      end.setHours(23, 59, 59, 999);
      range.$lte = end;
    }
    and.push({ allocationDate: range });
  }
  const term = safeSearchTerm(q);
  if (term) {
    const re = new RegExp(escapeRegex(term), "i");
    and.push({
      $or: [
        { allocationNo: re },
        { customerName: re },
        { linkedOANo: re },
        { linkedProformaNo: re },
        { linkedSalesInvoiceNo: re },
        { linkedQuotationNo: re },
        { "lines.article": re },
        { "lines.partNumber": re },
        { "lines.materialCode": re },
      ],
    });
  }
  return and.length === 1 ? and[0] : { $and: and };
}

export function summarizeAllocationPendingPack(allocation, packedByLine = new Map()) {
  let allocatedQty = 0;
  let packedQty = 0;
  let pendingLineCount = 0;
  for (const ln of allocation?.lines || []) {
    const aq = Number(ln.qty) || 0;
    const pk = packedByLine.get(String(ln._id)) || 0;
    allocatedQty += aq;
    packedQty += pk;
    if (Math.max(0, aq - pk) > 0) pendingLineCount += 1;
  }
  const pendingPackQty = Math.max(0, allocatedQty - packedQty);
  return { allocatedQty, packedQty, pendingPackQty, pendingLineCount };
}

export function rankEligibleAllocation(q, row) {
  const term = safeSearchTerm(q);
  if (!term) return 100;
  return rankDocumentMatch(term, [
    row.allocationNo,
    row.linkedOANo,
    row.linkedProformaNo,
    row.linkedSalesInvoiceNo,
    row.customerName,
  ]);
}

export function sortEligibleAllocations(items, q) {
  const term = safeSearchTerm(q);
  return [...items].sort((a, b) => {
    const ra = rankEligibleAllocation(term, a);
    const rb = rankEligibleAllocation(term, b);
    if (ra !== rb) return ra - rb;
    return String(b.allocationNo || "").localeCompare(String(a.allocationNo || ""));
  });
}

export function toEligibleAllocationItem(allocation, pending) {
  const allocationNo = String(allocation.allocationNo || "").trim();
  return {
    id: String(allocation._id),
    _id: allocation._id,
    allocationNo,
    linkedOANo: allocation.linkedOANo || "",
    linkedProformaNo: allocation.linkedProformaNo || "",
    linkedSalesInvoiceNo: allocation.linkedSalesInvoiceNo || "",
    customerName: allocation.customerName || "",
    status: allocation.status || "",
    warehouse: allocation.warehouse || "MAIN",
    allocatedQty: pending.allocatedQty,
    alreadyPackedQty: pending.packedQty,
    pendingPackQty: pending.pendingPackQty,
    pendingLineCount: pending.pendingLineCount,
    primaryLabel: allocationNo,
    secondaryLabel: [
      allocation.customerName || "",
      allocation.linkedOANo ? `OA ${allocation.linkedOANo}` : "",
      allocation.linkedProformaNo ? `PI ${allocation.linkedProformaNo}` : "",
      allocation.linkedSalesInvoiceNo ? `SI ${allocation.linkedSalesInvoiceNo}` : "",
      pending.pendingLineCount ? `${pending.pendingLineCount} pending lines` : "",
      pending.pendingPackQty ? `Qty ${Number(pending.pendingPackQty).toFixed(0)}` : "",
    ]
      .filter(Boolean)
      .join(" · "),
  };
}

export function parseListPaging(query = {}) {
  return {
    q: safeSearchTerm(query.q || query.search),
    page: clampPage(query.page),
    limit: clampLimit(query.limit, { fallback: 25, max: 50 }),
  };
}

export { CANDIDATE_CAP };
