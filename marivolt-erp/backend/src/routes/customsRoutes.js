import express from "express";
import { requireErpAccess } from "../middleware/erpAccess.js";
import { requirePermission } from "../middleware/permissions.js";
import * as c from "../controllers/customsController.js";

const router = express.Router();
router.use(...requireErpAccess);

const customsView = requirePermission("CUSTOMS", "view");
const customsReconcile = requirePermission("CUSTOMS", "reconcile");

router.get("/status", customsView, c.getCustomsStatus);
router.get("/stock", customsView, c.getCustomsStock);
router.get("/ledger", customsView, c.getCustomsLedger);
router.get("/lots", customsView, c.listCustomsLots);
router.get("/movements", customsView, c.listCustomsMovements);
router.get("/reconciliation", customsReconcile, c.getCustomsReconciliation);

export default router;
