import mongoose from "mongoose";

const poLineSchema = new mongoose.Schema(
  {
    itemCode: { type: String, required: true, trim: true, uppercase: true },
    description: { type: String, default: "" },
    qty: { type: Number, required: true, min: 0 },
    unitPrice: { type: Number, default: 0, min: 0 },
    currency: { type: String, default: "USD", trim: true },
    lineTotal: { type: Number, default: 0, min: 0 },
    expectedDeliveryDate: { type: Date },
    receivedQty: { type: Number, default: 0, min: 0 },
    remarks: { type: String, default: "" },
  },
  { _id: true }
);

const purchaseOrderSchema = new mongoose.Schema(
  {
    poNumber: { type: String, required: true, unique: true, trim: true },
    orderDate: { type: Date, default: () => new Date() },
    supplierName: { type: String, required: true, trim: true },
    supplierReference: { type: String, default: "", trim: true },
    currency: { type: String, default: "USD", trim: true },
    lines: { type: [poLineSchema], default: [] },
    subTotal: { type: Number, default: 0 },
    grandTotal: { type: Number, default: 0 },
    status: {
      type: String,
      enum: ["DRAFT", "SAVED", "SENT", "PARTIAL_RECEIVED", "RECEIVED", "CANCELLED"],
      default: "DRAFT",
    },
    remarks: { type: String, default: "" },
    createdBy: { type: String, default: "" },
  },
  { timestamps: true }
);

export default mongoose.model("PurchaseOrder", purchaseOrderSchema);
