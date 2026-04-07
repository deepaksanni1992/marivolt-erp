import mongoose from "mongoose";
import Item from "../models/itemModel.js";
import ItemMapping from "../models/itemMappingModel.js";
import ItemSupplierOffer from "../models/supplierModel.js";

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function pagination(req) {
  const exportMode = String(req.query.export || "") === "1";
  const page = exportMode ? 1 : Math.max(1, parseInt(String(req.query.page || "1"), 10) || 1);
  const limit = exportMode
    ? Math.min(10_000, Math.max(1, parseInt(String(req.query.limit || "5000"), 10) || 5000))
    : Math.min(100, Math.max(1, parseInt(String(req.query.limit || "50"), 10) || 50));
  const skip = exportMode ? 0 : (page - 1) * limit;
  return { page, limit, skip, exportMode };
}

export async function listItemFacets(req, res) {
  try {
    const [verticals, brands, models] = await Promise.all([
      Item.distinct("vertical", { vertical: { $nin: [null, ""] } }),
      Item.distinct("brand", { brand: { $nin: [null, ""] } }),
      Item.distinct("modelName", { modelName: { $nin: [null, ""] } }),
    ]);
    const norm = (arr) =>
      [...new Set(arr.map((x) => String(x || "").trim()).filter(Boolean))].sort((a, b) =>
        a.localeCompare(b, undefined, { sensitivity: "base" })
      );
    res.json({
      verticals: norm(verticals),
      brands: norm(brands),
      models: norm(models),
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function listItems(req, res) {
  try {
    const { page, limit, skip, exportMode } = pagination(req);
    const filter = {};
    if (req.query.isActive !== undefined) {
      filter.isActive = String(req.query.isActive) === "true";
    }
    if (req.query.search) {
      const s = String(req.query.search).trim();
      filter.$or = [
        { itemCode: new RegExp(s, "i") },
        { description: new RegExp(s, "i") },
        { makerPartNo: new RegExp(s, "i") },
        { supplierPartNo: new RegExp(s, "i") },
      ];
    }
    if (req.query.category) filter.category = new RegExp(String(req.query.category).trim(), "i");
    const v = String(req.query.vertical || "").trim();
    if (v) filter.vertical = new RegExp(`^${escapeRegex(v)}$`, "i");
    const b = String(req.query.brand || "").trim();
    if (b) filter.brand = new RegExp(`^${escapeRegex(b)}$`, "i");
    const m = String(req.query.model || "").trim();
    if (m) filter.modelName = new RegExp(`^${escapeRegex(m)}$`, "i");
    const [items, total] = await Promise.all([
      Item.find(filter).sort({ itemCode: 1 }).skip(skip).limit(limit).lean(),
      Item.countDocuments(filter),
    ]);
    res.json({ items, total, page, limit, exportMode });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function getItem(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid id" });
    }
    const item = await Item.findById(id).lean();
    if (!item) return res.status(404).json({ message: "Not found" });
    res.json(item);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function getItemByCode(req, res) {
  try {
    const code = String(req.params.code || "").trim().toUpperCase();
    const item = await Item.findOne({ itemCode: code }).lean();
    if (!item) return res.status(404).json({ message: "Not found" });
    res.json(item);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

/** GET /api/items/full/:article — item + mapping rows + supplier offer rows */
export async function getItemFullByArticle(req, res) {
  try {
    const raw = req.params.article ?? "";
    const code = decodeURIComponent(String(raw).trim()).toUpperCase();
    if (!code) return res.status(400).json({ message: "Article is required" });

    const item = await Item.findOne({ itemCode: code }).lean();
    if (!item) return res.status(404).json({ message: "Item not found" });

    const [mappings, suppliers] = await Promise.all([
      ItemMapping.find({ article: code }).sort({ createdAt: -1 }).lean(),
      ItemSupplierOffer.find({ article: code }).sort({ createdAt: -1 }).lean(),
    ]);

    res.json({ item, mappings, suppliers });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function createItem(req, res) {
  try {
    const payload = { ...req.body };
    if (payload.itemCode) payload.itemCode = String(payload.itemCode).trim().toUpperCase();
    const item = await Item.create(payload);
    res.status(201).json(item);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function updateItem(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid id" });
    }
    const payload = { ...req.body };
    if (payload.itemCode) payload.itemCode = String(payload.itemCode).trim().toUpperCase();
    delete payload._id;
    const item = await Item.findByIdAndUpdate(id, payload, { new: true, runValidators: true });
    if (!item) return res.status(404).json({ message: "Not found" });
    res.json(item);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function deleteItem(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid id" });
    }
    const item = await Item.findByIdAndDelete(id);
    if (!item) return res.status(404).json({ message: "Not found" });
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function importItems(req, res) {
  try {
    const { items } = req.body;
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ message: "Body must include non-empty items array" });
    }
    if (items.length > 2000) {
      return res.status(400).json({ message: "Maximum 2000 rows per import" });
    }
    let upserted = 0;
    let errors = [];
    for (let i = 0; i < items.length; i++) {
      const row = items[i];
      try {
        const itemCode = String(row.itemCode || "").trim().toUpperCase();
        if (!itemCode) throw new Error("itemCode required");
        await Item.findOneAndUpdate(
          { itemCode },
          {
            $set: {
              itemCode,
              description: row.description ?? "",
              uom: row.uom ?? "PCS",
              vertical: row.vertical ?? "",
              brand: row.brand ?? "",
              modelName: row.modelName ?? row.model ?? "",
              makerPartNo: row.makerPartNo ?? "",
              hsnCode: row.hsnCode ?? "",
              category: row.category ?? "",
              supplierName: row.supplierName ?? "",
              supplierPartNo: row.supplierPartNo ?? "",
              supplierLeadTimeDays: Number(row.supplierLeadTimeDays) || 0,
              purchasePrice: Number(row.purchasePrice) || 0,
              salePrice: Number(row.salePrice) || 0,
              currency: row.currency ?? "USD",
              weightKg: Number(row.weightKg) || 0,
              coo: row.coo ?? row.COO ?? "",
              reorderLevel: Number(row.reorderLevel) || 0,
              remarks: row.remarks ?? "",
              isActive: row.isActive !== false,
            },
          },
          { upsert: true, new: true, runValidators: true }
        );
        upserted += 1;
      } catch (e) {
        errors.push({ index: i, message: e.message });
      }
    }
    res.json({ upserted, errors, errorCount: errors.length });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}
