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

export function calcPoTotalsFromDoc(doc) {
  const lines = Array.isArray(doc?.lines) ? doc.lines : [];
  const subTotal =
    doc?.subTotal != null
      ? Number(doc.subTotal)
      : lines.reduce((s, l) => s + (Number(l.qty) || 0) * (Number(l.unitPrice) || 0), 0);
  const packingCost = poHeaderCost(doc?.packingCost);
  const handlingCost = poHeaderCost(doc?.handlingCost);
  const miscellaneousCost = poHeaderCost(doc?.miscellaneousCost);
  const grandTotal =
    doc?.grandTotal != null
      ? Number(doc.grandTotal)
      : calcPoGrandTotal(subTotal, packingCost, handlingCost, miscellaneousCost);
  return { subTotal, packingCost, handlingCost, miscellaneousCost, grandTotal };
}

export function supplierPartNumberDisplay(line) {
  const v = String(line?.supplierPartNumber ?? "").trim();
  return v || "—";
}
