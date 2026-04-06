import mongoose from "mongoose";

const salesInvoiceLineSchema = new mongoose.Schema(
  {
    itemCode: { type: String, default: "", trim: true, uppercase: true },
    description: { type: String, default: "" },
    qty: { type: Number, default: 0, min: 0 },
    rate: { type: Number, default: 0, min: 0 },
    amount: { type: Number, default: 0, min: 0 },
  },
  { _id: true }
);

const salesInvoiceSchema = new mongoose.Schema(
  {
    invoiceNumber: { type: String, required: true, unique: true, trim: true },
    invoiceDate: { type: Date, default: () => new Date() },
    customerName: { type: String, required: true, trim: true },
    linkedQuotationNumber: { type: String, default: "" },
    currency: { type: String, default: "USD", trim: true },
    lines: { type: [salesInvoiceLineSchema], default: [] },
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

export default mongoose.model("SalesInvoice", salesInvoiceSchema);
