import mongoose from "mongoose";

const analyticsKpiSnapshotSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: "Company", required: true, index: true },
    snapshotDate: { type: Date, required: true, index: true },
    snapshotType: { type: String, enum: ["DAILY", "MONTHLY"], required: true, index: true },
    filtersHash: { type: String, default: "", trim: true, index: true },
    payloadVersion: { type: String, default: "v1", trim: true },
    // Prepared for future scheduler: store compact KPI projection only.
    payload: { type: mongoose.Schema.Types.Mixed, default: {} },
    generatedAt: { type: Date, default: () => new Date() },
    generatedBy: { type: String, default: "system" },
  },
  { timestamps: true }
);

analyticsKpiSnapshotSchema.index({ companyId: 1, snapshotType: 1, snapshotDate: -1 });
analyticsKpiSnapshotSchema.index({ companyId: 1, filtersHash: 1, snapshotDate: -1 });

export default mongoose.model("AnalyticsKpiSnapshot", analyticsKpiSnapshotSchema);

