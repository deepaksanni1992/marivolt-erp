import express from "express";
import MaterialCompatibility from "../models/MaterialCompatibility.js";
import Material from "../models/Material.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { validateCompatibilityPayload } from "../validation/itemMasterValidation.js";
import { resolveBrandNameForMaterial } from "../utils/brandMaterialVertical.js";
import {
  DEFAULT_PAGE_SIZE,
} from "../constants/masterValues.js";

const router = express.Router();

router.use(requireAuth);

// Create compatibility row
router.post("/", requireRole("admin"), async (req, res) => {
  try {
    const payload = validateCompatibilityPayload(req.body || {});

    let canonicalBrand;
    try {
      canonicalBrand = await resolveBrandNameForMaterial(
        payload.materialCode,
        payload.brand
      );
    } catch (e) {
      return res.status(400).json({ message: e.message });
    }

    const toSave = { ...payload, brand: canonicalBrand };

    try {
      const doc = await MaterialCompatibility.create(toSave);
      return res.status(201).json(doc);
    } catch (err) {
      if (err.code === 11000) {
        return res.status(400).json({
          message: "Exact duplicate compatibility row not allowed",
        });
      }
      throw err;
    }
  } catch (err) {
    return res.status(400).json({ message: err.message });
  }
});

// List compatibility rows with filters
router.get("/", async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page || "1", 10), 1);
    const limit = Math.min(
      Math.max(parseInt(req.query.limit || DEFAULT_PAGE_SIZE, 10), 1),
      500
    );

    const materialCode = String(req.query.materialCode || "").trim();
    const brand =
      String(req.query.brand || req.query.engineMake || "").trim();
    const engineModel = String(req.query.engineModel || "").trim();
    const configuration = String(req.query.configuration || "").trim();
    const cylinderCount = String(req.query.cylinderCount || "").trim();
    const status = String(req.query.status || "").trim();

    const query = {};
    if (materialCode) query.materialCode = materialCode;
    if (brand) query.brand = brand;
    if (engineModel) query.engineModel = engineModel;
    if (configuration) query.configuration = configuration;
    if (cylinderCount) query.cylinderCount = cylinderCount;
    if (status) query.status = status;

    const [items, total] = await Promise.all([
      MaterialCompatibility.find(query)
        .sort({
          materialCode: 1,
          brand: 1,
          engineModel: 1,
          configuration: 1,
          cylinderCount: 1,
        })
        .skip((page - 1) * limit)
        .limit(limit),
      MaterialCompatibility.countDocuments(query),
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
    const row = await MaterialCompatibility.findById(req.params.id);
    if (!row) {
      return res
        .status(404)
        .json({ message: "Compatibility row not found" });
    }
    return res.json(row);
  } catch (err) {
    return res.status(400).json({ message: err.message });
  }
});

// Update compatibility row
router.put("/:id", requireRole("admin"), async (req, res) => {
  try {
    const payload = validateCompatibilityPayload(req.body || {});

    let canonicalBrand;
    try {
      canonicalBrand = await resolveBrandNameForMaterial(
        payload.materialCode,
        payload.brand
      );
    } catch (e) {
      return res.status(400).json({ message: e.message });
    }

    const toSave = { ...payload, brand: canonicalBrand };

    try {
      const updated = await MaterialCompatibility.findByIdAndUpdate(
        req.params.id,
        toSave,
        { new: true, runValidators: true }
      );
      if (!updated) {
        return res
          .status(404)
          .json({ message: "Compatibility row not found" });
      }
      return res.json(updated);
    } catch (err) {
      if (err.code === 11000) {
        return res.status(400).json({
          message: "Exact duplicate compatibility row not allowed",
        });
      }
      throw err;
    }
  } catch (err) {
    return res.status(400).json({ message: err.message });
  }
});

// Delete compatibility row
router.delete("/:id", requireRole("admin"), async (req, res) => {
  try {
    const deleted = await MaterialCompatibility.findByIdAndDelete(
      req.params.id
    );
    if (!deleted) {
      return res
        .status(404)
        .json({ message: "Compatibility row not found" });
    }
    return res.json({ success: true });
  } catch (err) {
    return res.status(400).json({ message: err.message });
  }
});

export default router;

