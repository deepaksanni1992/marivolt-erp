import express from "express";
import mongoose from "mongoose";
import SPN from "../models/SPN.js";
import Material from "../models/Material.js";
import MaterialCompatibility from "../models/MaterialCompatibility.js";
import Article from "../models/Article.js";
import MaterialSupplier from "../models/MaterialSupplier.js";
import Vertical from "../models/Vertical.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import {
  validateSpnPayload,
  validateMaterialPayload,
  validateCompatibilityPayload,
  validateArticlePayload,
  validateMaterialSupplierPayload,
} from "../validation/itemMasterValidation.js";
import { createEmptyImportResult, pushRowError } from "../utils/importResultBuilder.js";
import { resolveBrandNameForMaterial } from "../utils/brandMaterialVertical.js";

const router = express.Router();

router.use(requireAuth);
router.use(requireRole("admin"));

async function handleBulkImport({ rows, validateFn, upsertFn }) {
  const result = createEmptyImportResult();
  result.totalRows = rows.length;

  const keyToFirstIndex = new Map();

  // First pass: detect duplicates within file
  for (let i = 0; i < rows.length; i++) {
    const raw = rows[i];
    try {
      const validated = validateFn(raw);
      const key = JSON.stringify(validated);
      if (keyToFirstIndex.has(key)) {
        result.duplicateRows += 1;
        pushRowError(result, i, "Duplicate row within uploaded file");
        continue;
      }
      keyToFirstIndex.set(key, i);
    } catch (err) {
      pushRowError(result, i, err.message);
    }
  }

  // Second pass: insert valid, non-duplicate rows (first occurrence only)
  for (let i = 0; i < rows.length; i++) {
    const raw = rows[i];
    try {
      const validated = validateFn(raw);
      const key = JSON.stringify(validated);
      if (!keyToFirstIndex.has(key) || keyToFirstIndex.get(key) !== i) {
        continue;
      }

      await upsertFn(validated);
      result.successRows += 1;
    } catch (err) {
      if (String(err.message || "").includes("duplicate")) {
        result.duplicateRows += 1;
      } else {
        result.failedRows += 1;
      }
      pushRowError(result, i, err.message || "Import failed");
    }
  }

  return result;
}

// ---- SPN bulk import ----
router.post("/spn", async (req, res) => {
  try {
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];

    const result = await handleBulkImport({
      rows,
      validateFn: validateSpnPayload,
      upsertFn: async (payload) => {
        if (!mongoose.Types.ObjectId.isValid(payload.vertical)) {
          throw new Error("Invalid vertical id");
        }
        const verticalExists = await Vertical.exists({ _id: payload.vertical });
        if (!verticalExists) {
          throw new Error("Vertical not found");
        }

        const existing = await SPN.findOne({ spn: payload.spn });
        if (existing) {
          await SPN.updateOne({ spn: payload.spn }, payload);
        } else {
          await SPN.create(payload);
        }
      },
    });

    return res.json(result);
  } catch (err) {
    return res.status(400).json({ message: err.message });
  }
});

// ---- Material bulk import ----
router.post("/materials", async (req, res) => {
  try {
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];

    const result = await handleBulkImport({
      rows,
      validateFn: validateMaterialPayload,
      upsertFn: async (payload) => {
        const spnDoc = await SPN.findOne({ spn: payload.spn }).select("vertical").lean();
        if (!spnDoc) {
          throw new Error("Invalid SPN reference in material master");
        }
        if (String(spnDoc.vertical) !== String(payload.vertical)) {
          throw new Error("Material vertical must match the selected SPN's vertical");
        }

        const existing = await Material.findOne({
          materialCode: payload.materialCode,
        });
        if (existing) {
          await Material.updateOne(
            { materialCode: payload.materialCode },
            payload
          );
        } else {
          await Material.create(payload);
        }
      },
    });

    return res.json(result);
  } catch (err) {
    return res.status(400).json({ message: err.message });
  }
});

// ---- Material compatibility bulk import ----
router.post("/material-compat", async (req, res) => {
  try {
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];

    const result = await handleBulkImport({
      rows,
      validateFn: validateCompatibilityPayload,
      upsertFn: async (payload) => {
        const canonicalBrand = await resolveBrandNameForMaterial(
          payload.materialCode,
          payload.brand
        );
        const toSave = { ...payload, brand: canonicalBrand };

        try {
          await MaterialCompatibility.create(toSave);
        } catch (err) {
          if (err.code === 11000) {
            throw new Error("Duplicate compatibility row");
          }
          throw err;
        }
      },
    });

    return res.json(result);
  } catch (err) {
    return res.status(400).json({ message: err.message });
  }
});

// ---- Article bulk import ----
router.post("/articles", async (req, res) => {
  try {
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];

    const result = await handleBulkImport({
      rows,
      validateFn: validateArticlePayload,
      upsertFn: async (payload) => {
        const materialExists = await Material.exists({
          materialCode: payload.materialCode,
        });
        if (!materialExists) {
          throw new Error("Invalid materialCode reference");
        }

        const existing = await Article.findOne({
          articleNo: payload.articleNo,
        });
        if (existing) {
          await Article.updateOne({ articleNo: payload.articleNo }, payload);
        } else {
          await Article.create(payload);
        }
      },
    });

    return res.json(result);
  } catch (err) {
    return res.status(400).json({ message: err.message });
  }
});

// ---- Supplier mapping bulk import ----
router.post("/material-suppliers", async (req, res) => {
  try {
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];

    const result = await handleBulkImport({
      rows,
      validateFn: validateMaterialSupplierPayload,
      upsertFn: async (payload) => {
        const materialExists = await Material.exists({
          materialCode: payload.materialCode,
        });
        if (!materialExists) {
          throw new Error("Invalid materialCode reference");
        }

        await MaterialSupplier.create(payload);
      },
    });

    return res.json(result);
  } catch (err) {
    return res.status(400).json({ message: err.message });
  }
});

export default router;

