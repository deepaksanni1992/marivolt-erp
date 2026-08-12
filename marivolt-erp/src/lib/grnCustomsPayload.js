/** Default empty customs capture state for GRN posting (BOE_AVERAGE). */
export function emptyGrnCustomsState() {
  return {
    boeMode: "CREATE",
    customsBoeId: "",
    customsBoeRef: "",
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

/**
 * Customs capture is active only when the user entered meaningful Customs data.
 * Auto-filled Received Date and default Customs UOM PCS do not activate capture.
 */
export function isCustomsCaptureActive({ header = {}, lineOverrides = [], documents = null } = {}) {
  const h = header && typeof header === "object" ? header : {};
  const headerKeys = [
    "customsBoeId",
    "customsBoeRef",
    "boeNumber",
    "boeDate",
    "blNumber",
    "awbNumber",
    "supplierInvoiceNumber",
    "supplierInvoiceDate",
    "countryOfOrigin",
    "hsCode",
    "customsCurrency",
    "currency",
    "exchangeRateToAED",
    "boeDeclaredQty",
    "boeDeclaredValue",
    "grossWeightKg",
    "netWeightKg",
    "unitWeightKg",
    "weightKg",
    "customsRemarks",
    "remarks",
  ];
  for (const key of headerKeys) {
    if (trim(h[key])) return true;
  }
  const uom = trim(h.customsUom).toUpperCase();
  if (uom && uom !== "PCS") return true;

  const docs = documents || h.documents || {};
  if (docs.blCopy?._id || docs.blDocumentId || docs.supplierInvoiceCopy?._id || docs.supplierInvoiceDocumentId) {
    return true;
  }
  if (docs.packingListCopy?._id || docs.packingListDocumentId) return true;
  const others = docs.otherDocuments || docs.otherDocumentIds || [];
  if (Array.isArray(others) && others.some((d) => d && (d._id || d))) return true;

  const rows = Array.isArray(lineOverrides)
    ? lineOverrides
    : lineOverrides instanceof Map
      ? [...lineOverrides.values()]
      : [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    if (hasLineCustomsFields(row)) return true;
    if (
      [
        row.hsCode,
        row.countryOfOrigin,
        row.customsQty,
        row.boeNumber,
        row.customsCurrency,
        row.exchangeRateToAED,
      ].some((f) => trim(f))
    ) {
      return true;
    }
  }
  return false;
}

/** True when user entered meaningful customs fields or uploaded a document. */
export function hasGrnCustomsInput(customs, lineEdits = null, selectedLines = null) {
  if (!customs || typeof customs !== "object") return false;
  const lineOverrides = [];
  if (lineEdits && selectedLines) {
    for (const ln of selectedLines) {
      const id = ln.poLineId != null ? String(ln.poLineId) : "";
      if (id) lineOverrides.push(lineEdits[id] || {});
    }
  }
  return isCustomsCaptureActive({ header: customs, lineOverrides, documents: customs.documents });
}

export function formatGrnCustomsValidationDisplay({ headerErrors = [], lineErrors = [] } = {}) {
  const parts = [];
  if (headerErrors.length) {
    parts.push("CUSTOMS INFORMATION INCOMPLETE");
    parts.push(...headerErrors.map((m) => `• ${m}`));
  }
  if (lineErrors.length) {
    if (parts.length) parts.push("");
    parts.push("ARTICLE ISSUES");
    parts.push(...lineErrors.map((m) => `• ${m}`));
  }
  return parts.join("\n");
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
  if (!hasGrnCustomsInput(customs, lineEdits, selectedLines)) {
    return null;
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
    boeMode: trim(customs.boeMode) === "SELECT" || trim(customs.customsBoeId) || trim(customs.customsBoeRef)
      ? "SELECT"
      : "CREATE",
    customsBoeId: trim(customs.customsBoeId) || undefined,
    customsBoeRef: trim(customs.customsBoeRef) || undefined,
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
