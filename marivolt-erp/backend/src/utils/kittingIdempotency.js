/**
 * Idempotency + stable error codes for Kitting / De-Kitting.
 */
import { buildPhysicalEffectKey } from "../services/stockExpectedBuckets.js";

export const KIT_STOCK_SHORTAGE = "KIT_STOCK_SHORTAGE";
export const DEKIT_STOCK_SHORTAGE = "DEKIT_STOCK_SHORTAGE";
export const KIT_POST_IN_PROGRESS = "KIT_POST_IN_PROGRESS";
export const DEKIT_POST_IN_PROGRESS = "DEKIT_POST_IN_PROGRESS";
export const KIT_ALREADY_POSTED = "KIT_ALREADY_POSTED";
export const DEKIT_ALREADY_POSTED = "DEKIT_ALREADY_POSTED";
export const KIT_POSTING_CONFLICT = "KIT_POSTING_CONFLICT";
export const DEKIT_POSTING_CONFLICT = "DEKIT_POSTING_CONFLICT";
export const KIT_SNAPSHOT_REQUIRED = "KIT_SNAPSHOT_REQUIRED";
export const DEKIT_SNAPSHOT_REQUIRED = "DEKIT_SNAPSHOT_REQUIRED";
export const KIT_REVERSAL_BLOCKED = "KIT_REVERSAL_BLOCKED";
export const DEKIT_REVERSAL_BLOCKED = "DEKIT_REVERSAL_BLOCKED";
export const KIT_ALREADY_REVERSED = "KIT_ALREADY_REVERSED";
export const DEKIT_ALREADY_REVERSED = "DEKIT_ALREADY_REVERSED";
export const KIT_REVERSAL_IN_PROGRESS = "KIT_REVERSAL_IN_PROGRESS";
export const DEKIT_REVERSAL_IN_PROGRESS = "DEKIT_REVERSAL_IN_PROGRESS";
export const KIT_WORKFLOW_BLOCKED = "KIT_WORKFLOW_BLOCKED";
export const DEKIT_WORKFLOW_BLOCKED = "DEKIT_WORKFLOW_BLOCKED";

export const BOM_ITEM_NOT_FOUND = "BOM_ITEM_NOT_FOUND";
export const BOM_ITEM_INACTIVE = "BOM_ITEM_INACTIVE";
export const BOM_PACK_CONVERSION_INVALID = "BOM_PACK_CONVERSION_INVALID";
export const BOM_RATIO_MUST_BE_INTEGER = "BOM_RATIO_MUST_BE_INTEGER";
export const KIT_FRACTIONAL_SET_NOT_ALLOWED = "KIT_FRACTIONAL_SET_NOT_ALLOWED";
export const DEKIT_FRACTIONAL_SET_NOT_ALLOWED = "DEKIT_FRACTIONAL_SET_NOT_ALLOWED";

export function kittingConflictError(code, message, details = null, statusCode = 409) {
  const err = new Error(message || code);
  err.code = code;
  err.statusCode = statusCode;
  err.details = details;
  return err;
}

export function buildKittingEffectKey({
  movementType,
  companyId,
  referenceNo,
  article,
  warehouse,
  lineId = "",
}) {
  return buildPhysicalEffectKey({
    movementType,
    companyId,
    referenceNo,
    article,
    warehouse,
    lineId,
  });
}

export function buildKittingReversalEffectKey(originalEffectKey) {
  return `${String(originalEffectKey || "").trim()}|REVERSAL`;
}

export function isKittingEffectDuplicateKeyError(err) {
  return (
    err?.code === 11000 &&
    (String(err?.message || "").includes("effectKey") ||
      String(err?.message || "").includes("uniq_stockledger_packing_effect_key"))
  );
}
