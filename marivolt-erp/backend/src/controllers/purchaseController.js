import mongoose from "mongoose";
import PurchaseOrder from "../models/PurchaseOrder.js";
import { nextSequentialNumber } from "../utils/docNumbers.js";
import { applyStockIn } from "../services/stockService.js";

function recalcPoTotals(doc) {
  let sub = 0;
  const cur = doc.currency || "USD";
  for (const line of doc.lines) {
    line.currency = line.currency || cur;
    line.lineTotal = (Number(line.qty) || 0) * (Number(line.unitPrice) || 0);
    sub += line.lineTotal;
  }
  doc.subTotal = sub;
  doc.grandTotal = sub;
}

export async function listPurchaseOrders(req, res) {
  try {
    const page = Math.max(1, parseInt(String(req.query.page || "1"), 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit || "50"), 10) || 50));
    const skip = (page - 1) * limit;
    const filter = {};
    if (req.query.status) filter.status = req.query.status;
    if (req.query.supplierName) {
      filter.supplierName = new RegExp(String(req.query.supplierName).trim(), "i");
    }
    const [rows, total] = await Promise.all([
      PurchaseOrder.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      PurchaseOrder.countDocuments(filter),
    ]);
    res.json({ items: rows, total, page, limit });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function getPurchaseOrder(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid id" });
    }
    const row = await PurchaseOrder.findById(id).lean();
    if (!row) return res.status(404).json({ message: "Not found" });
    res.json(row);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function createPurchaseOrder(req, res) {
  try {
    const body = { ...req.body };
    if (!body.poNumber) {
      body.poNumber = await nextSequentialNumber(PurchaseOrder, "poNumber", "PO");
    }
    body.createdBy = req.user?.email || "";
    const doc = new PurchaseOrder(body);
    recalcPoTotals(doc);
    await doc.save();
    res.status(201).json(doc);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function updatePurchaseOrder(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid id" });
    }
    const doc = await PurchaseOrder.findById(id);
    if (!doc) return res.status(404).json({ message: "Not found" });

    const allowed = [
      "supplierName",
      "supplierReference",
      "currency",
      "lines",
      "status",
      "remarks",
      "orderDate",
    ];
    for (const k of allowed) {
      if (req.body[k] !== undefined) doc[k] = req.body[k];
    }
    recalcPoTotals(doc);
    await doc.save();
    res.json(doc);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function patchPurchaseStatus(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid id" });
    }
    const { status } = req.body;
    if (!status) return res.status(400).json({ message: "status required" });
    const doc = await PurchaseOrder.findByIdAndUpdate(
      id,
      { status },
      { new: true, runValidators: true }
    );
    if (!doc) return res.status(404).json({ message: "Not found" });
    res.json(doc);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function receivePurchaseOrder(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid id" });
    }
    const po = await PurchaseOrder.findById(id);
    if (!po) return res.status(404).json({ message: "Not found" });

    const { warehouse = "MAIN", lines } = req.body;
    if (!Array.isArray(lines) || lines.length === 0) {
      return res.status(400).json({ message: "lines array required" });
    }

    const userEmail = req.user?.email || "";

    for (const row of lines) {
      const lineId = row.lineId;
      const q = Number(row.qty);
      if (!lineId) return res.status(400).json({ message: "Each line needs lineId" });
      if (!Number.isFinite(q) || q <= 0) return res.status(400).json({ message: "Invalid qty" });

      const line = po.lines.id(lineId);
      if (!line) return res.status(400).json({ message: `Invalid lineId ${lineId}` });

      const remaining = (Number(line.qty) || 0) - (Number(line.receivedQty) || 0);
      const take = Math.min(q, remaining);
      if (take <= 0) continue;

      await applyStockIn({
        itemCode: line.itemCode,
        warehouse,
        qty: take,
        movementType: "IN_PURCHASE",
        referenceType: "PURCHASE_ORDER",
        referenceId: po._id,
        referenceNumber: po.poNumber,
        unitCost: line.unitPrice,
        remarks: row.remarks || "",
        createdBy: userEmail,
      });

      line.receivedQty = (Number(line.receivedQty) || 0) + take;
    }

    const allReceived = po.lines.length > 0 && po.lines.every((l) => (l.receivedQty || 0) >= (l.qty || 0));
    const anyReceived = po.lines.some((l) => (l.receivedQty || 0) > 0);
    if (allReceived) po.status = "RECEIVED";
    else if (anyReceived) po.status = "PARTIAL_RECEIVED";

    await po.save();
    res.json(po);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function deletePurchaseOrder(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid id" });
    }
    const row = await PurchaseOrder.findByIdAndDelete(id);
    if (!row) return res.status(404).json({ message: "Not found" });
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}
