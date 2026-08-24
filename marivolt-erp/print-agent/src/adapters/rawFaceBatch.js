/**
 * Multi-face packing batch helpers (TSPL_LABEL_BATCH / legacy RAW_FACE_BATCH).
 * Pure helpers for zero-paper tests (no Windows / GDI).
 */

/** Parameterless TSPL gap calibration — once per TSPL_LABEL_BATCH, never per face. */
export const GAPDETECT_TSPL = "GAPDETECT\r\n";

export function gapDetectDocumentName(jobNo) {
  const base = String(jobNo || "JOB").trim() || "JOB";
  return `Marivolt ${base} GAPDETECT`.slice(0, 120);
}

export function validateLabelFaceBatchInput({ faces, requestedLabels, mode = "TSPL_LABEL_BATCH" } = {}) {
  const list = Array.isArray(faces) ? faces : [];
  const requested = Math.max(0, Number(requestedLabels) || 0);
  const modeName = String(mode || "TSPL_LABEL_BATCH").toUpperCase();
  if (!list.length || list.length !== requested) {
    return {
      ok: false,
      statusHint: "FAILED",
      error: `Invalid ${modeName} (faces=${list.length}, requestedLabels=${requested})`,
    };
  }
  for (let i = 0; i < list.length; i++) {
    const payload = String(list[i] || "");
    if (!payload.trim()) {
      return { ok: false, statusHint: "FAILED", error: `${modeName} face ${i + 1} empty` };
    }
  }
  return { ok: true };
}

/** @deprecated Use validateLabelFaceBatchInput */
export function validateRawFaceBatchInput(args) {
  return validateLabelFaceBatchInput({ ...args, mode: "RAW_FACE_BATCH" });
}

/**
 * Failure semantics:
 * - 0 faces submitted + failure → FAILED, printedQty 0
 * - 1..N-1 faces submitted + failure → UNCERTAIN, printedQty 0
 * - all N submitted + spool completion → COMPLETED
 */
export function classifyLabelFaceBatchResult({
  requestedLabels = 0,
  submittedFaceCount = 0,
  windowsSpoolJobIds = [],
  drained = false,
  drainTimeout = false,
  submitError = "",
  jobIdCorrelationFailed = false,
  mode = "TSPL_LABEL_BATCH",
} = {}) {
  const requested = Math.max(0, Number(requestedLabels) || 0);
  const submitted = Math.max(0, Number(submittedFaceCount) || 0);
  const ids = Array.isArray(windowsSpoolJobIds) ? windowsSpoolJobIds.filter((n) => Number(n) > 0) : [];
  const modeName = String(mode || "TSPL_LABEL_BATCH").toUpperCase();

  if (submitted <= 0) {
    return {
      status: "FAILED",
      printedQty: 0,
      submittedFaceCount: 0,
      windowsSpoolJobIds: [],
      lastLabelWriteIndex: -1,
      labelsAttempted: 0,
      totalLabels: requested,
      error: submitError || `${modeName} submit did not start`,
    };
  }

  if (submitted < requested) {
    return {
      status: "UNCERTAIN",
      printedQty: 0,
      submittedFaceCount: submitted,
      windowsSpoolJobIds: ids,
      lastLabelWriteIndex: submitted - 1,
      labelsAttempted: submitted,
      totalLabels: requested,
      error:
        submitError ||
        `Partial ${modeName} submit (${submitted}/${requested}) — physical print unproven`,
    };
  }

  if (jobIdCorrelationFailed || ids.length < requested) {
    return {
      status: "UNCERTAIN",
      printedQty: 0,
      submittedFaceCount: submitted,
      windowsSpoolJobIds: ids,
      lastLabelWriteIndex: submitted - 1,
      labelsAttempted: submitted,
      totalLabels: requested,
      error: submitError || "Windows spool JobId(s) could not be safely identified",
    };
  }

  if (drainTimeout || !drained) {
    return {
      status: "UNCERTAIN",
      printedQty: 0,
      submittedFaceCount: submitted,
      windowsSpoolJobIds: ids,
      lastLabelWriteIndex: submitted - 1,
      labelsAttempted: submitted,
      totalLabels: requested,
      error: submitError || "Spool drain timeout — physical print unproven",
    };
  }

  return {
    status: "COMPLETED",
    printedQty: requested,
    submittedFaceCount: submitted,
    windowsSpoolJobIds: ids,
    lastLabelWriteIndex: requested - 1,
    labelsAttempted: requested,
    totalLabels: requested,
    error: "",
  };
}

/** @deprecated Use classifyLabelFaceBatchResult */
export function classifyRawFaceBatchResult(args) {
  return classifyLabelFaceBatchResult({ ...args, mode: "RAW_FACE_BATCH" });
}

export function faceDocumentName(jobNo, faceIndex) {
  const base = String(jobNo || "JOB").trim() || "JOB";
  return `Marivolt ${base} F${faceIndex + 1}`.slice(0, 120);
}
