import mongoose from "mongoose";

const prLineSchema = new mongoose.Schema(
  {
    itemCode: { type: String, required: true, trim: true, uppercase: true },
    description: { type: String, default: "" },
    qty: { type: Number, required: true, min: 0.0001 },
    unitPrice: { type: Number, default: 0, min: 0 },
    lineTotal: { type: Number, default: 0, min: 0 },
    reason: { type: String, default: "" },
  },
  { _id: true }
);

const purchaseReturnSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: "Company", required: true, index: true },
    returnNumber: { type: String, required: true, trim: true },
    returnDate: { type: Date, default: () => new Date() },
    supplierName: { type: String, required: true, trim: true },
    linkedPoNumber: { type: String, default: "", trim: true },
    linkedPoId: { type: mongoose.Schema.Types.ObjectId, ref: "PurchaseOrder" },
    warehouse: { type: String, default: "MAIN", trim: true, uppercase: true },
    currency: { type: String, default: "USD", trim: true },
    lines: { type: [prLineSchema], default: [] },
    subTotal: { type: Number, default: 0 },
    grandTotal: { type: Number, default: 0 },
    status: {
      type: String,
      enum: ["DRAFT", "APPROVED", "POSTED", "CANCELLED"],
      default: "DRAFT",
    },
    remarks: { type: String, default: "" },
    createdBy: { type: String, default: "" },
  },
  { timestamps: true }
);

purchaseReturnSchema.index({ companyId: 1, returnNumber: 1 }, { unique: true });
purchaseReturnSchema.index({ companyId: 1, supplierName: 1, returnDate: -1 });
purchaseReturnSchema.index({ status: 1 });

export default mongoose.model("PurchaseReturn", purchaseReturnSchema);
