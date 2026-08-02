import express from "express";
import { requireErpAccess } from "../middleware/erpAccess.js";
import { requirePermission } from "../middleware/permissions.js";
import * as c from "../controllers/grnController.js";

const router = express.Router();
router.use(...requireErpAccess);
const storeView = requirePermission("STORE", "view");
const storeCreate = requirePermission("STORE", "create");
const storeEdit = requirePermission("STORE", "edit");
const storeApprove = requirePermission("STORE", "approve");
const storeCancel = requirePermission("STORE", "cancel");
const storeDelete = requirePermission("STORE", "delete");

router.post("/", storeCreate, c.createGrn);
router.post("/draft", storeCreate, c.createGrn);
router.get("/", storeView, c.listGrn);
router.get("/csv-template", storeView, c.getGrnCsvTemplate);
router.post("/import-preview", storeCreate, c.importGrnCsvPreview);
router.post("/post", storeApprove, c.postGrnFromPo);
router.get("/reports/summary", storeView, c.getGrnSummaryReport);
router.get("/reports/supplier-receiving", storeView, c.getSupplierReceivingReport);
router.get("/reports/pending-po", storeView, c.getPendingPoGrnReport);
router.get("/eligible-purchase-orders", storeView, c.listEligiblePurchaseOrdersForGrn);
router.get("/from-po/:poId", storeView, c.getGrnFromPo);
router.delete("/id/:id/draft", storeDelete, c.deleteGrnDraft);
router.get("/id/:id", storeView, c.getGrnByMongoId);
router.post("/id/:id/post", storeApprove, c.postGrnByMongoId);
router.get("/:grnNo", storeView, c.getGrn);
router.put("/:grnNo", storeEdit, c.updateGrn);
router.post("/:grnNo/post", storeApprove, c.postGrn);
router.post("/:grnNo/receive", storeApprove, c.postGrn);
router.post("/:grnNo/cancel", storeCancel, c.cancelGrn);
router.post("/:grnNo/close", storeEdit, c.closeGrn);

export default router;
