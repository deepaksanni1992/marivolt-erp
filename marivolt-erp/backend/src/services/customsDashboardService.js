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

async function buildOpenBlSummary(companyId, filters) {
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
        supplier: { $first: { $ifNull: ["$lot.supplierName", ""] } },
        qty: { $sum: "$qtyImported" },
        balance: { $sum: "$qtyAvailable" },
        value: { $sum: { $multiply: ["$qtyAvailable", { $ifNull: ["$unitPrice", 0] }] } },
      },
    },
    { $sort: { value: -1 } },
    { $limit: 50 },
  ]);

  return rows.map((r) => ({
    blNumber: t(r._id),
    supplier: t(r.supplier) || "—",
    qty: parseNum(r.qty),
    balance: parseNum(r.balance),
    value: Number(parseNum(r.value).toFixed(2)),
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

  const recon = await listCustomsReconciliationPage(companyId, companyCode, {
    article: filters.article,
    supplier: filters.supplier,
    dateFrom: rawFilters.dateFrom,
    dateTo: rawFilters.dateTo,
  }, { page: 1, limit: 1 });

  const [summary, stockOverview, openBl, openBoe, movementTrend, statusCards] = await Promise.all([
    buildSummaryKpis(companyId, filters, recon.summary),
    buildStockOverview(companyId, filters),
    buildOpenBlSummary(companyId, filters),
    buildOpenBoeSummary(companyId, filters),
    buildMovementTrend(companyId, filters),
    buildStatusCards(companyId, filters, recon.summary),
  ]);

  return {
    generatedAt: new Date().toISOString(),
    filters: {
      article: filters.article || "",
      supplier: filters.supplier || "",
      dateFrom: filters.dateFrom,
      dateTo: filters.dateTo,
    },
    summary,
    stockOverview,
    openBl,
    openBoe,
    movementTrend,
    statusCards,
  };
}
