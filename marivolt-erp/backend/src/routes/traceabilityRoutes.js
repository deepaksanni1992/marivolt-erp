import express from "express";
import { requireErpAccess } from "../middleware/erpAccess.js";
import { requirePermission } from "../middleware/permissions.js";
import * as c from "../controllers/traceabilityController.js";

const router = express.Router();
router.use(...requireErpAccess);

const traceView = requirePermission("TRACEABILITY", "article_view");
const traceExport = requirePermission("TRACEABILITY", "article_export");

router.get("/article", traceView, c.getArticleTraceability);
router.get("/article/export-meta", traceView, c.getArticleTraceabilityExportMeta);

export { traceExport };
export default router;
