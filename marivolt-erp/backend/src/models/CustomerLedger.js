import mongoose from "mongoose";

const movementTypes = [
  "SALES_INVOICE",
  "PAYMENT_RECEIPT",
  "CREDIT_NOTE",
  "DEBIT_NOTE",
  "INVOICE_CANCEL",
  "PAYMENT_CANCEL",
  "OPENING_BALANCE",
  "JOURNAL",
];

const customerLedgerSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: "Company", required: true, index: true },
    customerId: { type: mongoose.Schema.Types.ObjectId, ref: "Customer", default: null, index: true },
    customerName: { type: String, required: true, trim: true, index: true },

    documentType: { type: String, default: "", trim: true, index: true },
    documentId: { type: mongoose.Schema.Types.ObjectId, default: null, index: true },
    documentNo: { type: String, default: "", trim: true, index: true },
    movementType: { type: String, enum: movementTypes, required: true, index: true },

    debitAmount: { type: Number, default: 0, min: 0 },
    creditAmount: { type: Number, default: 0, min: 0 },
    runningBalance: { type: Number, default: 0 },
    currency: { type: String, default: "USD", trim: true, uppercase: true, index: true },
    transactionDate: { type: Date, required: true, default: () => new Date(), index: true },

    remarks: { type: String, default: "" },
    linkedPaymentId: { type: mongoose.Schema.Types.ObjectId, ref: "PaymentReceipt", default: null, index: true },
    linkedInvoiceId: { type: mongoose.Schema.Types.ObjectId, ref: "SalesInvoice", default: null, index: true },
    reversedFromLedgerId: { type: mongoose.Schema.Types.ObjectId, ref: "CustomerLedger", default: null, index: true },
    status: { type: String, enum: ["POSTED", "CANCELLED", "REVERSED"], default: "POSTED", index: true },
    createdBy: { type: String, default: "" },
  },
  { timestamps: true }
);

customerLedgerSchema.index({ companyId: 1, customerId: 1, currency: 1, transactionDate: 1, createdAt: 1 });
customerLedgerSchema.index({ companyId: 1, customerName: 1, currency: 1, transactionDate: 1, createdAt: 1 });
customerLedgerSchema.index({ companyId: 1, documentNo: 1, transactionDate: -1 });
customerLedgerSchema.index({ companyId: 1, movementType: 1, transactionDate: -1 });
customerLedgerSchema.index({ companyId: 1, linkedInvoiceId: 1, movementType: 1 });
customerLedgerSchema.index({ companyId: 1, linkedPaymentId: 1, movementType: 1 });

export const CUSTOMER_LEDGER_MOVEMENTS = movementTypes;
export default mongoose.model("CustomerLedger", customerLedgerSchema);
