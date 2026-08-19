import express from "express";
import { requireErpAccess } from "../middleware/erpAccess.js";
import { requirePermission, requireAllPermissions } from "../middleware/permissions.js";
import * as c from "../controllers/receivingInspectionController.js";

const router = express.Router();
router.use(...requireErpAccess);

const receivingView = requirePermission("ASN", "view");
const receivingMutate = requireAllPermissions(["ASN", "view"], ["STORE", "create"]);

router.get("/settings", receivingView, c.settings);
router.get("/scan/:barcode", receivingView, c.scan);
router.get("/asn/:asnId/session", receivingView, c.getSessionForAsn);
router.get("/asn/:asnId/progress", receivingView, c.asnProgress);

router.post("/sessions", receivingMutate, c.startSession);
router.get("/sessions/:sessionId", receivingView, c.getSession);
router.get("/sessions/:sessionId/summary", receivingView, c.summary);
router.post("/sessions/:sessionId/complete", receivingMutate, c.completeSession);
router.patch("/sessions/:sessionId/units/:ruId", receivingMutate, c.saveDraft);
router.post("/sessions/:sessionId/units/:ruId/complete", receivingMutate, c.completeUnit);
router.post(
  "/sessions/:sessionId/units/:ruId/photos",
  receivingMutate,
  c.receivingPhotoUploadMiddleware,
  c.uploadPhoto
);
router.delete("/sessions/:sessionId/photos/:photoId", receivingMutate, c.removePhoto);
router.get("/photos/:photoId/url", receivingView, c.photoUrl);

export default router;
