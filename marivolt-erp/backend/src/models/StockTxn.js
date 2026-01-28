import mongoose from "mongoose";

const stockTxnSchema = new mongoose.Schema(
  {
    sku: { type: String, required: true, index: true },
    type: { type: String, enum: ["IN", "OUT"], required: true },
    qty: { type: Number, required: true, min: 1 },
    ref: { type: String, default: "" },   // e.g. PO:PO-001 or INV:INV-001
    note: { type: String, default: "" },
  },
  { timestamps: true }
);

export default mongoose.model("StockTxn", stockTxnSchema);
