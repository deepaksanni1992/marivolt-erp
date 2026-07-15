/**
 * Proforma Invoice — Payment Request (partial advance) helpers.
 *
 * commercialGrandTotal / grandTotal = full commercial order value on the PI.
 * requestedAmount = amount payable against THIS PI (advance / installment).
 * commercialBalanceAmount = commercialGrandTotal - requestedAmount (remaining on contract for this request).
 *
 * Existing payment field balanceAmount stays: payable remaining vs receipts
 * (payableTotal - totalReceived), where payableTotal = requestedAmount (fallback grandTotal).
 */

export const PI_VALUE_TYPES = ["FULL", "PERCENTAGE", "FIXED_AMOUNT"];

const TOL = 0.005;

/** Project display currency rounding (2 dp). */
export function roundMoney(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.round((x + Number.EPSILON) * 100) / 100;
}

/** Amount collection targets for this PI (payment receipts). */
export function piPayableTotal(doc = {}) {
  const requested = Number(doc.requestedAmount);
  if (Number.isFinite(requested) && requested >= 0 && doc.piValueType) {
    return roundMoney(Math.max(0, requested));
  }
  if (Number.isFinite(requested) && requested > 0) {
    return roundMoney(requested);
  }
  return roundMoney(Math.max(0, Number(doc.grandTotal) || 0));
}

/**
 * Resolve payment-request snapshot for display / historical docs (non-mutating).
 */
export function resolvePiPaymentRequest(doc = {}) {
  const commercialGrandTotal = roundMoney(
    Math.max(0, Number(doc.commercialGrandTotal ?? doc.grandTotal) || 0)
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

  if (piValueType === "FULL" || (!doc.piValueType && requestedAmount == null)) {
    piValueType = "FULL";
    requestedAmount = commercialGrandTotal;
    advancePercentage = commercialGrandTotal > 0 ? 100 : null;
  } else if (piValueType === "PERCENTAGE") {
    const pct = Math.max(0, Math.min(100, Number(advancePercentage) || 0));
    advancePercentage = pct;
    requestedAmount = roundMoney((commercialGrandTotal * pct) / 100);
  } else if (piValueType === "FIXED_AMOUNT") {
    requestedAmount = roundMoney(Math.max(0, Number(requestedAmount) || 0));
    advancePercentage =
      commercialGrandTotal > 0
        ? roundMoney((requestedAmount / commercialGrandTotal) * 100)
        : null;
  }

  const commercialBalanceAmount = roundMoney(
    Math.max(0, commercialGrandTotal - (requestedAmount || 0))
  );
  const advanceRemarks = String(doc.advanceRemarks ?? "").replace(/^\s+|\s+$/g, "");

  return {
    piValueType,
    advancePercentage,
    requestedAmount: roundMoney(requestedAmount || 0),
    commercialGrandTotal,
    commercialBalanceAmount,
    advanceRemarks,
  };
}

/**
 * Build + validate payment request fields from commercial totals + request body.
 * Throws Error with message on invalid input.
 *
 * @param {number} commercialGrandTotal - from computeTotals().grandTotal
 * @param {object} body
 * @param {{ maxRequestedAmount?: number|null }} opts - OA remaining capacity (optional)
 */
export function buildValidatedPiPaymentRequest(commercialGrandTotal, body = {}, opts = {}) {
  const commercial = roundMoney(Math.max(0, Number(commercialGrandTotal) || 0));
  if (!Number.isFinite(commercial) || Number.isNaN(commercial)) {
    throw new Error("Commercial grand total is invalid");
  }

  let piValueType = String(body.piValueType || "FULL").trim().toUpperCase();
  if (!PI_VALUE_TYPES.includes(piValueType)) {
    throw new Error("PI Value Type must be FULL, PERCENTAGE, or FIXED_AMOUNT");
  }

  let advancePercentage = null;
  let requestedAmount = 0;
  const advanceRemarks = String(body.advanceRemarks ?? "").replace(/^\s+|\s+$/g, "");

  if (piValueType === "FULL") {
    requestedAmount = commercial;
    advancePercentage = commercial > 0 ? 100 : null;
  } else if (piValueType === "PERCENTAGE") {
    const pct = Number(body.advancePercentage);
    if (!Number.isFinite(pct) || pct <= 0 || pct > 100) {
      throw new Error("Advance Percentage must be greater than 0 and at most 100");
    }
    advancePercentage = pct;
    requestedAmount = roundMoney((commercial * pct) / 100);
  } else {
    const fixed = Number(body.requestedAmount);
    if (!Number.isFinite(fixed) || fixed <= 0) {
      throw new Error("Requested Amount must be greater than 0");
    }
    requestedAmount = roundMoney(fixed);
    if (requestedAmount > commercial + TOL) {
      throw new Error("Requested Amount cannot exceed Commercial Grand Total");
    }
    advancePercentage =
      commercial > 0 ? roundMoney((requestedAmount / commercial) * 100) : null;
  }

  if (requestedAmount < 0 || Number.isNaN(requestedAmount)) {
    throw new Error("Requested Amount is invalid");
  }

  const maxCap =
    opts.maxRequestedAmount === null || opts.maxRequestedAmount === undefined
      ? null
      : roundMoney(Math.max(0, Number(opts.maxRequestedAmount) || 0));
  if (maxCap != null && requestedAmount > maxCap + TOL) {
    throw new Error(
      `Requested Amount exceeds remaining PI-eligible amount (${maxCap.toFixed(2)}) for this order`
    );
  }

  const commercialBalanceAmount = roundMoney(Math.max(0, commercial - requestedAmount));

  if (piValueType === "FULL") {
    if (Math.abs(requestedAmount - commercial) > TOL) {
      throw new Error("Full Value PI requested amount must equal Commercial Grand Total");
    }
    if (commercialBalanceAmount > TOL) {
      throw new Error("Full Value PI balance must be 0");
    }
  }

  return {
    piValueType,
    advancePercentage,
    requestedAmount,
    commercialGrandTotal: commercial,
    commercialBalanceAmount,
    advanceRemarks,
    // Keep grandTotal as commercial total for historical / conversion compatibility.
    grandTotal: commercial,
  };
}

/** Default FULL snapshot for create/convert when body omits payment request. */
export function defaultFullPiPaymentRequest(commercialGrandTotal) {
  return buildValidatedPiPaymentRequest(commercialGrandTotal, { piValueType: "FULL" });
}
