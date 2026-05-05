import mongoose from "mongoose";

const itemSupplierSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: "Company", required: true, index: true },
    article: { type: String, required: true, ref: "ItemMaster", trim: true, uppercase: true },
    supplierName: { type: String, required: true, trim: true },
    supplierPartNumber: { type: String, default: "", trim: true },
    currency: { type: String, default: "USD", trim: true, uppercase: true },
    price: { type: Number, default: 0, min: 0 },
    leadTime: { type: String, default: "", trim: true },
    remarks: { type: String, default: "", trim: true },
  },
  { timestamps: true }
);

itemSupplierSchema.index({ companyId: 1, article: 1 });
itemSupplierSchema.index({ companyId: 1, article: 1, supplierName: 1, supplierPartNumber: 1 }, { unique: true });

export default mongoose.model("ItemSupplier", itemSupplierSchema);
