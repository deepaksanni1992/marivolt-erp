import express from "express";
import mongoose from "mongoose";
import Brand from "../models/Brand.js";
import Vertical from "../models/Vertical.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { validateBrandPayload } from "../validation/masterDataValidation.js";
import { DEFAULT_PAGE_SIZE } from "../constants/masterValues.js";

const router = express.Router();

router.use(requireAuth);

router.post("/", requireRole("admin"), async (req, res) => {
  try {
    const payload = validateBrandPayload(req.body || {});
    if (!mongoose.Types.ObjectId.isValid(payload.vertical)) {
      return res.status(400).json({ message: "Invalid vertical id" });
    }
    const v = await Vertical.findById(payload.vertical);
    if (!v) return res.status(400).json({ message: "Vertical not found" });

    const existing = await Brand.findOne({
      vertical: payload.vertical,
      name: new RegExp(`^${escapeRegex(payload.name)}$`, "i"),
    });
    if (existing) {
      return res.status(400).json({ message: "Duplicate brand for this vertical" });
    }

    const doc = await Brand.create(payload);
    return res.status(201).json(doc);
  } catch (err) {
    return res.status(400).json({ message: err.message });
  }
});

router.get("/", async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page || "1", 10), 1);
    const limit = Math.min(
      Math.max(parseInt(req.query.limit || DEFAULT_PAGE_SIZE, 10), 1),
      200
    );
    const search = String(req.query.search || "").trim();
    const status = String(req.query.status || "").trim();
    const vertical = String(req.query.vertical || "").trim();

    const query = {};
    if (search) query.name = { $regex: search, $options: "i" };
    if (status) query.status = status;
    if (vertical && mongoose.Types.ObjectId.isValid(vertical)) {
      query.vertical = vertical;
    }

    const [items, total] = await Promise.all([
      Brand.find(query)
        .populate("vertical", "name status")
        .sort({ name: 1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      Brand.countDocuments(query),
    ]);
    return res.json({ items, pagination: { page, limit, total } });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
});

router.get("/:id", async (req, res) => {
  try {
    const doc = await Brand.findById(req.params.id).populate("vertical", "name status");
    if (!doc) return res.status(404).json({ message: "Brand not found" });
    return res.json(doc);
  } catch (err) {
    return res.status(400).json({ message: err.message });
  }
});

router.put("/:id", requireRole("admin"), async (req, res) => {
  try {
    const payload = validateBrandPayload(req.body || {});
    if (!mongoose.Types.ObjectId.isValid(payload.vertical)) {
      return res.status(400).json({ message: "Invalid vertical id" });
    }
    const v = await Vertical.findById(payload.vertical);
    if (!v) return res.status(400).json({ message: "Vertical not found" });

    const dup = await Brand.findOne({
      _id: { $ne: req.params.id },
      vertical: payload.vertical,
      name: new RegExp(`^${escapeRegex(payload.name)}$`, "i"),
    });
    if (dup) {
      return res.status(400).json({ message: "Duplicate brand for this vertical" });
    }

    const updated = await Brand.findByIdAndUpdate(req.params.id, payload, {
      new: true,
      runValidators: true,
    });
    if (!updated) return res.status(404).json({ message: "Brand not found" });
    return res.json(updated);
  } catch (err) {
    return res.status(400).json({ message: err.message });
  }
});

router.delete("/:id", requireRole("admin"), async (req, res) => {
  try {
    const deleted = await Brand.findByIdAndDelete(req.params.id);
    if (!deleted) return res.status(404).json({ message: "Brand not found" });
    return res.json({ success: true });
  } catch (err) {
    return res.status(400).json({ message: err.message });
  }
});

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export default router;
