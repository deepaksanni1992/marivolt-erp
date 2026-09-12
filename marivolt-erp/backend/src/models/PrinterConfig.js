import mongoose from "mongoose";

/**
 * ERP printer mapping → Windows queue via a print agent.
 * Additive fields only — existing mappings keep working.
 * Same Windows queue name on two PCs = two distinct ERP mappings (different agentId).
 */
const printerConfigSchema = new mongoose.Schema(
  {
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Company",
      required: true,
      index: true,
    },
    code: { type: String, required: true, trim: true, uppercase: true },
    displayName: { type: String, default: "", trim: true },
    printerModel: { type: String, default: "", trim: true },
    branchId: { type: mongoose.Schema.Types.ObjectId, ref: "Branch", default: null },
    branchName: { type: String, default: "", trim: true },
    warehouseId: { type: mongoose.Schema.Types.ObjectId, ref: "Warehouse", default: null },
    warehouseCode: { type: String, default: "", trim: true, uppercase: true, index: true },
    agentId: { type: String, required: true, trim: true, uppercase: true, index: true },
    windowsPrinterName: { type: String, required: true, trim: true },
    /**
     * Logical connection for UI: USB | NETWORK | WINDOWS_QUEUE.
     * Transport remains WINDOWS_SPOOLER / TCP_9100 via connectionType.
     */
    connectionKind: {
      type: String,
      enum: ["USB", "NETWORK", "WINDOWS_QUEUE"],
      default: "USB",
    },
    connectionType: {
      type: String,
      enum: ["WINDOWS_SPOOLER", "TCP_9100"],
      default: "WINDOWS_SPOOLER",
    },
    /** Company-wide default printer */
    isDefault: { type: Boolean, default: false },
    /** Preferred default within warehouseCode */
    isWarehouseDefault: { type: Boolean, default: false },
    isActive: { type: Boolean, default: true, index: true },
    remarks: { type: String, default: "", trim: true },
    /**
     * Command language for RAW payloads. Missing/legacy documents are TSPL.
     */
    language: {
      type: String,
      enum: ["TSPL", "ZPL"],
      default: "TSPL",
      trim: true,
      uppercase: true,
    },
    dpi: { type: Number, default: 203, min: 1 },
    /** Physical media. 0/unset = unrestricted (legacy STORE printers). */
    widthMm: { type: Number, default: 0, min: 0 },
    heightMm: { type: Number, default: 0, min: 0 },
    /**
     * Empty = all label purposes (legacy). Restricts auto-routing and overrides.
     */
    supportedPurposes: { type: [String], default: undefined },
    /** Empty = all templates compatible with language/media. */
    supportedTemplateCodes: { type: [String], default: undefined },
    lastPrintAt: { type: Date, default: null },
    createdBy: { type: String, default: "" },
  },
  { timestamps: true }
);

printerConfigSchema.index({ companyId: 1, code: 1 }, { unique: true });
printerConfigSchema.index({ companyId: 1, agentId: 1 });
printerConfigSchema.index({ companyId: 1, warehouseCode: 1, isActive: 1, isWarehouseDefault: 1 });
/** At most one active company default per company */
printerConfigSchema.index(
  { companyId: 1, isDefault: 1 },
  {
    unique: true,
    partialFilterExpression: { isDefault: true, isActive: true },
  }
);
/** At most one active warehouse default per company+warehouse */
printerConfigSchema.index(
  { companyId: 1, warehouseCode: 1, isWarehouseDefault: 1 },
  {
    unique: true,
    partialFilterExpression: {
      isWarehouseDefault: true,
      isActive: true,
      warehouseCode: { $type: "string", $gt: "" },
    },
  }
);

export default mongoose.model("PrinterConfig", printerConfigSchema);
