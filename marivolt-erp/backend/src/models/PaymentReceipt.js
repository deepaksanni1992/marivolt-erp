import mongoose from "mongoose";

const paymentModeEnum = ["BANK_TRANSFER", "CASH", "CHEQUE", "CARD", "OTHER"];
const paymentReceiptStatusEnum = ["POSTED", "CANCELLED"];

const paymentReceiptSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: "Company", required: true, index: true },
    receiptNo: { type: String, required: true, trim: true },
    proformaInvoiceId: { type: mongoose.Schema.Types.ObjectId, ref: "ProformaInvoice", required: true, index: true },
    proformaInvoiceNo: { type: String, default: "", trim: true, index: true },
    customerId: { type: mongoose.Schema.Types.ObjectId, ref: "Customer", default: null, index: true },
    customerName: { type: String, default: "", trim: true, index: true },
    receivedDate: { type: Date, required: true },
    amountReceived: { type: Number, required: true, min: 0.0001 },
    currency: { type: String, default: "USD", trim: true, uppercase: true },
    paymentMode: { type: String, enum: paymentModeEnum, required: true },
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
    status: { type: String, enum: paymentReceiptStatusEnum, default: "POSTED", index: true },
    cancellationReason: { type: String, default: "" },
    cancelledAt: { type: Date, default: null },
    cancelledBy: { type: String, default: "" },
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

export const PAYMENT_MODE_ENUM = paymentModeEnum;
export const PAYMENT_RECEIPT_STATUS_ENUM = paymentReceiptStatusEnum;
export default mongoose.model("PaymentReceipt", paymentReceiptSchema);
