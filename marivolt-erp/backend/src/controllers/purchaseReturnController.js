import mongoose from "mongoose";
import PurchaseReturn from "../models/PurchaseReturn.js";
import { nextSequentialNumber } from "../utils/docNumbers.js";
import { applyStockOut } from "../services/stockService.js";

function recalcTotals(doc) {
  let sub = 0;
  for (const line of doc.lines) {
    line.lineTotal = (Number(line.qty) || 0) * (Number(line.unitPrice) || 0);
    sub += line.lineTotal;
  }
  doc.subTotal = sub;
  doc.grandTotal = sub;
}

function pagination(req) {
  const page = Math.max(1, parseInt(String(req.query.page || "1"), 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit || "50"), 10) || 50));
  return { page, limit, skip: (page - 1) * limit };
}

export async function listPurchaseReturns(req, res) {
  try {
    const { page, limit, skip } = pagination(req);
    const filter = {};
    if (req.query.status) filter.status = req.query.status;
    if (req.query.supplierName) {
      filter.supplierName = new RegExp(String(req.query.supplierName).trim(), "i");
    }
    const [items, total] = await Promise.all([
      PurchaseReturn.find(filter).sort({ returnDate: -1 }).skip(skip).limit(limit).lean(),
      PurchaseReturn.countDocuments(filter),
    ]);
    res.json({ items, total, page, limit });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function getPurchaseReturn(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid id" });
    }
    const row = await PurchaseReturn.findById(id).lean();
    if (!row) return res.status(404).json({ message: "Not found" });
    res.json(row);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function createPurchaseReturn(req, res) {
  try {
    const body = { ...req.body };
    if (!body.returnNumber) {
      body.returnNumber = await nextSequentialNumber(PurchaseReturn, "returnNumber", "PR");
    }
    body.createdBy = req.user?.email || "";
    if (body.warehouse) {
      body.warehouse = String(body.warehouse).trim().toUpperCase() || "MAIN";
    }
    const doc = new PurchaseReturn(body);
    recalcTotals(doc);
    await doc.save();
    res.status(201).json(doc);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function updatePurchaseReturn(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid id" });
    }
    const doc = await PurchaseReturn.findById(id);
    if (!doc) return res.status(404).json({ message: "Not found" });
    if (doc.status === "POSTED") {
      return res.status(400).json({ message: "Posted returns cannot be edited" });
    }
    const allowed = [
      "supplierName",
      "linkedPoNumber",
      "linkedPoId",
      "warehouse",
      "currency",
      "lines",
      "remarks",
      "returnDate",
      "status",
    ];
    for (const k of allowed) {
      if (req.body[k] !== undefined) doc[k] = req.body[k];
    }
    if (doc.warehouse) doc.warehouse = String(doc.warehouse).trim().toUpperCase() || "MAIN";
    recalcTotals(doc);
    await doc.save();
    res.json(doc);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function postPurchaseReturn(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid id" });
    }
    const pr = await PurchaseReturn.findById(id);
    if (!pr) return res.status(404).json({ message: "Not found" });
    if (pr.status === "POSTED") {
      return res.status(400).json({ message: "Already posted" });
    }
    if (pr.status === "CANCELLED") {
      return res.status(400).json({ message: "Cancelled return cannot be posted" });
    }
    if (!pr.lines?.length) {
      return res.status(400).json({ message: "No lines to post" });
    }

    const userEmail = req.user?.email || "";
    const wh = String(pr.warehouse || "MAIN").trim().toUpperCase() || "MAIN";
    const refId = String(pr._id);

    for (const line of pr.lines) {
      const q = Number(line.qty) || 0;
      if (q <= 0) continue;
      await applyStockOut({
        itemCode: line.itemCode,
        warehouse: wh,
        qty: q,
        movementType: "OUT_RETURN",
        referenceType: "PURCHASE_RETURN",
        referenceId: refId,
        referenceNumber: pr.returnNumber,
        remarks: line.reason || pr.remarks || "",
        createdBy: userEmail,
      });
    }

    pr.status = "POSTED";
    await pr.save();
    res.json(pr);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function deletePurchaseReturn(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid id" });
    }
    const row = await PurchaseReturn.findById(id);
    if (!row) return res.status(404).json({ message: "Not found" });
    if (row.status === "POSTED") {
      return res.status(400).json({ message: "Cannot delete posted return" });
    }
    await PurchaseReturn.findByIdAndDelete(id);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}
