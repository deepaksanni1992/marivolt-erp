import OrderAcknowledgement from "../../models/OrderAcknowledgement.js";

/** Line match key when sourceQuotationLineId is absent (legacy OAs). */
export function lineArticlePartKey(article, partNumber) {
  const art = String(article ?? "")
    .trim()
    .toUpperCase();
  const part = String(partNumber ?? "")
    .trim()
    .toUpperCase();
  return `${art}||${part}`;
}

/**
 * Non-destructive quotation consumption: sums ordered qty from linked, non-cancelled OAs.
 * Quotation lines are never modified.
 */
export async function computeQuotationConsumption(companyId, quotation) {
  const qLines = quotation?.lines || [];
  const byLineId = new Map();
  const byArticlePart = new Map();

  for (const qLine of qLines) {
    const quotedQty = Number(qLine.qty) || 0;
    const lineId = qLine._id ? String(qLine._id) : "";
    const entry = {
      quotationLineId: lineId,
      article: qLine.article || "",
      partNumber: qLine.partNumber || "",
      quotedQty,
      alreadyOrderedQty: 0,
      remainingQty: quotedQty,
    };
    if (lineId) byLineId.set(lineId, entry);
    byArticlePart.set(lineArticlePartKey(qLine.article, qLine.partNumber), entry);
  }

  const oas = await OrderAcknowledgement.find({
    companyId,
    linkedQuotationId: quotation._id,
    status: { $ne: "CANCELLED" },
  })
    .select("lines oaNo status")
    .lean();

  for (const oa of oas) {
    for (const line of oa.lines || []) {
      const qty = Number(line.orderedQty ?? line.qty) || 0;
      if (qty <= 0) continue;
      const srcId = line.sourceQuotationLineId ? String(line.sourceQuotationLineId) : "";
      let entry = srcId && byLineId.has(srcId) ? byLineId.get(srcId) : null;
      if (!entry) {
        entry = byArticlePart.get(lineArticlePartKey(line.article, line.partNumber));
      }
      if (entry) entry.alreadyOrderedQty += qty;
    }
  }

  for (const entry of byLineId.values()) {
    entry.remainingQty = Math.max(0, entry.quotedQty - entry.alreadyOrderedQty);
  }

  const consumptionByLineId = new Map();
  for (const [id, entry] of byLineId) {
    consumptionByLineId.set(id, entry);
  }

  return {
    quotationId: String(quotation._id),
    quotationNo: quotation.quotationNo || "",
    linkedOaCount: oas.length,
    lines: Array.from(byLineId.values()),
    byLineId: consumptionByLineId,
    byArticlePart,
  };
}

/** Apply consumption to working-copy lines — default orderedQty to remainingQty. */
export function applyConsumptionToWorkingLines(lines, consumption) {
  const byLineId = consumption?.byLineId || new Map();
  const byArticlePart = consumption?.byArticlePart || new Map();

  return (lines || []).map((line, idx) => {
    const srcId = line.sourceQuotationLineId ? String(line.sourceQuotationLineId) : "";
    let c = srcId && byLineId.has(srcId) ? byLineId.get(srcId) : null;
    if (!c) {
      c = byArticlePart.get(lineArticlePartKey(line.article, line.partNumber));
    }
    const quotedQty = line.quotedQty != null ? Number(line.quotedQty) : c?.quotedQty ?? 0;
    const alreadyOrderedQty = c?.alreadyOrderedQty ?? 0;
    const remainingQty = c?.remainingQty ?? Math.max(0, quotedQty - alreadyOrderedQty);
    const orderedQty =
      line.orderedQty != null && line._consumptionApplied
        ? Number(line.orderedQty)
        : remainingQty;

    return {
      ...line,
      serialNo: idx + 1,
      quotedQty,
      alreadyOrderedQty,
      remainingQty,
      orderedQty,
      _consumptionApplied: true,
    };
  });
}

/**
 * Validate working-copy lines against remaining quotation qty.
 * Returns violations unless allowOverOrder is true.
 */
export function findOverOrderViolations(lines, consumption, { allowOverOrder = false } = {}) {
  if (allowOverOrder) return [];
  const byLineId = consumption?.byLineId || new Map();
  const byArticlePart = consumption?.byArticlePart || new Map();
  const violations = [];

  for (const line of lines || []) {
    if (line.includeInOA === false) continue;
    const orderedQty = Number(line.orderedQty ?? line.qty) || 0;
    if (orderedQty <= 0) continue;

    const srcId = line.sourceQuotationLineId ? String(line.sourceQuotationLineId) : "";
    let c = srcId && byLineId.has(srcId) ? byLineId.get(srcId) : null;
    if (!c) {
      c = byArticlePart.get(lineArticlePartKey(line.article, line.partNumber));
    }
    if (!c) continue;

    const remaining = c.remainingQty ?? 0;
    if (orderedQty > remaining + 1e-9) {
      violations.push({
        article: line.article,
        partNumber: line.partNumber || "",
        quotedQty: c.quotedQty,
        alreadyOrderedQty: c.alreadyOrderedQty,
        remainingQty: remaining,
        orderedQty,
        excessQty: orderedQty - remaining,
        message: `Ordered quantity (${orderedQty}) exceeds remaining quotation quantity (${remaining}) for ${line.article}`,
      });
    }
  }
  return violations;
}
