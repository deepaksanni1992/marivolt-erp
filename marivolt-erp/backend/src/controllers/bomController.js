import mongoose from "mongoose";
import BOM from "../models/BOM.js";
import ItemMaster from "../models/itemMasterModel.js";
import {
  appendBomRevisionHistory,
  bomConversionDefChanged,
  resolveBomKind,
  validateAndEnrichPackConversionBom,
} from "../utils/kittingPackConversion.js";
import { BOM_ITEM_NOT_FOUND, BOM_ITEM_INACTIVE, BOM_PACK_CONVERSION_INVALID } from "../utils/kittingIdempotency.js";

function pagination(req) {
  const page = Math.max(1, parseInt(String(req.query.page || "1"), 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit || "50"), 10) || 50));
  return { page, limit, skip: (page - 1) * limit };
}

function withCompany(req, filter = {}) {
  return { ...filter, companyId: req.companyId };
}

function respondBomError(res, err) {
  const code = err.code || BOM_PACK_CONVERSION_INVALID;
  const status = [BOM_ITEM_NOT_FOUND, BOM_ITEM_INACTIVE, BOM_PACK_CONVERSION_INVALID].includes(code) ? 400 : 400;
  return res.status(status).json({
    message: err.message,
    code,
    article: err.article || null,
  });
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
    componentUom: String(line.componentUom || "").trim().toUpperCase(),
    componentItemName: String(line.componentItemName || "").trim(),
  };
}

async function enrichGenericBomLines(companyId, parentItemCode, lines) {
  const codes = [
    String(parentItemCode || "").trim().toUpperCase(),
    ...lines.map((l) => String(l.article || l.componentItemCode || "").trim().toUpperCase()),
  ].filter(Boolean);
  const items = await ItemMaster.find({ companyId, article: { $in: codes } }).lean();
  const map = new Map(items.map((i) => [String(i.article).toUpperCase(), i]));
  const parent = map.get(String(parentItemCode).toUpperCase());
  if (!parent) {
    const err = new Error(`Item Master article not found: ${parentItemCode}`);
    err.code = BOM_ITEM_NOT_FOUND;
    err.article = parentItemCode;
    throw err;
  }
  if (String(parent.status || "Active") !== "Active") {
    const err = new Error(`Item Master article is not active: ${parentItemCode}`);
    err.code = BOM_ITEM_INACTIVE;
    err.article = parentItemCode;
    throw err;
  }
  const enriched = lines.map((l) => {
    const code = String(l.article || l.componentItemCode || "").trim().toUpperCase();
    const item = map.get(code);
    if (!item) {
      const err = new Error(`Item Master article not found: ${code}`);
      err.code = BOM_ITEM_NOT_FOUND;
      err.article = code;
      throw err;
    }
    if (String(item.status || "Active") !== "Active") {
      const err = new Error(`Item Master article is not active: ${code}`);
      err.code = BOM_ITEM_INACTIVE;
      err.article = code;
      throw err;
    }
    return {
      ...l,
      componentUom: String(item.uom || "PCS").toUpperCase(),
      componentItemName: item.itemName || "",
      description: l.description || item.description || item.itemName || "",
    };
  });
  return {
    parentUom: String(parent.uom || "PCS").toUpperCase(),
    parentItemName: parent.itemName || "",
    lines: enriched,
  };
}

async function prepareBomPayload(req, body, existing = null) {
  const payload = { ...body };
  if (payload.parentItemCode) {
    payload.parentItemCode = String(payload.parentItemCode).trim().toUpperCase();
  }
  if (Array.isArray(payload.lines)) {
    payload.lines = payload.lines.map(normalizeBomLine).filter((l) => l.article && l.qty > 0);
  }
  payload.kitType = String(payload.kitType || existing?.kitType || "CUSTOM_KIT").trim().toUpperCase();
  payload.bomKind = resolveBomKind(payload.kitType);
  payload.workflowMode = String(payload.workflowMode || existing?.workflowMode || "BOTH").trim().toUpperCase();
  payload.revisionNo = String(payload.revisionNo || existing?.revisionNo || "R1").trim();
  payload.bomName = String(payload.bomName || payload.name || existing?.bomName || "").trim();
  payload.bomCode = String(
    payload.bomCode || `${payload.parentItemCode || existing?.parentItemCode}-${payload.revisionNo}`
  ).trim().toUpperCase();

  if (payload.bomKind === "PACK_CONVERSION") {
    const validated = await validateAndEnrichPackConversionBom({
      companyId: req.companyId,
      parentItemCode: payload.parentItemCode || existing?.parentItemCode,
      lines: payload.lines,
      workflowMode: payload.workflowMode,
    });
    payload.parentUom = validated.parentUom;
    payload.parentItemName = validated.parentItemName;
    payload.lines = [validated.enrichedLine];
    payload.workflowMode = validated.workflowMode;
  } else if (payload.lines?.length) {
    try {
      const enriched = await enrichGenericBomLines(
        req.companyId,
        payload.parentItemCode || existing?.parentItemCode,
        payload.lines
      );
      payload.parentUom = enriched.parentUom;
      payload.parentItemName = enriched.parentItemName;
      payload.lines = enriched.lines;
    } catch (err) {
      if (err.code === BOM_ITEM_NOT_FOUND || err.code === BOM_ITEM_INACTIVE) {
        // Legacy generic BOMs may reference articles not yet in Item Master.
      } else {
        throw err;
      }
    }
  }

  if (existing && payload.bomKind === "PACK_CONVERSION" && bomConversionDefChanged(existing, payload)) {
    payload.revisions = appendBomRevisionHistory(existing, req.user?.email || "");
  }

  return payload;
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
    const body = await prepareBomPayload(req, { ...req.body });
    const doc = await BOM.create({
      ...body,
      companyId: req.companyId,
      createdBy: req.user?.email || "",
    });
    res.status(201).json(doc);
  } catch (err) {
    if (err.code) return respondBomError(res, err);
    res.status(400).json({ message: err.message });
  }
}

export async function updateBom(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid id" });
    }
    const existing = await BOM.findOne(withCompany(req, { _id: id }));
    if (!existing) return res.status(404).json({ message: "Not found" });

    const payload = await prepareBomPayload(req, { ...req.body }, existing.toObject());
    delete payload._id;
    delete payload.createdBy;
    delete payload.companyId;

    const doc = await BOM.findOneAndUpdate(withCompany(req, { _id: id }), payload, {
      new: true,
      runValidators: true,
    });
    res.json(doc);
  } catch (err) {
    if (err.code) return respondBomError(res, err);
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
      parentUom: r.parentUom || "",
      kitType: r.kitType || "",
      bomKind: r.bomKind || "",
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
