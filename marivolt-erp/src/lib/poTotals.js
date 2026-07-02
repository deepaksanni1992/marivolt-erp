export function poHeaderCost(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

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

function resolvePoDiscountTotal(doc, subTotal) {
  const type = String(doc?.discountType || "NONE").toUpperCase();
  if (type === "PERCENT" || type === "FLAT") {
    return calcPoDiscountTotal(subTotal, type, doc?.discountValue);
  }
  if (doc?.discountTotal != null) {
    return Math.min(subTotal, Math.max(0, Number(doc.discountTotal) || 0));
  }
  return 0;
}

export function calcPoTotalsFromDoc(doc) {
  const lines = Array.isArray(doc?.lines) ? doc.lines : [];
  const subTotal =
    doc?.subTotal != null
      ? Number(doc.subTotal)
      : lines.reduce((s, l) => s + (Number(l.qty) || 0) * (Number(l.unitPrice) || 0), 0);
  const packingCost = poHeaderCost(doc?.packingCost);
  const handlingCost = poHeaderCost(doc?.handlingCost);
  const miscellaneousCost = poHeaderCost(doc?.miscellaneousCost);
  const discountTotal = resolvePoDiscountTotal(doc, subTotal);
  const grandTotal = calcPoGrandTotal(subTotal, packingCost, handlingCost, miscellaneousCost, discountTotal);
  return { subTotal, discountTotal, packingCost, handlingCost, miscellaneousCost, grandTotal };
}

export function calcPoTotalsPreview(src) {
  const lines = Array.isArray(src?.lines) ? src.lines : [];
  const subTotal = lines.reduce((s, l) => s + (Number(l.qty) || 0) * (Number(l.unitPrice) || 0), 0);
  const packingCost = poHeaderCost(src?.packingCost);
  const handlingCost = poHeaderCost(src?.handlingCost);
  const miscellaneousCost = poHeaderCost(src?.miscellaneousCost);
  const discountTotal = calcPoDiscountTotal(subTotal, src?.discountType, src?.discountValue);
  const grandTotal = calcPoGrandTotal(subTotal, packingCost, handlingCost, miscellaneousCost, discountTotal);
  return { subTotal, discountTotal, packingCost, handlingCost, miscellaneousCost, grandTotal };
}

export function supplierPartNumberDisplay(line) {
  const v = String(line?.supplierPartNumber ?? "").trim();
  return v || "—";
}
