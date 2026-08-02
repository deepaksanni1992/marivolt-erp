import LabelTemplate, {
  LABEL_HEIGHT_MM,
  LABEL_WIDTH_MM,
  MARIVOLT_STANDARD_TEMPLATE_CODE,
  MARIVOLT_STANDARD_TEMPLATE_NAME,
} from "../../models/LabelTemplate.js";

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

export async function listTemplates() {
  await ensureMarivoltStandardTemplate();
  return LabelTemplate.find({ isActive: true }).sort({ code: 1 }).lean();
}

export async function getStandardTemplate() {
  await ensureMarivoltStandardTemplate();
  return LabelTemplate.findOne({ code: MARIVOLT_STANDARD_TEMPLATE_CODE }).lean();
}

export {
  MARIVOLT_STANDARD_TEMPLATE_CODE,
  MARIVOLT_STANDARD_TEMPLATE_NAME,
  LABEL_WIDTH_MM,
  LABEL_HEIGHT_MM,
};
