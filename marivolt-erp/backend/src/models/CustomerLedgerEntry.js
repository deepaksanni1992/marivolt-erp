import mongoose from "mongoose";

const customerLedgerEntrySchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: "Company", required: true, index: true },
    entryDate: { type: Date, required: true, default: () => new Date() },
    customerName: { type: String, required: true, trim: true },
    referenceType: { type: String, default: "", trim: true },
    referenceNumber: { type: String, default: "", trim: true },
    sourceModule: { type: String, default: "", trim: true },
    sourceType: { type: String, default: "", trim: true },
    sourceId: { type: mongoose.Schema.Types.ObjectId, default: null, index: true },
    proformaInvoiceId: { type: mongoose.Schema.Types.ObjectId, ref: "ProformaInvoice", default: null, index: true },
    proformaInvoiceNo: { type: String, default: "", trim: true },
    customerId: { type: mongoose.Schema.Types.ObjectId, ref: "Customer", default: null, index: true },
    debit: { type: Number, default: 0, min: 0 },
    credit: { type: Number, default: 0, min: 0 },
    currency: { type: String, default: "USD", trim: true, uppercase: true },
    paymentReference: { type: String, default: "", trim: true },
    attachmentProvider: { type: String, default: "", trim: true },
    attachmentKey: { type: String, default: "", trim: true },
    reversedFromEntryId: { type: mongoose.Schema.Types.ObjectId, default: null },
    narrative: { type: String, default: "" },
    createdBy: { type: String, default: "" },
  },
  { timestamps: true }
);

customerLedgerEntrySchema.index({ companyId: 1, customerName: 1, entryDate: 1 });

export default mongoose.model("CustomerLedgerEntry", customerLedgerEntrySchema);
