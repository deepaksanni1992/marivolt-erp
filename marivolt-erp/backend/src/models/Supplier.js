import mongoose from "mongoose";

const supplierSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: "Company", required: true, index: true },
    supplierCode: { type: String, sparse: true, trim: true, uppercase: true },
    name: { type: String, required: true, trim: true },
    contactName: { type: String, default: "" },
    phone: { type: String, default: "" },
    email: { type: String, default: "" },
    address: { type: String, default: "" },
    gstNo: { type: String, default: "" },
    panNo: { type: String, default: "" },
    notes: { type: String, default: "" },
  },
  { timestamps: true }
);

supplierSchema.index({ companyId: 1, supplierCode: 1 }, { unique: true, sparse: true });
supplierSchema.index({ companyId: 1, name: 1 }, { unique: true });

export default mongoose.model("Supplier", supplierSchema);
