import Counter from "../models/Counter.js";

const DOC_NUMBER_CONFIG = {
  QUOTATION: { key: "quotation", prefix: "QTN" },
  ORDER_ACK: { key: "oa", prefix: "OA" },
  PROFORMA: { key: "pi", prefix: "PI" },
  ORDER_ALLOCATION: { key: "allocation", prefix: "ALLOC" },
  PACKING: { key: "packing", prefix: "PK" },
  SALES_INVOICE: { key: "salesInvoice", prefix: "SI" },
  SALES_DISPATCH: { key: "dispatch", prefix: "DSP" },
  DISPATCH: { key: "dispatch", prefix: "DSP" },
  SALES_RETURN: { key: "salesReturn", prefix: "SR" },
  CIPL: { key: "cipl", prefix: "CIPL" },
  PAYMENT_RECEIPT: { key: "paymentReceipt", prefix: "RCPT" },
};

export function normalizeCompanyCode(companyCode) {
  const raw = String(companyCode || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (raw === "OKE" || raw === "OKEANOS") return "OKE";
  if (raw === "MAR" || raw === "MARIVOLT") return "MAR";
  return raw.slice(0, 3) || "CMP";
}

export function salesDocCounterKey(docKey, companyCode) {
  const safeKey = String(docKey || "").trim().toUpperCase();
  const config = DOC_NUMBER_CONFIG[safeKey];
  if (!config) throw new Error(`Unsupported sales docKey: ${safeKey}`);
  return `${config.key}:${normalizeCompanyCode(companyCode)}`;
}

export async function nextSalesDocNumber({ companyId, companyCode, docKey, referenceDate }) {
  void referenceDate;
  const safeKey = String(docKey || "").trim().toUpperCase();
  const config = DOC_NUMBER_CONFIG[safeKey];
  if (!config) throw new Error(`Unsupported sales docKey: ${safeKey}`);
  const code = normalizeCompanyCode(companyCode);
  const key = `${config.key}:${code}`;
  const row = await Counter.findOneAndUpdate(
    { companyId, key },
    {
      $setOnInsert: { companyId, key },
      $inc: { seq: 1 },
    },
    { upsert: true, new: true, setDefaultsOnInsert: false }
  ).lean();
  const seq = Number(row?.seq) || 0;
  if (!(seq > 0)) throw new Error(`Failed to generate ${safeKey} number`);
  return `${code}-${config.prefix}-${String(seq).padStart(4, "0")}`;
}

export async function nextUniqueSalesDocNumber({
  companyId,
  companyCode,
  docKey,
  model,
  field,
  referenceDate,
  maxAttempts = 25,
}) {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const number = await nextSalesDocNumber({ companyId, companyCode, docKey, referenceDate });
    if (!model || !field) return number;
    const exists = await model.exists({ companyId, [field]: number });
    if (!exists) return number;
  }
  throw new Error(`Unable to allocate a unique ${docKey} number after ${maxAttempts} attempts`);
}

/** Validate manual document number change on update (company-scoped uniqueness). */
export async function assertUniqueSalesDocNumberForUpdate({ companyId, model, field, value, excludeId }) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) {
    const err = new Error(`${field} is required`);
    err.statusCode = 400;
    throw err;
  }
  if (!excludeId) return trimmed;
  const exists = await model.exists({ companyId, [field]: trimmed, _id: { $ne: excludeId } });
  if (exists) {
    const err = new Error(`Document number "${trimmed}" is already in use`);
    err.statusCode = 409;
    throw err;
  }
  return trimmed;
}
