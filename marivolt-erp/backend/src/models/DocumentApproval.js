import mongoose from "mongoose";

const documentApprovalSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: "Company", required: true, index: true },
    approvalNo: { type: String, required: true, trim: true, index: true },
    linkedDocumentType: {
      type: String,
      enum: ["SALES_INVOICE", "PURCHASE_INVOICE", "PAYMENT", "GRN", "DISPATCH", "LANDED_COST", "STOCK_ADJUSTMENT"],
      required: true,
      index: true,
    },
    linkedDocumentId: { type: String, required: true, trim: true, index: true },
    linkedDocumentNo: { type: String, default: "", trim: true, index: true },
    status: {
      type: String,
      enum: ["PENDING", "APPROVED", "REJECTED", "CANCELLED"],
      default: "PENDING",
      index: true,
    },
    approver: { type: String, default: "", trim: true },
    approvalDate: { type: Date, default: null },
    remarks: { type: String, default: "" },
    requestedBy: { type: String, default: "" },
    requestedAt: { type: Date, default: () => new Date() },
    decidedBy: { type: String, default: "" },
    decidedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

documentApprovalSchema.index({ companyId: 1, approvalNo: 1 }, { unique: true });
documentApprovalSchema.index({ companyId: 1, linkedDocumentType: 1, linkedDocumentId: 1, status: 1 });

export default mongoose.model("DocumentApproval", documentApprovalSchema);

