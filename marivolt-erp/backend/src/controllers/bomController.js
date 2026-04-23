import mongoose from "mongoose";
import BOM from "../models/BOM.js";

function pagination(req) {
  const page = Math.max(1, parseInt(String(req.query.page || "1"), 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit || "50"), 10) || 50));
  return { page, limit, skip: (page - 1) * limit };
}

function withCompany(req, filter = {}) {
  return { ...filter, companyId: req.companyId };
}

export async function listBoms(req, res) {
  try {
    const { page, limit, skip } = pagination(req);
    const filter = withCompany(req);
    if (req.query.isActive !== undefined) {
      filter.isActive = String(req.query.isActive) === "true";
    }
    if (req.query.search) {
      const s = String(req.query.search).trim();
      filter.$or = [
        { parentItemCode: new RegExp(s, "i") },
        { name: new RegExp(s, "i") },
        { description: new RegExp(s, "i") },
      ];
    }
    const [items, total] = await Promise.all([
      BOM.find(filter).sort({ parentItemCode: 1 }).skip(skip).limit(limit).lean(),
      BOM.countDocuments(filter),
    ]);
    res.json({ items, total, page, limit });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function getBom(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid id" });
    }
    const row = await BOM.findOne(withCompany(req, { _id: id })).lean();
    if (!row) return res.status(404).json({ message: "Not found" });
    res.json(row);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function getBomByParentCode(req, res) {
  try {
    const code = String(req.params.parentCode || "").trim().toUpperCase();
    const row = await BOM.findOne(withCompany(req, { parentItemCode: code })).lean();
    if (!row) return res.status(404).json({ message: "Not found" });
    res.json(row);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function createBom(req, res) {
  try {
    const body = { ...req.body, companyId: req.companyId, createdBy: req.user?.email || "" };
    if (body.parentItemCode) {
      body.parentItemCode = String(body.parentItemCode).trim().toUpperCase();
    }
    if (Array.isArray(body.lines)) {
      body.lines = body.lines
        .map((l) => ({
          ...l,
          componentItemCode: String(l.componentItemCode || "").trim().toUpperCase(),
          qty: Number(l.qty) || 0,
        }))
        .filter((l) => l.componentItemCode && l.qty > 0);
    }
    const doc = await BOM.create(body);
    res.status(201).json(doc);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function updateBom(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid id" });
    }
    const payload = { ...req.body };
    delete payload._id;
    delete payload.createdBy;
    if (payload.parentItemCode) {
      payload.parentItemCode = String(payload.parentItemCode).trim().toUpperCase();
    }
    if (Array.isArray(payload.lines)) {
      payload.lines = payload.lines
        .map((l) => ({
          ...l,
          componentItemCode: String(l.componentItemCode || "").trim().toUpperCase(),
          qty: Number(l.qty) || 0,
        }))
        .filter((l) => l.componentItemCode && l.qty > 0);
    }
    const doc = await BOM.findOneAndUpdate(withCompany(req, { _id: id }), payload, {
      new: true,
      runValidators: true,
    });
    if (!doc) return res.status(404).json({ message: "Not found" });
    res.json(doc);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function deleteBom(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid id" });
    }
    const row = await BOM.findOneAndDelete(withCompany(req, { _id: id }));
    if (!row) return res.status(404).json({ message: "Not found" });
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}
