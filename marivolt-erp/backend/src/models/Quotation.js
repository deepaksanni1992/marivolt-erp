import mongoose from "mongoose";

const quotationLineSchema = new mongoose.Schema(
  {
    itemCode: { type: String, required: true, trim: true, uppercase: true, index: true },
    itemName: { type: String, default: "", trim: true },
    description: { type: String, default: "" },
    partNo: { type: String, default: "", trim: true },
    article: { type: String, default: "", trim: true, uppercase: true },
    qty: { type: Number, required: true, min: 0.0001 },
    unit: { type: String, default: "PCS", trim: true },
    salePrice: { type: Number, default: 0, min: 0 },
    discountPct: { type: Number, default: 0, min: 0 },
    taxPct: { type: Number, default: 0, min: 0 },
    currency: { type: String, default: "USD", trim: true },
    discountAmount: { type: Number, default: 0, min: 0 },
    taxAmount: { type: Number, default: 0, min: 0 },
    lineTotal: { type: Number, default: 0, min: 0 },
    deliveryTime: { type: String, default: "", trim: true },
    origin: { type: String, default: "", trim: true },
    hsCode: { type: String, default: "", trim: true },
    weight: { type: Number, default: 0, min: 0 },
    remarks: { type: String, default: "" },
    dispatchStatus: { type: String, default: "PENDING", trim: true },
    deliveredQty: { type: Number, default: 0, min: 0 },
    pendingQty: { type: Number, default: 0, min: 0 },
  },
  { _id: true }
);

const partySnapshotSchema = new mongoose.Schema(
  {
    name: { type: String, default: "", trim: true },
    billingAddress: { type: String, default: "", trim: true },
    shippingAddress: { type: String, default: "", trim: true },
    contactPerson: { type: String, default: "", trim: true },
    email: { type: String, default: "", trim: true },
    phone: { type: String, default: "", trim: true },
    country: { type: String, default: "", trim: true },
  },
  { _id: false }
);

const companySnapshotSchema = new mongoose.Schema(
  {
    companyName: { type: String, default: "", trim: true },
    logo: { type: String, default: "", trim: true },
    address: { type: String, default: "", trim: true },
    email: { type: String, default: "", trim: true },
    phone: { type: String, default: "", trim: true },
    registrationNo: { type: String, default: "", trim: true },
  },
  { _id: false }
);

const quotationSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: "Company", required: true, index: true },
    quotationNo: { type: String, required: true, trim: true },
    quotationDate: { type: Date, default: () => new Date() },
    validityDate: { type: Date },
    customerName: { type: String, required: true, trim: true, index: true },
    customerReference: { type: String, default: "", trim: true },
    attention: { type: String, default: "", trim: true },
    paymentTerms: { type: String, default: "", trim: true },
    deliveryTerms: { type: String, default: "", trim: true },
    incoterm: { type: String, default: "", trim: true },
    currency: { type: String, default: "USD", trim: true },
    exchangeRate: { type: Number, default: 1, min: 0 },
    portOfLoading: { type: String, default: "", trim: true },
    portOfDischarge: { type: String, default: "", trim: true },
    finalDestination: { type: String, default: "", trim: true },
    remarks: { type: String, default: "" },
    internalNotes: { type: String, default: "" },

    customer: { type: partySnapshotSchema, default: () => ({}) },
    companySnapshot: { type: companySnapshotSchema, default: () => ({}) },

    lines: { type: [quotationLineSchema], default: [] },
    subTotal: { type: Number, default: 0 },
    discountTotal: { type: Number, default: 0 },
    taxTotal: { type: Number, default: 0 },
    grandTotal: { type: Number, default: 0 },
    status: {
      type: String,
      enum: ["DRAFT", "SENT", "APPROVED", "REJECTED", "EXPIRED", "CONVERTED", "CANCELLED"],
      default: "DRAFT",
    },
    sourceType: { type: String, default: "MANUAL", trim: true },
    convertedTo: [{ type: String, default: "", trim: true }],
    shipmentReference: { type: String, default: "", trim: true },
    createdBy: { type: String, default: "" },
    updatedBy: { type: String, default: "" },
  },
  { timestamps: true }
);

quotationSchema.index({ companyId: 1, quotationNo: 1 }, { unique: true });
quotationSchema.index({ companyId: 1, quotationDate: -1 });

export default mongoose.model("Quotation", quotationSchema);
