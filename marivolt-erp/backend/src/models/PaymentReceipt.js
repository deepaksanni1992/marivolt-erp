import mongoose from "mongoose";

const paymentModeEnum = ["BANK_TRANSFER", "CASH", "CHEQUE", "CARD", "OTHER"];
const sourceTypeEnum = ["PROFORMA_INVOICE", "SALES_INVOICE", "ADVANCE_PAYMENT", "MULTIPLE_INVOICE"];
const paymentReceiptStatusEnum = ["POSTED", "PARTIALLY_ALLOCATED", "FULLY_ALLOCATED", "CANCELLED"];

const paymentAllocationSchema = new mongoose.Schema(
  {
    paymentReceiptId: { type: mongoose.Schema.Types.ObjectId, ref: "PaymentReceipt", default: null, index: true },
    customerId: { type: mongoose.Schema.Types.ObjectId, ref: "Customer", default: null, index: true },
    targetType: { type: String, enum: ["PROFORMA_INVOICE", "SALES_INVOICE"], required: true },
    targetId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    targetNo: { type: String, default: "", trim: true },
    invoiceTotal: { type: Number, default: 0, min: 0 },
    allocatedAmount: { type: Number, required: true, min: 0.0001 },
    currency: { type: String, default: "USD", trim: true, uppercase: true },
    allocatedAt: { type: Date, default: () => new Date() },
    allocatedBy: { type: String, default: "" },
  },
  { _id: true }
);

const paymentReceiptSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: "Company", required: true, index: true },
    receiptNo: { type: String, required: true, trim: true },
    receiptDate: { type: Date, required: true, default: () => new Date(), index: true },
    sourceType: { type: String, enum: sourceTypeEnum, default: "PROFORMA_INVOICE", index: true },
    proformaInvoiceId: { type: mongoose.Schema.Types.ObjectId, ref: "ProformaInvoice", default: null, index: true },
    proformaInvoiceNo: { type: String, default: "", trim: true, index: true },
    salesInvoiceId: { type: mongoose.Schema.Types.ObjectId, ref: "SalesInvoice", default: null, index: true },
    salesInvoiceNo: { type: String, default: "", trim: true, index: true },
    customerId: { type: mongoose.Schema.Types.ObjectId, ref: "Customer", default: null, index: true },
    customerName: { type: String, default: "", trim: true, index: true },
    receivedDate: { type: Date, required: true, default: () => new Date() },
    amountReceived: { type: Number, required: true, min: 0.0001 },
    allocatedAmount: { type: Number, default: 0, min: 0 },
    unallocatedAmount: { type: Number, default: 0, min: 0 },
    currency: { type: String, default: "USD", trim: true, uppercase: true },
    paymentMode: { type: String, enum: paymentModeEnum, required: true },
    bankCashAccountId: { type: mongoose.Schema.Types.ObjectId, default: null, index: true },
    bankCashAccountName: { type: String, default: "", trim: true, index: true },
    bankAccountId: { type: mongoose.Schema.Types.ObjectId, ref: "BankDetail", default: null },
    cashAccountId: { type: mongoose.Schema.Types.ObjectId, ref: "CashBankEntry", default: null },
    accountName: { type: String, default: "", trim: true },
    paymentReference: { type: String, default: "", trim: true, index: true },
    remarks: { type: String, default: "" },
    attachmentProvider: { type: String, enum: ["AWS_S3"], default: "AWS_S3" },
    attachmentBucket: { type: String, default: "", trim: true },
    attachmentKey: { type: String, default: "", trim: true },
    attachmentOriginalName: { type: String, default: "", trim: true },
    attachmentMimeType: { type: String, default: "", trim: true },
    attachmentSize: { type: Number, default: 0, min: 0 },
    attachmentUploadedAt: { type: Date, default: null },
    allocations: { type: [paymentAllocationSchema], default: [] },
    journalEntryId: { type: mongoose.Schema.Types.ObjectId, ref: "JournalEntry", default: null, index: true },
    status: { type: String, enum: paymentReceiptStatusEnum, default: "POSTED", index: true },
    cancellationReason: { type: String, default: "" },
    cancelledAt: { type: Date, default: null },
    cancelledBy: { type: String, default: "" },
    cancelReason: { type: String, default: "" },
    postedBy: { type: String, default: "" },
    linkedCustomerLedgerEntryId: { type: mongoose.Schema.Types.ObjectId, ref: "CustomerLedgerEntry", default: null },
    linkedCashBankEntryId: { type: mongoose.Schema.Types.ObjectId, ref: "CashBankEntry", default: null },
    linkedReverseCustomerLedgerEntryId: { type: mongoose.Schema.Types.ObjectId, ref: "CustomerLedgerEntry", default: null },
    linkedReverseCashBankEntryId: { type: mongoose.Schema.Types.ObjectId, ref: "CashBankEntry", default: null },
    createdBy: { type: String, default: "" },
    updatedBy: { type: String, default: "" },
  },
  { timestamps: true }
);

paymentReceiptSchema.index({ companyId: 1, receiptNo: 1 }, { unique: true });
paymentReceiptSchema.index({ companyId: 1, proformaInvoiceId: 1, status: 1, receivedDate: -1 });
paymentReceiptSchema.index({ companyId: 1, salesInvoiceId: 1, status: 1, receiptDate: -1 });

export const PAYMENT_MODE_ENUM = paymentModeEnum;
export const PAYMENT_RECEIPT_STATUS_ENUM = paymentReceiptStatusEnum;
export const PAYMENT_SOURCE_TYPE_ENUM = sourceTypeEnum;
export default mongoose.model("PaymentReceipt", paymentReceiptSchema);
