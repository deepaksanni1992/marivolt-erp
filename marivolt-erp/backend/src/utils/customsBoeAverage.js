/**
 * BOE-average customs valuation helpers.
 * customsUnitValue = boeDeclaredValue / boeDeclaredQty (server-authoritative).
 * Never trust a client-supplied unit value.
 */

export const CUSTOMS_VALUATION_BOE_AVERAGE = "BOE_AVERAGE";
export const CUSTOMS_VALUATION_LEGACY_LINE = "LEGACY_LINE_VALUE";

/** Money rounding — matches ERP roundMoney (2 dp). */
export function roundCustomsMoney(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.round((x + Number.EPSILON) * 100) / 100;
}

/** Qty precision — up to 6 dp for non-integer customs qty. */
export function roundCustomsQty(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.round(x * 1e6) / 1e6;
}

export function isBoeAverageValuation(method) {
  return String(method || "").toUpperCase() === CUSTOMS_VALUATION_BOE_AVERAGE;
}

export function resolveValuationMethod(raw) {
  const m = String(raw || "").toUpperCase();
  if (m === CUSTOMS_VALUATION_BOE_AVERAGE) return CUSTOMS_VALUATION_BOE_AVERAGE;
  if (m === CUSTOMS_VALUATION_LEGACY_LINE) return CUSTOMS_VALUATION_LEGACY_LINE;
  // Absent / unknown → legacy for historical compatibility
  return CUSTOMS_VALUATION_LEGACY_LINE;
}

/**
 * Authoritative BOE unit value.
 * @returns {{ ok: boolean, customsUnitValue: number, message?: string }}
 */
export function computeBoeCustomsUnitValue(boeDeclaredValue, boeDeclaredQty) {
  const value = Number(boeDeclaredValue);
  const qty = Number(boeDeclaredQty);
  if (!Number.isFinite(value) || value < 0) {
    return { ok: false, customsUnitValue: 0, message: "BOE Declared Value must be a non-negative number" };
  }
  if (!Number.isFinite(qty) || !(qty > 0)) {
    return { ok: false, customsUnitValue: 0, message: "BOE Declared Customs Qty must be greater than zero" };
  }
  const unit = roundCustomsMoney(value / qty);
  if (!Number.isFinite(unit) || unit < 0) {
    return { ok: false, customsUnitValue: 0, message: "BOE Customs Unit Value could not be calculated" };
  }
  return { ok: true, customsUnitValue: unit };
}

/**
 * Distribute BOE declared value across line customs qtys with residual on last positive line.
 * Ensures sum(lineValues) === roundMoney(boeDeclaredValue) within 2 dp.
 */
export function allocateBoeLineValues({
  lines = [],
  boeDeclaredValue,
  customsUnitValue,
} = {}) {
  const declared = roundCustomsMoney(boeDeclaredValue);
  const unit = Number(customsUnitValue) || 0;
  const out = [];
  let allocated = 0;
  const positiveIdx = lines
    .map((ln, i) => ({ i, qty: roundCustomsQty(ln.customsQty) }))
    .filter((x) => x.qty > 0);

  for (let i = 0; i < lines.length; i++) {
    const qty = roundCustomsQty(lines[i].customsQty);
    if (!(qty > 0)) {
      out.push({ ...lines[i], customsQty: 0, customsTotalPrice: 0 });
      continue;
    }
    const isLast = positiveIdx.length && i === positiveIdx[positiveIdx.length - 1].i;
    let total;
    if (isLast) {
      total = roundCustomsMoney(declared - allocated);
    } else {
      total = roundCustomsMoney(qty * unit);
      allocated = roundCustomsMoney(allocated + total);
    }
    out.push({
      ...lines[i],
      customsQty: qty,
      customsUnitValue: unit,
      customsTotalPrice: total,
    });
  }
  return out;
}

export function sameUomFamily(a, b) {
  const x = String(a || "PCS").trim().toUpperCase() || "PCS";
  const y = String(b || "PCS").trim().toUpperCase() || "PCS";
  return x === y;
}

/**
 * Decide whether BOE qty can default from physical accepted qty (1:1 PCS-like).
 */
export function canDefaultBoeQtyFromPhysical({ customsUom, lineUoms = [] } = {}) {
  const cu = String(customsUom || "PCS").trim().toUpperCase() || "PCS";
  if (!lineUoms.length) return cu === "PCS" || !customsUom;
  return lineUoms.every((u) => sameUomFamily(u, cu));
}

/**
 * Build per-line customs qty map.
 * - If every line has customsQty → use those (must sum to boeDeclaredQty).
 * - Else if 1:1 compatible → customsQty = physical qty.
 * - Else error: explicit mapping required.
 */
export function resolveLineCustomsQuantities({
  lines = [],
  boeDeclaredQty,
  customsUom,
} = {}) {
  const declared = roundCustomsQty(boeDeclaredValueSafe(boeDeclaredQty));
  const physical = lines.map((ln) => ({
    key: String(ln.poLineId ?? ln._id ?? ln.article ?? ""),
    article: ln.article || "",
    physicalQty: roundCustomsQty(ln.acceptedQty ?? ln.receivedQty ?? ln.quantity ?? ln.grnQty),
    uom: ln.uom || "PCS",
    customsQtyOverride: ln.customsQty != null && ln.customsQty !== "" ? roundCustomsQty(ln.customsQty) : null,
  }));

  const active = physical.filter((p) => p.physicalQty > 0);
  const hasAnyOverride = active.some((p) => p.customsQtyOverride != null && p.customsQtyOverride > 0);
  const hasAllOverrides = active.every((p) => p.customsQtyOverride != null && p.customsQtyOverride > 0);

  if (hasAnyOverride && !hasAllOverrides) {
    return {
      ok: false,
      lines: [],
      message:
        "When Customs Qty differs from physical qty, every accepted line must include an explicit customsQty allocation.",
    };
  }

  if (hasAllOverrides) {
    const mapped = active.map((p) => ({
      key: p.key,
      article: p.article,
      physicalQty: p.physicalQty,
      uom: p.uom,
      customsQty: p.customsQtyOverride,
    }));
    const sum = roundCustomsQty(mapped.reduce((s, r) => s + r.customsQty, 0));
    if (Math.abs(sum - declared) > 1e-6) {
      return {
        ok: false,
        lines: mapped,
        message: `Sum of line customsQty (${sum}) must equal BOE Declared Customs Qty (${declared}).`,
      };
    }
    return { ok: true, lines: mapped, mode: "EXPLICIT" };
  }

  const uoms = active.map((p) => p.uom);
  const oneToOne = canDefaultBoeQtyFromPhysical({ customsUom, lineUoms: uoms });
  const physicalSum = roundCustomsQty(active.reduce((s, p) => s + p.physicalQty, 0));

  if (oneToOne && Math.abs(physicalSum - declared) <= 1e-6) {
    return {
      ok: true,
      mode: "ONE_TO_ONE",
      lines: active.map((p) => ({
        key: p.key,
        article: p.article,
        physicalQty: p.physicalQty,
        uom: p.uom,
        customsQty: p.physicalQty,
      })),
    };
  }

  if (oneToOne && Math.abs(physicalSum - declared) > 1e-6) {
    return {
      ok: false,
      lines: [],
      message: `BOE Declared Customs Qty (${declared}) must equal sum of accepted GRN qty (${physicalSum}) when Customs UOM matches inventory UOM, or provide explicit customsQty per line.`,
    };
  }

  return {
    ok: false,
    lines: [],
    message:
      "Customs UOM differs from inventory UOM (or qty mismatch). Provide explicit customsQty per accepted GRN line so allocations sum to BOE Declared Customs Qty.",
  };
}

function boeDeclaredValueSafe(v) {
  return Number(v);
}

/**
 * Compare sales unit price vs BOE customs unit value in a common currency (prefer AED).
 * Returns warning payload; never invents FX.
 */
export function compareSalesVsBoeCustomsUnit({
  salesUnitPrice,
  salesCurrency,
  salesUnitPriceAed,
  boeCustomsUnitValue,
  boeCurrency,
  boeExchangeRateToAed,
} = {}) {
  const sales = Number(salesUnitPrice);
  const boe = Number(boeCustomsUnitValue);
  if (!Number.isFinite(sales) || !Number.isFinite(boe)) {
    return { comparable: false, warning: false, message: "Customs price comparison unavailable." };
  }

  const sCur = String(salesCurrency || "").toUpperCase();
  const bCur = String(boeCurrency || "").toUpperCase();

  let salesCmp = null;
  let boeCmp = null;
  let cmpCurrency = "";

  if (Number.isFinite(Number(salesUnitPriceAed)) && Number(salesUnitPriceAed) >= 0) {
    const fx = Number(boeExchangeRateToAed);
    if (fx > 0) {
      salesCmp = Number(salesUnitPriceAed);
      boeCmp = roundCustomsMoney(boe * fx);
      cmpCurrency = "AED";
    }
  }

  if (salesCmp == null && sCur && bCur && sCur === bCur) {
    salesCmp = sales;
    boeCmp = boe;
    cmpCurrency = sCur;
  }

  if (salesCmp == null || boeCmp == null) {
    return {
      comparable: false,
      warning: false,
      message: "Customs price comparison unavailable — FX conversion required.",
      salesCurrency: sCur,
      boeCurrency: bCur,
    };
  }

  const diff = roundCustomsMoney(salesCmp - boeCmp);
  const variancePct =
    boeCmp > 0 ? roundCustomsMoney((diff / boeCmp) * 100) : salesCmp === 0 ? 0 : null;
  const warning = salesCmp + 1e-9 < boeCmp;

  return {
    comparable: true,
    warning,
    message: warning ? "Sales price is below BOE Customs Unit Value." : "",
    comparisonCurrency: cmpCurrency,
    salesUnitPriceCompared: salesCmp,
    boeCustomsUnitValueCompared: boeCmp,
    difference: diff,
    variancePct,
  };
}
