import mongoose from "mongoose";

const grnAttachmentSchema = new mongoose.Schema(
  {
    documentId: { type: mongoose.Schema.Types.ObjectId, ref: "Document", default: null },
    documentType: { type: String, default: "" },
    fileName: { type: String, default: "" },
    uploadedAt: { type: Date, default: null },
    remarks: { type: String, default: "" },
  },
  { _id: true }
);

const grnCustomsCaptureSchema = new mongoose.Schema(
  {
    receivedDate: { type: Date, default: null },
    boeNumber: { type: String, default: "", trim: true },
    boeDate: { type: Date, default: null },
    blNumber: { type: String, default: "", trim: true },
    awbNumber: { type: String, default: "", trim: true },
    supplierInvoiceNumber: { type: String, default: "", trim: true },
    supplierInvoiceDate: { type: Date, default: null },
    countryOfOrigin: { type: String, default: "", trim: true, uppercase: true },
    hsCode: { type: String, default: "", trim: true, uppercase: true },
    unitWeightKg: { type: Number, default: 0, min: 0 },
    totalWeightKg: { type: Number, default: 0, min: 0 },
    customsUnitPrice: { type: Number, default: 0, min: 0 },
    customsTotalPrice: { type: Number, default: 0, min: 0 },
    customsCurrency: { type: String, default: "", trim: true, uppercase: true },
    exchangeRateToAED: { type: Number, default: 0, min: 0 },
    customsValueAED: { type: Number, default: 0, min: 0 },
    customsRemarks: { type: String, default: "", trim: true },
  },
  { _id: false }
);

const grnItemSchema = new mongoose.Schema(
  {
    article: { type: String, required: true, ref: "ItemMaster", trim: true, uppercase: true },
    description: { type: String, default: "", trim: true },
    partNumber: { type: String, default: "", trim: true, uppercase: true },
    spn: { type: String, default: "", trim: true },
    materialCode: { type: String, default: "", trim: true },
    drawingNo: { type: String, default: "", trim: true },
    uom: { type: String, default: "PCS", trim: true, uppercase: true },
    orderedQty: { type: Number, default: 0, min: 0 },
    receivedQty: { type: Number, required: true, min: 0 },
    pendingQty: { type: Number, default: 0, min: 0 },
    acceptedQty: { type: Number, required: true, min: 0 },
    rejectedQty: { type: Number, default: 0, min: 0 },
    cancelledQty: { type: Number, default: 0, min: 0 },
    unitCost: { type: Number, default: 0, min: 0 },
    lineAmount: { type: Number, default: 0, min: 0 },
    currency: { type: String, default: "USD", trim: true, uppercase: true },
    exchangeRate: { type: Number, default: 1, min: 0 },
    freight: { type: Number, default: 0, min: 0 },
    customs: { type: Number, default: 0, min: 0 },
    landedAdjustment: { type: Number, default: 0, min: 0 },
    location: { type: String, default: "", trim: true },
    warehouse: { type: String, default: "", trim: true, uppercase: true },
    warehouseId: { type: mongoose.Schema.Types.ObjectId, ref: "Warehouse", default: null },
    batchNo: { type: String, default: "", trim: true },
    serialNo: { type: String, default: "", trim: true },
    manufacturingDate: { type: Date, default: null },
    expiryDate: { type: Date, default: null },
    poId: { type: mongoose.Schema.Types.ObjectId, ref: "PurchaseOrder", default: null },
    poLineId: { type: mongoose.Schema.Types.ObjectId, default: null },
    poNo: String,
    remarks: { type: String, default: "", trim: true },
    recoveryInfo: { type: [String], default: [] },
    /** Resolved effective customs values at post — immutable snapshot; not header-dependent. */
    customsCapture: { type: grnCustomsCaptureSchema, default: null },
  },
  { _id: false }
);

const grnSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: "Company", required: true, index: true },
    branchId: { type: mongoose.Schema.Types.ObjectId, ref: "Branch", default: null, index: true },
    warehouseId: { type: mongoose.Schema.Types.ObjectId, ref: "Warehouse", default: null, index: true },
    grnNo: { type: String, required: true },
    poId: { type: mongoose.Schema.Types.ObjectId, ref: "PurchaseOrder", default: null, index: true },
    grnDate: { type: Date, required: true },
    supplierId: { type: mongoose.Schema.Types.ObjectId, ref: "Supplier", default: null, index: true },
    supplierName: { type: String, default: "", trim: true },
    supplierInvoiceNo: { type: String, default: "", trim: true },
    supplierDeliveryNote: { type: String, default: "", trim: true },
    transporter: { type: String, default: "", trim: true },
    vehicleDetails: { type: String, default: "", trim: true },
    packingListNo: { type: String, default: "", trim: true },
    blAwbNo: { type: String, default: "", trim: true },
    customsDocRef: { type: String, default: "", trim: true },
    poNo: String,
    currency: { type: String, default: "USD", trim: true, uppercase: true },
    exchangeRate: { type: Number, default: 1, min: 0 },
    freight: { type: Number, default: 0, min: 0 },
    customs: { type: Number, default: 0, min: 0 },
    landedAdjustment: { type: Number, default: 0, min: 0 },
    remarks: { type: String, default: "", trim: true },
    status: {
      type: String,
      enum: ["DRAFT", "POSTED", "RECEIVED", "PARTIAL_RECEIVED", "CANCELLED", "CLOSED"],
      default: "DRAFT",
      index: true,
    },
    approvalStatus: {
      type: String,
      enum: ["NOT_REQUIRED", "PENDING_RECEIVE", "PENDING_CANCEL", "APPROVED", "REJECTED"],
      default: "NOT_REQUIRED",
      index: true,
    },
    items: [grnItemSchema],
    attachments: { type: [grnAttachmentSchema], default: [] },
    createdBy: String,
    updatedBy: { type: String, default: "" },
    postedAt: Date,
    cancelledAt: Date,
    cancellationReason: { type: String, default: "", trim: true },
  },
  { timestamps: true }
);

grnSchema.index({ grnNo: 1 }, { unique: true });
grnSchema.index({ companyId: 1, grnNo: 1 }, { unique: true });

export default mongoose.model("GRN", grnSchema);
