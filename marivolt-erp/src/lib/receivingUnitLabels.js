/**
 * ASN Receiving Unit label planning helpers.
 * Reuses GRN distribution math — does not fork it.
 */
import {
  distributeByLabelCount,
  formatLabelDistribution,
  parseDistributionInput,
  sumDistribution,
  validateGrnLabelLinePrintConfig,
} from "./grnLabelDistribution.js";

export function suggestedDistribution(asnQty, labelCount) {
  const q = Number(asnQty) || 0;
  const n = Math.max(1, Math.floor(Number(labelCount) || 1));
  return q > 0 ? distributeByLabelCount(q, n) : [];
}

export function validateAsnLabelDistribution(asnQty, { labelCount, labelDistribution, article } = {}) {
  const result = validateGrnLabelLinePrintConfig({
    print: true,
    article,
    receivedQty: asnQty,
    labelCount,
    labelDistribution,
  });
  if (!result.ok) {
    return {
      ...result,
      message: String(result.message || "").replaceAll("GRN Qty", "ASN Qty"),
    };
  }
  return result;
}

export function distributionDifference(asnQty, distribution = []) {
  const total = sumDistribution(distribution);
  const qty = Number(asnQty) || 0;
  return {
    plannedQty: total,
    asnQty: qty,
    difference: Math.round((total - qty) * 1e6) / 1e6,
  };
}

export function defaultLinePlan(line) {
  const asnQty = Number(line?.asnQty) || 0;
  const existing = Array.isArray(line?.receivingUnits) ? line.receivingUnits : [];
  if (existing.length) {
    const dist = existing.map((ru) => Number(ru.plannedQty) || 0);
    return {
      asnLineId: line.asnLineId,
      labelCount: String(dist.length),
      labelDistribution: dist,
      customText: formatLabelDistribution(dist),
      mode: "existing",
    };
  }
  const dist = suggestedDistribution(asnQty, 1);
  return {
    asnLineId: line.asnLineId,
    labelCount: asnQty > 0 ? "1" : "0",
    labelDistribution: dist,
    customText: formatLabelDistribution(dist),
    mode: "count",
  };
}

export { formatLabelDistribution, parseDistributionInput, sumDistribution };
