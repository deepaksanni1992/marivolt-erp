import express from "express";
import { requireErpAccess } from "../middleware/erpAccess.js";
import * as c from "../controllers/salesController.js";
import * as flow from "../controllers/salesFlowController.js";

const router = express.Router();

router.use(...requireErpAccess);
router.get("/orders", c.listSalesOrders);
router.post("/orders", c.createSalesOrder);
router.get("/orders/:id", c.getSalesOrder);
router.get("/summary", flow.getSalesSummary);
router.get("/reports/quotation-summary", flow.reportQuotationSummary);
router.get("/reports/pending-quotation", flow.reportPendingQuotation);
router.get("/reports/order-acknowledgement", flow.reportOrderAcknowledgement);
router.get("/reports/pending-order-acknowledgement", flow.reportPendingOrderAcknowledgement);
router.get("/reports/proforma", flow.reportProforma);
router.get("/reports/sales-invoice-summary", flow.reportSalesInvoiceSummary);
router.get("/reports/sales-invoice-article-wise", flow.reportSalesInvoiceArticleWise);
router.get("/reports/sales-branch-wise", flow.reportSalesBranchWise);
router.get("/reports/cipl", flow.reportCipl);

router.get("/customers", flow.listCustomers);
router.post("/customers", flow.createCustomer);
router.put("/customers/:id", flow.updateCustomer);
router.delete("/customers/:id", flow.deleteCustomer);

router.get("/order-acknowledgements", flow.listOAs);
router.post("/order-acknowledgements", flow.createOA);
router.get("/order-acknowledgements/:id", flow.getOA);
router.get("/order-acknowledgements/:id/print", flow.getOAPrintData);
router.get("/order-acknowledgements/:id/pdf", flow.getOAPdfData);
router.put("/order-acknowledgements/:id", flow.updateOA);
router.patch("/order-acknowledgements/:id/cancel", flow.cancelOA);

router.get("/proforma-invoices", flow.listProformas);
router.post("/proforma-invoices", flow.createProforma);
router.get("/proforma-invoices/:id", flow.getProforma);
router.put("/proforma-invoices/:id", flow.updateProforma);
router.patch("/proforma-invoices/:id/cancel", flow.cancelProforma);

router.get("/sales-invoices", flow.listSalesInvoices);
router.post("/sales-invoices", flow.createSalesInvoice);
router.get("/sales-invoices/:id", flow.getSalesInvoice);
router.put("/sales-invoices/:id", flow.updateSalesInvoice);
router.patch("/sales-invoices/:id/cancel", flow.cancelSalesInvoice);

router.get("/cipls", flow.listCipls);
router.post("/cipls", flow.createCipl);
router.get("/cipls/:id", flow.getCipl);
router.put("/cipls/:id", flow.updateCipl);
router.patch("/cipls/:id/cancel", flow.cancelCipl);

router.post("/convert/quotation/:id/to-oa", flow.convertQuotationToOA);
router.post("/convert/quotation/:id/to-proforma", flow.convertQuotationToProforma);
router.post("/convert/quotation/:id/to-cipl", flow.convertQuotationToCipl);
router.post("/convert/oa/:id/to-proforma", flow.convertOAToProforma);
router.post("/convert/oa/:id/to-cipl", flow.convertOAToCipl);
router.post("/convert/proforma/:id/to-sales-invoice", flow.convertProformaToSalesInvoice);
router.post("/convert/sales-invoice/:id/to-cipl", flow.convertSalesInvoiceToCipl);

export default router;
