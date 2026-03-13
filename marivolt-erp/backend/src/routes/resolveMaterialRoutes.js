import express from "express";
import { requireAuth } from "../middleware/auth.js";
import { resolveMaterial } from "../services/resolveMaterialService.js";

const router = express.Router();

router.use(requireAuth);

// POST /api/resolve-material
router.post("/", async (req, res) => {
  try {
    const {
      spn,
      engineMake,
      engineModel,
      configuration,
      cylinderCount,
      esn,
    } = req.body || {};

    const result = await resolveMaterial({
      spn,
      engineMake,
      engineModel,
      configuration,
      cylinderCount,
      esn,
    });

    return res.json({ items: result });
  } catch (err) {
    return res.status(400).json({ message: err.message });
  }
});

export default router;

