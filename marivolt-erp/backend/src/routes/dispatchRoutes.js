/**
 * INTERNAL StoreDispatch HTTP surface (P0.5B stock posting).
 * S2 — User workflow must use /api/sales/sales-dispatches only.
 * These routes remain for internal/tooling compatibility; UI must not expose them.
 */
import express from "express";
import { requireErpAccess } from "../middleware/erpAccess.js";
import { requirePermission, denyRoles } from "../middleware/permissions.js";
import * as c from "../controllers/storeOutboundController.js";

const router = express.Router();
router.use(...requireErpAccess);
const storeView = requirePermission("STORE", "view");
const storeCreate = requirePermission("STORE", "create");
const storeApprove = requirePermission("STORE", "approve");
const storeCancel = requirePermission("STORE", "cancel");
const denyOperator = denyRoles("STORE_OPERATOR");

router.get("/", storeView, c.listStoreDispatch);
router.get("/packings/pending", storeView, c.listPendingDispatchPackings);
router.get("/invoices/pending", storeView, c.listPendingDispatchInvoices);
router.get("/from-invoice/:invoiceId", storeView, c.getDispatchFromInvoice);
router.get("/from-packing/:packingId", storeView, c.getDispatchFromPacking);
router.get("/:id", storeView, c.getStoreDispatch);
router.post("/draft", denyOperator, storeCreate, c.createStoreDispatchDraft);
router.post("/:id/post", denyOperator, storeApprove, c.postStoreDispatch);
router.post("/:id/cancel", denyOperator, storeCancel, c.cancelStoreDispatch);

export default router;
