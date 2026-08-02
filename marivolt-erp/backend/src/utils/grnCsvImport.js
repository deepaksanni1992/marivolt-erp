/**
 * GRN CSV template + import mapping (Customs-aware).
 * Does not post GRN or run customs lot creation — preview/mapping only.
 * Reuses customs field names from customsGrnFieldModel (header + line overrides).
 */

/** Canonical export header order (display labels). */
export const GRN_CSV_CUSTOMS_HEADERS = Object.freeze([
  "poLineId",
  "Article",
  "Description",
  "SPN",
  "UOM",
  "GRN Qty",
  "Location",
  "Remarks",
  "BOE Number",
  "BOE Date",
  "AWB No. / BL No.",
  "Received Date",
  "Supplier Invoice No.",
  "Supplier Invoice Date",
  "Country Of Origin",
  "HS Code",
  "Unit Weight",
  "Weight",
  "Customs Unit Price",
  "Total Price",
  "Currency",
  "Exchange Rate",
  "AED Value",
]);

/** Legacy template headers (still accepted on import). */
export const GRN_CSV_LEGACY_HEADERS = Object.freeze([
  "poLineId",
  "article",
  "materialCode",
  "spn",
  "grnQty",
  "location",
  "remarks",
]);

export function grnCsvTemplateHeaderLine() {
  return `${GRN_CSV_CUSTOMS_HEADERS.join(",")}\n`;
}

/** Normalize a CSV header cell to an alphanumeric key for lookups. */
export function normalizeCsvHeaderKey(h) {
  return String(h ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

/**
 * Detect CSV format from header keys (already normalized).
 * @param {string[]} headerKeys
 * @returns {"customs"|"legacy"}
 */
export function detectGrnCsvFormat(headerKeys) {
  const set = new Set((headerKeys || []).map(normalizeCsvHeaderKey).filter(Boolean));
  const customsMarkers = [
    "boenumber",
    "boedate",
    "awbnoblno",
    "receiveddate",
    "supplierinvoiceno",
    "supplierinvoicenumber",
    "supplierinvoicedate",
    "countryoforigin",
    "hscode",
    "unitweight",
    "customsunitprice",
    "totalprice",
    "exchangerate",
    "aedvalue",
  ];
  if (customsMarkers.some((m) => set.has(m))) return "customs";
  // "Weight" / "Currency" alone are weak; require at least one strong marker above.
  return "legacy";
}

function pickRaw(row, ...keys) {
  for (const k of keys) {
    const nk = normalizeCsvHeaderKey(k);
    if (Object.prototype.hasOwnProperty.call(row, nk) && row[nk] != null && String(row[nk]).trim() !== "") {
      return String(row[nk]).trim();
    }
  }
  return "";
}

function pickNum(row, ...keys) {
  const raw = pickRaw(row, ...keys);
  if (raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * Map one parsed CSV row (keys = normalizeCsvHeaderKey) to customs line-override fields
 * plus auto-calculated Weight / Total Price / AED Value when blank.
 *
 * @returns {{ override: object, computed: { weight: number|null, totalPrice: number|null, aedValue: number|null } }}
 */
export function mapCsvRowToCustomsOverride(row, grnQty) {
  const qty = Math.max(0, Number(grnQty) || 0);
  const unitWeight = pickNum(row, "Unit Weight", "unitWeight", "unitWeightKg");
  let weight = pickNum(row, "Weight", "totalWeightKg", "totalWeight");
  if (weight == null && unitWeight != null && qty > 0) {
    weight = qty * unitWeight;
  }

  const customsUnitPrice = pickNum(row, "Customs Unit Price", "customsUnitPrice", "unitPrice");
  let totalPrice = pickNum(row, "Total Price", "customsTotalPrice", "totalPrice");
  if (totalPrice == null && customsUnitPrice != null && qty > 0) {
    totalPrice = qty * customsUnitPrice;
  }

  const exchangeRate = pickNum(row, "Exchange Rate", "exchangeRate", "exchangeRateToAED");
  let aedValue = pickNum(row, "AED Value", "customsValueAED", "aedValue");
  if (aedValue == null && totalPrice != null && exchangeRate != null) {
    aedValue = totalPrice * exchangeRate;
  }

  const awbBl = pickRaw(row, "AWB No. / BL No.", "awbNoBlNo", "awbNumber", "blNumber", "AWB", "BL");
  const currency = pickRaw(row, "Currency", "customsCurrency");

  /** Canonical override keys matching customsGrnFieldModel / normalizeCustomsLineOverride */
  const override = {};
  const setStr = (key, val) => {
    if (val) override[key] = val;
  };
  const setNum = (key, val) => {
    if (val != null && Number.isFinite(Number(val))) override[key] = Number(val);
  };

  setStr("boeNumber", pickRaw(row, "BOE Number", "boeNumber"));
  setStr("boeDate", pickRaw(row, "BOE Date", "boeDate"));
  // Combined AWB/BL column → both optional carriers (resolution keeps both)
  if (awbBl) {
    override.blNumber = awbBl;
    override.awbNumber = awbBl;
  }
  setStr("receivedDate", pickRaw(row, "Received Date", "receivedDate"));
  setStr(
    "supplierInvoiceNumber",
    pickRaw(row, "Supplier Invoice No.", "Supplier Invoice Number", "supplierInvoiceNo", "supplierInvoiceNumber")
  );
  setStr("supplierInvoiceDate", pickRaw(row, "Supplier Invoice Date", "supplierInvoiceDate"));
  setStr("countryOfOrigin", pickRaw(row, "Country Of Origin", "countryOfOrigin"));
  setStr("hsCode", pickRaw(row, "HS Code", "hsCode"));
  setNum("unitWeightKg", unitWeight);
  setNum("totalWeightKg", weight);
  setNum("customsUnitPrice", customsUnitPrice);
  setNum("customsTotalPrice", totalPrice);
  setStr("customsCurrency", currency ? currency.toUpperCase() : "");
  setNum("exchangeRateToAED", exchangeRate);
  setNum("customsValueAED", aedValue);
  setStr("customsRemarks", pickRaw(row, "Customs Remarks", "customsRemarks"));
  // Do not map commercial Remarks into customsRemarks (legacy remarks stays on GRN line).

  return {
    override,
    computed: { weight, totalPrice, aedValue, unitWeight, customsUnitPrice, exchangeRate },
  };
}

/**
 * Build UI / API update customs slice from a normalized override object.
 * Keys match frontend grnLineEdits customs* fields + canonical override names for header merge.
 */
export function customsOverrideToLineEditFields(override = {}) {
  const o = override || {};
  const out = {};
  const set = (k, v) => {
    if (v == null || v === "") return;
    out[k] = typeof v === "number" ? String(v) : String(v);
  };
  set("customsReceivedDate", o.receivedDate);
  set("customsBoeNumber", o.boeNumber);
  set("customsBoeDate", o.boeDate);
  set("customsBlNumber", o.blNumber);
  set("customsAwbNumber", o.awbNumber);
  set("customsSupplierInvoiceNumber", o.supplierInvoiceNumber);
  set("customsSupplierInvoiceDate", o.supplierInvoiceDate);
  set("customsHsCode", o.hsCode);
  set("customsCountryOfOrigin", o.countryOfOrigin);
  set("customsUnitPrice", o.customsUnitPrice);
  set("customsCurrency", o.customsCurrency);
  set("customsUnitWeightKg", o.unitWeightKg);
  set("customsWeightKg", o.unitWeightKg);
  set("customsExchangeRateToAED", o.exchangeRateToAED);
  set("customsRemarks", o.customsRemarks);
  // Totals for optional UI / round-trip (server recalculates on post)
  set("customsTotalWeightKg", o.totalWeightKg);
  set("customsTotalPrice", o.customsTotalPrice);
  set("customsValueAED", o.customsValueAED);
  return out;
}

/**
 * Suggest header defaults from the first row that has customs data
 * (header defaults + line overrides resolution on post).
 */
export function suggestHeaderDefaultsFromOverrides(overrides = []) {
  for (const o of overrides) {
    if (!o || typeof o !== "object") continue;
    const keys = Object.keys(o);
    if (!keys.length) continue;
    return {
      receivedDate: o.receivedDate || "",
      boeNumber: o.boeNumber || "",
      boeDate: o.boeDate || "",
      blNumber: o.blNumber || "",
      awbNumber: o.awbNumber || "",
      supplierInvoiceNumber: o.supplierInvoiceNumber || "",
      supplierInvoiceDate: o.supplierInvoiceDate || "",
      countryOfOrigin: o.countryOfOrigin || "",
      hsCode: o.hsCode || "",
      unitWeightKg: o.unitWeightKg != null ? o.unitWeightKg : "",
      customsUnitPrice: o.customsUnitPrice != null ? o.customsUnitPrice : "",
      customsCurrency: o.customsCurrency || "",
      exchangeRateToAED: o.exchangeRateToAED != null ? o.exchangeRateToAED : "",
      customsRemarks: o.customsRemarks || "",
    };
  }
  return null;
}

/**
 * Parse CSV text into rows with normalized header keys.
 */
export function parseGrnCsvText(text) {
  const parseErrors = [];
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (!lines.length) return { rows: [], headerKeys: [], format: "legacy", parseErrors };

  const splitLine = (line) => {
    const out = [];
    let cur = "";
    let q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') {
        q = !q;
        continue;
      }
      if (!q && c === ",") {
        out.push(cur);
        cur = "";
        continue;
      }
      cur += c;
    }
    out.push(cur);
    return out.map((x) => String(x).trim());
  };

  const rawHeaders = splitLine(lines[0]);
  const headerKeys = rawHeaders.map(normalizeCsvHeaderKey);
  const format = detectGrnCsvFormat(headerKeys);
  const rows = [];
  for (let li = 1; li < lines.length; li++) {
    const parts = splitLine(lines[li]);
    const o = {};
    headerKeys.forEach((h, idx) => {
      if (!h) return;
      o[h] = parts[idx] ?? "";
    });
    rows.push(o);
  }
  return { rows, headerKeys, format, parseErrors };
}

/** Read GRN qty from legacy or customs column names. */
export function readGrnQtyFromCsvRow(row) {
  const n = pickNum(row, "GRN Qty", "grnQty", "qty", "grnqty");
  return n;
}

export function readLocationFromCsvRow(row) {
  return pickRaw(row, "Location", "location");
}

export function readRemarksFromCsvRow(row) {
  return pickRaw(row, "Remarks", "remarks");
}
