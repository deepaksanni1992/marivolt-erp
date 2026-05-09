import mongoose from "mongoose";

const communicationMessageSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: "Company", required: true, index: true },
    threadId: { type: mongoose.Schema.Types.ObjectId, ref: "CommunicationThread", required: true, index: true },
    sender: { type: String, default: "", trim: true, index: true },
    recipient: { type: String, default: "", trim: true, index: true },
    message: { type: String, default: "" },
    subject: { type: String, default: "", trim: true },
    channel: {
      type: String,
      enum: ["EMAIL", "PORTAL", "SYSTEM", "OTHER"],
      default: "SYSTEM",
    },
    direction: {
      type: String,
      enum: ["OUTBOUND", "INBOUND", "INTERNAL_NOTE"],
      default: "INTERNAL_NOTE",
      index: true,
    },
    visibility: {
      type: String,
      enum: ["INTERNAL", "CUSTOMER", "SUPPLIER", "ALL"],
      default: "INTERNAL",
      index: true,
    },
    portalVisible: { type: Boolean, default: false, index: true },
    attachments: {
      type: [
        {
          documentId: { type: mongoose.Schema.Types.ObjectId, ref: "Document", default: null },
          fileName: { type: String, default: "" },
        },
      ],
      default: [],
    },
    sentAt: { type: Date, default: null, index: true },
    createdBy: { type: String, default: "" },
  },
  { timestamps: true }
);

communicationMessageSchema.index({ companyId: 1, threadId: 1, createdAt: -1 });

export default mongoose.model("CommunicationMessage", communicationMessageSchema);

