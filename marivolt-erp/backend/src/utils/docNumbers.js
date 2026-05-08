import NumberSeriesConfig from "../models/NumberSeriesConfig.js";
import { nextNumber } from "../services/numberSeriesService.js";

function inferDocKey(prefix = "") {
  const value = String(prefix || "").trim().toUpperCase();
  if (value.endsWith("-PO")) return "PURCHASE_ORDER";
  if (value.endsWith("-PI")) return "PURCHASE_INVOICE";
  if (value.endsWith("-PR")) return "PURCHASE_RETURN";
  if (value.endsWith("-SI")) return "SALES_INVOICE";
  if (value.endsWith("-SH")) return "SHIPMENT";
  if (value.endsWith("-KIT")) return "KITTING";
  if (value.endsWith("-DK")) return "DEKITTING";
  return "";
}

function companyCodeFromPrefix(prefix = "") {
  return String(prefix || "").split("-")[0]?.trim().toUpperCase() || "";
}

export async function nextSequentialNumber(Model, field, prefix, extraFilter = {}) {
  const companyId = extraFilter?.companyId || null;
  const docKey = String(extraFilter?.docKey || inferDocKey(prefix)).trim().toUpperCase();
  if (companyId && docKey) {
    const configured = await NumberSeriesConfig.exists({
      companyId,
      branchId: extraFilter?.branchId || null,
      docKey,
      isActive: true,
    });
    if (configured) {
      const generated = await nextNumber({
        companyId,
        branchId: extraFilter?.branchId || null,
        companyCode: extraFilter?.companyCode || companyCodeFromPrefix(prefix),
        branchCode: extraFilter?.branchCode || "",
        docKey,
        referenceDate: extraFilter?.referenceDate || new Date(),
      });
      return generated.number;
    }
  }
  const d = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const re = new RegExp(`^${prefix}-${d}-`);
  const { docKey: _docKey, branchId: _branchId, companyCode: _companyCode, branchCode: _branchCode, referenceDate: _referenceDate, ...filter } = extraFilter || {};
  const count = await Model.countDocuments({ ...filter, [field]: { $regex: re } });
  return `${prefix}-${d}-${String(count + 1).padStart(4, "0")}`;
}
