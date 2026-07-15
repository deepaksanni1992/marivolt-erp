import mongoose from "mongoose";

const customerSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: "Company", required: true, index: true },
    name: { type: String, required: true, trim: true },
    contactName: { type: String, default: "" },
    /** Default Attention for quotations / OA / PI / invoices (editable per document). */
    attention: { type: String, default: "", trim: true },
    phone: { type: String, default: "" },
    email: { type: String, default: "" },
    /** Legacy single address — kept for backward compatibility. */
    address: { type: String, default: "" },
    billingAddress: { type: String, default: "", trim: true },
    shippingAddress: { type: String, default: "", trim: true },
    /**
     * Credit Terms — internal ERP workflow only (ADVANCE | CREDIT).
     * Controls allocation / PI readiness. NEVER printed on customer documents.
     */
    paymentTerms: {
      type: String,
      enum: ["ADVANCE", "CREDIT"],
      default: "CREDIT",
    },
    /**
     * Payment Terms — commercial free-text shown on Quotation / OA / PI / Invoice / Packing PDFs.
     * Independent of Credit Terms. Never used for stock allocation.
     */
    documentPaymentTerms: { type: String, default: "", trim: true },
    notes: { type: String, default: "" },
  },
  { timestamps: true }
);

customerSchema.index({ companyId: 1, name: 1 }, { unique: true });

export default mongoose.model("Customer", customerSchema);
