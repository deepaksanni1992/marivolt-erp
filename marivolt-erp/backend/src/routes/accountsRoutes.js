import express from "express";
import { requireRole } from "../middleware/auth.js";
import { requireErpAccess } from "../middleware/erpAccess.js";
import { requirePermission } from "../middleware/permissions.js";
import * as c from "../controllers/accountsController.js";

const bankDetailAdminRoles = ["super_admin", "company_admin", "admin"];
const journalViewRoles = ["super_admin", "company_admin", "admin", "accounts_logistics"];

const router = express.Router();

router.use(...requireErpAccess);
const accountsView = requirePermission("ACCOUNTS", "view");
const accountsCreate = requirePermission("ACCOUNTS", "create");
const accountsEdit = requirePermission("ACCOUNTS", "edit");
const accountsExport = requirePermission("ACCOUNTS", "export");
const accountsDelete = requirePermission("ACCOUNTS", "delete");
const reportsView = requirePermission("REPORTS", "view");

router.get("/sales-dispatches", accountsView, c.listSalesDispatchesAccounts);
router.get("/sales-invoices", accountsView, c.listSalesInvoices);
router.get("/sales-invoices/:id", accountsView, c.getSalesInvoice);
router.post("/sales-invoices", accountsCreate, c.createSalesInvoice);
router.put("/sales-invoices/:id", accountsEdit, c.updateSalesInvoice);
router.delete("/sales-invoices/:id", accountsDelete, c.deleteSalesInvoice);

router.get("/purchase-invoices", accountsView, c.listPurchaseInvoices);
router.get("/purchase-invoices/:id", accountsView, c.getPurchaseInvoice);
router.post("/purchase-invoices", accountsCreate, c.createPurchaseInvoice);
router.put("/purchase-invoices/:id", accountsEdit, c.updatePurchaseInvoice);
router.patch("/purchase-invoices/:id/cancel", accountsEdit, c.cancelPurchaseInvoice);
router.delete("/purchase-invoices/:id", accountsDelete, c.deletePurchaseInvoice);

router.get("/ap/po-supplier-documents", accountsView, c.listApPoSupplierDocuments);
router.get("/ap/po-search", accountsView, c.searchApPurchaseOrders);

router.get("/supplier-payments", accountsView, c.listSupplierPayments);
router.get("/supplier-payments/:id", accountsView, c.getSupplierPayment);
router.post("/supplier-payments", accountsCreate, c.createSupplierPayment);
router.put("/supplier-payments/:id", accountsEdit, c.updateSupplierPayment);
router.patch("/supplier-payments/:id/cancel", accountsEdit, c.cancelSupplierPayment);

router.get("/customer-ledger", accountsView, c.listCustomerLedger);
router.get("/customer-ledger/:customerId", accountsView, c.getCustomerLedgerByCustomerId);
router.get("/customer-statement", accountsExport, c.getCustomerStatement);
router.get("/customer-statement/:customerId", accountsExport, c.getCustomerStatement);
router.post("/customer-ledger", accountsCreate, c.createCustomerLedgerEntry);
router.delete("/customer-ledger/:id", accountsDelete, c.deleteCustomerLedgerEntry);

router.get("/supplier-ledger", accountsView, c.listSupplierLedger);
router.post("/supplier-ledger", accountsCreate, c.createSupplierLedgerEntry);
router.delete("/supplier-ledger/:id", accountsDelete, c.deleteSupplierLedgerEntry);

router.get("/cash-bank", accountsView, c.listCashBank);
router.get("/cash-bank-ledger", accountsView, c.listCashBankLedger);
router.post("/cash-bank", accountsCreate, c.createCashBankEntry);
router.delete("/cash-bank/:id", accountsDelete, c.deleteCashBankEntry);

router.get("/outstanding", reportsView, c.listOutstandingReport);
router.get("/aging", reportsView, c.listAgingReport);
router.get("/supplier-outstanding", reportsView, c.supplierOutstandingReport);
router.get("/outstanding-suppliers", reportsView, c.supplierOutstandingReport);
router.get("/ap-aging", reportsView, c.apAgeingReport);
router.get("/aging-suppliers", reportsView, c.apAgeingReport);
router.get("/ap-dashboard", reportsView, c.getApDashboard);
router.get("/reports/pending-supplier-documents", reportsView, c.reportPendingSupplierDocuments);
router.get("/reports/po-grn-invoice", reportsView, c.reportPoGrnInvoice);
router.get("/supplier-payment-summary", reportsView, c.supplierPaymentSummaryReport);
router.get("/supplier-ledger-summary", reportsView, c.supplierLedgerSummaryReport);
router.get("/journal-entries", accountsView, requireRole(...journalViewRoles), c.listJournalEntries);
router.get("/journal-entries/:id", accountsView, requireRole(...journalViewRoles), c.getJournalEntry);

router.get("/bank-details/for-currency/:currency", accountsView, c.getBankDetailForCurrency);
router.get("/bank-details", accountsView, c.listBankDetails);
router.post("/bank-details", accountsCreate, requireRole(...bankDetailAdminRoles), c.createBankDetail);
router.put("/bank-details/:id", accountsEdit, requireRole(...bankDetailAdminRoles), c.updateBankDetail);
router.delete("/bank-details/:id", accountsDelete, requireRole(...bankDetailAdminRoles), c.deleteBankDetail);

export default router;
