import mongoose from "mongoose";

const supplierPaymentAllocationSchema = new mongoose.Schema(
  {
    purchaseInvoiceId: { type: mongoose.Schema.Types.ObjectId, ref: "PurchaseInvoice", required: true, index: true },
    purchaseInvoiceNo: { type: String, default: "", trim: true },
    allocatedAmount: { type: Number, required: true, min: 0.0001 },
  },
  { _id: true }
);

const supplierPaymentSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: "Company", required: true, index: true },
    branchId: { type: mongoose.Schema.Types.ObjectId, ref: "Branch", default: null, index: true },
    linkedPoNo: { type: String, default: "", trim: true },
    supplierPiNo: { type: String, default: "", trim: true },
    supplierInvoiceNo: { type: String, default: "", trim: true },
    exchangeRate: { type: Number, default: 1, min: 0 },
    paymentNo: { type: String, required: true, trim: true },
    paymentDate: { type: Date, required: true, default: () => new Date(), index: true },
    supplierName: { type: String, required: true, trim: true, index: true },
    currency: { type: String, default: "USD", trim: true, uppercase: true },
    amountPaid: { type: Number, required: true, min: 0.0001 },
    allocatedAmount: { type: Number, default: 0, min: 0 },
    unallocatedAmount: { type: Number, default: 0, min: 0 },
    paymentMode: { type: String, default: "BANK_TRANSFER", trim: true, uppercase: true },
    bankCashAccountName: { type: String, default: "", trim: true },
    paymentReference: { type: String, default: "", trim: true },
    /** ADVANCE | PARTIAL | FULL | BALANCE — informational for reporting */
    paymentCategory: { type: String, default: "", trim: true },
    remarks: { type: String, default: "" },
    attachments: {
      type: [
        {
          documentId: { type: mongoose.Schema.Types.ObjectId, ref: "Document", default: null },
          documentType: { type: String, default: "" },
          fileName: { type: String, default: "" },
          uploadedAt: { type: Date, default: null },
        },
      ],
      default: [],
    },
    allocations: { type: [supplierPaymentAllocationSchema], default: [] },
    status: {
      type: String,
      enum: ["DRAFT", "POSTED", "PARTIALLY_ALLOCATED", "FULLY_ALLOCATED", "CANCELLED"],
      default: "POSTED",
      index: true,
    },
    linkedCashBankEntryId: { type: mongoose.Schema.Types.ObjectId, ref: "CashBankEntry", default: null },
    linkedSupplierLedgerEntryId: { type: mongoose.Schema.Types.ObjectId, ref: "SupplierLedgerEntry", default: null },
    createdBy: { type: String, default: "" },
    updatedBy: { type: String, default: "" },
  },
  { timestamps: true }
);

supplierPaymentSchema.index({ companyId: 1, paymentNo: 1 }, { unique: true });

export default mongoose.model("SupplierPayment", supplierPaymentSchema);
