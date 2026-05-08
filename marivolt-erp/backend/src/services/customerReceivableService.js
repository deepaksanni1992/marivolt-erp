import mongoose from "mongoose";
import Customer from "../models/Customer.js";
import CustomerLedger from "../models/CustomerLedger.js";

function idOrNull(v) {
  const s = String(v || "").trim();
  return mongoose.Types.ObjectId.isValid(s) ? new mongoose.Types.ObjectId(s) : null;
}

function money(v) {
  return Math.max(0, Number(v) || 0);
}

function currencyOf(v) {
  return String(v || "USD").trim().toUpperCase() || "USD";
}

function customerFilter({ companyId, customerId, customerName, currency }) {
  const filter = { companyId, currency: currencyOf(currency), status: { $ne: "CANCELLED" } };
  const id = idOrNull(customerId);
  if (id) filter.customerId = id;
  else filter.customerName = String(customerName || "").trim();
  return filter;
}

async function resolveCustomer({ companyId, customerId = null, customerName = "", session = null } = {}) {
  const id = idOrNull(customerId);
  if (id) {
    const row = await Customer.findOne({ companyId, _id: id }).session(session).select("_id name").lean();
    if (row) return { customerId: row._id, customerName: row.name || customerName || "" };
  }
  const name = String(customerName || "").trim();
  if (!name) return { customerId: null, customerName: "" };
  const row = await Customer.findOne({ companyId, name: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i") })
    .session(session)
    .select("_id name")
    .lean();
  return { customerId: row?._id || null, customerName: row?.name || name };
}

export async function latestCustomerBalance({ companyId, customerId = null, customerName = "", currency = "USD", session = null } = {}) {
  const latest = await CustomerLedger.findOne(customerFilter({ companyId, customerId, customerName, currency }))
    .sort({ transactionDate: -1, createdAt: -1, _id: -1 })
    .session(session)
    .select("runningBalance")
    .lean();
  return Number(latest?.runningBalance || 0);
}

export async function writeCustomerLedgerEntry({
  companyId,
  customerId = null,
  customerName = "",
  documentType = "",
  documentId = null,
  documentNo = "",
  movementType,
  debitAmount = 0,
  creditAmount = 0,
  currency = "USD",
  transactionDate = new Date(),
  remarks = "",
  linkedPaymentId = null,
  linkedInvoiceId = null,
  reversedFromLedgerId = null,
  status = "POSTED",
  createdBy = "",
  session = null,
  allowDuplicate = false,
} = {}) {
  if (!companyId) throw new Error("companyId is required for customer ledger");
  if (!movementType) throw new Error("movementType is required for customer ledger");
  const resolved = await resolveCustomer({ companyId, customerId, customerName, session });
  const name = resolved.customerName || String(customerName || "").trim();
  if (!name) throw new Error("customerName is required for customer ledger");

  const docId = idOrNull(documentId);
  if (!allowDuplicate && docId) {
    const existing = await CustomerLedger.findOne({
      companyId,
      documentId: docId,
      movementType,
      status: { $ne: "CANCELLED" },
    })
      .session(session)
      .lean();
    if (existing) return existing;
  }

  const cur = currencyOf(currency);
  const previous = await latestCustomerBalance({
    companyId,
    customerId: resolved.customerId,
    customerName: name,
    currency: cur,
    session,
  });
  const debit = money(debitAmount);
  const credit = money(creditAmount);
  const runningBalance = previous + debit - credit;
  const [row] = await CustomerLedger.create(
    [
      {
        companyId,
        customerId: resolved.customerId || null,
        customerName: name,
        documentType: String(documentType || "").trim(),
        documentId: docId,
        documentNo: String(documentNo || "").trim(),
        movementType,
        debitAmount: debit,
        creditAmount: credit,
        runningBalance,
        currency: cur,
        transactionDate: transactionDate || new Date(),
        remarks,
        linkedPaymentId: idOrNull(linkedPaymentId),
        linkedInvoiceId: idOrNull(linkedInvoiceId),
        reversedFromLedgerId: idOrNull(reversedFromLedgerId),
        status,
        createdBy,
      },
    ],
    { session }
  );
  return row;
}

export async function postSalesInvoiceReceivable({ req, invoice, session = null } = {}) {
  if (!invoice) return null;
  return writeCustomerLedgerEntry({
    companyId: req.companyId,
    customerName: invoice.customerName || "",
    documentType: "SALES_INVOICE",
    documentId: invoice._id,
    documentNo: invoice.invoiceNo || "",
    movementType: "SALES_INVOICE",
    debitAmount: money(invoice.grandTotal),
    creditAmount: 0,
    currency: invoice.currency || "USD",
    transactionDate: invoice.invoiceDate || invoice.createdAt || new Date(),
    remarks: `Sales invoice ${invoice.invoiceNo || ""}`,
    linkedInvoiceId: invoice._id,
    createdBy: req.user?.email || "",
    session,
  });
}

export async function reverseSalesInvoiceReceivable({ req, invoice, reason = "", session = null } = {}) {
  if (!invoice) return null;
  const original = await CustomerLedger.findOne({
    companyId: req.companyId,
    linkedInvoiceId: invoice._id,
    movementType: "SALES_INVOICE",
    status: { $ne: "CANCELLED" },
  })
    .session(session)
    .lean();
  if (!original) return null;
  return writeCustomerLedgerEntry({
    companyId: req.companyId,
    customerId: original.customerId || null,
    customerName: original.customerName || invoice.customerName || "",
    documentType: "SALES_INVOICE",
    documentId: invoice._id,
    documentNo: invoice.invoiceNo || "",
    movementType: "INVOICE_CANCEL",
    debitAmount: 0,
    creditAmount: money(original.debitAmount || invoice.grandTotal),
    currency: original.currency || invoice.currency || "USD",
    transactionDate: new Date(),
    remarks: reason ? `Invoice cancelled: ${reason}` : `Invoice ${invoice.invoiceNo || ""} cancelled`,
    linkedInvoiceId: invoice._id,
    reversedFromLedgerId: original._id,
    createdBy: req.user?.email || "",
    session,
  });
}

export async function postPaymentReceiptReceivable({ req, receipt, session = null } = {}) {
  if (!receipt) return null;
  const credit = money(receipt.allocatedAmount || receipt.amountReceived);
  if (credit <= 0) return null;
  const invoiceAlloc = (receipt.allocations || []).find((a) => String(a.targetType || "") === "SALES_INVOICE");
  return writeCustomerLedgerEntry({
    companyId: req.companyId,
    customerId: receipt.customerId || null,
    customerName: receipt.customerName || "",
    documentType: "PAYMENT_RECEIPT",
    documentId: receipt._id,
    documentNo: receipt.receiptNo || receipt.paymentReference || "",
    movementType: "PAYMENT_RECEIPT",
    debitAmount: 0,
    creditAmount: credit,
    currency: receipt.currency || "USD",
    transactionDate: receipt.receiptDate || receipt.receivedDate || new Date(),
    remarks: `Payment receipt ${receipt.receiptNo || ""}`,
    linkedPaymentId: receipt._id,
    linkedInvoiceId: invoiceAlloc?.targetId || receipt.salesInvoiceId || null,
    createdBy: req.user?.email || "",
    session,
  });
}

export async function reversePaymentReceiptReceivable({ req, receipt, reason = "", session = null } = {}) {
  if (!receipt) return null;
  const original = await CustomerLedger.findOne({
    companyId: req.companyId,
    linkedPaymentId: receipt._id,
    movementType: "PAYMENT_RECEIPT",
    status: { $ne: "CANCELLED" },
  })
    .session(session)
    .lean();
  const debit = money(original?.creditAmount || receipt.allocatedAmount || receipt.amountReceived);
  if (debit <= 0) return null;
  return writeCustomerLedgerEntry({
    companyId: req.companyId,
    customerId: original?.customerId || receipt.customerId || null,
    customerName: original?.customerName || receipt.customerName || "",
    documentType: "PAYMENT_RECEIPT",
    documentId: receipt._id,
    documentNo: receipt.receiptNo || receipt.paymentReference || "",
    movementType: "PAYMENT_CANCEL",
    debitAmount: debit,
    creditAmount: 0,
    currency: original?.currency || receipt.currency || "USD",
    transactionDate: new Date(),
    remarks: reason ? `Payment cancelled: ${reason}` : `Payment receipt ${receipt.receiptNo || ""} cancelled`,
    linkedPaymentId: receipt._id,
    linkedInvoiceId: original?.linkedInvoiceId || receipt.salesInvoiceId || null,
    reversedFromLedgerId: original?._id || null,
    createdBy: req.user?.email || "",
    session,
  });
}
