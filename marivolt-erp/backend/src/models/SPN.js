import mongoose from "mongoose";

const spnSchema = new mongoose.Schema(
  {
    spn: { type: String, required: true, unique: true, trim: true },
    partName: { type: String, required: true, trim: true },
    genericDescription: { type: String, default: "", trim: true },
    category: { type: String, default: "", trim: true },
    subCategory: { type: String, default: "", trim: true },
    uom: { type: String, default: "", trim: true },
    status: {
      type: String,
      enum: ["Active", "Inactive"],
      default: "Active",
    },
    remarks: { type: String, default: "", trim: true },
  },
  { timestamps: true }
);

spnSchema.index({ spn: 1 }, { unique: true });
spnSchema.index({ partName: 1 });

export default mongoose.model("SPN", spnSchema);

