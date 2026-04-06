import mongoose from "mongoose";
import BOM from "../models/BOM.js";
import KittingOrder from "../models/KittingOrder.js";
import { nextSequentialNumber } from "../utils/docNumbers.js";
import { runKitAssembly } from "../services/kittingExecution.js";

function pagination(req) {
  const page = Math.max(1, parseInt(String(req.query.page || "1"), 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit || "50"), 10) || 50));
  return { page, limit, skip: (page - 1) * limit };
}

export async function listKittingOrders(req, res) {
  try {
    const { page, limit, skip } = pagination(req);
    const filter = {};
    if (req.query.status) filter.status = req.query.status;
    if (req.query.parentItemCode) {
      filter.parentItemCode = String(req.query.parentItemCode).trim().toUpperCase();
    }
    const [items, total] = await Promise.all([
      KittingOrder.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      KittingOrder.countDocuments(filter),
    ]);
    res.json({ items, total, page, limit });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function getKittingOrder(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid id" });
    }
    const row = await KittingOrder.findById(id).lean();
    if (!row) return res.status(404).json({ message: "Not found" });
    res.json(row);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function createKittingOrder(req, res) {
  try {
    const parentItemCode = String(req.body.parentItemCode || "").trim().toUpperCase();
    if (!parentItemCode) return res.status(400).json({ message: "parentItemCode required" });

    const bom = await BOM.findOne({ parentItemCode, isActive: true });
    if (!bom) {
      return res.status(400).json({ message: "No active BOM for this parent item" });
    }

    const quantity = Number(req.body.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      return res.status(400).json({ message: "quantity must be a positive number" });
    }

    const kitNumber = await nextSequentialNumber(KittingOrder, "kitNumber", "KIT");
    const warehouse = String(req.body.warehouse || "MAIN").trim().toUpperCase() || "MAIN";

    const doc = await KittingOrder.create({
      kitNumber,
      parentItemCode,
      warehouse,
      quantity,
      bomId: bom._id,
      status: "DRAFT",
      remarks: req.body.remarks || "",
      createdBy: req.user?.email || "",
    });
    res.status(201).json(doc);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function executeKittingOrder(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid id" });
    }
    const order = await KittingOrder.findById(id);
    if (!order) return res.status(404).json({ message: "Not found" });
    if (order.status !== "DRAFT") {
      return res.status(400).json({ message: "Only DRAFT orders can be executed" });
    }

    const userEmail = req.user?.email || "";
    await runKitAssembly(order, userEmail);
    order.status = "COMPLETED";
    await order.save();
    res.json(order);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function cancelKittingOrder(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid id" });
    }
    const order = await KittingOrder.findById(id);
    if (!order) return res.status(404).json({ message: "Not found" });
    if (order.status !== "DRAFT") {
      return res.status(400).json({ message: "Only DRAFT orders can be cancelled" });
    }
    order.status = "CANCELLED";
    await order.save();
    res.json(order);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}
