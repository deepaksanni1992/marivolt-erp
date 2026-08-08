/**
 * Phase 1: batched last-known putaway (historical reference only).
 * Does NOT invent current bin quantities.
 */
import GRN from "../models/GRN.js";
import StockLedger from "../models/StockLedger.js";
import {
  parsePutawayFromLedgerRemarks,
  selectLatestPutawayByArticle,
} from "../utils/packingPhysicalStock.js";

const VALID_GRN_STATUSES = Object.freeze([
  "POSTED",
  "RECEIVED",
  "PARTIAL_RECEIVED",
  "CLOSED",
]);

function up(v) {
  return String(v ?? "").trim().toUpperCase();
}

/**
 * Resolve last-known putaway for many articles in one warehouse.
 * @returns {Map<string, { value, source, sourceDocument, date, historical }>}
 */
export async function batchLastKnownPutaway({ companyId, warehouse, articles = [] } = {}) {
  const wh = up(warehouse) || "MAIN";
  const arts = [...new Set((articles || []).map(up).filter(Boolean))];
  const result = new Map();
  if (!companyId || !arts.length) return result;

  const grns = await GRN.find({
    companyId,
    status: { $in: [...VALID_GRN_STATUSES] },
    "items.article": { $in: arts },
  })
    .select("grnNo grnDate postedAt status createdAt updatedAt items.article items.location items.warehouse")
    .lean();

  const grnCandidates = [];
  for (const grn of grns) {
    for (const item of grn.items || []) {
      const art = up(item.article);
      if (!arts.includes(art)) continue;
      const put = String(item.location || "").trim();
      if (!put) continue;
      const itemWh = up(item.warehouse) || wh;
      if (itemWh !== wh) continue;
      grnCandidates.push({
        article: art,
        putaway: put,
        warehouse: itemWh,
        status: grn.status,
        source: "GRN",
        sourceDocument: grn.grnNo || "",
        date: grn.postedAt || grn.grnDate || grn.updatedAt || grn.createdAt,
        postedAt: grn.postedAt,
        grnDate: grn.grnDate,
      });
    }
  }

  const fromGrn = selectLatestPutawayByArticle(grnCandidates, wh);
  for (const [art, row] of fromGrn) result.set(art, row);

  const missing = arts.filter((a) => !result.has(a));
  if (!missing.length) return result;

  const ledgers = await StockLedger.find({
    companyId,
    article: { $in: missing },
    $or: [{ warehouse: wh }, { location: wh }],
    remarks: { $regex: /Putaway:\s*\S+/i },
  })
    .select("article warehouse location remarks transactionDate createdAt referenceNo documentNo")
    .sort({ transactionDate: -1, createdAt: -1 })
    .limit(Math.max(50, missing.length * 5))
    .lean();

  for (const row of ledgers) {
    const art = up(row.article);
    if (!missing.includes(art) || result.has(art)) continue;
    const rowWh = up(row.warehouse || row.location) || wh;
    if (rowWh !== wh) continue;
    const put = parsePutawayFromLedgerRemarks(row.remarks);
    if (!put) continue;
    result.set(art, {
      value: put,
      source: "STOCK_LEDGER",
      sourceDocument: row.referenceNo || row.documentNo || "",
      date: row.transactionDate || row.createdAt || null,
      historical: true,
    });
  }

  return result;
}

export default { batchLastKnownPutaway, VALID_GRN_STATUSES };
