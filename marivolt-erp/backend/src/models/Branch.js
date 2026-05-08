import mongoose from "mongoose";

/**
 * Branch master — Phase-10.
 *
 * One company can have many branches (e.g. Dubai HQ, Abu Dhabi
 * branch, JAFZA office). A Branch is the unit used for:
 *   • numbering series scoping (per company + per branch)
 *   • user access scoping (a user can be limited to one or more
 *     branches inside their allowed company)
 *   • report filtering (Sales By Branch already exists)
 */
const branchSchema = new mongoose.Schema(
  {
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Company",
      required: true,
      index: true,
    },
    branchCode: { type: String, required: true, trim: true, uppercase: true },
    branchName: { type: String, required: true, trim: true },
    address: { type: String, default: "", trim: true },
    country: { type: String, default: "", trim: true },
    phone: { type: String, default: "", trim: true },
    email: { type: String, default: "", trim: true, lowercase: true },
    /** Optional TRN/VAT/registration override at branch level. */
    trnNo: { type: String, default: "", trim: true },
    registrationNo: { type: String, default: "", trim: true },
    /** Convenience link list — populated, but Warehouse.branchId is the source of truth. */
    warehouses: [{ type: mongoose.Schema.Types.ObjectId, ref: "Warehouse" }],
    isActive: { type: Boolean, default: true, index: true },
    createdBy: { type: String, default: "" },
    updatedBy: { type: String, default: "" },
  },
  { timestamps: true }
);

branchSchema.index({ companyId: 1, branchCode: 1 }, { unique: true });
branchSchema.index({ companyId: 1, isActive: 1, branchName: 1 });

export default mongoose.model("Branch", branchSchema);
