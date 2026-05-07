import mongoose from "mongoose";

const cashBankEntrySchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: "Company", required: true, index: true },
    entryDate: { type: Date, required: true, default: () => new Date() },
    accountName: { type: String, required: true, trim: true },
    transactionType: {
      type: String,
      enum: ["RECEIPT", "PAYMENT"],
      required: true,
    },
    sourceModule: { type: String, default: "", trim: true },
    sourceType: { type: String, default: "", trim: true },
    sourceId: { type: mongoose.Schema.Types.ObjectId, default: null, index: true },
    proformaInvoiceId: { type: mongoose.Schema.Types.ObjectId, ref: "ProformaInvoice", default: null, index: true },
    proformaInvoiceNo: { type: String, default: "", trim: true },
    customerId: { type: mongoose.Schema.Types.ObjectId, ref: "Customer", default: null, index: true },
    referenceNumber: { type: String, default: "", trim: true },
    currency: { type: String, default: "USD", trim: true, uppercase: true },
    partyName: { type: String, default: "", trim: true },
    amount: { type: Number, required: true, min: 0 },
    mode: { type: String, default: "", trim: true },
    paymentReference: { type: String, default: "", trim: true },
    attachmentProvider: { type: String, default: "", trim: true },
    attachmentKey: { type: String, default: "", trim: true },
    reversedFromEntryId: { type: mongoose.Schema.Types.ObjectId, default: null },
    remarks: { type: String, default: "" },
    createdBy: { type: String, default: "" },
  },
  { timestamps: true }
);

cashBankEntrySchema.index({ companyId: 1, entryDate: -1 });

export default mongoose.model("CashBankEntry", cashBankEntrySchema);
