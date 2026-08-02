import express from "express";
import { requireErpAccess } from "../middleware/erpAccess.js";
import { requirePermission, requireAnyPermission } from "../middleware/permissions.js";
import { requirePrintAgent } from "../middleware/printAgentAuth.js";
import * as c from "../controllers/labelController.js";
import * as agent from "../controllers/labelAgentController.js";

const router = express.Router();

const labelsView = requirePermission("LABELS", "view");
const labelsPrint = requirePermission("LABELS", "print");
const labelsReprint = requirePermission("LABELS", "reprint");
const labelsAdmin = requirePermission("LABELS", "admin");
const labelsSettingsWrite = requireAnyPermission(
  ["LABELS", "admin"],
  ["LABELS", "print"],
  ["SETTINGS", "edit"]
);

/** Agent routes — no user JWT */
router.post("/agent/heartbeat", requirePrintAgent, agent.heartbeat);
router.post("/agent/lease", requirePrintAgent, agent.lease);
router.post("/agent/jobs/:id/printing", requirePrintAgent, agent.printing);
router.post("/agent/jobs/:id/result", requirePrintAgent, agent.result);

/** ERP routes */
router.use(...requireErpAccess);

router.get("/settings", labelsView, c.getSettings);
router.put("/settings", labelsSettingsWrite, c.putSettings);
// Allow STORE print users to read settings; also allow SETTINGS.edit holders via admin matrix
router.get("/printers", labelsView, c.listPrinters);
router.post("/printers", labelsAdmin, c.upsertPrinter);
router.get("/templates", labelsView, c.listTemplates);
router.get("/agents", labelsAdmin, c.listAgents);
router.post("/agents", labelsAdmin, c.registerAgent);

router.post("/jobs/from-grn", labelsPrint, c.createFromGrn);
router.post("/jobs/stock-reprint", labelsReprint, c.stockReprint);
router.get("/jobs", labelsView, c.listJobs);
router.get("/jobs/:id", labelsView, c.getJob);
router.get("/jobs/:id/preview", labelsView, c.previewJob);
router.get("/jobs/:id/history", labelsView, c.jobHistory);
router.post("/jobs/:id/retry", labelsPrint, c.retryJob);
router.post("/jobs/:id/confirm-partial", labelsPrint, c.confirmPartial);
router.post("/jobs/:id/resolve-uncertain", labelsPrint, c.resolveUncertain);
router.post("/jobs/:id/cancel", labelsPrint, c.cancelJob);
router.post("/jobs/:id/reprint", labelsReprint, c.reprintJob);

export default router;
