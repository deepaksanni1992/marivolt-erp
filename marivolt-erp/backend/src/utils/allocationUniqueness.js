/**
 * P0.3 — One active Order Allocation per OA / per Proforma.
 *
 * Active = any non-CANCELLED status on the OrderAllocation enum.
 * Future statuses must be classified:
 *   - Add to ACTIVE_ALLOCATION_STATUSES if they block reallocation
 *   - Leave as CANCELLED (or other inactive) if a replacement allocation is allowed
 *
 * Partial unique indexes (created by migrate-active-allocation-unique-indexes.mjs)
 * use this same positive list so cancelled rows can be replaced.
 */

export const ACTIVE_ALLOCATION_ALREADY_EXISTS = "ACTIVE_ALLOCATION_ALREADY_EXISTS";

/** Positive list of statuses that count as an active allocation (blocks a second conversion). */
export const ACTIVE_ALLOCATION_STATUSES = Object.freeze([
  "OPEN",
  "PARTIALLY_PACKED",
  "FULLY_PACKED",
  "APPROVED",
  "CLOSED",
]);

export const ACTIVE_ALLOCATION_OA_INDEX = "uniq_active_allocation_per_oa";
export const ACTIVE_ALLOCATION_PI_INDEX = "uniq_active_allocation_per_proforma";

export function activeAllocationStatusFilter() {
  return { status: { $in: [...ACTIVE_ALLOCATION_STATUSES] } };
}

export function isAllocationStatusActive(status) {
  return ACTIVE_ALLOCATION_STATUSES.includes(String(status || "").toUpperCase());
}

/** Partial filter used by both DB indexes (MongoDB 6+ / Atlas: $in + $type supported). */
export function activeAllocationPartialFilter(linkField) {
  return {
    [linkField]: { $type: "objectId" },
    status: { $in: [...ACTIVE_ALLOCATION_STATUSES] },
  };
}

export const ACTIVE_ALLOCATION_INDEX_SPECS = Object.freeze([
  {
    name: ACTIVE_ALLOCATION_OA_INDEX,
    key: { companyId: 1, linkedOAId: 1 },
    unique: true,
    partialFilterExpression: activeAllocationPartialFilter("linkedOAId"),
  },
  {
    name: ACTIVE_ALLOCATION_PI_INDEX,
    key: { companyId: 1, linkedProformaId: 1 },
    unique: true,
    partialFilterExpression: activeAllocationPartialFilter("linkedProformaId"),
  },
]);

export function isActiveAllocationDuplicateKeyError(err) {
  if (Number(err?.code) !== 11000) return false;
  const message = String(err?.message || "");
  if (message.includes(ACTIVE_ALLOCATION_OA_INDEX) || message.includes(ACTIVE_ALLOCATION_PI_INDEX)) {
    return true;
  }
  const keyPattern = err?.keyPattern && typeof err.keyPattern === "object" ? err.keyPattern : {};
  if (keyPattern.linkedOAId || keyPattern.linkedProformaId) {
    return true;
  }
  const kv = err?.keyValue && typeof err.keyValue === "object" ? err.keyValue : {};
  if (
    Object.prototype.hasOwnProperty.call(kv, "linkedOAId") ||
    Object.prototype.hasOwnProperty.call(kv, "linkedProformaId")
  ) {
    return true;
  }
  return /uniq_active_allocation_per_(oa|proforma)/i.test(message);
}

/**
 * Build a structured conflict error for controllers.
 * @param {object} [existing] optional existing allocation lean/doc
 */
export function activeAllocationConflictError(existing = null, message = null) {
  const allocationNo = existing?.allocationNo ? String(existing.allocationNo) : "";
  const err = new Error(
    message ||
      (allocationNo
        ? `An active order allocation already exists (${allocationNo})`
        : "An active order allocation already exists for this source document")
  );
  err.code = ACTIVE_ALLOCATION_ALREADY_EXISTS;
  err.statusCode = 409;
  err.details = existing
    ? {
        allocationId: String(existing._id || ""),
        allocationNo: allocationNo || "",
        status: String(existing.status || ""),
      }
    : null;
  return err;
}

/**
 * In-memory claim used by concurrency tests (mirrors unique partial index behaviour).
 * Key: `${companyId}::oa::${oaId}` or `${companyId}::pi::${piId}`
 */
export function claimActiveAllocationLink(store, { companyId, linkedOAId = null, linkedProformaId = null, allocationId }) {
  const keys = [];
  if (linkedOAId) keys.push(`${companyId}::oa::${linkedOAId}`);
  if (linkedProformaId) keys.push(`${companyId}::pi::${linkedProformaId}`);
  for (const key of keys) {
    if (store.has(key)) {
      return { ok: false, existingId: store.get(key) };
    }
  }
  for (const key of keys) store.set(key, allocationId);
  return { ok: true };
}

export function releaseActiveAllocationLinks(store, { companyId, linkedOAId = null, linkedProformaId = null }) {
  if (linkedOAId) store.delete(`${companyId}::oa::${linkedOAId}`);
  if (linkedProformaId) store.delete(`${companyId}::pi::${linkedProformaId}`);
}
