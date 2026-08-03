import mongoose from "mongoose";

/**
 * Enterprise print agent profile.
 * Additive fields only — existing agents remain valid with defaults.
 * effectiveStatus is computed at read time: DISABLED | ONLINE | OFFLINE
 */
const printAgentSchema = new mongoose.Schema(
  {
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Company",
      required: true,
      index: true,
    },
    agentId: { type: String, required: true, trim: true, uppercase: true },
    /** Stable local install UUID — used for idempotent bootstrap */
    installationId: { type: String, default: "", trim: true, index: true },
    /** Friendly display name, e.g. "Warehouse Agent 01" */
    name: { type: String, default: "", trim: true },
    computerName: { type: String, default: "", trim: true, index: true },
    secretHash: { type: String, required: true },
    branchId: { type: mongoose.Schema.Types.ObjectId, ref: "Branch", default: null, index: true },
    branchName: { type: String, default: "", trim: true },
    warehouseId: { type: mongoose.Schema.Types.ObjectId, ref: "Warehouse", default: null },
    warehouseCode: { type: String, default: "", trim: true, uppercase: true, index: true },
    warehouseName: { type: String, default: "", trim: true },
    department: { type: String, default: "", trim: true },
    description: { type: String, default: "", trim: true },
    operatingSystem: { type: String, default: "", trim: true },
    windowsVersion: { type: String, default: "", trim: true },
    appVersion: { type: String, default: "", trim: true },
    /** Detected Windows printer queue names from last heartbeat (capped) */
    availablePrinters: { type: [String], default: [] },
    /**
     * Per-printer health snapshot from agent.
     * Legacy: [{ name, online }]
     * Current: [{ name, status, connected, offline, paused, paperOut, queueLength, statusMessage, lastSeen, online }]
     * Agent ONLINE is independent of these rows.
     */
    printerStatus: { type: [mongoose.Schema.Types.Mixed], default: [] },
    status: {
      type: String,
      enum: ["ONLINE", "OFFLINE"],
      default: "OFFLINE",
      index: true,
    },
    lastHeartbeatAt: { type: Date, default: null },
    lastIp: { type: String, default: "" },
    lastError: { type: String, default: "" },
    isActive: { type: Boolean, default: true, index: true },
    createdBy: { type: String, default: "" },
  },
  { timestamps: true }
);

printAgentSchema.index({ companyId: 1, agentId: 1 }, { unique: true });
printAgentSchema.index({ agentId: 1 }, { unique: true });
printAgentSchema.index({ companyId: 1, warehouseCode: 1, isActive: 1 });
printAgentSchema.index({ companyId: 1, computerName: 1 });
printAgentSchema.index({ companyId: 1, status: 1, lastHeartbeatAt: -1 });
printAgentSchema.index(
  { companyId: 1, installationId: 1 },
  {
    unique: true,
    partialFilterExpression: { installationId: { $type: "string", $gt: "" } },
  }
);

export default mongoose.model("PrintAgent", printAgentSchema);
