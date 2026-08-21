import mongoose from "mongoose";
import { ASN_SHIPMENT_MODES, ASN_STATUSES } from "../utils/asnRules.js";

const asnLineSchema = new mongoose.Schema(
  {
    poId: { type: mongoose.Schema.Types.ObjectId, ref: "PurchaseOrder", required: true, index: true },
    poLineId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    itemId: { type: mongoose.Schema.Types.ObjectId, ref: "ItemMaster", default: null },
    article: { type: String, default: "", trim: true, uppercase: true },
    itemName: { type: String, default: "", trim: true },
    description: { type: String, default: "", trim: true },
    supplierPartNumber: { type: String, default: "", trim: true },
    partNumber: { type: String, default: "", trim: true, uppercase: true },
    uom: { type: String, default: "PCS", trim: true },
    poQty: { type: Number, default: 0, min: 0 },
    previouslyAsnQty: { type: Number, default: 0, min: 0 },
    remainingAvailableQty: { type: Number, default: 0, min: 0 },
    asnQty: { type: Number, required: true, min: 0 },
    unitPrice: { type: Number, default: 0, min: 0 },
    currency: { type: String, default: "", trim: true, uppercase: true },
    /** Article-level HS Code (authoritative for ASN_RECEIVING customs). */
    hsCode: { type: String, default: "", trim: true, uppercase: true },
    /** Article-level Country of Origin (authoritative; legacy header COO is fallback only). */
    countryOfOrigin: { type: String, default: "", trim: true, uppercase: true },
    /** Atomic label-plan revision. Incremented on each accepted plan/replan. */
    ruPlanVersion: { type: Number, default: 0, min: 0 },
    /** Current authoritative Receiving Unit plan batch for this line. */
    ruActivePlanBatchId: { type: mongoose.Schema.Types.ObjectId, default: null },
  },
  { _id: true }
);

const asnSupplierInvoiceSchema = new mongoose.Schema(
  {
    invoiceNumber: { type: String, default: "", trim: true },
    invoiceDate: { type: Date, default: null },
  },
  { _id: false }
);

const asnAttachmentSchema = new mongoose.Schema(
  {
    documentId: { type: mongoose.Schema.Types.ObjectId, ref: "Document", default: null },
    documentType: { type: String, default: "ASN Document", trim: true },
    originalFilename: { type: String, default: "", trim: true },
    storageRef: { type: String, default: "", trim: true },
    uploadedBy: { type: String, default: "", trim: true },
    uploadedAt: { type: Date, default: Date.now },
  },
  { _id: true }
);

const advanceShipmentNoticeSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: "Company", required: true, index: true },
    asnNo: { type: String, required: true, trim: true },
    status: {
      type: String,
      enum: ASN_STATUSES,
      default: "DRAFT",
      index: true,
    },
    supplierId: { type: mongoose.Schema.Types.ObjectId, ref: "Supplier", default: null, index: true },
    supplierName: { type: String, default: "", trim: true },
    currency: { type: String, default: "", trim: true, uppercase: true },
    sourcePoId: { type: mongoose.Schema.Types.ObjectId, ref: "PurchaseOrder", required: true, index: true },
    sourcePoNo: { type: String, default: "", trim: true },
    sourcePoDate: { type: Date, default: null },
    /** Future multi-PO: always includes sourcePoId. Phase 1 UI creates from one PO. */
    poIds: { type: [{ type: mongoose.Schema.Types.ObjectId, ref: "PurchaseOrder" }], default: [] },
    /** Legacy scalar SI — kept for read compatibility; shadowed from supplierInvoices[FIFO]. */
    supplierInvoiceNumber: { type: String, default: "", trim: true },
    supplierInvoiceDate: { type: Date, default: null },
    /** One BL may carry multiple supplier invoices (ASN header ownership). */
    supplierInvoices: { type: [asnSupplierInvoiceSchema], default: [] },
    supplierPackingListNumber: { type: String, default: "", trim: true },
    shipmentMode: {
      type: String,
      enum: ASN_SHIPMENT_MODES,
      default: "OTHER",
    },
    forwarder: { type: String, default: "", trim: true },
    awbNumber: { type: String, default: "", trim: true },
    blNumber: { type: String, default: "", trim: true },
    trackingNumber: { type: String, default: "", trim: true },
    shipmentDate: { type: Date, default: null },
    expectedArrivalDate: { type: Date, default: null, index: true },
    actualArrivalDate: { type: Date, default: null },
    countryOfOrigin: { type: String, default: "", trim: true },
    portOfLoading: { type: String, default: "", trim: true },
    portOfArrival: { type: String, default: "", trim: true },
    numberOfPackages: { type: Number, default: 0, min: 0 },
    grossWeight: { type: Number, default: 0, min: 0 },
    grossWeightUom: { type: String, default: "KG", trim: true, uppercase: true },
    remarks: { type: String, default: "", trim: true },
    lines: { type: [asnLineSchema], default: [] },
    attachments: { type: [asnAttachmentSchema], default: [] },
    createdBy: { type: String, default: "", trim: true },
    createdByUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    updatedBy: { type: String, default: "", trim: true },
    updatedByUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    shippedAt: { type: Date, default: null },
    shippedBy: { type: String, default: "", trim: true },
    arrivedAt: { type: Date, default: null },
    arrivedBy: { type: String, default: "", trim: true },
    cancelledAt: { type: Date, default: null },
    cancelledBy: { type: String, default: "", trim: true },
    cancellationReason: { type: String, default: "", trim: true },
  },
  { timestamps: true, collection: "advanceShipmentNotices" }
);

advanceShipmentNoticeSchema.index({ companyId: 1, asnNo: 1 }, { unique: true });
advanceShipmentNoticeSchema.index({ companyId: 1, status: 1, expectedArrivalDate: 1 });
advanceShipmentNoticeSchema.index({ companyId: 1, supplierId: 1 });
advanceShipmentNoticeSchema.index({ companyId: 1, sourcePoId: 1 });
advanceShipmentNoticeSchema.index({ companyId: 1, "lines.poLineId": 1 });
advanceShipmentNoticeSchema.index({ companyId: 1, poIds: 1 });

export default mongoose.model("AdvanceShipmentNotice", advanceShipmentNoticeSchema);
