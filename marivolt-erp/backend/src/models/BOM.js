import mongoose from "mongoose";

const bomLineSchema = new mongoose.Schema(
  {
    itemId: { type: mongoose.Schema.Types.ObjectId, ref: "Item", required: true },
    article: { type: String, default: "" },
    description: { type: String, default: "" },
    spn: { type: String, default: "" },
    name: { type: String, default: "" },
    unitWeight: { type: Number, default: 0 },
    qty: { type: Number, required: true, min: 0.0001 },
  },
  { _id: true }
);

const bomSchema = new mongoose.Schema(
  {
    parentItemId: { type: mongoose.Schema.Types.ObjectId, ref: "Item", required: true },
    parentArticle: { type: String, default: "" },
    parentDescription: { type: String, default: "" },
    parentSpn: { type: String, default: "" },
    parentName: { type: String, default: "" },
    parentUnitWeight: { type: Number, default: 0 },
    name: { type: String, default: "" }, // optional BOM name/version
    lines: [bomLineSchema],
  },
  { timestamps: true }
);

bomSchema.index({ parentItemId: 1 });

export default mongoose.model("BOM", bomSchema);
