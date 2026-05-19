/** Non-negative PO header cost; used for packing / handling / miscellaneous. */
export function poHeaderCost(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

export function calcPoGrandTotal(subTotal, packingCost = 0, handlingCost = 0, miscellaneousCost = 0) {
  const sub = Number(subTotal) || 0;
  return (
    sub +
    poHeaderCost(packingCost) +
    poHeaderCost(handlingCost) +
    poHeaderCost(miscellaneousCost)
  );
}
