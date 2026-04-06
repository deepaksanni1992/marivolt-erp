import mongoose from "mongoose";
import BOM from "../models/BOM.js";
import DeKittingOrder from "../models/DeKittingOrder.js";
import { nextSequentialNumber } from "../utils/docNumbers.js";
import { runDeKit } from "../services/kittingExecution.js";

function pagination(req) {
  const page = Math.max(1, parseInt(String(req.query.page || "1"), 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit || "50"), 10) || 50));
  return { page, limit, skip: (page - 1) * limit };
}

export async function listDeKittingOrders(req, res) {
  try {
    const { page, limit, skip } = pagination(req);
    const filter = {};
    if (req.query.status) filter.status = req.query.status;
    if (req.query.parentItemCode) {
      filter.parentItemCode = String(req.query.parentItemCode).trim().toUpperCase();
    }
    const [items, total] = await Promise.all([
      DeKittingOrder.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      DeKittingOrder.countDocuments(filter),
    ]);
    res.json({ items, total, page, limit });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function getDeKittingOrder(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid id" });
    }
    const row = await DeKittingOrder.findById(id).lean();
    if (!row) return res.status(404).json({ message: "Not found" });
    res.json(row);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function createDeKittingOrder(req, res) {
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

    const dekitNumber = await nextSequentialNumber(DeKittingOrder, "dekitNumber", "DK");
    const warehouse = String(req.body.warehouse || "MAIN").trim().toUpperCase() || "MAIN";

    const doc = await DeKittingOrder.create({
      dekitNumber,
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

export async function executeDeKittingOrder(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid id" });
    }
    const order = await DeKittingOrder.findById(id);
    if (!order) return res.status(404).json({ message: "Not found" });
    if (order.status !== "DRAFT") {
      return res.status(400).json({ message: "Only DRAFT orders can be executed" });
    }

    const userEmail = req.user?.email || "";
    await runDeKit(order, userEmail);
    order.status = "COMPLETED";
    await order.save();
    res.json(order);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function cancelDeKittingOrder(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid id" });
    }
    const order = await DeKittingOrder.findById(id);
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
