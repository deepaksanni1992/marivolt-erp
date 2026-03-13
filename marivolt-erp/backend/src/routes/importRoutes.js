import express from "express";
import SPN from "../models/SPN.js";
import Material from "../models/Material.js";
import MaterialCompatibility from "../models/MaterialCompatibility.js";
import Article from "../models/Article.js";
import MaterialSupplier from "../models/MaterialSupplier.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import {
  validateSpnPayload,
  validateMaterialPayload,
  validateCompatibilityPayload,
  validateArticlePayload,
  validateMaterialSupplierPayload,
} from "../validation/itemMasterValidation.js";
import { createEmptyImportResult, pushRowError } from "../utils/importResultBuilder.js";

const router = express.Router();

router.use(requireAuth);
router.use(requireRole("admin"));

async function handleBulkImport({ rows, validateFn, upsertFn }) {
  const result = createEmptyImportResult();
  result.totalRows = rows.length;

  const seenKeys = new Set();

  // First pass: detect duplicates within file
  for (let i = 0; i < rows.length; i++) {
    const raw = rows[i];
    try {
      const validated = validateFn(raw);
      const key = JSON.stringify(validated);
      if (seenKeys.has(key)) {
        result.duplicateRows += 1;
        pushRowError(result, i, "Duplicate row within uploaded file");
        continue;
      }
      seenKeys.add(key);
    } catch (err) {
      pushRowError(result, i, err.message);
    }
  }

  // Second pass: insert valid, non-duplicate rows
  for (let i = 0; i < rows.length; i++) {
    const raw = rows[i];
    try {
      const validated = validateFn(raw);
      const key = JSON.stringify(validated);
      if (!seenKeys.has(key)) continue; // was error in first pass

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
        const existing = await SPN.findOne({ spn: payload.spn });
        if (existing) {
          // Update for idempotency
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
        const spnExists = await SPN.exists({ spn: payload.spn });
        if (!spnExists) {
          throw new Error("Invalid SPN reference in material master");
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
        const materialExists = await Material.exists({
          materialCode: payload.materialCode,
        });
        if (!materialExists) {
          throw new Error("Invalid materialCode reference");
        }

        try {
          await MaterialCompatibility.create(payload);
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

