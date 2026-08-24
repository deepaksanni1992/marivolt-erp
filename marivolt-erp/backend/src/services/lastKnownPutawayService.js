/**
 * Phase 1+: batched last-known putaway (historical reference only).
 * Does NOT invent current bin quantities.
 *
 * Priority:
 * 1. Target article valid GRN putaway
 * 2. Target article StockLedger Putaway remark
 * 3. Article conversion lineage (same warehouse, time-bounded)
 * 4. PACK_CONVERSION kit/de-kit lineage (same warehouse, time-bounded)
 */
import GRN from "../models/GRN.js";
import StockLedger from "../models/StockLedger.js";
import ArticleStockConversion from "../models/ArticleStockConversion.js";
import DeKittingOrder from "../models/DeKittingOrder.js";
import KittingOrder from "../models/KittingOrder.js";
import {
  parsePutawayFromLedgerRemarks,
  resolvePutawayViaConversionLineage,
  resolvePutawayViaPackConversionLineage,
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

function normalizePackTransform(doc, { sourceArticle, targetArticle, conversionNo }) {
  return {
    status: "COMPLETED",
    warehouse: up(doc.warehouse),
    sourceArticle: up(sourceArticle),
    targetArticle: up(targetArticle),
    sourceLocation: up(doc.sourcePutawayLocation || ""),
    targetLocation: up(doc.producedPutawayLocation || ""),
    postedAt: doc.postedAt || doc.updatedAt || doc.createdAt || null,
    conversionDate: doc.postedAt || doc.updatedAt || doc.createdAt || null,
    conversionNo: conversionNo || "",
  };
}

/**
 * Expand PACK_CONVERSION kit/de-kit graph (COMPLETED only, same warehouse).
 */
async function loadPackConversionLineageDocs({ companyId, warehouse, seedArticles }) {
  const wh = up(warehouse) || "MAIN";
  const pending = new Set((seedArticles || []).map(up).filter(Boolean));
  const collected = [];
  const seenIds = new Set();
  let depth = 0;

  while (pending.size && depth < PUTAWAY_LINEAGE_MAX_DEPTH) {
    const targets = [...pending];
    pending.clear();

    const dekits = await DeKittingOrder.find({
      companyId,
      status: "COMPLETED",
      bomKind: "PACK_CONVERSION",
      warehouse: wh,
      "linesSnapshot.componentItemCode": { $in: targets },
    })
      .select(
        "dekitNumber status warehouse parentItemCode linesSnapshot postedAt updatedAt createdAt sourcePutawayLocation producedPutawayLocation"
      )
      .lean();

    for (const d of dekits) {
      const id = `dekit:${String(d._id)}`;
      if (seenIds.has(id)) continue;
      const child = up(d.linesSnapshot?.[0]?.componentItemCode);
      if (!child || !targets.includes(child)) continue;
      seenIds.add(id);
      collected.push(
        normalizePackTransform(d, {
          sourceArticle: d.parentItemCode,
          targetArticle: child,
          conversionNo: d.dekitNumber,
        })
      );
      const src = up(d.parentItemCode);
      if (src) pending.add(src);
    }

    const kits = await KittingOrder.find({
      companyId,
      status: "COMPLETED",
      bomKind: "PACK_CONVERSION",
      warehouse: wh,
      parentItemCode: { $in: targets },
    })
      .select(
        "kitNumber status warehouse parentItemCode linesSnapshot postedAt updatedAt createdAt sourcePutawayLocation producedPutawayLocation"
      )
      .lean();

    for (const k of kits) {
      const id = `kit:${String(k._id)}`;
      if (seenIds.has(id)) continue;
      const parent = up(k.parentItemCode);
      if (!parent || !targets.includes(parent)) continue;
      const child = up(k.linesSnapshot?.[0]?.componentItemCode);
      if (!child) continue;
      seenIds.add(id);
      collected.push(
        normalizePackTransform(k, {
          sourceArticle: child,
          targetArticle: parent,
          conversionNo: k.kitNumber,
        })
      );
      pending.add(child);
    }

    depth += 1;
  }

  return collected;
}

async function applyLineageFallback({ companyId, warehouse, missing, candidates, result, loadDocs, resolveFn }) {
  if (!missing.length) return candidates;

  const transforms = await loadDocs({
    companyId,
    warehouse,
    seedArticles: missing,
  });
  if (!transforms.length) return candidates;

  const lineageArticles = new Set(missing);
  for (const t of transforms) {
    if (t.sourceArticle) lineageArticles.add(up(t.sourceArticle));
    if (t.targetArticle) lineageArticles.add(up(t.targetArticle));
  }

  const extraArts = [...lineageArticles].filter((a) => !missing.includes(a));
  if (extraArts.length) {
    const more = await loadPutawayCandidates({
      companyId,
      warehouse,
      articles: extraArts,
    });
    candidates = candidates.concat(more);
  }

  for (const art of missing) {
    if (result.has(art)) continue;
    const inherited = resolveFn(art, {
      warehouse,
      putawayCandidates: candidates,
      conversions: transforms,
      transforms,
      maxDepth: PUTAWAY_LINEAGE_MAX_DEPTH,
      asOfDate: null,
    });
    if (inherited?.value) {
      result.set(art, inherited);
    }
  }

  return candidates;
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

  let missing = arts.filter((a) => !result.has(a));
  if (!missing.length) return result;

  // 3. Article conversion lineage fallback
  candidates = await applyLineageFallback({
    companyId,
    warehouse: wh,
    missing,
    candidates,
    result,
    loadDocs: loadConversionLineageDocs,
    resolveFn: (art, opts) =>
      resolvePutawayViaConversionLineage(art, {
        warehouse: opts.warehouse,
        putawayCandidates: opts.putawayCandidates,
        conversions: opts.conversions,
        maxDepth: opts.maxDepth,
        asOfDate: opts.asOfDate,
      }),
  });

  missing = arts.filter((a) => !result.has(a));
  if (!missing.length) return result;

  // 4. PACK_CONVERSION kit/de-kit lineage fallback
  await applyLineageFallback({
    companyId,
    warehouse: wh,
    missing,
    candidates,
    result,
    loadDocs: loadPackConversionLineageDocs,
    resolveFn: (art, opts) =>
      resolvePutawayViaPackConversionLineage(art, {
        warehouse: opts.warehouse,
        putawayCandidates: opts.putawayCandidates,
        transforms: opts.transforms,
        maxDepth: opts.maxDepth,
        asOfDate: opts.asOfDate,
      }),
  });

  return result;
}

export default { batchLastKnownPutaway, VALID_GRN_STATUSES };
