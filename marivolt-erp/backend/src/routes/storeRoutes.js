import express from "express";
import { requireErpAccess } from "../middleware/erpAccess.js";
import { requirePermission } from "../middleware/permissions.js";
import * as stock from "../controllers/stockController.js";
import * as outbound from "../controllers/storeOutboundController.js";

/**
 * Aggregates Store-module endpoints under the `/api/store` namespace.
 * Today this only exposes the unified stock ledger projection per the
 * Phase-3 spec; future Store-only endpoints (negative allocation report,
 * customer allocation drill-down etc.) can be re-mounted here as well so
 * the Store module never has to call `/api/stock` directly.
 */
const router = express.Router();
router.use(...requireErpAccess);
const storeView = requirePermission("STORE", "view");

// GET /api/store/stock-ledger/unified — multi-source projection of
// StockLedger (GRN / Adjustment / Transfer / sales) and InventoryLedger
// (sales reservation / RTS / invoice / cancellation).
router.get("/stock-ledger/unified", storeView, stock.listUnifiedStockLedger);

// Convenience aliases so the Store frontend does not have to know about
// the legacy `/api/stock` namespace.
router.get("/stock-ledger", storeView, stock.listStockLedger);
router.get("/stock-summary", storeView, stock.listStockSummary);
router.get("/stock-balance", storeView, stock.listStockBalance);
router.get("/customer-allocations", storeView, stock.listCustomerAllocationsForArticle);
router.get("/negative-allocations", storeView, stock.reportNegativeAllocations);
router.get("/meta", storeView, stock.stockMeta);
router.get("/landed-cost", storeView, stock.listLandedCostAllocations);
router.post("/landed-cost", requirePermission("STORE", "create"), stock.createLandedCostAllocation);
router.get("/landed-cost/:id", storeView, stock.getLandedCostAllocation);
router.put("/landed-cost/:id", requirePermission("STORE", "edit"), stock.updateLandedCostAllocation);
router.post("/landed-cost/:id/apply", requirePermission("STORE", "approve"), stock.applyLandedCostAllocation);
router.post("/landed-cost/:id/cancel", requirePermission("STORE", "approve"), stock.cancelLandedCostAllocation);
router.get("/reports/landed-cost-summary", storeView, stock.landedCostSummaryReport);
router.get("/reports/stock-valuation-adjustments", storeView, stock.stockValuationAdjustmentReport);
router.get("/reports/grn-cost-analysis", storeView, stock.grnCostAnalysisReport);
router.get("/reports/packing-pending-dispatch", storeView, outbound.reportPackingPendingDispatch);
router.get("/reports/pending-packing", storeView, outbound.reportPendingPacking);
router.get("/reports/dispatch-summary", storeView, outbound.reportDispatchSummary);
router.get("/reports/dispatch-by-customer", storeView, outbound.reportDispatchByCustomer);
router.get("/reports/dispatch-by-article", storeView, outbound.reportDispatchByArticle);
router.get("/reports/packing-efficiency", storeView, outbound.reportPackingEfficiency);
router.get("/reports/daily-dispatch", storeView, outbound.reportDailyDispatch);

export default router;
