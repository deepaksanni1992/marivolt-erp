/**
 * MAN price-list / RFQ helpers (pure). Brand MAN only — not MAK / Wärtsilä.
 */
import {
  canonicalBrandSpelling,
  resolveBrandValue,
} from "./itemMasterTaxonomy.js";
import { UOM_VALUES } from "../models/itemMasterModel.js";
import { canonicalItemMasterPartNumber } from "./partNumberTerminology.js";

export const MAN_PRICE_LIST_ADMIN_ROLES = Object.freeze(["super_admin", "admin"]);
export const MAN_BRAND = "MAN";

export function isManPriceListAdminRole(role) {
  const r = String(role || "").toLowerCase().trim();
  return MAN_PRICE_LIST_ADMIN_ROLES.includes(r);
}

/** Item Master Part Number column is ItemTechnical.spn (falls back to ItemMaster.spn). */
export function displayedItemMasterSpn(item = {}, technical = {}) {
  return canonicalItemMasterPartNumber(item, technical);
}

/**
 * Item Master list "Supplier 1" / "Supplier 1 P/N" are ItemSupplier rows
 * sorted by supplierName, first row — not ItemMaster.supplierPartNumber.
 */
export function displayedSupplier1(supplier1 = null, item = {}) {
  return {
    name: String(supplier1?.supplierName || item?.supplier || ""),
    partNumber: String(supplier1?.supplierPartNumber || ""),
  };
}

export function manRfqRequestHash({ customerId = "", currency = "", lines = [], fxRates = [] } = {}) {
  const payload = {
    customerId: String(customerId || ""),
    currency: String(currency || ""),
    fxRates: normalizeManFxRateList(fxRates).map((r) => ({
      sourceCurrency: r.sourceCurrency,
      targetCurrency: r.targetCurrency,
      rate: r.rate,
    })),
    lines: (lines || []).map((l, idx) => ({
      sourceIndex: idx,
      sourceRowNumber:
        l.sourceRowNumber == null || l.sourceRowNumber === "" ? "" : Number(l.sourceRowNumber),
      article: String(l.article || "").trim().toUpperCase(),
      qty: Number(l.qty) || 0,
      uom: String(l.uom || "").trim().toUpperCase(),
      price: Number(l.price) || 0,
      priceTier: String(l.priceTier || "").trim().toUpperCase(),
      customerPartNo: String(l.customerPartNo || l.requestedPartNo || "").trim(),
      sourceCurrency: normalizeManCurrency(l.sourceCurrency),
      conversionRate: l.conversionRate == null || l.conversionRate === "" ? "" : Number(l.conversionRate),
    })),
  };
  return JSON.stringify(payload);
}

/** Keys that must never appear on Sales / MAN RFQ match payloads (any nesting). */
export const SALES_FORBIDDEN_PRICE_LIST_KEYS = Object.freeze([
  "priceListId",
  "buy",
  "nextBuy",
  "supplierName",
  "supplierPartNumber",
  "supplierId",
  "importId",
  "lastImportId",
  "itemMasterId",
]);

/**
 * Selling-side FX audit Sales may see on match/quotation retrieval.
 * Customer print must never include these (or enteredBy / internal notes).
 */
export const SALES_ALLOWED_FX_AUDIT_KEYS = Object.freeze([
  "sourceCurrency",
  "sourceUnitPrice",
  "conversionRate",
  "convertedCurrency",
  "convertedUnitPrice",
  "manRfqFxRates",
]);

function parentIsPrices(path) {
  return /(^|\.)prices$/.test(path);
}

function isRedactableObject(value) {
  if (value == null || typeof value !== "object") return false;
  if (Array.isArray(value)) return true;
  if (value instanceof Date) return false;
  if (typeof Buffer !== "undefined" && Buffer.isBuffer?.(value)) return false;
  if (typeof value._bsontype === "string") return false;
  return true;
}

/**
 * Recursively collect leaked internal price-list / purchase keys.
 * Quotation and line Mongo `_id` values are allowed; `prices.id` / `prices._id` are not.
 */
export function collectForbiddenSalesPriceKeys(value, path = "", acc = []) {
  if (!isRedactableObject(value)) return acc;
  if (Array.isArray(value)) {
    value.forEach((v, i) => collectForbiddenSalesPriceKeys(v, `${path}[${i}]`, acc));
    return acc;
  }
  for (const [k, v] of Object.entries(value)) {
    const next = path ? `${path}.${k}` : k;
    if (SALES_FORBIDDEN_PRICE_LIST_KEYS.includes(k)) acc.push(next);
    if (parentIsPrices(path) && (k === "id" || k === "_id")) acc.push(next);
    collectForbiddenSalesPriceKeys(v, next, acc);
  }
  return acc;
}

export function assertNoForbiddenSalesPriceKeys(value, label = "payload") {
  const hits = collectForbiddenSalesPriceKeys(value);
  if (hits.length) {
    throw new Error(`${label} leaked forbidden keys: ${hits.join(", ")}`);
  }
  return value;
}

function stripForbiddenSalesKeys(value, { keepPriceListRevision = false, parentKey = "" } = {}) {
  if (!isRedactableObject(value)) return value;
  if (Array.isArray(value)) {
    return value.map((v) => stripForbiddenSalesKeys(v, { keepPriceListRevision, parentKey }));
  }
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (SALES_FORBIDDEN_PRICE_LIST_KEYS.includes(k)) continue;
    if (k === "priceListRevision" && !keepPriceListRevision) continue;
    if (parentKey === "prices" && (k === "id" || k === "_id")) continue;
    out[k] = stripForbiddenSalesKeys(v, { keepPriceListRevision, parentKey: k });
  }
  return out;
}

/** Selling amounts + numeric revision only — never the ManPriceList document id. */
export function toSalesMatchPrices(price, { canRock = false } = {}) {
  if (!price) return null;
  return {
    revision: Number(price.revision) || 0,
    currency: price.currency || "",
    leadTime: price.leadTime || "",
    sellPrice: roundNullableMoney(price.sellPrice),
    sellIi: roundNullableMoney(price.sellIi),
    minm: roundNullableMoney(price.minm),
    rock: canRock ? roundNullableMoney(price.rock) : null,
  };
}

export function redactManRfqMatchResponse(payload = {}) {
  return roundQuotationMoneyFields(stripForbiddenSalesKeys(payload, { keepPriceListRevision: true }));
}

export function redactQuotationForSalesApi(row = {}) {
  if (!row || typeof row !== "object") return row;
  return roundQuotationMoneyFields(stripForbiddenSalesKeys(row, { keepPriceListRevision: false }));
}

export const MAN_PRICE_LIST_HEADERS = Object.freeze([
  "Article",
  "Description",
  "Part no",
  "Sell price",
  "UWT (kg)",
  "Ext. Remarks",
  "Availability",
  "Specs",
  "Sell II",
  "Minm",
  "Rock",
  "Buy",
  "Cur",
  "Supplier part No.",
  "Supplier",
  "Lead time",
  "Next Buy",
]);

export const MAN_PRICE_TIERS = Object.freeze(["SELL", "SELL_II", "MINM", "ROCK"]);

export const TIER_PERMISSION_ACTION = Object.freeze({
  SELL: "price_tier_sell",
  SELL_II: "price_tier_sell_ii",
  MINM: "price_tier_minm",
  ROCK: "price_tier_rock",
});

export const DEFAULT_MAN_TIER = "SELL";
export const DEFAULT_FULFILMENT_WAREHOUSE = "MAIN";
export const LEAD_TIME_UNCONFIRMED = "Lead time to be confirmed";

const FORMULA_PREFIX = /^[=+\-@\t\r]/;

function foldHeader(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

const HEADER_ALIASES = new Map([
  ["sell 2", "Sell II"],
  ["sell ii", "Sell II"],
  ["part no", "Part no"],
  ["part no.", "Part no"],
  ["part number", "Part no"],
  ["spn", "Part no"],
  ["supplier part no.", "Supplier part No."],
  ["supplier part no", "Supplier part No."],
  ["uwt (kg)", "UWT (kg)"],
  ["ext. remarks", "Ext. Remarks"],
  ["ext remarks", "Ext. Remarks"],
  ["next buy", "Next Buy"],
  ["sell price", "Sell price"],
  ["lead time", "Lead time"],
  ["engine model", "Engine model"],
  ["customer line", "Customer line"],
  ["customer reference", "Customer reference"],
  ["specifications", "Specifications"],
]);

export function canonicalCsvHeader(name) {
  const folded = foldHeader(name);
  if (HEADER_ALIASES.has(folded)) return HEADER_ALIASES.get(folded);
  const exact = MAN_PRICE_LIST_HEADERS.find((h) => foldHeader(h) === folded);
  return exact || String(name || "").trim();
}

export function isManEligibleItem(item = {}) {
  const brand = canonicalBrandSpelling(resolveBrandValue(item));
  return brand === MAN_BRAND;
}

/** SPECS row on ItemTechnical, else concatenated spec values. Never a price-list field. */
export function displayedItemMasterSpecs(technical = {}) {
  const list = Array.isArray(technical?.technicalSpecifications) ? technical.technicalSpecifications : [];
  const specsRow = list.find((s) => foldHeader(s?.specName) === "specs");
  if (String(specsRow?.specValue || "").trim()) return String(specsRow.specValue).trim();
  return list
    .map((s) => String(s?.specValue || "").trim())
    .filter(Boolean)
    .join("; ");
}

/** Compare models after trim / case-fold / collapsed spaces. Keep the stored display value elsewhere. */
export function normalizeEngineModel(value) {
  return String(value ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .toUpperCase();
}

export function modelsEquivalent(a, b) {
  const x = normalizeEngineModel(a);
  const y = normalizeEngineModel(b);
  return Boolean(x) && x === y;
}

export function configOrSpecConflict(requested, stored) {
  const a = normalizeEngineModel(requested);
  const b = normalizeEngineModel(stored);
  return Boolean(a && b && a !== b);
}

export const MAN_RFQ_MODEL_MODES = Object.freeze({
  SELECTED: "SELECTED",
  MIXED: "MIXED",
  UNSPECIFIED: "UNSPECIFIED",
});

export const MAN_RFQ_MODEL_ERROR_CODES = Object.freeze({
  MODE_INVALID: "MAN_RFQ_MODEL_MODE_INVALID",
  REQUIRED: "MAN_RFQ_MODEL_REQUIRED",
  CONFLICT: "MAN_RFQ_MODEL_CONFLICT",
  MISMATCH: "MAN_RFQ_MODEL_MISMATCH",
  CONFIG_CONFLICT: "MAN_RFQ_CONFIG_CONFLICT",
  SPEC_CONFLICT: "MAN_RFQ_SPEC_CONFLICT",
});

export const MAN_RFQ_CURRENCY_MISMATCH = "CURRENCY_MISMATCH";
export const MAN_RFQ_FX_RATE_REQUIRED = "FX_RATE_REQUIRED";
/** Technical ceiling only — not a commercial band. Override in tests via the exported constant. */
export const MAN_RFQ_FX_RATE_MAX = 1e8;
export const MAN_RFQ_FX_RATE_DECIMALS = 8;
export const MAN_RFQ_FX_NOTE_MAX = 200;

export function clipManFxNote(value) {
  return String(value || "").trim().slice(0, MAN_RFQ_FX_NOTE_MAX);
}

export function normalizeManCurrency(value) {
  return String(value || "").trim().toUpperCase();
}

export function manCurrenciesMatch(quotationCurrency, priceCurrency) {
  const q = normalizeManCurrency(quotationCurrency);
  const p = normalizeManCurrency(priceCurrency);
  return Boolean(q) && Boolean(p) && q === p;
}

export function manRfqCurrencyMismatchMessage(quotationCurrency, priceCurrency) {
  const q = normalizeManCurrency(quotationCurrency) || "(blank)";
  const p = normalizeManCurrency(priceCurrency) || "(blank)";
  return `Quotation currency is ${q}, but this Article is priced in ${p}.`;
}

export function manRfqFxPairLabel(sourceCurrency, targetCurrency) {
  const s = normalizeManCurrency(sourceCurrency) || "(blank)";
  const t = normalizeManCurrency(targetCurrency) || "(blank)";
  return `1 ${s} = [rate] ${t}`;
}

export function manRfqFxRateRequiredMessage(sourceCurrency, targetCurrency) {
  return `A conversion rate is required (${manRfqFxPairLabel(sourceCurrency, targetCurrency)}).`;
}

export function roundManFxRate(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return NaN;
  const f = 10 ** MAN_RFQ_FX_RATE_DECIMALS;
  return Math.round((n + Number.EPSILON) * f) / f;
}

export function parseManFxRate(value) {
  if (value == null || value === "") {
    return { ok: false, code: "MISSING", message: "Conversion rate is required", rate: undefined };
  }
  const n = typeof value === "number" ? value : Number(String(value).trim());
  if (!Number.isFinite(n)) {
    return { ok: false, code: "INVALID", message: "Conversion rate must be a finite number greater than zero", rate: undefined };
  }
  if (!(n > 0)) {
    return { ok: false, code: "INVALID", message: "Conversion rate must be greater than zero", rate: undefined };
  }
  if (n > MAN_RFQ_FX_RATE_MAX) {
    return {
      ok: false,
      code: "INVALID",
      message: `Conversion rate exceeds the technical maximum of ${MAN_RFQ_FX_RATE_MAX}`,
      rate: undefined,
    };
  }
  return { ok: true, code: "", message: "", rate: roundManFxRate(n) };
}

export function convertManSourceUnitPrice(sourceUnitPrice, rate) {
  const parsed = parseManFxRate(rate);
  if (!parsed.ok) return undefined;
  return roundQuotationMoney(roundQuotationMoney(sourceUnitPrice) * parsed.rate);
}

export function normalizeManFxSnapshot(raw = {}, { requireRate = true } = {}) {
  const sourceCurrency = normalizeManCurrency(raw.sourceCurrency || raw.fromCurrency);
  const targetCurrency = normalizeManCurrency(raw.targetCurrency || raw.toCurrency);
  const parsed = parseManFxRate(raw.rate);
  if (!sourceCurrency || !targetCurrency) {
    return {
      ok: false,
      code: MAN_RFQ_CURRENCY_MISMATCH,
      message: "Conversion rate must name source and target currencies",
    };
  }
  if (requireRate && !parsed.ok) {
    return {
      ok: false,
      code: MAN_RFQ_CURRENCY_MISMATCH,
      message: parsed.message,
      sourceCurrency,
      targetCurrency,
    };
  }
  return {
    ok: true,
    snapshot: {
      sourceCurrency,
      targetCurrency,
      rate: parsed.ok ? parsed.rate : undefined,
      rateDate: raw.rateDate ? String(raw.rateDate).slice(0, 10) : "",
      note: clipManFxNote(raw.note),
    },
  };
}

function fxPairKey(sourceCurrency, targetCurrency) {
  return `${normalizeManCurrency(sourceCurrency)}->${normalizeManCurrency(targetCurrency)}`;
}

function sortManFxSnapshots(rows) {
  return [...rows].sort((a, b) => {
    const s = String(a.sourceCurrency).localeCompare(String(b.sourceCurrency));
    return s !== 0 ? s : String(a.targetCurrency).localeCompare(String(b.targetCurrency));
  });
}

/**
 * First-wins for identical pairs. Conflicting rates for the same pair are rejected.
 */
export function canonicalizeManFxRates(list = []) {
  const rows = Array.isArray(list) ? list : [];
  const byPair = new Map();
  for (const raw of rows) {
    const parsed = normalizeManFxSnapshot(raw, { requireRate: true });
    if (!parsed.ok) {
      return {
        ok: false,
        code: parsed.code || MAN_RFQ_CURRENCY_MISMATCH,
        message: parsed.message,
        sourceCurrency: parsed.sourceCurrency,
        targetCurrency: parsed.targetCurrency,
        snapshots: [],
      };
    }
    const key = fxPairKey(parsed.snapshot.sourceCurrency, parsed.snapshot.targetCurrency);
    const existing = byPair.get(key);
    if (existing && Number(existing.rate) !== Number(parsed.snapshot.rate)) {
      return {
        ok: false,
        code: MAN_RFQ_CURRENCY_MISMATCH,
        message: `Conflicting conversion rates for ${manRfqFxPairLabel(parsed.snapshot.sourceCurrency, parsed.snapshot.targetCurrency)}.`,
        sourceCurrency: parsed.snapshot.sourceCurrency,
        targetCurrency: parsed.snapshot.targetCurrency,
        snapshots: [],
      };
    }
    if (!existing) byPair.set(key, parsed.snapshot);
  }
  return { ok: true, snapshots: sortManFxSnapshots([...byPair.values()]) };
}

/** First-wins unique pairs, sorted by source then target. Conflicting pairs are ignored here; create rejects them. */
export function normalizeManFxRateList(list = []) {
  const rows = Array.isArray(list) ? list : [];
  const byPair = new Map();
  for (const raw of rows) {
    const parsed = normalizeManFxSnapshot(raw, { requireRate: true });
    if (!parsed.ok) continue;
    const key = fxPairKey(parsed.snapshot.sourceCurrency, parsed.snapshot.targetCurrency);
    if (!byPair.has(key)) byPair.set(key, parsed.snapshot);
  }
  return sortManFxSnapshots([...byPair.values()]);
}

export function findManFxSnapshot(list, sourceCurrency, targetCurrency) {
  const source = normalizeManCurrency(sourceCurrency);
  const target = normalizeManCurrency(targetCurrency);
  if (!source || !target) return null;
  return (
    normalizeManFxRateList(list).find((r) => r.sourceCurrency === source && r.targetCurrency === target) || null
  );
}

/**
 * Price-list amounts stay in the stored row currency until a header conversion rate is applied.
 * Never relabel a source amount as another currency, invert a rate, or convert a converted value.
 */
export function applyManRfqCurrencyPricing({
  quotationCurrency,
  sourceCurrency,
  priceCurrency,
  sourceUnitPrice,
  unitPrice,
  status,
  fxRates = [],
} = {}) {
  const source = normalizeManCurrency(sourceCurrency || priceCurrency);
  const target = normalizeManCurrency(quotationCurrency);
  const original = roundQuotationMoney(sourceUnitPrice != null ? sourceUnitPrice : unitPrice);
  if (!target) {
    return {
      ok: false,
      status: MAN_RFQ_CURRENCY_MISMATCH,
      unitPrice: undefined,
      sourceUnitPrice: original,
      sourceCurrency: source,
      convertedCurrency: "",
      convertedUnitPrice: undefined,
      conversionRate: undefined,
      priceCurrency: source,
      reason: "Quotation currency is required",
    };
  }
  if (!source) {
    return {
      ok: false,
      status: MAN_RFQ_CURRENCY_MISMATCH,
      unitPrice: undefined,
      sourceUnitPrice: original,
      sourceCurrency: "",
      convertedCurrency: target,
      convertedUnitPrice: undefined,
      conversionRate: undefined,
      priceCurrency: "",
      reason: "Price-list currency is required",
    };
  }
  if (manCurrenciesMatch(target, source)) {
    return {
      ok: true,
      status: status || "MATCHED",
      unitPrice: original,
      sourceUnitPrice: original,
      sourceCurrency: source,
      convertedCurrency: target,
      convertedUnitPrice: original,
      conversionRate: 1,
      priceCurrency: source,
      reason: "",
    };
  }
  const snap = findManFxSnapshot(fxRates, source, target);
  if (!snap) {
    return {
      ok: false,
      status: MAN_RFQ_FX_RATE_REQUIRED,
      unitPrice: undefined,
      sourceUnitPrice: original,
      sourceCurrency: source,
      convertedCurrency: target,
      convertedUnitPrice: undefined,
      conversionRate: undefined,
      priceCurrency: source,
      reason: manRfqFxRateRequiredMessage(source, target),
    };
  }
  const converted = convertManSourceUnitPrice(original, snap.rate);
  if (converted == null) {
    return {
      ok: false,
      status: MAN_RFQ_CURRENCY_MISMATCH,
      unitPrice: undefined,
      sourceUnitPrice: original,
      sourceCurrency: source,
      convertedCurrency: target,
      convertedUnitPrice: undefined,
      conversionRate: undefined,
      priceCurrency: source,
      reason: `Conversion rate for ${manRfqFxPairLabel(source, target)} is invalid.`,
    };
  }
  return {
    ok: true,
    status: status || "MATCHED",
    unitPrice: converted,
    sourceUnitPrice: original,
    sourceCurrency: source,
    convertedCurrency: target,
    convertedUnitPrice: converted,
    conversionRate: snap.rate,
    priceCurrency: source,
    fxSnapshot: snap,
    reason: "",
  };
}

export function applyManRfqCurrencyGate(args = {}) {
  return applyManRfqCurrencyPricing(args);
}

/** Canonical mode or empty. Never defaults unknown values to SELECTED. */
export function canonicalManRfqModelMode(value) {
  const v = String(value ?? "").trim().toUpperCase();
  if (v === MAN_RFQ_MODEL_MODES.SELECTED) return MAN_RFQ_MODEL_MODES.SELECTED;
  if (v === MAN_RFQ_MODEL_MODES.MIXED) return MAN_RFQ_MODEL_MODES.MIXED;
  if (v === MAN_RFQ_MODEL_MODES.UNSPECIFIED) return MAN_RFQ_MODEL_MODES.UNSPECIFIED;
  return "";
}

/**
 * Shared match/create parser.
 * Legacy: omitted mode + a header model infers SELECTED.
 * Unknown mode values are rejected — never silently treated as SELECTED.
 */
export function resolveManRfqRequestMode({ modelMode, headerModel } = {}) {
  const header = String(headerModel || "").trim();
  const raw = modelMode == null ? "" : String(modelMode).trim();
  if (!raw) {
    if (header) {
      return { ok: true, mode: MAN_RFQ_MODEL_MODES.SELECTED, headerModel: header, inferred: true };
    }
    return {
      ok: false,
      code: MAN_RFQ_MODEL_ERROR_CODES.REQUIRED,
      message: "Select a MAN engine model, mixed models, or model not specified",
    };
  }
  const mode = canonicalManRfqModelMode(raw);
  if (!mode) {
    return {
      ok: false,
      code: MAN_RFQ_MODEL_ERROR_CODES.MODE_INVALID,
      message: "modelMode must be SELECTED, MIXED, or UNSPECIFIED",
    };
  }
  return { ok: true, mode, headerModel: header, inferred: false };
}

/** @deprecated Use canonicalManRfqModelMode / resolveManRfqRequestMode. Unknown returns "". */
export function parseManRfqModelMode(value) {
  return canonicalManRfqModelMode(value);
}

export function modelIsKnownManEngine(knownModels = [], value) {
  const needle = normalizeEngineModel(value);
  if (!needle) return false;
  return (knownModels || []).some((m) => normalizeEngineModel(m) === needle);
}

/** Selected Article only — never candidates[0] and never a silent article fallback. */
export function selectedManRfqCandidate(line = {}) {
  const article = String(line.selectedArticle || "").trim();
  if (!article) return null;
  const found = (line.candidates || []).find((c) => String(c?.article || "").trim() === article);
  return found || null;
}

/**
 * Distinct MAN Item Master model display values, keyed by normalized form.
 * First stored spelling wins; non-MAN brands are ignored.
 */
export function uniqueManEngineModels(items = []) {
  const byNorm = new Map();
  for (const item of items) {
    if (!isManEligibleItem(item)) continue;
    const display = String(item.model || "").trim();
    if (!display) continue;
    const key = normalizeEngineModel(display);
    if (!key) continue;
    if (!byNorm.has(key)) byNorm.set(key, display);
  }
  return [...byNorm.values()].sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));
}

export function uniqueDisplayModels(records = []) {
  const byNorm = new Map();
  for (const row of records) {
    const display = String(row?.model || "").trim();
    if (!display) continue;
    const key = normalizeEngineModel(display);
    if (!key) continue;
    if (!byNorm.has(key)) byNorm.set(key, display);
  }
  return [...byNorm.values()];
}

/**
 * Header model fills blank RFQ line cells. A different line model is a conflict
 * unless the RFQ is mixed or model-not-specified.
 */
export function resolveRfqLineModel({ headerMode = "SELECTED", headerModel = "", lineModel = "" } = {}) {
  const mode = canonicalManRfqModelMode(headerMode) || (headerMode ? "" : MAN_RFQ_MODEL_MODES.SELECTED);
  const header = String(headerModel || "").trim();
  const line = String(lineModel || "").trim();
  const lineModelMissing = !line;

  if (mode === MAN_RFQ_MODEL_MODES.MIXED) {
    return {
      mode,
      originalCustomerModel: line,
      resolvedModel: line,
      lineModelMissing,
      headerLineConflict: false,
    };
  }
  if (mode === MAN_RFQ_MODEL_MODES.UNSPECIFIED) {
    return {
      mode,
      originalCustomerModel: line,
      resolvedModel: line,
      lineModelMissing,
      headerLineConflict: false,
    };
  }
  if (mode === MAN_RFQ_MODEL_MODES.SELECTED) {
    return {
      mode: MAN_RFQ_MODEL_MODES.SELECTED,
      originalCustomerModel: line,
      resolvedModel: line || header,
      lineModelMissing,
      headerLineConflict: Boolean(header && line && !modelsEquivalent(header, line)),
    };
  }
  return {
    mode: "",
    originalCustomerModel: line,
    resolvedModel: line,
    lineModelMissing,
    headerLineConflict: false,
  };
}

/** Conservative part-no match: trim, collapse spaces, case-fold. Keep zeros and punctuation. */
export function normalizePartNoForMatch(value) {
  return String(value ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .toUpperCase();
}

export function preserveArticleCode(value) {
  return String(value ?? "").trim().toUpperCase();
}

export function cellIsBlank(value) {
  if (value == null) return true;
  return String(value).trim() === "";
}

/**
 * Parse a monetary cell. Blank is missing (not zero).
 * Preserves source precision as a number when valid.
 */
export function parseOptionalMoney(raw) {
  if (cellIsBlank(raw)) return { present: false, value: null, error: "" };
  const text = String(raw).trim().replace(/,/g, "");
  if (!/^-?\d+(\.\d+)?$/.test(text)) {
    return { present: true, value: null, error: `Invalid number: ${raw}` };
  }
  const value = Number(text);
  if (!Number.isFinite(value)) {
    return { present: true, value: null, error: `Invalid number: ${raw}` };
  }
  if (value < 0) {
    return { present: true, value, error: "Negative prices are not allowed" };
  }
  return { present: true, value, error: "" };
}

const QUOTATION_MONEY_FIELD_KEYS = new Set([
  "price",
  "totalPrice",
  "unitPrice",
  "sourceUnitPrice",
  "convertedUnitPrice",
  "subTotal",
  "discountTotal",
  "taxTotal",
  "packingCost",
  "clearanceCost",
  "grandTotal",
  "sellPrice",
  "sellIi",
  "minm",
  "rock",
]);

export function roundQuotationMoney(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export function quotationLineTotal(unitPrice, qty) {
  const unit = roundQuotationMoney(unitPrice);
  const q = Number(qty);
  if (!Number.isFinite(q)) return 0;
  return roundQuotationMoney(unit * q);
}

export function formatQuotationMoney(value) {
  const rounded = roundQuotationMoney(value);
  const negative = rounded < 0;
  const [whole, frac] = Math.abs(rounded).toFixed(2).split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}${grouped}.${frac}`;
}

function roundNullableMoney(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return roundQuotationMoney(n);
}

export function roundQuotationMoneyFields(value) {
  if (Array.isArray(value)) return value.map(roundQuotationMoneyFields);
  if (!isRedactableObject(value)) return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (QUOTATION_MONEY_FIELD_KEYS.has(k)) {
      out[k] = v == null || v === "" ? v : roundQuotationMoney(v);
    } else {
      out[k] = roundQuotationMoneyFields(v);
    }
  }
  return out;
}

export function sanitizeCsvFormula(value) {
  const s = value == null ? "" : String(value);
  if (FORMULA_PREFIX.test(s)) return `'${s}`;
  return s;
}

export function escapeCsvCell(value) {
  const s = sanitizeCsvFormula(value == null ? "" : String(value));
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function buildCsv(headers, rows) {
  const lines = [headers.map(escapeCsvCell).join(",")];
  for (const row of rows) {
    lines.push(headers.map((h) => escapeCsvCell(row[h] ?? "")).join(","));
  }
  return `\uFEFF${lines.join("\r\n")}`;
}

export function mapCsvRow(data = {}) {
  const out = {};
  for (const [k, v] of Object.entries(data)) {
    out[canonicalCsvHeader(k)] = v;
  }
  return out;
}

export function rowHasDuplicateArticle(articles) {
  const seen = new Map();
  const dupes = [];
  for (const a of articles) {
    const key = preserveArticleCode(a);
    if (!key) continue;
    const n = (seen.get(key) || 0) + 1;
    seen.set(key, n);
    if (n === 2) dupes.push(key);
  }
  return dupes;
}

export function mergeBlankPreserving(existing, incoming, keys) {
  const next = { ...existing };
  const changed = {};
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(incoming, key)) continue;
    const val = incoming[key];
    if (val === undefined || cellIsBlank(val)) continue;
    if (String(next[key] ?? "") !== String(val)) changed[key] = { from: next[key] ?? "", to: val };
    next[key] = val;
  }
  return { next, changed };
}

export function formatManAvailability({
  availableQty = 0,
  requestedQty = 0,
  uom = "PCS",
  leadTime = "",
} = {}) {
  const avail = Number(availableQty) || 0;
  const req = Number(requestedQty) || 0;
  const unit = String(uom || "PCS").trim() || "PCS";
  const lead = String(leadTime || "").trim() || LEAD_TIME_UNCONFIRMED;
  if (avail >= req && req > 0) return "Ex-Stock";
  if (avail > 0 && req > avail) {
    const balance = req - avail;
    return `${avail} ${unit} Ex-Stock; balance ${balance} ${unit}: ${lead}`;
  }
  return lead;
}

export function formatExportAvailability({ availableQty = 0, leadTime = "" } = {}) {
  const avail = Number(availableQty) || 0;
  if (avail > 0) return "Ex-Stock";
  return String(leadTime || "").trim() || LEAD_TIME_UNCONFIRMED;
}

export function normalizeRfqUom(value) {
  const u = String(value || "").trim().toUpperCase();
  return UOM_VALUES.includes(u) ? u : u;
}

export function uomsCompatible(itemUom, requestedUom) {
  const a = String(itemUom || "").trim().toUpperCase();
  const b = String(requestedUom || "").trim().toUpperCase();
  if (!a || !b) return false;
  return a === b;
}

export function permittedTiersForMatrix(matrix = {}, { isAdmin = false } = {}) {
  if (isAdmin) return [...MAN_PRICE_TIERS];
  const sales = new Set(matrix.SALES || []);
  return MAN_PRICE_TIERS.filter((tier) => sales.has(TIER_PERMISSION_ACTION[tier]));
}

export function publicSellingPrices(record = {}) {
  return {
    sellPrice: record.sellPrice ?? null,
    sellIi: record.sellIi ?? null,
    minm: record.minm ?? null,
    rock: record.rock ?? null,
    currency: record.currency || "",
  };
}

export function stripPurchaseFields(record = {}) {
  const {
    buy: _buy,
    nextBuy: _nextBuy,
    supplierName: _s,
    supplierId: _sid,
    supplierPartNumber: _spn,
    ...rest
  } = record;
  return rest;
}

export function isoTimestamp(value) {
  if (!value) return "";
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString();
}

export function shouldSkipUnchangedImport({ creating = false, hasItemChanges = false, beforeHash = "", nextHash = "" } = {}) {
  return !creating && !hasItemChanges && beforeHash === nextHash;
}

function compatibleManCandidates(pool = []) {
  return pool.filter((c) => c.uomOk && c.prices && c.pricingOk && !c.modelConflict && !c.configConflict);
}

/**
 * Classify MAN RFQ candidates after exact Part Number matching.
 * Never picks the cheapest Article, never matches by model alone, never auto-picks a similar Part Number.
 * Pass opts for engine-model aware statuses; omit opts to keep the legacy review path.
 */
export function classifyManRfqCandidates(candidates = [], opts = {}) {
  const hasOpts = Boolean(
    opts &&
      (opts.headerMode ||
        opts.resolvedModel ||
        opts.headerLineConflict ||
        opts.lineModelMissing ||
        opts.modelAware)
  );
  if (!hasOpts) {
    const compatible = compatibleManCandidates(candidates);
    if (!candidates.length) {
      return { status: "NOT_FOUND", reason: "Not found", pick: null, compatible, availableModels: [] };
    }
    if (candidates.some((c) => !c.uomOk || c.modelConflict) && compatible.length !== 1) {
      return {
        status: "REVIEW",
        reason: "UOM or model/configuration requires review",
        pick: null,
        compatible,
        availableModels: uniqueDisplayModels(candidates),
      };
    }
    if (candidates.every((c) => !c.prices || !c.pricingOk)) {
      return {
        status: "PRICING_REQUIRED",
        reason: "Pricing required",
        pick: null,
        compatible,
        availableModels: uniqueDisplayModels(candidates),
      };
    }
    if (compatible.length > 1) {
      return {
        status: "MULTIPLE",
        reason: "Multiple eligible Articles — select one",
        pick: null,
        compatible,
        availableModels: uniqueDisplayModels(candidates),
      };
    }
    if (compatible.length === 1) {
      return {
        status: "MATCHED",
        reason: "",
        pick: compatible[0],
        compatible,
        availableModels: uniqueDisplayModels(candidates),
      };
    }
    return {
      status: "REVIEW",
      reason: "Requires review",
      pick: null,
      compatible,
      availableModels: uniqueDisplayModels(candidates),
    };
  }

  const headerMode = canonicalManRfqModelMode(opts.headerMode);
  const resolvedModel = String(opts.resolvedModel || "").trim();
  const availableModels = uniqueDisplayModels(candidates);

  if (opts.headerLineConflict) {
    return {
      status: "MODEL_CONFLICT",
      reason: "Line Engine Model differs from the header Engine Model",
      pick: null,
      compatible: [],
      availableModels,
    };
  }
  if (headerMode === MAN_RFQ_MODEL_MODES.MIXED && opts.lineModelMissing) {
    return {
      status: "MODEL_REQUIRED",
      reason: "Engine Model is required on each line for mixed-model RFQs",
      pick: null,
      compatible: [],
      availableModels,
    };
  }
  if (!candidates.length) {
    return { status: "NOT_FOUND", reason: "Not found", pick: null, compatible: [], availableModels: [] };
  }

  const inResolvedModel = resolvedModel
    ? candidates.filter((c) => modelsEquivalent(c.model, resolvedModel))
    : candidates;
  const otherModels = uniqueDisplayModels(
    candidates.filter((c) => resolvedModel && !modelsEquivalent(c.model, resolvedModel))
  );

  if (resolvedModel && !inResolvedModel.length && otherModels.length) {
    return {
      status: "MODEL_MISMATCH",
      reason: "Part Number exists under other MAN models",
      pick: null,
      compatible: [],
      availableModels: otherModels,
    };
  }

  const pool = resolvedModel ? inResolvedModel : candidates;
  const compatible = compatibleManCandidates(pool);
  const poolModels = uniqueDisplayModels(pool);

  if (headerMode === MAN_RFQ_MODEL_MODES.UNSPECIFIED && !resolvedModel && poolModels.length > 1) {
    return {
      status: "MULTIPLE",
      reason: "Part Number exists across multiple MAN models — select one Article",
      pick: null,
      compatible: [],
      availableModels: poolModels,
    };
  }

  if (pool.length && pool.every((c) => !c.uomOk) && !compatible.length) {
    return {
      status: "UOM_MISMATCH",
      reason: "UOM is incompatible with the matched Article",
      pick: null,
      compatible: [],
      availableModels: poolModels,
    };
  }

  if (pool.length && pool.every((c) => !c.prices || !c.pricingOk) && pool.some((c) => c.uomOk)) {
    return {
      status: "PRICING_REQUIRED",
      reason: "Pricing required",
      pick: null,
      compatible,
      availableModels: poolModels,
    };
  }

  if (compatible.length > 1) {
    return {
      status: "MULTIPLE",
      reason: "Multiple eligible Articles — select one",
      pick: null,
      compatible,
      availableModels: poolModels,
    };
  }
  if (compatible.length === 1) {
    return {
      status: "MATCHED",
      reason: "",
      pick: compatible[0],
      compatible,
      availableModels: poolModels,
    };
  }
  return {
    status: "REVIEW",
    reason: "Requires review",
    pick: null,
    compatible,
    availableModels: poolModels,
  };
}

const CUSTOMER_PRINT_LINE_KEYS = [
  "serialNo",
  "description",
  "partNumber",
  "article",
  "qty",
  "uom",
  "price",
  "totalPrice",
  "remarks",
  "materialCode",
  "availability",
  "customerPartNo",
];

const CUSTOMER_PRINT_STRIP_HEADER_KEYS = [
  "internalNotes",
  "manRfqIdempotencyKey",
  "manRfqRequestHash",
  "manRfqModelMode",
  "manRfqFxRates",
];

/** Customer PDF/export: selected selling price and customer-facing fields only. */
export function sanitizeCustomerQuotationPrint(row = {}) {
  const header = { ...row };
  for (const k of CUSTOMER_PRINT_STRIP_HEADER_KEYS) {
    delete header[k];
  }
  return roundQuotationMoneyFields({
    ...header,
    internalNotes: "",
    manRfqIdempotencyKey: "",
    manRfqRequestHash: "",
    manRfqModelMode: "",
    manRfqFxRates: [],
    lines: (row.lines || []).map((line) => {
      const out = {};
      for (const k of CUSTOMER_PRINT_LINE_KEYS) {
        if (line[k] != null) out[k] = line[k];
      }
      return out;
    }),
  });
}

export function selectTierUnitPrice(record, tier) {
  const t = String(tier || DEFAULT_MAN_TIER).toUpperCase();
  if (t === "SELL") return record?.sellPrice;
  if (t === "SELL_II") return record?.sellIi;
  if (t === "MINM") return record?.minm;
  if (t === "ROCK") return record?.rock;
  return null;
}

export function tierIsSelectable(record, tier) {
  const price = selectTierUnitPrice(record, tier);
  return price != null && Number.isFinite(Number(price));
}

export function contentFingerprint(payload) {
  return JSON.stringify(payload);
}

export function parseRfqCsvRow(data = {}) {
  const mapped = mapCsvRow(data);
  return {
    partNo: mapped["Part no"] ?? mapped["Part No"] ?? mapped["Part Number"] ?? mapped.SPN ?? "",
    uom: mapped.UOM ?? mapped.Uom ?? "",
    qty: mapped.Qty ?? mapped.QTY ?? mapped.Quantity ?? "",
    customerLine: mapped["Customer line"] ?? mapped.Reference ?? mapped["Customer Line"] ?? "",
    customerReference: mapped["Customer reference"] ?? mapped["Customer Reference"] ?? "",
    description: mapped.Description ?? "",
    engineModel: mapped["Engine model"] ?? mapped.Model ?? mapped["Engine Model"] ?? "",
    configuration: mapped.Configuration ?? "",
    specifications: mapped.Specifications ?? mapped.Specs ?? mapped["Ext. Remarks"] ?? "",
  };
}
