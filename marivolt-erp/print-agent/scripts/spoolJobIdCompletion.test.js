/**
 * Windows spool JobId completion state machine + jobProcessor wiring (1.5.0).
 */
import assert from "assert";
import {
  classifySpoolJobResult,
  createPrinterFifo,
  waitForSpoolJobCompletion,
  SPOOL_JOB_QUERY_FAIL_LIMIT,
} from "../src/printSafety.js";
import { SPOOL_JOB_STATES, mapWindowsJobStatusText, isWindowsSpoolJobAbsentMessage } from "../src/windowsPrintJobStatus.js";
import { createJobProcessor } from "../src/jobProcessor.js";
import {
  assertNoSensitiveTimingPayload,
  formatPrintTimingSummaryLine,
} from "../src/printTiming.js";

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

function baseJob(overrides = {}) {
  return {
    id: "job-1",
    jobNo: "LBL-JOB1",
    leaseToken: "tok",
    windowsPrinterName: "RP4xx Series 200DPI TSPL",
    requestedLabels: 1,
    sourceType: "CUSTOM_PACKING",
    tsplPayload: "SIZE 100 mm,50 mm\r\nTEXT 10,10,\"3\",0,1,1,\"PART-A\"\r\nPRINT 1,1\r\n",
    ...overrides,
  };
}

function makeProcessor({
  jobs,
  printRaw,
  getWindowsPrintJobStatus,
  getPrinterHealth,
  getPrinterHealthLightweight,
  drainTimeoutMs = 200,
  drainPollMs = 0,
  log = () => {},
  diagLog = null,
} = {}) {
  const queue = [...(jobs || [])];
  const results = [];
  const writes = [];
  const summaries = [];
  const statusCalls = [];
  const processor = createJobProcessor({
    drainTimeoutMs,
    drainPollMs,
    sleepFn: async () => {},
    log: (msg, meta) => {
      log(msg, meta);
      if (meta?.event === "PRINT_TIMING_SUMMARY" || String(msg).includes("PRINT_TIMING_SUMMARY")) {
        summaries.push(String(msg));
      }
    },
    diagLog,
    getPrinterHealth:
      getPrinterHealth ||
      (async () => ({ status: "READY", queueLength: 0, name: "RP4xx Series 200DPI TSPL" })),
    getPrinterHealthLightweight:
      getPrinterHealthLightweight ||
      (async () => ({ status: "READY", queueLength: 0, name: "RP4xx Series 200DPI TSPL" })),
    getWindowsPrintJobStatus: async (printer, id) => {
      statusCalls.push({ printer, id });
      return getWindowsPrintJobStatus(printer, id);
    },
    leaseNext: async () => queue.shift() || null,
    releaseLease: async () => {},
    markPrinting: async () => {},
    reportResult: async (job, outcome) => {
      results.push({ jobNo: job.jobNo, ...outcome });
    },
    printRaw: async (buf, printerName, opts) => {
      const out = await printRaw(buf, printerName, opts);
      writes.push({
        printerName,
        documentName: opts?.documentName,
        bytes: buf.length,
        payload: buf.toString("utf8"),
        writeCount: 1,
      });
      return out;
    },
  });
  return { processor, results, writes, summaries, statusCalls, remaining: queue };
}

function okRaw(jobId, bytes) {
  return {
    ok: true,
    windowsSpoolJobId: jobId,
    timing: {
      totalMs: 5,
      bytesWritten: bytes,
      bytesRequested: bytes,
      windowsSpoolJobId: jobId,
      windowsSpoolJobIdCaptured: true,
    },
  };
}

console.log("\nSpool JobId completion (1.5.0)\n");

await run("1. mapWindowsJobStatusText covers queued/printing/error/paused", () => {
  assert.strictEqual(mapWindowsJobStatusText("Normal"), SPOOL_JOB_STATES.QUEUED);
  assert.strictEqual(mapWindowsJobStatusText("Printing"), SPOOL_JOB_STATES.PRINTING);
  assert.strictEqual(mapWindowsJobStatusText("Error"), SPOOL_JOB_STATES.ERROR);
  assert.strictEqual(mapWindowsJobStatusText("Paused"), SPOOL_JOB_STATES.PAUSED);
});

await run("2. StartDocPrinter JobId + full Write + EndDoc → capture path COMPLETED", async () => {
  const job = baseJob({ requestedLabels: 1 });
  const bytes = Buffer.byteLength(job.tsplPayload, "utf8");
  let n = 0;
  const h2 = makeProcessor({
    jobs: [job],
    printRaw: async () => okRaw(98, bytes),
    getWindowsPrintJobStatus: async () => {
      n += 1;
      if (n === 1) return { ok: true, present: true, state: SPOOL_JOB_STATES.QUEUED };
      return { ok: true, present: false, state: SPOOL_JOB_STATES.ABSENT };
    },
  });
  await h2.processor.processOne();
  assert.strictEqual(h2.results[0].status, "COMPLETED");
  assert.strictEqual(h2.results[0].printedQty, 1);
  assert.ok(h2.statusCalls.every((c) => c.id === 98));
});

await run("3. Specific JobId queued → disappears → COMPLETED", async () => {
  let n = 0;
  const out = await waitForSpoolJobCompletion({
    timeoutMs: 200,
    pollMs: 0,
    windowsSpoolJobId: 99,
    sleepFn: async () => {},
    getJobStatus: async () => {
      n += 1;
      if (n <= 2) return { ok: true, present: true, state: SPOOL_JOB_STATES.PRINTING };
      return { ok: true, present: false, state: SPOOL_JOB_STATES.ABSENT };
    },
  });
  assert.strictEqual(out.completed, true);
  assert.strictEqual(out.seenPresent, true);
  assert.strictEqual(out.fastAbsent, false);
  const cls = classifySpoolJobResult({
    wrote: true,
    bytesRequested: 100,
    bytesWritten: 100,
    windowsSpoolJobId: 99,
    jobIdCaptured: true,
    spoolOutcome: out,
  });
  assert.strictEqual(cls.status, "COMPLETED");
});

await run("4. JobId already absent on first observation after successful RAW → COMPLETED", async () => {
  const out = await waitForSpoolJobCompletion({
    timeoutMs: 200,
    pollMs: 0,
    windowsSpoolJobId: 99,
    sleepFn: async () => {},
    getJobStatus: async () => ({ ok: true, present: false, state: SPOOL_JOB_STATES.ABSENT }),
  });
  assert.strictEqual(out.completed, true);
  assert.strictEqual(out.seenPresent, false);
  assert.strictEqual(out.fastAbsent, true);
  const cls = classifySpoolJobResult({
    wrote: true,
    bytesRequested: 4622,
    bytesWritten: 4622,
    windowsSpoolJobId: 99,
    jobIdCaptured: true,
    spoolOutcome: out,
  });
  assert.strictEqual(cls.status, "COMPLETED");
});

await run("5. Specific JobId remains stuck → UNCERTAIN", async () => {
  const out = await waitForSpoolJobCompletion({
    timeoutMs: 30,
    pollMs: 0,
    windowsSpoolJobId: 77,
    sleepFn: async () => {},
    getJobStatus: async () => ({ ok: true, present: true, state: SPOOL_JOB_STATES.QUEUED }),
  });
  assert.strictEqual(out.completed, false);
  assert.strictEqual(out.timeout, true);
  const cls = classifySpoolJobResult({
    wrote: true,
    bytesRequested: 10,
    bytesWritten: 10,
    windowsSpoolJobId: 77,
    jobIdCaptured: true,
    spoolOutcome: out,
  });
  assert.strictEqual(cls.status, "UNCERTAIN");
  assert.match(cls.error, /still present|timeout/i);
});

await run("6. Specific JobId reports ERROR → UNCERTAIN", async () => {
  const out = await waitForSpoolJobCompletion({
    timeoutMs: 200,
    pollMs: 0,
    windowsSpoolJobId: 55,
    sleepFn: async () => {},
    getJobStatus: async () => ({ ok: true, present: true, state: SPOOL_JOB_STATES.ERROR }),
  });
  assert.strictEqual(out.completed, false);
  const cls = classifySpoolJobResult({
    wrote: true,
    bytesRequested: 10,
    bytesWritten: 10,
    windowsSpoolJobId: 55,
    jobIdCaptured: true,
    spoolOutcome: out,
  });
  assert.strictEqual(cls.status, "UNCERTAIN");
  assert.match(cls.error, /ERROR/);
});

await run("7. Status-query failures → UNCERTAIN after fail limit", async () => {
  let n = 0;
  const out = await waitForSpoolJobCompletion({
    timeoutMs: 500,
    pollMs: 0,
    queryFailLimit: SPOOL_JOB_QUERY_FAIL_LIMIT,
    windowsSpoolJobId: 44,
    sleepFn: async () => {},
    getJobStatus: async () => {
      n += 1;
      return { ok: false, present: false, state: SPOOL_JOB_STATES.QUERY_FAILED, error: "boom" };
    },
  });
  assert.strictEqual(out.completed, false);
  assert.ok(n >= SPOOL_JOB_QUERY_FAIL_LIMIT);
  const cls = classifySpoolJobResult({
    wrote: true,
    bytesRequested: 10,
    bytesWritten: 10,
    windowsSpoolJobId: 44,
    jobIdCaptured: true,
    spoolOutcome: out,
  });
  assert.strictEqual(cls.status, "UNCERTAIN");
  assert.match(cls.error, /query failed/i);
});

await run("8. Partial WritePrinter → UNCERTAIN (not COMPLETED)", async () => {
  const job = baseJob();
  const bytes = Buffer.byteLength(job.tsplPayload, "utf8");
  const h = makeProcessor({
    jobs: [job],
    printRaw: async () => ({
      ok: true,
      windowsSpoolJobId: 11,
      timing: {
        totalMs: 3,
        bytesWritten: Math.max(1, bytes - 10),
        windowsSpoolJobId: 11,
        windowsSpoolJobIdCaptured: true,
      },
    }),
    getWindowsPrintJobStatus: async () => ({
      ok: true,
      present: false,
      state: SPOOL_JOB_STATES.ABSENT,
    }),
  });
  await h.processor.processOne();
  assert.strictEqual(h.results[0].status, "UNCERTAIN");
  assert.match(h.results[0].error, /Partial WritePrinter/i);
  assert.strictEqual(h.statusCalls.length, 0);
});

await run("9. EndDoc / WritePrinter hard failure → FAILED (not COMPLETED)", async () => {
  const h = makeProcessor({
    jobs: [baseJob()],
    printRaw: async () => {
      const err = new Error("EndDocPrinter failed for RP4xx");
      err.timing = { totalMs: 4, windowsSpoolJobId: 12, bytesWritten: 0 };
      throw err;
    },
    getWindowsPrintJobStatus: async () => ({
      ok: true,
      present: false,
      state: SPOOL_JOB_STATES.ABSENT,
    }),
  });
  await h.processor.processOne();
  assert.strictEqual(h.results[0].status, "FAILED");
  assert.ok(!/COMPLETED/.test(h.results[0].status));
});

await run("10. No automatic retry after UNCERTAIN submission", async () => {
  let leases = 0;
  let reports = 0;
  const processor = createJobProcessor({
    drainTimeoutMs: 40,
    drainPollMs: 0,
    sleepFn: async () => {},
    getPrinterHealth: async () => ({ status: "READY", queueLength: 0, name: "P" }),
    getPrinterHealthLightweight: async () => ({ status: "READY", queueLength: 0, name: "P" }),
    getWindowsPrintJobStatus: async () => ({
      ok: true,
      present: true,
      state: SPOOL_JOB_STATES.QUEUED,
    }),
    leaseNext: async () => {
      leases += 1;
      if (leases > 1) return null;
      return baseJob({ windowsPrinterName: "P" });
    },
    releaseLease: async () => {},
    markPrinting: async () => {},
    reportResult: async () => {
      reports += 1;
    },
    printRaw: async (buf) => okRaw(33, buf.length),
  });
  await processor.processOne();
  const again = await processor.processOne();
  assert.strictEqual(reports, 1);
  assert.strictEqual(again, false);
});

await run("11. Job B in same printer queue does not prevent Job A completion", async () => {
  // Monitor only JobId 100; other jobs remaining in the Windows queue are irrelevant
  const out = await waitForSpoolJobCompletion({
    timeoutMs: 200,
    pollMs: 0,
    windowsSpoolJobId: 100,
    sleepFn: async () => {},
    getJobStatus: async () => ({ ok: true, present: false, state: SPOOL_JOB_STATES.ABSENT }),
  });
  assert.strictEqual(out.completed, true);
  const cls = classifySpoolJobResult({
    wrote: true,
    bytesRequested: 50,
    bytesWritten: 50,
    windowsSpoolJobId: 100,
    jobIdCaptured: true,
    spoolOutcome: out,
  });
  assert.strictEqual(cls.status, "COMPLETED");
});

await run("12. Two ERP jobs remain serialized for same physical printer", async () => {
  const fifo = createPrinterFifo();
  const order = [];
  await Promise.all([
    fifo.run("SamePrinter", async () => {
      order.push("A-start");
      await new Promise((r) => setTimeout(r, 20));
      order.push("A-end");
    }),
    fifo.run("SamePrinter", async () => {
      order.push("B-start");
      order.push("B-end");
    }),
  ]);
  assert.deepStrictEqual(order, ["A-start", "A-end", "B-start", "B-end"]);
});

await run("13. Six-label batch remains one WritePrinter call", async () => {
  const payload =
    "SIZE 100 mm,50 mm\r\n" +
    Array.from({ length: 6 }, (_, i) => `TEXT 10,10,\"3\",0,1,1,\"L${i}\"\r\nPRINT 1,1\r\n`).join("");
  const job = baseJob({ requestedLabels: 6, tsplPayload: payload });
  const bytes = Buffer.byteLength(payload, "utf8");
  let writeCalls = 0;
  const h = makeProcessor({
    jobs: [job],
    printRaw: async (buf) => {
      writeCalls += 1;
      return okRaw(99, buf.length);
    },
    getWindowsPrintJobStatus: async () => ({
      ok: true,
      present: false,
      state: SPOOL_JOB_STATES.ABSENT,
    }),
  });
  await h.processor.processOne();
  assert.strictEqual(writeCalls, 1);
  assert.strictEqual(h.writes.length, 1);
  assert.strictEqual(h.writes[0].bytes, bytes);
  assert.strictEqual(h.results[0].status, "COMPLETED");
  assert.strictEqual(h.results[0].printedQty, 6);
});

await run("14. Fallback when Windows JobId cannot be captured remains safe (JobCount drain)", async () => {
  let phase = "idle";
  const job = baseJob();
  const bytes = Buffer.byteLength(job.tsplPayload, "utf8");
  const h = makeProcessor({
    jobs: [job],
    printRaw: async () => {
      phase = "queued";
      return { ok: true, timing: { totalMs: 2, windowsSpoolJobId: null, bytesWritten: bytes } };
    },
    getWindowsPrintJobStatus: async () => {
      throw new Error("should not be called without JobId");
    },
    getPrinterHealthLightweight: async () => {
      if (phase === "queued") {
        phase = "idle";
        return { status: "READY", queueLength: 1, name: "RP4xx Series 200DPI TSPL" };
      }
      return { status: "READY", queueLength: 0, name: "RP4xx Series 200DPI TSPL" };
    },
  });
  await h.processor.processOne();
  assert.strictEqual(h.results[0].status, "COMPLETED");
  assert.strictEqual(h.statusCalls.length, 0);
});

await run("15. classifySpoolJobResult: missing JobId → UNCERTAIN", () => {
  const r = classifySpoolJobResult({
    wrote: true,
    bytesRequested: 10,
    bytesWritten: 10,
    windowsSpoolJobId: null,
    jobIdCaptured: false,
    spoolOutcome: { completed: true },
  });
  assert.strictEqual(r.status, "UNCERTAIN");
});

await run("16. Pre-send uses lightweight path (not full health) when provided", async () => {
  let full = 0;
  let light = 0;
  const job = baseJob();
  const bytes = Buffer.byteLength(job.tsplPayload, "utf8");
  const processor = createJobProcessor({
    drainTimeoutMs: 200,
    drainPollMs: 0,
    sleepFn: async () => {},
    getPrinterHealth: async () => {
      full += 1;
      return { status: "READY", queueLength: 0, name: "P" };
    },
    getPrinterHealthLightweight: async () => {
      light += 1;
      return { status: "READY", queueLength: 0, name: "P" };
    },
    getWindowsPrintJobStatus: async () => ({
      ok: true,
      present: false,
      state: SPOOL_JOB_STATES.ABSENT,
    }),
    leaseNext: async () => ({ ...job, windowsPrinterName: "P" }),
    releaseLease: async () => {},
    markPrinting: async () => {},
    reportResult: async () => {},
    printRaw: async (buf) => okRaw(1, buf.length),
  });
  await processor.processOne();
  assert.strictEqual(full, 1, "lease eligibility uses full/cached health once");
  assert.ok(light >= 1, "pre-send uses lightweight readiness");
});

await run("17. Timing summary available without TSPL / customer contents", async () => {
  const job = baseJob({
    tsplPayload:
      'SIZE 100 mm,50 mm\r\nTEXT 10,10,"3",0,1,1,"SECRET CUSTOMER ACME"\r\nPRINT 1,1\r\n',
  });
  const bytes = Buffer.byteLength(job.tsplPayload, "utf8");
  const h = makeProcessor({
    jobs: [job],
    printRaw: async () => okRaw(7, bytes),
    getWindowsPrintJobStatus: async () => ({
      ok: true,
      present: false,
      state: SPOOL_JOB_STATES.ABSENT,
    }),
  });
  await h.processor.processOne();
  assert.ok(h.summaries.length >= 1);
  const line = h.summaries[0];
  assert.match(line, /PRINT_TIMING_SUMMARY/);
  assert.match(line, /windowsSpoolJobId=7/);
  assert.doesNotMatch(line, /SECRET CUSTOMER/);
  assert.doesNotMatch(line, /SIZE 100/);
  assertNoSensitiveTimingPayload(line);
  assert.doesNotMatch(formatPrintTimingSummaryLine({ finalReason: "ok", payloadBytes: 1 }), /SIZE/);
});

await run("18. PAUSED spool job → UNCERTAIN", async () => {
  const out = await waitForSpoolJobCompletion({
    timeoutMs: 200,
    pollMs: 0,
    windowsSpoolJobId: 9,
    sleepFn: async () => {},
    getJobStatus: async () => ({ ok: true, present: true, state: SPOOL_JOB_STATES.PAUSED }),
  });
  assert.strictEqual(out.completed, false);
  assert.match(out.error, /PAUSED/);
});

await run("19. Live wording 'The specified job does not exist.' → ABSENT matcher", () => {
  assert.strictEqual(
    isWindowsSpoolJobAbsentMessage("The specified job does not exist."),
    true
  );
  assert.strictEqual(isWindowsSpoolJobAbsentMessage("the specified job does not exist"), true);
  assert.strictEqual(
    isWindowsSpoolJobAbsentMessage(
      "Get-PrintJob : The specified job does not exist. At line:1 char:1"
    ),
    true
  );
  assert.strictEqual(isWindowsSpoolJobAbsentMessage("does not exist"), true);
  assert.strictEqual(isWindowsSpoolJobAbsentMessage("Job not found"), true);
  assert.strictEqual(isWindowsSpoolJobAbsentMessage("ObjectNotFound: print job"), true);
  assert.strictEqual(isWindowsSpoolJobAbsentMessage("No print job was found"), true);
  assert.strictEqual(isWindowsSpoolJobAbsentMessage("cannot find the job"), true);
  // Genuine unrelated failures must NOT be ABSENT
  assert.strictEqual(isWindowsSpoolJobAbsentMessage("Access is denied"), false);
  assert.strictEqual(isWindowsSpoolJobAbsentMessage("The RPC server is unavailable"), false);
  assert.strictEqual(isWindowsSpoolJobAbsentMessage("Printer name is invalid"), false);
  assert.strictEqual(isWindowsSpoolJobAbsentMessage(""), false);
});

await run("20. Fast-USB: first status 'does not exist' → COMPLETED fastAbsent", async () => {
  const job = baseJob();
  const bytes = Buffer.byteLength(job.tsplPayload, "utf8");
  let probes = 0;
  const h = makeProcessor({
    jobs: [job],
    printRaw: async () => okRaw(100, bytes),
    getWindowsPrintJobStatus: async () => {
      probes += 1;
      // Simulate parser output after live Windows wording
      const absent = isWindowsSpoolJobAbsentMessage("The specified job does not exist.");
      assert.strictEqual(absent, true);
      return { ok: true, present: false, state: SPOOL_JOB_STATES.ABSENT };
    },
  });
  await h.processor.processOne();
  assert.strictEqual(h.results[0].status, "COMPLETED");
  assert.strictEqual(h.results[0].printedQty, 1);
  assert.strictEqual(probes, 1);
  assert.match(h.summaries[0], /finalStatus=COMPLETED/);
  assert.match(h.summaries[0], /windowsSpoolJobId=100/);
  assert.match(h.summaries[0], /drainProbeCount=1/);
});

await run("21. waitForSpoolJobCompletion: absent-on-first → fastAbsent COMPLETED", async () => {
  const out = await waitForSpoolJobCompletion({
    timeoutMs: 200,
    pollMs: 0,
    windowsSpoolJobId: 100,
    sleepFn: async () => {},
    getJobStatus: async () => {
      assert.ok(isWindowsSpoolJobAbsentMessage("The specified job does not exist."));
      return { ok: true, present: false, state: SPOOL_JOB_STATES.ABSENT };
    },
  });
  assert.strictEqual(out.completed, true);
  assert.strictEqual(out.fastAbsent, true);
  assert.strictEqual(out.probeCount, 1);
  const cls = classifySpoolJobResult({
    wrote: true,
    bytesRequested: 801,
    bytesWritten: 801,
    windowsSpoolJobId: 100,
    jobIdCaptured: true,
    spoolOutcome: out,
  });
  assert.strictEqual(cls.status, "COMPLETED");
});

console.log(`\nSpool JobId completion: ${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
