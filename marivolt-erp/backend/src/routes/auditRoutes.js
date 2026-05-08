import express from "express";
import { requireErpAccess } from "../middleware/erpAccess.js";
import * as audit from "../controllers/auditLogController.js";

const router = express.Router();
router.use(...requireErpAccess);

// GET /api/audit-logs?module=...&action=...&documentNo=...
router.get("/", audit.listAuditLogs);

// GET /api/audit-logs/document/:documentNo
router.get("/document/:documentNo", audit.listDocumentAuditTrail);

export default router;
