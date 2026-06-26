import mongoose from "mongoose";
import { DOC_TYPES, normalizeDocumentType } from "./documentTypes.js";
import { resolvePersistedSourceMetadata } from "./documentSourceMetadata.js";
import {
  copyDocument,
  getCopyRoute,
  loadSourceDocument,
} from "./documentSnapshotRegistry.js";
import {
  computeQuotationConsumption,
  findOverOrderViolations,
} from "./quotationConsumptionService.js";
import {
  validateOaLineFields,
  buildConsumptionBaseline,
  detectStaleConsumption,
} from "./oaCreateValidation.js";

export { copyDocument, getCopyRoute, loadSourceDocument };
export {
  buildQuotationSearchFilterForOA,
  mapQuotationSearchRowForOA,
} from "./documentSnapshotRegistry.js";

/**
 * Normalize snapshot working-copy lines into persisted OA lines.
 * Only included lines with orderedQty > 0 are saved.
 */
export function normalizeOALinesFromWorkingCopy(lines = []) {
  const included = [];
  for (const line of lines || []) {
    if (line.includeInOA === false) continue;

    const orderedQty = Math.max(0, Number(line.orderedQty ?? line.qty) || 0);
    const orderedPrice = Math.max(0, Number(line.orderedPrice ?? line.price ?? line.salePrice) || 0);
    const article = String(line.article || line.itemCode || "").trim().toUpperCase();
    const description = String(line.description || "").trim();
    const uom = String(line.uom || line.unit || "PCS").trim() || "PCS";

    if (!article || !description || !uom) continue;
    if (orderedQty <= 0) continue;
    if (orderedPrice < 0) continue;

    const quotedQty =
      line.quotedQty != null && line.quotedQty !== "" ? Math.max(0, Number(line.quotedQty)) : null;
    const quotedPrice =
      line.quotedPrice != null && line.quotedPrice !== ""
        ? Math.max(0, Number(line.quotedPrice))
        : null;

    const sourceLineId = line.sourceQuotationLineId || line.sourceLineId || "";

    included.push({
      serialNo: 0,
      sourceQuotationLineId: mongoose.Types.ObjectId.isValid(String(sourceLineId))
        ? new mongoose.Types.ObjectId(String(sourceLineId))
        : null,
      article,
      partNumber: String(line.partNumber || line.partNo || "").trim(),
      description,
      uom,
      qty: orderedQty,
      price: orderedPrice,
      quotedQty,
      orderedQty,
      quotedPrice,
      orderedPrice,
      totalPrice: orderedQty * orderedPrice,
      lineDiscount: Math.max(0, Number(line.discount ?? line.discountPct ?? line.lineDiscount) || 0),
      lineTax: Math.max(0, Number(line.tax ?? line.taxPct ?? line.lineTax) || 0),
      remarks: String(line.remarks || ""),
      materialCode: String(line.materialCode || line.material || "").trim(),
      availability: String(line.availability || "").trim(),
      includeInOA: true,
      supplierInfo: String(line.supplierInfo || "").trim(),
    });
  }

  return included.map((line, idx) => ({
    ...line,
    serialNo: idx + 1,
    totalPrice: line.qty * line.price,
  }));
}

export function isOaWorkingCopyPayload(body = {}) {
  if (String(body.oaSourceType || "").toUpperCase() === "FROM_QUOTATION") return true;
  return (body.lines || []).some(
    (line) =>
      line.includeInOA !== undefined ||
      line.orderedQty !== undefined ||
      line.orderedPrice !== undefined ||
      line.quotedQty !== undefined ||
      line.sourceQuotationLineId ||
      line.sourceLineId
  );
}

/** Validate OA working copy before persist — includes over-order and concurrency checks. */
export async function validateOaWorkingCopyBeforeSave({
  companyId,
  body,
  quotation = null,
}) {
  const lineErrors = validateOaLineFields(body.lines || [], { fromWorkingCopy: true });
  if (lineErrors.length) {
    return { ok: false, code: "VALIDATION", message: lineErrors[0], errors: lineErrors };
  }

  const customerName = String(body.customerName || "").trim();
  if (!customerName) {
    return { ok: false, code: "VALIDATION", message: "Customer name is required", errors: ["Customer name is required"] };
  }

  const linkedQtnId = body.linkedQuotationId || body.sourceQuotationId;
  if (!linkedQtnId || !isOaWorkingCopyPayload(body)) {
    return { ok: true, violations: [] };
  }

  if (!mongoose.Types.ObjectId.isValid(String(linkedQtnId))) {
    return { ok: false, code: "VALIDATION", message: "Invalid linked quotation id", errors: ["Invalid linked quotation id"] };
  }

  let q = quotation;
  if (!q) {
    q = await loadSourceDocument(companyId, DOC_TYPES.QUOTATION, linkedQtnId);
  }

  const st = String(q?.status || "").toUpperCase();
  if (["CANCELLED", "REJECTED"].includes(st)) {
    return {
      ok: false,
      code: "VALIDATION",
      message: `Cannot create OA from quotation with status ${st}`,
      errors: [`Quotation status ${st} is not allowed`],
    };
  }

  const consumption = await computeQuotationConsumption(companyId, q);

  const stale = detectStaleConsumption(body, consumption);
  if (stale.stale && body.allowStaleConsumption !== true) {
    return {
      ok: false,
      code: "STALE_CONSUMPTION",
      message: "Quotation remaining quantities changed while this form was open. Refresh and review, or confirm to continue.",
      reasons: stale.reasons,
      consumption,
    };
  }

  const violations = findOverOrderViolations(body.lines || [], consumption, {
    allowOverOrder: body.allowOverOrder === true,
  });

  if (violations.length) {
    return {
      ok: false,
      code: "OVER_ORDER",
      message: "Ordered quantity exceeds remaining quotation quantity for one or more lines",
      violations,
      consumption,
    };
  }
  return { ok: true, violations: [], consumption };
}

/** Build persisted source metadata fields for a new OA from request body. */
export function buildOaSourceMetadataForPersist(body, user) {
  return resolvePersistedSourceMetadata(body, user);
}

export async function buildOaWorkingCopyFromQuotation(companyId, quotation, { copiedBy = "" } = {}) {
  return copyDocument({
    companyId,
    sourceType: DOC_TYPES.QUOTATION,
    destinationType: DOC_TYPES.ORDER_ACKNOWLEDGEMENT,
    sourceId: quotation._id,
    copiedBy,
  });
}

export { DOC_TYPES, normalizeDocumentType };
