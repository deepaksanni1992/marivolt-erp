import express from "express";
import { requireErpAccess } from "../middleware/erpAccess.js";
import { requirePermission } from "../middleware/permissions.js";
import * as c from "../controllers/inventoryController.js";

const router = express.Router();

router.use(...requireErpAccess);
const storeView = requirePermission("STORE", "view");
const storeCreate = requirePermission("STORE", "create");
const storeApprove = requirePermission("STORE", "approve");

router.get("/balances", storeView, c.listBalances);
router.get("/balances/item/:itemCode", storeView, c.getBalance);
router.get("/ledger", storeView, c.listLedger);
router.post("/stock-in", storeCreate, c.postStockIn);
router.post("/stock-out", storeCreate, c.postStockOut);
router.post("/adjust", storeApprove, c.postAdjustment);
router.post("/opening", storeApprove, c.postOpening);

export default router;
