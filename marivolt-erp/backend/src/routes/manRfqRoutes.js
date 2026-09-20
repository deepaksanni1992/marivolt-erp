import express from "express";
import multer from "multer";
import { requireErpAccess } from "../middleware/erpAccess.js";
import { requirePermission } from "../middleware/permissions.js";
import * as c from "../controllers/manRfqController.js";

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

router.use(...requireErpAccess);
const salesCreate = requirePermission("SALES", "create");

router.get("/models", salesCreate, c.listModels);
router.get("/items/:article", salesCreate, c.itemSnapshot);
router.post("/match", salesCreate, upload.single("file"), c.match);
router.post("/availability", salesCreate, c.availability);
router.post("/quotations", salesCreate, c.createQuotation);

export default router;
