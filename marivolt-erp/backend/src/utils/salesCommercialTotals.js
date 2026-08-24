/**
 * Canonical sales commercial totals (Quotation / OA / PI / SI line headers).
 *
 * grandTotal =
 *   line subTotal
 *   − discountTotal
 *   + taxTotal
 *   + packingCost
 *   + clearanceCost
 *
 * Always pass a plain object (or use plainCommercialSource) — never spread a
 * Mongoose document into computeSalesCommercialTotals; enumerable own keys on
 * Documents omit schema path values and zero out packing/clearance.
 */

/**
 * Extract commercial header fields from a Mongoose doc or plain object.
 * @param {object|null|undefined} doc
 * @param {object} [overrides] - only defined keys replace the base
 */
export function plainCommercialSource(doc, overrides = {}) {
  if (!doc || typeof doc !== "object") {
    const out = {};
    for (const [k, v] of Object.entries(overrides || {})) {
      if (v !== undefined) out[k] = v;
    }
    return out;
  }

  let plain;
  if (typeof doc.toObject === "function") {
    plain = doc.toObject({ depopulate: true, virtuals: false });
  } else if (doc._doc && typeof doc._doc === "object") {
    plain = { ...doc._doc };
  } else {
    plain = { ...doc };
  }

  const out = {
    discountType: plain.discountType,
    discountValue: plain.discountValue,
    discountTotal: plain.discountTotal,
    taxTotal: plain.taxTotal,
    packingCost: plain.packingCost,
    clearanceCost: plain.clearanceCost,
  };
  for (const [k, v] of Object.entries(overrides || {})) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/**
 * @param {Array<{ totalPrice?: number }>} lines
 * @param {object} source - plain commercial header (use plainCommercialSource for Mongoose docs)
 */
export function computeSalesCommercialTotals(lines = [], source = {}) {
  let subTotal = 0;
  for (const line of lines) {
    subTotal += Number(line.totalPrice) || 0;
  }
  const discountType = String(source?.discountType || "NONE").toUpperCase();
  const discountValue = Math.max(0, Number(source?.discountValue) || 0);
  let discountTotal = Math.max(0, Number(source?.discountTotal) || 0);
  if (discountType === "PERCENT") {
    discountTotal = Math.min(subTotal, (subTotal * discountValue) / 100);
  } else if (discountType === "FLAT") {
    discountTotal = Math.min(subTotal, discountValue);
  } else if (discountTotal > 0) {
    discountTotal = Math.min(subTotal, discountTotal);
  } else {
    discountTotal = 0;
  }
  const taxTotal = Math.max(0, Number(source?.taxTotal) || 0);
  const packingCost = Math.max(0, Number(source?.packingCost) || 0);
  const clearanceCost = Math.max(0, Number(source?.clearanceCost) || 0);
  return {
    subTotal,
    discountType: ["PERCENT", "FLAT"].includes(discountType) ? discountType : "NONE",
    discountValue: ["PERCENT", "FLAT"].includes(discountType) ? discountValue : 0,
    discountTotal,
    taxTotal,
    packingCost,
    clearanceCost,
    grandTotal: subTotal - discountTotal + taxTotal + packingCost + clearanceCost,
  };
}
