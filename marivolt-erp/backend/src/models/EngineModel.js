import mongoose from "mongoose";

const engineModelSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    brand: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Brand",
      required: true,
      index: true,
    },
    status: {
      type: String,
      enum: ["Active", "Inactive"],
      default: "Active",
    },
  },
  { timestamps: true }
);

engineModelSchema.index({ brand: 1, name: 1 }, { unique: true });
engineModelSchema.index({ status: 1 });

export default mongoose.model("EngineModel", engineModelSchema);
