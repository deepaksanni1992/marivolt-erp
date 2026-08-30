import mongoose from "mongoose";

export const LABEL_JOB_STATUSES = [
  "PENDING",
  "LEASED",
  "PRINTING",
  "COMPLETED",
  "PARTIAL",
  "FAILED",
  "UNCERTAIN",
  "CANCELLED",
];

const labelJobLineSchema = new mongoose.Schema(
  {
    article: { type: String, default: "", trim: true, uppercase: true },
    description: { type: String, default: "", trim: true },
    spn: { type: String, default: "", trim: true },
    materialCode: { type: String, default: "", trim: true },
    qty: { type: Number, default: 0 },
    uom: { type: String, default: "PCS", trim: true },
    poNo: { type: String, default: "", trim: true },
    grnNo: { type: String, default: "", trim: true },
    receivedDate: { type: String, default: "", trim: true },
    location: { type: String, default: "", trim: true },
    barcodeValue: { type: String, default: "", trim: true },
    labelQty: { type: Number, default: 1, min: 0 },
    /** Qty represented on each physical label (primary chunk size). Additive. */
    qtyPerLabel: { type: Number, default: 0, min: 0 },
    /** Number of physical labels for this line. Additive. */
    labelCount: { type: Number, default: 0, min: 0 },
    /** Actual face quantities sent to printer, e.g. [10,10,5]. Additive for audit/reprint. */
    labelDistribution: { type: [Number], default: undefined },
    poLineId: { type: String, default: "" },
    /** Packing customer sticker fields (additive; unused by GRN). */
    customerName: { type: String, default: "", trim: true },
    customerRef: { type: String, default: "", trim: true },
    brand: { type: String, default: "", trim: true },
    modelName: { type: String, default: "", trim: true },
    serialNo: { type: String, default: "", trim: true },
    partNo: { type: String, default: "", trim: true },
    totalQty: { type: Number, default: 0, min: 0 },
    qtyDisplay: { type: String, default: "", trim: true },
    lineCopies: { type: Number, default: 1, min: 1 },
    packingLineId: { type: String, default: "" },
    allocationLineId: { type: String, default: "" },
    packageId: { type: String, default: "" },
    descriptionTruncated: { type: Boolean, default: false },
    /** Stable custom packing session row id (ephemeral UI UUID; additive). Rediscovery uses content fingerprint. */
    customPackingRowId: { type: String, default: "", trim: true },
    /** ASN Receiving Unit identity (additive; unused by GRN). */
    receivingUnitId: { type: mongoose.Schema.Types.ObjectId, ref: "ReceivingUnit", default: null },
    ruNo: { type: String, default: "", trim: true, uppercase: true },
    asnLineId: { type: mongoose.Schema.Types.ObjectId, default: null },
    labelId: { type: String, default: "", trim: true, uppercase: true },
  },
  { _id: false }
);

const labelPrintJobSchema = new mongoose.Schema(
  {
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Company",
      required: true,
      index: true,
    },
    jobNo: { type: String, required: true, trim: true, uppercase: true },
    sourceType: {
      type: String,
      enum: ["GRN", "GRN_PREPOST", "STOCK", "MANUAL", "PACKING", "CUSTOM_PACKING", "ASN"],
      default: "GRN",
    },
    sourceId: { type: mongoose.Schema.Types.ObjectId, default: null },
    sourceNo: { type: String, default: "", trim: true, uppercase: true, index: true },
    /** Pre-GRN draft session reference (GRN-DRAFT-…). Additive. */
    draftRef: { type: String, default: "", trim: true, uppercase: true, index: true },
    /** Linked final GRN number after post (pre-post jobs). Additive; never rewrite history destructively. */
    linkedGrnNo: { type: String, default: "", trim: true, uppercase: true },
    /** Fingerprint of label config used for stale detection / idempotency. */
    labelConfigFingerprint: { type: String, default: "", trim: true },
    warehouseCode: { type: String, default: "", trim: true, uppercase: true },
    printerConfigId: { type: mongoose.Schema.Types.ObjectId, ref: "PrinterConfig", default: null },
    agentId: { type: String, default: "", trim: true, uppercase: true, index: true },
    windowsPrinterName: { type: String, default: "", trim: true },
    templateCode: { type: String, default: "MARIVOLT_STANDARD", trim: true, uppercase: true },
    copies: { type: Number, default: 1, min: 1 },
    requestedLabels: { type: Number, default: 0, min: 0 },
    printedLabels: { type: Number, default: 0, min: 0 },
    remainingLabels: { type: Number, default: 0, min: 0 },
    lines: { type: [labelJobLineSchema], default: [] },
    tsplPayload: { type: String, default: "" },
    /**
     * Transport mode.
     * SINGLE_RAW = one TSPL WritePrinter (GRN/ASN/RU).
     * TSPL_LABEL_BATCH = N complete TSPL labels (packing/custom packing).
     * RAW_FACE_BATCH = legacy packing faces without media setup (historical only).
     * DRIVER_PAGES = abandoned (legacy enum only).
     */
    payloadMode: {
      type: String,
      enum: ["SINGLE_RAW", "TSPL_LABEL_BATCH", "RAW_FACE_BATCH", "DRIVER_PAGES"],
      default: "SINGLE_RAW",
      trim: true,
      uppercase: true,
    },
    /**
     * TSPL_LABEL_BATCH / legacy RAW_FACE_BATCH: one TSPL string per physical sticker.
     * Never concatenate faces into tsplPayload for packing.
     */
    rawFacePayloads: {
      type: [String],
      default: undefined,
    },
    /**
     * @deprecated Abandoned GDI path. Kept for reading historical jobs only.
     */
    driverPages: {
      type: [
        {
          pageIndex: { type: Number, default: 0 },
          widthPx: { type: Number, default: 0 },
          heightPx: { type: Number, default: 0 },
          dpi: { type: Number, default: 203 },
          widthMm: { type: Number, default: 100 },
          heightMm: { type: Number, default: 50 },
          pngBase64: { type: String, default: "" },
          partNo: { type: String, default: "" },
          qtyDisplay: { type: String, default: "" },
          omitArticle: { type: Boolean, default: false },
        },
      ],
      default: undefined,
    },
    status: {
      type: String,
      enum: LABEL_JOB_STATUSES,
      default: "PENDING",
      index: true,
    },
    leasedToAgentId: { type: String, default: "", trim: true, uppercase: true },
    leaseExpiresAt: { type: Date, default: null, index: true },
    leaseToken: { type: String, default: "" },
    lastError: { type: String, default: "" },
    retryCount: { type: Number, default: 0, min: 0 },
    isReprint: { type: Boolean, default: false },
    reprintReason: { type: String, default: "", trim: true },
    parentJobId: { type: mongoose.Schema.Types.ObjectId, ref: "LabelPrintJob", default: null },
    createdByUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    createdByName: { type: String, default: "" },
    /** Client-supplied key; unique per company when set — prevents duplicate enqueue on retry. */
    idempotencyKey: { type: String, default: null, trim: true },
    /** Packing print mode metadata (PRE_PACKING | POSTED_PACKING | REPRINT). */
    packingMode: { type: String, default: "", trim: true, uppercase: true },
    allocationId: { type: mongoose.Schema.Types.ObjectId, default: null },
    packingId: { type: mongoose.Schema.Types.ObjectId, default: null },
    /** True when any packing line description could not fully fit at min font. */
    descriptionTruncated: { type: Boolean, default: false },
    packingSelectionFingerprint: { type: String, default: "", trim: true },
  },
  { timestamps: true }
);

labelPrintJobSchema.index({ companyId: 1, jobNo: 1 }, { unique: true });
labelPrintJobSchema.index({ companyId: 1, status: 1, agentId: 1 });
labelPrintJobSchema.index({ companyId: 1, sourceNo: 1, createdAt: -1 });
labelPrintJobSchema.index({ companyId: 1, sourceType: 1, "lines.receivingUnitId": 1, status: 1 });
labelPrintJobSchema.index({ companyId: 1, sourceType: 1, packingSelectionFingerprint: 1, createdAt: -1 });
labelPrintJobSchema.index({ companyId: 1, packingId: 1, packingMode: 1, createdAt: -1 });
labelPrintJobSchema.index({ companyId: 1, allocationId: 1, packingMode: 1, createdAt: -1 });
labelPrintJobSchema.index({ companyId: 1, sourceType: 1, "lines.customPackingRowId": 1, createdAt: -1 });
labelPrintJobSchema.index(
  { companyId: 1, idempotencyKey: 1 },
  {
    unique: true,
    partialFilterExpression: { idempotencyKey: { $type: "string", $gt: "" } },
  }
);
export default mongoose.model("LabelPrintJob", labelPrintJobSchema);
