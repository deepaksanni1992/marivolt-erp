import DocCounter from "../models/DocCounter.js";

const SALES_PREFIX_BY_KEY = {
  QUOTATION: "QUO",
  ORDER_ACK: "OA",
  PROFORMA: "PI",
  SALES_INVOICE: "SINV",
  CIPL: "CIPL",
};

export async function nextSalesDocNumber({ companyId, companyCode, docKey }) {
  const safeKey = String(docKey || "").trim().toUpperCase();
  const suffix = SALES_PREFIX_BY_KEY[safeKey];
  if (!suffix) {
    throw new Error(`Unsupported sales docKey: ${safeKey}`);
  }
  const companyPrefix = String(companyCode || "CMP").trim().toUpperCase() || "CMP";
  const row = await DocCounter.findOneAndUpdate(
    { companyId, docKey: safeKey },
    { $inc: { seq: 1 } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  return `${companyPrefix}-${suffix}-${String(row.seq).padStart(4, "0")}`;
}
