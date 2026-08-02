import mongoose from "mongoose";

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
    warehouseId: { type: mongoose.Schema.Types.ObjectId, ref: "Warehouse", default: null },
    warehouseCode: { type: String, default: "", trim: true, uppercase: true },
    agentId: { type: String, required: true, trim: true, uppercase: true },
    windowsPrinterName: { type: String, required: true, trim: true },
    connectionType: {
      type: String,
      enum: ["WINDOWS_SPOOLER", "TCP_9100"],
      default: "WINDOWS_SPOOLER",
    },
    isDefault: { type: Boolean, default: false },
    isActive: { type: Boolean, default: true, index: true },
    createdBy: { type: String, default: "" },
  },
  { timestamps: true }
);

printerConfigSchema.index({ companyId: 1, code: 1 }, { unique: true });
printerConfigSchema.index({ companyId: 1, agentId: 1 });

export default mongoose.model("PrinterConfig", printerConfigSchema);
