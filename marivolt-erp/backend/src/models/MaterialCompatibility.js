import mongoose from "mongoose";

const materialCompatibilitySchema = new mongoose.Schema(
  {
    materialCode: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    brand: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    engineModel: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    configuration: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    cylinderCount: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    esnFrom: { type: Number, default: null },
    esnTo: { type: Number, default: null },
    remarks: { type: String, default: "", trim: true },
    status: {
      type: String,
      enum: ["Active", "Inactive"],
      default: "Active",
    },
  },
  { timestamps: true }
);

materialCompatibilitySchema.index(
  {
    materialCode: 1,
    brand: 1,
    engineModel: 1,
    configuration: 1,
    cylinderCount: 1,
    esnFrom: 1,
    esnTo: 1,
  },
  {
    unique: true,
    name: "uniq_material_compat_rule",
  }
);

export default mongoose.model(
  "MaterialCompatibility",
  materialCompatibilitySchema
);
