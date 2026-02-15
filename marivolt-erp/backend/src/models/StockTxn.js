import mongoose from "mongoose";

const stockTxnSchema = new mongoose.Schema(
  {
    sku: { type: String, default: "", index: true },
    article: { type: String, default: "", index: true }, // used for BOM Kitting/De-Kitting
    type: { type: String, enum: ["IN", "OUT"], required: true },
    qty: { type: Number, required: true, min: 1 },
    ref: { type: String, default: "" },   // e.g. PO:PO-001 or KIT:id
    supplier: { type: String, default: "", index: true },
    note: { type: String, default: "" },
  },
  { timestamps: true }
);

export default mongoose.model("StockTxn", stockTxnSchema);
