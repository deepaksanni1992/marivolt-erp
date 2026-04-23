import mongoose from "mongoose";

const proformaLineSchema = new mongoose.Schema(
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

const proformaInvoiceSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: "Company", required: true, index: true },
    proformaNo: { type: String, required: true, trim: true },
    proformaDate: { type: Date, default: () => new Date() },
    linkedQuotationId: { type: mongoose.Schema.Types.ObjectId, ref: "Quotation", index: true },
    linkedQuotationNo: { type: String, default: "", trim: true },
    linkedOAId: { type: mongoose.Schema.Types.ObjectId, ref: "OrderAcknowledgement", index: true, default: null },
    linkedOANo: { type: String, default: "", trim: true },
    customerName: { type: String, required: true, trim: true, index: true },
    paymentTerms: { type: String, default: "" },
    bankDetails: { type: String, default: "" },
    validity: { type: String, default: "" },
    shipmentTerms: { type: String, default: "" },
    remarks: { type: String, default: "" },
    currency: { type: String, default: "USD", trim: true, uppercase: true },
    lines: { type: [proformaLineSchema], default: [] },
    subTotal: { type: Number, default: 0 },
    discountTotal: { type: Number, default: 0 },
    taxTotal: { type: Number, default: 0 },
    grandTotal: { type: Number, default: 0 },
    status: {
      type: String,
      enum: ["DRAFT", "ISSUED", "PAID_PENDING_SHIPMENT", "CONVERTED", "CANCELLED"],
      default: "DRAFT",
    },
    createdBy: { type: String, default: "" },
    updatedBy: { type: String, default: "" },
  },
  { timestamps: true }
);

proformaInvoiceSchema.index({ companyId: 1, proformaNo: 1 }, { unique: true });
proformaInvoiceSchema.index({ companyId: 1, proformaDate: -1 });

export default mongoose.model("ProformaInvoice", proformaInvoiceSchema);
