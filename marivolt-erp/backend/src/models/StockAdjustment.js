import mongoose from "mongoose";

const stockAdjustmentSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: "Company", required: true, index: true },
    adjustmentNo: { type: String, required: true, trim: true, uppercase: true },
    date: { type: Date, required: true },
    article: { type: String, required: true, ref: "ItemMaster", trim: true, uppercase: true },
    location: { type: String, required: true, trim: true, uppercase: true },
    adjustmentType: { type: String, enum: ["Increase", "Decrease"], required: true },
    quantity: { type: Number, required: true, min: 0 },
    reason: { type: String, default: "", trim: true },
    remarks: { type: String, default: "", trim: true },
    status: { type: String, enum: ["Draft", "Posted"], default: "Draft" },
    postedAt: Date,
  },
  { timestamps: true }
);

stockAdjustmentSchema.index({ companyId: 1, adjustmentNo: 1 }, { unique: true });

export default mongoose.model("StockAdjustment", stockAdjustmentSchema);
