import express from "express";
import { requireErpAccess } from "../middleware/erpAccess.js";
import * as c from "../controllers/purchaseController.js";

const router = express.Router();

router.use(...requireErpAccess);

router.get("/", c.listPurchaseOrders);
router.get("/:id", c.getPurchaseOrder);
router.post("/", c.createPurchaseOrder);
router.put("/:id", c.updatePurchaseOrder);
router.patch("/:id/status", c.patchPurchaseStatus);
router.post("/:id/receive", c.receivePurchaseOrder);
router.delete("/:id", c.deletePurchaseOrder);

export default router;
