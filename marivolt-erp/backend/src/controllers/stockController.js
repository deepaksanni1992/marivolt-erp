import mongoose from "mongoose";
import ItemMaster from "../models/itemMasterModel.js";
import StockBalance from "../models/StockBalance.js";
import StockLedger, { TX_TYPES } from "../models/StockLedger.js";
import InventoryLedger from "../models/InventoryLedger.js";
import StockLocation from "../models/StockLocation.js";
import StockAdjustment from "../models/StockAdjustment.js";
import StockTransfer from "../models/StockTransfer.js";
import OrderAllocation from "../models/OrderAllocation.js";
import GRN from "../models/GRN.js";
import LandedCostAllocation from "../models/LandedCostAllocation.js";
import StorePacking from "../models/StorePacking.js";
import SalesInvoice from "../models/SalesInvoice.js";
import PurchaseInvoice from "../models/PurchaseInvoice.js";
import Shipment from "../models/Shipment.js";
import * as stockService from "../services/stockService.js";
import { writeAudit } from "../services/auditService.js";
import { approvalRequiredPayload, ensureApproval } from "../services/approvalService.js";
import { deriveStockBuckets } from "../services/stockExpectedBuckets.js";

/**
 * Derives the live stock buckets from a StockBalance row.
 * Delegates to canonical deriveStockBuckets — never trusts stored availableQty.
 */
function deriveStockRow(row) {
  const buckets = deriveStockBuckets(row);
  const dispatched = Number(row.dispatchedQty || 0) || 0;
  return {
    ...row,
    onHandQty: buckets.onHandQty,
    allocatedQty: buckets.allocatedQty,
    reservedQty: buckets.reservedQty,
    packedQty: buckets.packedQty,
    dispatchedQty: dispatched,
    availableQty: buckets.availableQty,
    isNegativeAvailable: buckets.isNegativeAvailable,
  };
}

const POSTED_STORE_PACKING_STATUSES = ["POSTED", "PARTIALLY_PACKED", "FULLY_PACKED"];

function stockStatusFromAvailable(available) {
  const n = Number(available) || 0;
  if (n < 0) return "NEGATIVE / BACKORDER";
  if (n === 0) return "ZERO STOCK";
  return "OK";
}

function refForAllocation(alloc) {
  return alloc.linkedProformaNo || alloc.linkedOANo || alloc.linkedQuotationNo || alloc.allocationNo || "";
}

function referenceTypeForAllocation(alloc) {
  if (alloc.linkedProformaId) return "PROFORMA";
  if (alloc.linkedOAId) return "ORDER_ACK";
  if (alloc.linkedQuotationId) return "QUOTATION";
  return "ORDER_ALLOCATION";
}

function lineQtyByArticle(lines = []) {
  const out = new Map();
  for (const line of lines || []) {
    const article = t(line?.article).toUpperCase();
    const qty = Number(line?.qty) || 0;
    if (!article || !(qty > 0)) continue;
    out.set(article, (out.get(article) || 0) + qty);
  }
  return out;
}

async function latestMovementMap(companyId, summaryRows) {
  const articles = [...new Set(summaryRows.map((r) => r.article).filter(Boolean))];
  const scopes = [
    ...new Set(
      summaryRows
        .flatMap((r) => [r.warehouse, r.location])
        .map((v) => t(v).toUpperCase())
        .filter(Boolean)
    ),
  ];
  if (!articles.length) return new Map();
  const filter = { companyId, article: { $in: articles } };
  if (scopes.length) {
    filter.$or = [{ warehouse: { $in: scopes } }, { location: { $in: scopes } }];
  }
  const ledgers = await StockLedger.find(filter)
    .sort({ transactionDate: -1, createdAt: -1 })
    .limit(Math.max(1000, summaryRows.length * 10))
    .lean();
  const map = new Map();
  for (const row of ledgers) {
    const article = t(row.article).toUpperCase();
    const warehouse = t(row.warehouse || row.location).toUpperCase();
    const location = t(row.location || row.warehouse).toUpperCase();
    for (const key of [`${article}::${warehouse}::${location}`, `${article}::${warehouse}::${warehouse}`]) {
      if (!map.has(key)) {
        map.set(key, {
          lastMovementDate: row.transactionDate || row.createdAt || null,
          lastMovementType: row.movementType || row.transactionType || "",
          lastReferenceNo: row.referenceNo || "",
        });
      }
    }
  }
  return map;
}

async function allocationPairsForFilters(req) {
  const customer = t(req.query.customer);
  const referenceNo = t(req.query.referenceNo);
  if (!customer && !referenceNo) return null;
  const filter = withCompany(req, { status: { $nin: ["CANCELLED"] } });
  if (customer) filter.customerName = new RegExp(customer, "i");
  const allocations = await OrderAllocation.find(filter)
    .select("allocationNo linkedProformaNo linkedOANo linkedQuotationNo warehouse lines customerName")
    .lean();
  const pairs = new Set();
  const refRe = referenceNo ? new RegExp(referenceNo, "i") : null;
  for (const alloc of allocations) {
    const ref = refForAllocation(alloc);
    if (refRe && !refRe.test(ref)) continue;
    const warehouse = t(alloc.warehouse || "MAIN").toUpperCase() || "MAIN";
    for (const line of alloc.lines || []) {
      const article = t(line.article).toUpperCase();
      if (!article) continue;
      pairs.add(`${article}::${warehouse}`);
    }
  }
  return pairs;
}

function withCompany(req, filter = {}) {
  return { companyId: req.companyId, ...filter };
}
function t(v) {
  return String(v ?? "").trim();
}
async function nextNo(model, companyId, prefix) {
  const y = new Date().getFullYear();
  const key = `${prefix}-${y}-`;
  const latest = await model.findOne({ companyId, [Object.keys(model.schema.paths).includes("adjustmentNo") ? "adjustmentNo" : "transferNo"]: new RegExp(`^${key}`) }).sort({ createdAt: -1 }).lean();
  const value = latest ? Number(String((latest.adjustmentNo || latest.transferNo)).split("-").pop()) + 1 : 1;
  return `${key}${String(value).padStart(5, "0")}`;
}

async function nextLandedCostNo(companyId) {
  const y = new Date().getFullYear();
  const prefix = `LC-${y}-`;
  const latest = await LandedCostAllocation.findOne({ companyId, allocationNo: new RegExp(`^${prefix}`) })
    .sort({ createdAt: -1 })
    .lean();
  const n = latest ? Number(String(latest.allocationNo).split("-").pop()) + 1 : 1;
  return `${prefix}${String(n).padStart(5, "0")}`;
}

export async function listStockBalance(req, res) {
  try {
    const page = Math.max(1, Number(req.query.page || 1));
    const limit = Math.min(500, Math.max(1, Number(req.query.limit || 50)));
    const skip = (page - 1) * limit;
    const search = t(req.query.search);
    const negativeOnly = req.query.negativeOnly === "true" || req.query.negativeOnly === "1";
    const allocatedOnly = req.query.allocatedOnly === "true" || req.query.allocatedOnly === "1";
    // Never trust stored availableQty for filtering — derive after fetch.
    const availableOnly = req.query.availableOnly === "true" || req.query.availableOnly === "1";
    const filter = withCompany(req);
    if (req.query.location) filter.location = t(req.query.location).toUpperCase();
    if (req.query.batchNo) filter.batchNo = new RegExp(t(req.query.batchNo), "i");
    if (req.query.article) filter.article = t(req.query.article).toUpperCase();
    // Trade-off: availableOnly / negativeOnly / allocatedOnly require derive-then-filter
    // in memory because persisted availableQty can be stale. Company (+ optional
    // location/article) Mongo pre-filter keeps the candidate set bounded; exact
    // availability uses onHand − reserved − packed via deriveStockRow.
    const needsDerivedPager = negativeOnly || allocatedOnly || availableOnly || Boolean(search);

    const baseQuery = StockBalance.find(filter).sort({ article: 1 });
    const rows = needsDerivedPager
      ? await baseQuery.lean()
      : await baseQuery.skip(skip).limit(limit).lean();
    const articles = [...new Set(rows.map((r) => r.article))];
    const items = await ItemMaster.find(withCompany(req, { article: { $in: articles } })).lean();
    const byArticle = new Map(items.map((it) => [it.article, it]));
    let merged = rows.map((r) => ({ ...deriveStockRow(r), item: byArticle.get(r.article) || null }));
    if (search) {
      const re = new RegExp(search, "i");
      merged = merged.filter((r) =>
        re.test(r.article) ||
        re.test(r.location || "") ||
        re.test(r.batchNo || "") ||
        re.test(r.serialNo || "") ||
        re.test(r.item?.itemName || "") ||
        re.test(r.item?.description || "") ||
        re.test(r.item?.engine || "") ||
        re.test(r.item?.model || "")
      );
    }
    if (negativeOnly) merged = merged.filter((r) => r.availableQty < 0);
    if (allocatedOnly) merged = merged.filter((r) => Number(r.allocatedQty) > 0);
    if (availableOnly) merged = merged.filter((r) => r.availableQty > 0);
    let total;
    if (needsDerivedPager) {
      total = merged.length;
      merged = merged.slice(skip, skip + limit);
    } else {
      total = await StockBalance.countDocuments(filter);
    }
    res.json({ items: merged, total, page, limit });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function listStockSummary(req, res) {
  try {
    const page = Math.max(1, Number(req.query.page || 1));
    const limit = Math.min(500, Math.max(1, Number(req.query.limit || 100)));
    const skip = (page - 1) * limit;
    const article = t(req.query.article).toUpperCase();
    const warehouse = t(req.query.warehouse || req.query.location).toUpperCase();
    const location = t(req.query.location).toUpperCase();
    const search = t(req.query.search);
    const negativeOnly = req.query.negativeOnly === "true" || req.query.negativeOnly === "1";
    const allocatedOnly = req.query.allocatedOnly === "true" || req.query.allocatedOnly === "1";
    const allocationPairs = await allocationPairsForFilters(req);
    if (allocationPairs && allocationPairs.size === 0) {
      return res.json({ items: [], total: 0, page, limit });
    }
    const allocationArticles = allocationPairs
      ? [...new Set([...allocationPairs].map((key) => key.split("::")[0]).filter(Boolean))]
      : [];

    const match = { companyId: new mongoose.Types.ObjectId(String(req.companyId)) };
    if (article) match.article = article;
    else if (allocationArticles.length) match.article = { $in: allocationArticles };
    if (warehouse) {
      match.$or = [{ warehouse }, { location: warehouse }];
    }
    if (location && location !== warehouse) {
      match.location = location;
    }
    if (search) {
      const re = new RegExp(search, "i");
      const itemHits = await ItemMaster.find(
        withCompany(req, {
          $or: [
            { article: re },
            { itemName: re },
            { description: re },
            { engine: re },
            { model: re },
            { config: re },
          ],
        })
      )
        .select("article")
        .limit(500)
        .lean();
      const hitArticles = itemHits.map((it) => it.article);
      const searchOr = [
        { article: re },
        { itemCode: re },
        { location: re },
        { warehouse: re },
      ];
      if (hitArticles.length) searchOr.push({ article: { $in: hitArticles } });
      if (match.$or) {
        match.$and = [{ $or: match.$or }, { $or: searchOr }];
        delete match.$or;
      } else {
        match.$or = searchOr;
      }
    }

    const pipeline = [
      { $match: match },
      {
        $group: {
          _id: {
            article: "$article",
            warehouse: { $ifNull: ["$warehouse", "$location"] },
            location: "$location",
          },
          onHandQty: { $sum: { $ifNull: ["$onHandQty", "$quantity"] } },
          quantity: { $sum: { $ifNull: ["$quantity", 0] } },
          allocatedQty: { $sum: { $max: ["$allocatedQty", "$reservedQty"] } },
          packedQty: { $sum: { $ifNull: ["$packedQty", 0] } },
          dispatchedQty: { $sum: { $ifNull: ["$dispatchedQty", 0] } },
          lastTransactionDate: { $max: "$lastTransactionDate" },
          rowIds: { $addToSet: "$_id" },
        },
      },
      {
        $project: {
          _id: {
            $concat: [
              "$_id.article",
              "::",
              { $ifNull: ["$_id.warehouse", ""] },
              "::",
              { $ifNull: ["$_id.location", ""] },
            ],
          },
          article: "$_id.article",
          warehouse: { $ifNull: ["$_id.warehouse", "$_id.location"] },
          location: "$_id.location",
          onHandQty: "$onHandQty",
          allocatedQty: "$allocatedQty",
          packedQty: "$packedQty",
          dispatchedQty: "$dispatchedQty",
          availableQty: {
            $subtract: [
              "$onHandQty",
              { $add: ["$allocatedQty", "$packedQty"] },
            ],
          },
          pairKey: {
            $concat: [
              "$_id.article",
              "::",
              { $ifNull: ["$_id.warehouse", "$_id.location"] },
            ],
          },
          lastTransactionDate: "$lastTransactionDate",
          rowIds: "$rowIds",
        },
      },
    ];
    const exprFilters = [];
    if (negativeOnly) exprFilters.push({ availableQty: { $lt: 0 } });
    if (allocatedOnly) exprFilters.push({ allocatedQty: { $gt: 0 } });
    if (exprFilters.length) pipeline.push({ $match: Object.assign({}, ...exprFilters) });
    if (allocationPairs) pipeline.push({ $match: { pairKey: { $in: [...allocationPairs] } } });
    pipeline.push({ $sort: { article: 1, warehouse: 1, location: 1 } });

    const [result] = await StockBalance.aggregate([
      ...pipeline,
      {
        $facet: {
          items: [{ $skip: skip }, { $limit: limit }],
          meta: [{ $count: "total" }],
        },
      },
    ]);

    let items = result?.items || [];
    const articles = [...new Set(items.map((r) => r.article).filter(Boolean))];
    const masters = articles.length
      ? await ItemMaster.find(withCompany(req, { article: { $in: articles } }))
          .select("article itemName description uom engine model config")
          .lean()
      : [];
    const masterByArticle = new Map(masters.map((m) => [m.article, m]));
    const movementByKey = await latestMovementMap(req.companyId, items);
    items = items.map((r) => {
      const wh = t(r.warehouse || r.location).toUpperCase();
      const loc = t(r.location || wh).toUpperCase();
      const movement =
        movementByKey.get(`${r.article}::${wh}::${loc}`) ||
        movementByKey.get(`${r.article}::${wh}::${wh}`) ||
        {};
      const item = masterByArticle.get(r.article) || null;
      return {
        ...r,
        item,
        itemName: item?.itemName || "",
        uom: item?.uom || "",
        negativeStatus: stockStatusFromAvailable(r.availableQty),
        lastMovementDate: movement.lastMovementDate || r.lastTransactionDate || null,
        lastMovementType: movement.lastMovementType || "",
        lastReferenceNo: movement.lastReferenceNo || "",
      };
    });

    const total = Number(result?.meta?.[0]?.total || 0);
    res.json({ items, total, page, limit });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

/**
 * Drill-down: list every active OrderAllocation line that holds reservation
 * for a given article (optionally filtered by warehouse/location and customer
 * search). Sourced from OrderAllocation, which today carries the
 * customer/reference/qty information for each reservation.
 */
export async function listCustomerAllocationsForArticle(req, res) {
  try {
    const article = t(req.query.article).toUpperCase();
    if (!article) return res.status(400).json({ message: "article query param is required" });
    const warehouse = t(req.query.warehouse || req.query.location).toUpperCase();
    const customerSearch = t(req.query.customer);
    const referenceSearch = t(req.query.referenceNo);
    const filter = withCompany(req, {
      "lines.article": article,
      status: { $nin: ["CANCELLED"] },
    });
    if (warehouse) filter.warehouse = warehouse;
    if (customerSearch) filter.customerName = new RegExp(customerSearch, "i");
    const allocations = await OrderAllocation.find(filter)
      .sort({ allocationDate: -1, createdAt: -1 })
      .lean();
    const allocationIds = allocations.map((a) => a._id);
    const [packingRows, invoiceRows] = allocationIds.length
      ? await Promise.all([
          StorePacking.find(
            withCompany(req, {
              allocationId: { $in: allocationIds },
              status: { $in: POSTED_STORE_PACKING_STATUSES },
            })
          )
            .select("allocationId status lines")
            .lean(),
          SalesInvoice.find(
            withCompany(req, {
              linkedOrderAllocationId: { $in: allocationIds },
              status: { $ne: "CANCELLED" },
            })
          )
            .select("linkedOrderAllocationId status lines")
            .lean(),
        ])
      : [[], []];
    /** Packed-but-not-yet-invoiced qty from posted Store Packing. */
    const packedQtyByAllocationArticle = new Map();
    for (const packing of packingRows) {
      const allocationId = String(packing.allocationId || "");
      const packedLines = (packing.lines || []).map((l) => ({ article: l.article, qty: l.packQty }));
      for (const [lineArticle, qty] of lineQtyByArticle(packedLines)) {
        const key = `${allocationId}::${lineArticle}`;
        packedQtyByAllocationArticle.set(key, (packedQtyByAllocationArticle.get(key) || 0) + qty);
      }
    }
    const invoiceQtyByAllocationArticle = new Map();
    for (const inv of invoiceRows) {
      const allocationId = String(inv.linkedOrderAllocationId || "");
      for (const [lineArticle, qty] of lineQtyByArticle(inv.lines || [])) {
        const key = `${allocationId}::${lineArticle}`;
        invoiceQtyByAllocationArticle.set(key, (invoiceQtyByAllocationArticle.get(key) || 0) + qty);
      }
    }
    const items = [];
    for (const alloc of allocations) {
      for (const line of alloc.lines || []) {
        if (String(line.article || "").toUpperCase() !== article) continue;
        const ref = alloc.linkedProformaNo || alloc.linkedOANo || alloc.linkedQuotationNo || alloc.allocationNo;
        if (referenceSearch && !new RegExp(referenceSearch, "i").test(ref || "")) continue;
        const allocationArticleKey = `${String(alloc._id)}::${article}`;
        const allocatedQty = Number(line.qty) || 0;
        const packedQty = Number(packedQtyByAllocationArticle.get(allocationArticleKey) || 0);
        const invoiceQty = Number(invoiceQtyByAllocationArticle.get(allocationArticleKey) || 0);
        items.push({
          allocationId: alloc._id,
          allocationNo: alloc.allocationNo,
          allocationDate: alloc.allocationDate,
          status: alloc.status,
          customerName: alloc.customerName,
          warehouse: alloc.warehouse || "MAIN",
          location: alloc.warehouse || "MAIN",
          article: line.article,
          partNumber: line.partNumber || "",
          description: line.description || "",
          uom: line.uom || "PCS",
          allocatedQty,
          packedQty,
          invoiceQty,
          pendingQty: Math.max(0, allocatedQty - packedQty - invoiceQty),
          isNegativeAllocation: Boolean(line.isNegativeAllocation),
          referenceType: referenceTypeForAllocation(alloc),
          referenceNo: ref,
          createdBy: alloc.createdBy || "",
          createdAt: alloc.createdAt,
        });
      }
    }
    res.json({ items, total: items.length });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

/**
 * Negative allocation / backorder report: returns one row per article+location
 * whose derived available is below zero, plus the customer allocation lines
 * that contributed to that negative state. Used by the Store > Negative
 * Allocation Report tab.
 */
export async function reportNegativeAllocations(req, res) {
  try {
    const article = t(req.query.article).toUpperCase();
    const warehouse = t(req.query.warehouse || req.query.location).toUpperCase();
    const customerSearch = t(req.query.customer);
    const filter = withCompany(req);
    if (article) filter.article = article;
    if (warehouse) filter.location = warehouse;
    const balances = await StockBalance.find(filter).lean();
    const articles = [...new Set(balances.map((b) => b.article))];
    const masters = await ItemMaster.find(withCompany(req, { article: { $in: articles } }))
      .select("article itemName uom")
      .lean();
    const masterByArticle = new Map(masters.map((m) => [m.article, m]));
    const allocFilter = withCompany(req, {
      status: { $nin: ["CANCELLED"] },
      "lines.article": { $in: articles },
    });
    if (customerSearch) allocFilter.customerName = new RegExp(customerSearch, "i");
    const allocs = articles.length
      ? await OrderAllocation.find(allocFilter).sort({ allocationDate: -1 }).lean()
      : [];
    const allocationsByArticleWarehouse = new Map();
    for (const alloc of allocs) {
      const wh = String(alloc.warehouse || "MAIN").toUpperCase();
      for (const line of alloc.lines || []) {
        const lineArticle = String(line.article || "").toUpperCase();
        if (!lineArticle) continue;
        const key = `${lineArticle}::${wh}`;
        if (!allocationsByArticleWarehouse.has(key)) allocationsByArticleWarehouse.set(key, []);
        allocationsByArticleWarehouse.get(key).push({
          allocationId: alloc._id,
          allocationNo: alloc.allocationNo,
          allocationDate: alloc.allocationDate,
          status: alloc.status,
          customerName: alloc.customerName,
          referenceNo:
            alloc.linkedProformaNo ||
            alloc.linkedOANo ||
            alloc.linkedQuotationNo ||
            alloc.allocationNo,
          referenceType: alloc.linkedProformaId
            ? "PROFORMA"
            : alloc.linkedOAId
              ? "ORDER_ACK"
              : alloc.linkedQuotationId
                ? "QUOTATION"
                : "ORDER_ALLOCATION",
          allocatedQty: Number(line.qty) || 0,
          isNegativeAllocation: Boolean(line.isNegativeAllocation),
          createdBy: alloc.createdBy || "",
          createdAt: alloc.createdAt,
        });
      }
    }
    const items = [];
    for (const balance of balances) {
      const derived = deriveStockRow(balance);
      if (derived.availableQty >= 0) continue;
      const master = masterByArticle.get(derived.article);
      const allocations = allocationsByArticleWarehouse.get(`${derived.article}::${String(derived.location || "").toUpperCase()}`) || [];
      // If the user asked for a customer search and this row has no matching
      // allocations after filtering, skip it.
      if (customerSearch && !allocations.length) continue;
      items.push({
        article: derived.article,
        itemName: master?.itemName || "",
        uom: master?.uom || "",
        warehouse: derived.warehouse || derived.location || "",
        location: derived.location || "",
        onHandQty: derived.onHandQty,
        allocatedQty: derived.allocatedQty,
        availableQty: derived.availableQty,
        negativeQty: Math.max(0, -derived.availableQty),
        shortageQty: Math.max(0, -derived.availableQty),
        allocations,
      });
    }
    items.sort((a, b) => a.availableQty - b.availableQty);
    const movementByKey = await latestMovementMap(req.companyId, items);
    for (const item of items) {
      const wh = t(item.warehouse || item.location).toUpperCase();
      const loc = t(item.location || wh).toUpperCase();
      const movement =
        movementByKey.get(`${item.article}::${wh}::${loc}`) ||
        movementByKey.get(`${item.article}::${wh}::${wh}`) ||
        {};
      item.lastMovementDate = movement.lastMovementDate || null;
    }
    res.json({ items, total: items.length });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function getBalanceByArticle(req, res) {
  try {
    const article = t(req.params.article).toUpperCase();
    const rows = await StockBalance.find(withCompany(req, { article })).sort({ location: 1 }).lean();
    res.json(rows);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function listStockLedger(req, res) {
  try {
    const page = Math.max(1, Number(req.query.page || 1));
    const limit = Math.min(500, Math.max(1, Number(req.query.limit || 100)));
    const skip = (page - 1) * limit;
    const filter = withCompany(req);
    if (req.query.article) filter.article = t(req.query.article).toUpperCase();
    if (req.query.transactionType) filter.transactionType = t(req.query.transactionType);
    if (req.query.referenceNo) filter.referenceNo = new RegExp(t(req.query.referenceNo), "i");
    if (req.query.location) filter.location = t(req.query.location).toUpperCase();
    if (req.query.dateFrom || req.query.dateTo) {
      filter.transactionDate = {};
      if (req.query.dateFrom) filter.transactionDate.$gte = new Date(req.query.dateFrom);
      if (req.query.dateTo) filter.transactionDate.$lte = new Date(req.query.dateTo);
    }
    const [items, total] = await Promise.all([
      StockLedger.find(filter).sort({ transactionDate: -1, createdAt: -1 }).skip(skip).limit(limit).lean(),
      StockLedger.countDocuments(filter),
    ]);
    const articleList = [...new Set(items.map((r) => r.article))];
    const masters = await ItemMaster.find(withCompany(req, { article: { $in: articleList } })).select("article itemName").lean();
    const map = new Map(masters.map((x) => [x.article, x.itemName]));
    res.json({ items: items.map((r) => ({ ...r, itemName: map.get(r.article) || "" })), total, page, limit });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

/* ------------------------------------------------------------------ */
/*  Unified stock ledger — multi-source projection                     */
/* ------------------------------------------------------------------ */

/**
 * Maps a raw transactionType (StockLedger) or movementType
 * (InventoryLedger) value to the unified vocabulary the UI uses.
 */
const STOCK_LEDGER_TYPE_TO_UNIFIED = {
  GRN: "GRN_IN",
  SALES_ALLOCATION: "ALLOCATION",
  ORDER_ALLOCATION_CANCEL: "ALLOCATION_CANCEL",
  SALES_INVOICE: "SALES_INVOICE_OUT",
  SALES_INVOICE_CANCEL: "SALES_INVOICE_CANCEL",
  STOCK_ADJUSTMENT: "STOCK_ADJUSTMENT",
  TRANSFER_IN: "STOCK_TRANSFER_IN",
  TRANSFER_OUT: "STOCK_TRANSFER_OUT",
  OPENING: "OPENING",
  PACKED: "PACKED",
  UNPACKED: "UNPACKED",
  DISPATCH_OUT: "DISPATCH_OUT",
  DISPATCH_CANCEL: "DISPATCH_CANCEL",
  ARTICLE_CONVERSION_OUT: "ARTICLE_CONVERSION_OUT",
  ARTICLE_CONVERSION_IN: "ARTICLE_CONVERSION_IN",
  ARTICLE_CONVERSION_REVERSAL_OUT: "ARTICLE_CONVERSION_REVERSAL_OUT",
  ARTICLE_CONVERSION_REVERSAL_IN: "ARTICLE_CONVERSION_REVERSAL_IN",
};

const INVENTORY_LEDGER_TYPE_TO_UNIFIED = {
  IN_PURCHASE: "GRN_IN",
  OUT_SALE: "SALES_INVOICE_OUT",
  ADJUSTMENT: "STOCK_ADJUSTMENT",
  IN_RETURN: "IN_RETURN",
  OUT_RETURN: "OUT_RETURN",
  TRANSFER_IN: "STOCK_TRANSFER_IN",
  TRANSFER_OUT: "STOCK_TRANSFER_OUT",
  OPENING: "OPENING",
  KIT_COMPONENT_OUT: "KIT_COMPONENT_OUT",
  KIT_PARENT_IN: "KIT_PARENT_IN",
  DEKIT_PARENT_OUT: "DEKIT_PARENT_OUT",
  DEKIT_COMPONENT_IN: "DEKIT_COMPONENT_IN",
  SALES_RESERVE: "ALLOCATION",
  SALES_RESERVE_RELEASE: "ALLOCATION_CANCEL",
  SALES_INVOICE_OUT: "SALES_INVOICE_OUT",
  SALES_INVOICE_CANCEL_RESTORE: "SALES_INVOICE_CANCEL",
};

/** Reverse maps used to translate a unified filter back to per-source raw types. */
const UNIFIED_TO_STOCK_LEDGER_TYPES = {};
const UNIFIED_TO_INVENTORY_LEDGER_TYPES = {};
for (const [raw, unified] of Object.entries(STOCK_LEDGER_TYPE_TO_UNIFIED)) {
  if (!UNIFIED_TO_STOCK_LEDGER_TYPES[unified]) UNIFIED_TO_STOCK_LEDGER_TYPES[unified] = [];
  UNIFIED_TO_STOCK_LEDGER_TYPES[unified].push(raw);
}
for (const [raw, unified] of Object.entries(INVENTORY_LEDGER_TYPE_TO_UNIFIED)) {
  if (!UNIFIED_TO_INVENTORY_LEDGER_TYPES[unified]) UNIFIED_TO_INVENTORY_LEDGER_TYPES[unified] = [];
  UNIFIED_TO_INVENTORY_LEDGER_TYPES[unified].push(raw);
}

/**
 * Returns true when a movement affects the Allocated bucket (positive or
 * negative). Used to decide whether to surface qtyIn/qtyOut at the
 * "available stock" granularity for the unified view.
 */
function isAllocationBucketMovement(rawType) {
  return rawType === "SALES_RESERVE" || rawType === "SALES_RESERVE_RELEASE";
}

/**
 * Splits `qtyDelta` into qtyIn / qtyOut for the unified view. We treat
 * the Available pool (On Hand - Allocated - Packed) as the canonical
 * "in/out" measure for non-physical movements so the user sees a single
 * column that always lines up with the impact on Available.
 */
function splitDelta(rawType, qtyDelta) {
  const delta = Number(qtyDelta) || 0;
  // Allocation reserves / releases: physical On Hand is unchanged but
  // Available drops or recovers. Reflect that as an out/in.
  if (isAllocationBucketMovement(rawType)) {
    return delta > 0
      ? { qtyIn: 0, qtyOut: Math.abs(delta) }
      : { qtyIn: Math.abs(delta), qtyOut: 0 };
  }
  return delta > 0
    ? { qtyIn: Math.abs(delta), qtyOut: 0 }
    : { qtyIn: 0, qtyOut: Math.abs(delta) };
}

/**
 * Unified Stock Ledger projection — merges StockLedger (GRN, adjustment,
 * transfer, sales) with InventoryLedger (sales reservation, packing,
 * invoice flow) into one normalized response. Existing write paths are
 * unchanged; this is a read-only projection for the Store > Stock Ledger
 * tab. Pagination is performed in memory after merging the two sources
 * so users get a single time-ordered view.
 */
export async function listUnifiedStockLedger(req, res) {
  try {
    const page = Math.max(1, Number(req.query.page || 1));
    const limit = Math.min(500, Math.max(1, Number(req.query.limit || 100)));
    const skip = (page - 1) * limit;

    const article = t(req.query.article).toUpperCase();
    const referenceNoSearch = t(req.query.referenceNo);
    const customerSearch = t(req.query.customerName || req.query.customer);
    const warehouseFilter = t(req.query.warehouse || req.query.location).toUpperCase();
    const sourceModel = t(req.query.sourceModel);
    const unifiedMovementType = t(req.query.movementType).toUpperCase();
    const dateFrom = req.query.dateFrom ? new Date(req.query.dateFrom) : null;
    let dateTo = req.query.dateTo ? new Date(req.query.dateTo) : null;
    // If the caller passed a date-only value (no time component) treat it as
    // end-of-day so the inclusive range matches the user's expectation.
    if (dateTo && /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.dateTo))) {
      dateTo.setHours(23, 59, 59, 999);
    }

    // To keep memory bounded while still giving accurate paging in most
    // realistic data sizes we cap each source at this many rows.
    const fetchCap = Math.max(limit * 5, 500);

    /* ---------- StockLedger filter --------------------------------- */
    const stockLedgerFilter = withCompany(req);
    if (article) stockLedgerFilter.article = article;
    if (warehouseFilter) stockLedgerFilter.location = warehouseFilter;
    if (referenceNoSearch) stockLedgerFilter.referenceNo = new RegExp(referenceNoSearch, "i");
    if (dateFrom || dateTo) {
      stockLedgerFilter.transactionDate = {};
      if (dateFrom) stockLedgerFilter.transactionDate.$gte = dateFrom;
      if (dateTo) stockLedgerFilter.transactionDate.$lte = dateTo;
    }
    if (unifiedMovementType) {
      const raws = UNIFIED_TO_STOCK_LEDGER_TYPES[unifiedMovementType] || [];
      // Caller may pass a raw type (e.g. "GRN") — accept both vocabularies.
      const directTypes = TX_TYPES.includes(unifiedMovementType) ? [unifiedMovementType] : [];
      const all = [...new Set([...raws, ...directTypes])];
      if (all.length === 0) {
        stockLedgerFilter.transactionType = "__NO_MATCH__";
      } else {
        stockLedgerFilter.transactionType = { $in: all };
      }
    }

    /* ---------- InventoryLedger filter ----------------------------- */
    const invLedgerFilter = withCompany(req);
    if (article) invLedgerFilter.itemCode = article;
    if (warehouseFilter) invLedgerFilter.warehouse = warehouseFilter;
    if (referenceNoSearch) invLedgerFilter.referenceNumber = new RegExp(referenceNoSearch, "i");
    if (dateFrom || dateTo) {
      invLedgerFilter.createdAt = {};
      if (dateFrom) invLedgerFilter.createdAt.$gte = dateFrom;
      if (dateTo) invLedgerFilter.createdAt.$lte = dateTo;
    }
    if (unifiedMovementType) {
      const raws = UNIFIED_TO_INVENTORY_LEDGER_TYPES[unifiedMovementType] || [];
      const directTypes = Object.keys(INVENTORY_LEDGER_TYPE_TO_UNIFIED).includes(unifiedMovementType)
        ? [unifiedMovementType]
        : [];
      const all = [...new Set([...raws, ...directTypes])];
      if (all.length === 0) {
        invLedgerFilter.movementType = "__NO_MATCH__";
      } else {
        invLedgerFilter.movementType = { $in: all };
      }
    }

    /* ---------- Pull from the two sources -------------------------- */
    const wantStockLedger = !sourceModel || sourceModel === "StockLedger";
    const wantInventoryLedger = !sourceModel || sourceModel === "InventoryLedger";

    const [stockLedgerRows, invLedgerRows] = await Promise.all([
      wantStockLedger
        ? StockLedger.find(stockLedgerFilter)
            .sort({ transactionDate: -1, createdAt: -1 })
            .limit(fetchCap)
            .lean()
        : Promise.resolve([]),
      wantInventoryLedger
        ? InventoryLedger.find(invLedgerFilter).sort({ createdAt: -1 }).limit(fetchCap).lean()
        : Promise.resolve([]),
    ]);

    /* ---------- Batch enrichment lookups --------------------------- */
    const articleSet = new Set();
    const grnNos = new Set();
    const allocationNos = new Set();
    const invoiceNos = new Set();

    for (const r of stockLedgerRows) {
      if (r.article) articleSet.add(String(r.article).toUpperCase());
      const ref = String(r.referenceNo || "").trim();
      if (!ref) continue;
      switch (r.transactionType) {
        case "GRN":
          grnNos.add(ref);
          break;
        case "SALES_ALLOCATION":
        case "ORDER_ALLOCATION_CANCEL":
          allocationNos.add(ref);
          break;
        case "SALES_INVOICE":
        case "SALES_INVOICE_CANCEL":
          invoiceNos.add(ref);
          break;
        default:
          break;
      }
    }
    for (const r of invLedgerRows) {
      if (r.itemCode) articleSet.add(String(r.itemCode).toUpperCase());
      const ref = String(r.referenceNumber || "").trim();
      if (!ref) continue;
      const refType = String(r.referenceType || "").toUpperCase();
      if (r.movementType === "IN_PURCHASE" || refType === "GRN") {
        grnNos.add(ref);
        continue;
      }
      if (
        refType === "ORDER_ALLOCATION" ||
        refType === "ORDER_ALLOCATION_CANCEL" ||
        refType === "ORDER_ALLOCATION_RESERVE_BACKFILL"
      ) {
        allocationNos.add(ref);
        continue;
      }
      if (refType === "SALES_INVOICE" || refType === "SALES_INVOICE_CANCEL") {
        invoiceNos.add(ref);
        continue;
      }
      // Best-effort fallback by movement type when referenceType is empty.
      switch (r.movementType) {
        case "SALES_RESERVE":
        case "SALES_RESERVE_RELEASE":
          allocationNos.add(ref);
          break;
        case "SALES_INVOICE_OUT":
        case "SALES_INVOICE_CANCEL_RESTORE":
        case "OUT_SALE":
          invoiceNos.add(ref);
          break;
        default:
          break;
      }
    }

    const [items, grns, allocations, invoices] = await Promise.all([
      articleSet.size
        ? ItemMaster.find(withCompany(req, { article: { $in: [...articleSet] } }))
            .select("article itemName")
            .lean()
        : [],
      grnNos.size
        ? GRN.find(withCompany(req, { grnNo: { $in: [...grnNos] } }))
            .select("grnNo supplierName")
            .lean()
        : [],
      allocationNos.size
        ? OrderAllocation.find(withCompany(req, { allocationNo: { $in: [...allocationNos] } }))
            .select("allocationNo customerName warehouse")
            .lean()
        : [],
      invoiceNos.size
        ? SalesInvoice.find(withCompany(req, { invoiceNo: { $in: [...invoiceNos] } }))
            .select("invoiceNo customerName")
            .lean()
        : [],
    ]);

    const itemNameByArticle = new Map(items.map((x) => [String(x.article).toUpperCase(), x.itemName || ""]));
    const supplierByGrn = new Map(grns.map((g) => [g.grnNo, g.supplierName || ""]));
    const allocationByNo = new Map(allocations.map((a) => [a.allocationNo, a]));
    const invoiceByNo = new Map(invoices.map((i) => [i.invoiceNo, i.customerName || ""]));

    /* ---------- Normalize each source ------------------------------ */
    const merged = [];

    for (const r of stockLedgerRows) {
      const rawType = r.transactionType;
      const ref = String(r.referenceNo || "").trim();
      let customerName = "";
      let supplierName = "";
      switch (rawType) {
        case "GRN":
          supplierName = supplierByGrn.get(ref) || "";
          break;
        case "SALES_ALLOCATION":
        case "ORDER_ALLOCATION_CANCEL":
          customerName = allocationByNo.get(ref)?.customerName || "";
          break;
        case "SALES_INVOICE":
        case "SALES_INVOICE_CANCEL":
          customerName = invoiceByNo.get(ref) || "";
          break;
        default:
          break;
      }
      const unified = STOCK_LEDGER_TYPE_TO_UNIFIED[rawType] || rawType || "OTHER";
      const isTransferIn = rawType === "TRANSFER_IN";
      const isTransferOut = rawType === "TRANSFER_OUT";
      // Phase-3 enrichment: prefer persisted columns when present,
      // fall back to legacy fields for historical rows.
      merged.push({
        date: r.transactionDate || r.createdAt,
        article: String(r.article || "").toUpperCase(),
        itemName: itemNameByArticle.get(String(r.article || "").toUpperCase()) || "",
        movementType: r.movementType || unified,
        rawMovementType: rawType,
        referenceType: r.referenceType || "",
        referenceNo: ref,
        customerName: r.customerName || customerName,
        supplierName: r.supplierName || supplierName,
        warehouse: String(r.warehouse || r.location || "").toUpperCase(),
        locationFrom: r.locationFrom || (isTransferOut ? String(r.location || "").toUpperCase() : ""),
        locationTo: r.locationTo || (isTransferIn ? String(r.location || "").toUpperCase() : ""),
        qtyIn: Number(r.qtyIn || 0),
        qtyOut: Number(r.qtyOut || 0),
        onHandAfter: r.onHandAfter != null ? Number(r.onHandAfter) : r.balanceQty != null ? Number(r.balanceQty) : null,
        allocatedAfter: r.allocatedAfter != null ? Number(r.allocatedAfter) : null,
        packedAfter: r.packedAfter != null ? Number(r.packedAfter) : null,
        availableAfter: r.availableAfter != null ? Number(r.availableAfter) : null,
        sourceModule: r.sourceModule || "",
        sourceModel: "StockLedger",
        createdBy: r.createdBy || "",
        remarks: r.remarks || "",
        isNegativeAllocation: Boolean(r.isNegativeAllocation),
        _rowId: String(r._id),
      });
    }

    for (const r of invLedgerRows) {
      const rawType = r.movementType;
      const refType = String(r.referenceType || "").toUpperCase();
      const ref = String(r.referenceNumber || "").trim();
      let customerName = "";
      let supplierName = "";
      if (
        refType === "ORDER_ALLOCATION" ||
        refType === "ORDER_ALLOCATION_CANCEL" ||
        refType === "ORDER_ALLOCATION_RESERVE_BACKFILL" ||
        rawType === "SALES_RESERVE" ||
        rawType === "SALES_RESERVE_RELEASE"
      ) {
        customerName = allocationByNo.get(ref)?.customerName || "";
      } else if (
        refType === "SALES_INVOICE" ||
        refType === "SALES_INVOICE_CANCEL" ||
        rawType === "SALES_INVOICE_OUT" ||
        rawType === "SALES_INVOICE_CANCEL_RESTORE" ||
        rawType === "OUT_SALE"
      ) {
        customerName = invoiceByNo.get(ref) || "";
      } else if (rawType === "IN_PURCHASE" || refType === "GRN") {
        supplierName = supplierByGrn.get(ref) || "";
      }
      // Prefer the persisted Phase-3 qtyIn/qtyOut/after-balances when
      // present (new writes), fall back to deriving from qtyDelta for
      // historical InventoryLedger rows that pre-date Phase-3.
      const split =
        r.qtyIn != null || r.qtyOut != null
          ? { qtyIn: Number(r.qtyIn || 0), qtyOut: Number(r.qtyOut || 0) }
          : splitDelta(rawType, r.qtyDelta);
      const unified = INVENTORY_LEDGER_TYPE_TO_UNIFIED[rawType] || rawType || "OTHER";
      const wh = String(r.warehouse || "").toUpperCase();
      const isTransferIn = rawType === "TRANSFER_IN";
      const isTransferOut = rawType === "TRANSFER_OUT";
      merged.push({
        date: r.createdAt || r.updatedAt,
        article: String(r.itemCode || "").toUpperCase(),
        itemName: itemNameByArticle.get(String(r.itemCode || "").toUpperCase()) || "",
        movementType: unified,
        rawMovementType: rawType,
        referenceType: r.referenceType || "",
        referenceNo: r.referenceNo || ref,
        customerName: r.customerName || customerName,
        supplierName: r.supplierName || supplierName,
        warehouse: wh,
        locationFrom: r.locationFrom || (isTransferOut ? wh : ""),
        locationTo: r.locationTo || (isTransferIn ? wh : ""),
        qtyIn: split.qtyIn,
        qtyOut: split.qtyOut,
        onHandAfter: r.onHandAfter != null ? Number(r.onHandAfter) : null,
        allocatedAfter: r.allocatedAfter != null ? Number(r.allocatedAfter) : null,
        packedAfter: r.packedAfter != null ? Number(r.packedAfter) : null,
        availableAfter: r.availableAfter != null ? Number(r.availableAfter) : null,
        sourceModule: r.sourceModule || "",
        sourceModel: "InventoryLedger",
        createdBy: r.createdBy || "",
        remarks: r.remarks || "",
        isNegativeAllocation: Boolean(r.isNegativeAllocation),
        _rowId: String(r._id),
      });
    }

    /* ---------- Post-projection filters & paging ------------------- */
    let filtered = merged;
    if (customerSearch) {
      const re = new RegExp(customerSearch, "i");
      filtered = filtered.filter(
        (r) => re.test(r.customerName || "") || re.test(r.supplierName || "")
      );
    }
    filtered.sort((a, b) => {
      const da = new Date(a.date || 0).getTime();
      const db = new Date(b.date || 0).getTime();
      if (db !== da) return db - da;
      return String(b._rowId || "").localeCompare(String(a._rowId || ""));
    });
    const total = filtered.length;
    const pageItems = filtered.slice(skip, skip + limit);

    res.json({
      items: pageItems,
      total,
      page,
      limit,
      sources: {
        stockLedger: stockLedgerRows.length,
        inventoryLedger: invLedgerRows.length,
        capped: stockLedgerRows.length === fetchCap || invLedgerRows.length === fetchCap,
      },
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function getStockLedgerByArticle(req, res) {
  try {
    const article = t(req.params.article).toUpperCase();
    const rows = await StockLedger.find(withCompany(req, { article })).sort({ transactionDate: -1 }).lean();
    res.json(rows);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function createAdjustment(req, res) {
  try {
    const adjustmentNo = t(req.body.adjustmentNo) || (await nextNo(StockAdjustment, req.companyId, "ADJ"));
    const doc = await StockAdjustment.create({
      companyId: req.companyId,
      adjustmentNo,
      date: req.body.date || new Date(),
      article: t(req.body.article).toUpperCase(),
      location: t(req.body.location).toUpperCase(),
      adjustmentType: req.body.adjustmentType === "Decrease" ? "Decrease" : "Increase",
      quantity: Number(req.body.quantity) || 0,
      reason: t(req.body.reason),
      remarks: t(req.body.remarks),
    });
    res.status(201).json(doc);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function postAdjustment(req, res) {
  const session = await mongoose.startSession();
  try {
    const rowForApproval = await StockAdjustment.findOne(
      withCompany(req, { adjustmentNo: t(req.params.adjustmentNo).toUpperCase() })
    ).lean();
    if (!rowForApproval) return res.status(404).json({ message: "Adjustment not found" });
    if (rowForApproval.status !== "Draft") return res.status(400).json({ message: "Adjustment already posted" });
    const gate = await ensureApproval(req, {
      companyId: req.companyId,
      module: "STORE",
      actionKey: "adjustment_post",
      documentType: "STOCK_ADJUSTMENT",
      documentId: rowForApproval._id,
      documentNo: rowForApproval.adjustmentNo,
      amount: Math.abs(Number(rowForApproval.quantity || 0)),
      currency: "USD",
      description: `Post stock adjustment ${rowForApproval.adjustmentNo}`,
    });
    if (!gate.approved) return res.status(202).json(approvalRequiredPayload(gate.request));
    await session.withTransaction(async () => {
      const row = await StockAdjustment.findOne(withCompany(req, { adjustmentNo: t(req.params.adjustmentNo).toUpperCase() })).session(session);
      if (!row) throw new Error("Adjustment not found");
      if (row.status !== "Draft") throw new Error("Adjustment already posted");
      const item = await ItemMaster.findOne(withCompany(req, { article: row.article })).session(session);
      if (!item) throw new Error("Article not found");
      const loc = await StockLocation.findOne(withCompany(req, { locationCode: row.location, status: "Active" })).session(session);
      if (!loc) throw new Error("Location not found");
      await stockService.stockAdjustment({
        session,
        companyId: req.companyId,
        article: row.article,
        warehouse: row.location,
        qty: row.quantity,
        direction: row.adjustmentType,
        referenceType: "STOCK_ADJUSTMENT",
        referenceNo: row.adjustmentNo,
        remarks: `${row.reason}${row.remarks ? ` | ${row.remarks}` : ""}`,
        createdBy: req.user?.email || "",
        sourceModule: "STORE",
        transactionDate: row.date,
        lineId: String(row._id || row.adjustmentNo),
      });
      row.status = "Posted";
      row.postedAt = new Date();
      await row.save({ session });
      await writeAudit(req, {
        action: "STOCK",
        module: "STORE",
        entityType: "STOCK_ADJUSTMENT",
        entityId: row._id,
        documentNo: row.adjustmentNo,
        toStatus: "Posted",
        description: `Stock adjustment ${row.adjustmentNo} posted (${row.adjustmentType} ${row.quantity})`,
        metadata: {
          article: row.article,
          location: row.location,
          adjustmentType: row.adjustmentType,
          quantity: row.quantity,
          reason: row.reason,
        },
      });
    });
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ message: err.message });
  } finally {
    await session.endSession();
  }
}

export async function createTransfer(req, res) {
  try {
    const transferNo = t(req.body.transferNo) || (await nextNo(StockTransfer, req.companyId, "TRF"));
    const row = await StockTransfer.create({
      companyId: req.companyId,
      transferNo,
      date: req.body.date || new Date(),
      article: t(req.body.article).toUpperCase(),
      fromLocation: t(req.body.fromLocation).toUpperCase(),
      toLocation: t(req.body.toLocation).toUpperCase(),
      quantity: Number(req.body.quantity) || 0,
      remarks: t(req.body.remarks),
    });
    res.status(201).json(row);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function postTransfer(req, res) {
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const row = await StockTransfer.findOne(withCompany(req, { transferNo: t(req.params.transferNo).toUpperCase() })).session(session);
      if (!row) throw new Error("Transfer not found");
      if (row.status !== "Draft") throw new Error("Transfer already posted");
      if (row.fromLocation === row.toLocation) throw new Error("From/To location must differ");
      // stockService.stockTransfer guards available qty atomically
      // inside the transaction; no separate pre-check needed.
      await stockService.stockTransfer({
        session,
        companyId: req.companyId,
        article: row.article,
        fromWarehouse: row.fromLocation,
        toWarehouse: row.toLocation,
        qty: row.quantity,
        referenceType: "TRANSFER",
        referenceNo: row.transferNo,
        remarks: row.remarks,
        createdBy: req.user?.email || "",
        sourceModule: "STORE",
        transactionDate: row.date,
        transferLineId: String(row._id),
      });
      row.status = "Posted";
      row.postedAt = new Date();
      await row.save({ session });
      await writeAudit(req, {
        action: "STOCK",
        module: "STORE",
        entityType: "STOCK_TRANSFER",
        entityId: row._id,
        documentNo: row.transferNo,
        toStatus: "Posted",
        description: `Stock transfer ${row.transferNo} posted: ${row.fromLocation} → ${row.toLocation} qty ${row.quantity}`,
        metadata: {
          article: row.article,
          fromLocation: row.fromLocation,
          toLocation: row.toLocation,
          quantity: row.quantity,
        },
      });
    });
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ message: err.message });
  } finally {
    await session.endSession();
  }
}

export async function createLocation(req, res) {
  try {
    const row = await StockLocation.create({
      companyId: req.companyId,
      locationCode: t(req.body.locationCode).toUpperCase(),
      locationName: t(req.body.locationName),
      warehouse: t(req.body.warehouse),
      rack: t(req.body.rack),
      bin: t(req.body.bin),
      status: req.body.status === "Inactive" ? "Inactive" : "Active",
    });
    res.status(201).json(row);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function listLocations(req, res) {
  try {
    const rows = await StockLocation.find(withCompany(req)).sort({ locationCode: 1 }).lean();
    res.json(rows);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function updateLocation(req, res) {
  try {
    const row = await StockLocation.findOneAndUpdate(
      withCompany(req, { locationCode: t(req.params.locationCode).toUpperCase() }),
      {
        locationName: t(req.body.locationName),
        warehouse: t(req.body.warehouse),
        rack: t(req.body.rack),
        bin: t(req.body.bin),
        status: req.body.status === "Inactive" ? "Inactive" : "Active",
      },
      { new: true, runValidators: true }
    );
    if (!row) return res.status(404).json({ message: "Location not found" });
    res.json(row);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function deleteLocation(req, res) {
  try {
    const code = t(req.params.locationCode).toUpperCase();
    const used = await StockBalance.findOne(withCompany(req, { location: code })).lean();
    if (used && Number(used.onHandQty || 0) > 0) {
      return res.status(400).json({ message: "Cannot delete location with stock" });
    }
    const row = await StockLocation.findOneAndDelete(withCompany(req, { locationCode: code }));
    if (!row) return res.status(404).json({ message: "Location not found" });
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function stockMeta(req, res) {
  const unifiedMovementTypes = [
    ...new Set([
      ...Object.values(STOCK_LEDGER_TYPE_TO_UNIFIED),
      ...Object.values(INVENTORY_LEDGER_TYPE_TO_UNIFIED),
      "LANDED_COST_ADJUSTMENT",
    ]),
  ].sort();
  res.json({
    transactionTypes: TX_TYPES,
    unifiedMovementTypes,
    sourceModels: ["StockLedger", "InventoryLedger"],
  });
}

function normalizeLandedCostPayload(body = {}) {
  const allowed = new Set(["QUANTITY", "LINE_VALUE", "WEIGHT", "VOLUME"]);
  const method = t(body.allocationMethod || "LINE_VALUE").toUpperCase();
  const allocationMethod = allowed.has(method) ? method : "LINE_VALUE";
  const components = (Array.isArray(body.components) ? body.components : [])
    .map((row) => {
      const componentType = t(row?.componentType).toUpperCase();
      const amount = Number(row?.amount) || 0;
      const currency = t(row?.currency || body.currency || "USD").toUpperCase() || "USD";
      const exchangeRate = Number(row?.exchangeRate ?? body.exchangeRate) || 1;
      return {
        componentType,
        amount,
        currency,
        exchangeRate,
        baseAmount: amount * exchangeRate,
        remarks: t(row?.remarks),
      };
    })
    .filter((row) =>
      ["FREIGHT", "CUSTOMS_DUTY", "TRUCKING", "INSURANCE", "HANDLING", "CLEARANCE", "MISC_CHARGES"].includes(
        row.componentType
      )
    );
  const lineInputs = (Array.isArray(body.lines) ? body.lines : []).map((ln) => ({
    article: t(ln?.article).toUpperCase(),
    location: t(ln?.location).toUpperCase(),
    batchNo: t(ln?.batchNo),
    serialNo: t(ln?.serialNo),
    weight: Number(ln?.weight) || 0,
    volume: Number(ln?.volume) || 0,
    remarks: t(ln?.remarks),
  }));
  const totalLandedCost = components.reduce((n, row) => n + (Number(row.baseAmount) || 0), 0);
  return {
    allocationMethod,
    currency: t(body.currency || "USD").toUpperCase() || "USD",
    exchangeRate: Number(body.exchangeRate) || 1,
    remarks: t(body.remarks),
    components,
    totalLandedCost,
    purchaseInvoiceNo: t(body.purchaseInvoiceNo),
    shipmentRef: t(body.shipmentRef),
    containerNo: t(body.containerNo),
    lineInputs,
  };
}

function buildLandedCostLinesFromGrn(grn, payload, existing = []) {
  const source = (grn.items || []).filter((ln) => (Number(ln.acceptedQty) || 0) > 0);
  if (!source.length) return [];
  const manualByKey = new Map(
    (payload.lineInputs || []).map((row) => [
      String([row.article, row.location, row.batchNo || "", row.serialNo || ""].join("::")),
      row,
    ])
  );
  const existingByKey = new Map(
    (existing || []).map((row) => [String([row.article, row.location, row.batchNo || "", row.serialNo || ""].join("::")), row])
  );
  const totalByQty = source.reduce((n, ln) => n + (Number(ln.acceptedQty || 0) || 0), 0);
  const totalByValue = source.reduce((n, ln) => n + (Number(ln.acceptedQty || 0) * Number(ln.unitCost || 0)), 0);
  const totalByWeight = source.reduce((n, ln) => n + (Number(ln.weight) || Number(ln.acceptedQty) || 0), 0);
  const totalByVolume = source.reduce((n, ln) => n + (Number(ln.volume) || Number(ln.acceptedQty) || 0), 0);
  return source.map((ln) => {
    const receivedQty = Number(ln.acceptedQty || 0);
    const baseUnitCost = Number(ln.unitCost || 0);
    const baseLineCost = receivedQty * baseUnitCost;
    const key = String([t(ln.article).toUpperCase(), t(ln.location || ln.warehouse).toUpperCase() || "MAIN", t(ln.batchNo), t(ln.serialNo)].join("::"));
    const existingLine = existingByKey.get(key);
    const manualLine = manualByKey.get(key);
    const weightMetric = Number(manualLine?.weight ?? existingLine?.weight ?? ln.weight ?? ln.acceptedQty) || 0;
    const volumeMetric = Number(manualLine?.volume ?? existingLine?.volume ?? ln.volume ?? ln.acceptedQty) || 0;
    const weight =
      payload.allocationMethod === "QUANTITY"
        ? totalByQty > 0
          ? receivedQty / totalByQty
          : 0
        : payload.allocationMethod === "WEIGHT"
          ? totalByWeight > 0
            ? weightMetric / totalByWeight
            : 0
          : payload.allocationMethod === "VOLUME"
            ? totalByVolume > 0
              ? volumeMetric / totalByVolume
              : 0
            : totalByValue > 0
              ? baseLineCost / totalByValue
              : 0;
    const allocatedCost = payload.totalLandedCost * weight;
    return {
      article: t(ln.article).toUpperCase(),
      location: t(ln.location || ln.warehouse).toUpperCase() || "MAIN",
      batchNo: t(ln.batchNo),
      serialNo: t(ln.serialNo),
      receivedQty,
      baseUnitCost,
      baseLineCost,
      weight: weightMetric,
      volume: volumeMetric,
      allocatedCost,
      finalUnitCost: receivedQty > 0 ? baseUnitCost + allocatedCost / receivedQty : baseUnitCost,
      valuationDelta: allocatedCost,
      oldCost: baseUnitCost,
      newCost: receivedQty > 0 ? baseUnitCost + allocatedCost / receivedQty : baseUnitCost,
      remarks: t(manualLine?.remarks || existingLine?.remarks || ""),
    };
  });
}

export async function createLandedCostAllocation(req, res) {
  try {
    const grnNo = t(req.body.grnNo).toUpperCase();
    if (!grnNo) return res.status(400).json({ message: "grnNo is required" });
    const grn = await GRN.findOne(withCompany(req, { grnNo })).lean();
    if (!grn) return res.status(404).json({ message: "GRN not found" });
    if (!["RECEIVED", "PARTIAL_RECEIVED", "CLOSED", "POSTED"].includes(String(grn.status || "").toUpperCase())) {
      return res.status(409).json({ message: "Landed cost can only be created for received GRN." });
    }
    const payload = normalizeLandedCostPayload(req.body);
    const [purchaseInvoice, shipment] = await Promise.all([
      payload.purchaseInvoiceNo
        ? PurchaseInvoice.findOne(withCompany(req, { invoiceNumber: payload.purchaseInvoiceNo }))
            .select("_id invoiceNumber")
            .lean()
        : null,
      payload.shipmentRef
        ? Shipment.findOne(withCompany(req, { shipmentRef: payload.shipmentRef }))
            .select("_id shipmentRef containerNo")
            .lean()
        : null,
    ]);
    const lines = buildLandedCostLinesFromGrn(grn, payload);
    if (!lines.length) return res.status(400).json({ message: "No receipted GRN lines available for cost allocation." });
    const allocationNo = await nextLandedCostNo(req.companyId);
    const doc = await LandedCostAllocation.create({
      companyId: req.companyId,
      allocationNo,
      grnId: grn._id,
      grnNo: grn.grnNo,
      supplierName: grn.supplierName || "",
      purchaseInvoiceId: purchaseInvoice?._id || null,
      purchaseInvoiceNo: purchaseInvoice?.invoiceNumber || "",
      shipmentId: shipment?._id || null,
      shipmentRef: shipment?.shipmentRef || "",
      containerNo: payload.containerNo || shipment?.containerNo || "",
      ...payload,
      lines,
      status: "DRAFT",
      createdBy: req.user?.email || "",
      updatedBy: req.user?.email || "",
    });
    await writeAudit(req, {
      action: "CREATE",
      module: "STORE",
      entityType: "LANDED_COST",
      entityId: doc._id,
      documentNo: doc.allocationNo,
      description: `Landed cost allocation ${doc.allocationNo} created for ${doc.grnNo}`,
      metadata: { totalLandedCost: doc.totalLandedCost, allocationMethod: doc.allocationMethod },
    });
    res.status(201).json(doc);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function listLandedCostAllocations(req, res) {
  try {
    const page = Math.max(1, Number(req.query.page || 1));
    const limit = Math.min(200, Math.max(1, Number(req.query.limit || 50)));
    const skip = (page - 1) * limit;
    const filter = withCompany(req);
    if (req.query.status) filter.status = t(req.query.status).toUpperCase();
    if (req.query.grnNo) filter.grnNo = new RegExp(t(req.query.grnNo), "i");
    const [items, total] = await Promise.all([
      LandedCostAllocation.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      LandedCostAllocation.countDocuments(filter),
    ]);
    res.json({ items, total, page, limit });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function getLandedCostAllocation(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: "Invalid id" });
    const row = await LandedCostAllocation.findOne(withCompany(req, { _id: id })).lean();
    if (!row) return res.status(404).json({ message: "Landed cost allocation not found" });
    res.json(row);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function updateLandedCostAllocation(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: "Invalid id" });
    const row = await LandedCostAllocation.findOne(withCompany(req, { _id: id }));
    if (!row) return res.status(404).json({ message: "Landed cost allocation not found" });
    if (!["DRAFT", "PENDING_APPROVAL"].includes(row.status)) {
      return res.status(409).json({ message: "Only DRAFT/PENDING_APPROVAL allocation can be edited" });
    }
    const payload = normalizeLandedCostPayload(req.body);
    const grn = await GRN.findOne(withCompany(req, { _id: row.grnId })).lean();
    if (!grn) return res.status(404).json({ message: "Linked GRN not found" });
    const [purchaseInvoice, shipment] = await Promise.all([
      payload.purchaseInvoiceNo
        ? PurchaseInvoice.findOne(withCompany(req, { invoiceNumber: payload.purchaseInvoiceNo }))
            .select("_id invoiceNumber")
            .lean()
        : null,
      payload.shipmentRef
        ? Shipment.findOne(withCompany(req, { shipmentRef: payload.shipmentRef }))
            .select("_id shipmentRef containerNo")
            .lean()
        : null,
    ]);
    row.allocationMethod = payload.allocationMethod;
    row.currency = payload.currency;
    row.exchangeRate = payload.exchangeRate;
    row.components = payload.components;
    row.totalLandedCost = payload.totalLandedCost;
    row.remarks = payload.remarks;
    row.purchaseInvoiceId = purchaseInvoice?._id || null;
    row.purchaseInvoiceNo = purchaseInvoice?.invoiceNumber || "";
    row.shipmentId = shipment?._id || null;
    row.shipmentRef = shipment?.shipmentRef || "";
    row.containerNo = payload.containerNo || shipment?.containerNo || "";
    row.lines = buildLandedCostLinesFromGrn(grn, payload, row.lines || []);
    row.updatedBy = req.user?.email || "";
    await row.save();
    await writeAudit(req, {
      action: "UPDATE",
      module: "STORE",
      entityType: "LANDED_COST",
      entityId: row._id,
      documentNo: row.allocationNo,
      description: `Landed cost allocation ${row.allocationNo} updated`,
      metadata: { totalLandedCost: row.totalLandedCost, allocationMethod: row.allocationMethod },
    });
    res.json(row);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function cancelLandedCostAllocation(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: "Invalid id" });
    const row = await LandedCostAllocation.findOne(withCompany(req, { _id: id }));
    if (!row) return res.status(404).json({ message: "Landed cost allocation not found" });
    if (row.status === "APPLIED") return res.status(409).json({ message: "Applied allocation cannot be cancelled." });
    const prevStatus = row.status;
    row.status = "CANCELLED";
    row.cancelledAt = new Date();
    row.updatedBy = req.user?.email || "";
    await row.save();
    await writeAudit(req, {
      action: "CANCEL",
      module: "STORE",
      entityType: "LANDED_COST",
      entityId: row._id,
      documentNo: row.allocationNo,
      fromStatus: prevStatus,
      toStatus: "CANCELLED",
      description: `Landed cost allocation ${row.allocationNo} cancelled`,
      metadata: { grnNo: row.grnNo },
    });
    res.json(row);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function applyLandedCostAllocation(req, res) {
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const { id } = req.params;
      if (!mongoose.Types.ObjectId.isValid(id)) throw new Error("Invalid id");
      const row = await LandedCostAllocation.findOne(withCompany(req, { _id: id })).session(session);
      if (!row) throw new Error("Landed cost allocation not found");
      if (!["DRAFT", "APPROVED", "PENDING_APPROVAL"].includes(row.status)) throw new Error("Allocation cannot be applied");

      const gate = await ensureApproval(req, {
        companyId: req.companyId,
        module: "STORE",
        actionKey: "landed_cost_apply",
        documentType: "LANDED_COST",
        documentId: row._id,
        documentNo: row.allocationNo,
        amount: Number(row.totalLandedCost) || 0,
        currency: row.currency || "USD",
        description: `Apply landed cost allocation ${row.allocationNo}`,
      });
      if (!gate.approved) {
        row.status = "PENDING_APPROVAL";
        row.approvalStatus = "PENDING_APPLY";
        row.updatedBy = req.user?.email || "";
        await row.save({ session });
        throw Object.assign(new Error("APPROVAL_REQUIRED"), { _approval: approvalRequiredPayload(gate.request) });
      }

      row.status = "APPROVED";
      row.approvalStatus = "APPROVED";
      row.updatedBy = req.user?.email || "";
      await row.save({ session });
      for (const ln of row.lines || []) {
        const balanceRows = await StockBalance.find(
          withCompany(req, {
            article: ln.article,
            location: ln.location,
            ...(ln.batchNo ? { batchNo: ln.batchNo } : {}),
            ...(ln.serialNo ? { serialNo: ln.serialNo } : {}),
          })
        ).session(session);
        if (!balanceRows.length) continue;
        const totalOnHand = balanceRows.reduce((n, b) => n + (Number(b.onHandQty ?? b.quantity ?? 0) || 0), 0);
        if (!(totalOnHand > 0)) continue;
        const addPerUnit = (Number(ln.allocatedCost) || 0) / totalOnHand;
        let oldWeighted = 0;
        let newWeighted = 0;
        for (const b of balanceRows) {
          const onHand = Number(b.onHandQty ?? b.quantity ?? 0) || 0;
          const oldCost = Number(b.avgCost ?? b.unitCost ?? 0) || 0;
          const newCost = Math.max(0, oldCost + addPerUnit);
          oldWeighted += oldCost * onHand;
          newWeighted += newCost * onHand;
          b.unitCost = newCost;
          b.avgCost = newCost;
          await b.save({ session });
        }
        const oldCost = totalOnHand > 0 ? oldWeighted / totalOnHand : Number(ln.baseUnitCost || 0);
        const newCost = totalOnHand > 0 ? newWeighted / totalOnHand : Number(ln.finalUnitCost || ln.baseUnitCost || 0);
        const valuationDelta = newWeighted - oldWeighted;
        const balView = await stockService.getStockBalance({
          companyId: req.companyId,
          article: ln.article,
          warehouse: ln.location,
          session,
        });
        await stockService.createStockLedgerEntry({
          session,
          companyId: req.companyId,
          movementType: "LANDED_COST_ADJUSTMENT",
          article: ln.article,
          warehouse: ln.location,
          referenceType: "LANDED_COST",
          referenceNo: row.allocationNo,
          qtyIn: 0,
          qtyOut: 0,
          unitCost: newCost,
          oldCost,
          newCost,
          valuationDelta,
          allocationId: row._id,
          currency: row.currency || "USD",
          remarks: `Landed cost allocated from ${row.grnNo}`,
          createdBy: req.user?.email || "",
          sourceModule: "STORE",
          onHandAfter: balView.onHandQty,
          allocatedAfter: balView.allocatedQty,
          availableAfter: balView.availableQty,
        });
        ln.oldCost = oldCost;
        ln.newCost = newCost;
        ln.valuationDelta = valuationDelta;
      }
      row.status = "APPLIED";
      row.appliedAt = new Date();
      row.updatedBy = req.user?.email || "";
      await row.save({ session });
      await writeAudit(req, {
        action: "POST",
        module: "STORE",
        entityType: "LANDED_COST",
        entityId: row._id,
        documentNo: row.allocationNo,
        fromStatus: "APPROVED",
        toStatus: "APPLIED",
        description: `Landed cost allocation ${row.allocationNo} applied`,
        metadata: { grnNo: row.grnNo, totalLandedCost: row.totalLandedCost },
      });
      await writeAudit(req, {
        action: "VALUATION_UPDATE",
        module: "STORE",
        entityType: "LANDED_COST",
        entityId: row._id,
        documentNo: row.allocationNo,
        description: `Stock valuation updated by landed cost allocation ${row.allocationNo}`,
        metadata: {
          valuationByLine: (row.lines || []).map((ln) => ({
            article: ln.article,
            oldCost: ln.oldCost,
            newCost: ln.newCost,
            valuationDelta: ln.valuationDelta,
          })),
        },
      });
    });
    res.json({ success: true });
  } catch (err) {
    if (err?._approval) return res.status(202).json(err._approval);
    res.status(400).json({ message: err.message });
  } finally {
    await session.endSession();
  }
}

export async function landedCostSummaryReport(req, res) {
  try {
    const filter = withCompany(req);
    if (req.query.status) filter.status = t(req.query.status).toUpperCase();
    const rows = await LandedCostAllocation.find(filter).sort({ createdAt: -1 }).lean();
    const items = rows.map((r) => ({
      allocationNo: r.allocationNo,
      grnNo: r.grnNo,
      supplierName: r.supplierName || "",
      allocationMethod: r.allocationMethod,
      totalLandedCost: Number(r.totalLandedCost || 0),
      lineCount: (r.lines || []).length,
      status: r.status,
      createdAt: r.createdAt,
      appliedAt: r.appliedAt,
    }));
    res.json({ items });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function stockValuationAdjustmentReport(req, res) {
  try {
    const filter = withCompany(req, {
      movementType: "LANDED_COST_ADJUSTMENT",
      referenceType: "LANDED_COST",
    });
    if (req.query.allocationNo) filter.referenceNo = new RegExp(t(req.query.allocationNo), "i");
    const items = await StockLedger.find(filter).sort({ createdAt: -1 }).lean();
    res.json({ items });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function grnCostAnalysisReport(req, res) {
  try {
    const filter = withCompany(req);
    if (req.query.grnNo) filter.grnNo = new RegExp(t(req.query.grnNo), "i");
    const rows = await LandedCostAllocation.find(filter).sort({ createdAt: -1 }).lean();
    const items = rows.map((row) => {
      const baseValue = (row.lines || []).reduce((n, ln) => n + (Number(ln.baseLineCost) || 0), 0);
      const finalValue = (row.lines || []).reduce((n, ln) => n + (Number(ln.baseLineCost) || 0) + (Number(ln.allocatedCost) || 0), 0);
      return {
        allocationNo: row.allocationNo,
        grnNo: row.grnNo,
        supplierName: row.supplierName || "",
        baseValue,
        landedCost: Number(row.totalLandedCost || 0),
        finalValue,
        status: row.status,
      };
    });
    res.json({ items });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}
