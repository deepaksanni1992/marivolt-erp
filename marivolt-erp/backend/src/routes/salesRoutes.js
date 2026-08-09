import express from "express";
import { requireRole } from "../middleware/auth.js";
import { requireErpAccess } from "../middleware/erpAccess.js";
import { requirePermission } from "../middleware/permissions.js";
import * as c from "../controllers/salesController.js";
import * as flow from "../controllers/salesFlowController.js";
import * as storeOutbound from "../controllers/storeOutboundController.js";
import * as canonicalDispatch from "../controllers/canonicalSalesDispatchController.js";
import * as salesReturn from "../controllers/salesReturnController.js";
import * as allocationPo from "../controllers/orderAllocationPoController.js";

/** Customer master edits (PUT/DELETE) — super_admin, company_admin, or admin only. */
const customerMasterAdminRoles = ["super_admin", "company_admin", "admin"];

const router = express.Router();

router.use(...requireErpAccess);
const salesView = requirePermission("SALES", "view");
const salesCreate = requirePermission("SALES", "create");
const salesEdit = requirePermission("SALES", "edit");
const salesApprove = requirePermission("SALES", "approve");
const salesCancel = requirePermission("SALES", "cancel");
const salesExport = requirePermission("SALES", "export");
const salesDelete = requirePermission("SALES", "delete");
const purchaseCreateFromAllocation = requirePermission("PURCHASE", "createFromAllocation");
const reportsView = requirePermission("REPORTS", "view");

router.get("/orders", salesView, c.listSalesOrders);
router.post("/orders", salesCreate, c.createSalesOrder);
router.get("/orders/:id", salesView, c.getSalesOrder);
router.get("/summary", salesView, flow.getSalesSummary);
router.get("/reports/quotation-summary", reportsView, flow.reportQuotationSummary);
router.get("/reports/pending-quotation", reportsView, flow.reportPendingQuotation);
router.get("/reports/order-acknowledgement", reportsView, flow.reportOrderAcknowledgement);
router.get("/reports/pending-order-acknowledgement", reportsView, flow.reportPendingOrderAcknowledgement);
router.get("/reports/proforma", reportsView, flow.reportProforma);
router.get("/reports/pending-proforma-payment", reportsView, flow.reportPendingProformaPayment);
router.get("/reports/pending-allocation", reportsView, flow.reportPendingAllocation);
router.get("/reports/packing-done-not-invoiced", reportsView, storeOutbound.reportPackedNotInvoiced);
router.get("/reports/invoiced-not-dispatched", reportsView, storeOutbound.reportInvoicedNotDispatched);
router.get("/reports/dispatch-status", reportsView, storeOutbound.listDispatchStatus);
router.get("/reports/sales-invoice-summary", reportsView, flow.reportSalesInvoiceSummary);
router.get("/reports/sales-invoice-article-wise", reportsView, flow.reportSalesInvoiceArticleWise);
router.get("/reports/sales-branch-wise", reportsView, flow.reportSalesBranchWise);
router.get("/reports/cipl", reportsView, flow.reportCipl);
router.get("/reports/order-allocation", reportsView, flow.reportOrderAllocation);
router.get("/reports/backorder", reportsView, flow.reportBackorder);

router.get("/customers", salesView, flow.listCustomers);
router.post("/customers", salesCreate, flow.createCustomer);
router.put("/customers/:id", salesEdit, requireRole(...customerMasterAdminRoles), flow.updateCustomer);
router.delete("/customers/:id", salesDelete, requireRole(...customerMasterAdminRoles), flow.deleteCustomer);

router.get("/order-acknowledgements", salesView, flow.listOAs);
router.post("/order-acknowledgements", salesCreate, flow.createOA);
router.get("/order-acknowledgements/:id", salesView, flow.getOA);
router.get("/order-acknowledgements/:id/print", salesExport, flow.getOAPrintData);
router.get("/order-acknowledgements/:id/pdf", salesExport, flow.getOAPdfData);
router.put("/order-acknowledgements/:id", salesEdit, flow.updateOA);
router.patch("/order-acknowledgements/:id/cancel", salesCancel, flow.cancelOA);

router.get("/proforma-invoices", salesView, flow.listProformas);
router.post("/proforma-invoices", salesCreate, flow.createProforma);
router.post(
  "/proforma-invoices/recalc-payment-state",
  salesEdit,
  requireRole("super_admin", "company_admin", "admin", "accounts_logistics"),
  flow.recalcAllProformaPaymentStates
);
router.get("/proforma-invoices/:id", salesView, flow.getProforma);
router.get("/proforma-invoices/:id/print", salesExport, flow.getProformaPrintData);
router.put("/proforma-invoices/:id", salesEdit, flow.updateProforma);
router.patch("/proforma-invoices/:id/cancel", salesCancel, flow.cancelProforma);

router.get("/sales-invoices", salesView, flow.listSalesInvoices);
router.post("/sales-invoices", salesCreate, flow.createSalesInvoice);
router.get("/sales-invoices/packings/ready", salesView, flow.listPackingsReadyForInvoice);
router.get("/sales-invoices/from-packing/:id", salesView, flow.getPackingInvoicePreview);
router.post("/sales-invoices/from-packing/:id", salesCreate, flow.convertPackingToSalesInvoice);
router.get("/sales-invoices/:id", salesView, flow.getSalesInvoice);
router.get("/sales-invoices/:id/print", salesExport, flow.getSalesInvoicePrintData);
router.put("/sales-invoices/:id", salesEdit, flow.updateSalesInvoice);
router.patch("/sales-invoices/:id/invoice-no", salesEdit, flow.updateSalesInvoiceNumber);
router.patch("/sales-invoices/:id/cancel", salesCancel, flow.cancelSalesInvoice);
router.get("/dispatch-status", salesView, storeOutbound.listDispatchStatus);
router.get("/sales-dispatches/pending-invoices", salesView, canonicalDispatch.listPendingSalesDispatchInvoices);
router.get("/sales-dispatches/from-invoice/:invoiceId", salesView, canonicalDispatch.getSalesDispatchPreviewFromInvoice);
router.get("/sales-dispatches", salesView, canonicalDispatch.listCanonicalSalesDispatches);
router.post("/sales-dispatches", salesCreate, canonicalDispatch.createSalesDispatch);
router.get("/sales-dispatches/:id", salesView, flow.getSalesDispatch);
router.put("/sales-dispatches/:id", salesEdit, canonicalDispatch.updateSalesDispatch);
router.patch("/sales-dispatches/:id", salesEdit, flow.patchSalesDispatch);
router.post("/sales-dispatches/:id/post", salesEdit, canonicalDispatch.postSalesDispatch);
router.post("/sales-dispatches/:id/cancel", salesCancel, canonicalDispatch.cancelSalesDispatch);

router.get("/sales-returns/prefill-from-dispatch/:dispatchId", salesView, salesReturn.getSalesReturnPrefillFromDispatch);
router.get("/sales-returns", salesView, salesReturn.listSalesReturns);
router.post("/sales-returns", salesCreate, salesReturn.createSalesReturn);
router.get("/sales-returns/:id", salesView, salesReturn.getSalesReturn);
router.put("/sales-returns/:id", salesEdit, salesReturn.updateSalesReturn);
router.delete("/sales-returns/:id", salesDelete, salesReturn.deleteSalesReturn);
router.patch("/sales-returns/:id/post", salesApprove, salesReturn.postSalesReturn);

router.get("/order-allocations", salesView, flow.listOrderAllocations);
router.get("/order-allocations/:id", salesView, flow.getOrderAllocation);
router.patch("/order-allocations/:id/allocation-no", salesEdit, flow.updateOrderAllocationNumber);
router.get("/order-allocations/:id/po-eligibility", salesView, allocationPo.getOrderAllocationPoEligibility);
router.get("/order-allocations/:id/stock-position", salesView, allocationPo.getOrderAllocationStockPosition);
router.get("/order-allocations/:id/linked-purchase-orders", salesView, allocationPo.getOrderAllocationLinkedPurchaseOrders);
router.post("/order-allocations/:id/to-sales-invoice", salesCreate, flow.convertOrderAllocationToSalesInvoice);

router.get("/cipls", salesView, flow.listCipls);
router.post("/cipls", salesCreate, flow.createCipl);
router.get("/cipls/:id", salesView, flow.getCipl);
router.put("/cipls/:id", salesEdit, flow.updateCipl);
router.patch("/cipls/:id/cancel", salesCancel, flow.cancelCipl);

router.post("/convert/quotation/:id/to-oa", salesCreate, flow.convertQuotationToOA);
router.post("/convert/quotation/:id/to-proforma", salesCreate, flow.convertQuotationToProforma);
router.post("/convert/quotation/:id/to-cipl", salesCreate, flow.convertQuotationToCipl);
router.post("/convert/oa/:id/to-proforma", salesCreate, flow.convertOAToProforma);
router.post("/convert/oa/:id/to-sales-invoice", salesCreate, flow.convertOAToSalesInvoice);
router.post("/convert/oa/:id/to-cipl", salesCreate, flow.convertOAToCipl);
router.post("/convert/oa/:id/to-order-allocation", salesCreate, flow.convertOAToOrderAllocation);
router.post("/convert/proforma/:id/to-sales-invoice", salesCreate, flow.convertProformaToSalesInvoice);
router.post("/convert/proforma/:id/to-cipl", salesCreate, flow.convertProformaToCipl);
router.post("/convert/proforma/:id/to-order-allocation", salesCreate, flow.convertProformaToOrderAllocation);
router.post("/convert/sales-invoice/:id/to-cipl", salesCreate, flow.convertSalesInvoiceToCipl);
router.post("/convert/sales-invoice/:id/to-sales-dispatch", salesCreate, flow.convertSalesInvoiceToSalesDispatch);

/** ERP workflow aliases (same handlers as /convert/* where applicable). */
router.post("/quotations/:id/convert-to-oa", salesCreate, flow.convertQuotationToOA);
router.post("/order-acknowledgements/:id/create-proforma", salesCreate, flow.convertOAToProforma);
router.post("/order-acknowledgements/:id/allocate", salesCreate, flow.convertOAToOrderAllocation);
router.post("/proformas/:id/mark-paid", salesEdit, flow.markProformaPaid);
router.post("/invoices/:id/cancel", salesCancel, flow.cancelSalesInvoice);
router.post("/allocations/:id/cancel", salesCancel, flow.cancelOrderAllocation);
router.post("/order-acknowledgements/:id/cancel", salesCancel, flow.cancelOA);

export default router;
