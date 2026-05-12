import mongoose from "mongoose";

/** Allowed business document categories (matches S3 folder mapping in controller). */
export const DOCUMENT_TYPES = [
  "Supplier Proforma Invoice",
  "Supplier Tax Invoice",
  "Commercial Invoice",
  "Delivery Note",
  "Supplier Bank Details",
  "Payment Instruction",
  "Supplier Invoice",
  "Customer PO",
  "Purchase Order",
  "Sales Invoice",
  "Packing List",
  "BL/AWB",
  "Customs Docs",
  "Inspection Report",
  "Bank Transfer Proof",
  "Supplier Receipt",
  "SWIFT Copy",
  "Shipping Document",
  "GRN Document",
  "Other",
];

const documentSchema = new mongoose.Schema(
  {
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Company",
      required: true,
      index: true,
    },
    documentType: {
      type: String,
      required: true,
      enum: DOCUMENT_TYPES,
      trim: true,
    },
    refNo: { type: String, default: "", trim: true },
    partyName: { type: String, default: "", trim: true },
    moduleName: { type: String, default: "", trim: true },
    relatedId: { type: String, default: "", trim: true },
    originalFileName: { type: String, required: true, trim: true },
    storedFileName: { type: String, required: true, trim: true },
    mimeType: { type: String, required: true, trim: true },
    size: { type: Number, required: true, min: 0 },
    s3Key: { type: String, required: true, trim: true, index: true },
    /** AWS bucket when using per-tenant buckets; empty uses default AWS_S3_BUCKET. */
    s3Bucket: { type: String, default: "", trim: true },
    fileUrl: { type: String, required: true, trim: true },
    remarks: { type: String, default: "", trim: true },
    uploadedBy: { type: String, default: "", trim: true },
    uploadedAt: { type: Date, default: () => new Date() },
  },
  { timestamps: true },
);

documentSchema.index({ companyId: 1, uploadedAt: -1 });

export default mongoose.model("Document", documentSchema);
