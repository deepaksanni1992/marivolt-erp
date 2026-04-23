import mongoose from "mongoose";

const bomLineSchema = new mongoose.Schema(
  {
    componentItemCode: { type: String, required: true, trim: true, uppercase: true },
    qty: { type: Number, required: true, min: 0.0001 },
    description: { type: String, default: "" },
  },
  { _id: true }
);

const bomSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: "Company", required: true, index: true },
    parentItemCode: { type: String, required: true, trim: true, uppercase: true },
    name: { type: String, default: "" },
    description: { type: String, default: "" },
    lines: { type: [bomLineSchema], default: [] },
    isActive: { type: Boolean, default: true },
    createdBy: { type: String, default: "" },
  },
  { timestamps: true }
);

bomSchema.index({ companyId: 1, parentItemCode: 1 }, { unique: true });

export default mongoose.model("BOM", bomSchema);
