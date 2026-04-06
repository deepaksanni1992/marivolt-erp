import mongoose from "mongoose";

const cashBankEntrySchema = new mongoose.Schema(
  {
    entryDate: { type: Date, required: true, default: () => new Date() },
    accountName: { type: String, required: true, trim: true },
    transactionType: {
      type: String,
      enum: ["RECEIPT", "PAYMENT"],
      required: true,
    },
    referenceNumber: { type: String, default: "", trim: true },
    partyName: { type: String, default: "", trim: true },
    amount: { type: Number, required: true, min: 0 },
    mode: { type: String, default: "", trim: true },
    remarks: { type: String, default: "" },
    createdBy: { type: String, default: "" },
  },
  { timestamps: true }
);

cashBankEntrySchema.index({ entryDate: -1 });

export default mongoose.model("CashBankEntry", cashBankEntrySchema);
