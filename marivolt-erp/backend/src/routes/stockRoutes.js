import express from "express";
import { requireErpAccess } from "../middleware/erpAccess.js";
import { requirePermission } from "../middleware/permissions.js";
import * as c from "../controllers/stockController.js";

const router = express.Router();
router.use(...requireErpAccess);
const storeView = requirePermission("STORE", "view");
const storeCreate = requirePermission("STORE", "create");
const storeEdit = requirePermission("STORE", "edit");
const storeApprove = requirePermission("STORE", "approve");
const storeDelete = requirePermission("STORE", "delete");

router.get("/meta", storeView, c.stockMeta);
router.get("/view", storeView, c.listStockSummary);
router.get("/summary", storeView, c.listStockSummary);
router.get("/balance", storeView, c.listStockBalance);
router.get("/customer-allocations", storeView, c.listCustomerAllocationsForArticle);
router.get("/negative-allocations", storeView, c.reportNegativeAllocations);
router.get("/balance/:article", storeView, c.getBalanceByArticle);
router.get("/ledger", storeView, c.listStockLedger);
// Multi-source projection that merges StockLedger + InventoryLedger.
// Must be declared before the `:article` route so Express does not capture
// "unified" as an article parameter.
router.get("/ledger/unified", storeView, c.listUnifiedStockLedger);
router.get("/ledger/:article", storeView, c.getStockLedgerByArticle);
router.post("/adjustment", storeCreate, c.createAdjustment);
router.post("/adjustment/:adjustmentNo/post", storeApprove, c.postAdjustment);
router.post("/transfer", storeCreate, c.createTransfer);
router.post("/transfer/:transferNo/post", storeApprove, c.postTransfer);
router.post("/locations", storeCreate, c.createLocation);
router.get("/locations", storeView, c.listLocations);
router.put("/locations/:locationCode", storeEdit, c.updateLocation);
router.delete("/locations/:locationCode", storeDelete, c.deleteLocation);
router.get("/landed-cost", storeView, c.listLandedCostAllocations);
router.post("/landed-cost", storeCreate, c.createLandedCostAllocation);
router.get("/landed-cost/:id", storeView, c.getLandedCostAllocation);
router.put("/landed-cost/:id", storeEdit, c.updateLandedCostAllocation);
router.post("/landed-cost/:id/apply", storeApprove, c.applyLandedCostAllocation);
router.post("/landed-cost/:id/cancel", storeApprove, c.cancelLandedCostAllocation);
router.get("/reports/landed-cost-summary", storeView, c.landedCostSummaryReport);
router.get("/reports/stock-valuation-adjustments", storeView, c.stockValuationAdjustmentReport);
router.get("/reports/grn-cost-analysis", storeView, c.grnCostAnalysisReport);

export default router;
