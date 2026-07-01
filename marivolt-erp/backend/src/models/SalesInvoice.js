import mongoose from "mongoose";

const salesInvoiceLineSchema = new mongoose.Schema(
  {
    serialNo: { type: Number, default: 0, min: 0 },
    packingLineId: { type: mongoose.Schema.Types.ObjectId, default: null },
    allocationLineId: { type: mongoose.Schema.Types.ObjectId, default: null },
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

const salesInvoiceSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: "Company", required: true, index: true },
    invoiceNo: { type: String, required: true, trim: true },
    invoiceNumber: { type: String, required: true, trim: true },
    invoiceDate: { type: Date, default: () => new Date(), index: true },
    linkedQuotationId: { type: mongoose.Schema.Types.ObjectId, ref: "Quotation", index: true, default: null },
    linkedQuotationNo: { type: String, default: "", trim: true },
    linkedOAId: { type: mongoose.Schema.Types.ObjectId, ref: "OrderAcknowledgement", index: true, default: null },
    linkedOANo: { type: String, default: "", trim: true },
    linkedProformaId: { type: mongoose.Schema.Types.ObjectId, ref: "ProformaInvoice", index: true, default: null },
    linkedProformaNo: { type: String, default: "", trim: true },
    linkedOrderAllocationId: { type: mongoose.Schema.Types.ObjectId, ref: "OrderAllocation", index: true, default: null },
    linkedOrderAllocationNo: { type: String, default: "", trim: true },
    linkedRtsId: { type: mongoose.Schema.Types.ObjectId, ref: "Rts", index: true, default: null },
    linkedRtsNo: { type: String, default: "", trim: true },
    linkedStorePackingId: { type: mongoose.Schema.Types.ObjectId, ref: "StorePacking", index: true, default: null },
    linkedStorePackingNo: { type: String, default: "", trim: true },
    linkedSalesDispatchId: { type: mongoose.Schema.Types.ObjectId, ref: "SalesDispatch", index: true, default: null },
    linkedSalesDispatchNo: { type: String, default: "", trim: true },
    customerName: { type: String, required: true, trim: true },
    paymentTerms: { type: String, default: "" },
    dispatchDetails: { type: String, default: "" },
    shippingAddress: { type: String, default: "" },
    billingAddress: { type: String, default: "" },
    customerReference: { type: String, default: "", trim: true },
    loadingPort: { type: String, default: "", trim: true },
    dischargePort: { type: String, default: "", trim: true },
    consignee: { type: String, default: "" },
    customerVatNo: { type: String, default: "", trim: true },
    currency: { type: String, default: "USD", trim: true, uppercase: true },
    vertical: { type: String, default: "", trim: true },
    engine: { type: String, default: "", trim: true },
    model: { type: String, default: "", trim: true },
    config: { type: String, default: "", trim: true },
    esn: { type: String, default: "", trim: true },
    lines: { type: [salesInvoiceLineSchema], default: [] },
    subTotal: { type: Number, default: 0 },
    discountTotal: { type: Number, default: 0 },
    taxTotal: { type: Number, default: 0 },
    packingCost: { type: Number, default: 0, min: 0 },
    clearanceCost: { type: Number, default: 0, min: 0 },
    grandTotal: { type: Number, default: 0 },
    /** Sum of allocations[].allocatedAmount across all non-cancelled receipts. Recomputed on every receipt change. */
    totalReceivedAmount: { type: Number, default: 0, min: 0 },
    /** Always grandTotal − totalReceivedAmount (clamped at 0). Phase-8.2. */
    balanceAmount: { type: Number, default: 0, min: 0 },
    /** Phase-8.2 canonical UNPAID / PARTIAL / PAID, derived from received vs grandTotal. */
    paymentStatus: {
      type: String,
      enum: ["UNPAID", "PARTIAL", "PAID"],
      default: "UNPAID",
      index: true,
    },
    status: {
      type: String,
      enum: ["DRAFT", "ISSUED", "DISPATCHED", "PARTIALLY_PAID", "PAID", "CANCELLED"],
      default: "DRAFT",
    },
    /** When set, inventory was reduced via SALES_INVOICE_OUT (supports safe cancel reversal). */
    stockPostedAt: { type: Date, default: null },
    cancelledAt: { type: Date, default: null },
    cancelledBy: { type: String, default: "" },
    cancellationReason: { type: String, default: "" },
    convertedFromRtsAt: { type: Date, default: null },
    convertedFromRtsBy: { type: String, default: "" },
    remarks: { type: String, default: "" },
    termsAndConditions: { type: String, default: "" },
    createdBy: { type: String, default: "" },
    updatedBy: { type: String, default: "" },
  },
  { timestamps: true }
);

salesInvoiceSchema.pre("validate", function syncInvoiceNumber() {
  const invoiceNo = String(this.invoiceNo || this.invoiceNumber || "").trim();
  this.invoiceNo = invoiceNo;
  this.invoiceNumber = invoiceNo;
});

salesInvoiceSchema.index({ companyId: 1, invoiceNo: 1 }, { unique: true });
salesInvoiceSchema.index({ companyId: 1, invoiceNumber: 1 }, { unique: true });
salesInvoiceSchema.index({ companyId: 1, invoiceDate: -1 });
salesInvoiceSchema.index({ companyId: 1, paymentStatus: 1, invoiceDate: -1 });

export default mongoose.model("SalesInvoice", salesInvoiceSchema);
