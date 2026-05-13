import mongoose from "mongoose";

const counterSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: "Company", required: true, index: true },
    key: { type: String, required: true, trim: true, lowercase: true },
    seq: { type: Number, required: true, default: 0, min: 0 },
  },
  { timestamps: true, collection: "counters" }
);

counterSchema.index({ companyId: 1, key: 1 }, { unique: true });

export default mongoose.model("Counter", counterSchema);
