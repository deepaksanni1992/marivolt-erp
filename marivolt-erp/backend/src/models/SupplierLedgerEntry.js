import mongoose from "mongoose";

const supplierLedgerEntrySchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: "Company", required: true, index: true },
    entryDate: { type: Date, required: true, default: () => new Date() },
    supplierName: { type: String, required: true, trim: true },
    referenceType: { type: String, default: "", trim: true },
    referenceNumber: { type: String, default: "", trim: true },
    debit: { type: Number, default: 0, min: 0 },
    credit: { type: Number, default: 0, min: 0 },
    narrative: { type: String, default: "" },
    createdBy: { type: String, default: "" },
  },
  { timestamps: true }
);

supplierLedgerEntrySchema.index({ companyId: 1, supplierName: 1, entryDate: 1 });

export default mongoose.model("SupplierLedgerEntry", supplierLedgerEntrySchema);
