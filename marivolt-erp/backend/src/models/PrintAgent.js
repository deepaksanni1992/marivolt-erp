import mongoose from "mongoose";

const printAgentSchema = new mongoose.Schema(
  {
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Company",
      required: true,
      index: true,
    },
    agentId: { type: String, required: true, trim: true, uppercase: true },
    name: { type: String, default: "", trim: true },
    computerName: { type: String, default: "", trim: true },
    secretHash: { type: String, required: true },
    warehouseId: { type: mongoose.Schema.Types.ObjectId, ref: "Warehouse", default: null },
    warehouseCode: { type: String, default: "", trim: true, uppercase: true },
    status: {
      type: String,
      enum: ["ONLINE", "OFFLINE"],
      default: "OFFLINE",
      index: true,
    },
    lastHeartbeatAt: { type: Date, default: null },
    lastIp: { type: String, default: "" },
    appVersion: { type: String, default: "" },
    isActive: { type: Boolean, default: true, index: true },
    createdBy: { type: String, default: "" },
  },
  { timestamps: true }
);

printAgentSchema.index({ companyId: 1, agentId: 1 }, { unique: true });
printAgentSchema.index({ agentId: 1 }, { unique: true });

export default mongoose.model("PrintAgent", printAgentSchema);
