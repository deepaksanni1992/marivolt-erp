import mongoose from "mongoose";

const itemTechnicalSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: "Company", required: true, index: true },
    article: { type: String, required: true, ref: "ItemMaster", trim: true, uppercase: true },
    spn: { type: String, default: "", trim: true },
    esn: { type: String, default: "", trim: true },
    materialCode: { type: String, default: "", trim: true },
    drawingNumber: { type: String, default: "", trim: true },
    dimension: { type: String, default: "", trim: true },
    oeMarkings: { type: String, default: "", trim: true },
    extRemarks: { type: String, default: "", trim: true },
    internalRemarks: { type: String, default: "", trim: true },
  },
  { timestamps: true }
);

itemTechnicalSchema.index({ companyId: 1, article: 1 }, { unique: true });
itemTechnicalSchema.index({ companyId: 1, spn: 1, materialCode: 1, drawingNumber: 1 });

export default mongoose.model("ItemTechnical", itemTechnicalSchema);
