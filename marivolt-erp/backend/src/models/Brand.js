import mongoose from "mongoose";

const brandSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    vertical: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Vertical",
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

brandSchema.index({ vertical: 1, name: 1 }, { unique: true });
brandSchema.index({ status: 1 });

export default mongoose.model("Brand", brandSchema);
