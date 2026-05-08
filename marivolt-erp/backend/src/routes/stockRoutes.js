import express from "express";
import { requireErpAccess } from "../middleware/erpAccess.js";
import * as c from "../controllers/stockController.js";

const router = express.Router();
router.use(...requireErpAccess);

router.get("/meta", c.stockMeta);
router.get("/balance", c.listStockBalance);
router.get("/customer-allocations", c.listCustomerAllocationsForArticle);
router.get("/negative-allocations", c.reportNegativeAllocations);
router.get("/balance/:article", c.getBalanceByArticle);
router.get("/ledger", c.listStockLedger);
// Multi-source projection that merges StockLedger + InventoryLedger.
// Must be declared before the `:article` route so Express does not capture
// "unified" as an article parameter.
router.get("/ledger/unified", c.listUnifiedStockLedger);
router.get("/ledger/:article", c.getStockLedgerByArticle);
router.post("/adjustment", c.createAdjustment);
router.post("/adjustment/:adjustmentNo/post", c.postAdjustment);
router.post("/transfer", c.createTransfer);
router.post("/transfer/:transferNo/post", c.postTransfer);
router.post("/locations", c.createLocation);
router.get("/locations", c.listLocations);
router.put("/locations/:locationCode", c.updateLocation);
router.delete("/locations/:locationCode", c.deleteLocation);

export default router;
