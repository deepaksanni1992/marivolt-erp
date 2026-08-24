/**
 * Packing-label queue idempotency — active vs terminal job handling.
 * Historical jobs retain packingSelectionFingerprint; active idempotencyKey is released
 * on CANCELLED/FAILED so a fresh Print Selected can enqueue a new PENDING job.
 */
import { LABEL_JOB_STATUSES } from "../../models/LabelPrintJob.js";

/** Job is actively queued or printing — identical POST reuses without duplicate. */
export const PACKING_LABEL_ACTIVE_IDEMPOTENCY_STATUSES = Object.freeze([
  "PENDING",
  "LEASED",
  "PRINTING",
]);

/** Successful completion — identical POST dedupes (no accidental reprint). */
export const PACKING_LABEL_COMPLETED_IDEMPOTENCY_STATUSES = Object.freeze(["COMPLETED"]);

/**
 * Ambiguous or partial completion — do not auto-enqueue another physical print.
 * Operator must Confirm qty / Retry on the existing job.
 */
export const PACKING_LABEL_BLOCKING_REPRINT_STATUSES = Object.freeze(["UNCERTAIN", "PARTIAL"]);

/** Terminal failures/cancellations — fresh Print Selected may create a new job. */
export const PACKING_LABEL_RELEASE_KEY_STATUSES = Object.freeze(["CANCELLED", "FAILED"]);

function normalizeStatus(status) {
  return String(status || "").trim().toUpperCase();
}

export function isActivePackingLabelQueueStatus(status) {
  return PACKING_LABEL_ACTIVE_IDEMPOTENCY_STATUSES.includes(normalizeStatus(status));
}

/**
 * Decide how an existing job matching idempotencyKey should be handled.
 * @returns {{
 *   action: 'create' | 'reuse' | 'dedupe' | 'block',
 *   code?: string,
 *   message?: string,
 * }}
 */
export function resolvePackingLabelIdempotencyAction(existingStatus) {
  const status = normalizeStatus(existingStatus);
  if (isActivePackingLabelQueueStatus(status)) {
    return { action: "reuse" };
  }
  if (PACKING_LABEL_COMPLETED_IDEMPOTENCY_STATUSES.includes(status)) {
    return { action: "dedupe" };
  }
  if (status === "UNCERTAIN") {
    return {
      action: "block",
      code: "LABEL_UNCERTAIN_EXISTING",
      message:
        "An uncertain label print job already exists for this selection. Confirm the printed quantity on the existing job before printing again.",
    };
  }
  if (status === "PARTIAL") {
    return {
      action: "block",
      code: "LABEL_PARTIAL_EXISTING",
      message:
        "A partial label print job already exists for this selection. Use Retry or Confirm qty on the existing job.",
    };
  }
  if (PACKING_LABEL_RELEASE_KEY_STATUSES.includes(status)) {
    return { action: "create" };
  }
  return { action: "create" };
}

export function buildPackingLabelEnqueueResponse(job, { created, reused }) {
  return {
    job,
    created: Boolean(created),
    reused: Boolean(reused),
    queueState: normalizeStatus(job?.status),
  };
}

/** All statuses from schema — documentation / tests. */
export function listPackingLabelJobStatuses() {
  return [...LABEL_JOB_STATUSES];
}
