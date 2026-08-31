import mongoose from "mongoose";

/** Fixed ERP-wide label size — never configurable per printer. */
export const LABEL_WIDTH_MM = 100;
export const LABEL_HEIGHT_MM = 50;
export const MARIVOLT_STANDARD_TEMPLATE_CODE = "MARIVOLT_STANDARD";
export const MARIVOLT_STANDARD_TEMPLATE_NAME = "MARIVOLT STANDARD LABEL";
/** Packing customer sticker — same physical size, different layout (no barcode). */
export const PACKING_STANDARD_TEMPLATE_CODE = "PACKING_STANDARD_100X50";
export const PACKING_STANDARD_TEMPLATE_NAME = "PACKING STANDARD 100×50";
/** Additive 100×150 landscape packing template — Phase 1 preview only. */
export const PACKING_QR_LANDSCAPE_V1_TEMPLATE_CODE = "PACKING_QR_LANDSCAPE_150X100_V1";
export const PACKING_QR_LANDSCAPE_V1_TEMPLATE_NAME = "PACKING QR LANDSCAPE 100×150 V1";

const labelTemplateSchema = new mongoose.Schema(
  {
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Company",
      default: null,
      index: true,
    },
    code: { type: String, required: true, trim: true, uppercase: true },
    name: { type: String, required: true, trim: true },
    widthMm: { type: Number, default: LABEL_WIDTH_MM },
    heightMm: { type: Number, default: LABEL_HEIGHT_MM },
    language: { type: String, enum: ["TSPL"], default: "TSPL" },
    layoutVersion: { type: Number, default: 1 },
    barcodeMode: {
      type: String,
      enum: ["ARTICLE", "LABEL_ID", "GS1"],
      default: "ARTICLE",
    },
    isSystem: { type: Boolean, default: false },
    isActive: { type: Boolean, default: true },
    previewEnabled: { type: Boolean, default: true },
    printEnabled: { type: Boolean, default: true },
    requiresPersistentIdentity: { type: Boolean, default: false },
  },
  { timestamps: true }
);

labelTemplateSchema.index({ code: 1 }, { unique: true });

export default mongoose.model("LabelTemplate", labelTemplateSchema);
