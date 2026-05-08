import express from "express";
import { requireErpAccess } from "../middleware/erpAccess.js";
import { requirePermission } from "../middleware/permissions.js";
import * as c from "../controllers/purchaseReturnController.js";

const router = express.Router();

router.use(...requireErpAccess);
const purchaseView = requirePermission("PURCHASE", "view");
const purchaseCreate = requirePermission("PURCHASE", "create");
const purchaseEdit = requirePermission("PURCHASE", "edit");
const purchaseApprove = requirePermission("PURCHASE", "approve");
const purchaseDelete = requirePermission("PURCHASE", "delete");

router.get("/", purchaseView, c.listPurchaseReturns);
router.get("/:id", purchaseView, c.getPurchaseReturn);
router.post("/", purchaseCreate, c.createPurchaseReturn);
router.put("/:id", purchaseEdit, c.updatePurchaseReturn);
router.post("/:id/post", purchaseApprove, c.postPurchaseReturn);
router.delete("/:id", purchaseDelete, c.deletePurchaseReturn);

export default router;
