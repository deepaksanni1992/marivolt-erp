import express from "express";
import { requireErpAccess } from "../middleware/erpAccess.js";
import { requirePermission } from "../middleware/permissions.js";
import * as c from "../controllers/supplierProformaController.js";

const router = express.Router();

router.use(...requireErpAccess);

const purchaseView = requirePermission("PURCHASE", "view");
const purchaseCreate = requirePermission("PURCHASE", "create");
const purchaseEdit = requirePermission("PURCHASE", "edit");
const purchaseApprove = requirePermission("PURCHASE", "approve");
const purchaseCancel = requirePermission("PURCHASE", "cancel");

router.get("/", purchaseView, c.listSupplierProformas);
router.get("/:id", purchaseView, c.getSupplierProforma);
router.post("/", purchaseCreate, c.createSupplierProforma);
router.put("/:id", purchaseEdit, c.updateSupplierProforma);
router.post("/:id/receive", purchaseEdit, c.receiveSupplierProforma);
router.post("/:id/approve", purchaseApprove, c.approveSupplierProforma);
router.post("/:id/cancel", purchaseCancel, c.cancelSupplierProforma);

export default router;
