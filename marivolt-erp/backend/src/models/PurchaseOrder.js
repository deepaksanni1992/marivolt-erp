import mongoose from "mongoose";

const poLineSchema = new mongoose.Schema(
  {
    article: { type: String, default: "", trim: true, uppercase: true },
    articleNo: { type: String, default: "", trim: true },
    itemCode: { type: String, required: true, trim: true, uppercase: true },
    description: { type: String, default: "" },
    partNo: { type: String, default: "", trim: true },
    partNumber: { type: String, default: "", trim: true, uppercase: true },
    materialCode: { type: String, default: "", trim: true, uppercase: true },
    spn: { type: String, default: "", trim: true, uppercase: true },
    drawingNo: { type: String, default: "", trim: true },
    vertical: { type: String, default: "", trim: true },
    brand: { type: String, default: "", trim: true },
    engine: { type: String, default: "", trim: true },
    model: { type: String, default: "", trim: true },
    config: { type: String, default: "", trim: true },
    esn: { type: String, default: "", trim: true },
    orderedQty: { type: Number, default: 0, min: 0 },
    pendingQty: { type: Number, default: 0, min: 0 },
    cancelledQty: { type: Number, default: 0, min: 0 },
    qty: { type: Number, required: true, min: 0 },
    uom: { type: String, default: "PCS", trim: true },
    unitPrice: { type: Number, default: 0, min: 0 },
    currency: { type: String, default: "USD", trim: true },
    lineAmount: { type: Number, default: 0, min: 0 },
    lineTotal: { type: Number, default: 0, min: 0 },
    expectedDeliveryDate: { type: Date },
    receivedQty: { type: Number, default: 0, min: 0 },
    remarks: { type: String, default: "" },
    leadTime: { type: String, default: "", trim: true },
    /** Supplier-facing part reference on PO print; internal mapping uses partNumber/spn. */
    supplierPartNumber: { type: String, default: "", trim: true },
  },
  { _id: true }
);

const purchaseOrderSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: "Company", required: true, index: true },
    branchId: { type: mongoose.Schema.Types.ObjectId, ref: "Branch", default: null, index: true },
    warehouseId: { type: mongoose.Schema.Types.ObjectId, ref: "Warehouse", default: null, index: true },
    poNo: { type: String, required: true, trim: true },
    poNumber: { type: String, required: true, trim: true },
    orderDate: { type: Date, default: () => new Date() },
    supplierId: { type: mongoose.Schema.Types.ObjectId, ref: "Supplier", default: null, index: true },
    exchangeRate: { type: Number, default: 1, min: 0 },
    paymentTerms: { type: String, default: "" },
    expectedDeliveryDate: { type: Date, default: null },
    linkedPRs: { type: [mongoose.Schema.Types.ObjectId], ref: "PurchaseRequisition", default: [] },
    approvalStatus: {
      type: String,
      enum: ["NOT_REQUIRED", "PENDING", "APPROVED", "REJECTED"],
      default: "NOT_REQUIRED",
      index: true,
    },

    buyerLegalName: { type: String, default: "", trim: true },
    buyerAddressLine: { type: String, default: "", trim: true },
    buyerPhone: { type: String, default: "", trim: true },
    buyerEmail: { type: String, default: "", trim: true },
    buyerWeb: { type: String, default: "", trim: true },
    buyerTrnNo: { type: String, default: "", trim: true },

    supplierName: { type: String, required: true, trim: true },
    supplierAddress: { type: String, default: "", trim: true },
    supplierPhone: { type: String, default: "", trim: true },
    supplierEmail: { type: String, default: "", trim: true },

    ref: { type: String, default: "", trim: true },
    intRef: { type: String, default: "", trim: true },
    contactPerson: { type: String, default: "", trim: true },
    supplierReference: { type: String, default: "", trim: true },
    offerDate: { type: String, default: "", trim: true },

    vertical: { type: String, default: "", trim: true },
    brand: { type: String, default: "", trim: true },
    engine: { type: String, default: "", trim: true },
    model: { type: String, default: "", trim: true },
    config: { type: String, default: "", trim: true },
    esn: { type: String, default: "", trim: true },

    currency: { type: String, default: "USD", trim: true },
    lines: { type: [poLineSchema], default: [] },
    subTotal: { type: Number, default: 0 },
    packingCost: { type: Number, default: 0, min: 0 },
    handlingCost: { type: Number, default: 0, min: 0 },
    miscellaneousCost: { type: Number, default: 0, min: 0 },
    grandTotal: { type: Number, default: 0 },
    /** When true, material code column appears on supplier-facing PO print/PDF. */
    showMaterialCodeOnPrint: { type: Boolean, default: false },
    /** When true, machine details box appears on supplier-facing PO print/PDF. */
    showMachineDetailsOnPrint: { type: Boolean, default: false },

    delivery: { type: String, default: "Ex-Works", trim: true },
    insurance: { type: String, default: "On buyers account", trim: true },
    packing: { type: String, default: "Inclusive", trim: true },
    freight: { type: String, default: "On buyers account", trim: true },
    taxes: { type: String, default: "N.A.", trim: true },
    payment: { type: String, default: "100% against delivery", trim: true },

    specialRemarks: { type: String, default: "-" },
    termsAndConditions: { type: String, default: "" },
    closingNote: {
      type: String,
      default:
        "Kindly send us the Order Acknowledgement and Proforma Invoice, with current status of delivery.",
    },

    status: {
      type: String,
      enum: ["DRAFT", "SAVED", "SENT", "REJECTED", "PARTIAL_RECEIVED", "RECEIVED", "CLOSED", "CANCELLED"],
      default: "DRAFT",
    },
    /** AP extension: supplier payment lifecycle (additive; does not replace `status`). */
    apPaymentStatus: {
      type: String,
      default: "NONE",
      trim: true,
    },
    /** AP extension: supplier PI / invoice document pipeline. */
    supplierDocumentStatus: {
      type: String,
      default: "NONE",
      trim: true,
    },
    /** AP extension: high-level GRN progress label (informational). */
    grnProgressStatus: {
      type: String,
      default: "NONE",
      trim: true,
    },
    /** GRN receipt progress vs PO lines (independent of supplier payment). */
    grnReceiptStatus: {
      type: String,
      default: "NOT_RECEIVED",
      trim: true,
    },
    /** AP extension: optional human-readable receipt summary. */
    receivedQtySummary: { type: String, default: "", trim: true },
    remarks: { type: String, default: "" },
    createdBy: { type: String, default: "" },
  },
  { timestamps: true }
);

/** Per-company PO numbers only — never a global unique on poNo/poNumber alone (see migrate-po-number-indexes). */
purchaseOrderSchema.index({ companyId: 1, poNumber: 1 }, { unique: true });
purchaseOrderSchema.index({ companyId: 1, poNo: 1 }, { unique: true });

export default mongoose.model("PurchaseOrder", purchaseOrderSchema);
