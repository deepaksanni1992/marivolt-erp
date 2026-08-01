import mongoose from "mongoose";

const stockBalanceSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: "Company", required: true, index: true },
    article: { type: String, required: true, ref: "ItemMaster", trim: true, uppercase: true },
    location: { type: String, required: true, trim: true, uppercase: true },
    // Legacy compatibility fields retained for existing modules.
    itemCode: { type: String, default: "", trim: true, uppercase: true },
    warehouse: { type: String, default: "", trim: true, uppercase: true },
    batchNo: { type: String, default: "", trim: true },
    serialNo: { type: String, default: "", trim: true },
    onHandQty: { type: Number, default: 0 },
    quantity: { type: Number, default: 0 },
    allocatedQty: { type: Number, default: 0 },
    reservedQty: { type: Number, default: 0 },
    /** Qty physically staged in packages (Store Packing posted), not yet dispatched. */
    packedQty: { type: Number, default: 0, min: 0 },
    /** Cumulative qty dispatched from packed stock. Physical on-hand is already reduced. */
    dispatchedQty: { type: Number, default: 0, min: 0 },
    availableQty: { type: Number, default: 0 },
    avgCost: { type: Number, default: 0 },
    unitCost: { type: Number, default: 0 },
    currency: { type: String, default: "USD", trim: true, uppercase: true },
    lastTransactionDate: Date,
  },
  { timestamps: true }
);

stockBalanceSchema.index({ companyId: 1, article: 1, location: 1, batchNo: 1, serialNo: 1 }, { unique: true });
stockBalanceSchema.index({ companyId: 1, article: 1, location: 1 });
stockBalanceSchema.index({ companyId: 1, warehouse: 1, itemCode: 1 });
stockBalanceSchema.index({ companyId: 1, availableQty: 1 });
stockBalanceSchema.index({ companyId: 1, lastTransactionDate: -1 });

export default mongoose.model("StockBalance", stockBalanceSchema);
