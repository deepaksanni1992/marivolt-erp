import express from "express";
import { requireErpAccess } from "../middleware/erpAccess.js";
import { requirePermission } from "../middleware/permissions.js";
import * as c from "../controllers/dekittingController.js";

const router = express.Router();

router.use(...requireErpAccess);
const itemView = requirePermission("ITEM_MASTER", "view");
const itemCreate = requirePermission("ITEM_MASTER", "create");
const itemApprove = requirePermission("ITEM_MASTER", "approve");
const itemCancel = requirePermission("ITEM_MASTER", "cancel");

router.get("/", itemView, c.listDeKittingOrders);
router.get("/reports/dekit", itemView, c.dekittingReport);
router.get("/:id", itemView, c.getDeKittingOrder);
router.post("/", itemCreate, c.createDeKittingOrder);
router.post("/:id/execute", itemApprove, c.executeDeKittingOrder);
router.post("/:id/cancel", itemCancel, c.cancelDeKittingOrder);

export default router;
