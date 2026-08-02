import mongoose from "mongoose";

const labelPrintHistorySchema = new mongoose.Schema(
  {
    jobId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "LabelPrintJob",
      required: true,
      index: true,
    },
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Company",
      required: true,
      index: true,
    },
    agentId: { type: String, default: "", trim: true, uppercase: true },
    computerName: { type: String, default: "" },
    windowsPrinterName: { type: String, default: "" },
    requestedQty: { type: Number, default: 0 },
    printedQty: { type: Number, default: 0 },
    status: { type: String, default: "", trim: true, uppercase: true },
    templateCode: { type: String, default: "" },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    userName: { type: String, default: "" },
    failureReason: { type: String, default: "" },
    retryCount: { type: Number, default: 0 },
    event: { type: String, default: "", trim: true },
  },
  { timestamps: { createdAt: "timestamp", updatedAt: false } }
);

labelPrintHistorySchema.index({ companyId: 1, timestamp: -1 });

export default mongoose.model("LabelPrintHistory", labelPrintHistorySchema);
