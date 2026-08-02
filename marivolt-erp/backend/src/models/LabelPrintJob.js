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
    poLineId: { type: String, default: "" },
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
    sourceType: { type: String, enum: ["GRN", "STOCK", "MANUAL"], default: "GRN" },
    sourceId: { type: mongoose.Schema.Types.ObjectId, default: null },
    sourceNo: { type: String, default: "", trim: true, uppercase: true, index: true },
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
  },
  { timestamps: true }
);

labelPrintJobSchema.index({ companyId: 1, jobNo: 1 }, { unique: true });
labelPrintJobSchema.index({ companyId: 1, status: 1, agentId: 1 });
labelPrintJobSchema.index({ companyId: 1, sourceNo: 1, createdAt: -1 });

export default mongoose.model("LabelPrintJob", labelPrintJobSchema);
