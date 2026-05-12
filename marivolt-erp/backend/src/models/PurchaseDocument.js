import mongoose from "mongoose";

/** Stored on PurchaseDocument; file may also exist in Document collection (documentId). */
export const PURCHASE_DOCUMENT_TYPES = [
  "SUPPLIER_PROFORMA",
  "SUPPLIER_TAX_INVOICE",
  "COMMERCIAL_INVOICE",
  "DELIVERY_NOTE",
  "PACKING_LIST",
  "SUPPLIER_BANK_DETAILS",
  "PAYMENT_INSTRUCTION",
  "OTHER",
];

const purchaseDocumentSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: "Company", required: true, index: true },
    branchId: { type: mongoose.Schema.Types.ObjectId, ref: "Branch", default: null, index: true },
    linkedPoId: { type: mongoose.Schema.Types.ObjectId, ref: "PurchaseOrder", required: true, index: true },
    supplierId: { type: mongoose.Schema.Types.ObjectId, ref: "Supplier", default: null, index: true },
    documentType: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
      enum: PURCHASE_DOCUMENT_TYPES,
    },
    documentNo: { type: String, default: "", trim: true },
    documentDate: { type: Date, default: null },
    amount: { type: Number, default: 0, min: 0 },
    currency: { type: String, default: "USD", trim: true, uppercase: true },
    dueDate: { type: Date, default: null },
    fileUrl: { type: String, default: "", trim: true },
    documentId: { type: mongoose.Schema.Types.ObjectId, ref: "Document", default: null },
    remarks: { type: String, default: "", trim: true },
    uploadedBy: { type: String, default: "" },
    uploadedAt: { type: Date, default: () => new Date() },
    status: { type: String, enum: ["ACTIVE", "VOID"], default: "ACTIVE", index: true },
    createdBy: { type: String, default: "" },
    updatedBy: { type: String, default: "" },
  },
  { timestamps: true }
);

purchaseDocumentSchema.index({ companyId: 1, linkedPoId: 1, documentType: 1, status: 1 });

export default mongoose.model("PurchaseDocument", purchaseDocumentSchema);
