import mongoose from "mongoose";

const communicationThreadSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: "Company", required: true, index: true },
    threadNo: { type: String, required: true, trim: true },
    threadType: {
      type: String,
      enum: ["CUSTOMER_COMMUNICATION", "SUPPLIER_COMMUNICATION", "DOCUMENT_APPROVAL", "INTERNAL_REVIEW"],
      default: "CUSTOMER_COMMUNICATION",
      index: true,
    },
    partyType: { type: String, enum: ["CUSTOMER", "SUPPLIER", "INTERNAL"], default: "INTERNAL", index: true },
    partyName: { type: String, default: "", trim: true, index: true },
    partyEmail: { type: String, default: "", trim: true, index: true },
    relatedModule: { type: String, default: "", trim: true, index: true },
    relatedId: { type: String, default: "", trim: true },
    linkedDocuments: {
      type: [
        {
          documentType: {
            type: String,
            enum: ["QUOTATION", "SALES_INVOICE", "PURCHASE_INVOICE", "SHIPMENT", "PURCHASE_ORDER", "GRN", "PAYMENT", "OTHER"],
            default: "OTHER",
          },
          documentId: { type: String, default: "" },
          documentNo: { type: String, default: "" },
        },
      ],
      default: [],
    },
    subject: { type: String, default: "", trim: true },
    status: {
      type: String,
      enum: ["OPEN", "WAITING_REPLY", "CLOSED"],
      default: "OPEN",
      index: true,
    },
    portalReady: { type: Boolean, default: false, index: true },
    portalReference: { type: String, default: "", trim: true },
    messageCount: { type: Number, default: 0, min: 0 },
    lastMessageAt: { type: Date, default: null, index: true },
    lastMessageBy: { type: String, default: "" },
    tags: { type: [String], default: [] },
    createdBy: { type: String, default: "" },
    updatedBy: { type: String, default: "" },
  },
  { timestamps: true }
);

communicationThreadSchema.index({ companyId: 1, threadNo: 1 }, { unique: true });
communicationThreadSchema.index({ companyId: 1, partyType: 1, status: 1, updatedAt: -1 });

export default mongoose.model("CommunicationThread", communicationThreadSchema);

