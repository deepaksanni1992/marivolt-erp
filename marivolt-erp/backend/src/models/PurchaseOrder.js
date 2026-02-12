import mongoose from "mongoose";

const poItemSchema = new mongoose.Schema(
  {
    sku: { type: String, default: "" },
    articleNo: { type: String, default: "" },
    description: { type: String, default: "" },
    partNo: { type: String, default: "" },
    qty: { type: Number, default: 0 },
    uom: { type: String, default: "" },
    unitRate: { type: Number, default: 0 },
    remark: { type: String, default: "" },
    total: { type: Number, default: 0 },
  },
  { _id: false }
);

const purchaseOrderSchema = new mongoose.Schema(
  {
    poNo: { type: String, required: true, unique: true },
    ref: { type: String, default: "" },
    intRef: { type: String, default: "" },
    offerDate: { type: String, default: "" },
    orderDate: { type: String, default: "" },
    currency: { type: String, default: "USD" },

    supplierId: { type: mongoose.Schema.Types.ObjectId, ref: "Supplier" },
    supplierName: { type: String, required: true },
    supplierAddress: { type: String, default: "" },
    supplierPhone: { type: String, default: "" },
    supplierEmail: { type: String, default: "" },
    contactPerson: { type: String, default: "" },

    items: [poItemSchema],
    subTotal: { type: Number, default: 0 },
    grandTotal: { type: Number, default: 0 },

    delivery: { type: String, default: "" },
    insurance: { type: String, default: "" },
    packing: { type: String, default: "" },
    freight: { type: String, default: "" },
    taxes: { type: String, default: "" },
    payment: { type: String, default: "" },
    specialRemarks: { type: String, default: "" },
    termsAndConditions: { type: String, default: "" },
    closingNote: { type: String, default: "" },

    status: {
      type: String,
      enum: ["DRAFT", "SAVED", "SENT", "PARTIAL", "CLOSED"],
      default: "DRAFT",
    },
    createdBy: { type: String },
  },
  { timestamps: true }
);

export default mongoose.model("PurchaseOrder", purchaseOrderSchema);
