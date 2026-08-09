import Counter from "../models/Counter.js";

/**
 * Sales document numbering (P1).
 *
 * Canonical for NEW QT / OA / PI / ALLOC / SI / SD:
 *   XX/YYMMDD.ab   e.g. QT/260808.01
 *
 * Counter scope: companyId + documentType + UAE business date (Asia/Dubai).
 * Counter key:   salesdoc:{TYPE}:{YYMMDD}
 * Atomic:        Counter.findOneAndUpdate $inc upsert
 *
 * Legacy lifetime format {CMP}-{PREFIX}-{####} remains for Packing, StoreDispatch
 * (DISPATCH), Sales Return, CIPL, Payment Receipt, Article Conversion, etc.
 *
 * Reference-date rule (P1):
 *   Daily sequence uses the UAE calendar date of the generation instant
 *   (referenceDate if provided and valid, else Date.now()). Prefer creation
 *   clock — do not pass editable document dates into the generator so
 *   backdating cannot consume historical daily counters.
 *
 * numberSeriesService is NOT used for live Sales documents.
 */

export const DEFAULT_SALES_DOC_TIMEZONE = "Asia/Dubai";

/** P1 document types and display prefixes (OA = Order Acknowledgement only). */
export const SALES_DOCUMENT_TYPES = Object.freeze({
  QT: "QT",
  OA: "OA",
  PI: "PI",
  ALLOC: "ALLOC",
  SI: "SI",
  SD: "SD",
});

/** Maps existing salesDocNumber docKey → P1 documentType. */
const DOCKEY_TO_P1_TYPE = Object.freeze({
  QUOTATION: "QT",
  ORDER_ACK: "OA",
  PROFORMA: "PI",
  ORDER_ALLOCATION: "ALLOC",
  SALES_INVOICE: "SI",
  SALES_DISPATCH: "SD",
});

const LEGACY_DOC_NUMBER_CONFIG = {
  QUOTATION: { key: "quotation", prefix: "QTN" },
  ORDER_ACK: { key: "oa", prefix: "OA" },
  PROFORMA: { key: "pi", prefix: "PI" },
  ORDER_ALLOCATION: { key: "allocation", prefix: "ALLOC" },
  PACKING: { key: "packing", prefix: "PK" },
  // StoreDispatch only — must NOT share SD daily sequence with SalesDispatch
  SALES_DISPATCH: { key: "dispatch", prefix: "DSP" },
  DISPATCH: { key: "dispatch", prefix: "DSP" },
  SALES_RETURN: { key: "salesReturn", prefix: "SR" },
  CIPL: { key: "cipl", prefix: "CIPL" },
  PAYMENT_RECEIPT: { key: "paymentReceipt", prefix: "RCPT" },
  ARTICLE_STOCK_CONVERSION: { key: "articleStockConversion", prefix: "STC" },
};

function toValidDate(value) {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (value == null || value === "") return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Resolve IANA timezone; invalid/empty → Asia/Dubai.
 * @param {string} [companyTimezone]
 */
export function resolveSalesDocTimezone(companyTimezone) {
  const tz = String(companyTimezone || "").trim();
  if (!tz) return DEFAULT_SALES_DOC_TIMEZONE;
  try {
    Intl.DateTimeFormat("en-US", { timeZone: tz }).format(new Date());
    return tz;
  } catch {
    return DEFAULT_SALES_DOC_TIMEZONE;
  }
}

/**
 * UAE (or company) business date parts for an instant.
 * @param {Date|string|number} [instant]
 * @param {string} [timeZone]
 */
export function getBusinessDateParts(instant = new Date(), timeZone = DEFAULT_SALES_DOC_TIMEZONE) {
  const d = toValidDate(instant) || new Date();
  const tz = resolveSalesDocTimezone(timeZone);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);
  const map = {};
  for (const p of parts) {
    if (p.type !== "literal") map[p.type] = p.value;
  }
  const yyyy = String(map.year || "");
  const yy = yyyy.slice(-2);
  const mm = String(map.month || "").padStart(2, "0");
  const dd = String(map.day || "").padStart(2, "0");
  return { yyyy, yy, mm, dd, token: `${yy}${mm}${dd}`, timeZone: tz };
}

/** @returns {string} YYMMDD in business timezone */
export function getBusinessDateToken(instant = new Date(), timeZone = DEFAULT_SALES_DOC_TIMEZONE) {
  return getBusinessDateParts(instant, timeZone).token;
}

/**
 * Resolve P1 document type from QT|OA|PI|ALLOC|SI|SD or legacy docKey.
 * @returns {string|null}
 */
export function resolveSalesDocumentType(documentTypeOrDocKey) {
  const u = String(documentTypeOrDocKey || "")
    .trim()
    .toUpperCase();
  if (!u) return null;
  if (SALES_DOCUMENT_TYPES[u]) return u;
  return DOCKEY_TO_P1_TYPE[u] || null;
}

export function isP1SalesDocumentType(documentTypeOrDocKey) {
  return Boolean(resolveSalesDocumentType(documentTypeOrDocKey));
}

/**
 * Counter key for P1 daily sequences (companyId is separate Counter field).
 * @example salesdoc:QT:260808
 */
export function salesDocumentCounterKey(documentType, dateToken) {
  const type = resolveSalesDocumentType(documentType);
  if (!type) throw new Error(`Unsupported sales documentType: ${documentType}`);
  const token = String(dateToken || "").trim();
  if (!/^\d{6}$/.test(token)) {
    throw new Error(`Invalid sales document date token: ${dateToken}`);
  }
  return `salesdoc:${type}:${token}`;
}

/**
 * Format allocated sequence into XX/YYMMDD.ab (padStart 2; allows 100+).
 */
export function formatSalesDocumentNumber(documentType, dateToken, seq) {
  const type = resolveSalesDocumentType(documentType);
  if (!type) throw new Error(`Unsupported sales documentType: ${documentType}`);
  const n = Number(seq);
  if (!(n > 0) || !Number.isFinite(n)) {
    throw new Error(`Invalid sales document sequence: ${seq}`);
  }
  return `${type}/${dateToken}.${String(Math.trunc(n)).padStart(2, "0")}`;
}

export function normalizeCompanyCode(companyCode) {
  const raw = String(companyCode || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
  if (raw === "OKE" || raw === "OKEANOS") return "OKE";
  if (raw === "MAR" || raw === "MARIVOLT") return "MAR";
  return raw.slice(0, 3) || "CMP";
}

/** Legacy lifetime counter key helper (Packing / StoreDispatch / etc.). */
export function salesDocCounterKey(docKey, companyCode) {
  const safeKey = String(docKey || "")
    .trim()
    .toUpperCase();
  const config = LEGACY_DOC_NUMBER_CONFIG[safeKey];
  if (!config) throw new Error(`Unsupported sales docKey: ${safeKey}`);
  return `${config.key}:${normalizeCompanyCode(companyCode)}`;
}

/**
 * Atomic $inc for a company-scoped counter key.
 * @param {{ companyId: any, key: string, CounterModel?: typeof Counter }} args
 */
export async function incrementCompanyCounter({ companyId, key, CounterModel = Counter }) {
  if (!companyId) throw new Error("companyId required for counter increment");
  if (!key) throw new Error("counter key required");
  const row = await CounterModel.findOneAndUpdate(
    { companyId, key },
    {
      $setOnInsert: { companyId, key },
      $inc: { seq: 1 },
    },
    { upsert: true, new: true, setDefaultsOnInsert: false, lean: true }
  );
  const seq = Number(row?.seq) || 0;
  if (!(seq > 0)) throw new Error(`Failed to increment counter ${key}`);
  return seq;
}

/**
 * Canonical P1 generator — NEW sales documents only.
 *
 * @param {{
 *   companyId: any,
 *   documentType: string,
 *   referenceDate?: Date|string|number,
 *   timezone?: string,
 *   CounterModel?: typeof Counter,
 * }} args
 * @returns {Promise<string>} e.g. QT/260808.01
 */
export async function generateSalesDocumentNumber({
  companyId,
  documentType,
  referenceDate,
  timezone = DEFAULT_SALES_DOC_TIMEZONE,
  CounterModel = Counter,
}) {
  const type = resolveSalesDocumentType(documentType);
  if (!type) throw new Error(`Unsupported sales documentType: ${documentType}`);
  if (!companyId) throw new Error("companyId required to generate sales document number");

  const instant = toValidDate(referenceDate) || new Date();
  const tz = resolveSalesDocTimezone(timezone);
  const { token } = getBusinessDateParts(instant, tz);
  const key = salesDocumentCounterKey(type, token);
  const seq = await incrementCompanyCounter({ companyId, key, CounterModel });
  return formatSalesDocumentNumber(type, token, seq);
}

async function nextLegacySalesDocNumber({ companyId, companyCode, docKey, CounterModel = Counter }) {
  const safeKey = String(docKey || "")
    .trim()
    .toUpperCase();
  const config = LEGACY_DOC_NUMBER_CONFIG[safeKey];
  if (!config) throw new Error(`Unsupported sales docKey: ${safeKey}`);
  const code = normalizeCompanyCode(companyCode);
  const key = `${config.key}:${code}`;
  const seq = await incrementCompanyCounter({ companyId, key, CounterModel });
  return `${code}-${config.prefix}-${String(seq).padStart(4, "0")}`;
}

/**
 * Compatibility entry point used by controllers.
 * P1 types (QT/OA/PI/ALLOC/SI/SD via docKey) → generateSalesDocumentNumber.
 * Other keys → legacy {CMP}-{PREFIX}-{####}.
 *
 * Note: SALES_DISPATCH uses P1 SD daily sequence.
 * DISPATCH (StoreDispatch) remains legacy and keeps the dispatch:{CMP} counter.
 */
export async function nextSalesDocNumber({
  companyId,
  companyCode,
  docKey,
  referenceDate,
  timezone,
  CounterModel = Counter,
}) {
  const safeKey = String(docKey || "")
    .trim()
    .toUpperCase();
  const p1Type = resolveSalesDocumentType(safeKey);
  // StoreDispatch uses DISPATCH — never route DISPATCH through P1 SD.
  if (p1Type && safeKey !== "DISPATCH") {
    return generateSalesDocumentNumber({
      companyId,
      documentType: p1Type,
      referenceDate,
      timezone,
      CounterModel,
    });
  }
  return nextLegacySalesDocNumber({ companyId, companyCode, docKey: safeKey, CounterModel });
}

export async function nextUniqueSalesDocNumber({
  companyId,
  companyCode,
  docKey,
  model,
  field,
  referenceDate,
  timezone,
  maxAttempts = 25,
  CounterModel = Counter,
}) {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const number = await nextSalesDocNumber({
      companyId,
      companyCode,
      docKey,
      referenceDate,
      timezone,
      CounterModel,
    });
    if (!model || !field) return number;
    const exists = await model.exists({ companyId, [field]: number });
    if (!exists) return number;
  }
  throw new Error(`Unable to allocate a unique ${docKey} number after ${maxAttempts} attempts`);
}

/**
 * Preview next automatic number without consuming the counter.
 * Display-only — create path remains authoritative.
 */
export async function peekNextSalesDocumentNumber({
  companyId,
  documentType,
  referenceDate,
  timezone = DEFAULT_SALES_DOC_TIMEZONE,
  CounterModel = Counter,
}) {
  const type = resolveSalesDocumentType(documentType);
  if (!type) throw new Error(`Unsupported sales documentType: ${documentType}`);
  if (!companyId) throw new Error("companyId required to peek sales document number");
  const instant = toValidDate(referenceDate) || new Date();
  const tz = resolveSalesDocTimezone(timezone);
  const { token } = getBusinessDateParts(instant, tz);
  const key = salesDocumentCounterKey(type, token);
  const row = await CounterModel.findOne({ companyId, key }).lean();
  const nextSeq = (Number(row?.seq) || 0) + 1;
  return formatSalesDocumentNumber(type, token, nextSeq);
}

export const SALES_DOC_NUMBER_MAX_LENGTH = 80;

/** Safe printable characters for manual document numbers. */
const MANUAL_NUMBER_SAFE_RE = /^[A-Za-z0-9 _\-\/\.()]+$/;

const DOCUMENT_TYPE_LABELS = Object.freeze({
  QT: "Quotation",
  OA: "Order Acknowledgement",
  PI: "Proforma Invoice",
  ALLOC: "Order Allocation",
  SI: "Sales Invoice",
  SD: "Sales Dispatch",
});

export function salesDocumentTypeLabel(documentTypeOrDocKey) {
  const type = resolveSalesDocumentType(documentTypeOrDocKey);
  return (type && DOCUMENT_TYPE_LABELS[type]) || "Document";
}

function statusError(message, statusCode = 400) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

/**
 * Parse XX/YYMMDD.ab (sequence may be 1+ digits).
 * Canonical prefixes normalize to uppercase; custom strings are noncanonical.
 */
export function parseCanonicalSalesDocumentNumber(number) {
  const raw = String(number ?? "").trim();
  if (!raw) return { isCanonical: false, raw: "" };
  const m = raw.match(/^(QT|OA|PI|ALLOC|SI|SD)\/(\d{6})\.(\d+)$/i);
  if (!m) return { isCanonical: false, raw };
  const documentType = m[1].toUpperCase();
  const dateToken = m[2];
  const sequence = Number.parseInt(m[3], 10);
  if (!(sequence > 0) || !Number.isFinite(sequence)) {
    return { isCanonical: false, raw };
  }
  return {
    isCanonical: true,
    documentType,
    dateToken,
    sequence,
    normalized: formatSalesDocumentNumber(documentType, dateToken, sequence),
    raw,
  };
}

/**
 * Synchronous validation for manual override (no DB / counter).
 * Canonical wrong-type prefix rejected; custom noncanonical allowed.
 */
export function validateManualSalesDocumentNumber({
  value,
  expectedDocumentType,
  documentLabel,
} = {}) {
  const label = documentLabel || salesDocumentTypeLabel(expectedDocumentType);
  const trimmed = String(value ?? "").trim();
  if (!trimmed) {
    throw statusError("Document number is required.");
  }
  if (trimmed.length > SALES_DOC_NUMBER_MAX_LENGTH) {
    throw statusError(`Document number is too long (maximum ${SALES_DOC_NUMBER_MAX_LENGTH} characters).`);
  }
  if (/[\x00-\x1F\x7F]/.test(trimmed)) {
    throw statusError("Document number contains invalid control characters.");
  }
  if (!MANUAL_NUMBER_SAFE_RE.test(trimmed)) {
    throw statusError(
      "Document number contains invalid characters. Use letters, numbers, spaces, and - _ / . ( )"
    );
  }

  const expectedType = resolveSalesDocumentType(expectedDocumentType);
  if (!expectedType) {
    throw statusError(`Unsupported document type for number validation: ${expectedDocumentType}`);
  }

  const parsed = parseCanonicalSalesDocumentNumber(trimmed);
  if (parsed.isCanonical) {
    if (parsed.documentType !== expectedType) {
      throw statusError(`${label} number cannot use the ${parsed.documentType} prefix.`);
    }
    return {
      number: parsed.normalized,
      parsed,
      numberSource: "MANUAL",
    };
  }

  // Custom / noncanonical — preserve user case after trim
  return {
    number: trimmed,
    parsed,
    numberSource: "MANUAL",
  };
}

/**
 * Atomic catch-up: raise daily counter to at least `sequence` via $max.
 * Never decreases. Custom (noncanonical) numbers must not call this.
 */
export async function bumpSalesDocumentCounterToAtLeast({
  companyId,
  documentType,
  dateToken,
  sequence,
  CounterModel = Counter,
}) {
  const type = resolveSalesDocumentType(documentType);
  if (!type) throw new Error(`Unsupported sales documentType: ${documentType}`);
  if (!companyId) throw new Error("companyId required for counter catch-up");
  const seq = Number(sequence);
  if (!(seq > 0) || !Number.isFinite(seq)) {
    throw new Error(`Invalid catch-up sequence: ${sequence}`);
  }
  const key = salesDocumentCounterKey(type, dateToken);
  const row = await CounterModel.findOneAndUpdate(
    { companyId, key },
    {
      $setOnInsert: { companyId, key },
      $max: { seq: Math.trunc(seq) },
    },
    { upsert: true, new: true, setDefaultsOnInsert: false, lean: true }
  );
  return Number(row?.seq) || 0;
}

/**
 * Full P2 manual-number pipeline: validate → uniqueness → canonical counter catch-up.
 *
 * When `previousNumber` normalizes to the same value, uniqueness/counter are skipped
 * (same-number update must not bump the counter).
 */
export async function applyManualSalesDocumentNumber({
  companyId,
  documentType,
  value,
  model,
  field,
  excludeId = null,
  previousNumber = null,
  documentLabel,
  CounterModel = Counter,
}) {
  const expectedType = resolveSalesDocumentType(documentType);
  const label = documentLabel || salesDocumentTypeLabel(expectedType);
  if (!companyId) throw statusError("companyId required");
  if (!model || !field) throw statusError("model and field required for uniqueness check");

  const validated = validateManualSalesDocumentNumber({
    value,
    expectedDocumentType: expectedType,
    documentLabel: label,
  });

  const prev = String(previousNumber ?? "").trim();
  if (prev && validated.number === prev) {
    return {
      number: validated.number,
      numberSource: "MANUAL",
      isCanonical: validated.parsed.isCanonical,
      parsed: validated.parsed,
      unchanged: true,
    };
  }

  const filter = { companyId, [field]: validated.number };
  if (excludeId) filter._id = { $ne: excludeId };
  const exists = await model.exists(filter);
  if (exists) {
    throw statusError(`${label} number ${validated.number} already exists.`, 409);
  }

  if (validated.parsed.isCanonical) {
    await bumpSalesDocumentCounterToAtLeast({
      companyId,
      documentType: validated.parsed.documentType,
      dateToken: validated.parsed.dateToken,
      sequence: validated.parsed.sequence,
      CounterModel,
    });
  }

  return {
    number: validated.number,
    numberSource: "MANUAL",
    isCanonical: validated.parsed.isCanonical,
    parsed: validated.parsed,
    unchanged: false,
  };
}

/**
 * Validate manual document number change on update (company-scoped uniqueness).
 * P2: also enforces character rules / wrong-type canonical prefix.
 * Does NOT bump counters — use applyManualSalesDocumentNumber for catch-up.
 */
export async function assertUniqueSalesDocNumberForUpdate({
  companyId,
  model,
  field,
  value,
  excludeId,
  documentType,
  documentLabel,
}) {
  if (documentType) {
    const validated = validateManualSalesDocumentNumber({
      value,
      expectedDocumentType: documentType,
      documentLabel,
    });
    const filter = { companyId, [field]: validated.number };
    if (excludeId) filter._id = { $ne: excludeId };
    const exists = await model.exists(filter);
    if (exists) {
      const label = documentLabel || salesDocumentTypeLabel(documentType);
      throw statusError(`${label} number ${validated.number} already exists.`, 409);
    }
    return validated.number;
  }

  const trimmed = String(value ?? "").trim();
  if (!trimmed) {
    throw statusError("Document number is required.");
  }
  if (!excludeId) return trimmed;
  const exists = await model.exists({ companyId, [field]: trimmed, _id: { $ne: excludeId } });
  if (exists) {
    throw statusError(`Document number "${trimmed}" is already in use`, 409);
  }
  return trimmed;
}

/** Map Mongo duplicate-key errors to a clean 409 message when possible. */
export function mapSalesDocNumberDuplicateError(err, { documentLabel = "Document", number = "" } = {}) {
  if (!err || err.code !== 11000) return null;
  const label = documentLabel || "Document";
  const n = String(number || "").trim();
  return statusError(n ? `${label} number ${n} already exists.` : `${label} number already exists.`, 409);
}
