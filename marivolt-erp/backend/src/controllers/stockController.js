import mongoose from "mongoose";
import ItemMaster from "../models/itemMasterModel.js";
import StockBalance from "../models/StockBalance.js";
import StockLedger, { TX_TYPES } from "../models/StockLedger.js";
import StockLocation from "../models/StockLocation.js";
import StockAdjustment from "../models/StockAdjustment.js";
import StockTransfer from "../models/StockTransfer.js";
import OrderAllocation from "../models/OrderAllocation.js";
import { postLedgerMovement } from "../services/stockLedgerService.js";

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
    const items = [];
    for (const alloc of allocations) {
      for (const line of alloc.lines || []) {
        if (String(line.article || "").toUpperCase() !== article) continue;
        const ref = alloc.linkedProformaNo || alloc.linkedOANo || alloc.linkedQuotationNo || alloc.allocationNo;
        if (referenceSearch && !new RegExp(referenceSearch, "i").test(ref || "")) continue;
        items.push({
          allocationId: alloc._id,
          allocationNo: alloc.allocationNo,
          allocationDate: alloc.allocationDate,
          status: alloc.status,
          customerName: alloc.customerName,
          warehouse: alloc.warehouse || "MAIN",
          article: line.article,
          partNumber: line.partNumber || "",
          description: line.description || "",
          uom: line.uom || "PCS",
          allocatedQty: Number(line.qty) || 0,
          isNegativeAllocation: Boolean(line.isNegativeAllocation),
          referenceType: alloc.linkedProformaId
            ? "PROFORMA"
            : alloc.linkedOAId
              ? "ORDER_ACK"
              : alloc.linkedQuotationId
                ? "QUOTATION"
                : "ORDER_ALLOCATION",
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
        location: derived.location || "",
        onHandQty: derived.onHandQty,
        allocatedQty: derived.allocatedQty,
        rtsQty: derived.rtsQty,
        availableQty: derived.availableQty,
        shortageQty: Math.max(0, -derived.availableQty),
        allocations,
      });
    }
    items.sort((a, b) => a.availableQty - b.availableQty);
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
      await postLedgerMovement({
        session,
        companyId: req.companyId,
        transactionDate: row.date,
        transactionType: "STOCK_ADJUSTMENT",
        referenceType: "STOCK_ADJUSTMENT",
        referenceNo: row.adjustmentNo,
        article: row.article,
        location: row.location,
        qtyIn: row.adjustmentType === "Increase" ? row.quantity : 0,
        qtyOut: row.adjustmentType === "Decrease" ? row.quantity : 0,
        remarks: `${row.reason}${row.remarks ? ` | ${row.remarks}` : ""}`,
        createdBy: req.user?.email || "",
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
      const fromBal = await StockBalance.findOne(withCompany(req, { article: row.article, location: row.fromLocation, batchNo: "", serialNo: "" })).session(session);
      if (!fromBal || Number(fromBal.availableQty || 0) < Number(row.quantity || 0)) {
        throw new Error("Insufficient available quantity for transfer");
      }
      await postLedgerMovement({
        session,
        companyId: req.companyId,
        transactionDate: row.date,
        transactionType: "TRANSFER_OUT",
        referenceType: "TRANSFER",
        referenceNo: row.transferNo,
        article: row.article,
        location: row.fromLocation,
        qtyIn: 0,
        qtyOut: row.quantity,
        remarks: row.remarks,
        createdBy: req.user?.email || "",
      });
      await postLedgerMovement({
        session,
        companyId: req.companyId,
        transactionDate: row.date,
        transactionType: "TRANSFER_IN",
        referenceType: "TRANSFER",
        referenceNo: row.transferNo,
        article: row.article,
        location: row.toLocation,
        qtyIn: row.quantity,
        qtyOut: 0,
        remarks: row.remarks,
        createdBy: req.user?.email || "",
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
  res.json({ transactionTypes: TX_TYPES });
}
