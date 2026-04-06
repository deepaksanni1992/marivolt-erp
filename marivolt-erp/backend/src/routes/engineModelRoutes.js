import express from "express";
import mongoose from "mongoose";
import EngineModel from "../models/EngineModel.js";
import Brand from "../models/Brand.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { validateEngineModelPayload } from "../validation/itemMasterValidation.js";
import { DEFAULT_PAGE_SIZE } from "../constants/masterValues.js";

const router = express.Router();

router.use(requireAuth);

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

router.post("/", requireRole("admin"), async (req, res) => {
  try {
    const payload = validateEngineModelPayload(req.body || {});
    if (!mongoose.Types.ObjectId.isValid(payload.brand)) {
      return res.status(400).json({ message: "Invalid brand id" });
    }
    const b = await Brand.findById(payload.brand);
    if (!b) return res.status(400).json({ message: "Brand not found" });

    const existing = await EngineModel.findOne({
      brand: payload.brand,
      name: new RegExp(`^${escapeRegex(payload.name)}$`, "i"),
    });
    if (existing) {
      return res.status(400).json({ message: "Duplicate model for this brand" });
    }

    const doc = await EngineModel.create(payload);
    const populated = await EngineModel.findById(doc._id)
      .populate({ path: "brand", select: "name vertical status", populate: { path: "vertical", select: "name" } })
      .lean();
    return res.status(201).json(populated);
  } catch (err) {
    return res.status(400).json({ message: err.message });
  }
});

router.get("/", async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page || "1", 10), 1);
    const limit = Math.min(
      Math.max(parseInt(req.query.limit || DEFAULT_PAGE_SIZE, 10), 1),
      500
    );
    const search = String(req.query.search || "").trim();
    const status = String(req.query.status || "").trim();
    const brand = String(req.query.brand || "").trim();

    const query = {};
    if (search) query.name = { $regex: search, $options: "i" };
    if (status) query.status = status;
    if (brand && mongoose.Types.ObjectId.isValid(brand)) {
      query.brand = brand;
    }

    const [items, total] = await Promise.all([
      EngineModel.find(query)
        .populate({
          path: "brand",
          select: "name vertical status",
          populate: { path: "vertical", select: "name status" },
        })
        .sort({ name: 1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      EngineModel.countDocuments(query),
    ]);

    return res.json({ items, pagination: { page, limit, total } });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
});

router.get("/:id", async (req, res) => {
  try {
    const doc = await EngineModel.findById(req.params.id).populate({
      path: "brand",
      select: "name vertical status",
      populate: { path: "vertical", select: "name status" },
    });
    if (!doc) return res.status(404).json({ message: "Engine model not found" });
    return res.json(doc);
  } catch (err) {
    return res.status(400).json({ message: err.message });
  }
});

router.put("/:id", requireRole("admin"), async (req, res) => {
  try {
    const payload = validateEngineModelPayload(req.body || {});
    if (!mongoose.Types.ObjectId.isValid(payload.brand)) {
      return res.status(400).json({ message: "Invalid brand id" });
    }
    const b = await Brand.findById(payload.brand);
    if (!b) return res.status(400).json({ message: "Brand not found" });

    const dup = await EngineModel.findOne({
      _id: { $ne: req.params.id },
      brand: payload.brand,
      name: new RegExp(`^${escapeRegex(payload.name)}$`, "i"),
    });
    if (dup) {
      return res.status(400).json({ message: "Duplicate model for this brand" });
    }

    const updated = await EngineModel.findByIdAndUpdate(req.params.id, payload, {
      new: true,
      runValidators: true,
    });
    if (!updated) {
      return res.status(404).json({ message: "Engine model not found" });
    }
    const populated = await EngineModel.findById(updated._id)
      .populate({
        path: "brand",
        select: "name vertical status",
        populate: { path: "vertical", select: "name status" },
      })
      .lean();
    return res.json(populated);
  } catch (err) {
    return res.status(400).json({ message: err.message });
  }
});

router.delete("/:id", requireRole("admin"), async (req, res) => {
  try {
    const deleted = await EngineModel.findByIdAndDelete(req.params.id);
    if (!deleted) {
      return res.status(404).json({ message: "Engine model not found" });
    }
    return res.json({ success: true });
  } catch (err) {
    return res.status(400).json({ message: err.message });
  }
});

export default router;
