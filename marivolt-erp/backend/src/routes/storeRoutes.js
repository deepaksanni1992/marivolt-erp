import express from "express";
import { requireErpAccess } from "../middleware/erpAccess.js";
import * as stock from "../controllers/stockController.js";

/**
 * Aggregates Store-module endpoints under the `/api/store` namespace.
 * Today this only exposes the unified stock ledger projection per the
 * Phase-3 spec; future Store-only endpoints (negative allocation report,
 * customer allocation drill-down etc.) can be re-mounted here as well so
 * the Store module never has to call `/api/stock` directly.
 */
const router = express.Router();
router.use(...requireErpAccess);

// GET /api/store/stock-ledger/unified — multi-source projection of
// StockLedger (GRN / Adjustment / Transfer / sales) and InventoryLedger
// (sales reservation / RTS / invoice / cancellation).
router.get("/stock-ledger/unified", stock.listUnifiedStockLedger);

// Convenience aliases so the Store frontend does not have to know about
// the legacy `/api/stock` namespace.
router.get("/stock-ledger", stock.listStockLedger);
router.get("/stock-balance", stock.listStockBalance);
router.get("/customer-allocations", stock.listCustomerAllocationsForArticle);
router.get("/negative-allocations", stock.reportNegativeAllocations);
router.get("/meta", stock.stockMeta);

export default router;
