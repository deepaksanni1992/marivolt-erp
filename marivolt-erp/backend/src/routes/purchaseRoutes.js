import express from "express";
import { requireErpAccess } from "../middleware/erpAccess.js";
import { requirePermission } from "../middleware/permissions.js";
import * as c from "../controllers/purchaseController.js";
import * as pr from "../controllers/purchaseRequisitionController.js";

const router = express.Router();

router.use(...requireErpAccess);
const purchaseView = requirePermission("PURCHASE", "view");
const purchaseCreate = requirePermission("PURCHASE", "create");
const purchaseEdit = requirePermission("PURCHASE", "edit");
const purchaseApprove = requirePermission("PURCHASE", "approve");
const purchaseCancel = requirePermission("PURCHASE", "cancel");
const purchaseDelete = requirePermission("PURCHASE", "delete");
const purchaseExport = requirePermission("PURCHASE", "export");
const reportsView = requirePermission("REPORTS", "view");

router.get("/reports/summary", reportsView, c.purchaseSummaryReport);
router.get("/reports/pending", reportsView, c.pendingPurchaseReport);
router.get("/export", purchaseExport, c.listPurchaseOrders);

router.get("/requisitions", purchaseView, pr.listPurchaseRequisitions);
router.get("/requisitions/:id", purchaseView, pr.getPurchaseRequisition);
router.post("/requisitions", purchaseCreate, pr.createPurchaseRequisition);
router.put("/requisitions/:id", purchaseEdit, pr.updatePurchaseRequisition);
router.post("/requisitions/:id/submit", purchaseApprove, pr.submitPurchaseRequisition);
router.post("/requisitions/:id/approve", purchaseApprove, pr.approvePurchaseRequisition);
router.post("/requisitions/:id/reject", purchaseApprove, pr.rejectPurchaseRequisition);
router.post("/requisitions/:id/cancel", purchaseCancel, pr.cancelPurchaseRequisition);
router.post("/requisitions/:id/close", purchaseApprove, pr.closePurchaseRequisition);

router.post("/import", purchaseCreate, c.importPurchaseOrders);
router.get("/", purchaseView, c.listPurchaseOrders);
router.get("/:id", purchaseView, c.getPurchaseOrder);
router.post("/", purchaseCreate, c.createPurchaseOrder);
router.put("/:id", purchaseEdit, c.updatePurchaseOrder);
router.post("/:id/submit", purchaseApprove, c.submitPurchaseOrder);
router.post("/:id/approve", purchaseApprove, c.approvePurchaseOrder);
router.post("/:id/reject", purchaseApprove, c.rejectPurchaseOrder);
router.post("/:id/cancel", purchaseCancel, c.cancelPurchaseOrder);
router.patch("/:id/status", purchaseApprove, c.patchPurchaseStatus);
router.post("/:id/receive", purchaseApprove, c.receivePurchaseOrder);
router.delete("/:id", purchaseDelete, c.deletePurchaseOrder);

export default router;
