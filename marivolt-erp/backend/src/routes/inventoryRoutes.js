import express from "express";
import { requireErpAccess } from "../middleware/erpAccess.js";
import { requirePermission, denyRoles } from "../middleware/permissions.js";
import * as c from "../controllers/inventoryController.js";

const router = express.Router();

router.use(...requireErpAccess);
const storeView = requirePermission("STORE", "view");
const storeCreate = requirePermission("STORE", "create");
const storeApprove = requirePermission("STORE", "approve");
const denyOperator = denyRoles("STORE_OPERATOR");

router.get("/balances", storeView, c.listBalances);
router.get("/balances/item/:itemCode", storeView, c.getBalance);
router.get("/ledger", storeView, c.listLedger);
router.post("/stock-in", denyOperator, storeCreate, c.postStockIn);
router.post("/stock-out", denyOperator, storeCreate, c.postStockOut);
router.post("/adjust", denyOperator, storeApprove, c.postAdjustment);
router.post("/opening", denyOperator, storeApprove, c.postOpening);

export default router;
