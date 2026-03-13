import mongoose from "mongoose";

const articleSchema = new mongoose.Schema(
  {
    articleNo: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },
    materialCode: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    description: { type: String, required: true, trim: true },
    drawingNo: { type: String, default: "", trim: true },
    maker: { type: String, default: "", trim: true },
    brand: { type: String, default: "", trim: true },
    unit: { type: String, default: "", trim: true },
    weight: { type: Number, default: 0 },
    hsnCode: { type: String, default: "", trim: true },
    status: {
      type: String,
      enum: ["Active", "Inactive"],
      default: "Active",
    },
    remarks: { type: String, default: "", trim: true },
  },
  { timestamps: true }
);

articleSchema.index({ articleNo: 1 }, { unique: true });
articleSchema.index({ materialCode: 1 });
articleSchema.index({ brand: 1 });

export default mongoose.model("Article", articleSchema);

