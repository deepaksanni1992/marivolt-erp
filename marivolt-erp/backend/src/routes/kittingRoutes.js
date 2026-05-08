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
router.get("/:id", itemView, c.getKittingOrder);
router.post("/", itemCreate, c.createKittingOrder);
router.post("/:id/execute", itemApprove, c.executeKittingOrder);
router.post("/:id/cancel", itemCancel, c.cancelKittingOrder);

export default router;
