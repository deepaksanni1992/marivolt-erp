import express from "express";
import { requireErpAccess } from "../middleware/erpAccess.js";
import { requirePermission } from "../middleware/permissions.js";
import * as audit from "../controllers/auditLogController.js";

const router = express.Router();
router.use(...requireErpAccess);
const auditView = requirePermission("AUDIT", "view");

// GET /api/audit-logs?module=...&action=...&documentNo=...
router.get("/", auditView, audit.listAuditLogs);

// GET /api/audit-logs/document/:documentNo
router.get("/document/:documentNo", auditView, audit.listDocumentAuditTrail);

export default router;
