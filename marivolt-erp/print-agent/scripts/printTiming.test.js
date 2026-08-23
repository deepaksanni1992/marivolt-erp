/**
 * Print timing diagnostics — measurement only; no behavior change.
 */
import assert from "assert";
import {
  assertNoSensitiveTimingPayload,
  buildPrintTimingSummary,
  createPrintTimingTrace,
  formatPrintTimingSummaryLine,
} from "../src/printTiming.js";
import { parseDiagStdout } from "../src/adapters/windowsRawSpooler.js";
import {
  classifyPrintResult,
  waitForQueueDrain,
} from "../src/printSafety.js";
import { createJobProcessor } from "../src/jobProcessor.js";

let passed = 0;
let failed = 0;

function run(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(
      () => {
        passed += 1;
        console.log(`  ✓ ${name}`);
      },
      (e) => {
        failed += 1;
        console.error(`  ✗ ${name}`);
        console.error(`    ${e.stack || e.message}`);
      }
    );
}

console.log("\nPrint timing diagnostics\n");

await run("1. Successful print still reaches COMPLETED with timing summary", async () => {
  const summaries = [];
  const results = [];
  let phase = "idle";
  const processor = createJobProcessor({
    drainTimeoutMs: 200,
    drainPollMs: 0,
    sleepFn: async () => {},
    log: (msg, meta) => {
      if (meta?.event === "PRINT_TIMING_SUMMARY" || String(msg).includes("PRINT_TIMING_SUMMARY")) {
        summaries.push(String(msg));
      }
    },
    getPrinterHealth: async () => {
      if (phase === "queued") {
        phase = "idle";
        return { status: "READY", queueLength: 1, name: "P" };
      }
      return { status: "READY", queueLength: 0, name: "P" };
    },
    leaseNext: async () => ({
      id: "job-ok",
      jobNo: "LBL-OK",
      sourceType: "CUSTOM_PACKING",
      requestedLabels: 1,
      tsplPayload: "SIZE 100 mm,50 mm\r\nPRINT 1,1\r\n",
      windowsPrinterName: "P",
    }),
    releaseLease: async () => {},
    markPrinting: async () => {},
    reportResult: async (_job, outcome) => {
      results.push(outcome);
    },
    printRaw: async () => {
      phase = "queued";
      return {
        ok: true,
        windowsJobName: "Marivolt LBL-OK",
        windowsSpoolJobId: 42,
        timing: {
          totalMs: 12,
          bytesWritten: 30,
          bytesRequested: 30,
          windowsSpoolJobId: 42,
          windowsSpoolJobIdCaptured: true,
          windowsJobName: "Marivolt LBL-OK",
        },
      };
    },
    getWindowsPrintJobStatus: async () => ({
      ok: true,
      present: false,
      state: "ABSENT",
    }),
  });
  await processor.processOne();
  assert.strictEqual(results[0].status, "COMPLETED");
  assert.strictEqual(results[0].printedQty, 1);
  assert.ok(summaries.some((s) => s.includes("PRINT_TIMING_SUMMARY") && s.includes("finalStatus=COMPLETED")));
  assert.ok(summaries.some((s) => s.includes("windowsSpoolJobId=42")));
});

await run("2. Drain timeout still reaches UNCERTAIN with printedQty=0", async () => {
  const results = [];
  const summaries = [];
  let healthCalls = 0;
  const processor = createJobProcessor({
    drainTimeoutMs: 50,
    drainPollMs: 0,
    sleepFn: async () => {},
    log: (msg, meta) => {
      if (meta?.event === "PRINT_TIMING_SUMMARY" || String(msg).includes("PRINT_TIMING_SUMMARY")) {
        summaries.push(String(msg));
      }
    },
    getPrinterHealth: async () => {
      healthCalls += 1;
      // Calls 1–2: pre-lease + pre-send (baseline 0). Later: stuck elevated queue.
      if (healthCalls <= 2) return { status: "READY", queueLength: 0, name: "P" };
      return { status: "READY", queueLength: 1, name: "P" };
    },
    leaseNext: async () => ({
      id: "job-unc",
      jobNo: "LBL-UNC",
      sourceType: "CUSTOM_PACKING",
      requestedLabels: 6,
      tsplPayload: "SIZE 100 mm,50 mm\r\nPRINT 1,1\r\n",
      windowsPrinterName: "P",
    }),
    releaseLease: async () => {},
    markPrinting: async () => {},
    reportResult: async (_job, outcome) => {
      results.push(outcome);
    },
    printRaw: async () => ({
      ok: true,
      timing: { totalMs: 5, windowsSpoolJobId: null, windowsJobName: "Marivolt LBL-UNC" },
    }),
  });
  await processor.processOne();
  assert.strictEqual(results[0].status, "UNCERTAIN");
  assert.strictEqual(results[0].printedQty, 0);
  assert.match(results[0].error, /did not drain/i);
  assert.ok(summaries.some((s) => s.includes("finalStatus=UNCERTAIN") && s.includes("printedQty=0")));
});

await run("3. No automatic retry after UNCERTAIN (single processOne)", async () => {
  let leases = 0;
  let reports = 0;
  const processor = createJobProcessor({
    drainTimeoutMs: 50,
    drainPollMs: 0,
    sleepFn: async () => {},
    log: () => {},
    getPrinterHealth: async () => ({ status: "READY", queueLength: 1, name: "P" }),
    leaseNext: async () => {
      leases += 1;
      if (leases > 1) return null;
      return {
        id: "job-once",
        jobNo: "LBL-ONCE",
        requestedLabels: 1,
        tsplPayload: "PRINT 1,1\r\n",
        windowsPrinterName: "P",
      };
    },
    releaseLease: async () => {},
    markPrinting: async () => {},
    reportResult: async () => {
      reports += 1;
    },
    printRaw: async () => ({ ok: true, timing: { totalMs: 1 } }),
  });
  await processor.processOne();
  const again = await processor.processOne();
  assert.strictEqual(reports, 1);
  assert.strictEqual(again, false);
});

await run("4. Timing summary generated without TSPL contents", () => {
  const trace = createPrintTimingTrace({
    id: "abc",
    jobNo: "LBL1",
    sourceType: "CUSTOM_PACKING",
    requestedLabels: 6,
    tsplPayload: 'SIZE 100 mm,50 mm\r\nTEXT 10,10,"0",0,1,1,"SECRET CUSTOMER"\r\nPRINT 1,1\r\n',
  });
  trace.setDocumentName("Marivolt LBL1");
  trace.setPreLeaseProbeMs(10);
  trace.setPreSendProbeMs(20);
  trace.markSubmitStart();
  trace.setRawSubmit({ totalMs: 30, windowsSpoolJobId: 7, windowsJobName: "Marivolt LBL1" });
  trace.setDrain({ drainMs: 40, probeCount: 3, maxProbeMs: 15 });
  const summary = trace.finish({
    status: "COMPLETED",
    printedQty: 6,
    error: "",
  });
  const line = formatPrintTimingSummaryLine(summary);
  assert.match(line, /PRINT_TIMING_SUMMARY/);
  assert.match(line, /requestedLabels=6/);
  assert.match(line, /payloadBytes=\d+/);
  assert.doesNotMatch(line, /SECRET CUSTOMER/);
  assert.doesNotMatch(line, /SIZE 100/);
  assert.doesNotMatch(line, /TEXT 10,10/);
  assertNoSensitiveTimingPayload(line);
  assert.strictEqual(summary.windowsSpoolJobId, 7);
  assert.strictEqual(summary.windowsSpoolJobIdCaptured, true);
});

await run("5. Windows spool JobId parsed from StartDocPrinter diagnostic JSON", () => {
  const parsed = parseDiagStdout(
    'noise\n{"ok":true,"windowsSpoolJobId":12345,"bytesWritten":4490,"openPrinterMs":2,"startDocMs":1,"writePrinterMs":3,"endDocMs":1}\n'
  );
  assert.strictEqual(parsed.windowsSpoolJobId, 12345);
  assert.strictEqual(parsed.bytesWritten, 4490);
});

await run("6. Failure to obtain spool JobId does not mark job successful by itself", () => {
  const r = classifyPrintResult({
    wrote: true,
    drained: false,
    timeout: true,
    printerReadyAfterWrite: true,
  });
  assert.strictEqual(r.status, "UNCERTAIN");
  assert.strictEqual(r.printedQty, 0);
  const summary = buildPrintTimingSummary({
    jobId: "x",
    windowsSpoolJobId: null,
    windowsSpoolJobIdCaptured: false,
    finalStatus: "UNCERTAIN",
    printedQty: 0,
  });
  assert.strictEqual(summary.windowsSpoolJobId, null);
  assert.strictEqual(summary.finalStatus, "UNCERTAIN");
});

await run("7. waitForQueueDrain onProbe fires without changing drain outcome", async () => {
  const probes = [];
  let n = 0;
  const out = await waitForQueueDrain({
    timeoutMs: 200,
    pollMs: 0,
    baselineQueueLength: 0,
    sleepFn: async () => {},
    jobId: "j1",
    documentName: "Marivolt LBL1",
    getHealth: async () => {
      n += 1;
      return { status: "READY", queueLength: n === 1 ? 1 : 0 };
    },
    onProbe: (obs) => probes.push(obs),
  });
  assert.strictEqual(out.drained, true);
  assert.ok(probes.length >= 1);
  assert.strictEqual(probes[0].jobId, "j1");
  assert.strictEqual(probes[0].documentName, "Marivolt LBL1");
});

console.log(`\nPrint timing diagnostics: ${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
