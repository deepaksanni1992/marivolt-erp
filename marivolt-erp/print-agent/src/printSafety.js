import fs from "fs";
import path from "path";
import { SPOOL_JOB_STATES } from "./windowsPrintJobStatus.js";

/** Wait for specific Windows spool JobId to leave the queue (or timeout). */
export const QUEUE_DRAIN_TIMEOUT_MS = 45_000;
/** Lightweight JobId poll interval (full health probes are not used on this path). */
export const QUEUE_DRAIN_POLL_MS = 250;
/** Consecutive query failures before UNCERTAIN (JobId path). */
export const SPOOL_JOB_QUERY_FAIL_LIMIT = 3;

export function isLeaseEligiblePrinterStatus(status) {
  return String(status || "").trim().toUpperCase() === "READY";
}

export function canonicalPrinterKey(name) {
  return String(name || "").trim().toLowerCase();
}

export function spoolDocumentName(jobNo) {
  const no = String(jobNo || "JOB")
    .replace(/[^\w.-]/g, "")
    .slice(0, 40);
  return `Marivolt ${no || "JOB"}`;
}

/**
 * One RAW submission at a time per Windows printer name.
 * Different printers run independently (separate tails).
 */
export function createPrinterFifo() {
  const tails = new Map();
  return {
    async run(printerName, fn) {
      const key = canonicalPrinterKey(printerName) || "_default";
      const prev = tails.get(key) || Promise.resolve();
      let unlock = () => {};
      const gate = new Promise((resolve) => {
        unlock = resolve;
      });
      tails.set(
        key,
        prev.then(() => gate).catch(() => {})
      );
      await prev;
      try {
        return await fn();
      } finally {
        unlock();
      }
    },
  };
}

/**
 * Legacy JobCount-baseline classifier (fallback when Windows JobId is unavailable).
 * COMPLETED = WRITE accepted while READY and the Windows queue drained.
 */
export function classifyPrintResult({
  wrote = false,
  drained = false,
  timeout = false,
  printerReadyAfterWrite = false,
} = {}) {
  if (!wrote) {
    return {
      status: "FAILED",
      printedQty: 0,
      error: "WritePrinter failed",
    };
  }
  if (!printerReadyAfterWrite) {
    return {
      status: "UNCERTAIN",
      printedQty: 0,
      error: "Printer left READY after spool submit — physical print unproven",
    };
  }
  if (timeout || !drained) {
    return {
      status: "UNCERTAIN",
      printedQty: 0,
      error: "Windows spool did not drain before timeout — physical print unproven",
    };
  }
  return {
    status: "COMPLETED",
    printedQty: null,
    error: "",
  };
}

/**
 * JobId-primary completion classifier.
 *
 * Safe COMPLETED when WritePrinter accepted all bytes, JobId was captured, and
 * that JobId is ABSENT (including fast-USB first-poll absence after successful submit).
 */
export function classifySpoolJobResult({
  wrote = false,
  bytesRequested = 0,
  bytesWritten = null,
  windowsSpoolJobId = null,
  jobIdCaptured = false,
  spoolOutcome = null,
} = {}) {
  const requested = Math.max(0, Number(bytesRequested) || 0);
  const written =
    bytesWritten == null || bytesWritten === "" ? null : Number(bytesWritten);

  if (!wrote) {
    return { status: "FAILED", printedQty: 0, error: "WritePrinter failed" };
  }
  if (written != null && Number.isFinite(written) && requested > 0 && written < requested) {
    return {
      status: "UNCERTAIN",
      printedQty: 0,
      error: `Partial WritePrinter (${written}/${requested} bytes) — physical print unproven`,
    };
  }
  if (!jobIdCaptured || !windowsSpoolJobId) {
    return {
      status: "UNCERTAIN",
      printedQty: 0,
      error: "Windows spool JobId not captured — physical print unproven",
    };
  }
  if (!spoolOutcome) {
    return {
      status: "UNCERTAIN",
      printedQty: 0,
      error: "Spool job monitoring did not run — physical print unproven",
    };
  }
  if (spoolOutcome.completed) {
    return { status: "COMPLETED", printedQty: null, error: "" };
  }
  return {
    status: "UNCERTAIN",
    printedQty: 0,
    error:
      String(spoolOutcome.error || "").slice(0, 240) ||
      "Windows spool job outcome unproven",
  };
}

/** Consecutive READY + queue-at-or-below-baseline polls required if the job never appears in JobCount. */
export const QUEUE_DRAIN_MIN_READY_POLLS = 2;

/**
 * Monitor a specific Windows spool JobId with lightweight Get-PrintJob queries.
 *
 * Fast-USB: JobId already ABSENT on first observation after successful
 * StartDoc+WritePrinter+EndDoc → COMPLETED.
 */
export async function waitForSpoolJobCompletion({
  timeoutMs = QUEUE_DRAIN_TIMEOUT_MS,
  pollMs = QUEUE_DRAIN_POLL_MS,
  getJobStatus,
  sleepFn = (ms) => new Promise((r) => setTimeout(r, ms)),
  queryFailLimit = SPOOL_JOB_QUERY_FAIL_LIMIT,
  onProbe = null,
  documentName = "",
  jobId = "",
  windowsSpoolJobId = null,
} = {}) {
  const started = Date.now();
  let probeNumber = 0;
  let maxProbeMs = 0;
  let seenPresent = false;
  let consecutiveQueryFails = 0;
  let lastState = SPOOL_JOB_STATES.UNKNOWN;

  while (Date.now() - started < timeoutMs) {
    probeNumber += 1;
    const probeStarted = Date.now();
    const st = (await getJobStatus()) || {};
    const probeMs = Date.now() - probeStarted;
    maxProbeMs = Math.max(maxProbeMs, probeMs);
    const elapsedMs = Date.now() - started;
    const state = String(st.state || SPOOL_JOB_STATES.UNKNOWN);

    if (typeof onProbe === "function") {
      try {
        onProbe({
          jobId,
          documentName,
          windowsSpoolJobId,
          probeNumber,
          elapsedMs,
          probeMs,
          state,
          present: Boolean(st.present),
          seenPresent,
          consecutiveQueryFails,
        });
      } catch {
        /* diagnostic only */
      }
    }

    if (st.ok === false || state === SPOOL_JOB_STATES.QUERY_FAILED) {
      consecutiveQueryFails += 1;
      lastState = SPOOL_JOB_STATES.QUERY_FAILED;
      if (consecutiveQueryFails >= queryFailLimit) {
        return {
          completed: false,
          timeout: false,
          error: `Windows spool JobId status query failed repeatedly (${st.error || "query-failed"})`,
          probeCount: probeNumber,
          maxProbeMs,
          drainMs: Date.now() - started,
          seenPresent,
          finalState: lastState,
          mode: "jobId",
        };
      }
      await sleepFn(pollMs);
      continue;
    }

    consecutiveQueryFails = 0;
    lastState = state;

    if (state === SPOOL_JOB_STATES.ERROR || state === SPOOL_JOB_STATES.PAUSED) {
      return {
        completed: false,
        timeout: false,
        error: `Windows spool JobId ${windowsSpoolJobId} reported ${state}`,
        probeCount: probeNumber,
        maxProbeMs,
        drainMs: Date.now() - started,
        seenPresent,
        finalState: state,
        mode: "jobId",
      };
    }

    if (st.present) {
      seenPresent = true;
      await sleepFn(pollMs);
      continue;
    }

    return {
      completed: true,
      timeout: false,
      error: "",
      probeCount: probeNumber,
      maxProbeMs,
      drainMs: Date.now() - started,
      seenPresent,
      finalState: SPOOL_JOB_STATES.ABSENT,
      mode: "jobId",
      fastAbsent: !seenPresent,
    };
  }

  return {
    completed: false,
    timeout: true,
    error: `Windows spool JobId ${windowsSpoolJobId} still present after timeout (state=${lastState})`,
    probeCount: probeNumber,
    maxProbeMs,
    drainMs: Date.now() - started,
    seenPresent,
    finalState: lastState,
    mode: "jobId",
  };
}

export async function waitForQueueDrain({
  timeoutMs = QUEUE_DRAIN_TIMEOUT_MS,
  pollMs = QUEUE_DRAIN_POLL_MS,
  baselineQueueLength = 0,
  getHealth,
  sleepFn = (ms) => new Promise((r) => setTimeout(r, ms)),
  minReadyPolls = QUEUE_DRAIN_MIN_READY_POLLS,
  onProbe = null,
  documentName = "",
  jobId = "",
} = {}) {
  const started = Date.now();
  const baseline = Number(baselineQueueLength) || 0;
  let last = { status: "UNKNOWN", queueLength: null };
  let seenElevated = false;
  let consecutiveOk = 0;
  let probeNumber = 0;
  let maxProbeMs = 0;
  while (Date.now() - started < timeoutMs) {
    probeNumber += 1;
    const probeStarted = Date.now();
    last = (await getHealth()) || last;
    const probeMs = Date.now() - probeStarted;
    maxProbeMs = Math.max(maxProbeMs, probeMs);
    const status = String(last.status || "").toUpperCase();
    const q = Number(last.queueLength);
    const queueLength = Number.isFinite(q) ? q : 0;
    const elapsedMs = Date.now() - started;
    if (typeof onProbe === "function") {
      try {
        onProbe({
          jobId,
          documentName,
          probeNumber,
          elapsedMs,
          probeMs,
          queueLength,
          baselineQueueLength: baseline,
          printerStatus: status,
          seenElevated,
          consecutiveReady: consecutiveOk,
          probeTiming: last.probeTiming || last.timing || null,
        });
      } catch {
        /* diagnostic only */
      }
    }
    if (!isLeaseEligiblePrinterStatus(status)) {
      return {
        drained: false,
        timeout: false,
        printerReady: false,
        finalPrinterStatus: status,
        queueLength,
        probeCount: probeNumber,
        maxProbeMs,
        drainMs: Date.now() - started,
        mode: "jobCountFallback",
      };
    }
    if (queueLength > baseline) {
      seenElevated = true;
      consecutiveOk = 0;
    } else {
      consecutiveOk += 1;
      const enough = seenElevated ? consecutiveOk >= 1 : consecutiveOk >= minReadyPolls;
      if (enough) {
        return {
          drained: true,
          timeout: false,
          printerReady: true,
          finalPrinterStatus: status,
          queueLength,
          probeCount: probeNumber,
          maxProbeMs,
          drainMs: Date.now() - started,
          mode: "jobCountFallback",
        };
      }
    }
    await sleepFn(pollMs);
  }
  const q = Number(last.queueLength);
  return {
    drained: false,
    timeout: true,
    printerReady: isLeaseEligiblePrinterStatus(last.status),
    finalPrinterStatus: String(last.status || "UNKNOWN").toUpperCase(),
    queueLength: Number.isFinite(q) ? q : 0,
    probeCount: probeNumber,
    maxProbeMs,
    drainMs: Date.now() - started,
    mode: "jobCountFallback",
  };
}

export function pidIsAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (e) {
    if (e && e.code === "ESRCH") return false;
    if (e && e.code === "EPERM") return true;
    return false;
  }
}

export function acquireAgentProcessLock(lockDir, agentId, { pid = process.pid, alive = pidIsAlive } = {}) {
  fs.mkdirSync(lockDir, { recursive: true });
  const safe = String(agentId || "agent").replace(/[^\w.-]/g, "_").slice(0, 40);
  const lockPath = path.join(lockDir, `agent-${safe}.lock`);
  let existing = "";
  try {
    existing = fs.readFileSync(lockPath, "utf8");
  } catch {
    existing = "";
  }
  const oldPid = Number(String(existing || "").trim());
  if (oldPid && oldPid !== pid && alive(oldPid)) {
    const err = new Error(
      `Another print-agent process is already running for this agentId (pid ${oldPid})`
    );
    err.code = "AGENT_PROCESS_LOCK";
    throw err;
  }
  fs.writeFileSync(lockPath, String(pid), "utf8");
  return {
    lockPath,
    release() {
      try {
        const cur = String(fs.readFileSync(lockPath, "utf8") || "").trim();
        if (cur === String(pid)) fs.unlinkSync(lockPath);
      } catch {
        /* ignore */
      }
    },
  };
}
