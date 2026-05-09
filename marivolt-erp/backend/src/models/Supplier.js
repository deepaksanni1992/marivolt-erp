import mongoose from "mongoose";

const bankDetailSchema = new mongoose.Schema(
  {
    accountName: { type: String, default: "", trim: true },
    accountNumber: { type: String, default: "", trim: true },
    bankName: { type: String, default: "", trim: true },
    iban: { type: String, default: "", trim: true },
    swiftCode: { type: String, default: "", trim: true },
    branchName: { type: String, default: "", trim: true },
    currency: { type: String, default: "USD", trim: true, uppercase: true },
    isDefault: { type: Boolean, default: false },
  },
  { _id: true }
);

const supplierSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: "Company", required: true, index: true },
    supplierCode: { type: String, sparse: true, trim: true, uppercase: true, required: true },
    supplierName: { type: String, required: true, trim: true, index: true },
    shortName: { type: String, default: "", trim: true },
    supplierType: { type: String, default: "LOCAL", trim: true, uppercase: true },
    country: { type: String, default: "", trim: true },
    phone: { type: String, default: "" },
    email: { type: String, default: "" },
    address: { type: String, default: "" },
    vatNo: { type: String, default: "" },
    registrationNo: { type: String, default: "" },
    contactPerson: { type: String, default: "", trim: true },
    paymentTerms: { type: String, default: "", trim: true },
    currency: { type: String, default: "USD", trim: true, uppercase: true },
    bankDetails: { type: [bankDetailSchema], default: [] },
    remarks: { type: String, default: "" },
    activeStatus: { type: Boolean, default: true },
    createdBy: { type: String, default: "" },

    // Backward-compatible aliases used by existing Purchase UI/logic.
    name: { type: String, default: "", trim: true },
    contactName: { type: String, default: "" },
    tradeLicenseNo: { type: String, default: "" },
    gstNo: { type: String, default: "" },
    panNo: { type: String, default: "" },
    notes: { type: String, default: "" },
  },
  { timestamps: true }
);

supplierSchema.index({ companyId: 1, supplierCode: 1 }, { unique: true, sparse: true });
supplierSchema.index({ companyId: 1, supplierName: 1 });

supplierSchema.pre("validate", function syncLegacyFields(next) {
  if (!this.supplierName && this.name) this.supplierName = String(this.name);
  if (!this.name && this.supplierName) this.name = String(this.supplierName);
  if (!this.contactPerson && this.contactName) this.contactPerson = String(this.contactName);
  if (!this.contactName && this.contactPerson) this.contactName = String(this.contactPerson);
  if (!this.remarks && this.notes) this.remarks = String(this.notes);
  if (!this.notes && this.remarks) this.notes = String(this.remarks);
  this.activeStatus = this.activeStatus !== false;
  next();
});

export default mongoose.model("Supplier", supplierSchema);
