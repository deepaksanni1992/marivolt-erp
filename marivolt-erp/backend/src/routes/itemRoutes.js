import express from "express";
import Item from "../models/Item.js";
import { requireAuth, requireRole } from "../middleware/auth.js";


const router = express.Router();

/* Create item */
router.post("/", requireAuth, requireRole("ADMIN"), async (req, res) => {
  try {
    const item = await Item.create(req.body);
    res.json(item);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

/* Get all items */
router.get("/", requireAuth, async (req, res) => {
  const items = await Item.find().sort({ createdAt: -1 });
  res.json(items);
});

/* Delete item */
router.delete("/:id", requireAuth, requireRole("ADMIN"), async (req, res) => {
  await Item.findByIdAndDelete(req.params.id);
  res.json({ success: true });
});

export default router;
