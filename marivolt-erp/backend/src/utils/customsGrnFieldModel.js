/**
 * Canonical Customs GRN field model (revised + BOE_AVERAGE).
 *
 * NEW posts: BOE Declared Value / BOE Declared Qty → frozen customsUnitValue.
 * Client-supplied customsUnitPrice / customsUnitValue are ignored for BOE_AVERAGE.
 * Legacy line-priced records remain readable without mass migration.
 */

import {
  CUSTOMS_VALUATION_BOE_AVERAGE,
  CUSTOMS_VALUATION_LEGACY_LINE,
  computeBoeCustomsUnitValue,
  resolveLineCustomsQuantities,
  allocateBoeLineValues,
  roundCustomsMoney,
  roundCustomsQty,
} from "./customsBoeAverage.js";

export const CUSTOMS_GRN_HEADER_FIELDS = [
  "receivedDate",
  "boeNumber",
  "boeDate",
  "blNumber",
  "awbNumber",
  "supplierInvoiceNumber",
  "supplierInvoiceDate",
  "countryOfOrigin",
  "hsCode",
  "unitWeightKg",
  "customsUnitPrice",
  "customsCurrency",
  "exchangeRateToAED",
  "customsRemarks",
  "boeDeclaredQty",
  "customsUom",
  "boeDeclaredValue",
  "grossWeightKg",
  "netWeightKg",
  "valuationMethod",
  "customsBoeId",
  "customsBoeRef",
  "boeMode",
];

/** Line may override metadata; customsQty used for non-1:1 UOM mapping. */
export const CUSTOMS_GRN_LINE_FIELDS = [
  ...CUSTOMS_GRN_HEADER_FIELDS,
  "totalWeightKg",
  "customsTotalPrice",
  "customsValueAED",
  "customsQty",
];

/** Mandatory metadata when customs capture is active. Unit price is NOT required for BOE_AVERAGE. */
export const CUSTOMS_GRN_MANDATORY_EFFECTIVE = [
  "receivedDate",
  "boeNumber",
  "boeDate",
  "supplierInvoiceNumber",
  "supplierInvoiceDate",
  "customsCurrency",
  "exchangeRateToAED",
  "countryOfOrigin",
  "hsCode",
];

/** Shipment/BOE fields validated once at header (not per article row). */
export const CUSTOMS_HEADER_REQUIRED_ONCE = [
  "receivedDate",
  "boeNumber",
  "boeDate",
  "supplierInvoiceNumber",
  "supplierInvoiceDate",
  "customsCurrency",
  "exchangeRateToAED",
  "boeDeclaredQty",
  "boeDeclaredValue",
];

/** Defaultable article fields — validated on effective (header fallback) values only. */
export const CUSTOMS_LINE_REQUIRED_EFFECTIVE = ["countryOfOrigin", "hsCode"];

export const CUSTOMS_BOE_MANDATORY_HEADER = [
  "boeDeclaredQty",
  "boeDeclaredValue",
  "customsCurrency",
];

/** Fields that mean the user intentionally started Customs capture. receivedDate alone does not. */
const CUSTOMS_ACTIVATION_HEADER_KEYS = [
  "boeNumber",
  "boeDate",
  "blNumber",
  "awbNumber",
  "supplierInvoiceNumber",
  "supplierInvoiceDate",
  "countryOfOrigin",
  "hsCode",
  "customsCurrency",
  "exchangeRateToAED",
  "boeDeclaredQty",
  "boeDeclaredValue",
  "grossWeightKg",
  "netWeightKg",
  "unitWeightKg",
  "customsRemarks",
  "customsBoeId",
  "customsBoeRef",
];

const CUSTOMS_ACTIVATION_LINE_KEYS = [
  "boeNumber",
  "boeDate",
  "blNumber",
  "awbNumber",
  "supplierInvoiceNumber",
  "supplierInvoiceDate",
  "countryOfOrigin",
  "hsCode",
  "customsCurrency",
  "exchangeRateToAED",
  "customsQty",
  "unitWeightKg",
  "customsRemarks",
];

function t(v) {
  return String(v ?? "").trim();
}

function upper(v) {
  return t(v).toUpperCase();
}

export function parseCustomsDate(value) {
  if (value == null || value === "") return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  const s = t(value);
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const [y, m, d] = s.split("-").map(Number);
    const dt = new Date(y, m - 1, d, 12, 0, 0, 0);
    return Number.isNaN(dt.getTime()) ? null : dt;
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

function startOfLocalDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function isFutureDate(d, now = new Date()) {
  if (!d) return false;
  return startOfLocalDay(d).getTime() > startOfLocalDay(now).getTime();
}

function isBeforeDate(a, b) {
  if (!a || !b) return false;
  return startOfLocalDay(a).getTime() < startOfLocalDay(b).getTime();
}

function isAfterDate(a, b) {
  if (!a || !b) return false;
  return startOfLocalDay(a).getTime() > startOfLocalDay(b).getTime();
}

function hasOwnOverride(override, key) {
  if (!override || typeof override !== "object") return false;
  if (!Object.prototype.hasOwnProperty.call(override, key)) return false;
  const v = override[key];
  if (v == null) return false;
  if (typeof v === "string" && !t(v)) return false;
  return true;
}

function pickNum(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function isMeaningfulCustomsUom(raw) {
  const u = upper(raw);
  return Boolean(u) && u !== "PCS";
}

/**
 * Customs capture is active only when the user entered meaningful Customs data.
 * Auto-filled Received Date and default Customs UOM PCS do not activate capture.
 */
export function isCustomsCaptureActive({ header = {}, lineOverrides = [], documents = null } = {}) {
  const h = header && typeof header === "object" ? header : {};
  for (const key of CUSTOMS_ACTIVATION_HEADER_KEYS) {
    const v = h[key];
    if (v == null || v === "") continue;
    if (typeof v === "number" && Number.isFinite(v)) return true;
    if (t(v)) return true;
  }
  if (isMeaningfulCustomsUom(h.customsUom)) return true;

  const docs = documents || h.documents;
  if (docs && typeof docs === "object") {
    if (docs.blCopy?._id || docs.blDocumentId || docs.supplierInvoiceCopy?._id || docs.supplierInvoiceDocumentId) {
      return true;
    }
    if (docs.packingListCopy?._id || docs.packingListDocumentId) return true;
    const others = docs.otherDocuments || docs.otherDocumentIds || [];
    if (Array.isArray(others) && others.some((d) => d && (d._id || d))) return true;
  }

  const rows = Array.isArray(lineOverrides)
    ? lineOverrides
    : lineOverrides instanceof Map
      ? [...lineOverrides.values()]
      : [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    for (const key of CUSTOMS_ACTIVATION_LINE_KEYS) {
      const v = row[key];
      if (v == null || v === "") continue;
      if (typeof v === "number" && Number.isFinite(v)) return true;
      if (t(v)) return true;
    }
  }
  return false;
}

export function formatCustomsCaptureErrorGroups(errors = []) {
  const header = [];
  const articles = [];
  for (const e of errors || []) {
    const msgs = e.messages || [];
    if (!msgs.length) continue;
    if (e.line === "HEADER" || e.group === "header") {
      header.push(...msgs);
      continue;
    }
    const label = e.article ? String(e.article) : e.line != null ? `Row ${e.line}` : "Line";
    for (const m of msgs) articles.push(`${label}: ${m}`);
  }
  return { header, articles };
}

export function formatCustomsCaptureErrorText(errors = []) {
  const { header, articles } = formatCustomsCaptureErrorGroups(errors);
  const parts = [];
  if (header.length) {
    parts.push("CUSTOMS INFORMATION INCOMPLETE");
    parts.push(...header.map((m) => `• ${m}`));
  }
  if (articles.length) {
    if (parts.length) parts.push("");
    parts.push("ARTICLE ISSUES");
    parts.push(...articles.map((m) => `• ${m}`));
  }
  return parts.join("\n");
}

/**
 * New GRN customs capture uses BOE_AVERAGE when declared qty+value are present.
 * Legacy unit-price-only payloads are rejected for new posts (clear message).
 */
export function detectCustomsValuationMode(header = {}) {
  const declaredQty = pickNum(header.boeDeclaredQty);
  const declaredValue = pickNum(header.boeDeclaredValue);
  const method = upper(header.valuationMethod);
  if (method === CUSTOMS_VALUATION_BOE_AVERAGE) return CUSTOMS_VALUATION_BOE_AVERAGE;
  if (declaredQty != null && declaredQty > 0 && declaredValue != null && declaredValue >= 0) {
    return CUSTOMS_VALUATION_BOE_AVERAGE;
  }
  if (method === CUSTOMS_VALUATION_LEGACY_LINE) return CUSTOMS_VALUATION_LEGACY_LINE;
  const legacyPrice = pickNum(header.customsUnitPrice ?? header.unitPrice);
  if (legacyPrice != null && legacyPrice > 0) return "LEGACY_REJECTED";
  return CUSTOMS_VALUATION_BOE_AVERAGE;
}

/**
 * Resolve effective customs metadata for one GRN line (HS/COO/dates/weight).
 * For BOE_AVERAGE, unit value is injected by the BOE resolver — not from line/header price.
 */
export function resolveCustomsLineEffective({
  header = {},
  override = {},
  quantity = 0,
  allowances = {},
  customsUnitValue = null,
  customsQty = null,
  valuationMethod = CUSTOMS_VALUATION_BOE_AVERAGE,
} = {}) {
  const qty = Math.max(0, Number(quantity) || 0);

  const pick = (key, { upperCase = false, numeric = false } = {}) => {
    if (hasOwnOverride(override, key)) {
      const raw = override[key];
      if (numeric) return pickNum(raw);
      return upperCase ? upper(raw) : t(raw);
    }
    if (hasOwnOverride(header, key)) {
      const raw = header[key];
      if (numeric) return pickNum(raw);
      return upperCase ? upper(raw) : t(raw);
    }
    if (numeric) return null;
    return "";
  };

  const pickDate = (key) => {
    if (hasOwnOverride(override, key)) return parseCustomsDate(override[key]);
    if (hasOwnOverride(header, key)) return parseCustomsDate(header[key]);
    return null;
  };

  const unitWeightKg = pick("unitWeightKg", { numeric: true }) ?? 0;
  let customsCurrency = pick("customsCurrency", { upperCase: true });
  let exchangeRateToAED = pick("exchangeRateToAED", { numeric: true });

  if (customsCurrency === "AED") {
    exchangeRateToAED = 1;
  }

  const rate =
    exchangeRateToAED == null || !(Number(exchangeRateToAED) > 0) ? null : Number(exchangeRateToAED);

  const computedTotalWeight = qty > 0 && unitWeightKg > 0 ? qty * unitWeightKg : 0;
  let totalWeightKg = computedTotalWeight;
  if (
    allowances.allowTotalWeightOverride &&
    hasOwnOverride(override, "totalWeightKg") &&
    pickNum(override.totalWeightKg) != null
  ) {
    totalWeightKg = pickNum(override.totalWeightKg);
  }

  const method = upper(valuationMethod) || CUSTOMS_VALUATION_BOE_AVERAGE;
  let unitPrice = 0;
  if (method === CUSTOMS_VALUATION_BOE_AVERAGE) {
    unitPrice = Number(customsUnitValue) || 0;
  } else {
    unitPrice = pick("customsUnitPrice", { numeric: true }) ?? 0;
  }

  const cQty = customsQty != null ? roundCustomsQty(customsQty) : roundCustomsQty(qty);
  const customsTotalPrice = roundCustomsMoney(cQty * unitPrice);
  const customsValueAED = rate != null ? roundCustomsMoney(customsTotalPrice * rate) : 0;

  return {
    receivedDate: pickDate("receivedDate"),
    boeNumber: pick("boeNumber"),
    boeDate: pickDate("boeDate"),
    blNumber: pick("blNumber"),
    awbNumber: pick("awbNumber"),
    supplierInvoiceNumber: pick("supplierInvoiceNumber"),
    supplierInvoiceDate: pickDate("supplierInvoiceDate"),
    countryOfOrigin: pick("countryOfOrigin", { upperCase: true }),
    hsCode: pick("hsCode", { upperCase: true }),
    unitWeightKg,
    totalWeightKg: Number(totalWeightKg) || 0,
    customsUnitPrice: unitPrice,
    customsUnitValue: unitPrice,
    customsTotalPrice,
    customsCurrency,
    exchangeRateToAED: rate,
    customsValueAED,
    customsRemarks: pick("customsRemarks"),
    quantity: qty,
    customsQty: cQty,
    valuationMethod: method,
    boeDeclaredQty: pickNum(header.boeDeclaredQty) ?? 0,
    boeDeclaredValue: pickNum(header.boeDeclaredValue) ?? 0,
    customsUom: upper(header.customsUom || "PCS") || "PCS",
  };
}

export function validateCustomsMandatoryEffective(effective, { location = "" } = {}) {
  const errors = [];
  const label = {
    receivedDate: "Received Date",
    boeNumber: "BOE Number",
    boeDate: "BOE Date",
    supplierInvoiceNumber: "Supplier Invoice Number",
    supplierInvoiceDate: "Supplier Invoice Date",
    customsCurrency: "Customs Currency",
    exchangeRateToAED: "Exchange Rate to AED",
    countryOfOrigin: "Country of Origin",
    hsCode: "HS Code",
  };

  for (const key of CUSTOMS_GRN_MANDATORY_EFFECTIVE) {
    const v = effective[key];
    if (key.endsWith("Date")) {
      if (!v) errors.push(`${label[key]} is required`);
      continue;
    }
    if (key === "exchangeRateToAED") {
      if (v == null || !(Number(v) > 0)) errors.push(`${label[key]} is required and must be greater than zero`);
      continue;
    }
    if (!t(v)) errors.push(`${label[key]} is required`);
  }

  if (upper(effective.customsCurrency) === "AED" && Number(effective.exchangeRateToAED) !== 1) {
    errors.push("When Customs Currency is AED, Exchange Rate to AED must be 1");
  }

  if (!t(location)) errors.push("Location is required");
  if (!(Number(effective.quantity) > 0)) errors.push("Quantity is required and must be greater than zero");

  return errors;
}

/** Header-level required fields — one error per missing BOE/shipment value. */
export function validateCustomsHeaderRequired(header = {}, { existingBoe = false } = {}) {
  const errors = [];
  const received = parseCustomsDate(header.receivedDate);
  if (!received) errors.push("Received Date is required");
  if (!t(header.boeNumber)) errors.push("BOE Number is required");
  if (!parseCustomsDate(header.boeDate)) errors.push("BOE Date is required");
  if (!t(header.supplierInvoiceNumber)) errors.push("Supplier Invoice Number is required");
  if (!parseCustomsDate(header.supplierInvoiceDate)) errors.push("Supplier Invoice Date is required");
  if (!existingBoe) {
    const declaredQty = pickNum(header.boeDeclaredQty);
    if (declaredQty == null || !(declaredQty > 0)) {
      errors.push("BOE Declared Qty is required");
    }
    const declaredValue = pickNum(header.boeDeclaredValue);
    if (declaredValue == null || declaredValue < 0) {
      errors.push("BOE Declared Value is required");
    }
  }
  if (!t(header.customsCurrency)) errors.push("Customs Currency is required");
  const fx = pickNum(header.exchangeRateToAED);
  const currency = upper(header.customsCurrency);
  if (currency === "AED") {
    if (fx != null && fx !== 1) {
      errors.push("When Customs Currency is AED, Exchange Rate to AED must be 1");
    }
  } else if (fx == null || !(fx > 0)) {
    errors.push("Exchange Rate to AED is required");
  }
  return errors;
}

export function validateCustomsLineEffectiveOnly(effective, { location = "" } = {}) {
  const errors = [];
  if (!t(effective?.countryOfOrigin)) errors.push("Country of Origin is required");
  if (!t(effective?.hsCode)) errors.push("HS Code is required");
  if (!t(location)) errors.push("Location is required");
  if (!(Number(effective?.quantity) > 0)) errors.push("Quantity is required and must be greater than zero");
  return errors;
}

export function resolveCustomsAllowances({ requested = {}, permissionGranted = false } = {}) {
  const grant = Boolean(permissionGranted);
  return {
    allowBoeBeforePoDate: grant && Boolean(requested.allowBoeBeforePoDate),
    allowInvoiceAfterReceivedDate: grant && Boolean(requested.allowInvoiceAfterReceivedDate),
    allowFutureReceivedDate: grant && Boolean(requested.allowFutureReceivedDate),
    allowTotalWeightOverride: grant && Boolean(requested.allowTotalWeightOverride),
  };
}

export function validateCustomsDates(effective, { poDate = null, allowances = {} } = {}) {
  const errors = [];
  const po = parseCustomsDate(poDate);
  const received = effective.receivedDate;
  const boe = effective.boeDate;
  const invoice = effective.supplierInvoiceDate;

  if (boe) {
    if (isFutureDate(boe)) errors.push("BOE Date cannot be in the future");
    if (po && isBeforeDate(boe, po) && !allowances.allowBoeBeforePoDate) {
      errors.push("BOE Date cannot be earlier than PO date unless explicitly authorised");
    }
  }

  if (invoice) {
    if (isFutureDate(invoice)) errors.push("Supplier Invoice Date cannot be in the future");
    if (received && isAfterDate(invoice, received) && !allowances.allowInvoiceAfterReceivedDate) {
      errors.push(
        "Supplier Invoice Date cannot be later than Received Date unless override permission exists"
      );
    }
  }

  if (received) {
    if (po && isBeforeDate(received, po)) {
      errors.push("Received Date cannot be earlier than PO date");
    }
    if (isFutureDate(received) && !allowances.allowFutureReceivedDate) {
      errors.push("Received Date cannot be in the future unless future GRN is explicitly supported");
    }
  }

  return errors;
}

export function normalizeCustomsHeaderDefaults(raw = {}) {
  const c = raw?.customs && typeof raw.customs === "object" ? raw.customs : raw;
  return {
    receivedDate: c.receivedDate ?? c.ReceivedDate ?? "",
    boeNumber: t(c.boeNumber ?? c.BOENumber),
    boeDate: c.boeDate ?? c.BOEDate ?? "",
    blNumber: t(c.blNumber ?? c.BLNumber),
    awbNumber: t(c.awbNumber ?? c.AWBNumber),
    supplierInvoiceNumber: t(c.supplierInvoiceNumber ?? c.SupplierInvoiceNumber ?? c.supplierInvoiceNo),
    supplierInvoiceDate: c.supplierInvoiceDate ?? c.SupplierInvoiceDate ?? "",
    countryOfOrigin: t(c.countryOfOrigin ?? c.CountryOfOrigin),
    hsCode: t(c.hsCode ?? c.HSCode),
    unitWeightKg: c.unitWeightKg ?? c.UnitWeightKg ?? c.weightKg ?? "",
    // Legacy aliases retained for detection only — ignored for BOE_AVERAGE unit value.
    customsUnitPrice: c.customsUnitPrice ?? c.CustomsUnitPrice ?? c.unitPrice ?? "",
    customsCurrency: t(c.customsCurrency ?? c.CustomsCurrency ?? c.currency),
    exchangeRateToAED: c.exchangeRateToAED ?? c.ExchangeRateToAED ?? "",
    customsRemarks: t(c.customsRemarks ?? c.CustomsRemarks ?? c.remarks),
    boeDeclaredQty: c.boeDeclaredQty ?? c.BOEDeclaredQty ?? "",
    customsUom: t(c.customsUom ?? c.CustomsUom ?? c.customsUOM),
    boeDeclaredValue: c.boeDeclaredValue ?? c.BOEDeclaredValue ?? c.customsDeclaredValue ?? "",
    grossWeightKg: c.grossWeightKg ?? c.GrossWeightKg ?? "",
    netWeightKg: c.netWeightKg ?? c.NetWeightKg ?? "",
    valuationMethod: t(c.valuationMethod ?? c.ValuationMethod),
    customsBoeId: t(c.customsBoeId ?? c.CustomsBoeId),
    customsBoeRef: t(c.customsBoeRef ?? c.CustomsBoeRef),
    boeMode: t(c.boeMode ?? c.BoeMode),
    // Spoof attempts — never used as source of truth
    customsUnitValue: c.customsUnitValue ?? c.CustomsUnitValue ?? "",
  };
}

export function normalizeCustomsLineOverride(row = {}) {
  const o = {};
  const map = {
    receivedDate: ["receivedDate", "ReceivedDate"],
    boeNumber: ["boeNumber", "BOENumber"],
    boeDate: ["boeDate", "BOEDate"],
    blNumber: ["blNumber", "BLNumber"],
    awbNumber: ["awbNumber", "AWBNumber"],
    supplierInvoiceNumber: ["supplierInvoiceNumber", "SupplierInvoiceNumber"],
    supplierInvoiceDate: ["supplierInvoiceDate", "SupplierInvoiceDate"],
    countryOfOrigin: ["countryOfOrigin", "CountryOfOrigin"],
    hsCode: ["hsCode", "HSCode"],
    unitWeightKg: ["unitWeightKg", "UnitWeightKg", "weightKg"],
    totalWeightKg: ["totalWeightKg", "TotalWeightKg"],
    customsUnitPrice: ["customsUnitPrice", "CustomsUnitPrice", "unitPrice"],
    customsTotalPrice: ["customsTotalPrice", "CustomsTotalPrice"],
    customsCurrency: ["customsCurrency", "CustomsCurrency", "currency"],
    exchangeRateToAED: ["exchangeRateToAED", "ExchangeRateToAED"],
    customsValueAED: ["customsValueAED", "CustomsValueAED"],
    customsRemarks: ["customsRemarks", "CustomsRemarks", "remarks"],
    customsQty: ["customsQty", "CustomsQty", "boeLineQty"],
  };
  for (const [canon, aliases] of Object.entries(map)) {
    for (const a of aliases) {
      if (Object.prototype.hasOwnProperty.call(row, a) && row[a] != null && row[a] !== "") {
        o[canon] = row[a];
        break;
      }
    }
  }
  return o;
}

export function buildLineOverrideMap(customs = {}) {
  const map = new Map();
  for (const row of customs.lineOverrides || []) {
    const key = String(row?.poLineId ?? row?.grnLineId ?? "");
    if (!key) continue;
    map.set(key, normalizeCustomsLineOverride(row));
  }
  return map;
}

/**
 * Validate customs capture for GRN (BOE_AVERAGE authoritative for new posts).
 * @param {{ parentBoe?: object|null, maxLinkQty?: number|null }} [opts]
 *   parentBoe — when selecting existing BOE, server-loaded economics (client values ignored)
 *   maxLinkQty — remaining qty allowed for this GRN (defaults to declared qty)
 */
export function validateCustomsCaptureForGrn({
  header = {},
  lineOverrides = new Map(),
  lines = [],
  poDate = null,
  allowances = {},
  parentBoe = null,
  maxLinkQty = null,
} = {}) {
  let headerNorm = normalizeCustomsHeaderDefaults(header);
  const errors = [];
  const existingBoe = Boolean(parentBoe);

  if (parentBoe) {
    // Never trust client BOE economics when linking to an existing parent.
    const clientDeclaredQty = pickNum(headerNorm.boeDeclaredQty);
    const clientDeclaredValue = pickNum(headerNorm.boeDeclaredValue);
    const clientUnit = pickNum(headerNorm.customsUnitValue);
    const parentUnit = Number(parentBoe.customsUnitValue) || 0;
    const parentQty = Number(parentBoe.boeDeclaredQty) || 0;
    const parentValue = Number(parentBoe.boeDeclaredValue) || 0;
    if (
      clientDeclaredQty != null &&
      Math.abs(clientDeclaredQty - parentQty) > 1e-6
    ) {
      errors.push({
        line: "HEADER",
        article: "",
        group: "header",
        messages: [
          `Cannot override BOE Declared Qty for existing BOE ${parentBoe.customsBoeRef || ""}. Parent has ${parentQty}.`,
        ],
      });
    }
    if (
      clientDeclaredValue != null &&
      Math.abs(clientDeclaredValue - parentValue) > 1e-6
    ) {
      errors.push({
        line: "HEADER",
        article: "",
        group: "header",
        messages: [
          `Cannot override BOE Declared Value for existing BOE ${parentBoe.customsBoeRef || ""}. Parent has ${parentValue}.`,
        ],
      });
    }
    if (clientUnit != null && Math.abs(clientUnit - parentUnit) > 1e-6) {
      errors.push({
        line: "HEADER",
        article: "",
        group: "header",
        messages: [`Cannot override frozen Customs Unit Value for existing BOE (${parentUnit}).`],
      });
    }
    headerNorm = {
      ...headerNorm,
      boeNumber: parentBoe.boeNumber || headerNorm.boeNumber,
      boeDate: parentBoe.boeDate || headerNorm.boeDate,
      blNumber: parentBoe.blNumber || headerNorm.blNumber,
      awbNumber: parentBoe.awbNumber || headerNorm.awbNumber,
      boeDeclaredQty: parentBoe.boeDeclaredQty,
      boeDeclaredValue: parentBoe.boeDeclaredValue,
      customsUom: parentBoe.customsUom || headerNorm.customsUom || "PCS",
      customsCurrency: parentBoe.customsCurrency || headerNorm.customsCurrency,
      exchangeRateToAED: parentBoe.exchangeRateToAED,
      grossWeightKg: parentBoe.grossWeightKg,
      netWeightKg: parentBoe.netWeightKg,
      valuationMethod: CUSTOMS_VALUATION_BOE_AVERAGE,
      customsBoeId: String(parentBoe._id || headerNorm.customsBoeId || ""),
      customsBoeRef: parentBoe.customsBoeRef || headerNorm.customsBoeRef,
    };
  }

  const mode = detectCustomsValuationMode(headerNorm);

  if (mode === "LEGACY_REJECTED") {
    return {
      ok: false,
      errors: [
        {
          line: "HEADER",
          article: "",
          messages: [
            "Manual Customs Unit Price is no longer accepted. Provide BOE Declared Customs Qty and BOE Declared Value; the system calculates BOE Customs Unit Value.",
          ],
        },
      ],
      valuationMethod: CUSTOMS_VALUATION_BOE_AVERAGE,
    };
  }

  const declaredQty = pickNum(headerNorm.boeDeclaredQty);
  const declaredValue = pickNum(headerNorm.boeDeclaredValue);
  const headerMsgs = validateCustomsHeaderRequired(headerNorm, { existingBoe });
  if (headerMsgs.length) {
    errors.push({ line: "HEADER", article: "", group: "header", messages: headerMsgs });
  }

  const unitCalc = existingBoe
    ? {
        ok: true,
        customsUnitValue: Number(parentBoe.customsUnitValue) || 0,
      }
    : computeBoeCustomsUnitValue(declaredValue ?? 0, declaredQty ?? 0);
  if (!unitCalc.ok && declaredQty > 0 && declaredValue != null) {
    errors.push({ line: "HEADER", article: "", messages: [unitCalc.message] });
  }

  const activeLines = (lines || []).filter(
    (ln) => (Number(ln.acceptedQty ?? ln.receivedQty ?? ln.quantity ?? ln.grnQty) || 0) > 0
  );

  const qtyLines = activeLines.map((ln) => {
    const key = String(ln.poLineId ?? ln._id ?? "");
    const override = lineOverrides.get(key) || normalizeCustomsLineOverride(ln.customsOverride || {});
    return {
      poLineId: ln.poLineId ?? ln._id,
      article: ln.article,
      acceptedQty: ln.acceptedQty ?? ln.receivedQty ?? ln.quantity ?? ln.grnQty,
      uom: ln.uom || "PCS",
      customsQty: override.customsQty,
      location: ln.location,
      override,
    };
  });

  const linkCap =
    maxLinkQty != null
      ? maxLinkQty
      : existingBoe
        ? roundCustomsQty(
            Math.max(0, Number(parentBoe.boeDeclaredQty) - Number(parentBoe.linkedCustomsQty || 0)),
          )
        : declaredQty;

  const qtyResolve = resolveLineCustomsQuantities({
    lines: qtyLines,
    boeDeclaredQty: declaredQty,
    customsUom: headerNorm.customsUom || "PCS",
    maxLinkQty: linkCap,
  });
  if (!qtyResolve.ok) {
    errors.push({ line: "HEADER", article: "", group: "header", messages: [qtyResolve.message] });
  }

  const headerDateProbe = resolveCustomsLineEffective({
    header: headerNorm,
    override: {},
    quantity: 1,
    allowances,
    customsUnitValue: unitCalc.ok ? unitCalc.customsUnitValue : 0,
    valuationMethod: CUSTOMS_VALUATION_BOE_AVERAGE,
  });
  const headerDateMsgs = validateCustomsDates(headerDateProbe, { poDate, allowances });
  if (headerDateMsgs.length) {
    errors.push({ line: "HEADER", article: "", group: "header", messages: headerDateMsgs });
  }

  const customsUnitValue = unitCalc.ok ? unitCalc.customsUnitValue : 0;
  const valueLines = allocateBoeLineValues({
    lines: (qtyResolve.lines || []).map((r) => ({ ...r, customsQty: r.customsQty })),
    boeDeclaredValue: declaredValue,
    boeDeclaredQty: declaredQty,
    customsUnitValue,
  });
  const valueByKey = new Map(valueLines.map((r) => [String(r.key || r.poLineId || r.article), r]));

  for (const line of activeLines) {
    const key = String(line.poLineId ?? line._id ?? "");
    const override = lineOverrides.get(key) || {};
    const mapped = valueByKey.get(key) || valueByKey.get(String(line.article || ""));
    const effective = resolveCustomsLineEffective({
      header: headerNorm,
      override,
      quantity: Number(line.acceptedQty ?? line.receivedQty) || 0,
      allowances,
      customsUnitValue,
      customsQty: mapped?.customsQty,
      valuationMethod: CUSTOMS_VALUATION_BOE_AVERAGE,
    });
    if (mapped) {
      effective.customsTotalPrice = mapped.customsTotalPrice;
      effective.customsQty = mapped.customsQty;
      const rate = effective.exchangeRateToAED;
      effective.customsValueAED =
        rate != null ? roundCustomsMoney(effective.customsTotalPrice * rate) : 0;
    }
    const msgs = [...validateCustomsLineEffectiveOnly(effective, { location: line.location })];
    if (!(Number(effective.customsUnitValue) >= 0) || !Number.isFinite(Number(effective.customsUnitValue))) {
      msgs.push("BOE Customs Unit Value is invalid");
    }
    if (msgs.length) {
      errors.push({
        line: key || line.article || "?",
        article: line.article || "",
        messages: msgs,
        effective,
      });
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    valuationMethod: CUSTOMS_VALUATION_BOE_AVERAGE,
    customsUnitValue,
    boeDeclaredQty: declaredQty,
    boeDeclaredValue: declaredValue,
    thisGrnCustomsQty: qtyResolve.thisGrnCustomsQty || 0,
    lineCustomsQty: valueByKey,
    customsBoeId: headerNorm.customsBoeId || (parentBoe?._id ? String(parentBoe._id) : ""),
    customsBoeRef: headerNorm.customsBoeRef || parentBoe?.customsBoeRef || "",
  };
}

/** Snapshot for GRN line persistence (effective only). */
export function toPersistedGrnLineCustoms(effective) {
  return {
    receivedDate: effective.receivedDate || null,
    boeNumber: effective.boeNumber || "",
    boeDate: effective.boeDate || null,
    blNumber: effective.blNumber || "",
    awbNumber: effective.awbNumber || "",
    supplierInvoiceNumber: effective.supplierInvoiceNumber || "",
    supplierInvoiceDate: effective.supplierInvoiceDate || null,
    countryOfOrigin: effective.countryOfOrigin || "",
    hsCode: effective.hsCode || "",
    unitWeightKg: Number(effective.unitWeightKg) || 0,
    totalWeightKg: Number(effective.totalWeightKg) || 0,
    customsUnitPrice: Number(effective.customsUnitValue ?? effective.customsUnitPrice) || 0,
    customsUnitValue: Number(effective.customsUnitValue ?? effective.customsUnitPrice) || 0,
    customsTotalPrice: Number(effective.customsTotalPrice) || 0,
    customsCurrency: effective.customsCurrency || "",
    exchangeRateToAED: Number(effective.exchangeRateToAED) || 0,
    customsValueAED: Number(effective.customsValueAED) || 0,
    customsRemarks: effective.customsRemarks || "",
    valuationMethod: effective.valuationMethod || CUSTOMS_VALUATION_BOE_AVERAGE,
    customsQty: Number(effective.customsQty) || 0,
    boeDeclaredQty: Number(effective.boeDeclaredQty) || 0,
    boeDeclaredValue: Number(effective.boeDeclaredValue) || 0,
    customsUom: effective.customsUom || "",
  };
}

export class CustomsGrnValidationError extends Error {
  constructor(errors = []) {
    const grouped = formatCustomsCaptureErrorText(errors);
    const flat =
      grouped ||
      errors
        .flatMap((e) => (e.messages || []).map((m) => `${e.article || e.line}: ${m}`))
        .join("; ");
    super(flat || "Customs validation failed");
    this.name = "CustomsGrnValidationError";
    this.code = "CUSTOMS_GRN_VALIDATION";
    this.errors = errors;
    this.statusCode = 400;
  }
}

export {
  CUSTOMS_VALUATION_BOE_AVERAGE,
  CUSTOMS_VALUATION_LEGACY_LINE,
  computeBoeCustomsUnitValue,
  roundCustomsMoney,
};
