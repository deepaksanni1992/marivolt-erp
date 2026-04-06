import mongoose from "mongoose";

const itemMappingSchema = new mongoose.Schema(
  {
    article: { type: String, required: true, trim: true, uppercase: true, index: true },
    model: { type: String, default: "", trim: true },
    esn: { type: String, default: "", trim: true },
    mpn: { type: String, default: "", trim: true },
    partNumber: { type: String, default: "", trim: true },
    materialCode: { type: String, default: "", trim: true },
    drawingNumber: { type: String, default: "", trim: true },
    description: { type: String, default: "", trim: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

itemMappingSchema.index({ article: 1, mpn: 1 });
itemMappingSchema.index({ article: 1, model: 1 });

export default mongoose.model("ItemMapping", itemMappingSchema);
