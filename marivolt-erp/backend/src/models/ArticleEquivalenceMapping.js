import mongoose from "mongoose";

export const ARTICLE_EQUIVALENCE_RELATIONSHIP_TYPES = Object.freeze([
  "EQUIVALENT",
  "SUPERSEDED_BY",
  "SUPPLIER_TO_OEM",
  "CUSTOMER_REFERENCE",
  "REPACKED_AS",
  "OTHER",
]);

const articleEquivalenceMappingSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: "Company", required: true, index: true },
    sourceArticle: { type: String, required: true, trim: true, uppercase: true, index: true },
    targetArticle: { type: String, required: true, trim: true, uppercase: true, index: true },
    relationshipType: {
      type: String,
      enum: ARTICLE_EQUIVALENCE_RELATIONSHIP_TYPES,
      default: "EQUIVALENT",
    },
    conversionRatio: { type: Number, default: 1, min: 0 },
    effectiveFrom: { type: Date, default: Date.now },
    effectiveTo: { type: Date, default: null },
    remarks: { type: String, default: "", trim: true },
    supportingDocument: { type: String, default: "", trim: true },
    approvalStatus: {
      type: String,
      enum: ["DRAFT", "PENDING", "APPROVED", "REJECTED", "INACTIVE"],
      default: "PENDING",
      index: true,
    },
    approvedBy: { type: String, default: "", trim: true },
    approvedAt: { type: Date, default: null },
    isActive: { type: Boolean, default: true, index: true },
    createdBy: { type: String, default: "", trim: true },
    updatedBy: { type: String, default: "", trim: true },
  },
  { timestamps: true }
);

articleEquivalenceMappingSchema.index(
  { companyId: 1, sourceArticle: 1, targetArticle: 1, isActive: 1 },
  {
    unique: true,
    partialFilterExpression: { isActive: true, approvalStatus: "APPROVED" },
    name: "uniq_active_approved_article_equivalence",
  }
);

export default mongoose.model("ArticleEquivalenceMapping", articleEquivalenceMappingSchema);
