import express from "express";
import { requireErpAccess } from "../middleware/erpAccess.js";
import * as c from "../controllers/logisticsController.js";

const router = express.Router();

router.use(...requireErpAccess);

router.get("/", c.listShipments);
router.get("/:id", c.getShipment);
router.post("/", c.createShipment);
router.put("/:id", c.updateShipment);
router.delete("/:id", c.deleteShipment);

export default router;
