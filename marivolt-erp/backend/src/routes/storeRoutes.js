import express from "express";
import { requireErpAccess } from "../middleware/erpAccess.js";
import { requirePermission, denyRoles } from "../middleware/permissions.js";
import * as stock from "../controllers/stockController.js";
import * as outbound from "../controllers/storeOutboundController.js";

/**
 * Aggregates Store-module endpoints under the `/api/store` namespace.
 */
const router = express.Router();
router.use(...requireErpAccess);
const storeView = requirePermission("STORE", "view");
const denyOperator = denyRoles("STORE_OPERATOR");

router.get("/stock-ledger/unified", storeView, stock.listUnifiedStockLedger);
router.get("/stock-ledger", storeView, stock.listStockLedger);
router.get("/stock-summary", storeView, stock.listStockSummary);
router.get("/stock-balance", storeView, stock.listStockBalance);
router.get("/customer-allocations", storeView, stock.listCustomerAllocationsForArticle);
router.get("/negative-allocations", storeView, stock.reportNegativeAllocations);
router.get("/meta", storeView, stock.stockMeta);
router.get("/landed-cost", storeView, stock.listLandedCostAllocations);
router.post("/landed-cost", denyOperator, requirePermission("STORE", "create"), stock.createLandedCostAllocation);
router.get("/landed-cost/:id", storeView, stock.getLandedCostAllocation);
router.put("/landed-cost/:id", denyOperator, requirePermission("STORE", "edit"), stock.updateLandedCostAllocation);
router.post("/landed-cost/:id/apply", denyOperator, requirePermission("STORE", "approve"), stock.applyLandedCostAllocation);
router.post("/landed-cost/:id/cancel", denyOperator, requirePermission("STORE", "approve"), stock.cancelLandedCostAllocation);
router.get("/reports/landed-cost-summary", storeView, stock.landedCostSummaryReport);
router.get("/reports/stock-valuation-adjustments", storeView, stock.stockValuationAdjustmentReport);
router.get("/reports/grn-cost-analysis", storeView, stock.grnCostAnalysisReport);
router.get("/reports/packing-pending-dispatch", storeView, outbound.reportPackingPendingDispatch);
router.get("/reports/pending-packing", storeView, outbound.reportPendingPacking);
router.get("/reports/partially-packed", storeView, outbound.reportPackingByStatus);
router.get("/reports/fully-packed", storeView, outbound.reportPackingByStatus);
router.get("/reports/packed-not-invoiced", storeView, outbound.reportPackedNotInvoiced);
router.get("/reports/invoiced-not-dispatched", storeView, outbound.reportInvoicedNotDispatched);
router.get("/reports/pending-dispatch", storeView, outbound.reportInvoicedNotDispatched);
router.get("/reports/customer-invoice-pending-dispatch", storeView, outbound.reportCustomerInvoicePendingDispatch);
router.get("/reports/dispatch-summary", storeView, outbound.reportDispatchSummary);
router.get("/reports/dispatch-by-customer", storeView, outbound.reportDispatchByCustomer);
router.get("/reports/dispatch-by-article", storeView, outbound.reportDispatchByArticle);
router.get("/reports/packing-efficiency", storeView, outbound.reportPackingEfficiency);
router.get("/reports/daily-dispatch", storeView, outbound.reportDailyDispatch);

export default router;
