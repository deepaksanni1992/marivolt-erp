import express from "express";
import { requireErpAccess } from "../middleware/erpAccess.js";
import { requirePermission } from "../middleware/permissions.js";
import * as c from "../controllers/dataHealthController.js";

const router = express.Router();
router.use(...requireErpAccess);

const reportsView = requirePermission("REPORTS", "view");

router.get("/", reportsView, c.getDataHealth);
router.post("/export-log", reportsView, c.logDataHealthExport);

export default router;
