import mongoose from "mongoose";

const communicationTemplateSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: "Company", required: true, index: true },
    templateCode: { type: String, required: true, trim: true, uppercase: true, index: true },
    templateName: { type: String, required: true, trim: true },
    templateType: {
      type: String,
      enum: ["QUOTATION_FOLLOWUP", "PAYMENT_REMINDER", "DISPATCH_UPDATE", "SUPPLIER_ENQUIRY", "SHIPMENT_DELAY", "CUSTOM"],
      default: "CUSTOM",
      index: true,
    },
    subjectTemplate: { type: String, default: "", trim: true },
    messageTemplate: { type: String, default: "" },
    channel: { type: String, enum: ["EMAIL", "PORTAL", "SYSTEM", "OTHER"], default: "EMAIL" },
    portalVisible: { type: Boolean, default: false },
    active: { type: Boolean, default: true, index: true },
    createdBy: { type: String, default: "" },
    updatedBy: { type: String, default: "" },
  },
  { timestamps: true }
);

communicationTemplateSchema.index({ companyId: 1, templateCode: 1 }, { unique: true });

export default mongoose.model("CommunicationTemplate", communicationTemplateSchema);

