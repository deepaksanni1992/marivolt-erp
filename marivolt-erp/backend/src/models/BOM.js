import mongoose from "mongoose";

const bomLineSchema = new mongoose.Schema(
  {
    /** Internal material identifier (Material Master) */
    materialCode: { type: String, default: "", trim: true },
    /** Article / part number used for stock (StockTxn.article) and kitting */
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
    /** Parent finished good (Material Master) */
    parentMaterialCode: { type: String, default: "", trim: true },
    parentArticle: { type: String, default: "" },
    parentDescription: { type: String, default: "" },
    parentSpn: { type: String, default: "" },
    parentName: { type: String, default: "" },
    parentUnitWeight: { type: Number, default: 0 },
    name: { type: String, default: "" },
    lines: [bomLineSchema],
  },
  { timestamps: true }
);

bomSchema.index({ parentMaterialCode: 1 });

export default mongoose.model("BOM", bomSchema);
