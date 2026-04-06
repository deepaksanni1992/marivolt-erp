import mongoose from "mongoose";

const customerLedgerEntrySchema = new mongoose.Schema(
  {
    entryDate: { type: Date, required: true, default: () => new Date() },
    customerName: { type: String, required: true, trim: true },
    referenceType: { type: String, default: "", trim: true },
    referenceNumber: { type: String, default: "", trim: true },
    debit: { type: Number, default: 0, min: 0 },
    credit: { type: Number, default: 0, min: 0 },
    narrative: { type: String, default: "" },
    createdBy: { type: String, default: "" },
  },
  { timestamps: true }
);

customerLedgerEntrySchema.index({ customerName: 1, entryDate: 1 });

export default mongoose.model("CustomerLedgerEntry", customerLedgerEntrySchema);
