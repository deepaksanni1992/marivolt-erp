import mongoose from "mongoose";

const prLineSchema = new mongoose.Schema(
  {
    article: { type: String, required: true, trim: true, uppercase: true },
    description: { type: String, default: "" },
    qty: { type: Number, required: true, min: 0.0001 },
    uom: { type: String, default: "PCS", trim: true, uppercase: true },
    requiredDate: { type: Date, default: null },
    remarks: { type: String, default: "" },
  },
  { _id: true }
);

const purchaseRequisitionSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: "Company", required: true, index: true },
    branchId: { type: mongoose.Schema.Types.ObjectId, ref: "Branch", default: null, index: true },
    warehouseId: { type: mongoose.Schema.Types.ObjectId, ref: "Warehouse", default: null, index: true },
    prNo: { type: String, required: true, trim: true, index: true },
    requester: { type: String, default: "", trim: true },
    department: { type: String, default: "", trim: true },
    requiredDate: { type: Date, default: null },
    remarks: { type: String, default: "" },
    approvalStatus: {
      type: String,
      enum: ["NOT_REQUIRED", "PENDING", "APPROVED", "REJECTED"],
      default: "NOT_REQUIRED",
      index: true,
    },
    status: {
      type: String,
      enum: ["DRAFT", "SUBMITTED", "APPROVED", "REJECTED", "CLOSED", "CANCELLED"],
      default: "DRAFT",
      index: true,
    },
    lines: { type: [prLineSchema], default: [] },
    createdBy: { type: String, default: "" },
    updatedBy: { type: String, default: "" },
  },
  { timestamps: true }
);

purchaseRequisitionSchema.index({ companyId: 1, prNo: 1 }, { unique: true });
purchaseRequisitionSchema.index({ companyId: 1, status: 1, createdAt: -1 });

export default mongoose.model("PurchaseRequisition", purchaseRequisitionSchema);
