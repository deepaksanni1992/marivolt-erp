import mongoose from "mongoose";

const grnItemSchema = new mongoose.Schema(
  {
    sku: String,
    name: String,
    qty: Number,
    uom: String,
    poNo: String,
  },
  { _id: false }
);

const grnSchema = new mongoose.Schema(
  {
    grnNo: { type: String, required: true, unique: true },
    supplier: String,
    poNo: String,
    items: [grnItemSchema],
    note: String,
    createdBy: String,
  },
  { timestamps: true }
);

export default mongoose.model("GRN", grnSchema);
