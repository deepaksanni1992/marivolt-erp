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

router.get("/", storeView, c.listStoreDispatch);
router.get("/packings/pending", storeView, c.listPendingDispatchPackings);
router.get("/invoices/pending", storeView, c.listPendingDispatchInvoices);
router.get("/from-invoice/:invoiceId", storeView, c.getDispatchFromInvoice);
router.get("/from-packing/:packingId", storeView, c.getDispatchFromPacking);
router.get("/:id", storeView, c.getStoreDispatch);
router.post("/draft", storeCreate, c.createStoreDispatchDraft);
router.post("/:id/post", storeApprove, c.postStoreDispatch);
router.post("/:id/cancel", storeCancel, c.cancelStoreDispatch);

export default router;
