import mongoose from "mongoose";

const customsInvoiceItemAllocationSchema = new mongoose.Schema(
  {
    customsLotItemId: { type: mongoose.Schema.Types.ObjectId, ref: "CustomsLotItem", default: null },
    customsLotId: { type: mongoose.Schema.Types.ObjectId, ref: "CustomsLot", default: null },
    qty: { type: Number, default: 0, min: 0 },
    /** Snapshot of remaining lot qty after this allocation was computed (preview/post). */
    remainingAfter: { type: Number, default: null },
    boeNumber: { type: String, default: "", trim: true },
    boeDate: { type: Date, default: null },
    blNumber: { type: String, default: "", trim: true },
    awbNumber: { type: String, default: "", trim: true },
    supplierInvoiceNumber: { type: String, default: "", trim: true },
    supplierInvoiceDate: { type: Date, default: null },
    receivedDate: { type: Date, default: null },
    supplierName: { type: String, default: "", trim: true },
    countryOfOrigin: { type: String, default: "", trim: true },
    hsCode: { type: String, default: "", trim: true },
    currency: { type: String, default: "USD", trim: true, uppercase: true },
    unitPrice: { type: Number, default: 0, min: 0 },
    weightKg: { type: Number, default: 0, min: 0 },
    unitWeightKg: { type: Number, default: 0, min: 0 },
    totalWeightKg: { type: Number, default: 0, min: 0 },
    totalValue: { type: Number, default: 0, min: 0 },
    exchangeRateToAED: { type: Number, default: 0, min: 0 },
    customsValueAED: { type: Number, default: 0, min: 0 },
    allocationMode: {
      type: String,
      enum: ["AUTO_FIFO", "MANUAL", "OVERRIDE_DUMMY"],
      default: "AUTO_FIFO",
    },
    overrideReason: { type: String, default: "", trim: true },
    documentLinks: [{ type: mongoose.Schema.Types.ObjectId, ref: "Document" }],
  },
  { _id: true },
);

const customsInvoiceItemSchema = new mongoose.Schema(
  {
    salesInvoiceLineId: { type: mongoose.Schema.Types.Mixed, default: null },
    articleNumber: { type: String, default: "", trim: true, uppercase: true },
    partNumber: { type: String, default: "", trim: true, uppercase: true },
    partName: { type: String, default: "", trim: true },
    description: { type: String, default: "", trim: true },
    qtyExported: { type: Number, default: 0, min: 0 },
    allocations: { type: [customsInvoiceItemAllocationSchema], default: [] },
  },
  { _id: true },
);

const customsInvoiceSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: "Company", required: true, index: true },
    companyCode: { type: String, default: "", trim: true, uppercase: true, index: true },
    customsInvoiceNumber: { type: String, required: true, trim: true, uppercase: true },
    salesInvoiceId: { type: mongoose.Schema.Types.ObjectId, ref: "SalesInvoice", default: null, index: true },
    salesInvoiceNumber: { type: String, default: "", trim: true, index: true },
    customerId: { type: mongoose.Schema.Types.ObjectId, default: null },
    customerName: { type: String, default: "", trim: true },
    invoiceDate: { type: Date, default: Date.now, index: true },
    status: {
      type: String,
      enum: ["DRAFT", "POSTED", "CANCELLED"],
      default: "DRAFT",
      index: true,
    },
    remarks: { type: String, default: "", trim: true },
    items: { type: [customsInvoiceItemSchema], default: [] },
    createdBy: { type: String, default: "" },
    updatedBy: { type: String, default: "" },
  },
  { timestamps: true },
);

customsInvoiceSchema.index({ companyId: 1, customsInvoiceNumber: 1 }, { unique: true });
customsInvoiceSchema.index({ companyId: 1, salesInvoiceId: 1 });

export default mongoose.model("CustomsInvoice", customsInvoiceSchema);
