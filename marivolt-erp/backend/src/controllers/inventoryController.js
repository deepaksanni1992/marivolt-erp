import mongoose from "mongoose";
import StockBalance from "../models/StockBalance.js";
import InventoryLedger from "../models/InventoryLedger.js";
import * as stockService from "../services/stockService.js";
import { deriveStockBuckets } from "../services/stockExpectedBuckets.js";
import { approvalRequiredPayload, ensureApproval } from "../services/approvalService.js";

function withCompany(req, filter = {}) {
  return { ...filter, companyId: req.companyId };
}

export async function listBalances(req, res) {
  try {
    const page = Math.max(1, parseInt(String(req.query.page || "1"), 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(String(req.query.limit || "100"), 10) || 100));
    const skip = (page - 1) * limit;
    const availableOnly =
      req.query.availableOnly === "true" || req.query.availableOnly === "1";
    const filter = withCompany(req);
    if (req.query.warehouse) filter.warehouse = String(req.query.warehouse).trim().toUpperCase();
    if (req.query.itemCode) {
      filter.itemCode = new RegExp(String(req.query.itemCode).trim(), "i");
    }
    // Trade-off: never filter Mongo on stored availableQty (stale). Pre-filter by
    // company/warehouse/itemCode, derive available = onHand − reserved − packed,
    // then apply availableOnly in memory before pagination.
    const rawItems = await StockBalance.find(filter)
      .sort({ itemCode: 1, warehouse: 1 })
      .lean();
    let items = rawItems.map((r) => {
      const buckets = deriveStockBuckets(r);
      return {
        ...r,
        onHandQty: buckets.onHandQty,
        reservedQty: buckets.reservedQty,
        packedQty: buckets.packedQty,
        availableQty: buckets.availableQty,
      };
    });
    if (availableOnly) items = items.filter((r) => r.availableQty > 0);
    const total = items.length;
    items = items.slice(skip, skip + limit);
    res.json({ items, total, page, limit });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function getBalance(req, res) {
  try {
    const itemCode = String(req.params.itemCode || "").trim().toUpperCase();
    const warehouse = String(req.query.warehouse || "MAIN").trim().toUpperCase() || "MAIN";
    const row = await StockBalance.findOne(withCompany(req, { itemCode, warehouse })).lean();
    if (!row) {
      return res.json({
        itemCode,
        warehouse,
        quantity: 0,
        reservedQty: 0,
        packedQty: 0,
        availableQty: 0,
        unitCost: 0,
        location: "",
      });
    }
    const buckets = deriveStockBuckets(row);
    res.json({
      ...row,
      onHandQty: buckets.onHandQty,
      reservedQty: buckets.reservedQty,
      packedQty: buckets.packedQty,
      availableQty: buckets.availableQty,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function listLedger(req, res) {
  try {
    const page = Math.max(1, parseInt(String(req.query.page || "1"), 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(String(req.query.limit || "100"), 10) || 100));
    const skip = (page - 1) * limit;
    const filter = withCompany(req);
    if (req.query.itemCode) {
      filter.itemCode = String(req.query.itemCode).trim().toUpperCase();
    }
    if (req.query.warehouse) filter.warehouse = String(req.query.warehouse).trim().toUpperCase();
    if (req.query.movementType) filter.movementType = req.query.movementType;
    const [items, total] = await Promise.all([
      InventoryLedger.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      InventoryLedger.countDocuments(filter),
    ]);
    res.json({ items, total, page, limit });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function postStockIn(req, res) {
  const session = await mongoose.startSession();
  try {
    const { itemCode, warehouse, qty, referenceType, referenceNumber, unitCost, remarks } = req.body;
    await session.withTransaction(async () => {
      const code = String(itemCode || "").trim().toUpperCase();
      const w = String(warehouse || "MAIN").trim().toUpperCase() || "MAIN";
      const ref = String(referenceNumber || "").trim();
      await stockService.grnReceive({
        session,
        companyId: req.companyId,
        article: code,
        warehouse: w,
        qty,
        referenceType: referenceType || "GRN",
        referenceNo: ref || `INV-IN:${code}:${w}`,
        unitCost,
        remarks,
        createdBy: req.user?.email || "",
        sourceModule: "INVENTORY",
        effectKey: req.body?.idempotencyKey
          ? String(req.body.idempotencyKey)
          : undefined,
        lineId: ref || "manual",
      });
    });
    const w = String(warehouse || "MAIN").trim().toUpperCase() || "MAIN";
    const code = String(itemCode || "").trim().toUpperCase();
    const bal = await StockBalance.findOne(withCompany(req, { itemCode: code, warehouse: w })).lean();
    res.status(201).json(bal);
  } catch (err) {
    res.status(400).json({ message: err.message });
  } finally {
    await session.endSession();
  }
}

export async function postStockOut(req, res) {
  const session = await mongoose.startSession();
  try {
    const { itemCode, warehouse, qty, referenceType, referenceNumber, remarks } = req.body;
    await session.withTransaction(async () => {
      const code = String(itemCode || "").trim().toUpperCase();
      const w = String(warehouse || "MAIN").trim().toUpperCase() || "MAIN";
      const ref = String(referenceNumber || "").trim();
      await stockService.stockAdjustment({
        session,
        companyId: req.companyId,
        article: code,
        warehouse: w,
        qty,
        direction: "Decrease",
        referenceType: referenceType || "STOCK_OUT",
        referenceNo: ref || `INV-OUT:${code}:${w}`,
        remarks,
        createdBy: req.user?.email || "",
        sourceModule: "INVENTORY",
        effectKey: req.body?.idempotencyKey ? String(req.body.idempotencyKey) : undefined,
        lineId: ref || "manual",
      });
    });
    const w = String(warehouse || "MAIN").trim().toUpperCase() || "MAIN";
    const code = String(itemCode || "").trim().toUpperCase();
    const bal = await StockBalance.findOne(withCompany(req, { itemCode: code, warehouse: w })).lean();
    res.status(201).json(bal);
  } catch (err) {
    res.status(400).json({ message: err.message });
  } finally {
    await session.endSession();
  }
}

export async function postAdjustment(req, res) {
  const session = await mongoose.startSession();
  try {
    const { itemCode, warehouse, qtyDelta, remarks } = req.body;
    const delta = Number(qtyDelta) || 0;
    if (!delta) return res.status(400).json({ message: "qtyDelta cannot be zero" });
    const gate = await ensureApproval(req, {
      companyId: req.companyId,
      module: "STORE",
      actionKey: "adjustment_post",
      documentType: "STOCK_ADJUSTMENT",
      documentNo: String(req.body?.referenceNo || itemCode || "INVENTORY_ADJUSTMENT").trim(),
      amount: Math.abs(delta),
      currency: "USD",
      description: `Post inventory adjustment for ${itemCode || "item"}`,
    });
    if (!gate.approved) return res.status(202).json(approvalRequiredPayload(gate.request));
    await session.withTransaction(async () => {
      const code = String(itemCode || "").trim().toUpperCase();
      const w = String(warehouse || "MAIN").trim().toUpperCase() || "MAIN";
      const ref = String(req.body?.referenceNo || "").trim();
      await stockService.stockAdjustment({
        session,
        companyId: req.companyId,
        article: code,
        warehouse: w,
        qty: Math.abs(delta),
        direction: delta > 0 ? "Increase" : "Decrease",
        referenceType: "STOCK_ADJUSTMENT",
        referenceNo: ref || `ADJ:${code}:${w}:${Math.abs(delta)}:${delta > 0 ? "IN" : "OUT"}`,
        remarks,
        createdBy: req.user?.email || "",
        sourceModule: "INVENTORY",
        effectKey: req.body?.idempotencyKey
          ? String(req.body.idempotencyKey)
          : gate.request?._id
            ? `phys:STOCK_ADJUSTMENT:${req.companyId}:APPR:${gate.request._id}:${code}`
            : undefined,
        lineId: ref || "manual",
      });
    });
    const w = String(warehouse || "MAIN").trim().toUpperCase() || "MAIN";
    const code = String(itemCode || "").trim().toUpperCase();
    const bal = await StockBalance.findOne(withCompany(req, { itemCode: code, warehouse: w })).lean();
    res.status(201).json(bal);
  } catch (err) {
    res.status(400).json({ message: err.message });
  } finally {
    await session.endSession();
  }
}

export async function postOpening(req, res) {
  const session = await mongoose.startSession();
  try {
    const { itemCode, warehouse, quantity, unitCost, remarks } = req.body;
    const q = Number(quantity);
    if (!Number.isFinite(q) || q < 0) {
      return res.status(400).json({ message: "quantity must be a non-negative number" });
    }
    const code = String(itemCode || "").trim().toUpperCase();
    const w = String(warehouse || "MAIN").trim().toUpperCase() || "MAIN";

    const existing = await StockBalance.findOne(withCompany(req, { itemCode: code, warehouse: w }));
    if (existing && (Number(existing.onHandQty || existing.quantity || 0) !== 0)) {
      return res.status(400).json({ message: "Balance already exists; use adjustment instead" });
    }

    await session.withTransaction(async () => {
      if (q > 0) {
        await stockService.openingBalance({
          session,
          companyId: req.companyId,
          article: code,
          warehouse: w,
          qty: q,
          unitCost,
          remarks: remarks || "",
          createdBy: req.user?.email || "",
          sourceModule: "INVENTORY",
          referenceNo: `OPENING:${code}:${w}`,
          effectKey: req.body?.idempotencyKey
            ? String(req.body.idempotencyKey)
            : undefined,
        });
      } else {
        // Zero opening — seed an empty StockBalance row without
        // writing a ledger entry so subsequent reads find a row.
        await StockBalance.findOneAndUpdate(
          { companyId: req.companyId, itemCode: code, warehouse: w },
          {
            $setOnInsert: {
              companyId: req.companyId,
              itemCode: code,
              warehouse: w,
              article: code,
              location: w,
              batchNo: "",
              serialNo: "",
              quantity: 0,
              onHandQty: 0,
              allocatedQty: 0,
              unitCost: Number(unitCost) || 0,
            },
          },
          { upsert: true, new: true, session }
        );
      }
    });

    const bal = await StockBalance.findOne(withCompany(req, { itemCode: code, warehouse: w })).lean();
    res.status(201).json(bal);
  } catch (err) {
    res.status(400).json({ message: err.message });
  } finally {
    await session.endSession();
  }
}
