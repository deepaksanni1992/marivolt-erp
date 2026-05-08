import express from "express";
import { requireErpAccess } from "../middleware/erpAccess.js";
import { requirePermission } from "../middleware/permissions.js";
import * as c from "../controllers/supplierController.js";

const router = express.Router();

router.use(...requireErpAccess);
const purchaseView = requirePermission("PURCHASE", "view");
const purchaseCreate = requirePermission("PURCHASE", "create");
const purchaseEdit = requirePermission("PURCHASE", "edit");
const purchaseDelete = requirePermission("PURCHASE", "delete");

router.get("/all", purchaseView, c.listSuppliersAll);
router.get("/", purchaseView, c.listSuppliers);
router.post("/import", purchaseCreate, c.importSuppliers);
router.get("/:id", purchaseView, c.getSupplier);
router.post("/", purchaseCreate, c.createSupplier);
router.put("/:id", purchaseEdit, c.updateSupplier);
router.delete("/:id", purchaseDelete, c.deleteSupplier);

export default router;
