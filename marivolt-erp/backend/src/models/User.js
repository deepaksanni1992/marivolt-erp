import mongoose from "mongoose";

/**
 * User — Phase-10 expansion.
 *
 * Backward compatibility:
 * - `role` enum and `allowedCompanies` / `defaultCompany` are kept
 *   exactly as before so existing tokens, login flow, and admin UI
 *   continue to work.
 * - Phase-10 adds optional fields for branch/warehouse scoping,
 *   structured role assignments, additional permission overrides,
 *   and last-activity metadata.
 */
const userSchema = new mongoose.Schema(
  {
    name: { type: String, default: "" },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    username: { type: String, unique: true, sparse: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true },
    role: {
      type: String,
      enum: [
        "super_admin",
        "company_admin",
        "admin",
        "staff",
        "purchase_sales",
        "accounts_logistics",
        // Phase-10 system role codes (lowercased to match existing enum style).
        "sales",
        "purchase",
        "store",
        "logistics",
        "accounts",
        "view_only",
      ],
      default: "staff",
    },
    /** Phase-10: optional structured role link (one or many). */
    roleIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "Role", default: [] }],
    allowedCompanies: [{ type: mongoose.Schema.Types.ObjectId, ref: "Company", index: true }],
    defaultCompany: { type: mongoose.Schema.Types.ObjectId, ref: "Company", default: null, index: true },
    /** Phase-10: per-company branch and warehouse access lists. Empty = all. */
    allowedBranches: [{ type: mongoose.Schema.Types.ObjectId, ref: "Branch", default: [] }],
    allowedWarehouses: [{ type: mongoose.Schema.Types.ObjectId, ref: "Warehouse", default: [] }],
    /** Phase-10: optional per-user permission overrides on top of role matrix. */
    permissionOverrides: {
      type: [
        new mongoose.Schema(
          {
            module: { type: String, default: "" },
            actions: { type: [String], default: [] },
          },
          { _id: false }
        ),
      ],
      default: [],
    },
    /** Phase-10: activity metadata (best-effort, written by auth routes). */
    lastLoginAt: { type: Date, default: null },
    lastLoginIp: { type: String, default: "" },
    lastLoginAgent: { type: String, default: "" },
    isActive: { type: Boolean, default: true, index: true },
  },
  { timestamps: true }
);

export default mongoose.model("User", userSchema);
