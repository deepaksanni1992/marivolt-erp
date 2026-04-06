import express from "express";
import MaterialSupplier from "../models/MaterialSupplier.js";
import Material from "../models/Material.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { validateMaterialSupplierPayload } from "../validation/masterDataValidation.js";
import { DEFAULT_PAGE_SIZE } from "../constants/masterValues.js";

const router = express.Router();

router.use(requireAuth);

// Create supplier mapping
router.post("/", requireRole("admin"), async (req, res) => {
  try {
    const payload = validateMaterialSupplierPayload(req.body || {});

    const materialExists = await Material.exists({
      materialCode: payload.materialCode,
    });
    if (!materialExists) {
      return res.status(400).json({
        message:
          "Invalid materialCode reference in supplier mapping",
      });
    }

    const doc = await MaterialSupplier.create(payload);
    return res.status(201).json(doc);
  } catch (err) {
    return res.status(400).json({ message: err.message });
  }
});

// List supplier mappings
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
    if (materialCode) query.materialCode = materialCode;
    if (status) query.status = status;

    if (search) {
      query.$or = [
        { supplierName: { $regex: search, $options: "i" } },
        { supplierArticleNo: { $regex: search, $options: "i" } },
      ];
    }

    const [items, total] = await Promise.all([
      MaterialSupplier.find(query)
        .sort({ materialCode: 1, supplierName: 1 })
        .skip((page - 1) * limit)
        .limit(limit),
      MaterialSupplier.countDocuments(query),
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
    const row = await MaterialSupplier.findById(req.params.id);
    if (!row) {
      return res
        .status(404)
        .json({ message: "Supplier mapping not found" });
    }
    return res.json(row);
  } catch (err) {
    return res.status(400).json({ message: err.message });
  }
});

// Update supplier mapping
router.put("/:id", requireRole("admin"), async (req, res) => {
  try {
    const payload = validateMaterialSupplierPayload(req.body || {});

    const materialExists = await Material.exists({
      materialCode: payload.materialCode,
    });
    if (!materialExists) {
      return res.status(400).json({
        message:
          "Invalid materialCode reference in supplier mapping",
      });
    }

    const updated = await MaterialSupplier.findByIdAndUpdate(
      req.params.id,
      payload,
      { new: true, runValidators: true }
    );
    if (!updated) {
      return res
        .status(404)
        .json({ message: "Supplier mapping not found" });
    }
    return res.json(updated);
  } catch (err) {
    return res.status(400).json({ message: err.message });
  }
});

// Delete supplier mapping
router.delete("/:id", requireRole("admin"), async (req, res) => {
  try {
    const deleted = await MaterialSupplier.findByIdAndDelete(
      req.params.id
    );
    if (!deleted) {
      return res
        .status(404)
        .json({ message: "Supplier mapping not found" });
    }
    return res.json({ success: true });
  } catch (err) {
    return res.status(400).json({ message: err.message });
  }
});

export default router;

