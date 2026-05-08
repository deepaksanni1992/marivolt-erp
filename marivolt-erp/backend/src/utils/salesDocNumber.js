import DocCounter from "../models/DocCounter.js";
import NumberSeriesConfig from "../models/NumberSeriesConfig.js";
import { nextNumber } from "../services/numberSeriesService.js";

function formatDatePrefix(value) {
  const date = value ? new Date(value) : new Date();
  const year = String(date.getFullYear()).slice(-2);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}${month}${day}`;
}

function companyInitial(companyCode) {
  const code = String(companyCode || "").trim().toUpperCase();
  if (code === "MAR") return "MV";
  if (code === "OKE") return "OK";
  if (!code) return "CP";
  if (code.length === 1) return code;
  return code.slice(0, 2);
}

export async function nextSalesDocNumber({ companyId, companyCode, docKey, referenceDate }) {
  const safeKey = String(docKey || "").trim().toUpperCase();
  const allowed = new Set([
    "QUOTATION",
    "ORDER_ACK",
    "PROFORMA",
    "ORDER_ALLOCATION",
    "RTS",
    "SALES_INVOICE",
    "SALES_DISPATCH",
    "SALES_RETURN",
    "CIPL",
    "PAYMENT_RECEIPT",
  ]);
  if (!allowed.has(safeKey)) {
    throw new Error(`Unsupported sales docKey: ${safeKey}`);
  }
  const configured = await NumberSeriesConfig.exists({
    companyId,
    branchId: null,
    docKey: safeKey,
    isActive: true,
  });
  if (configured) {
    const generated = await nextNumber({
      companyId,
      companyCode: companyInitial(companyCode),
      docKey: safeKey,
      referenceDate,
    });
    return generated.number;
  }
  const datePrefix = formatDatePrefix(referenceDate);
  const scopedDocKey = `${safeKey}:${datePrefix}`;
  const row = await DocCounter.findOneAndUpdate(
    { companyId, docKey: scopedDocKey },
    { $inc: { seq: 1 } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  return `${companyInitial(companyCode)}/${datePrefix}.${row.seq}`;
}
