import express from "express";
import { requireErpAccess } from "../middleware/erpAccess.js";
import * as c from "../controllers/logisticsController.js";

const router = express.Router();

router.use(...requireErpAccess);

router.get("/dashboard", c.getLogisticsDashboard);
router.get("/dispatches", c.listDispatches);
router.get("/dispatches/:dispatchId/packing-list", c.getPackingList);
router.get("/", c.listShipments);
router.get("/:id", c.getShipment);
router.post("/", c.createShipment);
router.put("/:id", c.updateShipment);
router.patch("/:id/tracking", c.addTrackingUpdate);
router.delete("/:id", c.deleteShipment);

export default router;
