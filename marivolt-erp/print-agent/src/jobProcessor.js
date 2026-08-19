import {
  classifyPrintResult,
  createPrinterFifo,
  isLeaseEligiblePrinterStatus,
  spoolDocumentName,
  waitForQueueDrain,
} from "./printSafety.js";

/**
 * Sequential per-printer print cycle with READY gate and spool-drain wait.
 * COMPLETED only after READY + WritePrinter + queue drain while still READY.
 */
export function createJobProcessor({
  getPrinterHealth,
  leaseNext,
  releaseLease,
  markPrinting,
  reportResult,
  printRaw,
  fifo = createPrinterFifo(),
  log = () => {},
  drainTimeoutMs,
  drainPollMs,
  sleepFn,
} = {}) {
  async function processOne() {
    const defaultHealth = await getPrinterHealth();
    if (!isLeaseEligiblePrinterStatus(defaultHealth?.status)) {
      log(`Skip lease — printer ${defaultHealth?.status || "UNKNOWN"}`, {
        event: "lease_skipped_unhealthy",
      });
      return false;
    }

    const job = await leaseNext();
    if (!job) return false;

    const printerName = job.windowsPrinterName || defaultHealth?.name || "";
    if (!printerName) {
      await reportResult(job, {
        status: "FAILED",
        printedQty: 0,
        error: "No Windows printer name configured",
      });
      return true;
    }
    return fifo.run(printerName, async () => {
      const preSend = await getPrinterHealth(printerName);
      if (!isLeaseEligiblePrinterStatus(preSend?.status)) {
        log(`Release lease ${job.jobNo} — printer ${preSend?.status || "UNKNOWN"}`, {
          event: "lease_released_unhealthy",
        });
        await releaseLease(job);
        return false;
      }

      await markPrinting(job);
      const documentName = spoolDocumentName(job.jobNo);
      const baselineQueueLength = Number(preSend.queueLength) || 0;
      const buf = Buffer.from(job.tsplPayload || "", "utf8");
      if (!buf.length) {
        await reportResult(job, {
          status: "FAILED",
          printedQty: 0,
          error: "Empty TSPL payload",
        });
        return true;
      }

      let wrote = false;
      try {
        const sent = await printRaw(buf, printerName, { documentName });
        wrote = sent?.ok !== false;
      } catch (e) {
        await reportResult(job, {
          status: "FAILED",
          printedQty: 0,
          error: e.message || "WritePrinter failed",
        });
        return true;
      }

      const drain = await waitForQueueDrain({
        timeoutMs: drainTimeoutMs,
        pollMs: drainPollMs,
        baselineQueueLength,
        getHealth: () => getPrinterHealth(printerName),
        sleepFn,
      });
      const outcome = classifyPrintResult({
        wrote,
        drained: drain.drained,
        timeout: drain.timeout,
        printerReadyAfterWrite: drain.printerReady && isLeaseEligiblePrinterStatus(drain.finalPrinterStatus),
      });
      if (outcome.status === "COMPLETED") {
        outcome.printedQty = job.requestedLabels;
      }
      await reportResult(job, outcome);
      return true;
    });
  }

  return { processOne, fifo };
}
