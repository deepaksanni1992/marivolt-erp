/**
 * P0.5A — Store Packing posting / cancellation idempotency helpers.
 *
 * State machine (StorePacking.status):
 *   DRAFT → POSTING → PARTIALLY_PACKED | FULLY_PACKED  (legacy also accepts POSTED)
 *   PARTIALLY_PACKED | FULLY_PACKED | POSTED → CANCELLING → CANCELLED
 *   DRAFT → CANCELLED (no stock)
 *
 * Intermediate POSTING / CANCELLING are ephemeral in-transaction claims;
 * aborted transactions must roll them back.
 *
 * Packing does not split a single packing line across warehouse/bin/batch/serial
 * today — those dimensions are normalized to empty string in the effect key so
 * the unique index stays stable if they are added later.
 */

export const PACKING_SOURCE_DOCUMENT_TYPE = "STORE_PACKING";

export const PACKING_ALREADY_POSTED = "PACKING_ALREADY_POSTED";
export const PACKING_POST_IN_PROGRESS = "PACKING_POST_IN_PROGRESS";
export const PACKING_POSTING_CONFLICT = "PACKING_POSTING_CONFLICT";
export const PACKING_LEDGER_INCONSISTENT = "PACKING_LEDGER_INCONSISTENT";
export const PACKING_CANCEL_IN_PROGRESS = "PACKING_CANCEL_IN_PROGRESS";
export const PACKING_ALREADY_CANCELLED = "PACKING_ALREADY_CANCELLED";
export const PACKING_CANCEL_CONFLICT = "PACKING_CANCEL_CONFLICT";

export const POSTED_PACKING_STATUSES = Object.freeze(["POSTED", "PARTIALLY_PACKED", "FULLY_PACKED"]);
export const CLAIMABLE_CANCEL_STATUSES = Object.freeze([...POSTED_PACKING_STATUSES]);

export const PACKING_EFFECT_UNIQUE_INDEX = "uniq_stockledger_packing_effect_key";

function normDim(v) {
  return String(v ?? "").trim().toUpperCase();
}

/**
 * Deterministic durable effect key for one Packing stock effect.
 * Dimensions that are unused today are normalized to "" (not null).
 */
export function buildPackingEffectKey({
  companyId,
  packingId,
  packingLineId,
  movementType,
  warehouse = "",
  location = "",
  batchNo = "",
  serialNo = "",
  customsLot = "",
}) {
  const parts = [
    String(companyId || ""),
    PACKING_SOURCE_DOCUMENT_TYPE,
    String(packingId || ""),
    String(packingLineId || ""),
    String(movementType || "").toUpperCase(),
    normDim(warehouse),
    normDim(location) || normDim(warehouse),
    String(batchNo ?? "").trim(),
    String(serialNo ?? "").trim(),
    String(customsLot ?? "").trim(),
  ];
  return parts.join("|");
}

export function buildPackingReversalEffectKey(originalEffectKey) {
  return `${String(originalEffectKey || "")}|REVERSAL`;
}

export function packingConflictError(code, message, details = null, statusCode = 409) {
  const err = new Error(message);
  err.code = code;
  err.statusCode = statusCode;
  err.details = details;
  return err;
}

export function isPackingEffectDuplicateKeyError(err) {
  if (Number(err?.code) !== 11000) return false;
  const msg = String(err?.message || "");
  if (msg.includes(PACKING_EFFECT_UNIQUE_INDEX) || msg.includes("effectKey")) return true;
  const kp = err?.keyPattern && typeof err.keyPattern === "object" ? err.keyPattern : {};
  return Boolean(kp.effectKey);
}

export const PACKING_EFFECT_INDEX_SPEC = Object.freeze({
  name: PACKING_EFFECT_UNIQUE_INDEX,
  key: { effectKey: 1 },
  unique: true,
  partialFilterExpression: {
    effectKey: { $type: "string", $gt: "" },
  },
});

/** In-memory claim store for concurrency unit tests. */
export function claimPackingStatus(store, { packingId, fromStatuses, toStatus }) {
  const cur = store.get(String(packingId));
  if (!cur) return null;
  if (!fromStatuses.includes(cur.status)) return null;
  const next = { ...cur, status: toStatus };
  store.set(String(packingId), next);
  return next;
}

export function simulatePackingPost({
  store,
  packingId,
  stockWork,
  hasPackedEvidence,
}) {
  const doc = store.get(String(packingId));
  if (!doc) {
    throw packingConflictError(PACKING_POSTING_CONFLICT, "Packing not found", null, 404);
  }
  if (POSTED_PACKING_STATUSES.includes(doc.status)) {
    if (!hasPackedEvidence(doc)) {
      throw packingConflictError(
        PACKING_LEDGER_INCONSISTENT,
        "Packing is posted but expected PACKED ledger evidence is missing",
        { packingId: String(packingId) }
      );
    }
    return { outcome: "idempotent", stockMoves: 0, doc };
  }
  if (doc.status === "POSTING") {
    throw packingConflictError(PACKING_POST_IN_PROGRESS, "Packing post already in progress");
  }
  if (doc.status === "CANCELLING") {
    throw packingConflictError(PACKING_POSTING_CONFLICT, "Packing cancellation in progress");
  }
  if (doc.status !== "DRAFT") {
    throw packingConflictError(PACKING_POSTING_CONFLICT, `Cannot post packing in status ${doc.status}`);
  }

  const claimed = claimPackingStatus(store, {
    packingId,
    fromStatuses: ["DRAFT"],
    toStatus: "POSTING",
  });
  if (!claimed) {
    throw packingConflictError(PACKING_POSTING_CONFLICT, "Failed to claim packing for post");
  }

  try {
    stockWork(claimed);
    const posted = {
      ...claimed,
      status: "FULLY_PACKED",
      hasEvidence: true,
    };
    store.set(String(packingId), posted);
    return { outcome: "posted", stockMoves: 1, doc: posted };
  } catch (e) {
    store.set(String(packingId), { ...claimed, status: "DRAFT" });
    throw e;
  }
}

export function simulatePackingCancel({
  store,
  packingId,
  stockWork,
  hasPackedEvidence,
  hasUnpackEvidence,
}) {
  const doc = store.get(String(packingId));
  if (!doc) {
    throw packingConflictError(PACKING_CANCEL_CONFLICT, "Packing not found", null, 404);
  }
  if (doc.status === "CANCELLED") {
    if (hasUnpackEvidence?.(doc) || !hasPackedEvidence(doc)) {
      return { outcome: "idempotent", stockMoves: 0, doc };
    }
    throw packingConflictError(
      PACKING_LEDGER_INCONSISTENT,
      "Packing is CANCELLED but packed stock evidence was not reversed",
      { packingId: String(packingId) }
    );
  }
  if (doc.status === "CANCELLING") {
    throw packingConflictError(PACKING_CANCEL_IN_PROGRESS, "Packing cancellation already in progress");
  }
  if (doc.status === "POSTING") {
    throw packingConflictError(PACKING_CANCEL_CONFLICT, "Packing post in progress");
  }
  if (doc.status === "DRAFT") {
    const cancelled = { ...doc, status: "CANCELLED" };
    store.set(String(packingId), cancelled);
    return { outcome: "cancelled_draft", stockMoves: 0, doc: cancelled };
  }
  if (!POSTED_PACKING_STATUSES.includes(doc.status)) {
    throw packingConflictError(PACKING_CANCEL_CONFLICT, `Cannot cancel packing in status ${doc.status}`);
  }
  if (!hasPackedEvidence(doc)) {
    throw packingConflictError(
      PACKING_LEDGER_INCONSISTENT,
      "Cannot cancel: original PACKED ledger evidence is missing",
      { packingId: String(packingId) }
    );
  }

  const claimed = claimPackingStatus(store, {
    packingId,
    fromStatuses: [...POSTED_PACKING_STATUSES],
    toStatus: "CANCELLING",
  });
  if (!claimed) {
    throw packingConflictError(PACKING_CANCEL_CONFLICT, "Failed to claim packing for cancel");
  }

  try {
    stockWork(claimed);
    const cancelled = { ...claimed, status: "CANCELLED", hasEvidence: false, hasUnpack: true };
    store.set(String(packingId), cancelled);
    return { outcome: "cancelled", stockMoves: 1, doc: cancelled };
  } catch (e) {
    store.set(String(packingId), { ...claimed, status: doc.status });
    throw e;
  }
}
