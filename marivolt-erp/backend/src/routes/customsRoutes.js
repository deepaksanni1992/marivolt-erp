import express from "express";
import { requireErpAccess } from "../middleware/erpAccess.js";
import { requireAnyPermission, requirePermission } from "../middleware/permissions.js";
import * as c from "../controllers/customsController.js";
import * as ci from "../controllers/customsInvoiceController.js";

const router = express.Router();
router.use(...requireErpAccess);

const customsView = requirePermission("CUSTOMS", "view");
const customsCreate = requirePermission("CUSTOMS", "create");
const customsCancel = requirePermission("CUSTOMS", "cancel");
const customsReconciliationView = requireAnyPermission(
  ["CUSTOMS", "reconciliation_view"],
  ["CUSTOMS", "reconcile"],
);

router.get("/status", customsView, c.getCustomsStatus);
router.get("/dashboard", customsView, c.getCustomsDashboard);
router.post("/dashboard/export-log", customsView, c.logCustomsDashboardExport);
router.get("/stock", customsView, c.getCustomsStock);
router.get("/ledger", customsView, c.getCustomsLedger);
router.get("/available-lots", customsView, ci.listAvailableLots);
router.get("/reports/boe-balance", customsView, c.getBoeBalanceReport);
router.get("/reports/lot-balance", customsView, c.getLotBalanceReport);
router.get("/reports/consumption", customsView, c.getConsumptionReport);
router.get("/reports/traceability", customsView, c.getTraceabilityReport);
router.get("/invoices", customsView, ci.listCustomsInvoices);
router.get("/invoices/by-sales-invoice/:salesInvoiceId", customsView, ci.getCustomsInvoiceBySalesInvoice);
router.get("/invoices/by-sales-invoice/:salesInvoiceId/eligibility", customsView, ci.checkSalesInvoiceEligibility);
router.post("/invoices/preview-from-sales-invoice/:salesInvoiceId", customsView, ci.previewFromSalesInvoice);
router.get("/invoices/:id/print", customsView, ci.getCustomsInvoicePrint);
router.get("/invoices/:id", customsView, ci.getCustomsInvoice);
router.post("/invoices/from-sales-invoice/:salesInvoiceId", customsCreate, ci.createFromSalesInvoice);
router.put("/invoices/:id", customsCreate, ci.updateCustomsInvoice);
router.post("/invoices/:id/finalize", customsCreate, ci.finalizeCustomsInvoice);
router.post("/invoices/:id/cancel", customsCancel, ci.cancelCustomsInvoice);
router.get("/lots", customsView, c.listCustomsLots);
router.get("/movements", customsView, c.listCustomsMovements);
router.get("/reconciliation", customsReconciliationView, c.getCustomsReconciliation);
router.get("/reconciliation/detail", customsReconciliationView, c.getCustomsReconciliationDetailHandler);

export default router;
