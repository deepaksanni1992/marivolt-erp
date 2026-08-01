/**
 * P0.5B — Store Dispatch posting / cancellation idempotency helpers.
 *
 * State machine (StoreDispatch.status):
 *   DRAFT → POSTING → PARTIALLY_DISPATCHED | FULLY_DISPATCHED  (legacy also accepts POSTED)
 *   PARTIALLY_DISPATCHED | FULLY_DISPATCHED | POSTED → CANCELLING → CANCELLED
 *   DRAFT → CANCELLED (no stock)
 *
 * Intermediate POSTING / CANCELLING are ephemeral in-transaction claims;
 * aborted transactions must roll them back.
 *
 * Effect-key uniqueness reuses the P0.5A partial unique index on StockLedger.effectKey
 * (`uniq_stockledger_packing_effect_key`) — that index is already generic for every
 * non-empty effectKey string, so no second Dispatch-only unique index is required.
 *
 * Dispatch lines today post at document warehouse granularity (no per-line batch/serial
 * split). Unused dimensions normalize to "" for a stable key if splits are added later.
 */

export const DISPATCH_SOURCE_DOCUMENT_TYPE = "STORE_DISPATCH";

export const DISPATCH_ALREADY_POSTED = "DISPATCH_ALREADY_POSTED";
export const DISPATCH_POST_IN_PROGRESS = "DISPATCH_POST_IN_PROGRESS";
export const DISPATCH_POSTING_CONFLICT = "DISPATCH_POSTING_CONFLICT";
export const DISPATCH_LEDGER_INCONSISTENT = "DISPATCH_LEDGER_INCONSISTENT";
export const DISPATCH_EXCEEDS_PACKED_QTY = "DISPATCH_EXCEEDS_PACKED_QTY";
export const DISPATCH_SOURCE_PACKING_INVALID = "DISPATCH_SOURCE_PACKING_INVALID";
export const DISPATCH_CANCEL_IN_PROGRESS = "DISPATCH_CANCEL_IN_PROGRESS";
export const DISPATCH_ALREADY_CANCELLED = "DISPATCH_ALREADY_CANCELLED";
export const DISPATCH_CANCEL_CONFLICT = "DISPATCH_CANCEL_CONFLICT";

export const POSTED_DISPATCH_STATUSES = Object.freeze([
  "POSTED",
  "PARTIALLY_DISPATCHED",
  "FULLY_DISPATCHED",
]);
export const CLAIMABLE_DISPATCH_CANCEL_STATUSES = Object.freeze([...POSTED_DISPATCH_STATUSES]);

/** Same physical index created in P0.5A — generic for all non-empty effectKeys. */
export const DISPATCH_EFFECT_UNIQUE_INDEX = "uniq_stockledger_packing_effect_key";

export const DISPATCH_EFFECT_INDEX_SPEC = Object.freeze({
  name: DISPATCH_EFFECT_UNIQUE_INDEX,
  key: { effectKey: 1 },
  unique: true,
  partialFilterExpression: {
    effectKey: { $type: "string", $gt: "" },
  },
  reusedFrom: "P0.5A",
  note: "Index name retains packing prefix; filter already covers Dispatch effectKeys.",
});

function normDim(v) {
  return String(v ?? "").trim().toUpperCase();
}

/**
 * Deterministic durable effect key for one Dispatch stock effect.
 */
export function buildDispatchEffectKey({
  companyId,
  dispatchId,
  dispatchLineId,
  movementType,
  warehouse = "",
  location = "",
  batchNo = "",
  serialNo = "",
  customsLot = "",
}) {
  const parts = [
    String(companyId || ""),
    DISPATCH_SOURCE_DOCUMENT_TYPE,
    String(dispatchId || ""),
    String(dispatchLineId || ""),
    String(movementType || "").toUpperCase(),
    normDim(warehouse),
    normDim(location) || normDim(warehouse),
    String(batchNo ?? "").trim(),
    String(serialNo ?? "").trim(),
    String(customsLot ?? "").trim(),
  ];
  return parts.join("|");
}

export function buildDispatchReversalEffectKey(originalEffectKey) {
  return `${String(originalEffectKey || "")}|REVERSAL`;
}

export function dispatchConflictError(code, message, details = null, statusCode = 409) {
  const err = new Error(message);
  err.code = code;
  err.statusCode = statusCode;
  err.details = details;
  return err;
}

export function isDispatchEffectDuplicateKeyError(err) {
  if (Number(err?.code) !== 11000) return false;
  const msg = String(err?.message || "");
  if (msg.includes(DISPATCH_EFFECT_UNIQUE_INDEX) || msg.includes("effectKey")) return true;
  const kp = err?.keyPattern && typeof err.keyPattern === "object" ? err.keyPattern : {};
  return Boolean(kp.effectKey);
}

/** In-memory claim store for concurrency unit tests. */
export function claimDispatchStatus(store, { dispatchId, fromStatuses, toStatus }) {
  const cur = store.get(String(dispatchId));
  if (!cur) return null;
  if (!fromStatuses.includes(cur.status)) return null;
  const next = { ...cur, status: toStatus };
  store.set(String(dispatchId), next);
  return next;
}

export function simulateDispatchPost({
  store,
  dispatchId,
  stockWork,
  hasDispatchOutEvidence,
}) {
  const doc = store.get(String(dispatchId));
  if (!doc) {
    throw dispatchConflictError(DISPATCH_POSTING_CONFLICT, "Dispatch not found", null, 404);
  }
  if (POSTED_DISPATCH_STATUSES.includes(doc.status)) {
    if (!hasDispatchOutEvidence(doc)) {
      throw dispatchConflictError(
        DISPATCH_LEDGER_INCONSISTENT,
        "Dispatch is posted but expected DISPATCH_OUT ledger evidence is missing",
        { dispatchId: String(dispatchId) }
      );
    }
    return { outcome: "idempotent", stockMoves: 0, doc };
  }
  if (doc.status === "POSTING") {
    throw dispatchConflictError(DISPATCH_POST_IN_PROGRESS, "Dispatch post already in progress");
  }
  if (doc.status === "CANCELLING") {
    throw dispatchConflictError(DISPATCH_POSTING_CONFLICT, "Dispatch cancellation in progress");
  }
  if (doc.status !== "DRAFT") {
    throw dispatchConflictError(
      DISPATCH_POSTING_CONFLICT,
      `Cannot post dispatch in status ${doc.status}`
    );
  }

  const claimed = claimDispatchStatus(store, {
    dispatchId,
    fromStatuses: ["DRAFT"],
    toStatus: "POSTING",
  });
  if (!claimed) {
    throw dispatchConflictError(DISPATCH_POSTING_CONFLICT, "Failed to claim dispatch for post");
  }

  try {
    stockWork(claimed);
    const posted = {
      ...claimed,
      status: "FULLY_DISPATCHED",
      hasEvidence: true,
    };
    store.set(String(dispatchId), posted);
    return { outcome: "posted", stockMoves: 1, doc: posted };
  } catch (e) {
    store.set(String(dispatchId), { ...claimed, status: "DRAFT" });
    throw e;
  }
}

export function simulateDispatchCancel({
  store,
  dispatchId,
  stockWork,
  hasDispatchOutEvidence,
  hasCancelEvidence,
}) {
  const doc = store.get(String(dispatchId));
  if (!doc) {
    throw dispatchConflictError(DISPATCH_CANCEL_CONFLICT, "Dispatch not found", null, 404);
  }
  if (doc.status === "CANCELLED") {
    if (hasCancelEvidence?.(doc) || !hasDispatchOutEvidence(doc)) {
      return { outcome: "idempotent", stockMoves: 0, doc };
    }
    throw dispatchConflictError(
      DISPATCH_LEDGER_INCONSISTENT,
      "Dispatch is CANCELLED but DISPATCH_OUT evidence was not reversed",
      { dispatchId: String(dispatchId) }
    );
  }
  if (doc.status === "CANCELLING") {
    throw dispatchConflictError(
      DISPATCH_CANCEL_IN_PROGRESS,
      "Dispatch cancellation already in progress"
    );
  }
  if (doc.status === "POSTING") {
    throw dispatchConflictError(DISPATCH_CANCEL_CONFLICT, "Dispatch post in progress");
  }
  if (doc.status === "DRAFT") {
    const cancelled = { ...doc, status: "CANCELLED" };
    store.set(String(dispatchId), cancelled);
    return { outcome: "cancelled_draft", stockMoves: 0, doc: cancelled };
  }
  if (!POSTED_DISPATCH_STATUSES.includes(doc.status)) {
    throw dispatchConflictError(
      DISPATCH_CANCEL_CONFLICT,
      `Cannot cancel dispatch in status ${doc.status}`
    );
  }
  if (!hasDispatchOutEvidence(doc)) {
    throw dispatchConflictError(
      DISPATCH_LEDGER_INCONSISTENT,
      "Cannot cancel: original DISPATCH_OUT ledger evidence is missing",
      { dispatchId: String(dispatchId) }
    );
  }

  const claimed = claimDispatchStatus(store, {
    dispatchId,
    fromStatuses: [...POSTED_DISPATCH_STATUSES],
    toStatus: "CANCELLING",
  });
  if (!claimed) {
    throw dispatchConflictError(DISPATCH_CANCEL_CONFLICT, "Failed to claim dispatch for cancel");
  }

  try {
    stockWork(claimed);
    const cancelled = {
      ...claimed,
      status: "CANCELLED",
      hasEvidence: false,
      hasCancel: true,
    };
    store.set(String(dispatchId), cancelled);
    return { outcome: "cancelled", stockMoves: 1, doc: cancelled };
  } catch (e) {
    store.set(String(dispatchId), { ...claimed, status: doc.status });
    throw e;
  }
}
