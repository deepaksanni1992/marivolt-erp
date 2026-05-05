import mongoose from "mongoose";

const stockTransferSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: "Company", required: true, index: true },
    transferNo: { type: String, required: true, trim: true, uppercase: true },
    date: { type: Date, required: true },
    article: { type: String, required: true, ref: "ItemMaster", trim: true, uppercase: true },
    fromLocation: { type: String, required: true, trim: true, uppercase: true },
    toLocation: { type: String, required: true, trim: true, uppercase: true },
    quantity: { type: Number, required: true, min: 0 },
    remarks: { type: String, default: "", trim: true },
    status: { type: String, enum: ["Draft", "Posted"], default: "Draft" },
    postedAt: Date,
  },
  { timestamps: true }
);

stockTransferSchema.index({ companyId: 1, transferNo: 1 }, { unique: true });

export default mongoose.model("StockTransfer", stockTransferSchema);
