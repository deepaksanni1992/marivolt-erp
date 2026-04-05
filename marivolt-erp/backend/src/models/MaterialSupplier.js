import mongoose from "mongoose";

const materialSupplierSchema = new mongoose.Schema(
  {
    materialCode: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    supplierName: { type: String, required: true, trim: true },
    supplierArticleNo: { type: String, default: "", trim: true },
    supplierDescription: { type: String, default: "", trim: true },
    currency: { type: String, default: "", trim: true },
    price: { type: Number, default: 0 },
    leadTimeDays: { type: Number, default: 0 },
    moq: { type: Number, default: 0 },
    supplierCountry: { type: String, default: "", trim: true },
    preferred: { type: Boolean, default: false },
    status: {
      type: String,
      enum: ["Active", "Inactive"],
      default: "Active",
    },
    remarks: { type: String, default: "", trim: true },
  },
  { timestamps: true }
);

materialSupplierSchema.index({ materialCode: 1 });
materialSupplierSchema.index({ supplierName: 1 });
materialSupplierSchema.index({ materialCode: 1, preferred: 1 });

export default mongoose.model("MaterialSupplier", materialSupplierSchema);
