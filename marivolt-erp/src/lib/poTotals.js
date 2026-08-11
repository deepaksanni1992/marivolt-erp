/** Non-negative PO header cost; used for packing / handling / miscellaneous. */
export function poHeaderCost(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

export const PO_ADJUSTMENT_TYPE_META = {
  PACKING: { type: "PACKING", label: "Packing Cost" },
  HANDLING: { type: "HANDLING", label: "Handling Cost" },
  FREIGHT: { type: "FREIGHT", label: "Freight" },
  INSURANCE: { type: "INSURANCE", label: "Insurance" },
  DOCUMENTATION: { type: "DOCUMENTATION", label: "Documentation" },
  BANK: { type: "BANK", label: "Bank Charges" },
  CUSTOM: { type: "CUSTOM", label: "Other / Custom Cost" },
  DISCOUNT: { type: "DISCOUNT", label: "Discount" },
};

export const PO_ADJUSTMENT_TYPES = Object.keys(PO_ADJUSTMENT_TYPE_META);
export const PO_SYSTEM_ADJUSTMENT_TYPES = PO_ADJUSTMENT_TYPES.filter((t) => t !== "CUSTOM");

export function defaultPoAdjustmentLabel(type) {
  const key = String(type || "").toUpperCase();
  return PO_ADJUSTMENT_TYPE_META[key]?.label || key;
}

export function formatPoDiscountPercent(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value ?? "");
  if (Number.isInteger(n)) return String(n);
  return String(n);
}

export function poDiscountMode(row) {
  const mode = String(row?.discountMode || "").toUpperCase();
  if (mode === "PERCENT" || mode === "FLAT") return mode;
  return "FLAT";
}

export function poAdjustmentDisplayLabel(row) {
  const type = String(row?.type || "").toUpperCase();
  if (type === "CUSTOM") {
    const custom = String(row?.label || "").trim();
    return custom || defaultPoAdjustmentLabel("CUSTOM");
  }
  if (type === "DISCOUNT" && poDiscountMode(row) === "PERCENT") {
    return `Discount (${formatPoDiscountPercent(row.discountValue)}%)`;
  }
  return defaultPoAdjustmentLabel(type);
}

export function isPoAdjustmentType(type) {
  return PO_ADJUSTMENT_TYPES.includes(String(type || "").toUpperCase());
}

/**
 * Parse an adjustment amount without silently coercing invalid text to 0.
 * Empty / blank is treated as 0 so unused rows can be dropped on save.
 */
export function parsePoAdjustmentAmount(value) {
  if (value === "" || value == null) {
    return { ok: true, amount: 0, empty: true };
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      return { ok: false, message: "Adjustment amount must be numeric" };
    }
    if (value < 0) {
      return { ok: false, message: "Adjustment amount cannot be negative" };
    }
    return { ok: true, amount: value, empty: false };
  }
  const raw = String(value).trim();
  if (raw === "") {
    return { ok: true, amount: 0, empty: true };
  }
  if (!/^(?:\d+\.?\d*|\.\d+)$/.test(raw)) {
    return { ok: false, message: "Adjustment amount must be numeric" };
  }
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    return { ok: false, message: "Adjustment amount must be numeric" };
  }
  if (n < 0) {
    return { ok: false, message: "Adjustment amount cannot be negative" };
  }
  return { ok: true, amount: n, empty: false };
}

/**
 * Legacy rule (unchanged):
 * PERCENT = min(subTotal, subTotal * value / 100)
 * FLAT    = min(subTotal, value)
 * Percentage is applied to line-items subtotal only — not subtotal + extra costs.
 * Values > 100 are allowed and still cap at the subtotal (same as before).
 */
export function calcPoDiscountTotal(subTotal, discountType, discountValue) {
  const sub = Number(subTotal) || 0;
  const type = String(discountType || "NONE").toUpperCase();
  const value = Math.max(0, Number(discountValue) || 0);
  if (type === "PERCENT") return Math.min(sub, (sub * value) / 100);
  if (type === "FLAT") return Math.min(sub, value);
  return 0;
}

export function calcPoGrandTotal(
  subTotal,
  packingCost = 0,
  handlingCost = 0,
  miscellaneousCost = 0,
  discountTotal = 0
) {
  const sub = Number(subTotal) || 0;
  const discount = Math.max(0, Number(discountTotal) || 0);
  return (
    sub -
    discount +
    poHeaderCost(packingCost) +
    poHeaderCost(handlingCost) +
    poHeaderCost(miscellaneousCost)
  );
}

export function hasPersistedPoAdjustments(doc) {
  return Array.isArray(doc?.adjustments) && doc.adjustments.length > 0;
}

function lineItemsSubTotal(doc) {
  const lines = Array.isArray(doc?.lines) ? doc.lines : [];
  return lines.reduce((s, l) => s + (Number(l.qty) || 0) * (Number(l.unitPrice) || 0), 0);
}

function resolveStoredSubTotal(doc) {
  if (doc?.subTotal != null && doc.subTotal !== "") {
    return Number(doc.subTotal) || 0;
  }
  return lineItemsSubTotal(doc);
}

function resolvePoDiscountTotal(doc, subTotal) {
  const type = String(doc?.discountType || "NONE").toUpperCase();
  if (type === "PERCENT" || type === "FLAT") {
    return calcPoDiscountTotal(subTotal, type, doc?.discountValue);
  }
  if (doc?.discountTotal != null) {
    return Math.min(subTotal, Math.max(0, Number(doc.discountTotal) || 0));
  }
  if (doc?.discount != null) {
    return Math.min(subTotal, Math.max(0, Number(doc.discount) || 0));
  }
  return 0;
}

export function discountMonetaryAmount(row, subTotal) {
  if (String(row?.type || "").toUpperCase() !== "DISCOUNT") {
    return poHeaderCost(row?.amount);
  }
  const mode = poDiscountMode(row);
  const raw = mode === "PERCENT" ? row?.discountValue : row?.discountValue ?? row?.amount;
  return calcPoDiscountTotal(subTotal, mode, raw);
}

export function withDerivedDiscountAmounts(adjustments, subTotal) {
  return (adjustments || []).map((row) => {
    if (String(row?.type || "").toUpperCase() !== "DISCOUNT") return row;
    return { ...row, amount: discountMonetaryAmount(row, subTotal) };
  });
}

export function legacyCostsToAdjustments(doc) {
  const rows = [];
  const packing = poHeaderCost(doc?.packingCost);
  if (packing > 0) {
    rows.push({ type: "PACKING", label: "Packing Cost", amount: packing });
  }
  const handling = poHeaderCost(doc?.handlingCost);
  if (handling > 0) {
    rows.push({ type: "HANDLING", label: "Handling Cost", amount: handling });
  }
  const misc = poHeaderCost(doc?.miscellaneousCost);
  if (misc > 0) {
    rows.push({ type: "CUSTOM", label: "Miscellaneous Cost", amount: misc });
  }
  const subTotal = resolveStoredSubTotal(doc);
  const type = String(doc?.discountType || "NONE").toUpperCase();
  if (type === "PERCENT") {
    const discountValue = Math.max(0, Number(doc?.discountValue) || 0);
    const amount = calcPoDiscountTotal(subTotal, "PERCENT", discountValue);
    if (discountValue > 0) {
      rows.push({
        type: "DISCOUNT",
        label: "Discount",
        amount,
        discountMode: "PERCENT",
        discountValue,
      });
    }
  } else {
    const discountTotal = resolvePoDiscountTotal(doc, subTotal);
    if (discountTotal > 0) {
      const discountValue =
        type === "FLAT" ? Math.max(0, Number(doc?.discountValue) || discountTotal) : discountTotal;
      rows.push({
        type: "DISCOUNT",
        label: "Discount",
        amount: discountTotal,
        discountMode: "FLAT",
        discountValue,
      });
    }
  }
  return rows;
}

export function sanitizePoAdjustment(row) {
  const type = String(row?.type || "").toUpperCase();
  const label =
    type === "CUSTOM" ? String(row?.label || "").trim() : defaultPoAdjustmentLabel(type);
  if (type === "DISCOUNT") {
    const mode = poDiscountMode(row);
    const source = mode === "PERCENT" ? row?.discountValue : row?.discountValue ?? row?.amount;
    const parsed = parsePoAdjustmentAmount(source);
    const value = parsed.ok ? parsed.amount : 0;
    return {
      type,
      label,
      discountMode: mode,
      discountValue: value,
      amount: mode === "FLAT" ? value : 0,
    };
  }
  const parsed = parsePoAdjustmentAmount(row?.amount);
  return { type, label, amount: parsed.ok ? parsed.amount : 0 };
}

export function sanitizePoAdjustments(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.filter((row) => isPoAdjustmentType(row?.type)).map(sanitizePoAdjustment);
}

/**
 * Adjustments are authoritative when a non-empty array exists.
 * Never merge persisted adjustments with legacy shadow scalars.
 */
export function resolvePoAdjustments(doc) {
  if (hasPersistedPoAdjustments(doc)) {
    return sanitizePoAdjustments(doc.adjustments);
  }
  return legacyCostsToAdjustments(doc);
}

function isPersistableAdjustment(row) {
  if (String(row?.type || "").toUpperCase() === "DISCOUNT") {
    if (poDiscountMode(row) === "PERCENT") return poHeaderCost(row.discountValue) > 0;
    return poHeaderCost(row.amount) > 0 || poHeaderCost(row.discountValue) > 0;
  }
  return poHeaderCost(row.amount) > 0;
}

export function visiblePoAdjustmentRows(doc) {
  const subTotal = resolveStoredSubTotal(doc);
  return withDerivedDiscountAmounts(resolvePoAdjustments(doc), subTotal).filter((row) => {
    if (String(row.type).toUpperCase() === "DISCOUNT" && poDiscountMode(row) === "PERCENT") {
      return poHeaderCost(row.discountValue) > 0 && poHeaderCost(row.amount) > 0;
    }
    return poHeaderCost(row.amount) > 0;
  });
}

export function validatePoAdjustments(rows) {
  const errors = [];
  if (rows == null) return errors;
  if (!Array.isArray(rows)) {
    errors.push("Adjustments must be an array");
    return errors;
  }
  const seenSystem = new Set();
  for (const row of rows) {
    const type = String(row?.type || "").toUpperCase();
    if (!isPoAdjustmentType(type)) {
      errors.push(`Unknown adjustment type: ${row?.type ?? ""}`);
      continue;
    }
    if (type === "DISCOUNT") {
      const mode = poDiscountMode(row);
      const source = mode === "PERCENT" ? row?.discountValue : row?.discountValue ?? row?.amount;
      const parsed = parsePoAdjustmentAmount(source);
      if (!parsed.ok) {
        errors.push(mode === "PERCENT" ? "Discount percentage must be numeric" : parsed.message);
        continue;
      }
    } else {
      const parsed = parsePoAdjustmentAmount(row?.amount);
      if (!parsed.ok) {
        errors.push(parsed.message);
        continue;
      }
      if (type === "CUSTOM" && parsed.amount > 0 && !String(row?.label || "").trim()) {
        errors.push("Custom cost requires a description");
      }
    }
    if (type !== "CUSTOM") {
      if (seenSystem.has(type)) {
        errors.push(`${defaultPoAdjustmentLabel(type)} cannot be added more than once`);
      }
      seenSystem.add(type);
    }
  }
  return errors;
}

/** Drop unused zero-value rows after validation. PERCENT 0% is unused; PERCENT > 0 is kept. */
export function preparePoAdjustmentsForSave(rows) {
  return sanitizePoAdjustments(rows).filter(isPersistableAdjustment);
}

export function summarizeAdjustmentsAsLegacy(adjustments, subTotal = 0) {
  let packingCost = 0;
  let handlingCost = 0;
  let miscellaneousCost = 0;
  let discountRaw = 0;
  let discountType = "NONE";
  let discountValue = 0;
  const sub = Number(subTotal) || 0;
  for (const row of adjustments || []) {
    const type = String(row.type || "").toUpperCase();
    if (type === "PACKING") packingCost += poHeaderCost(row.amount);
    else if (type === "HANDLING") handlingCost += poHeaderCost(row.amount);
    else if (type === "DISCOUNT") {
      const mode = poDiscountMode(row);
      discountType = mode;
      discountValue =
        mode === "PERCENT" ? poHeaderCost(row.discountValue) : poHeaderCost(row.discountValue ?? row.amount);
      discountRaw += discountMonetaryAmount(row, sub);
    } else {
      miscellaneousCost += poHeaderCost(row.amount);
    }
  }
  const discountTotal = Math.min(sub, discountRaw);
  return { packingCost, handlingCost, miscellaneousCost, discountTotal, discountRaw, discountType, discountValue };
}

export function legacyCostsFromAdjustments(adjustments, subTotal = 0) {
  const { packingCost, handlingCost, miscellaneousCost, discountTotal, discountType, discountValue } =
    summarizeAdjustmentsAsLegacy(adjustments, subTotal);
  const persistType =
    discountType === "PERCENT" && discountValue > 0
      ? "PERCENT"
      : discountType === "FLAT" && discountValue > 0
        ? "FLAT"
        : discountTotal > 0
          ? discountType
          : "NONE";
  return {
    packingCost,
    handlingCost,
    miscellaneousCost,
    discountType: persistType,
    discountValue: persistType === "NONE" ? 0 : discountValue,
    discountTotal,
  };
}

export function calcPoGrandTotalFromAdjustments(subTotal, adjustments) {
  const sub = Number(subTotal) || 0;
  const { packingCost, handlingCost, miscellaneousCost, discountTotal } =
    summarizeAdjustmentsAsLegacy(adjustments, sub);
  return calcPoGrandTotal(sub, packingCost, handlingCost, miscellaneousCost, discountTotal);
}

function totalsFromAdjustments(subTotal, adjustments) {
  const derived = withDerivedDiscountAmounts(adjustments, subTotal);
  const visible = derived.filter((row) => {
    if (String(row.type).toUpperCase() === "DISCOUNT" && poDiscountMode(row) === "PERCENT") {
      return poHeaderCost(row.discountValue) > 0 && poHeaderCost(row.amount) > 0;
    }
    return poHeaderCost(row.amount) > 0;
  });
  const legacy = summarizeAdjustmentsAsLegacy(adjustments, subTotal);
  const grandTotal = calcPoGrandTotal(
    subTotal,
    legacy.packingCost,
    legacy.handlingCost,
    legacy.miscellaneousCost,
    legacy.discountTotal
  );
  return {
    subTotal,
    discountTotal: legacy.discountTotal,
    discountType: legacy.discountType,
    discountValue: legacy.discountValue,
    packingCost: legacy.packingCost,
    handlingCost: legacy.handlingCost,
    miscellaneousCost: legacy.miscellaneousCost,
    adjustments: visible,
    grandTotal,
  };
}

export function calcPoTotalsFromDoc(doc) {
  const subTotal = resolveStoredSubTotal(doc);
  return totalsFromAdjustments(subTotal, resolvePoAdjustments(doc));
}

export function calcPoTotalsPreview(src) {
  const subTotal = lineItemsSubTotal(src);
  const adjustments = Array.isArray(src?.adjustments)
    ? sanitizePoAdjustments(src.adjustments)
    : resolvePoAdjustments(src);
  return totalsFromAdjustments(subTotal, adjustments);
}

export function listVisiblePoTotalRows(doc) {
  const totals = calcPoTotalsFromDoc(doc);
  const rows = (totals.adjustments || []).map((row) => ({
    type: row.type,
    label: poAdjustmentDisplayLabel(row),
    amount: poHeaderCost(row.amount),
    isDiscount: String(row.type).toUpperCase() === "DISCOUNT",
    discountMode: String(row.type).toUpperCase() === "DISCOUNT" ? poDiscountMode(row) : undefined,
    discountValue: row.discountValue,
  }));
  return {
    subTotal: totals.subTotal,
    grandTotal: totals.grandTotal,
    rows,
  };
}

export function buildPoDocumentTotalsRowsHtml(doc, currency) {
  const cur = String(currency || doc?.currency || "USD");
  const { subTotal, grandTotal, rows } = listVisiblePoTotalRows(doc);
  const line = (label, amount) =>
    `<div style="display:flex;justify-content:space-between;color:#4b5563;margin-bottom:6px"><span>${label}</span><span style="font-weight:600;color:#111">${cur} ${Number(amount).toFixed(2)}</span></div>`;
  const adjustmentHtml = rows.map((row) => line(row.label, row.amount)).join("");
  return (
    line("Line items subtotal", subTotal) +
    adjustmentHtml +
    `<div style="display:flex;justify-content:space-between;padding-top:8px;border-top:1px solid #e5e7eb;font-size:16px;font-weight:700;color:#1f3a5f"><span>Grand total</span><span>${cur} ${Number(grandTotal).toFixed(2)}</span></div>`
  );
}

/** Simulate save → stored document for idempotency tests (no DB). */
export function applyPoAdjustmentsRoundTrip(doc) {
  const subTotal = lineItemsSubTotal(doc);
  const prepared = preparePoAdjustmentsForSave(resolvePoAdjustments(doc));
  const shadow = legacyCostsFromAdjustments(prepared, subTotal);
  return {
    currency: doc.currency,
    lines: doc.lines,
    subTotal,
    adjustments: prepared,
    ...shadow,
    grandTotal: calcPoGrandTotalFromAdjustments(subTotal, prepared),
  };
}

export function supplierPartNumberDisplay(line) {
  const v = String(line?.supplierPartNumber ?? "").trim();
  return v || "—";
}
