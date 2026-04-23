import mongoose from "mongoose";

const purchaseInvoiceLineSchema = new mongoose.Schema(
  {
    itemCode: { type: String, default: "", trim: true, uppercase: true },
    description: { type: String, default: "" },
    qty: { type: Number, default: 0, min: 0 },
    rate: { type: Number, default: 0, min: 0 },
    amount: { type: Number, default: 0, min: 0 },
  },
  { _id: true }
);

const purchaseInvoiceSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: "Company", required: true, index: true },
    invoiceNumber: { type: String, required: true, trim: true },
    invoiceDate: { type: Date, default: () => new Date() },
    supplierName: { type: String, required: true, trim: true },
    linkedPoNumber: { type: String, default: "" },
    currency: { type: String, default: "USD", trim: true },
    lines: { type: [purchaseInvoiceLineSchema], default: [] },
    subTotal: { type: Number, default: 0 },
    taxAmount: { type: Number, default: 0 },
    totalAmount: { type: Number, default: 0 },
    paymentStatus: {
      type: String,
      enum: ["UNPAID", "PARTIAL", "PAID"],
      default: "UNPAID",
    },
    remarks: { type: String, default: "" },
    createdBy: { type: String, default: "" },
  },
  { timestamps: true }
);

purchaseInvoiceSchema.index({ companyId: 1, invoiceNumber: 1 }, { unique: true });

export default mongoose.model("PurchaseInvoice", purchaseInvoiceSchema);
