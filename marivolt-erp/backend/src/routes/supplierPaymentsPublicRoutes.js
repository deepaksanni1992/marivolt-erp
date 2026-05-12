import express from "express";
import { requireErpAccess } from "../middleware/erpAccess.js";
import { requirePermission } from "../middleware/permissions.js";
import * as c from "../controllers/accountsController.js";

const router = express.Router();
router.use(...requireErpAccess);
const accountsView = requirePermission("ACCOUNTS", "view");
const accountsCreate = requirePermission("ACCOUNTS", "create");
const accountsEdit = requirePermission("ACCOUNTS", "edit");

router.get("/", accountsView, c.listSupplierPayments);
router.post("/", accountsCreate, c.createSupplierPayment);
router.get("/:id", accountsView, c.getSupplierPayment);
router.post("/:id/post", accountsEdit, c.postDraftSupplierPayment);
router.post("/:id/cancel", accountsEdit, c.cancelSupplierPayment);

export default router;
