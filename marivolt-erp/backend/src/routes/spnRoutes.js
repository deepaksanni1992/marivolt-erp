import express from "express";
import SPN from "../models/SPN.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { validateSpnPayload } from "../validation/itemMasterValidation.js";
import { DEFAULT_PAGE_SIZE } from "../constants/masterValues.js";

const router = express.Router();

router.use(requireAuth);

// Create SPN
router.post("/", requireRole("admin"), async (req, res) => {
  try {
    const payload = validateSpnPayload(req.body || {});

    const existing = await SPN.findOne({ spn: payload.spn });
    if (existing) {
      return res.status(400).json({ message: "Duplicate SPN not allowed" });
    }

    const doc = await SPN.create(payload);
    return res.status(201).json(doc);
  } catch (err) {
    return res.status(400).json({ message: err.message });
  }
});

// List SPNs with pagination and search
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
      query.$or = [
        { spn: { $regex: search, $options: "i" } },
        { partName: { $regex: search, $options: "i" } },
        { genericDescription: { $regex: search, $options: "i" } },
      ];
    }
    if (status) {
      query.status = status;
    }

    const [items, total] = await Promise.all([
      SPN.find(query)
        .sort({ spn: 1 })
        .skip((page - 1) * limit)
        .limit(limit),
      SPN.countDocuments(query),
    ]);

    return res.json({
      items,
      pagination: { page, limit, total },
    });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
});

// Get SPN by id
router.get("/:id", async (req, res) => {
  try {
    const spn = await SPN.findById(req.params.id);
    if (!spn) {
      return res.status(404).json({ message: "SPN not found" });
    }
    return res.json(spn);
  } catch (err) {
    return res.status(400).json({ message: err.message });
  }
});

// Update SPN
router.put("/:id", requireRole("admin"), async (req, res) => {
  try {
    const payload = validateSpnPayload(req.body || {});

    // Check duplicate spn (exclude self)
    const existing = await SPN.findOne({
      _id: { $ne: req.params.id },
      spn: payload.spn,
    });
    if (existing) {
      return res.status(400).json({ message: "Duplicate SPN not allowed" });
    }

    const updated = await SPN.findByIdAndUpdate(req.params.id, payload, {
      new: true,
      runValidators: true,
    });
    if (!updated) {
      return res.status(404).json({ message: "SPN not found" });
    }
    return res.json(updated);
  } catch (err) {
    return res.status(400).json({ message: err.message });
  }
});

// Delete SPN
router.delete("/:id", requireRole("admin"), async (req, res) => {
  try {
    const deleted = await SPN.findByIdAndDelete(req.params.id);
    if (!deleted) {
      return res.status(404).json({ message: "SPN not found" });
    }
    return res.json({ success: true });
  } catch (err) {
    return res.status(400).json({ message: err.message });
  }
});

export default router;

