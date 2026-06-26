/**
 * Canonical document type keys for the Enterprise Document Snapshot Engine.
 * Used by copyDocument(), document chain navigation, and source metadata.
 */
export const DOC_TYPES = Object.freeze({
  QUOTATION: "QUOTATION",
  ORDER_ACKNOWLEDGEMENT: "ORDER_ACKNOWLEDGEMENT",
  PROFORMA_INVOICE: "PROFORMA_INVOICE",
  ORDER_ALLOCATION: "ORDER_ALLOCATION",
  STORE_PACKING: "STORE_PACKING",
  SALES_INVOICE: "SALES_INVOICE",
  STORE_DISPATCH: "STORE_DISPATCH",
  SALES_RETURN: "SALES_RETURN",
  CIPL: "CIPL",
});

/** Route key: `${sourceType}:${destinationType}` */
export function copyRouteKey(sourceType, destinationType) {
  return `${String(sourceType || "").toUpperCase()}:${String(destinationType || "").toUpperCase()}`;
}

/** Normalize aliases (e.g. "oa", "quotation") to canonical DOC_TYPES values. */
export function normalizeDocumentType(raw) {
  const s = String(raw || "")
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, "_");
  const aliases = {
    QTN: DOC_TYPES.QUOTATION,
    QUOTATION: DOC_TYPES.QUOTATION,
    OA: DOC_TYPES.ORDER_ACKNOWLEDGEMENT,
    ORDER_ACK: DOC_TYPES.ORDER_ACKNOWLEDGEMENT,
    ORDER_ACKNOWLEDGEMENT: DOC_TYPES.ORDER_ACKNOWLEDGEMENT,
    PI: DOC_TYPES.PROFORMA_INVOICE,
    PROFORMA: DOC_TYPES.PROFORMA_INVOICE,
    PROFORMA_INVOICE: DOC_TYPES.PROFORMA_INVOICE,
    ALLOCATION: DOC_TYPES.ORDER_ALLOCATION,
    ORDER_ALLOCATION: DOC_TYPES.ORDER_ALLOCATION,
    PACKING: DOC_TYPES.STORE_PACKING,
    STORE_PACKING: DOC_TYPES.STORE_PACKING,
    INVOICE: DOC_TYPES.SALES_INVOICE,
    SALES_INVOICE: DOC_TYPES.SALES_INVOICE,
    SI: DOC_TYPES.SALES_INVOICE,
    DISPATCH: DOC_TYPES.STORE_DISPATCH,
    STORE_DISPATCH: DOC_TYPES.STORE_DISPATCH,
    SALES_RETURN: DOC_TYPES.SALES_RETURN,
    SR: DOC_TYPES.SALES_RETURN,
    CIPL: DOC_TYPES.CIPL,
  };
  return aliases[s] || s;
}
