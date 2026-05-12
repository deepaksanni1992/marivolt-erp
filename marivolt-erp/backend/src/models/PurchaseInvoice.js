import mongoose from "mongoose";

const purchaseInvoiceLineSchema = new mongoose.Schema(
  {
    itemCode: { type: String, default: "", trim: true, uppercase: true },
    description: { type: String, default: "" },
    qty: { type: Number, default: 0, min: 0 },
    rate: { type: Number, default: 0, min: 0 },
    amount: { type: Number, default: 0, min: 0 },
  },
  { _id: true }
);

const purchaseInvoiceSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: "Company", required: true, index: true },
    branchId: { type: mongoose.Schema.Types.ObjectId, ref: "Branch", default: null, index: true },
    linkedPoId: { type: mongoose.Schema.Types.ObjectId, ref: "PurchaseOrder", default: null, index: true },
    supplierId: { type: mongoose.Schema.Types.ObjectId, ref: "Supplier", default: null, index: true },
    invoiceNumber: { type: String, required: true, trim: true },
    invoiceDate: { type: Date, default: () => new Date() },
    dueDate: { type: Date, default: null, index: true },
    supplierName: { type: String, required: true, trim: true },
    supplierInvoiceNo: { type: String, default: "", trim: true, index: true },
    supplierInvoiceDate: { type: Date, default: null },
    grnNo: { type: String, default: "", trim: true, index: true },
    linkedPoNumber: { type: String, default: "" },
    currency: { type: String, default: "USD", trim: true },
    paymentTerms: { type: String, default: "", trim: true },
    lines: { type: [purchaseInvoiceLineSchema], default: [] },
    subTotal: { type: Number, default: 0 },
    taxAmount: { type: Number, default: 0 },
    otherCharges: { type: Number, default: 0, min: 0 },
    totalAmount: { type: Number, default: 0 },
    totalPaidAmount: { type: Number, default: 0, min: 0 },
    balanceAmount: { type: Number, default: 0, min: 0 },
    paymentStatus: {
      type: String,
      enum: ["UNPAID", "PARTIAL", "PAID"],
      default: "UNPAID",
    },
    status: { type: String, enum: ["DRAFT", "POSTED", "CANCELLED"], default: "POSTED", index: true },
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
    remarks: { type: String, default: "" },
    createdBy: { type: String, default: "" },
    updatedBy: { type: String, default: "" },
  },
  { timestamps: true }
);

purchaseInvoiceSchema.index({ companyId: 1, invoiceNumber: 1 }, { unique: true });

export default mongoose.model("PurchaseInvoice", purchaseInvoiceSchema);
