import express from "express";
import { requireErpAccess } from "../middleware/erpAccess.js";
import { requirePermission } from "../middleware/permissions.js";
import * as c from "../controllers/logisticsController.js";

const router = express.Router();

router.use(...requireErpAccess);
const logisticsView = requirePermission("LOGISTICS", "view");
const logisticsCreate = requirePermission("LOGISTICS", "create");
const logisticsEdit = requirePermission("LOGISTICS", "edit");
const logisticsCancel = requirePermission("LOGISTICS", "cancel");
const logisticsExport = requirePermission("LOGISTICS", "export");
const reportsView = requirePermission("REPORTS", "view");

router.get("/dashboard", logisticsView, c.getLogisticsDashboard);
router.get("/dispatches", logisticsView, c.listDispatches);
router.get("/dispatches/:dispatchId/packing-list", logisticsExport, c.getPackingList);
router.get("/customer-tracking/:ref", logisticsView, c.getCustomerTracking);
router.get("/containers", logisticsView, c.listContainers);
router.post("/containers", logisticsCreate, c.createContainer);
router.get("/reports/shipment-summary", reportsView, c.getShipmentSummaryReport);
router.get("/reports/delivery-delay", reportsView, c.getDeliveryDelayReport);
router.get("/reports/container-utilization", reportsView, c.getContainerUtilizationReport);
router.get("/reports/pending-dispatch", reportsView, c.getPendingDispatchReport);
router.get("/reports/physical-dispatch-status", reportsView, c.getPhysicalDispatchStatusReport);
router.get("/reports/partially-dispatched", reportsView, (req, res) => c.getPhysicalDispatchStatusReport({ ...req, query: { ...(req.query || {}), status: "PARTIALLY_DISPATCHED" } }, res));
router.get("/reports/fully-dispatched", reportsView, (req, res) => c.getPhysicalDispatchStatusReport({ ...req, query: { ...(req.query || {}), status: "FULLY_DISPATCHED" } }, res));
router.get("/reports/awb-tracking", reportsView, c.getAwbTrackingReport);
router.get("/", logisticsView, c.listShipments);
router.get("/:id", logisticsView, c.getShipment);
router.post("/", logisticsCreate, c.createShipment);
router.put("/:id", logisticsEdit, c.updateShipment);
router.patch("/:id/tracking", logisticsEdit, c.addTrackingUpdate);
router.patch("/:id/export-documents", logisticsEdit, c.updateShipmentDocuments);
router.delete("/:id", logisticsCancel, c.deleteShipment);

export default router;
