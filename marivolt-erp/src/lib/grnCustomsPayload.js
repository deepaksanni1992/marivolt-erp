/** Default empty customs capture state for GRN posting. */
export function emptyGrnCustomsState() {
  return {
    boeNumber: "",
    blNumber: "",
    awbNumber: "",
    supplierInvoiceNumber: "",
    supplierInvoiceDate: "",
    countryOfOrigin: "",
    hsCode: "",
    currency: "",
    unitPrice: "",
    weightKg: "",
    remarks: "",
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
    ed.customsHsCode,
    ed.customsCountryOfOrigin,
    ed.customsUnitPrice,
    ed.customsCurrency,
    ed.customsWeightKg,
  ].some((f) => trim(f));
}

/** True when user entered any optional customs field or uploaded a document. */
export function hasGrnCustomsInput(customs) {
  if (!customs || typeof customs !== "object") return false;
  const headerFields = [
    customs.boeNumber,
    customs.blNumber,
    customs.awbNumber,
    customs.supplierInvoiceNumber,
    customs.supplierInvoiceDate,
    customs.countryOfOrigin,
    customs.hsCode,
    customs.currency,
    customs.unitPrice,
    customs.weightKg,
    customs.remarks,
  ];
  if (headerFields.some((f) => trim(f))) return true;

  const docs = customs.documents || {};
  if (docs.blCopy?._id || docs.supplierInvoiceCopy?._id || docs.packingListCopy?._id) return true;
  if (Array.isArray(docs.otherDocuments) && docs.otherDocuments.some((d) => d?._id)) return true;
  return false;
}

/**
 * Build optional customs payload for POST /grn/post.
 * Returns null when no customs input — GRN behaves exactly as before.
 */
export function buildGrnCustomsPayload(customs, lineEdits, selectedLines, defaultCurrency = "USD") {
  if (!hasGrnCustomsInput(customs)) {
    const anyLineCustoms = (selectedLines || []).some((ln) => {
      const id = ln.poLineId != null ? String(ln.poLineId) : "";
      return hasLineCustomsFields(lineEdits[id]);
    });
    if (!anyLineCustoms) return null;
  }

  const headerCurrency = trim(customs.currency) || trim(defaultCurrency) || "USD";
  const lineOverrides = [];

  for (const ln of selectedLines || []) {
    const id = ln.poLineId != null ? String(ln.poLineId) : "";
    const ed = lineEdits[id] || {};
    if (!hasLineCustomsFields(ed)) continue;

    const row = { poLineId: ln.poLineId };
    const hsCode = trim(ed.customsHsCode);
    const countryOfOrigin = trim(ed.customsCountryOfOrigin);
    const unitPrice = trim(ed.customsUnitPrice);
    const currency = trim(ed.customsCurrency);
    const weightKg = trim(ed.customsWeightKg);

    if (hsCode) row.hsCode = hsCode;
    if (countryOfOrigin) row.countryOfOrigin = countryOfOrigin;
    if (unitPrice) row.unitPrice = Number(unitPrice) || 0;
    if (currency) row.currency = currency.toUpperCase();
    if (weightKg) row.weightKg = Number(weightKg) || 0;
    lineOverrides.push(row);
  }

  const docs = customs.documents || {};
  const payload = {
    boeNumber: trim(customs.boeNumber),
    blNumber: trim(customs.blNumber),
    awbNumber: trim(customs.awbNumber),
    supplierInvoiceNumber: trim(customs.supplierInvoiceNumber),
    supplierInvoiceDate: trim(customs.supplierInvoiceDate) || undefined,
    countryOfOrigin: trim(customs.countryOfOrigin),
    hsCode: trim(customs.hsCode),
    currency: headerCurrency.toUpperCase(),
    unitPrice: trim(customs.unitPrice) ? Number(customs.unitPrice) : undefined,
    weightKg: trim(customs.weightKg) ? Number(customs.weightKg) : undefined,
    remarks: trim(customs.remarks),
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

/** Default line edit fields for customs tagging. */
export function defaultGrnLineCustomsFields() {
  return {
    customsHsCode: "",
    customsCountryOfOrigin: "",
    customsUnitPrice: "",
    customsCurrency: "",
    customsWeightKg: "",
  };
}
