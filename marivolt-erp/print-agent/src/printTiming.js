/**
 * Temporary diagnostic instrumentation for label print performance.
 * Logs timing only — does not alter print / COMPLETED / UNCERTAIN semantics.
 * Never log TSPL payload or customer label field values.
 */

export function nowMs() {
  return Date.now();
}

export function createPrintTimingTrace(job = {}) {
  const jobId = String(job.id || job.jobNo || "unknown");
  const jobNo = String(job.jobNo || "");
  const sourceType = String(job.sourceType || job.sourceNo || "").slice(0, 40);
  const requestedLabels = Math.max(0, Number(job.requestedLabels) || 0);
  const payloadBytes = Buffer.byteLength(String(job.tsplPayload || ""), "utf8");
  const rawFaces = Array.isArray(job.rawFacePayloads) ? job.rawFacePayloads : [];
  const faceBytes = rawFaces.reduce(
    (s, face) => s + Buffer.byteLength(String(face || ""), "utf8"),
    0
  );
  const startedAt = nowMs();
  const leasedAt = nowMs();

  /** @type {Record<string, unknown>} */
  const state = {
    jobId,
    jobNo,
    sourceType,
    requestedLabels,
    payloadBytes: payloadBytes + faceBytes,
    startedAt,
    leasedAt,
    documentName: "",
    windowsSpoolJobId: null,
    windowsSpoolJobIdCaptured: false,
    preLeaseProbeMs: null,
    preSendProbeMs: null,
    leaseToSubmitMs: null,
    rawSubmitMs: null,
    drainMs: null,
    drainProbeCount: 0,
    maxDrainProbeMs: 0,
    finalStatus: "",
    finalReason: "",
    printedQty: null,
  };

  return {
    jobId,
    jobNo,
    get state() {
      return state;
    },
    setDocumentName(name) {
      state.documentName = String(name || "").slice(0, 80);
    },
    setPreLeaseProbeMs(ms) {
      state.preLeaseProbeMs = Number(ms) || 0;
    },
    setPreSendProbeMs(ms) {
      state.preSendProbeMs = Number(ms) || 0;
    },
    markSubmitStart() {
      state.leaseToSubmitMs = Math.max(0, nowMs() - leasedAt);
    },
    setRawSubmit(result = {}) {
      state.rawSubmitMs = Number(result.totalMs) || 0;
      if (result.windowsSpoolJobId != null && result.windowsSpoolJobId !== "") {
        state.windowsSpoolJobId = Number(result.windowsSpoolJobId);
        state.windowsSpoolJobIdCaptured = Number.isFinite(state.windowsSpoolJobId) && state.windowsSpoolJobId > 0;
      } else {
        state.windowsSpoolJobId = null;
        state.windowsSpoolJobIdCaptured = false;
      }
      if (result.windowsJobName) state.documentName = String(result.windowsJobName).slice(0, 80);
    },
    setDrain(result = {}) {
      state.drainMs = Number(result.drainMs) || 0;
      state.drainProbeCount = Number(result.probeCount) || 0;
      state.maxDrainProbeMs = Number(result.maxProbeMs) || 0;
    },
    finish(outcome = {}) {
      state.finalStatus = String(outcome.status || "");
      state.finalReason = String(outcome.error || "").slice(0, 240);
      state.printedQty = outcome.printedQty == null ? null : Number(outcome.printedQty);
      state.totalProcessingMs = Math.max(0, nowMs() - startedAt);
      return buildPrintTimingSummary(state);
    },
  };
}

export function buildPrintTimingSummary(state = {}) {
  return {
    event: "PRINT_TIMING_SUMMARY",
    jobId: state.jobId || "",
    jobNo: state.jobNo || "",
    sourceType: state.sourceType || "",
    requestedLabels: Number(state.requestedLabels) || 0,
    payloadBytes: Number(state.payloadBytes) || 0,
    documentName: state.documentName || "",
    windowsSpoolJobId: state.windowsSpoolJobIdCaptured ? state.windowsSpoolJobId : null,
    windowsSpoolJobIdCaptured: Boolean(state.windowsSpoolJobIdCaptured),
    leaseToSubmitMs: state.leaseToSubmitMs,
    preLeaseProbeMs: state.preLeaseProbeMs,
    preSendProbeMs: state.preSendProbeMs,
    rawSubmitMs: state.rawSubmitMs,
    drainMs: state.drainMs,
    drainProbeCount: state.drainProbeCount,
    maxDrainProbeMs: state.maxDrainProbeMs,
    totalProcessingMs: state.totalProcessingMs,
    finalStatus: state.finalStatus || "",
    finalReason: state.finalReason || "",
    printedQty: state.printedQty,
  };
}

/** Compact one-line summary for agent.log (no TSPL / customer fields). */
export function formatPrintTimingSummaryLine(summary = {}) {
  const parts = [
    "PRINT_TIMING_SUMMARY",
    `jobId=${summary.jobId || ""}`,
    `jobNo=${summary.jobNo || ""}`,
    `sourceType=${summary.sourceType || ""}`,
    `requestedLabels=${summary.requestedLabels ?? ""}`,
    `payloadBytes=${summary.payloadBytes ?? ""}`,
    `documentName=${summary.documentName || ""}`,
    `windowsSpoolJobId=${summary.windowsSpoolJobIdCaptured ? summary.windowsSpoolJobId : "null"}`,
    `leaseToSubmitMs=${summary.leaseToSubmitMs ?? ""}`,
    `preLeaseProbeMs=${summary.preLeaseProbeMs ?? ""}`,
    `preSendProbeMs=${summary.preSendProbeMs ?? ""}`,
    `rawSubmitMs=${summary.rawSubmitMs ?? ""}`,
    `drainMs=${summary.drainMs ?? ""}`,
    `drainProbeCount=${summary.drainProbeCount ?? ""}`,
    `maxDrainProbeMs=${summary.maxDrainProbeMs ?? ""}`,
    `totalProcessingMs=${summary.totalProcessingMs ?? ""}`,
    `finalStatus=${summary.finalStatus || ""}`,
    `printedQty=${summary.printedQty == null ? "" : summary.printedQty}`,
    `reason=${JSON.stringify(String(summary.finalReason || "").slice(0, 200))}`,
  ];
  return parts.join(" ");
}

export function assertNoSensitiveTimingPayload(text = "") {
  const s = String(text);
  if (/\bPRINT_TIMING_SUMMARY\b/.test(s) && /SIZE\s+\d+\s*mm/i.test(s)) {
    throw new Error("Timing summary must not include TSPL payload");
  }
  return true;
}
