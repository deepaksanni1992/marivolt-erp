/**
 * Phase 1+: batched last-known putaway (historical reference only).
 * Does NOT invent current bin quantities.
 *
 * Priority:
 * 1. Target article valid GRN putaway
 * 2. Target article StockLedger Putaway remark
 * 3. Article conversion lineage (same warehouse, time-bounded)
 */
import GRN from "../models/GRN.js";
import StockLedger from "../models/StockLedger.js";
import ArticleStockConversion from "../models/ArticleStockConversion.js";
import {
  parsePutawayFromLedgerRemarks,
  resolvePutawayViaConversionLineage,
  selectLatestPutawayByArticle,
  PUTAWAY_LINEAGE_MAX_DEPTH,
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

function pushGrnCandidates(grns, arts, wh, into) {
  for (const grn of grns || []) {
    for (const item of grn.items || []) {
      const art = up(item.article);
      if (arts.size && !arts.has(art)) continue;
      const put = String(item.location || "").trim();
      if (!put) continue;
      const itemWh = up(item.warehouse) || wh;
      if (itemWh !== wh) continue;
      into.push({
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
}

async function loadPutawayCandidates({ companyId, warehouse, articles }) {
  const wh = up(warehouse) || "MAIN";
  const arts = [...new Set((articles || []).map(up).filter(Boolean))];
  const artSet = new Set(arts);
  const candidates = [];
  if (!companyId || !arts.length) return candidates;

  const grns = await GRN.find({
    companyId,
    status: { $in: [...VALID_GRN_STATUSES] },
    "items.article": { $in: arts },
  })
    .select("grnNo grnDate postedAt status createdAt updatedAt items.article items.location items.warehouse")
    .lean();

  pushGrnCandidates(grns, artSet, wh, candidates);

  const ledgers = await StockLedger.find({
    companyId,
    article: { $in: arts },
    $or: [{ warehouse: wh }, { location: wh }],
    remarks: { $regex: /Putaway:\s*\S+/i },
  })
    .select("article warehouse location remarks transactionDate createdAt referenceNo documentNo")
    .sort({ transactionDate: -1, createdAt: -1 })
    .limit(Math.max(100, arts.length * 10))
    .lean();

  for (const row of ledgers) {
    const art = up(row.article);
    if (!artSet.has(art)) continue;
    const rowWh = up(row.warehouse || row.location) || wh;
    if (rowWh !== wh) continue;
    const put = parsePutawayFromLedgerRemarks(row.remarks);
    if (!put) continue;
    candidates.push({
      article: art,
      putaway: put,
      warehouse: rowWh,
      status: "POSTED",
      source: "STOCK_LEDGER",
      sourceDocument: row.referenceNo || row.documentNo || "",
      date: row.transactionDate || row.createdAt || null,
    });
  }

  return candidates;
}

/**
 * Expand conversion graph for lineage (POSTED only, same warehouse).
 */
async function loadConversionLineageDocs({ companyId, warehouse, seedArticles }) {
  const wh = up(warehouse) || "MAIN";
  const pending = new Set((seedArticles || []).map(up).filter(Boolean));
  const collected = [];
  const seenIds = new Set();
  let depth = 0;

  while (pending.size && depth < PUTAWAY_LINEAGE_MAX_DEPTH) {
    const targets = [...pending];
    pending.clear();
    const convs = await ArticleStockConversion.find({
      companyId,
      status: "POSTED",
      warehouse: wh,
      targetArticle: { $in: targets },
    })
      .select(
        "conversionNo status warehouse sourceArticle targetArticle sourceLocation targetLocation postedAt conversionDate"
      )
      .lean();

    for (const c of convs) {
      const id = String(c._id);
      if (seenIds.has(id)) continue;
      seenIds.add(id);
      collected.push(c);
      const src = up(c.sourceArticle);
      if (src) pending.add(src);
    }
    depth += 1;
  }

  return collected;
}

/**
 * Resolve last-known putaway for many articles in one warehouse.
 * @returns {Map<string, object>}
 */
export async function batchLastKnownPutaway({ companyId, warehouse, articles = [] } = {}) {
  const wh = up(warehouse) || "MAIN";
  const arts = [...new Set((articles || []).map(up).filter(Boolean))];
  const result = new Map();
  if (!companyId || !arts.length) return result;

  // 1–2. Direct GRN / ledger evidence for requested articles
  let candidates = await loadPutawayCandidates({ companyId, warehouse: wh, articles: arts });
  const direct = selectLatestPutawayByArticle(candidates, wh, null);
  for (const [art, row] of direct) {
    result.set(art, {
      ...row,
      sourceType: row.sourceType || row.source || "GRN",
    });
  }

  const missing = arts.filter((a) => !result.has(a));
  if (!missing.length) return result;

  // 3. Conversion lineage fallback
  const conversions = await loadConversionLineageDocs({
    companyId,
    warehouse: wh,
    seedArticles: missing,
  });
  if (!conversions.length) return result;

  const lineageArticles = new Set(missing);
  for (const c of conversions) {
    lineageArticles.add(up(c.sourceArticle));
    lineageArticles.add(up(c.targetArticle));
  }

  const extraArts = [...lineageArticles].filter((a) => !arts.includes(a));
  if (extraArts.length) {
    const more = await loadPutawayCandidates({
      companyId,
      warehouse: wh,
      articles: extraArts,
    });
    candidates = candidates.concat(more);
  }

  for (const art of missing) {
    if (result.has(art)) continue;
    const inherited = resolvePutawayViaConversionLineage(art, {
      warehouse: wh,
      putawayCandidates: candidates,
      conversions,
      maxDepth: PUTAWAY_LINEAGE_MAX_DEPTH,
      asOfDate: null,
    });
    if (inherited?.value) {
      result.set(art, inherited);
    }
  }

  return result;
}

export default { batchLastKnownPutaway, VALID_GRN_STATUSES };
