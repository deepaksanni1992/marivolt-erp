import mongoose from "mongoose";

/**
 * Setting — Phase-10.
 *
 * Generic per-company configuration store. Keys live under namespaces
 * so the UI can group related settings:
 *   • COMPANY     — display defaults, logo, address overrides
 *   • TAX         — default tax rates, TRN format
 *   • CURRENCY    — base currency, supported FX list
 *   • APPROVAL    — module-level approval thresholds and rules
 *   • WAREHOUSE   — default warehouse / location preferences
 *   • NUMBERING   — informational only; the canonical number series
 *                   config lives in NumberSeriesConfig
 *   • OTHER       — free-form
 */
const settingSchema = new mongoose.Schema(
  {
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Company",
      required: true,
      index: true,
    },
    branchId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Branch",
      default: null,
      index: true,
    },
    namespace: {
      type: String,
      enum: ["COMPANY", "TAX", "CURRENCY", "APPROVAL", "WAREHOUSE", "NUMBERING", "OTHER"],
      required: true,
      index: true,
    },
    key: { type: String, required: true, trim: true },
    value: { type: mongoose.Schema.Types.Mixed, default: null },
    description: { type: String, default: "" },
    updatedBy: { type: String, default: "" },
  },
  { timestamps: true }
);

settingSchema.index(
  { companyId: 1, branchId: 1, namespace: 1, key: 1 },
  { unique: true }
);

export default mongoose.model("Setting", settingSchema);
