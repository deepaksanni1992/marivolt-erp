import mongoose from "mongoose";
import Quotation from "../models/Quotation.js";
import { nextSequentialNumber } from "../utils/docNumbers.js";
import { applyStockOut } from "../services/stockService.js";

function withCompany(req, filter = {}) {
  return { ...filter, companyId: req.companyId };
}

function recalcQuotationTotals(doc) {
  let sub = 0;
  const cur = doc.currency || "USD";
  for (const line of doc.lines) {
    line.currency = line.currency || cur;
    line.lineTotal = (Number(line.qty) || 0) * (Number(line.salePrice) || 0);
    sub += line.lineTotal;
  }
  doc.subTotal = sub;
  doc.grandTotal = sub;
}

export async function listQuotations(req, res) {
  try {
    const page = Math.max(1, parseInt(String(req.query.page || "1"), 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit || "50"), 10) || 50));
    const skip = (page - 1) * limit;
    const filter = withCompany(req);
    if (req.query.status) filter.status = req.query.status;
    if (req.query.customerName) {
      filter.customerName = new RegExp(String(req.query.customerName).trim(), "i");
    }
    const [rows, total] = await Promise.all([
      Quotation.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      Quotation.countDocuments(filter),
    ]);
    res.json({ items: rows, total, page, limit });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function getQuotation(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid id" });
    }
    const row = await Quotation.findOne(withCompany(req, { _id: id })).lean();
    if (!row) return res.status(404).json({ message: "Not found" });
    res.json(row);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function createQuotation(req, res) {
  try {
    const body = { ...req.body };
    if (!body.quotationNumber) {
      body.quotationNumber = await nextSequentialNumber(
        Quotation,
        "quotationNumber",
        `${req.companyCode || "CMP"}-QT`,
        { companyId: req.companyId }
      );
    }
    body.createdBy = req.user?.email || "";
    body.companyId = req.companyId;
    const doc = new Quotation(body);
    recalcQuotationTotals(doc);
    await doc.save();
    res.status(201).json(doc);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function updateQuotation(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid id" });
    }
    const doc = await Quotation.findOne(withCompany(req, { _id: id }));
    if (!doc) return res.status(404).json({ message: "Not found" });

    const allowed = [
      "customerName",
      "customerReference",
      "currency",
      "lines",
      "status",
      "remarks",
      "quotationDate",
      "validUntil",
    ];
    for (const k of allowed) {
      if (req.body[k] !== undefined) doc[k] = req.body[k];
    }
    recalcQuotationTotals(doc);
    await doc.save();
    res.json(doc);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function patchQuotationStatus(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid id" });
    }
    const { status } = req.body;
    if (!status) return res.status(400).json({ message: "status required" });
    const doc = await Quotation.findOneAndUpdate(
      withCompany(req, { _id: id }),
      { status },
      { new: true, runValidators: true }
    );
    if (!doc) return res.status(404).json({ message: "Not found" });
    res.json(doc);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function stockOutFromQuotation(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid id" });
    }
    const q = await Quotation.findOne(withCompany(req, { _id: id }));
    if (!q) return res.status(404).json({ message: "Not found" });

    const { warehouse = "MAIN", lines } = req.body;
    if (!Array.isArray(lines) || lines.length === 0) {
      return res.status(400).json({ message: "lines array required" });
    }

    const userEmail = req.user?.email || "";

    for (const row of lines) {
      const lineId = row.lineId;
      const qty = Number(row.qty);
      if (!lineId) return res.status(400).json({ message: "Each line needs lineId" });
      if (!Number.isFinite(qty) || qty <= 0) return res.status(400).json({ message: "Invalid qty" });

      const line = q.lines.id(lineId);
      if (!line) return res.status(400).json({ message: `Invalid lineId ${lineId}` });
      if (qty > (Number(line.qty) || 0)) {
        return res.status(400).json({ message: "qty exceeds quotation line qty" });
      }

      await applyStockOut({
        companyId: req.companyId,
        itemCode: line.itemCode,
        warehouse,
        qty,
        movementType: "OUT_SALE",
        referenceType: "QUOTATION",
        referenceId: q._id,
        referenceNumber: q.quotationNumber,
        remarks: row.remarks || "",
        createdBy: userEmail,
      });
    }

    res.json({ success: true, quotationId: q._id });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function deleteQuotation(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid id" });
    }
    const row = await Quotation.findOneAndDelete(withCompany(req, { _id: id }));
    if (!row) return res.status(404).json({ message: "Not found" });
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}
