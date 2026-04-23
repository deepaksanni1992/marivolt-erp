import express from "express";
import { requireErpAccess } from "../middleware/erpAccess.js";
import * as c from "../controllers/salesController.js";

const router = express.Router();

router.use(...requireErpAccess);
router.get("/orders", c.listSalesOrders);
router.post("/orders", c.createSalesOrder);
router.get("/orders/:id", c.getSalesOrder);

export default router;
