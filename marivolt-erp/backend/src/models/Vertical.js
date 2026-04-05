import mongoose from "mongoose";

const verticalSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },
    status: {
      type: String,
      enum: ["Active", "Inactive"],
      default: "Active",
    },
  },
  { timestamps: true }
);

verticalSchema.index({ name: 1 }, { unique: true });
verticalSchema.index({ status: 1 });

export default mongoose.model("Vertical", verticalSchema);
