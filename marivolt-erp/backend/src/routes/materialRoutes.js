import express from "express";
import mongoose from "mongoose";
import Material from "../models/Material.js";
import SPN from "../models/SPN.js";
import MaterialCompatibility from "../models/MaterialCompatibility.js";
import MaterialSupplier from "../models/MaterialSupplier.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { validateMaterialPayload } from "../validation/itemMasterValidation.js";
import { DEFAULT_PAGE_SIZE } from "../constants/masterValues.js";

const router = express.Router();

router.use(requireAuth);

// Create material
router.post("/", requireRole("admin"), async (req, res) => {
  try {
    const payload = validateMaterialPayload(req.body || {});

    const existing = await Material.findOne({
      materialCode: payload.materialCode,
    });
    if (existing) {
      return res
        .status(400)
        .json({ message: "Duplicate materialCode not allowed" });
    }

    const spnDoc = await SPN.findOne({ spn: payload.spn }).select("vertical").lean();
    if (!spnDoc) {
      return res
        .status(400)
        .json({ message: "Invalid SPN reference in material master" });
    }
    if (String(spnDoc.vertical) !== String(payload.vertical)) {
      return res.status(400).json({
        message: "Material vertical must match the selected SPN's vertical",
      });
    }

    const doc = await Material.create(payload);
    const populated = await Material.findById(doc._id)
      .populate("vertical", "name status")
      .lean();
    return res.status(201).json(populated);
  } catch (err) {
    return res.status(400).json({ message: err.message });
  }
});

// List materials with pagination + filters
router.get("/", async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page || "1", 10), 1);
    const limit = Math.min(
      Math.max(parseInt(req.query.limit || DEFAULT_PAGE_SIZE, 10), 1),
      200
    );
    const search = String(req.query.search || "").trim();
    const status = String(req.query.status || "").trim();
    const spn = String(req.query.spn || "").trim();
    const itemType = String(req.query.itemType || "").trim();
    const vertical = String(req.query.vertical || "").trim();

    const query = {};

    if (search) {
      query.$or = [
        { materialCode: { $regex: search, $options: "i" } },
        { spn: { $regex: search, $options: "i" } },
        { shortDescription: { $regex: search, $options: "i" } },
      ];
    }
    if (status) query.status = status;
    if (spn) query.spn = spn;
    if (itemType) query.itemType = itemType;
    if (vertical && mongoose.Types.ObjectId.isValid(vertical)) {
      query.vertical = vertical;
    }

    const [rows, total, compatCounts, supplierCounts] = await Promise.all([
      Material.find(query)
        .populate("vertical", "name status")
        .sort({ materialCode: 1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      Material.countDocuments(query),
      MaterialCompatibility.aggregate([
        { $match: { materialCode: { $exists: true } } },
        { $group: { _id: "$materialCode", count: { $sum: 1 } } },
      ]),
      MaterialSupplier.aggregate([
        { $match: { materialCode: { $exists: true } } },
        { $group: { _id: "$materialCode", count: { $sum: 1 } } },
      ]),
    ]);

    const compatMap = new Map(
      compatCounts.map((c) => [c._id, c.count])
    );
    const supplierMap = new Map(
      supplierCounts.map((c) => [c._id, c.count])
    );

    const items = rows.map((m) => ({
      ...m,
      compatibilityCount: compatMap.get(m.materialCode) || 0,
      supplierCount: supplierMap.get(m.materialCode) || 0,
    }));

    return res.json({
      items,
      pagination: { page, limit, total },
    });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
});

// Get material by id
router.get("/:id", async (req, res) => {
  try {
    const material = await Material.findById(req.params.id).populate(
      "vertical",
      "name status"
    );
    if (!material) {
      return res.status(404).json({ message: "Material not found" });
    }
    return res.json(material);
  } catch (err) {
    return res.status(400).json({ message: err.message });
  }
});

// Update material
router.put("/:id", requireRole("admin"), async (req, res) => {
  try {
    const payload = validateMaterialPayload(req.body || {});

    const duplicate = await Material.findOne({
      _id: { $ne: req.params.id },
      materialCode: payload.materialCode,
    });
    if (duplicate) {
      return res
        .status(400)
        .json({ message: "Duplicate materialCode not allowed" });
    }

    const spnDoc = await SPN.findOne({ spn: payload.spn }).select("vertical").lean();
    if (!spnDoc) {
      return res
        .status(400)
        .json({ message: "Invalid SPN reference in material master" });
    }
    if (String(spnDoc.vertical) !== String(payload.vertical)) {
      return res.status(400).json({
        message: "Material vertical must match the selected SPN's vertical",
      });
    }

    const updated = await Material.findByIdAndUpdate(
      req.params.id,
      payload,
      { new: true, runValidators: true }
    );
    if (!updated) {
      return res.status(404).json({ message: "Material not found" });
    }
    const populated = await Material.findById(updated._id)
      .populate("vertical", "name status")
      .lean();
    return res.json(populated);
  } catch (err) {
    return res.status(400).json({ message: err.message });
  }
});

// Delete material
router.delete("/:id", requireRole("admin"), async (req, res) => {
  try {
    const deleted = await Material.findByIdAndDelete(req.params.id);
    if (!deleted) {
      return res.status(404).json({ message: "Material not found" });
    }
    return res.json({ success: true });
  } catch (err) {
    return res.status(400).json({ message: err.message });
  }
});

export default router;

