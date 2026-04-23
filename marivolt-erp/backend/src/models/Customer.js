import mongoose from "mongoose";

const customerSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: "Company", required: true, index: true },
    name: { type: String, required: true, trim: true },
    contactName: { type: String, default: "" },
    phone: { type: String, default: "" },
    email: { type: String, default: "" },
    address: { type: String, default: "" },
    paymentTerms: {
      type: String,
      enum: ["ADVANCE", "CREDIT"],
      default: "CREDIT",
    },
    notes: { type: String, default: "" },
  },
  { timestamps: true }
);

customerSchema.index({ companyId: 1, name: 1 }, { unique: true });

export default mongoose.model("Customer", customerSchema);
