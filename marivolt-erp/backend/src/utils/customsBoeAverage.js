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
        message: `Customs Qty total ${sum} does not match BOE Declared Qty ${declared}.`,
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

/** Primary inbound/source classification for Customs Stock article rows (display/provenance). */
export const CUSTOMS_SOURCE_GRN = "GRN";
export const CUSTOMS_SOURCE_ARTICLE_CONVERSION = "ARTICLE_CONVERSION";
export const CUSTOMS_SOURCE_LEGACY = "LEGACY";
export const CUSTOMS_SOURCE_OTHER = "OTHER";

/** Display badge when a direct GRN layer was fully retargeted by article conversion. */
export const CUSTOMS_CONVERSION_STATUS_CONVERTED_OUT = "CONVERTED_OUT";

/**
 * Map source lot-item id → conversion metadata from sibling derived layers in the same lot.
 * Used only for presentation (Converted Out); does not mutate stock.
 */
export function indexConvertedOutSources(items = []) {
  const map = new Map();
  for (const item of items || []) {
    const fromId = item?.convertedFromLotItemId != null ? String(item.convertedFromLotItemId) : "";
    if (!fromId) continue;
    const conversionNo = String(item.conversionNo || "").trim().toUpperCase();
    const prev = map.get(fromId);
    // Prefer an entry that carries a conversion number when multiple derived rows exist.
    if (!prev || (!prev.conversionNo && conversionNo)) {
      map.set(fromId, {
        conversionNo,
        conversionDocumentId: item.conversionDocumentId || null,
        targetArticle: String(item.articleNumber || "").trim().toUpperCase(),
      });
    }
  }
  return map;
}

/**
 * Resolve additive provenance fields for one CustomsLotItem in a stock group.
 * Does not invent conversion refs for historical/legacy rows.
 *
 * @param {object} item
 * @param {object} lot
 * @param {{ convertedOutMeta?: { conversionNo?: string, conversionDocumentId?: *, targetArticle?: string } | null }} [opts]
 */
export function resolveCustomsLotItemProvenance(item = {}, lot = {}, opts = {}) {
  const grnNo = String(item.grnNo || lot.grnNo || "").trim();
  const isConversionLayer = Boolean(item.isConversionLayer);
  const conversionNo = String(item.conversionNo || "").trim().toUpperCase();
  const convertedFromLotItemId =
    item.convertedFromLotItemId != null && item.convertedFromLotItemId !== ""
      ? String(item.convertedFromLotItemId)
      : "";
  const originalReceivedArticle = String(item.originalReceivedArticle || "").trim().toUpperCase();
  const conversionDocumentId = item.conversionDocumentId || null;
  const qtyAvailable = Number(item.qtyAvailable) || 0;
  const convertedOutMeta = opts.convertedOutMeta || null;

  const looksConverted =
    isConversionLayer || Boolean(conversionNo) || Boolean(convertedFromLotItemId);

  let sourceType = CUSTOMS_SOURCE_LEGACY;
  let sourceRef = "";

  if (looksConverted) {
    sourceType = CUSTOMS_SOURCE_ARTICLE_CONVERSION;
    sourceRef = conversionNo;
  } else if (grnNo) {
    sourceType = CUSTOMS_SOURCE_GRN;
    sourceRef = grnNo;
  } else if (item.grnId || lot.grnId) {
    // GRN id without readable number — still treat as GRN when known, else legacy.
    sourceType = CUSTOMS_SOURCE_GRN;
    sourceRef = grnNo;
  }

  const originalGrnNo = grnNo;

  // Converted Out: only when a derived layer points at this item AND availability is depleted.
  // Do not label ordinary export/consume as Converted Out.
  let conversionStatus = "";
  let convertedOutConversionNo = "";
  let convertedOutDocumentId = null;
  if (
    convertedOutMeta &&
    sourceType === CUSTOMS_SOURCE_GRN &&
    !looksConverted &&
    qtyAvailable <= 1e-6
  ) {
    conversionStatus = CUSTOMS_CONVERSION_STATUS_CONVERTED_OUT;
    convertedOutConversionNo = String(convertedOutMeta.conversionNo || "").trim().toUpperCase();
    convertedOutDocumentId = convertedOutMeta.conversionDocumentId || null;
  }

  const effectiveConversionNo = conversionNo || convertedOutConversionNo || "";
  const effectiveConversionDocumentId = conversionDocumentId || convertedOutDocumentId || null;

  let provenanceTooltip = "";
  if (sourceType === CUSTOMS_SOURCE_ARTICLE_CONVERSION) {
    const fromArt = originalReceivedArticle || "source article";
    const conv = effectiveConversionNo || "article conversion";
    const origGrn = originalGrnNo || "—";
    const boe = String(item.boeNumber || lot.boeNumber || "").trim() || "—";
    provenanceTooltip = `Derived from article ${fromArt} under ${conv}. Original customs provenance: ${origGrn} / BOE ${boe}.`;
  } else if (conversionStatus === CUSTOMS_CONVERSION_STATUS_CONVERTED_OUT) {
    const toArt = String(convertedOutMeta?.targetArticle || "").trim() || "target article";
    const conv = convertedOutConversionNo || "article conversion";
    provenanceTooltip = `Converted out to ${toArt} under ${conv}. Original GRN receipt layer (depleted).`;
  }

  return {
    sourceType,
    sourceRef,
    originalGrnNo,
    originalReceivedArticle:
      sourceType === CUSTOMS_SOURCE_ARTICLE_CONVERSION ? originalReceivedArticle : originalReceivedArticle || "",
    conversionNo: effectiveConversionNo,
    conversionDocumentId: effectiveConversionDocumentId,
    convertedFromLotItemId: convertedFromLotItemId || null,
    isConversionLayer,
    conversionStatus,
    provenanceTooltip,
  };
}

/**
 * Per-line customs qty/value economics for stock display.
 *
 * Distinguishes:
 * - historicalImportedValue — stored layer totalValue (audit; may remain on converted-out rows)
 * - remainingCustomsValue — CURRENT remaining customs value (never uses stale totalValue when qty=0)
 * - importedCustomsValue — current-layer imported value for stock totals (0 when layer fully emptied without export)
 *
 * totalValue in the schema is the layer's customs value for its qtyImported basis; conversion must
 * reduce it when retargeting. This helper still guards display when older rows left totalValue stale.
 */
export function computeLotItemCustomsEconomics(item = {}) {
  const qtyImported = Number(item.qtyImported) || 0;
  const qtyAvailable = Number(item.qtyAvailable) || 0;
  const qtyConsumed = Number(item.qtyConsumed) || 0;
  const unit = Number(item.customsUnitValue ?? item.unitPrice) || 0;
  const storedTotal =
    item.totalValue != null && item.totalValue !== "" ? roundCustomsMoney(item.totalValue) : null;

  /** Fully emptied without customs export — typical converted-out GRN layer after retarget. */
  const emptiedWithoutExport = qtyImported <= 1e-9 && qtyAvailable <= 1e-9 && qtyConsumed <= 1e-9;

  let customsQtyImported = roundCustomsQty(Number(item.customsQtyImported) || qtyImported);
  if (emptiedWithoutExport) {
    customsQtyImported = 0;
  }

  const remainingCustomsQty =
    qtyAvailable <= 1e-9
      ? 0
      : qtyImported > 1e-9
        ? roundCustomsQty(Math.max(0, customsQtyImported * (qtyAvailable / qtyImported)))
        : roundCustomsQty(Math.max(0, qtyAvailable));

  const exportedCustomsQty = roundCustomsQty(Math.max(0, customsQtyImported - remainingCustomsQty));

  const historicalImportedValue =
    storedTotal != null ? storedTotal : roundCustomsMoney((Number(item.customsQtyImported) || qtyImported) * unit);

  // Empty retargeted layers must not contribute current imported value (avoids BOE double-count with target).
  const importedCustomsValue = emptiedWithoutExport ? 0 : historicalImportedValue;

  let remainingCustomsValue;
  if (remainingCustomsQty <= 1e-9) {
    remainingCustomsValue = 0;
  } else if (qtyImported > 1e-9 && storedTotal != null) {
    remainingCustomsValue = roundCustomsMoney(storedTotal * (qtyAvailable / qtyImported));
  } else {
    remainingCustomsValue = roundCustomsMoney(remainingCustomsQty * unit);
  }

  let consumedCustomsValue;
  if (emptiedWithoutExport) {
    consumedCustomsValue = 0;
  } else if (qtyImported > 1e-9 && storedTotal != null) {
    consumedCustomsValue = roundCustomsMoney(storedTotal * (qtyConsumed / qtyImported));
  } else {
    consumedCustomsValue = roundCustomsMoney(exportedCustomsQty * unit);
  }

  return {
    customsQtyImported,
    exportedCustomsQty,
    remainingCustomsQty,
    customsUnitValue: unit,
    importedCustomsValue,
    historicalImportedValue,
    consumedCustomsValue,
    remainingCustomsValue,
    physicalQtyImported: qtyImported,
    physicalQtyExported: qtyConsumed,
    physicalQtyRemaining: qtyAvailable,
  };
}

/**
 * Compute customs qty/value to move from a source layer during article conversion.
 * Conserves remaining customs value; does not invent value.
 */
export function computeConversionCustomsTransfer({
  take,
  qtyAvailable,
  qtyImported,
  qtyConsumed = 0,
  unitPrice = 0,
  customsUnitValue = null,
  totalValue = null,
  customsQtyImported = null,
  customsValueAED = null,
  exchangeRateToAED = 0,
} = {}) {
  const takeQty = Number(take) || 0;
  const avail = Number(qtyAvailable) || 0;
  const imported = Number(qtyImported) || 0;
  const consumed = Number(qtyConsumed) || 0;
  const unit = Number(customsUnitValue ?? unitPrice) || 0;
  const fx = Number(exchangeRateToAED) || 0;
  const srcTotal = totalValue != null && totalValue !== "" ? Number(totalValue) : NaN;
  const srcCqi =
    customsQtyImported != null && customsQtyImported !== ""
      ? Number(customsQtyImported)
      : imported;
  const srcAed = customsValueAED != null && customsValueAED !== "" ? Number(customsValueAED) : NaN;

  if (!(takeQty > 0) || !(avail > 0) || takeQty > avail + 1e-6) {
    return {
      ok: false,
      transferQty: 0,
      transferCustomsQty: 0,
      transferValue: 0,
      transferValueAED: 0,
      unit,
      nextQtyAvailable: avail,
      nextQtyImported: imported,
      nextTotalValue: Number.isFinite(srcTotal) ? roundCustomsMoney(srcTotal) : 0,
      nextCustomsQtyImported: Number.isFinite(srcCqi) ? roundCustomsQty(srcCqi) : 0,
      nextCustomsValueAED: Number.isFinite(srcAed) ? roundCustomsMoney(srcAed) : 0,
      message: "Invalid conversion take/availability",
    };
  }

  const nextAvail = Math.max(0, avail - takeQty);
  const nextImported = Math.max(consumed + nextAvail, imported - takeQty);

  let remainingValueOnAvail;
  if (imported > 1e-9 && Number.isFinite(srcTotal)) {
    remainingValueOnAvail = roundCustomsMoney(srcTotal * (avail / imported));
  } else {
    remainingValueOnAvail = roundCustomsMoney(unit * avail);
  }

  const transferValue =
    nextAvail <= 1e-9
      ? remainingValueOnAvail
      : roundCustomsMoney(remainingValueOnAvail * (takeQty / avail));

  const transferCustomsQty =
    imported > 1e-9 && Number.isFinite(srcCqi)
      ? nextAvail <= 1e-9 && consumed <= 1e-9
        ? roundCustomsQty(srcCqi)
        : roundCustomsQty(srcCqi * (takeQty / imported))
      : roundCustomsQty(takeQty);

  let nextTotalValue = 0;
  if (Number.isFinite(srcTotal)) {
    nextTotalValue = Math.max(0, roundCustomsMoney(srcTotal - transferValue));
  }

  let nextCustomsQtyImported = 0;
  if (Number.isFinite(srcCqi)) {
    nextCustomsQtyImported = Math.max(0, roundCustomsQty(srcCqi - transferCustomsQty));
  }

  let transferValueAED = 0;
  let nextCustomsValueAED = Number.isFinite(srcAed) ? roundCustomsMoney(srcAed) : 0;
  if (Number.isFinite(srcAed) && imported > 1e-9) {
    const remainingAedOnAvail = roundCustomsMoney(srcAed * (avail / imported));
    transferValueAED =
      nextAvail <= 1e-9
        ? remainingAedOnAvail
        : roundCustomsMoney(remainingAedOnAvail * (takeQty / avail));
    nextCustomsValueAED = Math.max(0, roundCustomsMoney(srcAed - transferValueAED));
  } else if (fx > 0) {
    transferValueAED = roundCustomsMoney(transferValue * fx);
    nextCustomsValueAED = Math.max(0, roundCustomsMoney((Number.isFinite(srcAed) ? srcAed : 0) - transferValueAED));
  }

  return {
    ok: true,
    transferQty: takeQty,
    transferCustomsQty,
    transferValue,
    transferValueAED,
    unit,
    nextQtyAvailable: nextAvail,
    nextQtyImported: nextImported,
    nextTotalValue,
    nextCustomsQtyImported,
    nextCustomsValueAED,
  };
}

/**
 * Build one Customs Stock BOE/lot group. Group key is always customsLotId (never BOE number alone).
 */
export function buildCustomsLotStockGroup(lot = {}, items = [], { srNo = 1, matchArticle = "" } = {}) {
  const valuationMethod = resolveValuationMethod(lot.valuationMethod || items[0]?.valuationMethod);
  const isBoeAvg = isBoeAverageValuation(valuationMethod);
  const lotCancelled =
    String(lot.status || "").toUpperCase() === "CANCELLED" ||
    (items.length > 0 && items.every((i) => String(i.status || "").toUpperCase() === "CANCELLED"));

  const convertedOutBy = indexConvertedOutSources(items);

  const articles = (items || []).map((item) => {
    const eco = computeLotItemCustomsEconomics(item);
    const articleMatch =
      matchArticle &&
      String(item.articleNumber || "")
        .toUpperCase()
        .includes(String(matchArticle).toUpperCase());
    const itemId = item._id != null ? String(item._id) : "";
    const provenance = resolveCustomsLotItemProvenance(item, lot, {
      convertedOutMeta: itemId ? convertedOutBy.get(itemId) || null : null,
    });
    return {
      _id: item._id,
      customsLotItemId: item._id,
      articleNumber: item.articleNumber || "",
      partNumber: item.partNumber || "",
      partName: item.partName || item.description || "",
      description: item.description || "",
      hsCode: item.hsCode || "",
      countryOfOrigin: item.countryOfOrigin || "",
      grnId: item.grnId || lot.grnId || null,
      // Retain grnNo for legacy consumers / Original GRN drill-down; primary source is sourceRef.
      grnNo: item.grnNo || lot.grnNo || "",
      location: item.location || item.remarks1 || "",
      status: item.status || "",
      currency: item.currency || lot.currency || "",
      matchHighlight: Boolean(articleMatch),
      ...eco,
      valuationMethod: resolveValuationMethod(item.valuationMethod || valuationMethod),
      ...provenance,
      provenanceTooltip:
        provenance.conversionStatus === CUSTOMS_CONVERSION_STATUS_CONVERTED_OUT &&
        Number(eco.historicalImportedValue) > 0
          ? `${provenance.provenanceTooltip} Historical customs value: ${eco.historicalImportedValue}.`.trim()
          : provenance.provenanceTooltip,
    };
  });

  const importedCustomsQty = roundCustomsQty(
    articles.reduce((s, a) => s + (Number(a.customsQtyImported) || 0), 0),
  );
  const remainingCustomsQty = roundCustomsQty(
    articles.reduce((s, a) => s + (Number(a.remainingCustomsQty) || 0), 0),
  );
  const exportedCustomsQty = roundCustomsQty(
    Math.max(0, importedCustomsQty - remainingCustomsQty),
  );
  const consumedCustomsValue = roundCustomsMoney(
    articles.reduce((s, a) => s + (Number(a.consumedCustomsValue) || 0), 0),
  );
  const remainingCustomsValue = roundCustomsMoney(
    articles.reduce((s, a) => s + (Number(a.remainingCustomsValue) || 0), 0),
  );

  const declaredQty = isBoeAvg ? Number(lot.boeDeclaredQty) || 0 : null;
  const declaredValue = isBoeAvg ? roundCustomsMoney(lot.boeDeclaredValue) : null;
  const customsUnitValue = isBoeAvg
    ? Number(lot.customsUnitValue) || Number(articles[0]?.customsUnitValue) || 0
    : null;

  let status = "OPEN";
  if (lotCancelled) status = "CANCELLED";
  else if (remainingCustomsQty <= 1e-9) status = "CLOSED";

  const qtyInvariantOk =
    !isBoeAvg ||
    declaredQty == null ||
    declaredQty <= 0 ||
    Math.abs(roundCustomsQty(exportedCustomsQty + remainingCustomsQty) - roundCustomsQty(importedCustomsQty)) <=
      1e-6;
  const valueInvariantOk =
    !isBoeAvg ||
    declaredValue == null ||
    Math.abs(
      roundCustomsMoney(consumedCustomsValue + remainingCustomsValue) - roundCustomsMoney(declaredValue),
    ) <= 0.02;

  return {
    srNo,
    groupKey: String(lot._id || ""),
    customsLotId: lot._id,
    customsLotRef: lot.customsLotRef || "",
    companyId: lot.companyId,
    companyCode: lot.companyCode || "",
    valuationMethod,
    isBoeAverage: isBoeAvg,
    boeNumber: lot.boeNumber || "",
    boeDate: lot.boeDate || null,
    blNumber: lot.blNumber || "",
    awbNumber: lot.awbNumber || "",
    supplier: lot.supplierName || "",
    supplierInvoiceNumber: lot.supplierInvoiceNumber || "",
    supplierInvoiceDate: lot.supplierInvoiceDate || null,
    receivedDate: lot.receivedDate || null,
    currency: lot.currency || articles[0]?.currency || "USD",
    customsUom: lot.customsUom || (isBoeAvg ? "PCS" : ""),
    grossWeightKg: Number(lot.grossWeightKg) || 0,
    netWeightKg: Number(lot.netWeightKg) || 0,
    grnId: lot.grnId || null,
    grnNo: lot.grnNo || "",
    status,
    lotStatus: lot.status || "",
    documents: {
      blDocumentId: lot.documents?.blDocumentId || null,
      supplierInvoiceDocumentId: lot.documents?.supplierInvoiceDocumentId || null,
    },
    boeSummary: {
      declaredQty: isBoeAvg ? declaredQty : null,
      exportedQty: exportedCustomsQty,
      remainingQty: remainingCustomsQty,
      importedQty: importedCustomsQty,
      declaredValue: isBoeAvg ? declaredValue : null,
      customsUnitValue: isBoeAvg ? customsUnitValue : null,
      consumedValue: consumedCustomsValue,
      remainingValue: remainingCustomsValue,
      currency: lot.currency || "USD",
      customsUom: lot.customsUom || "",
      grossWeightKg: Number(lot.grossWeightKg) || 0,
      netWeightKg: Number(lot.netWeightKg) || 0,
    },
    reconciliation: {
      qtyInvariantOk,
      valueInvariantOk,
      warning:
        isBoeAvg && (!qtyInvariantOk || !valueInvariantOk)
          ? "BOE qty/value reconciliation mismatch — review Customs Ledger / Reconciliation."
          : "",
    },
    articleCount: articles.length,
    articles,
    hasArticleMatch: articles.some((a) => a.matchHighlight),
  };
}
