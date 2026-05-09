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

function normalizeBomLine(line = {}) {
  const article = String(line.article || line.componentItemCode || "").trim().toUpperCase();
  const alternativeArticles = Array.isArray(line.alternativeArticles)
    ? line.alternativeArticles.map((x) => String(x || "").trim().toUpperCase()).filter(Boolean)
    : String(line.alternativeArticles || "")
        .split(",")
        .map((x) => x.trim().toUpperCase())
        .filter(Boolean);
  return {
    ...line,
    article,
    componentItemCode: article,
    qty: Number(line.qty) || 0,
    optionalFlag: Boolean(line.optionalFlag),
    interchangeableGroup: String(line.interchangeableGroup || "").trim().toUpperCase(),
    alternativeArticles,
    remarks: String(line.remarks || "").trim(),
  };
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
    if (req.query.kitType) {
      filter.kitType = String(req.query.kitType).trim().toUpperCase();
    }
    if (req.query.workflowMode) {
      filter.workflowMode = String(req.query.workflowMode).trim().toUpperCase();
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
      body.lines = body.lines.map(normalizeBomLine).filter((l) => l.article && l.qty > 0);
    }
    body.kitType = String(body.kitType || "CUSTOM_KIT").trim().toUpperCase();
    body.workflowMode = String(body.workflowMode || "BOTH").trim().toUpperCase();
    body.revisionNo = String(body.revisionNo || "R1").trim();
    body.bomName = String(body.bomName || body.name || "").trim();
    body.bomCode = String(body.bomCode || `${body.parentItemCode}-${body.revisionNo}`).trim().toUpperCase();
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
      payload.lines = payload.lines.map(normalizeBomLine).filter((l) => l.article && l.qty > 0);
    }
    if (payload.kitType) payload.kitType = String(payload.kitType).trim().toUpperCase();
    if (payload.workflowMode) payload.workflowMode = String(payload.workflowMode).trim().toUpperCase();
    if (payload.revisionNo) payload.revisionNo = String(payload.revisionNo).trim();
    if (payload.bomName) payload.bomName = String(payload.bomName).trim();
    if (payload.bomCode) payload.bomCode = String(payload.bomCode).trim().toUpperCase();
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

export async function bomSummaryReport(req, res) {
  try {
    const rows = await BOM.find(withCompany(req))
      .sort({ updatedAt: -1 })
      .limit(500)
      .lean();
    const items = rows.map((r) => ({
      bomCode: r.bomCode || "",
      bomName: r.bomName || r.name || "",
      parentItemCode: r.parentItemCode,
      kitType: r.kitType || "",
      workflowMode: r.workflowMode || "",
      engineModel: r.engineModel || "",
      configuration: r.configuration || "",
      revisionNo: r.revisionNo || "",
      linesCount: (r.lines || []).length,
      optionalLines: (r.lines || []).filter((x) => x.optionalFlag).length,
      activeStatus: r.isActive ? "ACTIVE" : "INACTIVE",
      updatedAt: r.updatedAt,
    }));
    res.json({ items });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}
