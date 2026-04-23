import mongoose from "mongoose";

const ciplLineSchema = new mongoose.Schema(
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

const ciplSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: "Company", required: true, index: true },
    ciplNo: { type: String, required: true, trim: true },
    ciplDate: { type: Date, default: () => new Date(), index: true },
    linkedQuotationId: { type: mongoose.Schema.Types.ObjectId, ref: "Quotation", index: true, default: null },
    linkedQuotationNo: { type: String, default: "", trim: true },
    linkedOAId: { type: mongoose.Schema.Types.ObjectId, ref: "OrderAcknowledgement", index: true, default: null },
    linkedOANo: { type: String, default: "", trim: true },
    linkedSalesInvoiceId: { type: mongoose.Schema.Types.ObjectId, ref: "SalesInvoice", index: true, default: null },
    linkedSalesInvoiceNo: { type: String, default: "", trim: true },
    customerName: { type: String, required: true, trim: true },
    consigneeName: { type: String, default: "", trim: true },
    shipmentMode: { type: String, default: "", trim: true },
    incoterm: { type: String, default: "", trim: true },
    currency: { type: String, default: "USD", trim: true, uppercase: true },
    lines: { type: [ciplLineSchema], default: [] },
    subTotal: { type: Number, default: 0 },
    discountTotal: { type: Number, default: 0 },
    taxTotal: { type: Number, default: 0 },
    grandTotal: { type: Number, default: 0 },
    status: {
      type: String,
      enum: ["DRAFT", "ISSUED", "SHIPPED", "CANCELLED"],
      default: "DRAFT",
    },
    remarks: { type: String, default: "" },
    createdBy: { type: String, default: "" },
    updatedBy: { type: String, default: "" },
  },
  { timestamps: true }
);

ciplSchema.index({ companyId: 1, ciplNo: 1 }, { unique: true });
ciplSchema.index({ companyId: 1, ciplDate: -1 });

export default mongoose.model("Cipl", ciplSchema);
