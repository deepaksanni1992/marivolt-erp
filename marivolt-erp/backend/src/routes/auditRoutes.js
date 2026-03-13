import express from "express";
import AuditLog from "../models/AuditLog.js";
import { requireAuth, requireRole } from "../middleware/auth.js";

const router = express.Router();

router.use(requireAuth);
router.use(requireRole("admin"));

router.get("/", async (req, res) => {
  try {
    const { from, to, userId, entityType, action } = req.query || {};
    const filter = {};

    if (from || to) {
      filter.createdAt = {};
      if (from) filter.createdAt.$gte = new Date(from);
      if (to) filter.createdAt.$lte = new Date(to);
    }
    if (userId) filter.userId = userId;
    if (entityType) filter.entityType = entityType;
    if (action) filter.action = action;

    const logs = await AuditLog.find(filter)
      .sort({ createdAt: -1 })
      .limit(500);

    res.json(logs);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

export default router;

