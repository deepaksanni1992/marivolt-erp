import {
  classifyPrintResult,
  classifySpoolJobResult,
  createPrinterFifo,
  isLeaseEligiblePrinterStatus,
  spoolDocumentName,
  waitForQueueDrain,
  waitForSpoolJobCompletion,
} from "./printSafety.js";
import {
  createPrintTimingTrace,
  formatPrintTimingSummaryLine,
} from "./printTiming.js";
import {
  classifyRawFaceBatchResult,
  faceDocumentName,
  validateRawFaceBatchInput,
} from "./adapters/rawFaceBatch.js";

/**
 * Sequential per-printer print cycle.
 * SINGLE_RAW: one WritePrinter TSPL + JobId drain (GRN/ASN/RU).
 * RAW_FACE_BATCH: N independent RAW docs (packing) inside one FIFO lease.
 */
export function createJobProcessor({
  getPrinterHealth,
  getPrinterHealthLightweight,
  getWindowsPrintJobStatus,
  leaseNext,
  releaseLease,
  markPrinting,
  reportResult,
  printRaw,
  fifo = createPrinterFifo(),
  log = () => {},
  diagLog = null,
  drainTimeoutMs,
  drainPollMs,
  sleepFn,
} = {}) {
  const dlog = typeof diagLog === "function" ? diagLog : () => {};

  async function resolveLeaseHealth() {
    const started = Date.now();
    const health = await getPrinterHealth({ purpose: "lease" });
    return { health, ms: Date.now() - started };
  }

  async function resolvePreSendHealth(printerName) {
    const started = Date.now();
    if (typeof getPrinterHealthLightweight === "function") {
      const health = await getPrinterHealthLightweight(printerName);
      return { health, ms: Date.now() - started, mode: "lightweight" };
    }
    const health = await getPrinterHealth({ purpose: "presend", printerName });
    return { health, ms: Date.now() - started, mode: "full" };
  }

  async function processRawFaceBatch({ job, printerName, trace }) {
    const faces = Array.isArray(job.rawFacePayloads) ? job.rawFacePayloads : [];
    const requested = Math.max(0, Number(job.requestedLabels) || 0);
    const pre = validateRawFaceBatchInput({ faces, requestedLabels: requested });
    if (!pre.ok) {
      const outcome = {
        status: "FAILED",
        printedQty: 0,
        submittedFaceCount: 0,
        windowsSpoolJobIds: [],
        error: pre.error,
      };
      await reportResult(job, outcome);
      emitTimingSummary(log, trace.finish(outcome));
      return true;
    }
    if (typeof printRaw !== "function") {
      const outcome = {
        status: "FAILED",
        printedQty: 0,
        submittedFaceCount: 0,
        windowsSpoolJobIds: [],
        error: "RAW transport not configured on agent",
      };
      await reportResult(job, outcome);
      emitTimingSummary(log, trace.finish(outcome));
      return true;
    }

    const windowsSpoolJobIds = [];
    let submittedFaceCount = 0;
    let lastDocumentName = "";
    let submitError = "";
    const submitStarted = Date.now();

    dlog(
      `PRINT_DIAG jobId=${trace.jobId} event=raw_face_batch_start faces=${faces.length} requested=${requested}`
    );

    for (let i = 0; i < faces.length; i++) {
      const documentName = faceDocumentName(job.jobNo, i);
      lastDocumentName = documentName;
      const buf = Buffer.from(String(faces[i] || ""), "utf8");
      if (!buf.length) {
        submitError = `RAW_FACE_BATCH face ${i + 1} empty buffer`;
        break;
      }
      try {
        if (i === 0) trace.markSubmitStart();
        dlog(
          `PRINT_DIAG jobId=${trace.jobId} event=raw_face_submit_start face=${i + 1}/${faces.length} documentName=${documentName} bytes=${buf.length}`
        );
        const sent = await printRaw(buf, printerName, {
          documentName,
          jobNo: job.jobNo,
          faceIndex: i,
        });
        const wrote = sent?.ok !== false;
        const timing = sent?.timing || null;
        const bytesWritten =
          timing?.bytesWritten != null
            ? Number(timing.bytesWritten)
            : sent?.bytesWritten != null
              ? Number(sent.bytesWritten)
              : null;
        if (
          wrote &&
          bytesWritten != null &&
          Number.isFinite(bytesWritten) &&
          buf.length > 0 &&
          bytesWritten < buf.length
        ) {
          submitError = `Partial WritePrinter face ${i + 1} (${bytesWritten}/${buf.length})`;
          break;
        }
        if (!wrote) {
          submitError = sent?.error || `WritePrinter failed for face ${i + 1}`;
          break;
        }
        submittedFaceCount += 1;
        const rawId = timing?.windowsSpoolJobId ?? sent?.windowsSpoolJobId ?? null;
        const id = Number(rawId);
        if (Number.isFinite(id) && id > 0) {
          windowsSpoolJobIds.push(id);
        }
        dlog(
          `PRINT_DIAG jobId=${trace.jobId} event=raw_face_submit_done face=${i + 1} windowsSpoolJobId=${Number.isFinite(id) && id > 0 ? id : "null"}`
        );
      } catch (e) {
        submitError = e.message || `WritePrinter failed for face ${i + 1}`;
        break;
      }
    }

    const submitMs = Date.now() - submitStarted;
    const lastId = windowsSpoolJobIds.length
      ? windowsSpoolJobIds[windowsSpoolJobIds.length - 1]
      : null;
    if (lastId != null) {
      trace.setDocumentName(lastDocumentName);
      trace.setRawSubmit({
        totalMs: submitMs,
        windowsSpoolJobId: lastId,
        windowsJobName: lastDocumentName,
      });
    } else {
      trace.setRawSubmit({ totalMs: submitMs, windowsSpoolJobId: null, windowsJobName: lastDocumentName });
    }

    const jobIdCorrelationFailed =
      submittedFaceCount === requested && windowsSpoolJobIds.length < requested;

    let drained = false;
    let drainTimeout = false;
    let spoolMonitorError = "";
    if (
      submittedFaceCount === requested &&
      lastId != null &&
      !jobIdCorrelationFailed &&
      typeof getWindowsPrintJobStatus === "function"
    ) {
      const spoolOutcome = await waitForSpoolJobCompletion({
        timeoutMs: drainTimeoutMs,
        pollMs: drainPollMs,
        windowsSpoolJobId: lastId,
        documentName: lastDocumentName,
        jobId: trace.jobId,
        sleepFn,
        getJobStatus: () => getWindowsPrintJobStatus(printerName, lastId),
        onProbe: (obs) => {
          dlog(
            `PRINT_DIAG jobId=${trace.jobId} event=raw_face_batch_spool_probe n=${obs.probeNumber} windowsSpoolJobId=${lastId} state=${obs.state}`
          );
        },
      });
      trace.setDrain({
        drainMs: spoolOutcome.drainMs,
        probeCount: spoolOutcome.probeCount,
        maxProbeMs: spoolOutcome.maxProbeMs,
      });
      drained = spoolOutcome.completed === true;
      drainTimeout = spoolOutcome.timeout === true || spoolOutcome.completed !== true;
      spoolMonitorError = String(spoolOutcome.error || "");
    } else if (submittedFaceCount === requested && jobIdCorrelationFailed) {
      drainTimeout = true;
      spoolMonitorError = "Windows spool JobId(s) could not be safely identified";
    } else if (submittedFaceCount === requested && lastId == null) {
      drainTimeout = true;
      spoolMonitorError = "Windows spool JobId not captured after RAW_FACE_BATCH submit";
    }

    const outcome = classifyRawFaceBatchResult({
      requestedLabels: requested,
      submittedFaceCount,
      windowsSpoolJobIds,
      drained,
      drainTimeout,
      submitError: submitError || spoolMonitorError,
      jobIdCorrelationFailed,
    });
    outcome.submitMs = submitMs;
    await reportResult(job, outcome);
    emitTimingSummary(log, trace.finish(outcome));
    return true;
  }

  async function processOne() {
    const { health: defaultHealth, ms: preLeaseProbeMs } = await resolveLeaseHealth();
    if (!isLeaseEligiblePrinterStatus(defaultHealth?.status)) {
      log(`Skip lease — printer ${defaultHealth?.status || "UNKNOWN"}`, {
        event: "lease_skipped_unhealthy",
      });
      return false;
    }

    const job = await leaseNext();
    if (!job) return false;

    const trace = createPrintTimingTrace(job);
    trace.setPreLeaseProbeMs(preLeaseProbeMs);
    dlog(
      `PRINT_DIAG jobId=${trace.jobId} jobNo=${trace.jobNo} event=leased requestedLabels=${trace.state.requestedLabels} payloadBytes=${trace.state.payloadBytes} payloadMode=${job.payloadMode || "SINGLE_RAW"} preLeaseProbeMs=${preLeaseProbeMs}`
    );

    const printerName = job.windowsPrinterName || defaultHealth?.name || "";
    if (!printerName) {
      const outcome = {
        status: "FAILED",
        printedQty: 0,
        error: "No Windows printer name configured",
      };
      await reportResult(job, outcome);
      emitTimingSummary(log, trace.finish(outcome));
      return true;
    }

    return fifo.run(printerName, async () => {
      const { health: preSend, ms: preSendProbeMs, mode: preSendMode } =
        await resolvePreSendHealth(printerName);
      trace.setPreSendProbeMs(preSendProbeMs);
      dlog(
        `PRINT_DIAG jobId=${trace.jobId} event=pre_send_probe mode=${preSendMode} ms=${preSendProbeMs} status=${preSend?.status || "UNKNOWN"} queueLength=${preSend?.queueLength ?? ""}`
      );
      if (!isLeaseEligiblePrinterStatus(preSend?.status)) {
        log(`Release lease ${job.jobNo} — printer ${preSend?.status || "UNKNOWN"}`, {
          event: "lease_released_unhealthy",
        });
        await releaseLease(job);
        emitTimingSummary(
          log,
          trace.finish({
            status: "RELEASED",
            printedQty: 0,
            error: `lease released — printer ${preSend?.status || "UNKNOWN"}`,
          })
        );
        return false;
      }

      await markPrinting(job);
      const payloadMode = String(job.payloadMode || "SINGLE_RAW").toUpperCase();
      if (payloadMode === "RAW_FACE_BATCH") {
        return processRawFaceBatch({ job, printerName, trace });
      }
      if (payloadMode === "DRIVER_PAGES") {
        const outcome = {
          status: "FAILED",
          printedQty: 0,
          error: "DRIVER_PAGES abandoned — use RAW_FACE_BATCH for packing",
        };
        await reportResult(job, outcome);
        emitTimingSummary(log, trace.finish(outcome));
        return true;
      }

      const documentName = spoolDocumentName(job.jobNo);
      trace.setDocumentName(documentName);
      const baselineQueueLength = Number(preSend.queueLength) || 0;
      const buf = Buffer.from(job.tsplPayload || "", "utf8");
      if (!buf.length) {
        const outcome = {
          status: "FAILED",
          printedQty: 0,
          error: "Empty TSPL payload",
        };
        await reportResult(job, outcome);
        emitTimingSummary(log, trace.finish(outcome));
        return true;
      }

      let wrote = false;
      let submitTiming = null;
      let windowsSpoolJobId = null;
      let jobIdCaptured = false;
      let bytesWritten = null;
      try {
        trace.markSubmitStart();
        dlog(
          `PRINT_DIAG jobId=${trace.jobId} event=print_raw_start documentName=${documentName} bytes=${buf.length}`
        );
        const sent = await printRaw(buf, printerName, { documentName, jobNo: job.jobNo });
        wrote = sent?.ok !== false;
        submitTiming = sent?.timing || null;
        if (submitTiming) {
          trace.setRawSubmit(submitTiming);
          bytesWritten =
            submitTiming.bytesWritten != null ? Number(submitTiming.bytesWritten) : null;
        } else {
          trace.setRawSubmit({
            totalMs: 0,
            windowsSpoolJobId: sent?.windowsSpoolJobId ?? null,
            windowsJobName: documentName,
          });
          if (sent?.bytesWritten != null) bytesWritten = Number(sent.bytesWritten);
        }
        {
          const rawId =
            submitTiming?.windowsSpoolJobId ?? sent?.windowsSpoolJobId ?? null;
          const id = Number(rawId);
          if (Number.isFinite(id) && id > 0) {
            windowsSpoolJobId = id;
            jobIdCaptured = true;
          }
        }
        dlog(
          `PRINT_DIAG jobId=${trace.jobId} event=print_raw_done ok=${wrote} rawSubmitMs=${trace.state.rawSubmitMs} windowsSpoolJobId=${jobIdCaptured ? windowsSpoolJobId : "null"} bytesWritten=${bytesWritten ?? ""}`
        );
      } catch (e) {
        if (e?.timing) trace.setRawSubmit(e.timing);
        const outcome = {
          status: "FAILED",
          printedQty: 0,
          error: e.message || "WritePrinter failed",
        };
        await reportResult(job, outcome);
        emitTimingSummary(log, trace.finish(outcome));
        return true;
      }

      if (
        wrote &&
        bytesWritten != null &&
        Number.isFinite(bytesWritten) &&
        buf.length > 0 &&
        bytesWritten < buf.length
      ) {
        const outcome = {
          status: "UNCERTAIN",
          printedQty: 0,
          error: `Partial WritePrinter (${bytesWritten}/${buf.length} bytes) — physical print unproven`,
        };
        await reportResult(job, outcome);
        emitTimingSummary(log, trace.finish(outcome));
        return true;
      }

      let outcome;
      if (jobIdCaptured && typeof getWindowsPrintJobStatus === "function") {
        const spoolOutcome = await waitForSpoolJobCompletion({
          timeoutMs: drainTimeoutMs,
          pollMs: drainPollMs,
          windowsSpoolJobId,
          documentName,
          jobId: trace.jobId,
          sleepFn,
          getJobStatus: () => getWindowsPrintJobStatus(printerName, windowsSpoolJobId),
          onProbe: (obs) => {
            dlog(
              `PRINT_DIAG jobId=${trace.jobId} event=spool_job_probe n=${obs.probeNumber} elapsedMs=${obs.elapsedMs} probeMs=${obs.probeMs} windowsSpoolJobId=${windowsSpoolJobId} state=${obs.state} present=${obs.present} seenPresent=${obs.seenPresent}`
            );
          },
        });
        trace.setDrain({
          drainMs: spoolOutcome.drainMs,
          probeCount: spoolOutcome.probeCount,
          maxProbeMs: spoolOutcome.maxProbeMs,
        });
        outcome = classifySpoolJobResult({
          wrote,
          bytesRequested: buf.length,
          bytesWritten,
          windowsSpoolJobId,
          jobIdCaptured: true,
          spoolOutcome,
        });
      } else {
        const drain = await waitForQueueDrain({
          timeoutMs: drainTimeoutMs,
          pollMs: drainPollMs,
          baselineQueueLength,
          getHealth: async () => {
            if (typeof getPrinterHealthLightweight === "function") {
              return getPrinterHealthLightweight(printerName);
            }
            return getPrinterHealth({ purpose: "drain", printerName });
          },
          sleepFn,
          documentName,
          jobId: trace.jobId,
          onProbe: (obs) => {
            dlog(
              `PRINT_DIAG jobId=${trace.jobId} event=drain_probe_fallback n=${obs.probeNumber} elapsedMs=${obs.elapsedMs} probeMs=${obs.probeMs} queueLength=${obs.queueLength} status=${obs.printerStatus}`
            );
          },
        });
        trace.setDrain(drain);
        outcome = classifyPrintResult({
          wrote,
          drained: drain.drained,
          timeout: drain.timeout,
          printerReadyAfterWrite:
            drain.printerReady && isLeaseEligiblePrinterStatus(drain.finalPrinterStatus),
        });
      }

      if (outcome.status === "COMPLETED") {
        outcome.printedQty = job.requestedLabels;
      }
      await reportResult(job, outcome);
      emitTimingSummary(log, trace.finish(outcome));
      return true;
    });
  }

  return { processOne, fifo };
}

function emitTimingSummary(log, summary) {
  log(formatPrintTimingSummaryLine(summary), { event: "PRINT_TIMING_SUMMARY" });
}
