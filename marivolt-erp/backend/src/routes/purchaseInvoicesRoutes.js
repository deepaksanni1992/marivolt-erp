import express from "express";
import { requireErpAccess } from "../middleware/erpAccess.js";
import { requirePermission } from "../middleware/permissions.js";
import * as c from "../controllers/accountsController.js";

const router = express.Router();
router.use(...requireErpAccess);
const accountsView = requirePermission("ACCOUNTS", "view");
const accountsCreate = requirePermission("ACCOUNTS", "create");
const accountsEdit = requirePermission("ACCOUNTS", "edit");

router.get("/", accountsView, c.listPurchaseInvoices);
router.post("/from-po/:poId", accountsCreate, c.createPurchaseInvoiceDraftFromPo);
router.get("/:id", accountsView, c.getPurchaseInvoice);
router.post("/:id/book", accountsEdit, c.bookPurchaseInvoice);
router.post("/:id/cancel", accountsEdit, c.cancelPurchaseInvoice);

export default router;
