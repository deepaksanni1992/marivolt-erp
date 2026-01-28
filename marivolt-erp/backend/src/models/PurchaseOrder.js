import mongoose from "mongoose";

const poItemSchema = new mongoose.Schema(
  {
    sku: String,
    name: String,
    qty: Number,
    uom: String,
    price: Number,
  },
  { _id: false }
);

const purchaseOrderSchema = new mongoose.Schema(
  {
    poNo: { type: String, required: true, unique: true },
    supplier: { type: String, required: true },
    items: [poItemSchema],
    status: {
      type: String,
      enum: ["DRAFT", "SENT", "PARTIAL", "CLOSED"],
      default: "DRAFT",
    },
    note: String,
    createdBy: { type: String },
  },
  { timestamps: true }
);

export default mongoose.model("PurchaseOrder", purchaseOrderSchema);
