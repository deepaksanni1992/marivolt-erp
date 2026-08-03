import mongoose from "mongoose";

const packingAttachmentSchema = new mongoose.Schema(
  {
    documentId: { type: mongoose.Schema.Types.ObjectId, ref: "Document", default: null },
    fileName: { type: String, default: "" },
    uploadedAt: { type: Date, default: null },
    remarks: { type: String, default: "" },
  },
  { _id: true }
);

const storePackingLineSchema = new mongoose.Schema(
  {
    allocationLineId: { type: mongoose.Schema.Types.ObjectId, default: null },
    article: { type: String, required: true, trim: true, uppercase: true },
    description: { type: String, default: "" },
    spn: { type: String, default: "", trim: true },
    materialCode: { type: String, default: "", trim: true },
    allocatedQty: { type: Number, default: 0, min: 0 },
    packQty: { type: Number, required: true, min: 0 },
    /**
     * S3 — Sum of successfully posted dispatch qty claimed against this packing line.
     * Updated atomically inside dispatch post/cancel transactions only.
     */
    dispatchedQty: { type: Number, default: 0, min: 0 },
    uom: { type: String, default: "PCS", trim: true },
    remarks: { type: String, default: "", trim: true },
  },
  { _id: true }
);

const packageItemSchema = new mongoose.Schema(
  {
    allocationLineId: { type: mongoose.Schema.Types.ObjectId, default: null },
    article: { type: String, required: true, trim: true, uppercase: true },
    description: { type: String, default: "" },
    spn: { type: String, default: "", trim: true },
    materialCode: { type: String, default: "", trim: true },
    qty: { type: Number, required: true, min: 0 },
    uom: { type: String, default: "PCS", trim: true },
    remarks: { type: String, default: "", trim: true },
  },
  { _id: true }
);

const packingPackageSchema = new mongoose.Schema(
  {
    packageNo: { type: String, required: true, trim: true },
    packageType: {
      type: String,
      enum: ["CARTON", "PALLET", "WOODEN_BOX", "CRATE", "BUNDLE"],
      default: "CARTON",
      trim: true,
    },
    dimensions: { type: String, default: "", trim: true },
    grossWeightKg: { type: Number, default: 0, min: 0 },
    netWeightKg: { type: Number, default: 0, min: 0 },
    packageRemarks: { type: String, default: "", trim: true },
    marksAndNumbers: { type: String, default: "", trim: true },
    barcode: { type: String, default: "", trim: true },
    qrCode: { type: String, default: "", trim: true },
    items: { type: [packageItemSchema], default: [] },
  },
  { _id: true }
);

const storePackingSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: "Company", required: true, index: true },
    branchId: { type: mongoose.Schema.Types.ObjectId, ref: "Branch", default: null, index: true },
    packingNo: { type: String, required: true, trim: true, index: true },
    packingDate: { type: Date, default: () => new Date(), index: true },
    warehouse: { type: String, default: "MAIN", trim: true, uppercase: true },
    sourceDocumentType: { type: String, default: "ORDER_ALLOCATION", trim: true },
    sourceDocumentId: { type: mongoose.Schema.Types.ObjectId, default: null, index: true },
    allocationId: { type: mongoose.Schema.Types.ObjectId, ref: "OrderAllocation", required: true, index: true },
    allocationNo: { type: String, default: "", trim: true, index: true },
    linkedOANo: { type: String, default: "", trim: true },
    linkedProformaNo: { type: String, default: "", trim: true },
    customerName: { type: String, default: "", trim: true },
    /** Snapshot copied from OA/PI at packing create — independent of Customer Master. */
    customerReference: { type: String, default: "", trim: true },
    contactPerson: { type: String, default: "", trim: true },
    attention: { type: String, default: "", trim: true },
    billingAddress: { type: String, default: "", trim: true },
    shippingAddress: { type: String, default: "", trim: true },
    paymentTerms: { type: String, default: "", trim: true },
    engine: { type: String, default: "", trim: true },
    model: { type: String, default: "", trim: true },
    esn: { type: String, default: "", trim: true },
    currency: { type: String, default: "USD", trim: true, uppercase: true },
    totalPackages: { type: Number, default: 0, min: 0 },
    totalGrossWeightKg: { type: Number, default: 0, min: 0 },
    totalNetWeightKg: { type: Number, default: 0, min: 0 },
    marksAndNumbers: { type: String, default: "", trim: true },
    packages: { type: [packingPackageSchema], default: [] },
    lines: { type: [storePackingLineSchema], default: [] },
    attachments: { type: [packingAttachmentSchema], default: [] },
    remarks: { type: String, default: "", trim: true },
    status: {
      type: String,
      // POSTING / CANCELLING are ephemeral in-transaction claims (P0.5A).
      enum: ["DRAFT", "POSTING", "POSTED", "PARTIALLY_PACKED", "FULLY_PACKED", "CANCELLING", "CANCELLED"],
      default: "DRAFT",
      index: true,
    },
    invoiceStatus: {
      type: String,
      enum: ["NOT_INVOICED", "PARTIALLY_INVOICED", "FULLY_INVOICED"],
      default: "NOT_INVOICED",
      index: true,
    },
    linkedSalesInvoiceIds: { type: [mongoose.Schema.Types.ObjectId], default: [] },
    linkedSalesInvoiceNos: { type: [String], default: [] },
    lastInvoicedAt: { type: Date, default: null },
    /** Draft was saved while physical stock was short (additive; no ledger effect). */
    hasPhysicalShortage: { type: Boolean, default: false },
    physicalShortageQty: { type: Number, default: 0, min: 0 },
    physicalShortageAcknowledgedAt: { type: Date, default: null },
    /** Reserved for future PACKING.overridePhysicalShortage permission gate. */
    physicalShortageOverrideRequested: { type: Boolean, default: false },
    postedAt: { type: Date, default: null },
    cancelledAt: { type: Date, default: null },
    cancellationReason: { type: String, default: "", trim: true },
    createdBy: { type: String, default: "" },
    updatedBy: { type: String, default: "" },
  },
  { timestamps: true }
);

storePackingSchema.index({ companyId: 1, packingNo: 1 }, { unique: true });
storePackingSchema.index({ companyId: 1, allocationId: 1, status: 1 });

export default mongoose.model("StorePacking", storePackingSchema);
