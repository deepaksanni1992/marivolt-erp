import mongoose from "mongoose";

const itemSchema = new mongoose.Schema(
  {
    itemCode: { type: String, required: true, unique: true, trim: true, uppercase: true },
    description: { type: String, default: "", trim: true },
    uom: { type: String, default: "PCS", trim: true },
    vertical: { type: String, default: "", trim: true },
    brand: { type: String, default: "", trim: true },
    modelName: { type: String, default: "", trim: true },
    makerPartNo: { type: String, default: "", trim: true },
    hsnCode: { type: String, default: "", trim: true },
    category: { type: String, default: "", trim: true },

    supplierName: { type: String, default: "", trim: true },
    supplierPartNo: { type: String, default: "", trim: true },
    supplierLeadTimeDays: { type: Number, default: 0 },

    purchasePrice: { type: Number, default: 0 },
    salePrice: { type: Number, default: 0 },
    currency: { type: String, default: "USD", trim: true },

    weightKg: { type: Number, default: 0 },
    /** Country of origin (Excel COO column on item master import). */
    coo: { type: String, default: "", trim: true },
    reorderLevel: { type: Number, default: 0 },
    remarks: { type: String, default: "" },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

itemSchema.index({ description: "text", makerPartNo: "text", supplierPartNo: "text" });
itemSchema.index({ vertical: 1, brand: 1, modelName: 1 });

export default mongoose.model("Item", itemSchema);
