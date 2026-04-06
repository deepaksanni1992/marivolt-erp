import mongoose from "mongoose";

const itemSchema = new mongoose.Schema(
  {
    itemCode: { type: String, required: true, unique: true, trim: true, uppercase: true },
    description: { type: String, default: "", trim: true },
    uom: { type: String, default: "PCS", trim: true },
    brand: { type: String, default: "", trim: true },
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
    reorderLevel: { type: Number, default: 0 },
    remarks: { type: String, default: "" },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

itemSchema.index({ description: "text", makerPartNo: "text", supplierPartNo: "text" });

export default mongoose.model("Item", itemSchema);
