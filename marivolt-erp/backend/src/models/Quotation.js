import mongoose from "mongoose";

const quotationLineSchema = new mongoose.Schema(
  {
    itemCode: { type: String, required: true, trim: true, uppercase: true },
    description: { type: String, default: "" },
    qty: { type: Number, required: true, min: 0 },
    salePrice: { type: Number, default: 0, min: 0 },
    currency: { type: String, default: "USD", trim: true },
    lineTotal: { type: Number, default: 0, min: 0 },
    remarks: { type: String, default: "" },
  },
  { _id: true }
);

const quotationSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: "Company", required: true, index: true },
    quotationNumber: { type: String, required: true, trim: true },
    quotationDate: { type: Date, default: () => new Date() },
    customerName: { type: String, required: true, trim: true },
    customerReference: { type: String, default: "", trim: true },
    currency: { type: String, default: "USD", trim: true },
    lines: { type: [quotationLineSchema], default: [] },
    subTotal: { type: Number, default: 0 },
    grandTotal: { type: Number, default: 0 },
    status: {
      type: String,
      enum: ["DRAFT", "SENT", "ACCEPTED", "REJECTED", "EXPIRED", "CANCELLED"],
      default: "DRAFT",
    },
    validUntil: { type: Date },
    remarks: { type: String, default: "" },
    createdBy: { type: String, default: "" },
  },
  { timestamps: true }
);

quotationSchema.index({ companyId: 1, quotationNumber: 1 }, { unique: true });

export default mongoose.model("Quotation", quotationSchema);
