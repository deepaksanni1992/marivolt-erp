/**
 * Customs GRN CSV — download template + import parser.
 * Preview/mapping only; does not post GRN or create customs lots.
 */

export const INVALID_GRN_TEMPLATE = "INVALID_GRN_TEMPLATE";

/** Official generated export/import header labels. */
export const GRN_CSV_HEADERS = Object.freeze([
  "PO Line ID",
  "Article",
  "Description",
  "SPN",
  "UOM",
  "GRN Qty",
  "Location",
  "Remarks",
  "Customs BOE Ref",
  "BOE Number",
  "BOE Date",
  "BL Number",
  "AWB Number",
  "Received Date",
  "Supplier Invoice Number",
  "Supplier Invoice Date",
  "BOE Declared Qty",
  "Customs UOM",
  "BOE Declared Value",
  "Customs Currency",
  "Exchange Rate to AED",
  "Gross Weight KG",
  "Net Weight KG",
  "Country of Origin",
  "HS Code",
  "Unit Weight KG",
  "Customs Qty",
  "Customs Remarks",
]);

/** Shipment/BOE fields: first nonblank wins; later blanks inherit; conflicts reject. */
export const GRN_CSV_SHIPMENT_FIELDS = Object.freeze([
  "customsBoeRef",
  "boeNumber",
  "boeDate",
  "blNumber",
  "awbNumber",
  "receivedDate",
  "supplierInvoiceNumber",
  "supplierInvoiceDate",
  "boeDeclaredQty",
  "customsUom",
  "boeDeclaredValue",
  "customsCurrency",
  "exchangeRateToAED",
  "grossWeightKg",
  "netWeightKg",
]);

const CSV_FIELD_ALIASES = Object.freeze({
  polineid: "poLineId",
  article: "article",
  description: "description",
  spn: "spn",
  uom: "uom",
  grnqty: "grnQty",
  location: "location",
  remarks: "remarks",
  customsboeref: "customsBoeRef",
  boenumber: "boeNumber",
  boedate: "boeDate",
  awbnoblno: "awbBlCombined",
  blnumber: "blNumber",
  awbnumber: "awbNumber",
  receiveddate: "receivedDate",
  supplierinvoiceno: "supplierInvoiceNumber",
  supplierinvoicenumber: "supplierInvoiceNumber",
  supplierinvoicedate: "supplierInvoiceDate",
  countryoforigin: "countryOfOrigin",
  hscode: "hsCode",
  unitweight: "unitWeightKg",
  unitweightkg: "unitWeightKg",
  weight: "deprecatedWeight",
  boedeclaredqty: "boeDeclaredQty",
  customsuom: "customsUom",
  boedeclaredvalue: "boeDeclaredValue",
  currency: "customsCurrency",
  customscurrency: "customsCurrency",
  exchangerate: "exchangeRateToAED",
  exchangeratetoaed: "exchangeRateToAED",
  grossweightkg: "grossWeightKg",
  netweightkg: "netWeightKg",
  customsqty: "customsQty",
  customsremarks: "customsRemarks",
});

const SHIPMENT_LABELS = {
  customsBoeRef: "Customs BOE Ref",
  boeNumber: "BOE Number",
  boeDate: "BOE Date",
  blNumber: "BL Number",
  awbNumber: "AWB Number",
  receivedDate: "Received Date",
  supplierInvoiceNumber: "Supplier Invoice Number",
  supplierInvoiceDate: "Supplier Invoice Date",
  boeDeclaredQty: "BOE Declared Qty",
  customsUom: "Customs UOM",
  boeDeclaredValue: "BOE Declared Value",
  customsCurrency: "Customs Currency",
  exchangeRateToAED: "Exchange Rate to AED",
  grossWeightKg: "Gross Weight KG",
  netWeightKg: "Net Weight KG",
};

export function normalizeCsvHeaderKey(h) {
  return String(h ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

/** Normalized keys corresponding 1:1 with GRN_CSV_HEADERS (generated template). */
export const GRN_CSV_HEADER_KEYS = Object.freeze(GRN_CSV_HEADERS.map(normalizeCsvHeaderKey));

export function resolveCsvCanonicalField(headerLabel) {
  return CSV_FIELD_ALIASES[normalizeCsvHeaderKey(headerLabel)] || null;
}

export function grnCsvTemplateHeaderLine() {
  return `${GRN_CSV_HEADERS.join(",")}\n`;
}

export function isDateLikeWeightString(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return false;
  return /^\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}(?:\s|$)/.test(s);
}

/**
 * Accept the generated template or a known-alias header row (legacy names / reorder).
 * Unknown columns are rejected.
 */
export function validateGrnCsvHeaders(rawHeaders) {
  const details = [];
  const headers = (rawHeaders || []).map((h) => String(h ?? "").replace(/^\uFEFF/, "").trim());

  if (!headers.length) {
    return {
      ok: false,
      code: INVALID_GRN_TEMPLATE,
      message: "Expected Customs GRN template. Please download the latest template.",
      details: ["CSV header row is missing."],
    };
  }

  const seenCanon = new Map();
  const columnMap = [];
  headers.forEach((h, i) => {
    if (!h) {
      details.push(`Column ${i + 1} has an empty header.`);
      columnMap.push(null);
      return;
    }
    const canon = resolveCsvCanonicalField(h);
    if (!canon) {
      details.push(`Unexpected extra column ${i + 1}: "${h}".`);
      columnMap.push(null);
      return;
    }
    if (seenCanon.has(canon) && canon !== "awbBlCombined") {
      details.push(`Duplicate column "${h}" (also at column ${seenCanon.get(canon)}).`);
    } else {
      seenCanon.set(canon, i + 1);
    }
    columnMap.push(canon);
  });

  if (!seenCanon.has("article") && !seenCanon.has("poLineId")) {
    details.push('Missing required column "Article" or "PO Line ID".');
  }
  if (!seenCanon.has("grnQty")) {
    details.push('Missing required column "GRN Qty".');
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
  return { ok: true, columnMap };
}

function cell(row, headerLabel) {
  const canon = resolveCsvCanonicalField(headerLabel) || normalizeCsvHeaderKey(headerLabel);
  const v = row?.[canon] ?? row?.[normalizeCsvHeaderKey(headerLabel)];
  return v == null ? "" : String(v).trim();
}

function cellNum(row, headerLabel) {
  const raw = cell(row, headerLabel);
  if (raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : NaN;
}

/**
 * Map one official-template row to customs line-override / header fields.
 * Does not treat Customs Unit Price as source of truth (column removed).
 * BOE Declared Qty/Value map to header defaults; line may include customsQty when needed.
 */
export function mapCsvRowToCustomsOverride(row, grnQty) {
  const qty = Math.max(0, Number(grnQty) || 0);
  const unitWeightRaw = cell(row, "Unit Weight KG") || cell(row, "Unit Weight");
  const deprecatedWeightRaw = cell(row, "Weight");
  const weightErrors = [];
  if (unitWeightRaw && isDateLikeWeightString(unitWeightRaw)) {
    weightErrors.push(`Unit Weight KG "${unitWeightRaw}" looks like a date. Enter a numeric KG value such as 0.5.`);
  }
  if (deprecatedWeightRaw && isDateLikeWeightString(deprecatedWeightRaw)) {
    weightErrors.push(`Weight "${deprecatedWeightRaw}" looks like a date. Use Unit Weight KG / Gross Weight KG / Net Weight KG.`);
  }

  const unitWeight = unitWeightRaw && !isDateLikeWeightString(unitWeightRaw) ? Number(unitWeightRaw) : null;
  const unitWeightNum = unitWeight != null && Number.isFinite(unitWeight) ? unitWeight : null;
  const deprecatedWeight =
    deprecatedWeightRaw && !isDateLikeWeightString(deprecatedWeightRaw) ? Number(deprecatedWeightRaw) : null;
  let totalWeight =
    deprecatedWeight != null && Number.isFinite(deprecatedWeight) ? deprecatedWeight : null;
  if (totalWeight == null && unitWeightNum != null && qty > 0) {
    totalWeight = qty * unitWeightNum;
  }

  const boeDeclaredQty = cellNum(row, "BOE Declared Qty");
  const boeDeclaredValue = cellNum(row, "BOE Declared Value");
  const customsUom = cell(row, "Customs UOM");
  const exchangeRate = cellNum(row, "Exchange Rate to AED");
  const awbBl = cell(row, "AWB No. / BL No.");
  const blNumber = cell(row, "BL Number");
  const awbNumber = cell(row, "AWB Number");
  const currency = cell(row, "Customs Currency") || cell(row, "Currency");
  const customsQty = cellNum(row, "Customs Qty");
  const grossWeightKg = cellNum(row, "Gross Weight KG");
  const netWeightKg = cellNum(row, "Net Weight KG");

  const legacyUnitPrice = cellNum(row, "Customs Unit Price");

  const override = {};
  const setStr = (key, val) => {
    if (val) override[key] = val;
  };
  const setNum = (key, val) => {
    if (val != null && Number.isFinite(Number(val)) && !Number.isNaN(Number(val))) {
      override[key] = Number(val);
    }
  };

  setStr("customsBoeRef", cell(row, "Customs BOE Ref"));
  setStr("boeNumber", cell(row, "BOE Number"));
  setStr("boeDate", cell(row, "BOE Date"));
  setStr("blNumber", blNumber || awbBl);
  setStr("awbNumber", awbNumber || awbBl);
  setStr("receivedDate", cell(row, "Received Date"));
  setStr("supplierInvoiceNumber", cell(row, "Supplier Invoice Number") || cell(row, "Supplier Invoice No."));
  setStr("supplierInvoiceDate", cell(row, "Supplier Invoice Date"));
  setStr("countryOfOrigin", cell(row, "Country of Origin") || cell(row, "Country Of Origin"));
  setStr("hsCode", cell(row, "HS Code"));
  setNum("unitWeightKg", unitWeightNum);
  setNum("totalWeightKg", totalWeight);
  setNum("grossWeightKg", grossWeightKg != null && !Number.isNaN(grossWeightKg) ? grossWeightKg : null);
  setNum("netWeightKg", netWeightKg != null && !Number.isNaN(netWeightKg) ? netWeightKg : null);
  setStr("customsCurrency", currency ? currency.toUpperCase() : "");
  setNum("exchangeRateToAED", exchangeRate != null && !Number.isNaN(exchangeRate) ? exchangeRate : null);
  setNum("boeDeclaredQty", boeDeclaredQty != null && !Number.isNaN(boeDeclaredQty) ? boeDeclaredQty : null);
  setNum("boeDeclaredValue", boeDeclaredValue != null && !Number.isNaN(boeDeclaredValue) ? boeDeclaredValue : null);
  setStr("customsUom", customsUom ? customsUom.toUpperCase() : "");
  setNum("customsQty", customsQty != null && !Number.isNaN(customsQty) ? customsQty : null);
  setStr("customsRemarks", cell(row, "Customs Remarks"));

  return {
    override,
    weightErrors,
    computed: {
      weight: totalWeight,
      unitWeight: unitWeightNum,
      boeDeclaredQty: boeDeclaredQty != null && !Number.isNaN(boeDeclaredQty) ? boeDeclaredQty : null,
      boeDeclaredValue: boeDeclaredValue != null && !Number.isNaN(boeDeclaredValue) ? boeDeclaredValue : null,
      customsUom: customsUom || null,
      exchangeRate: exchangeRate != null && !Number.isNaN(exchangeRate) ? exchangeRate : null,
      customsQty: customsQty != null && !Number.isNaN(customsQty) ? customsQty : null,
      legacyCustomsUnitPriceIgnored:
        legacyUnitPrice != null && !Number.isNaN(legacyUnitPrice) ? legacyUnitPrice : null,
    },
  };
}

/** Keep only defaultable / line-specific customs fields on article rows. */
export function stripShipmentFieldsFromLineOverride(override = {}) {
  const o = override || {};
  const out = {};
  if (o.countryOfOrigin) out.countryOfOrigin = o.countryOfOrigin;
  if (o.hsCode) out.hsCode = o.hsCode;
  if (o.unitWeightKg != null && o.unitWeightKg !== "") out.unitWeightKg = o.unitWeightKg;
  if (o.totalWeightKg != null && o.totalWeightKg !== "") out.totalWeightKg = o.totalWeightKg;
  if (o.customsQty != null && o.customsQty !== "") out.customsQty = o.customsQty;
  if (o.customsRemarks) out.customsRemarks = o.customsRemarks;
  return out;
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
  set("customsQty", o.customsQty);
  set("customsCurrency", o.customsCurrency);
  set("customsUnitWeightKg", o.unitWeightKg);
  set("customsWeightKg", o.unitWeightKg);
  set("customsExchangeRateToAED", o.exchangeRateToAED);
  set("customsRemarks", o.customsRemarks);
  set("customsTotalWeightKg", o.totalWeightKg);
  return out;
}

export function suggestHeaderDefaultsFromOverrides(overrides = []) {
  for (const o of overrides) {
    if (!o || typeof o !== "object") continue;
    if (!Object.keys(o).length) continue;
    return {
      receivedDate: o.receivedDate || "",
      customsBoeRef: o.customsBoeRef || "",
      boeNumber: o.boeNumber || "",
      boeDate: o.boeDate || "",
      blNumber: o.blNumber || "",
      awbNumber: o.awbNumber || "",
      supplierInvoiceNumber: o.supplierInvoiceNumber || "",
      supplierInvoiceDate: o.supplierInvoiceDate || "",
      countryOfOrigin: o.countryOfOrigin || "",
      hsCode: o.hsCode || "",
      unitWeightKg: o.unitWeightKg != null ? o.unitWeightKg : "",
      customsCurrency: o.customsCurrency || "",
      exchangeRateToAED: o.exchangeRateToAED != null ? o.exchangeRateToAED : "",
      customsRemarks: o.customsRemarks || "",
      boeDeclaredQty: o.boeDeclaredQty != null ? o.boeDeclaredQty : "",
      customsUom: o.customsUom || "",
      boeDeclaredValue: o.boeDeclaredValue != null ? o.boeDeclaredValue : "",
      grossWeightKg: o.grossWeightKg != null ? o.grossWeightKg : "",
      netWeightKg: o.netWeightKg != null ? o.netWeightKg : "",
      boeMode: o.customsBoeRef ? "SELECT" : "CREATE",
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
    .replace(/^\uFEFF/, "")
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

  const rawHeaders = splitCsvLine(lines[0]).map((h) => String(h ?? "").replace(/^\uFEFF/, "").trim());
  const headerCheck = validateGrnCsvHeaders(rawHeaders);
  if (!headerCheck.ok) return headerCheck;

  const columnMap = headerCheck.columnMap || rawHeaders.map((h) => resolveCsvCanonicalField(h));
  const rows = [];
  for (let li = 1; li < lines.length; li++) {
    const parts = splitCsvLine(lines[li]);
    const o = {};
    columnMap.forEach((canon, idx) => {
      if (!canon) return;
      const val = parts[idx] ?? "";
      if (canon === "awbBlCombined") {
        if (val) {
          if (!o.blNumber) o.blNumber = val;
          if (!o.awbNumber) o.awbNumber = val;
        }
        return;
      }
      o[canon] = val;
    });
    rows.push(o);
  }
  return { ok: true, rows, rawHeaders, columnMap };
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
 * Normalize article for matching: trim, uppercase, collapse whitespace.
 * Description is never used for matching.
 */
export function normalizeArticleKey(value) {
  return String(value ?? "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "");
}

/** Normalize PO Line ID cell values (trim; Excel "1.0" → "1" for numeric-only ids). */
export function normalizePoLineIdKey(value) {
  let s = String(value ?? "").trim();
  if (!s) return "";
  if (/^\d+\.0+$/.test(s)) s = s.replace(/\.0+$/, "");
  return s;
}

export function poLineArticleFromRaw(line) {
  return String(
    line?.itemCode || line?.article || line?.materialCode || line?.articleNo || line?.sku || ""
  ).trim();
}

/**
 * Collect all identifiers that may be exported in "PO Line ID".
 * Does NOT invent a row-index id (never assume CSV row number = PO Line ID).
 */
export function collectPoLineIdentifiers(line) {
  if (!line || typeof line !== "object") return [];
  const out = [];
  const seen = new Set();
  const push = (raw, field) => {
    const key = normalizePoLineIdKey(raw);
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push({ key, field });
  };
  push(line._id, "_id");
  push(line.id, "id");
  push(line.lineId, "lineId");
  push(line.poLineId, "poLineId");
  push(line.lineNumber, "lineNumber");
  push(line.lineNo, "lineNo");
  return out;
}

/**
 * Build lookup maps from loaded PO lines.
 * @returns {{ byId: Map<string,{line:object,field:string}>, byArticle: Map<string,object[]>, availableIds: string[] }}
 */
export function buildPoLineLookup(rawRows = []) {
  const byId = new Map();
  const byArticle = new Map();
  const availableIds = [];

  for (const line of Array.isArray(rawRows) ? rawRows : []) {
    const ids = collectPoLineIdentifiers(line);
    for (const { key, field } of ids) {
      if (!byId.has(key)) {
        byId.set(key, { line, field });
        availableIds.push(key);
      }
    }
    const art = normalizeArticleKey(poLineArticleFromRaw(line));
    if (!art) continue;
    if (!byArticle.has(art)) byArticle.set(art, []);
    byArticle.get(art).push(line);
  }

  return { byId, byArticle, availableIds };
}

/**
 * Match a CSV row to a PO line.
 * Prefer exported PO Line ID (_id / lineId / poLineId / lineNumber / …),
 * then unique Article (description is display-only).
 *
 * @returns {{ ok: true, line, by: string, matchedId?: string }
 *   | { ok: false, reason: string, importedId: string, availableIds: string[], article?: string }}
 */
export function findPoLineMatchForCsvRow(rawRows, row, opts = {}) {
  const importedId = normalizePoLineIdKey(readPoLineIdFromCsvRow(row));
  const articleRaw = readArticleFromCsvRow(row);
  const articleKey = normalizeArticleKey(articleRaw);
  const { byId, byArticle, availableIds } = buildPoLineLookup(rawRows);
  const log = typeof opts.log === "function" ? opts.log : null;

  if (importedId && byId.has(importedId)) {
    const hit = byId.get(importedId);
    if (log) {
      log({
        event: "grn_csv_po_line_match",
        importedPoLineId: importedId,
        availablePoLineIds: availableIds,
        matchingField: hit.field,
        matchedBy: "id",
      });
    }
    return { ok: true, line: hit.line, by: hit.field, matchedId: importedId };
  }

  if (articleKey) {
    const hits = byArticle.get(articleKey) || [];
    if (hits.length === 1) {
      if (log) {
        log({
          event: "grn_csv_po_line_match",
          importedPoLineId: importedId || "(empty)",
          availablePoLineIds: availableIds,
          matchingField: "article",
          matchedBy: "article",
          article: articleRaw,
        });
      }
      return { ok: true, line: hits[0], by: "article", matchedId: importedId || "" };
    }
    if (hits.length > 1) {
      return {
        ok: false,
        reason: "ambiguous_article",
        importedId,
        availableIds,
        article: articleRaw,
      };
    }
  }

  if (log) {
    log({
      event: "grn_csv_po_line_match_miss",
      importedPoLineId: importedId || "(empty)",
      availablePoLineIds: availableIds,
      matchingField: null,
      article: articleRaw || "",
    });
  }

  return {
    ok: false,
    reason: importedId ? "id_not_found" : "no_id_or_article",
    importedId,
    availableIds,
    article: articleRaw,
  };
}

/** Human-readable match failure for import preview. */
export function formatPoLineMatchError(matchFail, { rowLineNo, poNo } = {}) {
  const poLabel = poNo ? String(poNo) : "the purchase order";
  const rowPrefix = rowLineNo != null ? `Row ${rowLineNo}: ` : "";
  if (!matchFail || matchFail.ok) return "";
  if (matchFail.reason === "ambiguous_article") {
    return `${rowPrefix}Article "${matchFail.article}" matches multiple PO lines in ${poLabel}. Use the exported PO Line ID.`;
  }
  if (matchFail.importedId) {
    return `${rowPrefix}PO Line ID '${matchFail.importedId}' was not found in Purchase Order ${poLabel}.`;
  }
  return `${rowPrefix}No matching PO line (provide a valid PO Line ID from the template, or a unique Article).`;
}

/**
 * Build template CSV text. When lines are provided, pre-fill exported identifiers
 * so import can always accept the same PO Line ID values.
 */
export function buildGrnCsvTemplateCsv(lines = []) {
  const header = GRN_CSV_HEADERS.join(",");
  if (!Array.isArray(lines) || !lines.length) return `${header}\n`;

  const body = lines.map((line) => {
    const ids = collectPoLineIdentifiers(line);
    const poLineId = ids[0]?.key || "";
    const article = poLineArticleFromRaw(line);
    const description = String(line?.description || "").trim();
    const spn = String(line?.spn || line?.partNumber || line?.partNo || "").trim();
    const uom = String(line?.uom || "PCS").trim();
    const { pending } = (() => {
      const ordered = Number(line?.orderedQty ?? line?.qty ?? line?.quantity) || 0;
      const received = Number(line?.receivedQty ?? line?.received) || 0;
      const cancelled = Number(line?.cancelledQty ?? line?.cancelled) || 0;
      const pendingQty = Math.max(
        0,
        Number(line?.pendingQty ?? Math.max(0, ordered - received - cancelled)) || 0
      );
      return { pending: pendingQty };
    })();
    const values = {
      "PO Line ID": poLineId,
      Article: article,
      Description: description,
      SPN: spn,
      UOM: uom,
      "GRN Qty": pending > 0 ? String(pending) : "",
      Location: "",
      Remarks: "",
      "BOE Number": "",
      "BOE Date": "",
      "BL Number": "",
      "AWB Number": "",
      "Received Date": "",
      "Supplier Invoice Number": "",
      "Supplier Invoice Date": "",
      "BOE Declared Qty": "",
      "Customs UOM": "",
      "BOE Declared Value": "",
      "Customs Currency": "",
      "Exchange Rate to AED": "",
      "Gross Weight KG": "",
      "Net Weight KG": "",
      "Country of Origin": "",
      "HS Code": "",
      "Unit Weight KG": "",
      "Customs Qty": "",
      "Customs Remarks": "",
    };
    return buildGrnCsvRow(values);
  });

  return `${header}\n${body.join("\n")}\n`;
}

/**
 * Row-level required field checks for commercial identity only.
 * Shipment/BOE fields are validated once after header inheritance.
 */
export function validateGrnCsvRowRequiredFields(row) {
  const messages = [];
  const hasId = Boolean(readPoLineIdFromCsvRow(row));
  const hasArticle = Boolean(readArticleFromCsvRow(row));
  if (!hasId && !hasArticle) {
    messages.push("PO Line ID or Article is required.");
  }
  if (!hasArticle) messages.push("Article is required.");

  const grnQty = readGrnQtyFromCsvRow(row);
  if (grnQty == null) {
    messages.push("GRN Qty is required.");
  } else if (Number.isNaN(grnQty) || !(grnQty > 0)) {
    messages.push("GRN Qty must be greater than zero.");
  }

  if (!readLocationFromCsvRow(row)) messages.push("Location is required.");

  const unitWeightRaw = cell(row, "Unit Weight KG") || cell(row, "Unit Weight");
  if (unitWeightRaw && isDateLikeWeightString(unitWeightRaw)) {
    messages.push(`Unit Weight KG "${unitWeightRaw}" looks like a date. Enter a numeric KG value such as 0.5.`);
  }
  const deprecatedWeightRaw = cell(row, "Weight");
  if (deprecatedWeightRaw && isDateLikeWeightString(deprecatedWeightRaw)) {
    messages.push(
      `Weight "${deprecatedWeightRaw}" looks like a date. Use Unit Weight KG / Gross Weight KG / Net Weight KG.`
    );
  }

  const legacyPrice = cellNum(row, "Customs Unit Price");
  if (legacyPrice != null && !Number.isNaN(legacyPrice) && legacyPrice > 0) {
    messages.push(
      "Customs Unit Price is no longer accepted. Use BOE Declared Qty and BOE Declared Value."
    );
  }

  return messages;
}

function normalizeComparable(field, raw) {
  const s = String(raw ?? "").trim();
  if (!s) return "";
  if (
    field === "customsCurrency" ||
    field === "customsUom" ||
    field === "boeNumber" ||
    field === "supplierInvoiceNumber"
  ) {
    return s.toUpperCase();
  }
  if (
    field === "boeDeclaredQty" ||
    field === "boeDeclaredValue" ||
    field === "exchangeRateToAED" ||
    field === "grossWeightKg" ||
    field === "netWeightKg"
  ) {
    const n = Number(s);
    return Number.isFinite(n) ? String(n) : s;
  }
  return s;
}

/**
 * Collapse flat CSV shipment cells into one header.
 * Blank = inherit. Identical repeats accepted. Conflicts rejected.
 */
export function extractShipmentHeaderFromCsvRows(rows = []) {
  const header = {};
  const conflicts = [];
  for (const field of GRN_CSV_SHIPMENT_FIELDS) {
    let chosen = "";
    let chosenRow = null;
    (rows || []).forEach((row, idx) => {
      const raw = row?.[field];
      const val = raw == null ? "" : String(raw).trim();
      if (!val) return;
      if (!chosen) {
        chosen = val;
        chosenRow = idx + 2;
        return;
      }
      if (normalizeComparable(field, val) !== normalizeComparable(field, chosen)) {
        conflicts.push({
          field,
          line: idx + 2,
          message: `Conflicting ${SHIPMENT_LABELS[field] || field} in row ${idx + 2}. Shipment ${SHIPMENT_LABELS[field] || field} is ${chosen}.`,
        });
      }
    });
    if (chosen) header[field] = chosen;
  }
  return { header, conflicts, firstDataRow: chosenRowOf(rows, "boeNumber") };
}

function chosenRowOf(rows, field) {
  const i = (rows || []).findIndex((r) => String(r?.[field] ?? "").trim());
  return i >= 0 ? i + 2 : null;
}

export function csvHasMeaningfulCustoms(header = {}, overrides = []) {
  const keys = [
    "customsBoeRef",
    "boeNumber",
    "boeDate",
    "blNumber",
    "awbNumber",
    "supplierInvoiceNumber",
    "supplierInvoiceDate",
    "boeDeclaredQty",
    "boeDeclaredValue",
    "customsCurrency",
    "exchangeRateToAED",
    "countryOfOrigin",
    "hsCode",
    "grossWeightKg",
    "netWeightKg",
    "unitWeightKg",
    "customsQty",
    "customsRemarks",
  ];
  if (keys.some((k) => String(header[k] ?? "").trim())) return true;
  return (overrides || []).some((o) => keys.some((k) => o?.[k] != null && String(o[k]).trim()));
}

/**
 * When CSV provides Customs BOE Ref, declared economics are optional.
 * If present they must match the parent (caller supplies parent) — never silently overwrite.
 */
export function validateInheritedCsvShipmentHeader(header = {}, { existingBoe = false } = {}) {
  const messages = [];
  const hasBoeRef = Boolean(String(header.customsBoeRef || "").trim());
  const linkExisting = existingBoe || hasBoeRef;

  if (!linkExisting && !String(header.boeNumber || "").trim()) messages.push("BOE Number is required");
  if (!linkExisting && !String(header.boeDate || "").trim()) messages.push("BOE Date is required");
  if (!String(header.supplierInvoiceNumber || "").trim()) messages.push("Supplier Invoice Number is required");
  if (!String(header.supplierInvoiceDate || "").trim()) messages.push("Supplier Invoice Date is required");

  if (!linkExisting) {
    const qty = Number(header.boeDeclaredQty);
    if (!String(header.boeDeclaredQty ?? "").trim() || !Number.isFinite(qty) || !(qty > 0)) {
      messages.push("BOE Declared Qty is required");
    }
    const val = Number(header.boeDeclaredValue);
    if (!String(header.boeDeclaredValue ?? "").trim() || !Number.isFinite(val) || val < 0) {
      messages.push("BOE Declared Value is required");
    }
    if (!String(header.customsCurrency || "").trim()) messages.push("Customs Currency is required");
    const cur = String(header.customsCurrency || "").trim().toUpperCase();
    const fx = Number(header.exchangeRateToAED);
    if (cur === "AED") {
      if (String(header.exchangeRateToAED ?? "").trim() && fx !== 1) {
        messages.push("When Customs Currency is AED, Exchange Rate to AED must be 1");
      }
    } else if (!String(header.exchangeRateToAED ?? "").trim() || !Number.isFinite(fx) || !(fx > 0)) {
      messages.push("Exchange Rate to AED is required");
    }
  }
  return messages;
}

/**
 * Reject CSV rows that attempt to override frozen parent BOE economics.
 */
export function validateCsvAgainstExistingBoe(header = {}, parentBoe = null) {
  const messages = [];
  if (!parentBoe) return messages;
  const num = (v) => {
    if (v == null || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const str = (v) => String(v ?? "").trim();
  const qty = num(header.boeDeclaredQty);
  const val = num(header.boeDeclaredValue);
  const fx = num(header.exchangeRateToAED);
  const unit = num(header.customsUnitValue);
  if (qty != null && Math.abs(qty - Number(parentBoe.boeDeclaredQty)) > 1e-6) {
    messages.push(
      `CSV BOE Declared Qty ${qty} conflicts with existing BOE ${parentBoe.customsBoeRef} declared qty ${parentBoe.boeDeclaredQty}.`,
    );
  }
  if (val != null && Math.abs(val - Number(parentBoe.boeDeclaredValue)) > 1e-6) {
    messages.push(
      `CSV BOE Declared Value ${val} conflicts with existing BOE ${parentBoe.customsBoeRef} declared value ${parentBoe.boeDeclaredValue}.`,
    );
  }
  if (fx != null && Math.abs(fx - Number(parentBoe.exchangeRateToAED)) > 1e-6) {
    messages.push(
      `CSV Exchange Rate conflicts with existing BOE ${parentBoe.customsBoeRef}.`,
    );
  }
  if (unit != null && Math.abs(unit - Number(parentBoe.customsUnitValue)) > 1e-6) {
    messages.push(`CSV Customs Unit Value conflicts with frozen unit on ${parentBoe.customsBoeRef}.`);
  }
  const cur = str(header.customsCurrency).toUpperCase();
  if (cur && cur !== String(parentBoe.customsCurrency || "").toUpperCase()) {
    messages.push(`CSV Customs Currency conflicts with existing BOE ${parentBoe.customsBoeRef}.`);
  }
  const gw = num(header.grossWeightKg);
  const nw = num(header.netWeightKg);
  if (gw != null && Math.abs(gw - Number(parentBoe.grossWeightKg || 0)) > 1e-6) {
    messages.push(`CSV Gross Weight conflicts with existing BOE ${parentBoe.customsBoeRef}.`);
  }
  if (nw != null && Math.abs(nw - Number(parentBoe.netWeightKg || 0)) > 1e-6) {
    messages.push(`CSV Net Weight conflicts with existing BOE ${parentBoe.customsBoeRef}.`);
  }
  return messages;
}

export function validateCsvLineAfterInheritance(override = {}, header = {}) {
  const messages = [];
  const coo = String(override.countryOfOrigin || header.countryOfOrigin || "").trim();
  const hs = String(override.hsCode || header.hsCode || "").trim();
  if (!coo) messages.push("Country of Origin is required");
  if (!hs) messages.push("HS Code is required");
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
