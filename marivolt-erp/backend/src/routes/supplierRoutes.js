import express from "express";
import { requireErpAccess } from "../middleware/erpAccess.js";
import * as c from "../controllers/supplierController.js";

const router = express.Router();

router.use(...requireErpAccess);

router.get("/all", c.listSuppliersAll);
router.get("/", c.listSuppliers);
router.post("/import", c.importSuppliers);
router.get("/:id", c.getSupplier);
router.post("/", c.createSupplier);
router.put("/:id", c.updateSupplier);
router.delete("/:id", c.deleteSupplier);

export default router;
