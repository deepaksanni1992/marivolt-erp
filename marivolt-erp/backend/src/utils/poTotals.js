/** Non-negative PO header cost; used for packing / handling / miscellaneous. */
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
