import mongoose from "mongoose";

const customsLotItemSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: "Company", required: true, index: true },
    companyCode: { type: String, default: "", trim: true, uppercase: true, index: true },
    customsLotId: { type: mongoose.Schema.Types.ObjectId, ref: "CustomsLot", required: true, index: true },
    customsLotRef: { type: String, default: "", trim: true, uppercase: true },
    grnId: { type: mongoose.Schema.Types.ObjectId, ref: "GRN", required: true, index: true },
    grnNo: { type: String, default: "", trim: true, uppercase: true },
    grnLineId: { type: mongoose.Schema.Types.Mixed, default: null },
    articleNumber: { type: String, required: true, trim: true, uppercase: true, index: true },
    partNumber: { type: String, default: "", trim: true, uppercase: true, index: true },
    partName: { type: String, default: "", trim: true },
    description: { type: String, default: "", trim: true },
    hsCode: { type: String, default: "", trim: true, uppercase: true },
    currency: { type: String, default: "USD", trim: true, uppercase: true },
    unitPrice: { type: Number, default: 0, min: 0 },
    qtyImported: { type: Number, required: true, min: 0 },
    qtyAvailable: { type: Number, required: true, min: 0 },
    qtyConsumed: { type: Number, default: 0, min: 0 },
    /** @deprecated Prefer unitWeightKg; kept for legacy stock UI. */
    weightKg: { type: Number, default: 0, min: 0 },
    unitWeightKg: { type: Number, default: 0, min: 0 },
    totalWeightKg: { type: Number, default: 0, min: 0 },
    totalValue: { type: Number, default: 0, min: 0 },
    exchangeRateToAED: { type: Number, default: 0, min: 0 },
    customsValueAED: { type: Number, default: 0, min: 0 },
    customStock: { type: Number, default: 0, min: 0 },
    customStockBalance: { type: Number, default: 0, min: 0 },
    supplierInvoiceNumber: { type: String, default: "", trim: true },
    supplierInvoiceDate: { type: Date, default: null, index: true },
    receivedDate: { type: Date, default: null, index: true },
    boeNumber: { type: String, default: "", trim: true },
    boeDate: { type: Date, default: null },
    blNumber: { type: String, default: "", trim: true },
    awbNumber: { type: String, default: "", trim: true },
    countryOfOrigin: { type: String, default: "", trim: true, uppercase: true },
    status: {
      type: String,
      enum: ["IN_STOCK", "PARTIAL", "CONSUMED", "OVERRIDDEN", "CANCELLED"],
      default: "IN_STOCK",
      index: true,
    },
    remarks1: { type: String, default: "", trim: true },
    remarks2: { type: String, default: "", trim: true },
    customsRemarks: { type: String, default: "", trim: true },
    /** Article Stock Conversion lineage (additive; GRN inbound unchanged). */
    originalReceivedArticle: { type: String, default: "", trim: true, uppercase: true },
    conversionNo: { type: String, default: "", trim: true, uppercase: true, index: true },
    conversionDocumentId: { type: mongoose.Schema.Types.ObjectId, default: null, index: true },
    convertedFromLotItemId: { type: mongoose.Schema.Types.ObjectId, default: null },
    isConversionLayer: { type: Boolean, default: false },
  },
  { timestamps: true },
);

customsLotItemSchema.index({ companyId: 1, customsLotId: 1, articleNumber: 1, grnLineId: 1 });
customsLotItemSchema.index({ companyId: 1, articleNumber: 1, qtyAvailable: 1, supplierInvoiceDate: 1 });

export default mongoose.model("CustomsLotItem", customsLotItemSchema);
