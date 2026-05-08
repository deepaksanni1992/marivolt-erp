/**
 * Number series service — Phase-10.
 *
 * Configurable, backward-compatible document numbering.
 *
 * - When a NumberSeriesConfig row exists for (companyId, branchId,
 *   docKey) it is used to compose the new number using the format
 *   tokens described in `models/NumberSeriesConfig.js`.
 * - Otherwise the legacy `nextSalesDocNumber` (Sales/PI/SI/etc.) or
 *   `nextSequentialNumber` (Store) helpers continue to work.
 *
 * The DocCounter collection is shared with the legacy generator, but
 * to avoid colliding sequences this service stores its own counters
 * under the prefix `NS:` so existing rows are untouched.
 */
import DocCounter from "../models/DocCounter.js";
import NumberSeriesConfig from "../models/NumberSeriesConfig.js";

function pad(value, width) {
  if (!width || width <= 0) return String(value);
  return String(value).padStart(width, "0");
}

function formatTokens({ format, companyCode, branchCode, date, seq, padding }) {
  const d = date instanceof Date ? date : new Date(date || Date.now());
  const yyyy = String(d.getFullYear());
  const yy = yyyy.slice(-2);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return String(format || "")
    .replace(/\{COMPANY\}/g, String(companyCode || "").toUpperCase())
    .replace(/\{BRANCH\}/g, String(branchCode || "").toUpperCase())
    .replace(/\{YYYY\}/g, yyyy)
    .replace(/\{YY\}/g, yy)
    .replace(/\{YYMMDD\}/g, `${yy}${mm}${dd}`)
    .replace(/\{YYYYMMDD\}/g, `${yyyy}${mm}${dd}`)
    .replace(/\{MM\}/g, mm)
    .replace(/\{DD\}/g, dd)
    .replace(/\{SEQ\}/g, pad(seq, padding));
}

function periodToken(resetCycle, date = new Date()) {
  const d = date instanceof Date ? date : new Date(date || Date.now());
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  switch (String(resetCycle || "DAILY").toUpperCase()) {
    case "NEVER":
      return "ALL";
    case "MONTHLY":
      return `${yyyy}${mm}`;
    case "YEARLY":
      return `${yyyy}`;
    case "DAILY":
    default:
      return `${yyyy}${mm}${dd}`;
  }
}

function counterKey({ branchId, docKey, period }) {
  const branchPart = branchId ? `:${String(branchId)}` : "";
  return `NS:${docKey}${branchPart}:${period}`.toUpperCase();
}

function defaultFormatFor(docKey) {
  const upper = String(docKey || "").toUpperCase();
  switch (upper) {
    case "QUOTATION":
    case "ORDER_ACK":
    case "PROFORMA":
    case "ORDER_ALLOCATION":
    case "RTS":
    case "SALES_INVOICE":
    case "SALES_DISPATCH":
    case "SALES_RETURN":
    case "CIPL":
    case "PAYMENT_RECEIPT":
      return "{COMPANY}/{YYMMDD}.{SEQ}";
    case "GRN":
      return "GRN-{YYYYMMDD}-{SEQ}";
    case "STOCK_ADJUSTMENT":
      return "ADJ-{YYYYMMDD}-{SEQ}";
    case "STOCK_TRANSFER":
      return "TRF-{YYYYMMDD}-{SEQ}";
    case "PURCHASE_ORDER":
      return "PO-{YYYYMMDD}-{SEQ}";
    case "PURCHASE_INVOICE":
      return "PI-{YYYYMMDD}-{SEQ}";
    case "PURCHASE_RETURN":
      return "PR-{YYYYMMDD}-{SEQ}";
    case "SHIPMENT":
      return "SH-{YYYYMMDD}-{SEQ}";
    case "KITTING":
      return "KIT-{YYYYMMDD}-{SEQ}";
    case "DEKITTING":
      return "DK-{YYYYMMDD}-{SEQ}";
    default:
      return `${upper}-{YYYYMMDD}-{SEQ}`;
  }
}

/**
 * Generate the next number for a (companyId, branchId, docKey) triple
 * using the configured format, falling back to a sensible default
 * format if no config row exists.
 *
 * Returns { number, seq, config } so callers can record audit data.
 */
export async function nextNumber({
  companyId,
  branchId = null,
  companyCode = "",
  branchCode = "",
  docKey,
  referenceDate = new Date(),
}) {
  const safeKey = String(docKey || "").trim().toUpperCase();
  if (!companyId) throw new Error("nextNumber: companyId required");
  if (!safeKey) throw new Error("nextNumber: docKey required");

  const config = await NumberSeriesConfig.findOne({
    companyId,
    branchId: branchId || null,
    docKey: safeKey,
    isActive: true,
  }).lean();

  const format = config?.format?.trim() || defaultFormatFor(safeKey);
  const padding = Number.isFinite(config?.padding) ? config.padding : 4;
  const resetCycle = config?.resetCycle || "DAILY";
  const startSeq = Number.isFinite(config?.startSeq) ? config.startSeq : 1;
  const period = periodToken(resetCycle, referenceDate);
  const counter = counterKey({ branchId, docKey: safeKey, period });

  let row = await DocCounter.findOneAndUpdate(
    { companyId, docKey: counter },
    { $inc: { seq: 1 } },
    { new: true }
  );
  if (!row) {
    try {
      row = await DocCounter.create({
        companyId,
        docKey: counter,
        seq: Math.max(startSeq, 1),
      });
    } catch (err) {
      if (err?.code !== 11000) throw err;
      row = await DocCounter.findOneAndUpdate(
        { companyId, docKey: counter },
        { $inc: { seq: 1 } },
        { new: true }
      );
    }
  }

  const seq = row.seq;
  const composed = formatTokens({
    format: `${config?.prefix || ""}${format}${config?.suffix || ""}`,
    companyCode,
    branchCode,
    date: referenceDate,
    seq,
    padding,
  });

  return { number: composed, seq, config: config || null };
}

export default { nextNumber };
