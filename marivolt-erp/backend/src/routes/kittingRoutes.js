import express from "express";
import { requireErpAccess } from "../middleware/erpAccess.js";
import { requirePermission } from "../middleware/permissions.js";
import * as c from "../controllers/kittingController.js";

const router = express.Router();

router.use(...requireErpAccess);
const itemView = requirePermission("ITEM_MASTER", "view");
const itemCreate = requirePermission("ITEM_MASTER", "create");
const itemApprove = requirePermission("ITEM_MASTER", "approve");
const itemCancel = requirePermission("ITEM_MASTER", "cancel");

router.get("/", itemView, c.listKittingOrders);
router.get("/reports/assembly-history", itemView, c.kittingAssemblyHistoryReport);
router.get("/reports/component-consumption", itemView, c.componentConsumptionReport);
router.get("/shortage-analysis", itemView, c.getKittingShortage);
router.get("/:id", itemView, c.getKittingOrder);
router.post("/", itemCreate, c.createKittingOrder);
router.post("/:id/execute", itemApprove, c.executeKittingOrder);
router.post("/:id/reverse", itemApprove, c.reverseKittingOrder);
router.post("/:id/cancel", itemCancel, c.cancelKittingOrder);

export default router;
