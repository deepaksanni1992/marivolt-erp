import mongoose from "mongoose";

const portalAccessLogSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: "Company", required: true, index: true },
    partyType: { type: String, enum: ["CUSTOMER", "SUPPLIER"], required: true, index: true },
    partyEmail: { type: String, default: "", trim: true, index: true },
    portalReference: { type: String, default: "", trim: true, index: true },
    action: { type: String, default: "ACCESS", trim: true, index: true },
    status: { type: String, enum: ["SUCCESS", "DENIED", "EXPIRED"], default: "SUCCESS", index: true },
    tokenId: { type: mongoose.Schema.Types.ObjectId, ref: "PortalAccessToken", default: null, index: true },
    ip: { type: String, default: "", trim: true },
    userAgent: { type: String, default: "", trim: true },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

portalAccessLogSchema.index({ companyId: 1, createdAt: -1 });

export default mongoose.model("PortalAccessLog", portalAccessLogSchema);

