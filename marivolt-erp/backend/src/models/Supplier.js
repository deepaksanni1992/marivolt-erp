import mongoose from "mongoose";

const supplierSchema = new mongoose.Schema(
  {
    supplierCode: { type: String, unique: true, sparse: true, trim: true, uppercase: true },
    name: { type: String, required: true, unique: true, trim: true },
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

export default mongoose.model("Supplier", supplierSchema);
