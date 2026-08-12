import mongoose from "mongoose";

const customsLotDocumentSchema = new mongoose.Schema(
  {
    blDocumentId: { type: mongoose.Schema.Types.ObjectId, ref: "Document", default: null },
    supplierInvoiceDocumentId: { type: mongoose.Schema.Types.ObjectId, ref: "Document", default: null },
    packingListDocumentId: { type: mongoose.Schema.Types.ObjectId, ref: "Document", default: null },
    otherDocumentIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "Document" }],
  },
  { _id: false },
);

const customsLotSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: "Company", required: true, index: true },
    companyCode: { type: String, default: "", trim: true, uppercase: true, index: true },
    customsLotRef: { type: String, required: true, trim: true, uppercase: true },
    /** Parent CustomsBoe (null/absent = legacy self-contained lot). */
    customsBoeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "CustomsBoe",
      default: null,
      index: true,
    },
    customsBoeRef: { type: String, default: "", trim: true, uppercase: true, index: true },
    grnId: { type: mongoose.Schema.Types.ObjectId, ref: "GRN", required: true, index: true },
    grnNo: { type: String, required: true, trim: true, uppercase: true, index: true },
    poId: { type: mongoose.Schema.Types.ObjectId, ref: "PurchaseOrder", default: null, index: true },
    poNo: { type: String, default: "", trim: true },
    supplierId: { type: mongoose.Schema.Types.ObjectId, ref: "Supplier", default: null, index: true },
    supplierName: { type: String, default: "", trim: true },
    boeNumber: { type: String, default: "", trim: true, index: true },
    boeDate: { type: Date, default: null, index: true },
    blNumber: { type: String, default: "", trim: true, index: true },
    awbNumber: { type: String, default: "", trim: true, index: true },
    supplierInvoiceNumber: { type: String, default: "", trim: true, index: true },
    supplierInvoiceDate: { type: Date, default: null, index: true },
    receivedDate: { type: Date, default: null, index: true },
    countryOfOrigin: { type: String, default: "", trim: true, uppercase: true },
    hsCode: { type: String, default: "", trim: true, uppercase: true },
    unitWeightKg: { type: Number, default: 0, min: 0 },
    customsUnitPrice: { type: Number, default: 0, min: 0 },
    currency: { type: String, default: "USD", trim: true, uppercase: true },
    exchangeRateToAED: { type: Number, default: 0, min: 0 },
    /** Additive BOE-average economics (new posts). Absent ⇒ LEGACY_LINE_VALUE. */
    valuationMethod: {
      type: String,
      enum: ["LEGACY_LINE_VALUE", "BOE_AVERAGE"],
      default: "LEGACY_LINE_VALUE",
      index: true,
    },
    boeDeclaredQty: { type: Number, default: 0, min: 0 },
    customsUom: { type: String, default: "", trim: true, uppercase: true },
    boeDeclaredValue: { type: Number, default: 0, min: 0 },
    /** Frozen BOE average unit value (authoritative for BOE_AVERAGE). */
    customsUnitValue: { type: Number, default: 0, min: 0 },
    grossWeightKg: { type: Number, default: 0, min: 0 },
    netWeightKg: { type: Number, default: 0, min: 0 },
    valuationLockedAt: { type: Date, default: null },
    status: {
      type: String,
      enum: ["OPEN", "PARTIAL", "CONSUMED", "CANCELLED"],
      default: "OPEN",
      index: true,
    },
    remarks: { type: String, default: "", trim: true },
    documents: { type: customsLotDocumentSchema, default: () => ({}) },
    createdBy: { type: String, default: "" },
    updatedBy: { type: String, default: "" },
  },
  { timestamps: true },
);

customsLotSchema.index({ companyId: 1, customsLotRef: 1 }, { unique: true });
customsLotSchema.index({ companyId: 1, grnId: 1 }, { unique: true });
customsLotSchema.index({ companyId: 1, customsBoeId: 1 });

export default mongoose.model("CustomsLot", customsLotSchema);
