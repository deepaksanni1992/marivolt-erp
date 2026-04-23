import mongoose from "mongoose";

const stockBalanceSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: "Company", required: true, index: true },
    itemCode: { type: String, required: true, trim: true, uppercase: true },
    warehouse: { type: String, required: true, trim: true, default: "MAIN" },
    location: { type: String, default: "", trim: true },
    quantity: { type: Number, default: 0 },
    reservedQty: { type: Number, default: 0 },
    unitCost: { type: Number, default: 0 },
  },
  { timestamps: true }
);

stockBalanceSchema.index({ companyId: 1, itemCode: 1, warehouse: 1 }, { unique: true });

export default mongoose.model("StockBalance", stockBalanceSchema);
