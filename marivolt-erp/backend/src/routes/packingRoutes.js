import express from "express";
import { requireErpAccess } from "../middleware/erpAccess.js";
import { requirePermission } from "../middleware/permissions.js";
import * as c from "../controllers/storeOutboundController.js";

const router = express.Router();
router.use(...requireErpAccess);
const storeView = requirePermission("STORE", "view");
const storeCreate = requirePermission("STORE", "create");
const storeApprove = requirePermission("STORE", "approve");
const storeCancel = requirePermission("STORE", "cancel");

router.get("/", storeView, c.listStorePacking);
router.get("/allocations/pending", storeView, c.listPendingPackingAllocations);
router.get("/allocations/eligible", storeView, c.listEligibleAllocationsForPacking);
router.get("/from-allocation/:allocationId", storeView, c.getPackingFromAllocation);
router.get("/csv-template", storeView, c.getPackingCsvTemplate);
router.post("/import-preview", storeCreate, c.importPackingCsvPreview);
router.get("/:id", storeView, c.getStorePacking);
router.post("/draft", storeCreate, c.createStorePackingDraft);
router.post("/:id/post", storeApprove, c.postStorePacking);
router.post("/:id/cancel", storeCancel, c.cancelStorePacking);

export default router;
