import express from "express";
import { requireErpAccess } from "../middleware/erpAccess.js";
import { requirePermission } from "../middleware/permissions.js";
import * as c from "../controllers/documentSnapshotController.js";

const router = express.Router();

router.use(...requireErpAccess);
const salesView = requirePermission("SALES", "view");

router.get("/routes", salesView, c.listSnapshotRoutes);
router.get("/chain/:documentType/:id", salesView, c.getDocumentChain);
router.get("/working-copy/:sourceType/:sourceId/:destinationType", salesView, c.getWorkingCopy);

export default router;
