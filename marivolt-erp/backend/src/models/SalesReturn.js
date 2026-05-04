import mongoose from "mongoose";

const salesReturnLineSchema = new mongoose.Schema(
  {
    article: { type: String, required: true, trim: true, uppercase: true },
    partNumber: { type: String, default: "", trim: true },
    description: { type: String, default: "" },
    qty: { type: Number, required: true, min: 0.0001 },
    uom: { type: String, default: "PCS", trim: true },
    unitPrice: { type: Number, default: 0, min: 0 },
    lineTotal: { type: Number, default: 0, min: 0 },
    reason: { type: String, default: "" },
  },
  { _id: true }
);

const salesReturnSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: "Company", required: true, index: true },
    returnNo: { type: String, required: true, trim: true },
    returnDate: { type: Date, default: () => new Date(), index: true },
    customerName: { type: String, required: true, trim: true, index: true },
    linkedSalesDispatchId: { type: mongoose.Schema.Types.ObjectId, ref: "SalesDispatch", default: null, index: true },
    linkedSalesDispatchNo: { type: String, default: "", trim: true },
    linkedSalesInvoiceId: { type: mongoose.Schema.Types.ObjectId, ref: "SalesInvoice", default: null },
    linkedSalesInvoiceNo: { type: String, default: "", trim: true },
    warehouse: { type: String, default: "MAIN", trim: true, uppercase: true },
    currency: { type: String, default: "USD", trim: true, uppercase: true },
    lines: { type: [salesReturnLineSchema], default: [] },
    subTotal: { type: Number, default: 0 },
    grandTotal: { type: Number, default: 0 },
    status: {
      type: String,
      enum: ["DRAFT", "POSTED", "CANCELLED"],
      default: "DRAFT",
    },
    remarks: { type: String, default: "" },
    createdBy: { type: String, default: "" },
    updatedBy: { type: String, default: "" },
  },
  { timestamps: true }
);

salesReturnSchema.index({ companyId: 1, returnNo: 1 }, { unique: true });

export default mongoose.model("SalesReturn", salesReturnSchema);
