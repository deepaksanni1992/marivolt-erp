/**
 * Executive Customs Dashboard — read-only aggregates from existing collections.
 */
import CustomsLot from "../models/CustomsLot.js";
import CustomsLotItem from "../models/CustomsLotItem.js";
import CustomsMovement from "../models/CustomsMovement.js";
import ItemMaster from "../models/itemMasterModel.js";
import { customsWithCompanyId } from "./customsService.js";
import { listCustomsReconciliationPage } from "./customsReconciliationService.js";

const EPS = 0.0001;
const MS_PER_DAY = 1000 * 60 * 60 * 24;

function t(v) {
  return String(v ?? "").trim();
}

function upper(v) {
  return t(v).toUpperCase();
}

function parseNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function parseFilters(raw = {}) {
  const dateFrom = raw.dateFrom ? new Date(raw.dateFrom) : null;
  const dateTo = raw.dateTo ? new Date(raw.dateTo) : null;
  if (dateTo) dateTo.setHours(23, 59, 59, 999);
  return {
    article: upper(raw.article || raw.articleNumber),
    supplier: t(raw.supplier),
    dateFrom: dateFrom && !Number.isNaN(dateFrom.getTime()) ? dateFrom : null,
    dateTo: dateTo && !Number.isNaN(dateTo.getTime()) ? dateTo : null,
  };
}

async function lotIdsForSupplier(companyId, supplier) {
  if (!supplier) return null;
  const re = new RegExp(supplier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  const lots = await CustomsLot.find(customsWithCompanyId(companyId, { supplierName: re }))
    .select("_id")
    .lean();
  return lots.map((l) => l._id);
}

async function buildItemMatch(companyId, filters) {
  const match = customsWithCompanyId(companyId, { status: { $ne: "CANCELLED" } });
  if (filters.article) match.articleNumber = filters.article;
  if (filters.supplier) {
    const lotIds = await lotIdsForSupplier(companyId, filters.supplier);
    match.customsLotId = lotIds?.length ? { $in: lotIds } : { $in: [] };
  }
  if (filters.dateFrom || filters.dateTo) {
    match.supplierInvoiceDate = {};
    if (filters.dateFrom) match.supplierInvoiceDate.$gte = filters.dateFrom;
    if (filters.dateTo) match.supplierInvoiceDate.$lte = filters.dateTo;
  }
  return match;
}

function movementMatch(companyId, filters) {
  const match = customsWithCompanyId(companyId, {});
  if (filters.article) match.articleNumber = filters.article;
  if (filters.dateFrom || filters.dateTo) {
    match.movementDate = {};
    if (filters.dateFrom) match.movementDate.$gte = filters.dateFrom;
    if (filters.dateTo) match.movementDate.$lte = filters.dateTo;
  }
  return match;
}

async function loadDescriptions(companyId, articles) {
  if (!articles.length) return new Map();
  const rows = await ItemMaster.find(customsWithCompanyId(companyId, { article: { $in: articles } }))
    .select("article itemName description")
    .lean();
  const map = new Map();
  for (const row of rows) {
    map.set(upper(row.article), t(row.itemName || row.description));
  }
  return map;
}

async function buildStockOverview(companyId, filters) {
  const match = await buildItemMatch(companyId, filters);
  const rows = await CustomsLotItem.aggregate([
    { $match: match },
    {
      $group: {
        _id: "$articleNumber",
        qtyIn: { $sum: "$qtyImported" },
        qtyOut: { $sum: "$qtyConsumed" },
        balance: { $sum: "$qtyAvailable" },
        stockValue: { $sum: { $multiply: ["$qtyAvailable", { $ifNull: ["$unitPrice", 0] }] } },
        partName: { $first: "$partName" },
      },
    },
    { $sort: { stockValue: -1 } },
    { $limit: 20 },
  ]);

  const descMap = await loadDescriptions(
    companyId,
    rows.map((r) => r._id).filter(Boolean),
  );

  return rows.map((r) => ({
    article: upper(r._id),
    description: descMap.get(upper(r._id)) || t(r.partName) || "—",
    qtyIn: parseNum(r.qtyIn),
    qtyOut: parseNum(r.qtyOut),
    balance: parseNum(r.balance),
    stockValue: Number(parseNum(r.stockValue).toFixed(2)),
  }));
}

function blAgingStatus(ageDays) {
  if (ageDays <= 30) return "Fresh";
  if (ageDays <= 90) return "Warning";
  return "Critical";
}

function blAgingBucket(ageDays) {
  if (ageDays < 30) return "under30";
  if (ageDays <= 60) return "days30to60";
  if (ageDays <= 90) return "days61to90";
  return "over90";
}

function ageDaysFromDate(blDate, now = new Date()) {
  if (!blDate) return 0;
  const d = new Date(blDate);
  if (Number.isNaN(d.getTime())) return 0;
  const days = Math.floor((now.getTime() - d.getTime()) / MS_PER_DAY);
  return Math.max(0, days);
}

async function buildBlAgingRows(companyId, filters, now = new Date()) {
  const match = await buildItemMatch(companyId, filters);
  match.qtyAvailable = { $gt: EPS };
  match.blNumber = { $nin: ["", null] };

  const rows = await CustomsLotItem.aggregate([
    { $match: match },
    {
      $lookup: {
        from: "customslots",
        localField: "customsLotId",
        foreignField: "_id",
        as: "lot",
      },
    },
    { $unwind: { path: "$lot", preserveNullAndEmptyArrays: true } },
    {
      $group: {
        _id: "$blNumber",
        boeNumber: { $first: "$boeNumber" },
        supplier: { $first: { $ifNull: ["$lot.supplierName", ""] } },
        blDate: {
          $min: {
            $ifNull: ["$lot.supplierInvoiceDate", { $ifNull: ["$supplierInvoiceDate", "$createdAt"] }],
          },
        },
        openQty: { $sum: "$qtyAvailable" },
        openValue: { $sum: { $multiply: ["$qtyAvailable", { $ifNull: ["$unitPrice", 0] }] } },
      },
    },
    { $sort: { openValue: -1 } },
  ]);

  return rows.map((r) => {
    const ageDays = ageDaysFromDate(r.blDate, now);
    return {
      blNumber: t(r._id),
      boeNumber: t(r.boeNumber) || "—",
      supplier: t(r.supplier) || "—",
      blDate: r.blDate || null,
      ageDays,
      openQty: parseNum(r.openQty),
      openValue: Number(parseNum(r.openValue).toFixed(2)),
      status: blAgingStatus(ageDays),
      bucket: blAgingBucket(ageDays),
    };
  });
}

function buildBlAgingBuckets(rows = []) {
  const counts = { under30: 0, days30to60: 0, days61to90: 0, over90: 0 };
  for (const row of rows) {
    if (counts[row.bucket] != null) counts[row.bucket] += 1;
  }
  return counts;
}

async function buildTopValueArticles(companyId, filters) {
  const match = await buildItemMatch(companyId, filters);
  const rows = await CustomsLotItem.aggregate([
    { $match: match },
    {
      $group: {
        _id: "$articleNumber",
        customsQty: { $sum: "$qtyImported" },
        balanceQty: { $sum: "$qtyAvailable" },
        customsValue: { $sum: { $multiply: ["$qtyAvailable", { $ifNull: ["$unitPrice", 0] }] } },
        valueQty: { $sum: { $cond: [{ $gt: ["$qtyAvailable", 0] }, "$qtyAvailable", 0] } },
        valueAmount: { $sum: { $multiply: ["$qtyAvailable", { $ifNull: ["$unitPrice", 0] }] } },
        partName: { $first: "$partName" },
      },
    },
    { $sort: { customsValue: -1 } },
    { $limit: 10 },
  ]);

  const descMap = await loadDescriptions(
    companyId,
    rows.map((r) => r._id).filter(Boolean),
  );

  return rows.map((r) => {
    const balanceQty = parseNum(r.balanceQty);
    const customsValue = Number(parseNum(r.customsValue).toFixed(2));
    const unitPrice = balanceQty > EPS ? Number((customsValue / balanceQty).toFixed(4)) : 0;
    return {
      article: upper(r._id),
      description: descMap.get(upper(r._id)) || t(r.partName) || "—",
      customsQty: parseNum(r.customsQty),
      balanceQty,
      unitPrice,
      customsValue,
    };
  });
}

function buildExposureSummary(summary, blAgingRows = []) {
  const ages = blAgingRows.map((r) => r.ageDays).filter((a) => Number.isFinite(a));
  const averageBlAge = ages.length ? Math.round(ages.reduce((s, a) => s + a, 0) / ages.length) : 0;
  const oldestBlAge = ages.length ? Math.max(...ages) : 0;
  return {
    totalCustomsStockValue: parseNum(summary.customsStockValue),
    totalOpenBl: parseNum(summary.openBlCount),
    totalOpenBoe: parseNum(summary.openBoeCount),
    averageBlAge,
    oldestBlAge,
  };
}

function buildTopOpenBlValue(blAgingRows = []) {
  return [...blAgingRows]
    .sort((a, b) => b.openValue - a.openValue)
    .slice(0, 10)
    .map((r) => ({
      blNumber: r.blNumber,
      supplier: r.supplier,
      balanceQty: r.openQty,
      balanceValue: r.openValue,
    }));
}

async function buildOpenBoeSummary(companyId, filters) {
  const match = await buildItemMatch(companyId, filters);
  match.qtyAvailable = { $gt: EPS };
  match.boeNumber = { $nin: ["", null] };

  const rows = await CustomsLotItem.aggregate([
    { $match: match },
    {
      $group: {
        _id: "$boeNumber",
        date: { $max: "$supplierInvoiceDate" },
        balanceQty: { $sum: "$qtyAvailable" },
        balanceValue: { $sum: { $multiply: ["$qtyAvailable", { $ifNull: ["$unitPrice", 0] }] } },
      },
    },
    { $sort: { balanceValue: -1 } },
    { $limit: 50 },
  ]);

  return rows.map((r) => ({
    boeNumber: t(r._id),
    date: r.date || null,
    balanceQty: parseNum(r.balanceQty),
    balanceValue: Number(parseNum(r.balanceValue).toFixed(2)),
  }));
}

async function buildMovementTrend(companyId, filters) {
  const match = movementMatch(companyId, filters);
  const rows = await CustomsMovement.aggregate([
    { $match: match },
    {
      $project: {
        month: {
          $dateToString: { format: "%Y-%m", date: { $ifNull: ["$movementDate", "$createdAt"] } },
        },
        movementType: 1,
        qty: 1,
      },
    },
    {
      $group: {
        _id: "$month",
        inboundQty: {
          $sum: {
            $cond: [
              { $in: ["$movementType", ["INBOUND", "REVERSAL"]] },
              "$qty",
              0,
            ],
          },
        },
        outboundQty: {
          $sum: {
            $cond: [{ $eq: ["$movementType", "OUTBOUND"] }, "$qty", 0],
          },
        },
      },
    },
    { $sort: { _id: 1 } },
    { $limit: 24 },
  ]);

  return rows.map((r) => ({
    month: r._id,
    inboundQty: parseNum(r.inboundQty),
    outboundQty: parseNum(r.outboundQty),
  }));
}

async function buildStatusCards(companyId, filters, reconSummary) {
  const match = await buildItemMatch(companyId, filters);
  const statusRows = await CustomsLotItem.aggregate([
    { $match: match },
    {
      $group: {
        _id: null,
        inStock: {
          $sum: {
            $cond: [{ $and: [{ $gt: ["$qtyAvailable", EPS] }, { $eq: ["$status", "IN_STOCK"] }] }, 1, 0],
          },
        },
        fullyConsumed: {
          $sum: {
            $cond: [
              {
                $or: [{ $eq: ["$status", "CONSUMED"] }, { $lte: ["$qtyAvailable", EPS] }],
              },
              1,
              0,
            ],
          },
        },
        partiallyConsumed: {
          $sum: { $cond: [{ $eq: ["$status", "PARTIAL"] }, 1, 0] },
        },
        totalItems: { $sum: 1 },
      },
    },
  ]);

  const s = statusRows[0] || {};
  return {
    inStock: parseNum(s.inStock),
    fullyConsumed: parseNum(s.fullyConsumed),
    partiallyConsumed: parseNum(s.partiallyConsumed),
    reconciled: parseNum(reconSummary?.matchedArticles),
    mismatch: parseNum(reconSummary?.mismatchArticles),
    totalItems: parseNum(s.totalItems),
  };
}

async function buildSummaryKpis(companyId, filters, reconSummary) {
  const match = await buildItemMatch(companyId, filters);
  const openMatch = { ...match, qtyAvailable: { $gt: EPS } };

  const [valueRow, openBlRow, openBoeRow, openLotRow] = await Promise.all([
    CustomsLotItem.aggregate([
      { $match: match },
      {
        $group: {
          _id: null,
          stockValue: { $sum: { $multiply: ["$qtyAvailable", { $ifNull: ["$unitPrice", 0] }] } },
          stockBalance: { $sum: "$qtyAvailable" },
        },
      },
    ]),
    CustomsLotItem.aggregate([
      { $match: { ...openMatch, blNumber: { $nin: ["", null] } } },
      { $group: { _id: "$blNumber" } },
      { $count: "count" },
    ]),
    CustomsLotItem.aggregate([
      { $match: { ...openMatch, boeNumber: { $nin: ["", null] } } },
      { $group: { _id: "$boeNumber" } },
      { $count: "count" },
    ]),
    CustomsLotItem.aggregate([
      { $match: openMatch },
      { $group: { _id: "$customsLotId" } },
      { $count: "count" },
    ]),
  ]);

  const val = valueRow[0] || {};
  return {
    openBlCount: openBlRow[0]?.count || 0,
    openBoeCount: openBoeRow[0]?.count || 0,
    openLotCount: openLotRow[0]?.count || 0,
    customsStockValue: Number(parseNum(val.stockValue).toFixed(2)),
    customsStockBalance: parseNum(val.stockBalance),
    pendingReconciliation: parseNum(reconSummary?.mismatchArticles),
    matchedArticles: parseNum(reconSummary?.matchedArticles),
    matchPct: parseNum(reconSummary?.matchPct),
  };
}

export async function buildCustomsDashboard(companyId, companyCode = "", rawFilters = {}) {
  const filters = parseFilters(rawFilters);
  const now = new Date();

  const reconPromise = listCustomsReconciliationPage(
    companyId,
    companyCode,
    {
      article: filters.article,
      supplier: filters.supplier,
      dateFrom: rawFilters.dateFrom,
      dateTo: rawFilters.dateTo,
    },
    { page: 1, limit: 1 },
  );

  const blAgingPromise = buildBlAgingRows(companyId, filters, now);
  const [recon, blAging, stockOverview, openBoe, movementTrend, topValueArticles, summary, statusCards] =
    await Promise.all([
      reconPromise,
      blAgingPromise,
      buildStockOverview(companyId, filters),
      buildOpenBoeSummary(companyId, filters),
      buildMovementTrend(companyId, filters),
      buildTopValueArticles(companyId, filters),
      reconPromise.then((r) => buildSummaryKpis(companyId, filters, r.summary)),
      reconPromise.then((r) => buildStatusCards(companyId, filters, r.summary)),
    ]);
  const blAgingBuckets = buildBlAgingBuckets(blAging);
  const topOpenBlValue = buildTopOpenBlValue(blAging);
  const exposure = buildExposureSummary(summary, blAging);
  const openBl = blAging.map((r) => ({
    blNumber: r.blNumber,
    supplier: r.supplier,
    qty: r.openQty,
    balance: r.openQty,
    value: r.openValue,
  }));

  return {
    generatedAt: now.toISOString(),
    filters: {
      article: filters.article || "",
      supplier: filters.supplier || "",
      dateFrom: filters.dateFrom,
      dateTo: filters.dateTo,
    },
    summary,
    exposure,
    blAgingBuckets,
    blAging,
    topValueArticles,
    topOpenBlValue,
    stockOverview,
    openBl,
    openBoe,
    movementTrend,
    statusCards,
  };
}
