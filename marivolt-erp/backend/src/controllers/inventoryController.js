import StockBalance from "../models/StockBalance.js";
import InventoryLedger from "../models/InventoryLedger.js";
import { applyStockIn, applyStockOut, applyAdjustment } from "../services/stockService.js";

function withCompany(req, filter = {}) {
  return { ...filter, companyId: req.companyId };
}

export async function listBalances(req, res) {
  try {
    const page = Math.max(1, parseInt(String(req.query.page || "1"), 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(String(req.query.limit || "100"), 10) || 100));
    const skip = (page - 1) * limit;
    const filter = withCompany(req);
    if (req.query.warehouse) filter.warehouse = String(req.query.warehouse).trim().toUpperCase();
    if (req.query.itemCode) {
      filter.itemCode = new RegExp(String(req.query.itemCode).trim(), "i");
    }
    const [items, total] = await Promise.all([
      StockBalance.find(filter).sort({ itemCode: 1, warehouse: 1 }).skip(skip).limit(limit).lean(),
      StockBalance.countDocuments(filter),
    ]);
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
        unitCost: 0,
        location: "",
      });
    }
    res.json(row);
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
  try {
    const {
      itemCode,
      warehouse,
      qty,
      movementType,
      referenceType,
      referenceId,
      referenceNumber,
      unitCost,
      remarks,
    } = req.body;
    await applyStockIn({
      companyId: req.companyId,
      itemCode,
      warehouse,
      qty,
      movementType: movementType || "IN_PURCHASE",
      referenceType,
      referenceId,
      referenceNumber,
      unitCost,
      remarks,
      createdBy: req.user?.email || "",
    });
    const w = String(warehouse || "MAIN").trim().toUpperCase() || "MAIN";
    const code = String(itemCode || "").trim().toUpperCase();
    const bal = await StockBalance.findOne(withCompany(req, { itemCode: code, warehouse: w })).lean();
    res.status(201).json(bal);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function postStockOut(req, res) {
  try {
    const { itemCode, warehouse, qty, movementType, referenceType, referenceId, referenceNumber, remarks } =
      req.body;
    const bal = await applyStockOut({
      companyId: req.companyId,
      itemCode,
      warehouse,
      qty,
      movementType: movementType || "OUT_SALE",
      referenceType,
      referenceId,
      referenceNumber,
      remarks,
      createdBy: req.user?.email || "",
    });
    res.status(201).json(bal);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function postAdjustment(req, res) {
  try {
    const { itemCode, warehouse, qtyDelta, remarks } = req.body;
    await applyAdjustment({
      companyId: req.companyId,
      itemCode,
      warehouse,
      qtyDelta,
      remarks,
      createdBy: req.user?.email || "",
    });
    const w = String(warehouse || "MAIN").trim().toUpperCase() || "MAIN";
    const code = String(itemCode || "").trim().toUpperCase();
    const bal = await StockBalance.findOne(withCompany(req, { itemCode: code, warehouse: w })).lean();
    res.status(201).json(bal);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function postOpening(req, res) {
  try {
    const { itemCode, warehouse, quantity, unitCost, remarks } = req.body;
    const q = Number(quantity);
    if (!Number.isFinite(q) || q < 0) {
      return res.status(400).json({ message: "quantity must be a non-negative number" });
    }
    const code = String(itemCode || "").trim().toUpperCase();
    const w = String(warehouse || "MAIN").trim().toUpperCase() || "MAIN";

    const existing = await StockBalance.findOne(withCompany(req, { itemCode: code, warehouse: w }));
    if (existing && (existing.quantity || 0) !== 0) {
      return res.status(400).json({ message: "Balance already exists; use adjustment instead" });
    }

    await InventoryLedger.create({
      companyId: req.companyId,
      itemCode: code,
      warehouse: w,
      movementType: "OPENING",
      qtyDelta: q,
      referenceType: "OPENING",
      referenceNumber: "OPENING",
      unitCost: Number(unitCost) || 0,
      remarks: remarks || "",
      createdBy: req.user?.email || "",
    });

    await StockBalance.findOneAndUpdate(
      { companyId: req.companyId, itemCode: code, warehouse: w },
      {
        $set: {
          quantity: q,
          reservedQty: 0,
          unitCost: Number(unitCost) || 0,
        },
      },
      { upsert: true, new: true }
    );

    const bal = await StockBalance.findOne(withCompany(req, { itemCode: code, warehouse: w })).lean();
    res.status(201).json(bal);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}
