import mongoose from "mongoose";

const docCounterSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: "Company", required: true, index: true },
    docKey: { type: String, required: true, trim: true, uppercase: true },
    seq: { type: Number, required: true, default: 0, min: 0 },
  },
  { timestamps: true }
);

docCounterSchema.index({ companyId: 1, docKey: 1 }, { unique: true });

export default mongoose.model("DocCounter", docCounterSchema);
