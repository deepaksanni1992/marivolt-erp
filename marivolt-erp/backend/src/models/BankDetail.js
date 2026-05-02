import mongoose from "mongoose";

const bankDetailSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: "Company", required: true, index: true },
    bankName: { type: String, required: true, trim: true },
    accountName: { type: String, required: true, trim: true },
    accountNumber: { type: String, required: true, trim: true },
    currency: { type: String, default: "USD", trim: true, uppercase: true },
    branchName: { type: String, default: "", trim: true },
    swiftCode: { type: String, default: "", trim: true },
    iban: { type: String, default: "", trim: true },
    bankAddress: { type: String, default: "" },
    correspondentBankName: { type: String, default: "", trim: true },
    correspondentSwiftCode: { type: String, default: "", trim: true },
    beneficiaryName: { type: String, default: "", trim: true },
    beneficiaryAddress: { type: String, default: "" },
    purposeOfPayment: { type: String, default: "", trim: true },
    isDefault: { type: Boolean, default: false },
    remarks: { type: String, default: "" },
    createdBy: { type: String, default: "" },
    updatedBy: { type: String, default: "" },
  },
  { timestamps: true }
);

bankDetailSchema.index({ companyId: 1, bankName: 1, accountNumber: 1 }, { unique: true });
bankDetailSchema.index({ companyId: 1, currency: 1 });

export default mongoose.model("BankDetail", bankDetailSchema);

