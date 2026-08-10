/** Default empty customs capture state for GRN posting (BOE_AVERAGE). */
export function emptyGrnCustomsState() {
  return {
    receivedDate: new Date().toISOString().slice(0, 10),
    boeNumber: "",
    boeDate: "",
    blNumber: "",
    awbNumber: "",
    supplierInvoiceNumber: "",
    supplierInvoiceDate: "",
    countryOfOrigin: "",
    hsCode: "",
    unitWeightKg: "",
    customsCurrency: "",
    exchangeRateToAED: "",
    customsRemarks: "",
    boeDeclaredQty: "",
    customsUom: "PCS",
    boeDeclaredValue: "",
    grossWeightKg: "",
    netWeightKg: "",
    allowBoeBeforePoDate: false,
    allowInvoiceAfterReceivedDate: false,
    allowFutureReceivedDate: false,
    documents: {
      blCopy: null,
      supplierInvoiceCopy: null,
      packingListCopy: null,
      otherDocuments: [],
    },
  };
}

function trim(v) {
  return String(v ?? "").trim();
}

function hasLineCustomsFields(ed = {}) {
  return [
    ed.customsReceivedDate,
    ed.customsBoeNumber,
    ed.customsBoeDate,
    ed.customsBlNumber,
    ed.customsAwbNumber,
    ed.customsSupplierInvoiceNumber,
    ed.customsSupplierInvoiceDate,
    ed.customsHsCode,
    ed.customsCountryOfOrigin,
    ed.customsCurrency,
    ed.customsUnitWeightKg,
    ed.customsWeightKg,
    ed.customsExchangeRateToAED,
    ed.customsRemarks,
    ed.customsQty,
  ].some((f) => trim(f));
}

/** True when user entered any customs field or uploaded a document. */
export function hasGrnCustomsInput(customs) {
  if (!customs || typeof customs !== "object") return false;
  const headerFields = [
    customs.receivedDate,
    customs.boeNumber,
    customs.boeDate,
    customs.blNumber,
    customs.awbNumber,
    customs.supplierInvoiceNumber,
    customs.supplierInvoiceDate,
    customs.countryOfOrigin,
    customs.hsCode,
    customs.customsCurrency,
    customs.currency,
    customs.unitWeightKg,
    customs.weightKg,
    customs.exchangeRateToAED,
    customs.customsRemarks,
    customs.remarks,
    customs.boeDeclaredQty,
    customs.boeDeclaredValue,
    customs.customsUom,
    customs.grossWeightKg,
    customs.netWeightKg,
  ];
  if (headerFields.some((f) => trim(f))) return true;

  const docs = customs.documents || {};
  if (docs.blCopy?._id || docs.supplierInvoiceCopy?._id || docs.packingListCopy?._id) return true;
  if (Array.isArray(docs.otherDocuments) && docs.otherDocuments.some((d) => d?._id)) return true;
  return false;
}

/** Preview BOE customs unit value (UI only — backend recalculates). */
export function previewBoeCustomsUnitValue(declaredValue, declaredQty) {
  const v = Number(declaredValue);
  const q = Number(declaredQty);
  if (!Number.isFinite(v) || !Number.isFinite(q) || !(q > 0)) return null;
  return Math.round((v / q + Number.EPSILON) * 100) / 100;
}

/**
 * Build customs payload for POST /grn/post.
 * Does NOT send customsUnitPrice / customsUnitValue as source of truth.
 */
export function buildGrnCustomsPayload(customs, lineEdits, selectedLines, defaultCurrency = "USD") {
  if (!hasGrnCustomsInput(customs)) {
    const anyLineCustoms = (selectedLines || []).some((ln) => {
      const id = ln.poLineId != null ? String(ln.poLineId) : "";
      return hasLineCustomsFields(lineEdits[id]);
    });
    if (!anyLineCustoms) return null;
  }

  const headerCurrency =
    trim(customs.customsCurrency) || trim(customs.currency) || trim(defaultCurrency) || "USD";
  const lineOverrides = [];

  for (const ln of selectedLines || []) {
    const id = ln.poLineId != null ? String(ln.poLineId) : "";
    const ed = lineEdits[id] || {};
    if (!hasLineCustomsFields(ed)) continue;

    const row = { poLineId: ln.poLineId };
    const setIf = (key, val) => {
      if (trim(val)) row[key] = trim(val);
    };
    setIf("receivedDate", ed.customsReceivedDate);
    setIf("boeNumber", ed.customsBoeNumber);
    setIf("boeDate", ed.customsBoeDate);
    setIf("blNumber", ed.customsBlNumber);
    setIf("awbNumber", ed.customsAwbNumber);
    setIf("supplierInvoiceNumber", ed.customsSupplierInvoiceNumber);
    setIf("supplierInvoiceDate", ed.customsSupplierInvoiceDate);
    setIf("hsCode", ed.customsHsCode);
    setIf("countryOfOrigin", ed.customsCountryOfOrigin);
    setIf("customsCurrency", ed.customsCurrency);
    setIf("customsRemarks", ed.customsRemarks);

    const customsQty = trim(ed.customsQty);
    if (customsQty) row.customsQty = Number(customsQty) || 0;
    const unitWt = trim(ed.customsUnitWeightKg || ed.customsWeightKg);
    if (unitWt) row.unitWeightKg = Number(unitWt) || 0;
    const fx = trim(ed.customsExchangeRateToAED);
    if (fx) row.exchangeRateToAED = Number(fx) || 0;

    lineOverrides.push(row);
  }

  const docs = customs.documents || {};
  const payload = {
    receivedDate: trim(customs.receivedDate) || undefined,
    boeNumber: trim(customs.boeNumber),
    boeDate: trim(customs.boeDate) || undefined,
    blNumber: trim(customs.blNumber),
    awbNumber: trim(customs.awbNumber),
    supplierInvoiceNumber: trim(customs.supplierInvoiceNumber),
    supplierInvoiceDate: trim(customs.supplierInvoiceDate) || undefined,
    countryOfOrigin: trim(customs.countryOfOrigin),
    hsCode: trim(customs.hsCode),
    customsCurrency: headerCurrency.toUpperCase(),
    currency: headerCurrency.toUpperCase(),
    valuationMethod: "BOE_AVERAGE",
    boeDeclaredQty: trim(customs.boeDeclaredQty) ? Number(customs.boeDeclaredQty) : undefined,
    customsUom: trim(customs.customsUom) || "PCS",
    boeDeclaredValue: trim(customs.boeDeclaredValue) ? Number(customs.boeDeclaredValue) : undefined,
    grossWeightKg: trim(customs.grossWeightKg) ? Number(customs.grossWeightKg) : undefined,
    netWeightKg: trim(customs.netWeightKg) ? Number(customs.netWeightKg) : undefined,
    unitWeightKg: trim(customs.unitWeightKg || customs.weightKg)
      ? Number(customs.unitWeightKg || customs.weightKg)
      : undefined,
    exchangeRateToAED: trim(customs.exchangeRateToAED) ? Number(customs.exchangeRateToAED) : undefined,
    customsRemarks: trim(customs.customsRemarks || customs.remarks),
    remarks: trim(customs.customsRemarks || customs.remarks),
    allowBoeBeforePoDate: Boolean(customs.allowBoeBeforePoDate),
    allowInvoiceAfterReceivedDate: Boolean(customs.allowInvoiceAfterReceivedDate),
    allowFutureReceivedDate: Boolean(customs.allowFutureReceivedDate),
    documents: {
      blDocumentId: docs.blCopy?._id || null,
      supplierInvoiceDocumentId: docs.supplierInvoiceCopy?._id || null,
      packingListDocumentId: docs.packingListCopy?._id || null,
      otherDocumentIds: (docs.otherDocuments || []).map((d) => d?._id).filter(Boolean),
    },
  };

  if (lineOverrides.length) payload.lineOverrides = lineOverrides;

  return payload;
}

/** Default line edit fields for customs overrides. */
export function defaultGrnLineCustomsFields() {
  return {
    customsReceivedDate: "",
    customsBoeNumber: "",
    customsBoeDate: "",
    customsBlNumber: "",
    customsAwbNumber: "",
    customsSupplierInvoiceNumber: "",
    customsSupplierInvoiceDate: "",
    customsHsCode: "",
    customsCountryOfOrigin: "",
    customsQty: "",
    customsCurrency: "",
    customsUnitWeightKg: "",
    customsWeightKg: "",
    customsExchangeRateToAED: "",
    customsRemarks: "",
  };
}
