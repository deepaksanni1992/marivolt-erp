import mongoose from "mongoose";

const dekitLineSnapshotSchema = new mongoose.Schema(
  {
    componentItemCode: { type: String, required: true, trim: true, uppercase: true },
    qtyPerKit: { type: Number, required: true, min: 0 },
    description: { type: String, default: "" },
  },
  { _id: false }
);

const deKittingOrderSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: "Company", required: true, index: true },
    dekitNumber: { type: String, required: true, trim: true },
    parentItemCode: { type: String, required: true, trim: true, uppercase: true },
    kitType: {
      type: String,
      enum: ["ENGINE_OVERHAUL_KIT", "SERVICE_KIT", "CYLINDER_HEAD_KIT", "FUEL_PUMP_KIT", "CUSTOM_KIT"],
      default: "CUSTOM_KIT",
      index: true,
    },
    disassemblyMode: {
      type: String,
      enum: ["STANDARD_DISASSEMBLY", "SERVICE_BREAKDOWN", "OVERHAUL_BREAKDOWN", "ENGINE_BREAKDOWN"],
      default: "STANDARD_DISASSEMBLY",
    },
    disassemblyReason: { type: String, default: "", trim: true },
    linkedEngineModel: { type: String, default: "", trim: true },
    linkedEngineESN: { type: String, default: "", trim: true },
    sourceReference: { type: String, default: "", trim: true },
    warehouse: { type: String, required: true, trim: true, default: "MAIN" },
    kitBatch: { type: String, default: "", trim: true, index: true },
    assemblyDate: { type: Date, default: null },
    assembledBy: { type: String, default: "", trim: true },
    linkedBomRevision: { type: String, default: "", trim: true },
    assembledCost: { type: Number, default: 0, min: 0 },
    componentCostTotal: { type: Number, default: 0, min: 0 },
    quantity: { type: Number, required: true, min: 0.0001 },
    bomId: { type: mongoose.Schema.Types.ObjectId, ref: "BOM", required: true },
    status: {
      type: String,
      enum: ["DRAFT", "COMPLETED", "CANCELLED"],
      default: "DRAFT",
    },
    linesSnapshot: { type: [dekitLineSnapshotSchema], default: [] },
    remarks: { type: String, default: "" },
    createdBy: { type: String, default: "" },
  },
  { timestamps: true }
);

deKittingOrderSchema.index({ companyId: 1, dekitNumber: 1 }, { unique: true });
deKittingOrderSchema.index({ companyId: 1, parentItemCode: 1, createdAt: -1 });
deKittingOrderSchema.index({ status: 1 });

export default mongoose.model("DeKittingOrder", deKittingOrderSchema);
