import mongoose from "mongoose";

/**
 * ApprovalRule — Phase-10.
 *
 * Defines whether a given action on a given module needs approval
 * before it is allowed to proceed. A request is matched by:
 *   companyId + module + action + (amount > minAmount?)
 *
 * Module/action pairs commonly used today:
 *   SALES.invoice_post, SALES.invoice_cancel
 *   ACCOUNTS.payment_post, ACCOUNTS.payment_cancel
 *   STORE.adjustment_post
 *   LOGISTICS.dispatch_close
 *
 * Rules are checked in order of `priority` (highest first); the
 * first matching rule wins.
 */
const approvalRuleSchema = new mongoose.Schema(
  {
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Company",
      required: true,
      index: true,
    },
    module: { type: String, required: true, trim: true, uppercase: true },
    /** Free-form action key, e.g. invoice_post, payment_cancel, adjustment_post. */
    actionKey: { type: String, required: true, trim: true, lowercase: true },
    description: { type: String, default: "", trim: true },
    /** Optional currency-aware threshold. Rule only applies when amount >= minAmount. */
    minAmount: { type: Number, default: 0, min: 0 },
    currency: { type: String, default: "USD", trim: true, uppercase: true },
    /** Roles allowed to approve this request. */
    approverRoles: { type: [String], default: ["super_admin", "company_admin", "admin"] },
    /** Specific approver users (optional). */
    approverUserIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
    /** Priority: higher value = checked first. */
    priority: { type: Number, default: 100 },
    isActive: { type: Boolean, default: true, index: true },
    createdBy: { type: String, default: "" },
    updatedBy: { type: String, default: "" },
  },
  { timestamps: true }
);

approvalRuleSchema.index({ companyId: 1, module: 1, actionKey: 1, priority: -1 });

export default mongoose.model("ApprovalRule", approvalRuleSchema);
