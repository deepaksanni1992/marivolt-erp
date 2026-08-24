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

const costSnapshotSchema = new mongoose.Schema(
  {
    sourceUnitCost: { type: Number, default: 0, min: 0 },
    sourceTotalCost: { type: Number, default: 0, min: 0 },
    producedUnitCost: { type: Number, default: 0, min: 0 },
    producedTotalCost: { type: Number, default: 0, min: 0 },
    currency: { type: String, default: "USD", trim: true, uppercase: true },
    capturedAt: { type: Date, default: null },
  },
  { _id: false }
);

const customsLotLayerSchema = new mongoose.Schema(
  {
    customsLotId: { type: mongoose.Schema.Types.ObjectId, default: null },
    customsLotItemId: { type: mongoose.Schema.Types.ObjectId, default: null },
    targetCustomsLotItemId: { type: mongoose.Schema.Types.ObjectId, default: null },
    sourceQty: { type: Number, default: 0, min: 0 },
    targetQty: { type: Number, default: 0, min: 0 },
    boeNumber: { type: String, default: "", trim: true },
    grnNo: { type: String, default: "", trim: true },
    unitCost: { type: Number, default: 0, min: 0 },
    currency: { type: String, default: "", trim: true, uppercase: true },
    sourceStockValue: { type: Number, default: 0, min: 0 },
    targetStockValue: { type: Number, default: 0, min: 0 },
  },
  { _id: false }
);

const kitLineSnapshotSchema = new mongoose.Schema(
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

const kittingOrderSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: "Company", required: true, index: true },
    kitNumber: { type: String, required: true, trim: true },
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
    assemblyMode: {
      type: String,
      enum: ["STANDARD_ASSEMBLY", "SERVICE_ASSEMBLY", "OVERHAUL_ASSEMBLY", "ENGINE_ASSEMBLY"],
      default: "STANDARD_ASSEMBLY",
    },
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
    shortageSnapshot: { type: Array, default: [] },
    previewConsume: { type: [previewLineSchema], default: [] },
    previewProduce: { type: [previewLineSchema], default: [] },
    maxKittable: { type: Number, default: null },
    bomId: { type: mongoose.Schema.Types.ObjectId, ref: "BOM", required: true },
    workflowMode: { type: String, default: "BOTH", trim: true, uppercase: true },
    status: {
      type: String,
      enum: ["DRAFT", "POSTING", "COMPLETED", "CANCELLED", "REVERSING", "REVERSED"],
      default: "DRAFT",
    },
    linesSnapshot: { type: [kitLineSnapshotSchema], default: [] },
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
    costSnapshot: { type: costSnapshotSchema, default: null },
    /** Frozen historical putaway of consumed child stock at execution (PACK_CONVERSION). */
    sourcePutawayLocation: { type: String, default: "", trim: true, uppercase: true },
    /** Frozen historical putaway applied to produced parent stock at execution (PACK_CONVERSION). */
    producedPutawayLocation: { type: String, default: "", trim: true, uppercase: true },
    customsLotLayers: { type: [customsLotLayerSchema], default: [] },
    remarks: { type: String, default: "" },
    createdBy: { type: String, default: "" },
  },
  { timestamps: true }
);

kittingOrderSchema.index({ companyId: 1, kitNumber: 1 }, { unique: true });
kittingOrderSchema.index({ companyId: 1, parentItemCode: 1, createdAt: -1 });
kittingOrderSchema.index({ status: 1 });

export default mongoose.model("KittingOrder", kittingOrderSchema);
