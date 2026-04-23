import mongoose from "mongoose";
import SalesDoc from "../models/SalesDoc.js";
import { nextSequentialNumber } from "../utils/docNumbers.js";

function withCompany(req, filter = {}) {
  return { ...filter, companyId: req.companyId };
}

export async function listSalesOrders(req, res) {
  try {
    const page = Math.max(1, parseInt(String(req.query.page || "1"), 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit || "50"), 10) || 50));
    const skip = (page - 1) * limit;
    const filter = withCompany(req, { type: "ORDER_CONFIRMATION" });
    if (req.query.customerName) {
      filter.customerName = new RegExp(String(req.query.customerName).trim(), "i");
    }
    const [items, total] = await Promise.all([
      SalesDoc.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      SalesDoc.countDocuments(filter),
    ]);
    res.json({ items, total, page, limit });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function createSalesOrder(req, res) {
  try {
    const body = { ...req.body };
    const prefix = `${req.companyCode || "CMP"}-SO`;
    const docNo =
      body.docNo ||
      (await nextSequentialNumber(SalesDoc, "docNo", prefix, {
        companyId: req.companyId,
      }));
    const doc = await SalesDoc.create({
      ...body,
      docNo,
      type: "ORDER_CONFIRMATION",
      companyId: req.companyId,
    });
    res.status(201).json(doc);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function getSalesOrder(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid id" });
    }
    const doc = await SalesDoc.findOne(withCompany(req, { _id: id, type: "ORDER_CONFIRMATION" })).lean();
    if (!doc) return res.status(404).json({ message: "Not found" });
    res.json(doc);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}
