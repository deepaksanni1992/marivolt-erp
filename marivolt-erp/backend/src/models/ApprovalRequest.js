import mongoose from "mongoose";

/**
 * ApprovalRequest — Phase-10.
 *
 * One row per pending or completed approval. Created automatically
 * when a controller calls `approvalService.requestApproval(...)` and
 * the matching ApprovalRule says approval is required. The original
 * controller action only proceeds after the request is APPROVED.
 *
 * Statuses:
 *   PENDING   — awaiting approver action
 *   APPROVED  — approved; controller proceeds
 *   REJECTED  — rejected; controller aborts
 *   CANCELLED — requester cancelled before decision
 */
const approvalActionSchema = new mongoose.Schema(
  {
    actorUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    actorEmail: { type: String, default: "" },
    actorName: { type: String, default: "" },
    decision: {
      type: String,
      enum: ["APPROVED", "REJECTED", "COMMENT", "CANCELLED"],
      required: true,
    },
    note: { type: String, default: "" },
    at: { type: Date, default: () => new Date() },
  },
  { _id: true }
);

const approvalRequestSchema = new mongoose.Schema(
  {
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Company",
      required: true,
      index: true,
    },
    module: { type: String, required: true, trim: true, uppercase: true, index: true },
    actionKey: { type: String, required: true, trim: true, lowercase: true, index: true },
    /** Document tagging so approvers can quickly identify the target. */
    documentType: { type: String, default: "" },
    documentId: { type: mongoose.Schema.Types.ObjectId, default: null, index: true },
    documentNo: { type: String, default: "", index: true },
    customerName: { type: String, default: "" },
    amount: { type: Number, default: 0 },
    currency: { type: String, default: "USD", trim: true, uppercase: true },
    description: { type: String, default: "" },
    requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    requestedByEmail: { type: String, default: "" },
    requestedByName: { type: String, default: "" },
    status: {
      type: String,
      enum: ["PENDING", "APPROVED", "REJECTED", "CANCELLED"],
      default: "PENDING",
      index: true,
    },
    /** Snapshot of the matching rule for audit. */
    ruleId: { type: mongoose.Schema.Types.ObjectId, ref: "ApprovalRule", default: null },
    approverRoles: { type: [String], default: [] },
    approverUserIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
    history: { type: [approvalActionSchema], default: [] },
    decidedAt: { type: Date, default: null },
    decidedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    decidedByEmail: { type: String, default: "" },
  },
  { timestamps: true }
);

approvalRequestSchema.index({ companyId: 1, status: 1, createdAt: -1 });
approvalRequestSchema.index({ companyId: 1, module: 1, actionKey: 1, status: 1 });
approvalRequestSchema.index({ companyId: 1, documentNo: 1 });

export default mongoose.model("ApprovalRequest", approvalRequestSchema);
