import express from "express";
import { requireErpAccess } from "../middleware/erpAccess.js";
import * as c from "../controllers/inventoryController.js";

const router = express.Router();

router.use(...requireErpAccess);

router.get("/balances", c.listBalances);
router.get("/balances/item/:itemCode", c.getBalance);
router.get("/ledger", c.listLedger);
router.post("/stock-in", c.postStockIn);
router.post("/stock-out", c.postStockOut);
router.post("/adjust", c.postAdjustment);
router.post("/opening", c.postOpening);

export default router;
