/**
 * Customs GRN CSV — single supported template / parser (Phase 2).
 * Preview/mapping only; does not post GRN or create customs lots.
 */

export const INVALID_GRN_TEMPLATE = "INVALID_GRN_TEMPLATE";

/** Official export/import header labels — exact order required. */
export const GRN_CSV_HEADERS = Object.freeze([
  "PO Line ID",
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

export function normalizeCsvHeaderKey(h) {
  return String(h ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

/** Normalized keys corresponding 1:1 with GRN_CSV_HEADERS. */
export const GRN_CSV_HEADER_KEYS = Object.freeze(GRN_CSV_HEADERS.map(normalizeCsvHeaderKey));

export function grnCsvTemplateHeaderLine() {
  return `${GRN_CSV_HEADERS.join(",")}\n`;
}

/**
 * Strict header validation: exact labels, order, no missing/extra/duplicates.
 * @returns {{ ok: true } | { ok: false, code: string, message: string, details: string[] }}
 */
export function validateGrnCsvHeaders(rawHeaders) {
  const details = [];
  const headers = (rawHeaders || []).map((h) => String(h ?? "").trim());
  const expected = [...GRN_CSV_HEADERS];

  if (!headers.length) {
    return {
      ok: false,
      code: INVALID_GRN_TEMPLATE,
      message: "Expected Customs GRN template. Please download the latest template.",
      details: ["CSV header row is missing."],
    };
  }

  const seen = new Map();
  headers.forEach((h, i) => {
    const key = normalizeCsvHeaderKey(h);
    if (!key) {
      details.push(`Column ${i + 1} has an empty header.`);
      return;
    }
    if (seen.has(key)) {
      details.push(`Duplicate column "${h}" (also at column ${seen.get(key)}).`);
    } else {
      seen.set(key, i + 1);
    }
  });

  if (headers.length !== expected.length) {
    details.push(`Expected ${expected.length} columns, found ${headers.length}.`);
  }

  const max = Math.max(headers.length, expected.length);
  for (let i = 0; i < max; i++) {
    const got = headers[i] ?? "";
    const want = expected[i] ?? "";
    if (!want) {
      details.push(`Unexpected extra column ${i + 1}: "${got}".`);
      continue;
    }
    if (!got) {
      details.push(`Missing column ${i + 1}: expected "${want}".`);
      continue;
    }
    if (got !== want) {
      details.push(`Column ${i + 1}: expected "${want}", found "${got}".`);
    }
  }

  const uniq = [...new Set(details)];
  if (uniq.length) {
    return {
      ok: false,
      code: INVALID_GRN_TEMPLATE,
      message: "Expected Customs GRN template. Please download the latest template.",
      details: uniq,
    };
  }
  return { ok: true };
}

function cell(row, headerLabel) {
  const key = normalizeCsvHeaderKey(headerLabel);
  const v = row?.[key];
  return v == null ? "" : String(v).trim();
}

function cellNum(row, headerLabel) {
  const raw = cell(row, headerLabel);
  if (raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : NaN;
}

/**
 * Map one official-template row to customs line-override fields.
 * Auto-fills Weight / Total Price / AED Value only when blank.
 */
export function mapCsvRowToCustomsOverride(row, grnQty) {
  const qty = Math.max(0, Number(grnQty) || 0);
  const unitWeight = cellNum(row, "Unit Weight");
  let weight = cellNum(row, "Weight");
  if (weight == null && unitWeight != null && !Number.isNaN(unitWeight) && qty > 0) {
    weight = qty * unitWeight;
  }

  const customsUnitPrice = cellNum(row, "Customs Unit Price");
  let totalPrice = cellNum(row, "Total Price");
  if (totalPrice == null && customsUnitPrice != null && !Number.isNaN(customsUnitPrice) && qty > 0) {
    totalPrice = qty * customsUnitPrice;
  }

  const exchangeRate = cellNum(row, "Exchange Rate");
  let aedValue = cellNum(row, "AED Value");
  if (
    aedValue == null &&
    totalPrice != null &&
    !Number.isNaN(totalPrice) &&
    exchangeRate != null &&
    !Number.isNaN(exchangeRate)
  ) {
    aedValue = totalPrice * exchangeRate;
  }

  const awbBl = cell(row, "AWB No. / BL No.");
  const currency = cell(row, "Currency");

  const override = {};
  const setStr = (key, val) => {
    if (val) override[key] = val;
  };
  const setNum = (key, val) => {
    if (val != null && Number.isFinite(Number(val)) && !Number.isNaN(Number(val))) {
      override[key] = Number(val);
    }
  };

  setStr("boeNumber", cell(row, "BOE Number"));
  setStr("boeDate", cell(row, "BOE Date"));
  if (awbBl) {
    override.blNumber = awbBl;
    override.awbNumber = awbBl;
  }
  setStr("receivedDate", cell(row, "Received Date"));
  setStr("supplierInvoiceNumber", cell(row, "Supplier Invoice No."));
  setStr("supplierInvoiceDate", cell(row, "Supplier Invoice Date"));
  setStr("countryOfOrigin", cell(row, "Country Of Origin"));
  setStr("hsCode", cell(row, "HS Code"));
  setNum("unitWeightKg", unitWeight != null && !Number.isNaN(unitWeight) ? unitWeight : null);
  setNum("totalWeightKg", weight != null && !Number.isNaN(weight) ? weight : null);
  setNum(
    "customsUnitPrice",
    customsUnitPrice != null && !Number.isNaN(customsUnitPrice) ? customsUnitPrice : null
  );
  setNum("customsTotalPrice", totalPrice != null && !Number.isNaN(totalPrice) ? totalPrice : null);
  setStr("customsCurrency", currency ? currency.toUpperCase() : "");
  setNum("exchangeRateToAED", exchangeRate != null && !Number.isNaN(exchangeRate) ? exchangeRate : null);
  setNum("customsValueAED", aedValue != null && !Number.isNaN(aedValue) ? aedValue : null);

  return {
    override,
    computed: {
      weight: weight != null && !Number.isNaN(weight) ? weight : null,
      totalPrice: totalPrice != null && !Number.isNaN(totalPrice) ? totalPrice : null,
      aedValue: aedValue != null && !Number.isNaN(aedValue) ? aedValue : null,
      unitWeight: unitWeight != null && !Number.isNaN(unitWeight) ? unitWeight : null,
      customsUnitPrice:
        customsUnitPrice != null && !Number.isNaN(customsUnitPrice) ? customsUnitPrice : null,
      exchangeRate: exchangeRate != null && !Number.isNaN(exchangeRate) ? exchangeRate : null,
    },
  };
}

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
  set("customsTotalWeightKg", o.totalWeightKg);
  set("customsTotalPrice", o.customsTotalPrice);
  set("customsValueAED", o.customsValueAED);
  return out;
}

export function suggestHeaderDefaultsFromOverrides(overrides = []) {
  for (const o of overrides) {
    if (!o || typeof o !== "object") continue;
    if (!Object.keys(o).length) continue;
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

function splitCsvLine(line) {
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
}

/**
 * Parse Customs GRN CSV. Validates header strictly before reading rows.
 * @returns {{ ok: true, rows, rawHeaders } | { ok: false, code, message, details }}
 */
export function parseGrnCsvText(text) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (!lines.length) {
    return {
      ok: false,
      code: INVALID_GRN_TEMPLATE,
      message: "Expected Customs GRN template. Please download the latest template.",
      details: ["CSV is empty."],
    };
  }

  const rawHeaders = splitCsvLine(lines[0]);
  const headerCheck = validateGrnCsvHeaders(rawHeaders);
  if (!headerCheck.ok) return headerCheck;

  const rows = [];
  for (let li = 1; li < lines.length; li++) {
    const parts = splitCsvLine(lines[li]);
    const o = {};
    GRN_CSV_HEADER_KEYS.forEach((h, idx) => {
      o[h] = parts[idx] ?? "";
    });
    rows.push(o);
  }
  return { ok: true, rows, rawHeaders };
}

export function readPoLineIdFromCsvRow(row) {
  return cell(row, "PO Line ID");
}

export function readArticleFromCsvRow(row) {
  return cell(row, "Article");
}

export function readGrnQtyFromCsvRow(row) {
  return cellNum(row, "GRN Qty");
}

export function readLocationFromCsvRow(row) {
  return cell(row, "Location");
}

export function readRemarksFromCsvRow(row) {
  return cell(row, "Remarks");
}

/**
 * Row-level required field checks for Customs GRN CSV import.
 * @returns {string[]} error messages (without row prefix)
 */
export function validateGrnCsvRowRequiredFields(row) {
  const messages = [];
  if (!readPoLineIdFromCsvRow(row)) messages.push("PO Line ID is required.");
  if (!readArticleFromCsvRow(row)) messages.push("Article is required.");

  const grnQty = readGrnQtyFromCsvRow(row);
  if (grnQty == null) {
    messages.push("GRN Qty is required.");
  } else if (Number.isNaN(grnQty) || !(grnQty > 0)) {
    messages.push("GRN Qty must be greater than zero.");
  }

  if (!readLocationFromCsvRow(row)) messages.push("Location is required.");
  if (!cell(row, "BOE Number")) messages.push("BOE Number is required.");
  if (!cell(row, "BOE Date")) messages.push("BOE Date is required.");
  if (!cell(row, "Supplier Invoice No.")) messages.push("Supplier Invoice No. is required.");
  if (!cell(row, "Supplier Invoice Date")) messages.push("Supplier Invoice Date is required.");
  if (!cell(row, "Currency")) messages.push("Currency is required.");

  const fx = cellNum(row, "Exchange Rate");
  if (fx == null) messages.push("Exchange Rate is required.");
  else if (Number.isNaN(fx) || !(fx > 0)) messages.push("Exchange Rate must be greater than zero.");

  const unitPrice = cellNum(row, "Customs Unit Price");
  if (unitPrice == null) messages.push("Customs Unit Price is required.");
  else if (Number.isNaN(unitPrice) || !(unitPrice > 0)) {
    messages.push("Customs Unit Price must be greater than zero.");
  }

  if (!cell(row, "Country Of Origin")) messages.push("Country Of Origin is required.");
  if (!cell(row, "HS Code")) messages.push("HS Code is required.");

  return messages;
}

/** Build a sample data row aligned to GRN_CSV_HEADERS (tests). */
export function buildGrnCsvRow(valuesByHeader = {}) {
  return GRN_CSV_HEADERS.map((h) => {
    const v = valuesByHeader[h];
    if (v == null) return "";
    const s = String(v);
    return s.includes(",") || s.includes('"') ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(",");
}
