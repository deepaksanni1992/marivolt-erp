import mongoose from "mongoose";

const previewLineSchema = new mongoose.Schema(
  {
    article: { type: String, required: true, trim: true, uppercase: true },
    qty: { type: Number, required: true, min: 0 },
    uom: { type: String, default: "", trim: true, uppercase: true },
    description: { type: String, default: "" },
  },
  { _id: false }
);

const dekitLineSnapshotSchema = new mongoose.Schema(
  {
    lineId: { type: String, default: "" },
    componentItemCode: { type: String, required: true, trim: true, uppercase: true },
    componentUom: { type: String, default: "", trim: true, uppercase: true },
    componentItemName: { type: String, default: "" },
    qtyPerKit: { type: Number, required: true, min: 0 },
    description: { type: String, default: "" },
    optionalFlag: { type: Boolean, default: false },
    alternativeArticles: { type: [String], default: [] },
  },
  { _id: false }
);

const deKittingOrderSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: "Company", required: true, index: true },
    dekitNumber: { type: String, required: true, trim: true },
    parentItemCode: { type: String, required: true, trim: true, uppercase: true },
    parentUom: { type: String, default: "", trim: true, uppercase: true },
    parentItemName: { type: String, default: "", trim: true },
    kitType: {
      type: String,
      enum: [
        "ENGINE_OVERHAUL_KIT",
        "SERVICE_KIT",
        "CYLINDER_HEAD_KIT",
        "FUEL_PUMP_KIT",
        "CUSTOM_KIT",
        "PACK_CONVERSION",
      ],
      default: "CUSTOM_KIT",
      index: true,
    },
    bomKind: {
      type: String,
      enum: ["PACK_CONVERSION", "GENERIC"],
      default: "GENERIC",
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
    bomSnapshotAt: { type: Date, default: null },
    assembledCost: { type: Number, default: 0, min: 0 },
    componentCostTotal: { type: Number, default: 0, min: 0 },
    quantity: { type: Number, required: true, min: 0.0001 },
    previewConsume: { type: [previewLineSchema], default: [] },
    previewProduce: { type: [previewLineSchema], default: [] },
    bomId: { type: mongoose.Schema.Types.ObjectId, ref: "BOM", required: true },
    workflowMode: { type: String, default: "BOTH", trim: true, uppercase: true },
    status: {
      type: String,
      enum: ["DRAFT", "POSTING", "COMPLETED", "CANCELLED", "REVERSING", "REVERSED"],
      default: "DRAFT",
    },
    linesSnapshot: { type: [dekitLineSnapshotSchema], default: [] },
    postingOperationId: { type: String, default: "", trim: true },
    postedAt: { type: Date, default: null },
    postedBy: { type: String, default: "", trim: true },
    ledgerEffectKeys: { type: [String], default: [] },
    reversalStatus: {
      type: String,
      enum: ["NONE", "REVERSING", "REVERSED"],
      default: "NONE",
    },
    reversedAt: { type: Date, default: null },
    reversedBy: { type: String, default: "", trim: true },
    reversalOperationId: { type: String, default: "", trim: true },
    reversalReason: { type: String, default: "", trim: true },
    remarks: { type: String, default: "" },
    createdBy: { type: String, default: "" },
  },
  { timestamps: true }
);

deKittingOrderSchema.index({ companyId: 1, dekitNumber: 1 }, { unique: true });
deKittingOrderSchema.index({ companyId: 1, parentItemCode: 1, createdAt: -1 });
deKittingOrderSchema.index({ status: 1 });

export default mongoose.model("DeKittingOrder", deKittingOrderSchema);
