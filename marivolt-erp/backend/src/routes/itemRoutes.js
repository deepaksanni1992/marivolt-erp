import express from "express";
import Item from "../models/Item.js";
import { requireAuth, requireRole } from "../middleware/auth.js";

const router = express.Router();

/**
 * CREATE item (ADMIN only)
 * POST /api/items
 */
router.post("/", requireAuth, requireRole("admin"), async (req, res) => {
  try {
    const item = await Item.create(req.body);
    return res.status(201).json(item);
  } catch (err) {
    return res.status(400).json({ message: err.message });
  }
});

/**
 * GET all items (any logged-in user)
 * GET /api/items
 */
router.get("/", requireAuth, async (req, res) => {
  try {
    const items = await Item.find().sort({ createdAt: -1 });
    return res.json(items);
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
});

/**
 * UPDATE item (ADMIN only)
 * PUT /api/items/:id
 */
router.put("/:id", requireAuth, requireRole("admin"), async (req, res) => {
  try {
    const updatedItem = await Item.findByIdAndUpdate(
      req.params.id,
      req.body,
      { new: true, runValidators: true } // ✅ return updated doc + validate schema
    );

    if (!updatedItem) {
      return res.status(404).json({ message: "Item not found" });
    }

    return res.json(updatedItem);
  } catch (err) {
    return res.status(400).json({ message: err.message });
  }
});

/**
 * DELETE item (ADMIN only)
 * DELETE /api/items/:id
 */
router.delete("/:id", requireAuth, requireRole("admin"), async (req, res) => {
  try {
    const deleted = await Item.findByIdAndDelete(req.params.id);

    if (!deleted) {
      return res.status(404).json({ message: "Item not found" });
    }

    return res.json({ success: true });
  } catch (err) {
    return res.status(400).json({ message: err.message });
  }
});

export default router;