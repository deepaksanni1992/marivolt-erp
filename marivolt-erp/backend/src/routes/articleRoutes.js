import express from "express";
import Article from "../models/Article.js";
import Material from "../models/Material.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { validateArticlePayload } from "../validation/itemMasterValidation.js";
import { DEFAULT_PAGE_SIZE } from "../constants/masterValues.js";

const router = express.Router();

router.use(requireAuth);

// Create article
router.post("/", requireRole("admin"), async (req, res) => {
  try {
    const payload = validateArticlePayload(req.body || {});

    const materialExists = await Material.exists({
      materialCode: payload.materialCode,
    });
    if (!materialExists) {
      return res
        .status(400)
        .json({ message: "Invalid materialCode reference in article master" });
    }

    const duplicate = await Article.findOne({
      articleNo: payload.articleNo,
    });
    if (duplicate) {
      return res.status(400).json({ message: "Duplicate articleNo not allowed" });
    }

    const doc = await Article.create(payload);
    return res.status(201).json(doc);
  } catch (err) {
    return res.status(400).json({ message: err.message });
  }
});

// List articles
router.get("/", async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page || "1", 10), 1);
    const limit = Math.min(
      Math.max(parseInt(req.query.limit || DEFAULT_PAGE_SIZE, 10), 1),
      200
    );
    const search = String(req.query.search || "").trim();
    const materialCode = String(req.query.materialCode || "").trim();
    const status = String(req.query.status || "").trim();

    const query = {};
    if (search) {
      query.$or = [
        { articleNo: { $regex: search, $options: "i" } },
        { description: { $regex: search, $options: "i" } },
      ];
    }
    if (materialCode) query.materialCode = materialCode;
    if (status) query.status = status;

    const [items, total] = await Promise.all([
      Article.find(query)
        .sort({ articleNo: 1 })
        .skip((page - 1) * limit)
        .limit(limit),
      Article.countDocuments(query),
    ]);

    return res.json({
      items,
      pagination: { page, limit, total },
    });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
});

// Get by id
router.get("/:id", async (req, res) => {
  try {
    const article = await Article.findById(req.params.id);
    if (!article) {
      return res.status(404).json({ message: "Article not found" });
    }
    return res.json(article);
  } catch (err) {
    return res.status(400).json({ message: err.message });
  }
});

// Update article
router.put("/:id", requireRole("admin"), async (req, res) => {
  try {
    const payload = validateArticlePayload(req.body || {});

    const materialExists = await Material.exists({
      materialCode: payload.materialCode,
    });
    if (!materialExists) {
      return res
        .status(400)
        .json({ message: "Invalid materialCode reference in article master" });
    }

    const duplicate = await Article.findOne({
      _id: { $ne: req.params.id },
      articleNo: payload.articleNo,
    });
    if (duplicate) {
      return res.status(400).json({ message: "Duplicate articleNo not allowed" });
    }

    const updated = await Article.findByIdAndUpdate(req.params.id, payload, {
      new: true,
      runValidators: true,
    });
    if (!updated) {
      return res.status(404).json({ message: "Article not found" });
    }
    return res.json(updated);
  } catch (err) {
    return res.status(400).json({ message: err.message });
  }
});

// Delete article
router.delete("/:id", requireRole("admin"), async (req, res) => {
  try {
    const deleted = await Article.findByIdAndDelete(req.params.id);
    if (!deleted) {
      return res.status(404).json({ message: "Article not found" });
    }
    return res.json({ success: true });
  } catch (err) {
    return res.status(400).json({ message: err.message });
  }
});

export default router;

