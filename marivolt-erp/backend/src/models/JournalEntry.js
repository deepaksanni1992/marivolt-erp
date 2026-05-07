import mongoose from "mongoose";

const journalLineSchema = new mongoose.Schema(
  {
    accountId: { type: String, default: "", trim: true },
    accountName: { type: String, required: true, trim: true },
    debit: { type: Number, default: 0, min: 0 },
    credit: { type: Number, default: 0, min: 0 },
  },
  { _id: true }
);

const journalEntrySchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: "Company", required: true, index: true },
    entryNo: { type: String, required: true, trim: true, index: true },
    entryDate: { type: Date, required: true, default: () => new Date(), index: true },
    sourceModule: { type: String, default: "Accounts", trim: true },
    sourceType: { type: String, default: "Payment Receipt", trim: true },
    sourceId: { type: mongoose.Schema.Types.ObjectId, default: null, index: true },
    referenceNo: { type: String, default: "", trim: true, index: true },
    customerId: { type: mongoose.Schema.Types.ObjectId, ref: "Customer", default: null, index: true },
    currency: { type: String, default: "USD", trim: true, uppercase: true },
    narration: { type: String, default: "" },
    lines: { type: [journalLineSchema], default: [] },
    status: { type: String, enum: ["POSTED", "REVERSED"], default: "POSTED", index: true },
    reversedByEntryId: { type: mongoose.Schema.Types.ObjectId, ref: "JournalEntry", default: null },
    reversedFromEntryId: { type: mongoose.Schema.Types.ObjectId, ref: "JournalEntry", default: null },
    createdBy: { type: String, default: "" },
    updatedBy: { type: String, default: "" },
  },
  { timestamps: true }
);

journalEntrySchema.index({ companyId: 1, entryNo: 1 }, { unique: true });

export default mongoose.model("JournalEntry", journalEntrySchema);
