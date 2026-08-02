import mongoose from "mongoose";

const attachmentSchema = new mongoose.Schema(
  {
    documentId: { type: mongoose.Schema.Types.ObjectId, ref: "Document", default: null },
    fileName: { type: String, default: "", trim: true },
    fileUrl: { type: String, default: "", trim: true },
    uploadedAt: { type: Date, default: null },
    remarks: { type: String, default: "", trim: true },
  },
  { _id: true }
);

/**
 * A1 — First-class Supplier Proforma (advance authorization).
 * Does not create stock, AP liability, or final Purchase Invoice.
 */
const supplierProformaSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: "Company", required: true, index: true },
    branchId: { type: mongoose.Schema.Types.ObjectId, ref: "Branch", default: null, index: true },

    /** Internal system reference e.g. MAR-SPF-0001 */
    internalProformaRef: { type: String, required: true, trim: true, index: true },
    /** Supplier's own proforma number */
    supplierProformaNo: { type: String, required: true, trim: true },
    normalizedSupplierProformaNo: { type: String, required: true, trim: true, uppercase: true, index: true },
    supplierProformaDate: { type: Date, default: () => new Date(), index: true },

    supplierId: { type: mongoose.Schema.Types.ObjectId, ref: "Supplier", required: true, index: true },
    supplierName: { type: String, default: "", trim: true },
    purchaseOrderId: { type: mongoose.Schema.Types.ObjectId, ref: "PurchaseOrder", required: true, index: true },
    purchaseOrderNo: { type: String, default: "", trim: true, index: true },
    /** Optional link to generic PurchaseDocument attachment row */
    purchaseDocumentId: { type: mongoose.Schema.Types.ObjectId, ref: "PurchaseDocument", default: null, index: true },

    currency: { type: String, default: "USD", trim: true, uppercase: true },
    exchangeRate: { type: Number, default: 1, min: 0 },
    exchangeRateReason: { type: String, default: "", trim: true },
    totalValue: { type: Number, default: 0, min: 0 },
    requestedAdvanceAmount: { type: Number, default: 0, min: 0 },
    requestedAdvancePercent: { type: Number, default: 0, min: 0, max: 100 },
    paymentDueDate: { type: Date, default: null },
    paymentTerms: { type: String, default: "", trim: true },
    remarks: { type: String, default: "", trim: true },

    primaryAttachment: { type: attachmentSchema, default: null },
    supportingAttachments: { type: [attachmentSchema], default: [] },

    documentStatus: {
      type: String,
      enum: ["DRAFT", "RECEIVED", "APPROVED", "CANCELLED"],
      default: "DRAFT",
      index: true,
    },
    /**
     * Coverage of requested advance only (A2 will drive updates).
     * Not final AP settlement.
     */
    paymentStatus: {
      type: String,
      enum: ["UNPAID", "PARTIALLY_PAID", "PAID"],
      default: "UNPAID",
      index: true,
    },

    createdBy: { type: String, default: "" },
    updatedBy: { type: String, default: "" },
    approvedBy: { type: String, default: "" },
    approvedAt: { type: Date, default: null },
    cancelledBy: { type: String, default: "" },
    cancelledAt: { type: Date, default: null },
    cancellationReason: { type: String, default: "", trim: true },
  },
  { timestamps: true }
);

supplierProformaSchema.index({ companyId: 1, internalProformaRef: 1 }, { unique: true });
// Unique index on active duplicates is applied via controlled migration (not at startup).
supplierProformaSchema.index({ companyId: 1, purchaseOrderId: 1, documentStatus: 1 });
supplierProformaSchema.index({ companyId: 1, supplierId: 1, normalizedSupplierProformaNo: 1 });

export default mongoose.model("SupplierProforma", supplierProformaSchema);
