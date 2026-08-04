import mongoose from "mongoose";

/**
 * AuditLog — Phase-8.
 *
 * One row per business-meaningful change in the ERP. Used for:
 *   • lifecycle transitions (status changes on sales documents)
 *   • cancellations / edits on posted documents
 *   • payment + receipt changes
 *   • stock movements driven by the user (direct adjustments,
 *     manual transfers; routine ledger writes are NOT logged here)
 *
 * The schema is intentionally additive — old rows captured by the
 * previous (unused) shape will continue to validate because every
 * field is optional except `action` + `module` + `documentNo`.
 */
const auditLogSchema = new mongoose.Schema(
  {
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Company",
      index: true,
    },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null, index: true },
    userName: { type: String, default: "" },
    userEmail: { type: String, default: "" },

    action: {
      type: String,
      enum: [
        "CREATE",
        "UPDATE",
        "DELETE",
        "STATUS_CHANGE",
        "CANCEL",
        "POST",
        "PAYMENT",
        "STOCK",
        "ATTACHMENT",
        "LOGIN",
        "LOGOUT",
        "ORPHAN_RESERVATION_REPAIRED",
        "ARTICLE_CONVERSION_DELETED",
        "OTHER",
      ],
      required: true,
      index: true,
    },
    module: { type: String, default: "", index: true },

    entityType: { type: String, default: "" },
    entityId: { type: String, default: "", index: true },
    documentNo: { type: String, default: "", index: true },

    description: { type: String, default: "" },
    fromStatus: { type: String, default: "" },
    toStatus: { type: String, default: "" },

    beforeData: { type: mongoose.Schema.Types.Mixed, default: null },
    afterData: { type: mongoose.Schema.Types.Mixed, default: null },

    ip: { type: String, default: "" },
    userAgent: { type: String, default: "" },

    metadata: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { timestamps: true }
);

auditLogSchema.index({ companyId: 1, module: 1, createdAt: -1 });
auditLogSchema.index({ companyId: 1, documentNo: 1, createdAt: -1 });
auditLogSchema.index({ companyId: 1, userId: 1, createdAt: -1 });

const AuditLog = mongoose.model("AuditLog", auditLogSchema);

export default AuditLog;
