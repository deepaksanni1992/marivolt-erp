import express from "express";
import { requireErpAccess } from "../middleware/erpAccess.js";
import { requirePermission, denyRoles } from "../middleware/permissions.js";
import * as c from "../controllers/stockController.js";

const router = express.Router();
router.use(...requireErpAccess);
const storeView = requirePermission("STORE", "view");
const storeCreate = requirePermission("STORE", "create");
const storeEdit = requirePermission("STORE", "edit");
const storeApprove = requirePermission("STORE", "approve");
const storeDelete = requirePermission("STORE", "delete");
/** STORE_OPERATOR shares STORE.create for GRN/packing — block inventory mutations. */
const denyOperator = denyRoles("STORE_OPERATOR");

router.get("/meta", storeView, c.stockMeta);
router.get("/view", storeView, c.listStockSummary);
router.get("/summary", storeView, c.listStockSummary);
router.get("/balance", storeView, c.listStockBalance);
router.get("/customer-allocations", storeView, c.listCustomerAllocationsForArticle);
router.get("/negative-allocations", storeView, c.reportNegativeAllocations);
router.get("/balance/:article", storeView, c.getBalanceByArticle);
router.get("/ledger", storeView, c.listStockLedger);
router.get("/ledger/unified", storeView, c.listUnifiedStockLedger);
router.get("/ledger/:article", storeView, c.getStockLedgerByArticle);
router.post("/adjustment", denyOperator, storeCreate, c.createAdjustment);
router.post("/adjustment/:adjustmentNo/post", denyOperator, storeApprove, c.postAdjustment);
router.post("/transfer", denyOperator, storeCreate, c.createTransfer);
router.post("/transfer/:transferNo/post", denyOperator, storeApprove, c.postTransfer);
router.post("/locations", denyOperator, storeCreate, c.createLocation);
router.get("/locations", storeView, c.listLocations);
router.put("/locations/:locationCode", denyOperator, storeEdit, c.updateLocation);
router.delete("/locations/:locationCode", denyOperator, storeDelete, c.deleteLocation);
router.get("/landed-cost", storeView, c.listLandedCostAllocations);
router.post("/landed-cost", denyOperator, storeCreate, c.createLandedCostAllocation);
router.get("/landed-cost/:id", storeView, c.getLandedCostAllocation);
router.put("/landed-cost/:id", denyOperator, storeEdit, c.updateLandedCostAllocation);
router.post("/landed-cost/:id/apply", denyOperator, storeApprove, c.applyLandedCostAllocation);
router.post("/landed-cost/:id/cancel", denyOperator, storeApprove, c.cancelLandedCostAllocation);
router.get("/reports/landed-cost-summary", storeView, c.landedCostSummaryReport);
router.get("/reports/stock-valuation-adjustments", storeView, c.stockValuationAdjustmentReport);
router.get("/reports/grn-cost-analysis", storeView, c.grnCostAnalysisReport);

export default router;
