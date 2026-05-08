import express from "express";
import { requireErpAccess } from "../middleware/erpAccess.js";
import { requirePermission } from "../middleware/permissions.js";
import * as c from "../controllers/purchaseController.js";

const router = express.Router();

router.use(...requireErpAccess);
const purchaseView = requirePermission("PURCHASE", "view");
const purchaseCreate = requirePermission("PURCHASE", "create");
const purchaseEdit = requirePermission("PURCHASE", "edit");
const purchaseApprove = requirePermission("PURCHASE", "approve");
const purchaseDelete = requirePermission("PURCHASE", "delete");
const reportsView = requirePermission("REPORTS", "view");

router.get("/reports/summary", reportsView, c.purchaseSummaryReport);
router.get("/reports/pending", reportsView, c.pendingPurchaseReport);
router.post("/import", purchaseCreate, c.importPurchaseOrders);
router.get("/", purchaseView, c.listPurchaseOrders);
router.get("/:id", purchaseView, c.getPurchaseOrder);
router.post("/", purchaseCreate, c.createPurchaseOrder);
router.put("/:id", purchaseEdit, c.updatePurchaseOrder);
router.patch("/:id/status", purchaseApprove, c.patchPurchaseStatus);
router.post("/:id/receive", purchaseApprove, c.receivePurchaseOrder);
router.delete("/:id", purchaseDelete, c.deletePurchaseOrder);

export default router;
