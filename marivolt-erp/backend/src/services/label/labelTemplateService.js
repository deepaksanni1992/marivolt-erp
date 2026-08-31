import LabelTemplate, {
  LABEL_HEIGHT_MM,
  LABEL_WIDTH_MM,
  MARIVOLT_STANDARD_TEMPLATE_CODE,
  MARIVOLT_STANDARD_TEMPLATE_NAME,
  PACKING_STANDARD_TEMPLATE_CODE,
  PACKING_STANDARD_TEMPLATE_NAME,
  PACKING_QR_LANDSCAPE_V1_TEMPLATE_CODE,
  PACKING_QR_LANDSCAPE_V1_TEMPLATE_NAME,
} from "../../models/LabelTemplate.js";
import { packingQrLandscapeV1TemplateDocument } from "./packingQrLandscapeV1.js";

export async function ensureMarivoltStandardTemplate() {
  const existing = await LabelTemplate.findOne({ code: MARIVOLT_STANDARD_TEMPLATE_CODE });
  if (existing) return existing;
  return LabelTemplate.create({
    companyId: null,
    code: MARIVOLT_STANDARD_TEMPLATE_CODE,
    name: MARIVOLT_STANDARD_TEMPLATE_NAME,
    widthMm: LABEL_WIDTH_MM,
    heightMm: LABEL_HEIGHT_MM,
    language: "TSPL",
    layoutVersion: 1,
    barcodeMode: "ARTICLE",
    isSystem: true,
    isActive: true,
  });
}

export async function ensurePackingStandardTemplate() {
  const existing = await LabelTemplate.findOne({ code: PACKING_STANDARD_TEMPLATE_CODE });
  if (existing) return existing;
  return LabelTemplate.create({
    companyId: null,
    code: PACKING_STANDARD_TEMPLATE_CODE,
    name: PACKING_STANDARD_TEMPLATE_NAME,
    widthMm: LABEL_WIDTH_MM,
    heightMm: LABEL_HEIGHT_MM,
    language: "TSPL",
    layoutVersion: 1,
    barcodeMode: "ARTICLE",
    isSystem: true,
    isActive: true,
  });
}

export async function listTemplates() {
  await ensureMarivoltStandardTemplate();
  await ensurePackingStandardTemplate();
  return LabelTemplate.find({ isActive: true }).sort({ code: 1 }).lean();
}

export async function getStandardTemplate() {
  await ensureMarivoltStandardTemplate();
  return LabelTemplate.findOne({ code: MARIVOLT_STANDARD_TEMPLATE_CODE }).lean();
}

export async function getPackingStandardTemplate() {
  await ensurePackingStandardTemplate();
  return LabelTemplate.findOne({ code: PACKING_STANDARD_TEMPLATE_CODE }).lean();
}

/**
 * Catalog row for the 100×150 landscape template.
 * Phase 1 print/preview paths do not call this (no production DB write required).
 */
export async function ensurePackingQrLandscapeV1Template() {
  const existing = await LabelTemplate.findOne({ code: PACKING_QR_LANDSCAPE_V1_TEMPLATE_CODE });
  if (existing) {
    let dirty = false;
    if (existing.printEnabled !== false) {
      existing.printEnabled = false;
      dirty = true;
    }
    if (existing.previewEnabled !== true) {
      existing.previewEnabled = true;
      dirty = true;
    }
    if (existing.requiresPersistentIdentity !== true) {
      existing.requiresPersistentIdentity = true;
      dirty = true;
    }
    if (Number(existing.widthMm) !== 100) {
      existing.widthMm = 100;
      dirty = true;
    }
    if (Number(existing.heightMm) !== 150) {
      existing.heightMm = 150;
      dirty = true;
    }
    if (dirty) await existing.save();
    return existing;
  }
  return LabelTemplate.create(packingQrLandscapeV1TemplateDocument());
}

export {
  MARIVOLT_STANDARD_TEMPLATE_CODE,
  MARIVOLT_STANDARD_TEMPLATE_NAME,
  PACKING_STANDARD_TEMPLATE_CODE,
  PACKING_STANDARD_TEMPLATE_NAME,
  PACKING_QR_LANDSCAPE_V1_TEMPLATE_CODE,
  PACKING_QR_LANDSCAPE_V1_TEMPLATE_NAME,
  LABEL_WIDTH_MM,
  LABEL_HEIGHT_MM,
};
