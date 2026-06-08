/**
 * Customs Reconciliation — read-only ERP inventory vs customs stock comparison.
 * Does not mutate inventory, customs lots, or allocation logic.
 */
import CustomsLot from "../models/CustomsLot.js";
import CustomsLotItem from "../models/CustomsLotItem.js";
import CustomsMovement from "../models/CustomsMovement.js";
import ItemMaster from "../models/itemMasterModel.js";
import StockBalance from "../models/StockBalance.js";
import StockLedger from "../models/StockLedger.js";
import { customsWithCompanyId } from "./customsService.js";

const EPS = 0.0001;
const RECON_STATUS = {
  MATCH: "MATCH",
  ERP_HIGHER: "ERP HIGHER",
  CUSTOMS_HIGHER: "CUSTOMS HIGHER",
  MISSING_CUSTOMS: "MISSING CUSTOMS RECORD",
};

function t(v) {
  return String(v ?? "").trim();
}

function upper(v) {
  return t(v).toUpperCase();
}

function itemKey(article, partNumber) {
  return `${upper(article)}::${upper(partNumber)}`;
}

function parseNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function parseFilters(raw = {}) {
  return {
    search: t(raw.search),
    article: upper(raw.article || raw.articleNumber),
    partNumber: upper(raw.partNumber),
    supplier: t(raw.supplier),
    boe: t(raw.boe || raw.boeNumber),
    bl: t(raw.bl || raw.blNumber),
    awb: t(raw.awb || raw.awbNumber),
    status: upper(raw.status).replace(/_/g, " "),
    dateFrom: raw.dateFrom ? new Date(raw.dateFrom) : null,
    dateTo: raw.dateTo ? new Date(raw.dateTo) : null,
    onlyMismatches: String(raw.onlyMismatches || raw.onlyMismatch || "").toLowerCase() === "true",
  };
}

function computeRowStatus(erpStock, customsStock, hasCustomsRecord) {
  const erp = parseNum(erpStock);
  const customs = parseNum(customsStock);
  const diff = erp - customs;
  if (!hasCustomsRecord && erp > EPS) {
    return {
      status: RECON_STATUS.MISSING_CUSTOMS,
      actionRequired: "Review historical imports",
      difference: diff,
      differencePct: customs > EPS ? (diff / customs) * 100 : erp > EPS ? 100 : 0,
    };
  }
  if (Math.abs(diff) <= EPS) {
    return {
      status: RECON_STATUS.MATCH,
      actionRequired: "No Action",
      difference: diff,
      differencePct: 0,
    };
  }
  if (diff > EPS) {
    return {
      status: RECON_STATUS.ERP_HIGHER,
      actionRequired: "Check customs allocation",
      difference: diff,
      differencePct: customs > EPS ? (diff / customs) * 100 : 100,
    };
  }
  return {
    status: RECON_STATUS.CUSTOMS_HIGHER,
    actionRequired: "Check inventory adjustment",
    difference: diff,
    differencePct: erp > EPS ? (diff / erp) * 100 : -100,
  };
}

function inDateRange(date, from, to) {
  if (!from && !to) return true;
  if (!date) return false;
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return false;
  if (from && d < from) return false;
  if (to) {
    const end = new Date(to);
    end.setHours(23, 59, 59, 999);
    if (d > end) return false;
  }
  return true;
}

async function lotIdsForSupplier(companyId, supplier) {
  if (!supplier) return null;
  const re = new RegExp(supplier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  const lots = await CustomsLot.find(customsWithCompanyId(companyId, { supplierName: re }))
    .select("_id")
    .lean();
  return lots.map((l) => l._id);
}

async function aggregateErpStock(companyId, filters) {
  const match = customsWithCompanyId(companyId, {});
  if (filters.article) match.article = filters.article;
  if (filters.partNumber) match.itemCode = filters.partNumber;
  if (filters.search) {
    const re = new RegExp(filters.search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    match.$or = [{ article: re }, { itemCode: re }];
  }

  const rows = await StockBalance.aggregate([
    { $match: match },
    {
      $group: {
        _id: { article: "$article", partNumber: { $ifNull: ["$itemCode", ""] } },
        onHandQty: { $sum: { $ifNull: ["$onHandQty", "$quantity"] } },
        allocatedQty: { $sum: { $max: [{ $ifNull: ["$allocatedQty", 0] }, { $ifNull: ["$reservedQty", 0] }] } },
        rtsQty: { $sum: { $ifNull: ["$rtsQty", 0] } },
        packedQty: { $sum: { $ifNull: ["$packedQty", 0] } },
        lastErpMovementDate: { $max: "$lastTransactionDate" },
        erpValue: {
          $sum: {
            $multiply: [
              {
                $subtract: [
                  { $ifNull: ["$onHandQty", "$quantity"] },
                  {
                    $add: [
                      { $max: [{ $ifNull: ["$allocatedQty", 0] }, { $ifNull: ["$reservedQty", 0] }] },
                      { $ifNull: ["$rtsQty", 0] },
                      { $ifNull: ["$packedQty", 0] },
                    ],
                  },
                ],
              },
              { $ifNull: ["$avgCost", { $ifNull: ["$unitCost", 0] }] },
            ],
          },
        },
      },
    },
    {
      $project: {
        article: "$_id.article",
        partNumber: "$_id.partNumber",
        erpStock: {
          $subtract: ["$onHandQty", { $add: ["$allocatedQty", "$rtsQty", "$packedQty"] }],
        },
        lastErpMovementDate: 1,
        erpValue: 1,
      },
    },
  ]);

  const map = new Map();
  for (const row of rows) {
    const article = upper(row.article);
    const partNumber = upper(row.partNumber);
    if (!article) continue;
    const key = itemKey(article, partNumber);
    map.set(key, {
      article,
      partNumber,
      erpStock: parseNum(row.erpStock),
      lastErpMovementDate: row.lastErpMovementDate || null,
      erpValue: parseNum(row.erpValue),
    });
  }
  return map;
}

async function aggregateCustomsStock(companyId, filters) {
  const match = customsWithCompanyId(companyId, { status: { $ne: "CANCELLED" } });
  if (filters.article) match.articleNumber = filters.article;
  if (filters.partNumber) match.partNumber = filters.partNumber;
  if (filters.boe) match.boeNumber = new RegExp(filters.boe.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  if (filters.bl) match.blNumber = new RegExp(filters.bl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  if (filters.awb) match.awbNumber = new RegExp(filters.awb.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  if (filters.search) {
    const re = new RegExp(filters.search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    const searchOr = [{ articleNumber: re }, { partNumber: re }, { partName: re }, { boeNumber: re }, { blNumber: re }];
    match.$or = match.$or ? [...match.$or, ...searchOr] : searchOr;
  }
  const lotIds = await lotIdsForSupplier(companyId, filters.supplier);
  if (lotIds) {
    if (!lotIds.length) return new Map();
    match.customsLotId = { $in: lotIds };
  }

  const rows = await CustomsLotItem.aggregate([
    { $match: match },
    { $sort: { updatedAt: -1 } },
    {
      $group: {
        _id: { article: "$articleNumber", partNumber: { $ifNull: ["$partNumber", ""] } },
        customsStock: { $sum: "$qtyAvailable" },
        qtyImported: { $sum: "$qtyImported" },
        qtyConsumed: { $sum: "$qtyConsumed" },
        customsValue: { $sum: { $multiply: ["$qtyAvailable", { $ifNull: ["$unitPrice", 0] }] } },
        partName: { $first: "$partName" },
        lastBoe: { $first: "$boeNumber" },
        lastBl: { $first: "$blNumber" },
        lastAwb: { $first: "$awbNumber" },
        lastSupplierInvoice: { $first: "$supplierInvoiceNumber" },
        itemCount: { $sum: 1 },
      },
    },
  ]);

  const map = new Map();
  for (const row of rows) {
    const article = upper(row._id?.article);
    const partNumber = upper(row._id?.partNumber);
    if (!article) continue;
    map.set(itemKey(article, partNumber), {
      article,
      partNumber,
      customsStock: parseNum(row.customsStock),
      qtyImported: parseNum(row.qtyImported),
      qtyConsumed: parseNum(row.qtyConsumed),
      customsValue: parseNum(row.customsValue),
      partName: t(row.partName),
      lastBoe: t(row.lastBoe),
      lastBl: t(row.lastBl),
      lastAwb: t(row.lastAwb),
      lastSupplierInvoice: t(row.lastSupplierInvoice),
      hasCustomsRecord: true,
    });
  }
  return map;
}

async function aggregateCustomsMovementDates(companyId) {
  const rows = await CustomsMovement.aggregate([
    { $match: customsWithCompanyId(companyId, {}) },
    {
      $group: {
        _id: { article: "$articleNumber", partNumber: { $ifNull: ["$partNumber", ""] } },
        lastCustomsMovementDate: { $max: "$movementDate" },
      },
    },
  ]);
  const map = new Map();
  for (const row of rows) {
    map.set(itemKey(row._id?.article, row._id?.partNumber), row.lastCustomsMovementDate || null);
  }
  return map;
}

async function loadPartNames(companyId, articles) {
  if (!articles.length) return new Map();
  const items = await ItemMaster.find(
    customsWithCompanyId(companyId, { article: { $in: articles } }),
  )
    .select("article itemName description")
    .lean();
  const map = new Map();
  for (const it of items) {
    map.set(upper(it.article), t(it.itemName || it.description));
  }
  return map;
}

function mergeReconciliationRows(erpMap, customsMap, customsMovementMap, partNameMap, companyCode) {
  const keys = new Set([...erpMap.keys(), ...customsMap.keys()]);
  const rows = [];

  for (const key of keys) {
    const erp = erpMap.get(key) || {
      article: key.split("::")[0],
      partNumber: key.split("::")[1] || "",
      erpStock: 0,
      lastErpMovementDate: null,
      erpValue: 0,
    };
    const customs = customsMap.get(key);
    const erpStock = parseNum(erp.erpStock);
    const customsStock = parseNum(customs?.customsStock);
    if (erpStock <= EPS && customsStock <= EPS && !customs?.hasCustomsRecord) continue;

    const hasCustomsRecord = !!customs?.hasCustomsRecord;
    const statusRow = computeRowStatus(erpStock, customsStock, hasCustomsRecord);
    const partName = customs?.partName || partNameMap.get(erp.article) || "";

    rows.push({
      article: erp.article || customs?.article || key.split("::")[0],
      partNumber: erp.partNumber || customs?.partNumber || key.split("::")[1] || "",
      partName,
      company: companyCode || "",
      erpStock,
      customsStock,
      difference: statusRow.difference,
      differencePct: Number(statusRow.differencePct.toFixed(2)),
      lastErpMovementDate: erp.lastErpMovementDate || null,
      lastCustomsMovementDate: customsMovementMap.get(key) || null,
      lastBoe: customs?.lastBoe || "",
      lastBl: customs?.lastBl || "",
      lastSupplierInvoice: customs?.lastSupplierInvoice || "",
      lastAwb: customs?.lastAwb || "",
      status: statusRow.status,
      actionRequired: statusRow.actionRequired,
      erpValue: parseNum(erp.erpValue),
      customsValue: parseNum(customs?.customsValue),
      hasCustomsRecord,
    });
  }

  rows.sort((a, b) => Math.abs(b.difference) - Math.abs(a.difference));
  return rows;
}

function applyRowFilters(rows, filters) {
  return rows.filter((row) => {
    if (filters.status && upper(row.status) !== filters.status) return false;
    if (filters.onlyMismatches && row.status === RECON_STATUS.MATCH) return false;
    if (filters.dateFrom || filters.dateTo) {
      const dates = [row.lastErpMovementDate, row.lastCustomsMovementDate].filter(Boolean);
      if (!dates.length) return false;
      if (!dates.some((d) => inDateRange(d, filters.dateFrom, filters.dateTo))) return false;
    }
    if (filters.boe && !new RegExp(filters.boe, "i").test(row.lastBoe || "")) return false;
    if (filters.bl && !new RegExp(filters.bl, "i").test(row.lastBl || "")) return false;
    if (filters.awb && !new RegExp(filters.awb, "i").test(row.lastAwb || "")) return false;
    return true;
  });
}

function buildSummary(rows) {
  let matchedArticles = 0;
  let mismatchArticles = 0;
  let erpHigherItems = 0;
  let customsHigherItems = 0;
  let missingCustomsRecords = 0;
  let totalErpStockValue = 0;
  let totalCustomsStockValue = 0;

  for (const row of rows) {
    totalErpStockValue += parseNum(row.erpValue);
    totalCustomsStockValue += parseNum(row.customsValue);
    if (row.status === RECON_STATUS.MATCH) matchedArticles += 1;
    else mismatchArticles += 1;
    if (row.status === RECON_STATUS.ERP_HIGHER) erpHigherItems += 1;
    if (row.status === RECON_STATUS.CUSTOMS_HIGHER) customsHigherItems += 1;
    if (row.status === RECON_STATUS.MISSING_CUSTOMS) missingCustomsRecords += 1;
  }

  const totalArticles = rows.length;
  const matchPct = totalArticles ? Number(((matchedArticles / totalArticles) * 100).toFixed(1)) : 100;

  return {
    totalErpStockValue: Number(totalErpStockValue.toFixed(2)),
    totalCustomsStockValue: Number(totalCustomsStockValue.toFixed(2)),
    matchedArticles,
    mismatchArticles,
    erpHigherItems,
    customsHigherItems,
    missingCustomsRecords,
    matchPct,
    totalArticles,
  };
}

function buildCharts(rows) {
  const matched = rows.filter((r) => r.status === RECON_STATUS.MATCH).length;
  const mismatch = rows.length - matched;
  const topDifferences = [...rows]
    .sort((a, b) => Math.abs(b.difference) - Math.abs(a.difference))
    .slice(0, 20)
    .map((r) => ({
      article: r.article,
      partNumber: r.partNumber,
      partName: r.partName,
      difference: r.difference,
      absDifference: Math.abs(r.difference),
      status: r.status,
    }));

  const monthMap = new Map();
  for (const row of rows) {
    if (row.status === RECON_STATUS.MATCH) continue;
    const refDate = row.lastCustomsMovementDate || row.lastErpMovementDate;
    if (!refDate) continue;
    const d = new Date(refDate);
    if (Number.isNaN(d.getTime())) continue;
    const month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    monthMap.set(month, (monthMap.get(month) || 0) + 1);
  }
  const mismatchTrend = [...monthMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(-12)
    .map(([month, count]) => ({ month, mismatchCount: count }));

  return {
    matchBreakdown: { matched, mismatch },
    topDifferences,
    mismatchTrend,
  };
}

export async function listCustomsReconciliationPage(companyId, companyCode, rawFilters = {}, paging = {}) {
  const filters = parseFilters(rawFilters);
  const page = Math.max(1, Number(paging.page) || 1);
  const exportAll = String(paging.exportAll || "").toLowerCase() === "true";
  const cap = exportAll ? 50000 : 200;
  const limit = Math.min(cap, Math.max(1, Number(paging.limit) || 50));
  const skip = (page - 1) * limit;

  const [erpMap, customsMap, customsMovementMap] = await Promise.all([
    aggregateErpStock(companyId, filters),
    aggregateCustomsStock(companyId, filters),
    aggregateCustomsMovementDates(companyId),
  ]);

  const articles = [...new Set([...erpMap.values(), ...customsMap.values()].map((r) => r.article).filter(Boolean))];
  const partNameMap = await loadPartNames(companyId, articles);

  let rows = mergeReconciliationRows(erpMap, customsMap, customsMovementMap, partNameMap, companyCode);
  rows = applyRowFilters(rows, filters);

  const summary = buildSummary(rows);
  const charts = buildCharts(rows);
  const total = rows.length;
  const items = rows.slice(skip, skip + limit);

  return {
    items,
    total,
    page,
    limit,
    summary,
    charts,
    mismatchCount: summary.mismatchArticles,
  };
}

/** Lightweight mismatch list for data-health scans (no movement dates / part-name lookups). */
export async function getCustomsReconciliationMismatches(companyId, _companyCode = "", cap = 40) {
  const [erpMap, customsMap] = await Promise.all([
    aggregateErpStock(companyId, {}),
    aggregateCustomsStock(companyId, {}),
  ]);

  const keys = [...new Set([...erpMap.keys(), ...customsMap.keys()])].sort((a, b) => a.localeCompare(b));
  const rows = [];

  for (const key of keys) {
    const erp = erpMap.get(key) || {
      article: key.split("::")[0],
      partNumber: key.split("::")[1] || "",
      erpStock: 0,
    };
    const customs = customsMap.get(key);
    const erpStock = parseNum(erp.erpStock);
    const customsStock = parseNum(customs?.customsStock);
    if (erpStock <= EPS && customsStock <= EPS && !customs?.hasCustomsRecord) continue;

    const statusRow = computeRowStatus(erpStock, customsStock, !!customs?.hasCustomsRecord);
    if (statusRow.status === RECON_STATUS.MATCH) continue;

    rows.push({
      article: erp.article || customs?.article || key.split("::")[0],
      partNumber: erp.partNumber || customs?.partNumber || key.split("::")[1] || "",
      erpStock,
      customsStock,
      status: statusRow.status,
      actionRequired: statusRow.actionRequired,
    });
    if (rows.length >= cap) break;
  }

  return rows;
}

/** Backward-compatible full list helper used by legacy callers. */
export async function buildCustomsReconciliation(companyId, companyCode = "") {
  const { items } = await listCustomsReconciliationPage(companyId, companyCode, {}, {
    page: 1,
    limit: 50000,
    exportAll: true,
  });
  return items.map((row) => ({
    article: row.article,
    partNumber: row.partNumber,
    erpStock: row.erpStock,
    customsStock: row.customsStock,
    difference: row.difference,
    actionRequired: row.status !== RECON_STATUS.MATCH,
  }));
}

export async function getCustomsReconciliationDetail(companyId, article, partNumber = "") {
  const art = upper(article);
  const part = upper(partNumber);
  if (!art) throw new Error("Article is required");

  const erpMatch = customsWithCompanyId(companyId, { article: art });
  if (part) erpMatch.itemCode = part;

  const erpRows = await StockBalance.find(erpMatch).lean();
  let erpStock = 0;
  const erpLocations = [];
  for (const row of erpRows) {
    const onHand = parseNum(row.onHandQty ?? row.quantity);
    const allocated = Math.max(parseNum(row.allocatedQty), parseNum(row.reservedQty));
    const rts = parseNum(row.rtsQty);
    const packed = parseNum(row.packedQty);
    const available = onHand - allocated - rts - packed;
    erpStock += available;
    erpLocations.push({
      warehouse: row.warehouse || row.location || "",
      location: row.location || "",
      onHandQty: onHand,
      availableQty: available,
      lastTransactionDate: row.lastTransactionDate || null,
    });
  }

  const customsMatch = customsWithCompanyId(companyId, {
    articleNumber: art,
    status: { $ne: "CANCELLED" },
  });
  if (part) customsMatch.partNumber = part;

  const customsItems = await CustomsLotItem.find(customsMatch).sort({ updatedAt: -1 }).limit(100).lean();
  const customsStock = customsItems.reduce((s, it) => s + parseNum(it.qtyAvailable), 0);

  const stockMovements = await StockLedger.find(customsWithCompanyId(companyId, { article: art }))
    .sort({ transactionDate: -1, createdAt: -1 })
    .limit(25)
    .lean();

  const customsMovements = await CustomsMovement.find(
    customsWithCompanyId(companyId, { articleNumber: art, ...(part ? { partNumber: part } : {}) }),
  )
    .sort({ movementDate: -1, createdAt: -1 })
    .limit(25)
    .lean();

  const item = await ItemMaster.findOne(customsWithCompanyId(companyId, { article: art }))
    .select("article itemName description")
    .lean();

  return {
    article: art,
    partNumber: part,
    partName: customsItems[0]?.partName || item?.itemName || item?.description || "",
    erp: {
      currentStock: erpStock,
      locations: erpLocations,
      lastMovements: stockMovements.map((m) => ({
        date: m.transactionDate || m.createdAt,
        type: m.movementType || m.transactionType || "",
        referenceNo: m.referenceNo || "",
        qtyIn: parseNum(m.qtyIn),
        qtyOut: parseNum(m.qtyOut),
        warehouse: m.warehouse || m.location || "",
        remarks: m.remarks || "",
      })),
    },
    customs: {
      currentStock: customsStock,
      items: customsItems.map((it) => ({
        boeNumber: it.boeNumber || "",
        blNumber: it.blNumber || "",
        awbNumber: it.awbNumber || "",
        supplierInvoiceNumber: it.supplierInvoiceNumber || "",
        qtyImported: parseNum(it.qtyImported),
        qtyConsumed: parseNum(it.qtyConsumed),
        qtyAvailable: parseNum(it.qtyAvailable),
        grnNo: it.grnNo || "",
        status: it.status || "",
      })),
      lastMovements: customsMovements.map((m) => ({
        date: m.movementDate || m.createdAt,
        movementType: m.movementType,
        referenceType: m.referenceType,
        referenceNumber: m.referenceNumber || "",
        qty: parseNum(m.qty),
        remarks: m.remarks || "",
      })),
    },
  };
}

export { RECON_STATUS, computeRowStatus };
