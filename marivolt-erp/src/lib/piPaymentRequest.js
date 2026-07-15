/**
 * Frontend helpers for Proforma Invoice Payment Request (partial advance).
 * Mirrors backend rounding / resolution for live totals UI.
 */

export const PI_VALUE_TYPES = ["FULL", "PERCENTAGE", "FIXED_AMOUNT"];

export function roundMoney(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.round((x + Number.EPSILON) * 100) / 100;
}

export function resolvePiPaymentRequest(doc = {}, commercialOverride = null) {
  const commercialGrandTotal = roundMoney(
    Math.max(
      0,
      Number(
        commercialOverride != null ? commercialOverride : doc.commercialGrandTotal ?? doc.grandTotal
      ) || 0
    )
  );
  let piValueType = String(doc.piValueType || "FULL").trim().toUpperCase();
  if (!PI_VALUE_TYPES.includes(piValueType)) piValueType = "FULL";

  let advancePercentage =
    doc.advancePercentage === null || doc.advancePercentage === undefined || doc.advancePercentage === ""
      ? null
      : Number(doc.advancePercentage);
  if (!Number.isFinite(advancePercentage)) advancePercentage = null;

  let requestedAmount =
    doc.requestedAmount === null || doc.requestedAmount === undefined || doc.requestedAmount === ""
      ? null
      : Number(doc.requestedAmount);
  if (!Number.isFinite(requestedAmount)) requestedAmount = null;

  if (piValueType === "FULL") {
    requestedAmount = commercialGrandTotal;
    advancePercentage = commercialGrandTotal > 0 ? 100 : null;
  } else if (piValueType === "PERCENTAGE") {
    const pct = Math.max(0, Math.min(100, Number(advancePercentage) || 0));
    advancePercentage = pct;
    requestedAmount = roundMoney((commercialGrandTotal * pct) / 100);
  } else {
    requestedAmount = roundMoney(Math.max(0, Number(requestedAmount) || 0));
    advancePercentage =
      commercialGrandTotal > 0
        ? roundMoney((requestedAmount / commercialGrandTotal) * 100)
        : null;
  }

  return {
    piValueType,
    advancePercentage,
    requestedAmount: roundMoney(requestedAmount || 0),
    commercialGrandTotal,
    commercialBalanceAmount: roundMoney(Math.max(0, commercialGrandTotal - (requestedAmount || 0))),
    advanceRemarks: String(doc.advanceRemarks ?? ""),
  };
}

export function defaultPiPaymentRequestFields() {
  return {
    piValueType: "FULL",
    advancePercentage: "",
    requestedAmount: "",
    advanceRemarks: "",
  };
}
