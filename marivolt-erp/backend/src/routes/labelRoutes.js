import express from "express";
import { requireErpAccess } from "../middleware/erpAccess.js";
import { requirePermission, requireAnyPermission, requireAllPermissions } from "../middleware/permissions.js";
import { requirePrintAgent } from "../middleware/printAgentAuth.js";
import { createRateLimiter } from "../middleware/rateLimit.js";
import * as c from "../controllers/labelController.js";
import * as agent from "../controllers/labelAgentController.js";

const router = express.Router();

const labelsView = requirePermission("LABELS", "view");
const labelsPrint = requirePermission("LABELS", "print");
const labelsReprint = requirePermission("LABELS", "reprint");
const labelsAdmin = requirePermission("LABELS", "admin");
const asnLabelPrint = requireAllPermissions(["ASN", "view"], ["LABELS", "print"]);
const asnLabelView = requireAllPermissions(["ASN", "view"], ["LABELS", "view"]);
const labelsSettingsWrite = requireAnyPermission(
  ["LABELS", "admin"],
  ["SETTINGS", "edit"]
);

const agentRateLimit = createRateLimiter({
  name: "label-agent",
  windowMs: 60_000,
  max: Number(process.env.LABEL_AGENT_RATE_LIMIT_MAX) || 120,
  keyFn: (req) =>
    `${req.headers["x-print-agent-id"] || req.ip || "unknown"}`.toLowerCase().slice(0, 120),
});

const bootstrapRateLimit = createRateLimiter({
  name: "label-agent-bootstrap",
  windowMs: 60_000,
  max: Number(process.env.LABEL_AGENT_BOOTSTRAP_RATE_LIMIT_MAX) || 10,
  keyFn: (req) => `${req.ip || "unknown"}`.toLowerCase().slice(0, 120),
});

const testPrintRateLimit = createRateLimiter({
  name: "label-test-print",
  windowMs: 60_000,
  max: Number(process.env.LABEL_TEST_PRINT_RATE_LIMIT_MAX) || 10,
  keyFn: (req) => `${req.user?.id || req.ip || "unknown"}`.toLowerCase().slice(0, 120),
});

/** Agent routes — no user JWT; rate-limited */
router.post("/agent/bootstrap", bootstrapRateLimit, agent.bootstrap);
router.post("/agent/heartbeat", agentRateLimit, requirePrintAgent, agent.heartbeat);
router.post("/agent/lease", agentRateLimit, requirePrintAgent, agent.lease);
router.post("/agent/jobs/:id/printing", agentRateLimit, requirePrintAgent, agent.printing);
router.post("/agent/jobs/:id/result", agentRateLimit, requirePrintAgent, agent.result);

/** ERP routes */
router.use(...requireErpAccess);

router.get("/settings", labelsView, c.getSettings);
router.put("/settings", labelsSettingsWrite, c.putSettings);
router.get("/printers", labelsView, c.listPrinters);
router.post("/printers", labelsAdmin, c.upsertPrinter);
router.post("/printers/:id/disable", labelsAdmin, c.disablePrinter);
router.post("/printers/:id/enable", labelsAdmin, c.enablePrinter);
router.post("/printers/:id/delete", labelsAdmin, c.deletePrinter);
router.post("/printers/:id/test-print", labelsAdmin, testPrintRateLimit, (req, res) => {
  req.body = { ...(req.body || {}), printerCode: req.params.id };
  return c.testPrint(req, res);
});
router.get("/templates", labelsView, c.listTemplates);
router.get("/agents", labelsAdmin, c.listAgents);
router.post("/agents", labelsAdmin, c.registerAgent);
router.get("/agents/:id", labelsAdmin, c.getAgent);
router.put("/agents/:id", labelsAdmin, c.updateAgent);
router.post("/agents/:id/disable", labelsAdmin, c.disableAgent);
router.post("/agents/:id/enable", labelsAdmin, c.enableAgent);
router.post("/agents/:id/rotate-secret", labelsAdmin, c.rotateAgentSecret);
router.post("/agents/:id/test-connection", labelsAdmin, c.testConnection);
router.post("/agents/:id/test-print", labelsAdmin, testPrintRateLimit, (req, res) => {
  req.body = { ...(req.body || {}), agentId: req.params.id };
  return c.testPrint(req, res);
});
router.post("/test-print", labelsAdmin, testPrintRateLimit, c.testPrint);

router.post("/jobs/from-grn", labelsPrint, c.createFromGrn);
router.post("/jobs/from-grn-prepost", labelsPrint, c.createFromGrnPrepost);
router.post("/jobs/from-grn-prepost/preview", labelsView, c.previewFromGrnPrepost);
router.post("/jobs/link-grn-prepost", labelsPrint, c.linkGrnPrepost);
router.post("/jobs/from-packing", labelsPrint, c.createFromPacking);
router.post("/jobs/from-packing/preview", labelsView, c.previewFromPacking);
router.post("/jobs/from-custom-packing", labelsPrint, c.createFromCustomPacking);
router.post("/jobs/from-custom-packing/preview", labelsView, c.previewFromCustomPacking);
router.post("/jobs/from-asn", asnLabelPrint, c.createFromAsn);
router.post("/jobs/from-asn/preview", asnLabelView, c.previewFromAsn);
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
