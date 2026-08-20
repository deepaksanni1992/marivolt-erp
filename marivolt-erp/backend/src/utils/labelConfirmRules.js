/**
 * Manual printed-qty confirmation for PARTIAL / UNCERTAIN label jobs.
 * Confirm never generates RAW output; it only accounts for labels the operator verified.
 */

export const CONFIRMABLE_LABEL_JOB_STATUSES = ["PARTIAL", "PRINTING", "LEASED", "UNCERTAIN", "FAILED"];

/**
 * @param {{
 *   status?: string,
 *   printedLabels?: number,
 *   remainingLabels?: number,
 *   requestedLabels?: number,
 *   confirmedQty?: number,
 *   allowedStatuses?: string[],
 * }} args
 */
export function planManualPrintedQtyConfirmation({
  status = "",
  printedLabels = 0,
  remainingLabels = 0,
  requestedLabels = 0,
  confirmedQty = 0,
  allowedStatuses = CONFIRMABLE_LABEL_JOB_STATUSES,
} = {}) {
  const currentStatus = String(status || "").toUpperCase();
  if (!allowedStatuses.includes(currentStatus)) {
    return {
      ok: false,
      code: "LABEL_CONFIRM_STATUS",
      message: `Cannot confirm printed quantity for status ${currentStatus || "(empty)"}`,
      nextStatus: currentStatus,
      nextPrintedLabels: Number(printedLabels) || 0,
      nextRemainingLabels: Number(remainingLabels) || 0,
      confirmedQty: 0,
    };
  }

  if (confirmedQty === "" || confirmedQty == null) {
    return {
      ok: false,
      code: "LABEL_CONFIRM_QTY_INVALID",
      message: "Confirmed printed quantity is required",
      nextStatus: currentStatus,
      nextPrintedLabels: Number(printedLabels) || 0,
      nextRemainingLabels: Number(remainingLabels) || 0,
      confirmedQty: 0,
    };
  }
  const qty = Number(confirmedQty);
  if (!Number.isFinite(qty) || qty < 0) {
    return {
      ok: false,
      code: "LABEL_CONFIRM_QTY_INVALID",
      message: "Confirmed printed quantity must be a non-negative number",
      nextStatus: currentStatus,
      nextPrintedLabels: Number(printedLabels) || 0,
      nextRemainingLabels: Number(remainingLabels) || 0,
      confirmedQty: 0,
    };
  }

  const wasRemaining =
    Number(remainingLabels) > 0
      ? Number(remainingLabels)
      : Number(remainingLabels) === 0 && Number(printedLabels) > 0
        ? 0
        : Number(remainingLabels) || Number(requestedLabels) || 0;

  if (qty > wasRemaining + 1e-9) {
    return {
      ok: false,
      code: "LABEL_CONFIRM_EXCEEDS_REMAINING",
      message: `Confirmed printed qty (${qty}) cannot exceed remaining (${wasRemaining})`,
      nextStatus: currentStatus,
      nextPrintedLabels: Number(printedLabels) || 0,
      nextRemainingLabels: wasRemaining,
      confirmedQty: qty,
    };
  }

  const nextPrintedLabels = (Number(printedLabels) || 0) + qty;
  const nextRemainingLabels = Math.max(0, wasRemaining - qty);
  const nextStatus = nextRemainingLabels > 0 ? "PARTIAL" : "COMPLETED";
  return {
    ok: true,
    code: "",
    message: "",
    nextStatus,
    nextPrintedLabels,
    nextRemainingLabels,
    confirmedQty: qty,
    wasRemaining,
    clearLastError: nextStatus === "COMPLETED",
  };
}

/**
 * Operator-facing success copy after confirming physical labels for an ASN RU job.
 */
export function formatUncertainConfirmSuccessMessage({
  confirmedQty = 0,
  ruNos = [],
  jobStatus = "",
} = {}) {
  const qty = Number(confirmedQty) || 0;
  const nos = (ruNos || []).map((n) => String(n || "").trim().toUpperCase()).filter(Boolean);
  const status = String(jobStatus || "").toUpperCase();
  if (status === "COMPLETED" && nos.length === 1) {
    return `${qty} physical label confirmed. RU ${nos[0]} is now PRINTED.`;
  }
  if (status === "COMPLETED" && nos.length > 1) {
    return `${qty} physical label(s) confirmed. Receiving Units ${nos.join(", ")} are now PRINTED.`;
  }
  if (status === "COMPLETED") {
    return `${qty} physical label(s) confirmed. Job is COMPLETED.`;
  }
  return `${qty} physical label(s) confirmed. Remaining labels still need a separate print/retry.`;
}
