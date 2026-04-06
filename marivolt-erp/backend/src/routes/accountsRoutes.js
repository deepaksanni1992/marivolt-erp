import express from "express";
import { requireErpAccess } from "../middleware/erpAccess.js";
import * as c from "../controllers/accountsController.js";

const router = express.Router();

router.use(...requireErpAccess);

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
router.post("/customer-ledger", c.createCustomerLedgerEntry);
router.delete("/customer-ledger/:id", c.deleteCustomerLedgerEntry);

router.get("/supplier-ledger", c.listSupplierLedger);
router.post("/supplier-ledger", c.createSupplierLedgerEntry);
router.delete("/supplier-ledger/:id", c.deleteSupplierLedgerEntry);

router.get("/cash-bank", c.listCashBank);
router.post("/cash-bank", c.createCashBankEntry);
router.delete("/cash-bank/:id", c.deleteCashBankEntry);

export default router;
