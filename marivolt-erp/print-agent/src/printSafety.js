import fs from "fs";
import path from "path";

/** Small thermal label: wait this long for Windows queue to drop after WritePrinter. */
export const QUEUE_DRAIN_TIMEOUT_MS = 45_000;
export const QUEUE_DRAIN_POLL_MS = 400;

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
 * COMPLETED = WRITE accepted while READY and the Windows queue drained.
 * That is still not optical/physical paper-sensor confirmation.
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

/** Consecutive READY + queue-at-or-below-baseline polls required if the job never appears in JobCount. */
export const QUEUE_DRAIN_MIN_READY_POLLS = 2;

export async function waitForQueueDrain({
  timeoutMs = QUEUE_DRAIN_TIMEOUT_MS,
  pollMs = QUEUE_DRAIN_POLL_MS,
  baselineQueueLength = 0,
  getHealth,
  sleepFn = (ms) => new Promise((r) => setTimeout(r, ms)),
  minReadyPolls = QUEUE_DRAIN_MIN_READY_POLLS,
} = {}) {
  const started = Date.now();
  const baseline = Number(baselineQueueLength) || 0;
  let last = { status: "UNKNOWN", queueLength: null };
  let seenElevated = false;
  let consecutiveOk = 0;
  while (Date.now() - started < timeoutMs) {
    last = (await getHealth()) || last;
    const status = String(last.status || "").toUpperCase();
    const q = Number(last.queueLength);
    const queueLength = Number.isFinite(q) ? q : 0;
    if (!isLeaseEligiblePrinterStatus(status)) {
      return {
        drained: false,
        timeout: false,
        printerReady: false,
        finalPrinterStatus: status,
        queueLength,
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
