import Setting from "../../models/Setting.js";

const NS = "WAREHOUSE";

export const LABEL_SETTING_KEYS = Object.freeze({
  ENABLED: "LABEL_ENABLED",
  DEFAULT_PRINTER_CODE: "LABEL_DEFAULT_PRINTER_CODE",
  AUTO_PRINT_AFTER_GRN: "LABEL_AUTO_PRINT_AFTER_GRN",
  ALLOW_MANUAL_REPRINT: "LABEL_ALLOW_MANUAL_REPRINT",
  MAX_PER_JOB: "LABEL_MAX_PER_JOB",
  DEFAULT_COPIES: "LABEL_DEFAULT_COPIES",
});

export const LABEL_SETTING_DEFAULTS = Object.freeze({
  [LABEL_SETTING_KEYS.ENABLED]: false,
  [LABEL_SETTING_KEYS.DEFAULT_PRINTER_CODE]: "",
  [LABEL_SETTING_KEYS.AUTO_PRINT_AFTER_GRN]: false,
  [LABEL_SETTING_KEYS.ALLOW_MANUAL_REPRINT]: true,
  [LABEL_SETTING_KEYS.MAX_PER_JOB]: 200,
  [LABEL_SETTING_KEYS.DEFAULT_COPIES]: 1,
});

function companyFilter(companyId) {
  return { companyId, branchId: null, namespace: NS };
}

export async function getLabelSettings(companyId) {
  const rows = await Setting.find({
    ...companyFilter(companyId),
    key: { $in: Object.values(LABEL_SETTING_KEYS) },
  }).lean();
  const map = { ...LABEL_SETTING_DEFAULTS };
  for (const r of rows) {
    map[r.key] = r.value;
  }
  return {
    enabled: Boolean(map[LABEL_SETTING_KEYS.ENABLED]),
    defaultPrinterCode: String(map[LABEL_SETTING_KEYS.DEFAULT_PRINTER_CODE] || ""),
    autoPrintAfterGrn: Boolean(map[LABEL_SETTING_KEYS.AUTO_PRINT_AFTER_GRN]),
    allowManualReprint: map[LABEL_SETTING_KEYS.ALLOW_MANUAL_REPRINT] !== false,
    maxPerJob: Math.max(1, Number(map[LABEL_SETTING_KEYS.MAX_PER_JOB]) || 200),
    defaultCopies: Math.max(1, Number(map[LABEL_SETTING_KEYS.DEFAULT_COPIES]) || 1),
  };
}

export async function upsertLabelSettings(companyId, patch = {}, updatedBy = "") {
  const allowed = {
    enabled: LABEL_SETTING_KEYS.ENABLED,
    defaultPrinterCode: LABEL_SETTING_KEYS.DEFAULT_PRINTER_CODE,
    autoPrintAfterGrn: LABEL_SETTING_KEYS.AUTO_PRINT_AFTER_GRN,
    allowManualReprint: LABEL_SETTING_KEYS.ALLOW_MANUAL_REPRINT,
    maxPerJob: LABEL_SETTING_KEYS.MAX_PER_JOB,
    defaultCopies: LABEL_SETTING_KEYS.DEFAULT_COPIES,
  };
  for (const [field, key] of Object.entries(allowed)) {
    if (!Object.prototype.hasOwnProperty.call(patch, field)) continue;
    let value = patch[field];
    if (field === "maxPerJob" || field === "defaultCopies") {
      value = Math.max(1, Number(value) || 1);
    }
    if (field === "enabled" || field === "autoPrintAfterGrn" || field === "allowManualReprint") {
      value = Boolean(value);
    }
    if (field === "defaultPrinterCode") value = String(value || "").trim().toUpperCase();
    await Setting.findOneAndUpdate(
      { ...companyFilter(companyId), key },
      {
        $set: {
          value,
          description: `Warehouse label setting ${key}`,
          updatedBy: String(updatedBy || ""),
        },
        $setOnInsert: {
          companyId,
          branchId: null,
          namespace: NS,
          key,
        },
      },
      { upsert: true, new: true }
    );
  }
  return getLabelSettings(companyId);
}
