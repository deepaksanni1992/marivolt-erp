import DocCounter from "../models/DocCounter.js";
import Quotation from "../models/Quotation.js";

const SALES_PREFIX_BY_KEY = {
  QUOTATION: "QUO",
  ORDER_ACK: "OA",
  PROFORMA: "PI",
  ORDER_ALLOCATION: "ALLOC",
  RTS: "RTS",
  SALES_INVOICE: "SINV",
  SALES_DISPATCH: "SDISP",
  SALES_RETURN: "SRET",
  CIPL: "CIPL",
};

function formatDatePrefix(value) {
  const date = value ? new Date(value) : new Date();
  const year = String(date.getFullYear()).slice(-2);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}${month}${day}`;
}

async function nextQuotationNumber({ companyId, referenceDate }) {
  const prefix = formatDatePrefix(referenceDate);
  const pattern = new RegExp(`^${prefix}\\.\\d+$`);
  const rows = await Quotation.find({ companyId, quotationNo: pattern }).select("quotationNo").lean();
  let maxSeq = 0;
  for (const row of rows) {
    const value = String(row.quotationNo || "");
    const seqRaw = value.slice(prefix.length + 1);
    const seq = Number(seqRaw);
    if (Number.isFinite(seq) && seq > maxSeq) maxSeq = seq;
  }
  return `${prefix}.${maxSeq + 1}`;
}

export async function nextSalesDocNumber({ companyId, companyCode, docKey, referenceDate }) {
  const safeKey = String(docKey || "").trim().toUpperCase();
  if (safeKey === "QUOTATION") {
    return nextQuotationNumber({ companyId, referenceDate });
  }
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
