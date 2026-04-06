import express from "express";
import { requireErpAccess } from "../middleware/erpAccess.js";
import * as c from "../controllers/kittingController.js";

const router = express.Router();

router.use(...requireErpAccess);

router.get("/", c.listKittingOrders);
router.get("/:id", c.getKittingOrder);
router.post("/", c.createKittingOrder);
router.post("/:id/execute", c.executeKittingOrder);
router.post("/:id/cancel", c.cancelKittingOrder);

export default router;
