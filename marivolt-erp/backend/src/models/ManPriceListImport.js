import mongoose from "mongoose";

const manPriceListImportSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: "Company", required: true, index: true },
    filename: { type: String, default: "" },
    status: { type: String, enum: ["PREVIEW", "APPLIED", "EXPIRED"], default: "PREVIEW", index: true },
    fileHash: { type: String, default: "" },
    rows: { type: [mongoose.Schema.Types.Mixed], default: [] },
    importErrors: { type: [mongoose.Schema.Types.Mixed], default: [] },
    warnings: { type: [mongoose.Schema.Types.Mixed], default: [] },
    itemFingerprints: { type: mongoose.Schema.Types.Mixed, default: {} },
    canApply: { type: Boolean, default: false },
    appliedAt: { type: Date, default: null },
    appliedArticles: { type: [String], default: [] },
    skippedUnchanged: { type: [String], default: [] },
    createdBy: { type: String, default: "" },
    expiresAt: { type: Date, default: () => new Date(Date.now() + 2 * 60 * 60 * 1000) },
  },
  { timestamps: true }
);

manPriceListImportSchema.index({ companyId: 1, createdAt: -1 });
manPriceListImportSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default mongoose.model("ManPriceListImport", manPriceListImportSchema);
