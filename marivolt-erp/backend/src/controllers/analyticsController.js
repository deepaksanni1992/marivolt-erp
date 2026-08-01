import mongoose from "mongoose";
import PDFDocument from "pdfkit";
import SalesInvoice from "../models/SalesInvoice.js";
import PurchaseOrder from "../models/PurchaseOrder.js";
import PurchaseInvoice from "../models/PurchaseInvoice.js";
import SupplierPayment from "../models/SupplierPayment.js";
import PaymentReceipt from "../models/PaymentReceipt.js";
import Shipment from "../models/Shipment.js";
import StockBalance from "../models/StockBalance.js";
import StockLedger from "../models/StockLedger.js";
import GRN from "../models/GRN.js";
import KittingOrder from "../models/KittingOrder.js";
import DeKittingOrder from "../models/DeKittingOrder.js";
import LandedCostAllocation from "../models/LandedCostAllocation.js";
import OrderAllocation from "../models/OrderAllocation.js";

const cache = new Map();
const CACHE_MS = 60 * 1000;

function monthKey(date = new Date()) {
  const d = new Date(date);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function parseDate(value, fallback = null) {
  if (!value) return fallback;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? fallback : d;
}

function normalizeFilters(req) {
  const companyId = String(req.query.company || req.companyId || "");
  const branchId = String(req.query.branch || "").trim();
  const warehouse = String(req.query.warehouse || "").trim().toUpperCase();
  const customer = String(req.query.customer || "").trim();
  const supplier = String(req.query.supplier || "").trim();
  const dateTo = parseDate(req.query.dateTo, new Date());
  const dateFrom = parseDate(req.query.dateFrom, new Date(new Date(dateTo).setUTCMonth(dateTo.getUTCMonth() - 12)));
  return { companyId, branchId, warehouse, customer, supplier, dateFrom, dateTo };
}

function pagination(req) {
  const page = Math.max(1, parseInt(String(req.query.page || "1"), 10) || 1);
  const limit = Math.min(200, Math.max(1, parseInt(String(req.query.limit || "50"), 10) || 50));
  return { page, limit, skip: (page - 1) * limit };
}

function companyMatch(companyId) {
  return mongoose.Types.ObjectId.isValid(companyId) ? { companyId: new mongoose.Types.ObjectId(companyId) } : { companyId };
}

function monthlySeries(rows, valueKey) {
  const map = new Map();
  for (const row of rows) map.set(row._id, Number(row[valueKey]) || 0);
  const now = new Date();
  const out = [];
  for (let i = 11; i >= 0; i -= 1) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const key = monthKey(d);
    out.push({ month: key, value: map.get(key) || 0 });
  }
  return out;
}

function trendDelta(series = []) {
  if (series.length < 2) return { current: series[series.length - 1]?.value || 0, previous: 0, deltaPct: 0 };
  const current = Number(series[series.length - 1]?.value || 0);
  const previous = Number(series[series.length - 2]?.value || 0);
  const deltaPct = previous === 0 ? (current > 0 ? 100 : 0) : ((current - previous) / previous) * 100;
  return { current, previous, deltaPct: Number(deltaPct.toFixed(2)) };
}

async function resolveWarehouseScopedSalesIds(f) {
  if (!f.warehouse) return null;
  const base = companyMatch(f.companyId);
  const allocRows = await OrderAllocation.find({ ...base, warehouse: f.warehouse })
    .select("linkedSalesInvoiceId")
    .lean();
  const allocInvoiceIds = allocRows
    .map((x) => x.linkedSalesInvoiceId)
    .filter(Boolean)
    .map((x) => String(x));
  const ids = [...new Set(allocInvoiceIds)];
  return ids.map((x) => new mongoose.Types.ObjectId(x));
}

function toCsv(rows = [], columns = []) {
  const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const head = columns.map((c) => esc(c.header)).join(",");
  const body = rows.map((r) => columns.map((c) => esc(r[c.key])).join(",")).join("\n");
  return `${head}\n${body}`;
}

function sendPdf(res, title, rows = [], columns = []) {
  const doc = new PDFDocument({ margin: 30, size: "A4" });
  const chunks = [];
  doc.on("data", (c) => chunks.push(c));
  doc.on("end", () => {
    const out = Buffer.concat(chunks);
    res.setHeader("Content-Type", "application/pdf");
    res.send(out);
  });
  doc.fontSize(14).text(title);
  doc.moveDown(0.5);
  doc.fontSize(8).text(columns.map((c) => c.header).join(" | "));
  doc.moveDown(0.2);
  rows.slice(0, 500).forEach((r) => doc.text(columns.map((c) => String(r[c.key] ?? "")).join(" | ")));
  doc.end();
}

async function salesAnalytics(f) {
  const warehouseInvoiceIds = await resolveWarehouseScopedSalesIds(f);
  const match = { ...companyMatch(f.companyId), invoiceDate: { $gte: f.dateFrom, $lte: f.dateTo }, status: { $ne: "CANCELLED" } };
  if (warehouseInvoiceIds) match._id = { $in: warehouseInvoiceIds };
  if (f.customer) match.customerName = { $regex: f.customer, $options: "i" };
  const [kpi, monthly, topCustomers] = await Promise.all([
    SalesInvoice.aggregate([
      { $match: match },
      { $group: { _id: null, invoiceCount: { $sum: 1 }, salesAmount: { $sum: "$grandTotal" }, receivableAmount: { $sum: "$balanceAmount" } } },
    ]),
    SalesInvoice.aggregate([
      { $match: match },
      { $group: { _id: { $dateToString: { format: "%Y-%m", date: "$invoiceDate" } }, total: { $sum: "$grandTotal" } } },
      { $sort: { _id: 1 } },
    ]),
    SalesInvoice.aggregate([
      { $match: match },
      { $group: { _id: "$customerName", value: { $sum: "$grandTotal" }, invoices: { $sum: 1 } } },
      { $sort: { value: -1 } },
      { $limit: 10 },
    ]),
  ]);
  return {
    kpis: kpi[0] || { invoiceCount: 0, salesAmount: 0, receivableAmount: 0 },
    trends: { monthlySales: monthlySeries(monthly, "total") },
    topCustomers,
  };
}

async function inventoryAnalytics(f) {
  const match = { ...companyMatch(f.companyId) };
  if (f.warehouse) match.warehouse = f.warehouse;
  const ledgerMatch = { ...companyMatch(f.companyId), transactionDate: { $gte: f.dateFrom, $lte: f.dateTo } };
  if (f.warehouse) ledgerMatch.warehouse = f.warehouse;
  const [stockRows, movement, topMoving, negativeItems] = await Promise.all([
    StockBalance.find(match).lean(),
    StockLedger.aggregate([
      { $match: ledgerMatch },
      {
        $group: {
          _id: { $dateToString: { format: "%Y-%m", date: "$transactionDate" } },
          inQty: { $sum: "$qtyIn" },
          outQty: { $sum: "$qtyOut" },
        },
      },
      { $sort: { _id: 1 } },
    ]),
    StockLedger.aggregate([
      { $match: ledgerMatch },
      { $group: { _id: "$article", movedQty: { $sum: { $add: [{ $ifNull: ["$qtyIn", 0] }, { $ifNull: ["$qtyOut", 0] }] } } } },
      { $sort: { movedQty: -1 } },
      { $limit: 10 },
    ]),
    StockBalance.find({ ...match, availableQty: { $lt: 0 } }).sort({ availableQty: 1 }).limit(20).lean(),
  ]);
  const stockValuation = stockRows.reduce((n, x) => n + (Number(x.onHandQty) || 0) * (Number(x.avgCost || x.unitCost) || 0), 0);
  const now = Date.now();
  const ageing = { "0-30": 0, "31-60": 0, "61-90": 0, "90+": 0 };
  let deadStockCount = 0;
  let fastMovingCount = 0;
  for (const row of stockRows) {
    const last = row.lastTransactionDate ? new Date(row.lastTransactionDate).getTime() : 0;
    const days = last ? Math.floor((now - last) / (24 * 3600 * 1000)) : 9999;
    if (days <= 30) ageing["0-30"] += 1;
    else if (days <= 60) ageing["31-60"] += 1;
    else if (days <= 90) ageing["61-90"] += 1;
    else ageing["90+"] += 1;
    if (days > 120 && (Number(row.onHandQty) || 0) > 0) deadStockCount += 1;
    if (days <= 30 && (Number(row.onHandQty) || 0) > 0) fastMovingCount += 1;
  }
  return {
    kpis: {
      stockValuation,
      negativeStockCount: negativeItems.length,
      deadStockCount,
      fastMovingCount,
      onHandQty: stockRows.reduce((n, x) => n + (Number(x.onHandQty) || 0), 0),
    },
    trends: {
      inventoryMovementIn: monthlySeries(movement, "inQty"),
      inventoryMovementOut: monthlySeries(movement, "outQty"),
    },
    topMovingArticles: topMoving,
    slowMovingItems: stockRows
      .filter((x) => (Number(x.onHandQty) || 0) > 0)
      .sort((a, b) => new Date(a.lastTransactionDate || 0) - new Date(b.lastTransactionDate || 0))
      .slice(0, 10)
      .map((x) => ({ article: x.article, onHandQty: x.onHandQty, lastTransactionDate: x.lastTransactionDate })),
    negativeStockItems: negativeItems.map((x) => ({ article: x.article, warehouse: x.warehouse || x.location, availableQty: x.availableQty })),
    inventoryAgeing: ageing,
  };
}

async function procurementAnalytics(f) {
  const poMatch = { ...companyMatch(f.companyId), orderDate: { $gte: f.dateFrom, $lte: f.dateTo } };
  const grnMatch = { ...companyMatch(f.companyId), grnDate: { $gte: f.dateFrom, $lte: f.dateTo } };
  if (f.branchId) poMatch.branchId = new mongoose.Types.ObjectId(f.branchId);
  if (f.warehouse) poMatch.warehouse = f.warehouse;
  if (f.supplier) {
    poMatch.supplierName = { $regex: f.supplier, $options: "i" };
    grnMatch.supplierName = { $regex: f.supplier, $options: "i" };
  }
  const [poSummary, poMonthly, grnMonthly, supplierPerf, landed] = await Promise.all([
    PurchaseOrder.aggregate([
      { $match: poMatch },
      {
        $group: {
          _id: null,
          pendingPoValue: {
            $sum: {
              $cond: [{ $in: ["$status", ["DRAFT", "SAVED", "SENT", "PARTIAL_RECEIVED"]] }, { $ifNull: ["$grandTotal", 0] }, 0],
            },
          },
          openPoCount: {
            $sum: { $cond: [{ $in: ["$status", ["DRAFT", "SAVED", "SENT", "PARTIAL_RECEIVED"]] }, 1, 0] },
          },
        },
      },
    ]),
    PurchaseOrder.aggregate([
      { $match: poMatch },
      { $group: { _id: { $dateToString: { format: "%Y-%m", date: "$orderDate" } }, total: { $sum: "$grandTotal" } } },
      { $sort: { _id: 1 } },
    ]),
    GRN.aggregate([
      { $match: grnMatch },
      { $group: { _id: { $dateToString: { format: "%Y-%m", date: "$grnDate" } }, count: { $sum: 1 }, value: { $sum: "$freight" } } },
      { $sort: { _id: 1 } },
    ]),
    PurchaseOrder.aggregate([
      { $match: poMatch },
      {
        $group: {
          _id: "$supplierName",
          totalPo: { $sum: 1 },
          delayed: {
            $sum: {
              $cond: [
                { $and: [{ $ne: ["$expectedDeliveryDate", null] }, { $lt: ["$expectedDeliveryDate", new Date()] }, { $in: ["$status", ["SENT", "PARTIAL_RECEIVED"]] }] },
                1,
                0,
              ],
            },
          },
          value: { $sum: "$grandTotal" },
        },
      },
      { $sort: { delayed: -1, value: -1 } },
      { $limit: 10 },
    ]),
    LandedCostAllocation.aggregate([
      { $match: { ...companyMatch(f.companyId), createdAt: { $gte: f.dateFrom, $lte: f.dateTo }, status: "APPLIED" } },
      { $unwind: { path: "$lines", preserveNullAndEmptyArrays: true } },
      { $group: { _id: null, landedCostImpact: { $sum: "$lines.valuationDelta" } } },
    ]),
  ]);
  return {
    kpis: poSummary[0] || { pendingPoValue: 0, openPoCount: 0 },
    trends: {
      monthlyProcurement: monthlySeries(poMonthly, "total"),
      grnTrend: monthlySeries(grnMonthly, "count"),
    },
    supplierPerformance: supplierPerf,
    delayedSuppliers: supplierPerf.filter((x) => x.delayed > 0).slice(0, 10),
    landedCostImpact: Number(landed[0]?.landedCostImpact || 0),
  };
}

function apBucket(diffDays) {
  if (diffDays < 0) return "current";
  if (diffDays <= 30) return "d0_30";
  if (diffDays <= 60) return "d31_60";
  if (diffDays <= 90) return "d61_90";
  return "d90_plus";
}

async function accountsAnalytics(f) {
  const warehouseInvoiceIds = await resolveWarehouseScopedSalesIds(f);
  const invMatch = { ...companyMatch(f.companyId), invoiceDate: { $gte: f.dateFrom, $lte: f.dateTo }, status: { $ne: "CANCELLED" } };
  const piMatch = { ...companyMatch(f.companyId), invoiceDate: { $gte: f.dateFrom, $lte: f.dateTo }, status: { $ne: "CANCELLED" } };
  if (warehouseInvoiceIds) invMatch._id = { $in: warehouseInvoiceIds };
  if (f.customer) invMatch.customerName = { $regex: f.customer, $options: "i" };
  if (f.supplier) piMatch.supplierName = { $regex: f.supplier, $options: "i" };
  const [salesInvoices, purchaseInvoices, receiptTrend, paymentTrend] = await Promise.all([
    SalesInvoice.find(invMatch).select("customerName balanceAmount invoiceDate paymentTerms grandTotal").lean(),
    PurchaseInvoice.find(piMatch).select("supplierName balanceAmount dueDate totalAmount").lean(),
    PaymentReceipt.aggregate([
      { $match: { ...companyMatch(f.companyId), receiptDate: { $gte: f.dateFrom, $lte: f.dateTo }, status: { $ne: "CANCELLED" } } },
      { $group: { _id: { $dateToString: { format: "%Y-%m", date: "$receiptDate" } }, value: { $sum: "$amountReceived" } } },
      { $sort: { _id: 1 } },
    ]),
    SupplierPayment.aggregate([
      { $match: { ...companyMatch(f.companyId), paymentDate: { $gte: f.dateFrom, $lte: f.dateTo }, status: { $ne: "CANCELLED" } } },
      { $group: { _id: { $dateToString: { format: "%Y-%m", date: "$paymentDate" } }, value: { $sum: "$amountPaid" } } },
      { $sort: { _id: 1 } },
    ]),
  ]);
  const now = Date.now();
  const arAgeing = { current: 0, d0_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0 };
  const apAgeing = { current: 0, d0_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0 };
  const overdueCustomers = [];
  for (const inv of salesInvoices) {
    const balance = Number(inv.balanceAmount || 0);
    if (balance <= 0) continue;
    const days = Math.floor((now - new Date(inv.invoiceDate || Date.now()).getTime()) / (24 * 3600 * 1000));
    const bucket = apBucket(days);
    arAgeing[bucket] += balance;
    if (days > 30) overdueCustomers.push({ customerName: inv.customerName, balanceAmount: balance, daysOverdue: days });
  }
  const overdueSuppliers = [];
  for (const inv of purchaseInvoices) {
    const balance = Number(inv.balanceAmount || 0);
    if (balance <= 0) continue;
    const due = inv.dueDate ? new Date(inv.dueDate).getTime() : now;
    const days = Math.floor((now - due) / (24 * 3600 * 1000));
    const bucket = apBucket(days);
    apAgeing[bucket] += balance;
    if (days > 0) overdueSuppliers.push({ supplierName: inv.supplierName, balanceAmount: balance, daysOverdue: days });
  }
  return {
    kpis: {
      arOutstanding: salesInvoices.reduce((n, x) => n + (Number(x.balanceAmount) || 0), 0),
      apOutstanding: purchaseInvoices.reduce((n, x) => n + (Number(x.balanceAmount) || 0), 0),
    },
    arAgeingSummary: arAgeing,
    apAgeingSummary: apAgeing,
    overdueCustomers: overdueCustomers.sort((a, b) => b.balanceAmount - a.balanceAmount).slice(0, 10),
    overdueSuppliers: overdueSuppliers.sort((a, b) => b.balanceAmount - a.balanceAmount).slice(0, 10),
    trends: {
      receivableTrend: monthlySeries(receiptTrend, "value"),
      payableTrend: monthlySeries(paymentTrend, "value"),
      cashCollectionTrend: monthlySeries(receiptTrend, "value"),
    },
  };
}

async function logisticsAnalytics(f) {
  const match = { ...companyMatch(f.companyId), createdAt: { $gte: f.dateFrom, $lte: f.dateTo } };
  if (f.warehouse) {
    const warehouseInvoiceIds = await resolveWarehouseScopedSalesIds(f);
    if (warehouseInvoiceIds && warehouseInvoiceIds.length) {
      match.$or = [
        { linkedSalesInvoiceId: { $in: warehouseInvoiceIds } },
        { "linkedSalesInvoices.invoiceId": { $in: warehouseInvoiceIds } },
      ];
    } else {
      match._id = { $in: [] };
    }
  }
  if (f.customer) match.customerName = { $regex: f.customer, $options: "i" };
  if (f.supplier) match.supplierName = { $regex: f.supplier, $options: "i" };
  const [statusRows, delayedCount, dispatchTrend, deliveredRows] = await Promise.all([
    Shipment.aggregate([{ $match: match }, { $group: { _id: "$status", count: { $sum: 1 } } }, { $sort: { count: -1 } }]),
    Shipment.countDocuments({ ...match, $or: [{ delayedDays: { $gt: 0 } }, { $and: [{ eta: { $lt: new Date() } }, { status: { $nin: ["DELIVERED", "CLOSED", "CANCELLED"] } }] }] }),
    Shipment.aggregate([
      { $match: match },
      { $group: { _id: { $dateToString: { format: "%Y-%m", date: "$createdAt" } }, count: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]),
    Shipment.find({ ...match, status: { $in: ["DELIVERED", "CLOSED"] } }).select("plannedEta actualEta delayedDays").lean(),
  ]);
  const onTime = deliveredRows.filter((x) => x.actualEta && x.plannedEta && new Date(x.actualEta) <= new Date(x.plannedEta)).length;
  const performance = deliveredRows.length ? (onTime / deliveredRows.length) * 100 : 0;
  return {
    kpis: {
      shipmentCount: statusRows.reduce((n, x) => n + (Number(x.count) || 0), 0),
      delayedShipmentCount: delayedCount,
      deliveryPerformancePct: Number(performance.toFixed(2)),
    },
    shipmentStatusSummary: statusRows,
    delayedShipments: delayedCount,
    trends: { dispatchTrend: monthlySeries(dispatchTrend, "count") },
    deliveryPerformance: { deliveredCount: deliveredRows.length, onTimeCount: onTime, onTimePct: Number(performance.toFixed(2)) },
  };
}

async function kittingAnalytics(f) {
  const match = { ...companyMatch(f.companyId), createdAt: { $gte: f.dateFrom, $lte: f.dateTo } };
  if (f.warehouse) {
    match.warehouse = f.warehouse;
  }
  const [kitRows, dekitRows, kitTrend] = await Promise.all([
    KittingOrder.find(match).select("status quantity assembledCost parentItemCode warehouse createdAt").lean(),
    DeKittingOrder.find(match).select("status quantity parentItemCode warehouse createdAt").lean(),
    KittingOrder.aggregate([
      { $match: match },
      { $group: { _id: { $dateToString: { format: "%Y-%m", date: "$createdAt" } }, count: { $sum: 1 }, qty: { $sum: "$quantity" } } },
      { $sort: { _id: 1 } },
    ]),
  ]);
  return {
    kpis: {
      completedKits: kitRows.filter((x) => x.status === "COMPLETED").length,
      completedDeKits: dekitRows.filter((x) => x.status === "COMPLETED").length,
      assembledCost: kitRows.reduce((n, x) => n + (Number(x.assembledCost) || 0) * (Number(x.quantity) || 0), 0),
    },
    trends: { kittingTrend: monthlySeries(kitTrend, "count") },
    topAssembledItems: kitRows
      .filter((x) => x.status === "COMPLETED")
      .reduce((acc, x) => {
        acc[x.parentItemCode] = (acc[x.parentItemCode] || 0) + (Number(x.quantity) || 0);
        return acc;
      }, {}),
  };
}

export async function buildDashboardPayload(req) {
  const filters = normalizeFilters(req);
  const [sales, inventory, procurement, accounts, logistics, kitting] = await Promise.all([
    salesAnalytics(filters),
    inventoryAnalytics(filters),
    procurementAnalytics(filters),
    accountsAnalytics(filters),
    logisticsAnalytics(filters),
    kittingAnalytics(filters),
  ]);
  return {
    filters,
    generatedAt: new Date().toISOString(),
    sales,
    inventory,
    procurement,
    accounts,
    logistics,
    kitting,
    trendIndicators: {
      monthlySales: trendDelta(sales.trends.monthlySales),
      monthlyProcurement: trendDelta(procurement.trends.monthlyProcurement),
      inventoryMovementIn: trendDelta(inventory.trends.inventoryMovementIn),
      receivableTrend: trendDelta(accounts.trends.receivableTrend),
      payableTrend: trendDelta(accounts.trends.payableTrend),
    },
  };
}

export async function getAnalyticsDashboard(req, res) {
  try {
    const filters = normalizeFilters(req);
    const cacheKey = JSON.stringify(filters);
    const cached = cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return res.json(cached.payload);
    }
    const payload = await buildDashboardPayload(req);
    cache.set(cacheKey, { expiresAt: Date.now() + CACHE_MS, payload });
    res.json(payload);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function getAnalyticsDrilldown(req, res) {
  try {
    const type = String(req.params.type || "").trim();
    const f = normalizeFilters(req);
    const { page, limit, skip } = pagination(req);
    if (type === "negative-stock") {
      const q = { ...companyMatch(f.companyId), availableQty: { $lt: 0 } };
      if (f.warehouse) q.warehouse = f.warehouse;
      const [items, total] = await Promise.all([
        StockBalance.find(q).sort({ availableQty: 1 }).skip(skip).limit(limit).lean(),
        StockBalance.countDocuments(q),
      ]);
      return res.json({ items, total, page, limit });
    }
    if (type === "overdue-invoices") {
      const q = { ...companyMatch(f.companyId), balanceAmount: { $gt: 0 }, status: { $ne: "CANCELLED" } };
      const [items, total] = await Promise.all([
        SalesInvoice.find(q).sort({ invoiceDate: 1 }).skip(skip).limit(limit).lean(),
        SalesInvoice.countDocuments(q),
      ]);
      return res.json({ items, total, page, limit });
    }
    if (type === "delayed-shipments") {
      const q = { ...companyMatch(f.companyId), $or: [{ delayedDays: { $gt: 0 } }, { $and: [{ eta: { $lt: new Date() } }, { status: { $nin: ["DELIVERED", "CLOSED", "CANCELLED"] } }] }] };
      const [items, total] = await Promise.all([
        Shipment.find(q).sort({ delayedDays: -1, eta: 1 }).skip(skip).limit(limit).lean(),
        Shipment.countDocuments(q),
      ]);
      return res.json({ items, total, page, limit });
    }
    if (type === "pending-po-lines") {
      const q = { ...companyMatch(f.companyId), status: { $in: ["DRAFT", "SAVED", "SENT", "PARTIAL_RECEIVED"] } };
      const rows = await PurchaseOrder.find(q).select("poNo supplierName lines expectedDeliveryDate status").lean();
      const lines = [];
      for (const po of rows) {
        for (const ln of po.lines || []) {
          if ((Number(ln.pendingQty || ln.qty || 0) || 0) <= 0) continue;
          lines.push({
            poNo: po.poNo,
            supplierName: po.supplierName,
            article: ln.article || ln.itemCode,
            pendingQty: Number(ln.pendingQty || ln.qty || 0),
            expectedDeliveryDate: po.expectedDeliveryDate,
            status: po.status,
          });
        }
      }
      const paged = lines.slice(skip, skip + limit);
      return res.json({ items: paged, total: lines.length, page, limit });
    }
    if (type === "top-moving-items") {
      const q = { ...companyMatch(f.companyId), transactionDate: { $gte: f.dateFrom, $lte: f.dateTo } };
      const items = await StockLedger.aggregate([
        { $match: q },
        { $group: { _id: "$article", movedQty: { $sum: { $add: [{ $ifNull: ["$qtyIn", 0] }, { $ifNull: ["$qtyOut", 0] }] } } } },
        { $sort: { movedQty: -1 } },
        { $skip: skip },
        { $limit: limit },
      ]);
      return res.json({ items, total: items.length, page, limit });
    }
    return res.status(400).json({ message: "Unknown drilldown type" });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

function sectionRows(payload, section) {
  if (section === "sales") return payload.sales?.topCustomers || [];
  if (section === "inventory") return payload.inventory?.topMovingArticles || [];
  if (section === "procurement") return payload.procurement?.supplierPerformance || [];
  if (section === "accounts") return payload.accounts?.overdueCustomers || [];
  if (section === "logistics") return payload.logistics?.shipmentStatusSummary || [];
  return [];
}

function sectionColumns(section) {
  if (section === "sales") return [{ key: "_id", header: "Customer" }, { key: "value", header: "Value" }, { key: "invoices", header: "Invoices" }];
  if (section === "inventory") return [{ key: "_id", header: "Article" }, { key: "movedQty", header: "Moved Qty" }];
  if (section === "procurement") return [{ key: "_id", header: "Supplier" }, { key: "totalPo", header: "Total PO" }, { key: "delayed", header: "Delayed" }, { key: "value", header: "Value" }];
  if (section === "accounts") return [{ key: "customerName", header: "Customer" }, { key: "balanceAmount", header: "Balance" }, { key: "daysOverdue", header: "Days Overdue" }];
  if (section === "logistics") return [{ key: "_id", header: "Status" }, { key: "count", header: "Count" }];
  return [];
}

export async function exportAnalyticsSection(req, res) {
  try {
    const format = String(req.query.format || "csv").toLowerCase();
    const section = String(req.params.section || "").toLowerCase();
    const payload = await buildDashboardPayload(req);
    const rows = sectionRows(payload, section);
    const columns = sectionColumns(section);
    if (!columns.length) return res.status(400).json({ message: "Unknown analytics export section" });
    if (format === "pdf") return sendPdf(res, `Analytics Export - ${section}`, rows, columns);
    const csv = toCsv(rows, columns);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename=analytics-${section}.csv`);
    return res.send(csv);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

