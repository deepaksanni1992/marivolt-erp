import express from "express";
import { requireErpAccess } from "../middleware/erpAccess.js";
import { requirePermission } from "../middleware/permissions.js";
import * as c from "../controllers/communicationController.js";

const router = express.Router();

router.use(...requireErpAccess);

const reportsView = requirePermission("REPORTS", "view");
const reportsCreate = requirePermission("REPORTS", "create");
const reportsEdit = requirePermission("REPORTS", "edit");
const reportsApprove = requirePermission("REPORTS", "approve");

router.get("/threads", reportsView, c.listCommunicationThreads);
router.get("/threads/:id", reportsView, c.getCommunicationThread);
router.post("/threads", reportsCreate, c.createCommunicationThread);
router.post("/threads/:id/messages", reportsEdit, c.addCommunicationMessage);
router.post("/threads/:id/close", reportsEdit, c.closeCommunicationThread);
router.post("/threads/:id/status", reportsEdit, c.updateCommunicationThreadStatus);
router.post("/threads/:id/portal-ready", reportsApprove, c.markThreadPortalReady);

router.get("/templates", reportsView, c.listCommunicationTemplates);
router.post("/templates", reportsCreate, c.createCommunicationTemplate);
router.post("/templates/:id/use", reportsView, c.useCommunicationTemplate);

router.get("/approvals", reportsView, c.listDocumentApprovals);
router.post("/approvals", reportsCreate, c.createDocumentApproval);
router.post("/approvals/:id/decide", reportsApprove, c.decideDocumentApproval);

router.post("/portal/validate-token", reportsView, c.validatePortalAccessToken);
router.get("/portal/documents", reportsView, c.listPortalDocuments);
router.post("/portal/access-tokens", reportsApprove, c.createPortalAccessToken);

router.get("/reports/activity", reportsView, c.communicationActivityReport);
router.get("/reports/pending-approvals", reportsView, c.pendingApprovalsReport);
router.get("/reports/portal-access-log", reportsView, c.portalAccessLogReport);

export default router;

