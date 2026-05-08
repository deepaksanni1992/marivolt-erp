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
import Rts from "../models/Rts.js";
import SalesInvoice from "../models/SalesInvoice.js";
import * as stockService from "../services/stockService.js";

/**
 * Derives the live stock buckets from a StockBalance row.
 * We treat onHandQty (legacy `quantity`), reservedQty (legacy alias for
 * allocatedQty), rtsQty as the source of truth and compute available
 * fresh on every read, because not every write path keeps `availableQty`
 * in sync (specifically the sales reserve path increments reservedQty
 * without touching availableQty).
 */
function deriveStockRow(row) {
  const onHand = Number(row.onHandQty ?? row.quantity ?? 0) || 0;
  // Some writers used reservedQty, others use allocatedQty — take the larger
  // so a stale 0 in one of them does not under-report.
  const allocated = Math.max(Number(row.allocatedQty || 0), Number(row.reservedQty || 0));
  const rts = Number(row.rtsQty || 0);
  const available = onHand - allocated - rts;
  return {
    ...row,
    onHandQty: onHand,
    allocatedQty: allocated,
    reservedQty: allocated,
    rtsQty: rts,
    availableQty: available,
    isNegativeAvailable: available < 0,
  };
}

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

export async function listStockBalance(req, res) {
  try {
    const page = Math.max(1, Number(req.query.page || 1));
    const limit = Math.min(500, Math.max(1, Number(req.query.limit || 50)));
    const skip = (page - 1) * limit;
    const search = t(req.query.search);
    const negativeOnly = req.query.negativeOnly === "true" || req.query.negativeOnly === "1";
    const allocatedOnly = req.query.allocatedOnly === "true" || req.query.allocatedOnly === "1";
    const filter = withCompany(req);
    if (req.query.location) filter.location = t(req.query.location).toUpperCase();
    if (req.query.batchNo) filter.batchNo = new RegExp(t(req.query.batchNo), "i");
    if (req.query.article) filter.article = t(req.query.article).toUpperCase();
    if (req.query.availableOnly === "true") filter.availableQty = { $gt: 0 };

    // When the caller asked for a server-filtered subset (negative or allocated)
    // we have to pull all matching rows for that filter and paginate after the
    // derived computation, since availableQty is not a reliable persisted field.
    const needsClientPager = negativeOnly || allocatedOnly;
    const baseQuery = StockBalance.find(filter).sort({ article: 1 });
    const rows = needsClientPager ? await baseQuery.lean() : await baseQuery.skip(skip).limit(limit).lean();
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
    let total;
    if (needsClientPager) {
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
          rtsQty: { $sum: { $ifNull: ["$rtsQty", 0] } },
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
          rtsQty: "$rtsQty",
          availableQty: { $subtract: ["$onHandQty", { $add: ["$allocatedQty", "$rtsQty"] }] },
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
    const [rtsRows, invoiceRows] = allocationIds.length
      ? await Promise.all([
          Rts.find(
            withCompany(req, {
              linkedOrderAllocationId: { $in: allocationIds },
              status: { $nin: ["CANCELLED"] },
            })
          )
            .select("linkedOrderAllocationId status lines")
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
    const rtsQtyByAllocationArticle = new Map();
    for (const rts of rtsRows) {
      if (String(rts.status || "").toUpperCase() !== "APPROVED") continue;
      const allocationId = String(rts.linkedOrderAllocationId || "");
      for (const [lineArticle, qty] of lineQtyByArticle(rts.lines || [])) {
        const key = `${allocationId}::${lineArticle}`;
        rtsQtyByAllocationArticle.set(key, (rtsQtyByAllocationArticle.get(key) || 0) + qty);
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
        const rtsQty = Number(rtsQtyByAllocationArticle.get(allocationArticleKey) || 0);
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
          rtsQty,
          invoiceQty,
          pendingQty: Math.max(0, allocatedQty - rtsQty - invoiceQty),
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
        rtsQty: derived.rtsQty,
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
  RTS: "RTS_TRANSFER",
  RTS_CANCEL: "RTS_CANCEL",
  SALES_INVOICE: "SALES_INVOICE_OUT",
  SALES_INVOICE_CANCEL: "SALES_INVOICE_CANCEL",
  STOCK_ADJUSTMENT: "STOCK_ADJUSTMENT",
  TRANSFER_IN: "STOCK_TRANSFER_IN",
  TRANSFER_OUT: "STOCK_TRANSFER_OUT",
  OPENING: "OPENING",
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
  SALES_RESERVED_TO_RTS: "RTS_TRANSFER",
  SALES_RTS_TO_RESERVED: "RTS_CANCEL",
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
 * Returns true when a movement only shifts buckets between Allocated/RTS
 * without moving On Hand. For these we expose `qtyIn` / `qtyOut` as 0 and
 * surface the magnitude on `bucketImpact`/remarks instead.
 */
function isBucketOnlyInventoryMovement(rawType) {
  return rawType === "SALES_RESERVED_TO_RTS" || rawType === "SALES_RTS_TO_RESERVED";
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
 * the Available pool (On Hand - Allocated - RTS) as the canonical
 * "in/out" measure for non-physical movements so the user sees a single
 * column that always lines up with the impact on Available.
 */
function splitDelta(rawType, qtyDelta) {
  const delta = Number(qtyDelta) || 0;
  // Pure bucket shifts (Allocated <-> RTS) leave Available unchanged.
  if (isBucketOnlyInventoryMovement(rawType)) {
    return { qtyIn: 0, qtyOut: 0 };
  }
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
 * transfer, sales) with InventoryLedger (sales reservation, RTS shifts,
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
    const rtsNos = new Set();
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
        case "RTS":
        case "RTS_CANCEL":
          rtsNos.add(ref);
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
      if (refType === "RTS_APPROVED" || refType === "RTS_CANCEL") {
        rtsNos.add(ref);
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
        case "SALES_RESERVED_TO_RTS":
        case "SALES_RTS_TO_RESERVED":
          rtsNos.add(ref);
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

    const [items, grns, allocations, rtsDocs, invoices] = await Promise.all([
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
      rtsNos.size
        ? Rts.find(withCompany(req, { rtsNo: { $in: [...rtsNos] } }))
            .select("rtsNo customerName warehouse")
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
    const rtsByNo = new Map(rtsDocs.map((r) => [r.rtsNo, r]));
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
        case "RTS":
        case "RTS_CANCEL":
          customerName = rtsByNo.get(ref)?.customerName || "";
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
        rtsAfter: r.rtsAfter != null ? Number(r.rtsAfter) : null,
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
        refType === "RTS_APPROVED" ||
        refType === "RTS_CANCEL" ||
        rawType === "SALES_RESERVED_TO_RTS" ||
        rawType === "SALES_RTS_TO_RESERVED"
      ) {
        customerName = rtsByNo.get(ref)?.customerName || "";
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
        rtsAfter: r.rtsAfter != null ? Number(r.rtsAfter) : null,
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
      });
      row.status = "Posted";
      row.postedAt = new Date();
      await row.save({ session });
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
      });
      row.status = "Posted";
      row.postedAt = new Date();
      await row.save({ session });
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
    ]),
  ].sort();
  res.json({
    transactionTypes: TX_TYPES,
    unifiedMovementTypes,
    sourceModels: ["StockLedger", "InventoryLedger"],
  });
}
