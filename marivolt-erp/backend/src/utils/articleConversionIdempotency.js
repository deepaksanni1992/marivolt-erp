/**
 * Idempotency helpers for Article Stock Conversion ledger effects.
 */

export const ARTICLE_CONVERSION_STOCK_SHORTAGE = "ARTICLE_CONVERSION_STOCK_SHORTAGE";
export const ARTICLE_CONVERSION_ALREADY_POSTED = "ARTICLE_CONVERSION_ALREADY_POSTED";
export const ARTICLE_CONVERSION_POST_IN_PROGRESS = "ARTICLE_CONVERSION_POST_IN_PROGRESS";
export const ARTICLE_CONVERSION_POSTING_CONFLICT = "ARTICLE_CONVERSION_POSTING_CONFLICT";
export const ARTICLE_CONVERSION_MAPPING_REQUIRED = "ARTICLE_CONVERSION_MAPPING_REQUIRED";
export const ARTICLE_CONVERSION_REVERSAL_BLOCKED = "ARTICLE_CONVERSION_REVERSAL_BLOCKED";
export const ARTICLE_CONVERSION_ALREADY_REVERSED = "ARTICLE_CONVERSION_ALREADY_REVERSED";
export const ARTICLE_CONVERSION_SAME_ARTICLE = "ARTICLE_CONVERSION_SAME_ARTICLE";
export const ARTICLE_CONVERSION_UOM_MISMATCH = "ARTICLE_CONVERSION_UOM_MISMATCH";
export const ARTICLE_CONVERSION_COST_MISMATCH = "ARTICLE_CONVERSION_COST_MISMATCH";

export const ARTICLE_CONVERSION_SOURCE_DOCUMENT_TYPE = "ARTICLE_STOCK_CONVERSION";

export function buildArticleConversionEffectKey({
  companyId,
  conversionId,
  movementType,
  warehouse,
  article,
  customsLotItemId = "",
}) {
  return [
    String(companyId || ""),
    ARTICLE_CONVERSION_SOURCE_DOCUMENT_TYPE,
    String(conversionId || ""),
    String(movementType || "").toUpperCase(),
    String(warehouse || "").toUpperCase(),
    String(article || "").toUpperCase(),
    String(customsLotItemId || ""),
  ].join("|");
}

export function buildArticleConversionReversalEffectKey(originalEffectKey) {
  return `${String(originalEffectKey || "").trim()}|REVERSAL`;
}

export function articleConversionConflictError(code, message, details = null, statusCode = 409) {
  const err = new Error(message || code);
  err.code = code;
  err.statusCode = statusCode;
  err.details = details;
  return err;
}

export function isArticleConversionEffectDuplicateKeyError(err) {
  return (
    err?.code === 11000 &&
    (String(err?.message || "").includes("effectKey") ||
      String(err?.message || "").includes("uniq_stockledger_packing_effect_key"))
  );
}
