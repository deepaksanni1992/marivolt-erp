import express from "express";
import { requireErpAccess } from "../middleware/erpAccess.js";
import { requirePermission } from "../middleware/permissions.js";
import * as c from "../controllers/accountsController.js";

const router = express.Router();
router.use(...requireErpAccess);
const accountsView = requirePermission("ACCOUNTS", "view");

router.get("/:supplierId", accountsView, c.listSupplierLedgerBySupplierId);

export default router;
