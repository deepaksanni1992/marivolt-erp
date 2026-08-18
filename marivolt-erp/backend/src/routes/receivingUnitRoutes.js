import express from "express";
import { requireErpAccess } from "../middleware/erpAccess.js";
import { requirePermission } from "../middleware/permissions.js";
import * as c from "../controllers/receivingUnitController.js";

const router = express.Router();
router.use(...requireErpAccess);

const asnView = requirePermission("ASN", "view");

/** Company-scoped barcode lookup. Inactive/superseded RUs are returned with active:false. */
router.get("/by-barcode/:barcode", asnView, c.byBarcode);

export default router;
