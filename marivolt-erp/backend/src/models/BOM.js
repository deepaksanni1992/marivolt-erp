import mongoose from "mongoose";

const bomLineSchema = new mongoose.Schema(
  {
    article: { type: String, required: true, trim: true, uppercase: true },
    componentItemCode: { type: String, default: "", trim: true, uppercase: true },
    qty: { type: Number, required: true, min: 0.0001 },
    optionalFlag: { type: Boolean, default: false },
    interchangeableGroup: { type: String, default: "", trim: true, uppercase: true },
    alternativeArticles: { type: [String], default: [] },
    remarks: { type: String, default: "", trim: true },
    description: { type: String, default: "" },
  },
  { _id: true }
);

const bomSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: "Company", required: true, index: true },
    bomCode: { type: String, default: "", trim: true, uppercase: true, index: true },
    parentItemCode: { type: String, required: true, trim: true, uppercase: true },
    bomName: { type: String, default: "" },
    name: { type: String, default: "" },
    description: { type: String, default: "" },
    kitType: {
      type: String,
      enum: ["ENGINE_OVERHAUL_KIT", "SERVICE_KIT", "CYLINDER_HEAD_KIT", "FUEL_PUMP_KIT", "CUSTOM_KIT"],
      default: "CUSTOM_KIT",
      index: true,
    },
    engineModel: { type: String, default: "", trim: true },
    configuration: { type: String, default: "", trim: true },
    revisionNo: { type: String, default: "R1", trim: true },
    remarks: { type: String, default: "", trim: true },
    workflowMode: {
      type: String,
      enum: ["ASSEMBLY", "DISASSEMBLY", "BOTH"],
      default: "BOTH",
    },
    lines: { type: [bomLineSchema], default: [] },
    isActive: { type: Boolean, default: true },
    createdBy: { type: String, default: "" },
  },
  { timestamps: true }
);

bomSchema.index({ companyId: 1, parentItemCode: 1 }, { unique: true });
bomSchema.index({ companyId: 1, bomCode: 1 }, { unique: true, sparse: true });

export default mongoose.model("BOM", bomSchema);
