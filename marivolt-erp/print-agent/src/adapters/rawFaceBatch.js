/**
 * RAW_FACE_BATCH — packing/custom packing: N independent RAW TSPL documents.
 * Pure helpers for zero-paper tests (no Windows / GDI).
 */

export function validateRawFaceBatchInput({ faces, requestedLabels } = {}) {
  const list = Array.isArray(faces) ? faces : [];
  const requested = Math.max(0, Number(requestedLabels) || 0);
  if (!list.length || list.length !== requested) {
    return {
      ok: false,
      statusHint: "FAILED",
      error: `Invalid RAW_FACE_BATCH (faces=${list.length}, requestedLabels=${requested})`,
    };
  }
  for (let i = 0; i < list.length; i++) {
    const payload = String(list[i] || "");
    if (!payload.trim()) {
      return { ok: false, statusHint: "FAILED", error: `RAW_FACE_BATCH face ${i + 1} empty` };
    }
  }
  return { ok: true };
}

/**
 * Failure semantics:
 * - 0 faces submitted + failure → FAILED, printedQty 0
 * - 1..N-1 faces submitted + failure → UNCERTAIN, printedQty 0
 * - all N submitted + spool completion → COMPLETED
 */
export function classifyRawFaceBatchResult({
  requestedLabels = 0,
  submittedFaceCount = 0,
  windowsSpoolJobIds = [],
  drained = false,
  drainTimeout = false,
  submitError = "",
  jobIdCorrelationFailed = false,
} = {}) {
  const requested = Math.max(0, Number(requestedLabels) || 0);
  const submitted = Math.max(0, Number(submittedFaceCount) || 0);
  const ids = Array.isArray(windowsSpoolJobIds) ? windowsSpoolJobIds.filter((n) => Number(n) > 0) : [];

  if (submitted <= 0) {
    return {
      status: "FAILED",
      printedQty: 0,
      submittedFaceCount: 0,
      windowsSpoolJobIds: [],
      error: submitError || "RAW_FACE_BATCH submit did not start",
    };
  }

  if (submitted < requested) {
    return {
      status: "UNCERTAIN",
      printedQty: 0,
      submittedFaceCount: submitted,
      windowsSpoolJobIds: ids,
      error:
        submitError ||
        `Partial RAW_FACE_BATCH submit (${submitted}/${requested}) — physical print unproven`,
    };
  }

  if (jobIdCorrelationFailed || ids.length < requested) {
    return {
      status: "UNCERTAIN",
      printedQty: 0,
      submittedFaceCount: submitted,
      windowsSpoolJobIds: ids,
      error: submitError || "Windows spool JobId(s) could not be safely identified",
    };
  }

  if (drainTimeout || !drained) {
    return {
      status: "UNCERTAIN",
      printedQty: 0,
      submittedFaceCount: submitted,
      windowsSpoolJobIds: ids,
      error: submitError || "Spool drain timeout — physical print unproven",
    };
  }

  return {
    status: "COMPLETED",
    printedQty: requested,
    submittedFaceCount: submitted,
    windowsSpoolJobIds: ids,
    error: "",
  };
}

export function faceDocumentName(jobNo, faceIndex) {
  const base = String(jobNo || "JOB").trim() || "JOB";
  return `Marivolt ${base} F${faceIndex + 1}`.slice(0, 120);
}
