import mongoose from "mongoose";

const oaLineSchema = new mongoose.Schema(
  {
    serialNo: { type: Number, default: 0, min: 0 },
    article: { type: String, required: true, trim: true, uppercase: true },
    partNumber: { type: String, default: "", trim: true },
    description: { type: String, default: "" },
    qty: { type: Number, required: true, min: 0.0001 },
    uom: { type: String, default: "PCS", trim: true },
    price: { type: Number, default: 0, min: 0 },
    totalPrice: { type: Number, default: 0, min: 0 },
    remarks: { type: String, default: "" },
    materialCode: { type: String, default: "", trim: true },
    availability: { type: String, default: "", trim: true },
  },
  { _id: true }
);

const orderAcknowledgementSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: "Company", required: true, index: true },
    oaNo: { type: String, required: true, trim: true },
    oaDate: { type: Date, default: () => new Date() },
    linkedQuotationId: { type: mongoose.Schema.Types.ObjectId, ref: "Quotation", index: true },
    linkedQuotationNo: { type: String, default: "", trim: true },
    customerName: { type: String, required: true, trim: true, index: true },
    customerPORef: { type: String, default: "", trim: true },
    customerPODate: { type: Date, default: null },
    acknowledgementNotes: { type: String, default: "" },
    deliverySchedule: { type: String, default: "" },
    paymentTerms: { type: String, default: "" },
    incoterm: { type: String, default: "" },
    dispatchTerms: { type: String, default: "" },
    currency: { type: String, default: "USD", trim: true, uppercase: true },
    lines: { type: [oaLineSchema], default: [] },
    subTotal: { type: Number, default: 0 },
    discountTotal: { type: Number, default: 0 },
    taxTotal: { type: Number, default: 0 },
    grandTotal: { type: Number, default: 0 },
    status: {
      type: String,
      enum: ["DRAFT", "CONFIRMED", "CLOSED", "CANCELLED"],
      default: "DRAFT",
    },
    convertedTo: [{ type: String, default: "", trim: true }],
    createdBy: { type: String, default: "" },
    updatedBy: { type: String, default: "" },
  },
  { timestamps: true }
);

orderAcknowledgementSchema.index({ companyId: 1, oaNo: 1 }, { unique: true });
orderAcknowledgementSchema.index({ companyId: 1, oaDate: -1 });

export default mongoose.model("OrderAcknowledgement", orderAcknowledgementSchema);
