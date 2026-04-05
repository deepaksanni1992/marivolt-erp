import express from "express";
import Vertical from "../models/Vertical.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { validateVerticalPayload } from "../validation/itemMasterValidation.js";
import { DEFAULT_PAGE_SIZE } from "../constants/masterValues.js";
import { ensureDefaultBrandsForVertical } from "../utils/ensureDefaultBrands.js";

const router = express.Router();

router.use(requireAuth);

router.post("/", requireRole("admin"), async (req, res) => {
  try {
    const payload = validateVerticalPayload(req.body || {});
    const existing = await Vertical.findOne({
      name: new RegExp(`^${escapeRegex(payload.name)}$`, "i"),
    });
    if (existing) {
      return res.status(400).json({ message: "Duplicate vertical name" });
    }
    const doc = await Vertical.create(payload);
    await ensureDefaultBrandsForVertical(doc._id);
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
    const query = {};
    if (search) {
      query.name = { $regex: search, $options: "i" };
    }
    if (status) query.status = status;

    const [items, total] = await Promise.all([
      Vertical.find(query)
        .sort({ name: 1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      Vertical.countDocuments(query),
    ]);
    return res.json({ items, pagination: { page, limit, total } });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
});

router.get("/:id", async (req, res) => {
  try {
    const doc = await Vertical.findById(req.params.id);
    if (!doc) return res.status(404).json({ message: "Vertical not found" });
    return res.json(doc);
  } catch (err) {
    return res.status(400).json({ message: err.message });
  }
});

router.put("/:id", requireRole("admin"), async (req, res) => {
  try {
    const payload = validateVerticalPayload(req.body || {});
    const dup = await Vertical.findOne({
      _id: { $ne: req.params.id },
      name: new RegExp(`^${escapeRegex(payload.name)}$`, "i"),
    });
    if (dup) {
      return res.status(400).json({ message: "Duplicate vertical name" });
    }
    const updated = await Vertical.findByIdAndUpdate(req.params.id, payload, {
      new: true,
      runValidators: true,
    });
    if (!updated) return res.status(404).json({ message: "Vertical not found" });
    return res.json(updated);
  } catch (err) {
    return res.status(400).json({ message: err.message });
  }
});

router.delete("/:id", requireRole("admin"), async (req, res) => {
  try {
    const deleted = await Vertical.findByIdAndDelete(req.params.id);
    if (!deleted) return res.status(404).json({ message: "Vertical not found" });
    return res.json({ success: true });
  } catch (err) {
    return res.status(400).json({ message: err.message });
  }
});

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export default router;
