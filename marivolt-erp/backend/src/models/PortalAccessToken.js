import mongoose from "mongoose";

const portalAccessTokenSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: "Company", required: true, index: true },
    partyType: { type: String, enum: ["CUSTOMER", "SUPPLIER"], required: true, index: true },
    partyName: { type: String, default: "", trim: true },
    partyEmail: { type: String, required: true, trim: true, index: true },
    tokenHash: { type: String, required: true, trim: true, index: true },
    scope: { type: [String], default: ["documents:view"] },
    status: { type: String, enum: ["ACTIVE", "REVOKED", "EXPIRED"], default: "ACTIVE", index: true },
    portalReference: { type: String, default: "", trim: true, index: true },
    expiresAt: { type: Date, default: null, index: true },
    lastAccessAt: { type: Date, default: null },
    createdBy: { type: String, default: "" },
    revokedBy: { type: String, default: "" },
    revokedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

portalAccessTokenSchema.index({ companyId: 1, partyEmail: 1, status: 1 });

export default mongoose.model("PortalAccessToken", portalAccessTokenSchema);

