import mongoose from "mongoose";

const UOM_VALUES = ["PCS", "SET", "KG", "NOS", "MTR"];

const itemMasterSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: "Company", required: true, index: true },
    article: { type: String, required: true, trim: true, uppercase: true },
    itemName: { type: String, required: true, trim: true },
    description: { type: String, default: "", trim: true },
    materialCode: { type: String, default: "", trim: true },
    spn: { type: String, default: "", trim: true },
    companyCode: { type: String, default: "", trim: true, uppercase: true },
    source: { type: String, default: "", trim: true },
    vertical: { type: String, default: "", trim: true },
    engine: { type: String, default: "", trim: true },
    model: { type: String, default: "", trim: true },
    config: { type: String, default: "", trim: true },
    uom: { type: String, enum: UOM_VALUES, default: "PCS" },
    status: { type: String, enum: ["Active", "Inactive"], default: "Active" },
  },
  { timestamps: true }
);

itemMasterSchema.index({ companyId: 1, article: 1 }, { unique: true });
itemMasterSchema.index({ companyId: 1, vertical: 1, engine: 1, model: 1 });
itemMasterSchema.index({
  article: "text",
  itemName: "text",
  description: "text",
  engine: "text",
  model: "text",
  config: "text",
});

export { UOM_VALUES };
export default mongoose.model("ItemMaster", itemMasterSchema);
