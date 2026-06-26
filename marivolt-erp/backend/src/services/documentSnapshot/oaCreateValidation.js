import { lineArticlePartKey } from "./quotationConsumptionService.js";

const MAX_OA_LINES = 500;

/**
 * Server-side line validation — never trust frontend payloads.
 */
export function validateOaLineFields(lines = [], { fromWorkingCopy = false } = {}) {
  const errors = [];
  const dupKeys = new Set();
  let includedCount = 0;

  if (!Array.isArray(lines)) {
    return ["Lines must be an array"];
  }
  if (lines.length > MAX_OA_LINES) {
    return [`Maximum ${MAX_OA_LINES} lines allowed per OA`];
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const row = i + 1;
    if (fromWorkingCopy && line?.includeInOA === false) continue;

    const orderedQtyRaw = line?.orderedQty ?? line?.qty;
    const orderedPriceRaw = line?.orderedPrice ?? line?.price ?? line?.salePrice;
    const orderedQty = Number(orderedQtyRaw);
    const orderedPrice = Number(orderedPriceRaw);

    if (orderedQtyRaw !== undefined && orderedQtyRaw !== "" && !Number.isFinite(orderedQty)) {
      errors.push(`Row ${row}: ordered quantity must be numeric`);
      continue;
    }
    if (!Number.isFinite(orderedQty) || orderedQty < 0) {
      errors.push(`Row ${row}: ordered quantity must be a non-negative number`);
      continue;
    }
    if (orderedQty <= 0) continue;

    if (orderedPriceRaw !== undefined && orderedPriceRaw !== "" && !Number.isFinite(orderedPrice)) {
      errors.push(`Row ${row}: ordered price must be numeric`);
      continue;
    }
    if (!Number.isFinite(orderedPrice) || orderedPrice < 0) {
      errors.push(`Row ${row}: ordered price must be a non-negative number`);
      continue;
    }

    const article = String(line?.article || line?.itemCode || "").trim();
    const description = String(line?.description || "").trim();
    const uom = String(line?.uom || line?.unit || "PCS").trim();

    if (!article) errors.push(`Row ${row}: article is required`);
    if (!description) errors.push(`Row ${row}: description is required`);
    if (!uom) errors.push(`Row ${row}: UOM is required`);

    const key = lineArticlePartKey(article, line?.partNumber);
    if (article && dupKeys.has(key)) {
      errors.push(`Row ${row}: duplicate article/part (${article})`);
    } else if (article) {
      dupKeys.add(key);
    }

    includedCount += 1;
  }

  if (includedCount === 0) {
    errors.push("At least one included line with ordered quantity > 0 is required");
  }

  return errors;
}

/** Snapshot of consumption at working-copy load time (concurrency baseline). */
export function buildConsumptionBaseline(consumption) {
  const lineRemaining = {};
  for (const row of consumption?.lines || []) {
    const id = row.quotationLineId ? String(row.quotationLineId) : "";
    if (!id) continue;
    lineRemaining[id] = {
      remainingQty: Number(row.remainingQty) || 0,
      alreadyOrderedQty: Number(row.alreadyOrderedQty) || 0,
    };
  }
  return {
    linkedOaCount: Number(consumption?.linkedOaCount) || 0,
    capturedAt: new Date().toISOString(),
    lineRemaining,
  };
}

/**
 * Detect if quotation consumption changed while user held the working form open.
 */
export function detectStaleConsumption(body = {}, freshConsumption) {
  const baseline = body.consumptionBaseline;
  if (!baseline || !freshConsumption) return { stale: false, reasons: [] };

  const reasons = [];
  const freshCount = Number(freshConsumption.linkedOaCount) || 0;
  const baseCount = Number(baseline.linkedOaCount) || 0;
  if (freshCount > baseCount) {
    reasons.push(
      `${freshCount - baseCount} additional OA(s) were created on this quotation since you opened the form`
    );
  }

  const baseRemaining = baseline.lineRemaining || {};
  for (const line of body.lines || []) {
    if (line.includeInOA === false) continue;
    const lid = String(line.sourceQuotationLineId || line.sourceLineId || "");
    if (!lid || !baseRemaining[lid]) continue;
    const was = Number(baseRemaining[lid].remainingQty);
    const now = freshConsumption.byLineId?.get(lid)?.remainingQty;
    if (now != null && Number.isFinite(was) && Math.abs(Number(now) - was) > 1e-9) {
      reasons.push(`Remaining qty for ${line.article || lid} changed (${was} → ${now})`);
    }
  }

  return { stale: reasons.length > 0, reasons };
}

export { MAX_OA_LINES };
