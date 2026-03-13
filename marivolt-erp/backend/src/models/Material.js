import mongoose from "mongoose";

const materialSchema = new mongoose.Schema(
  {
    materialCode: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },
    spn: {
      type: String,
      required: true,
      trim: true,
    },
    shortDescription: {
      type: String,
      required: true,
      trim: true,
    },
    itemType: {
      type: String,
      enum: ["OEM", "Aftermarket", "Reconditioned"],
      required: true,
    },
    unit: { type: String, required: true, trim: true },
    status: {
      type: String,
      enum: ["Active", "Inactive"],
      default: "Active",
    },
    remarks: { type: String, default: "", trim: true },
  },
  { timestamps: true }
);

materialSchema.index({ materialCode: 1 }, { unique: true });
materialSchema.index({ spn: 1 });
materialSchema.index({ itemType: 1 });
materialSchema.index({ status: 1 });

export default mongoose.model("Material", materialSchema);

