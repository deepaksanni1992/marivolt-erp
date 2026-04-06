import express from "express";
import { requireErpAccess } from "../middleware/erpAccess.js";
import * as c from "../controllers/dekittingController.js";

const router = express.Router();

router.use(...requireErpAccess);

router.get("/", c.listDeKittingOrders);
router.get("/:id", c.getDeKittingOrder);
router.post("/", c.createDeKittingOrder);
router.post("/:id/execute", c.executeDeKittingOrder);
router.post("/:id/cancel", c.cancelDeKittingOrder);

export default router;
