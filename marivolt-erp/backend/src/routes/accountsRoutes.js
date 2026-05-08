import express from "express";
import { requireRole } from "../middleware/auth.js";
import { requireErpAccess } from "../middleware/erpAccess.js";
import * as c from "../controllers/accountsController.js";

const bankDetailAdminRoles = ["super_admin", "company_admin", "admin"];
const journalViewRoles = ["super_admin", "company_admin", "admin", "accounts_logistics"];

const router = express.Router();

router.use(...requireErpAccess);

router.get("/sales-dispatches", c.listSalesDispatchesAccounts);
router.get("/sales-invoices", c.listSalesInvoices);
router.get("/sales-invoices/:id", c.getSalesInvoice);
router.post("/sales-invoices", c.createSalesInvoice);
router.put("/sales-invoices/:id", c.updateSalesInvoice);
router.delete("/sales-invoices/:id", c.deleteSalesInvoice);

router.get("/purchase-invoices", c.listPurchaseInvoices);
router.get("/purchase-invoices/:id", c.getPurchaseInvoice);
router.post("/purchase-invoices", c.createPurchaseInvoice);
router.put("/purchase-invoices/:id", c.updatePurchaseInvoice);
router.delete("/purchase-invoices/:id", c.deletePurchaseInvoice);

router.get("/customer-ledger", c.listCustomerLedger);
router.get("/customer-ledger/:customerId", c.getCustomerLedgerByCustomerId);
router.get("/customer-statement", c.getCustomerStatement);
router.get("/customer-statement/:customerId", c.getCustomerStatement);
router.post("/customer-ledger", c.createCustomerLedgerEntry);
router.delete("/customer-ledger/:id", c.deleteCustomerLedgerEntry);

router.get("/supplier-ledger", c.listSupplierLedger);
router.post("/supplier-ledger", c.createSupplierLedgerEntry);
router.delete("/supplier-ledger/:id", c.deleteSupplierLedgerEntry);

router.get("/cash-bank", c.listCashBank);
router.get("/cash-bank-ledger", c.listCashBankLedger);
router.post("/cash-bank", c.createCashBankEntry);
router.delete("/cash-bank/:id", c.deleteCashBankEntry);

router.get("/outstanding", c.listOutstandingReport);
router.get("/aging", c.listAgingReport);
router.get("/journal-entries", requireRole(...journalViewRoles), c.listJournalEntries);
router.get("/journal-entries/:id", requireRole(...journalViewRoles), c.getJournalEntry);

router.get("/bank-details/for-currency/:currency", c.getBankDetailForCurrency);
router.get("/bank-details", c.listBankDetails);
router.post("/bank-details", requireRole(...bankDetailAdminRoles), c.createBankDetail);
router.put("/bank-details/:id", requireRole(...bankDetailAdminRoles), c.updateBankDetail);
router.delete("/bank-details/:id", requireRole(...bankDetailAdminRoles), c.deleteBankDetail);

export default router;
