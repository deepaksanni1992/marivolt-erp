/**
 * TSPL_LABEL_BATCH Print Agent path — zero physical printing (mocked printRaw).
 */
import assert from "assert";
import {
  classifyLabelFaceBatchResult,
  validateLabelFaceBatchInput,
  faceDocumentName,
  GAPDETECT_TSPL,
} from "../src/adapters/rawFaceBatch.js";
import { createPrinterFifo } from "../src/printSafety.js";
import { createJobProcessor } from "../src/jobProcessor.js";
import { SPOOL_JOB_STATES } from "../src/windowsPrintJobStatus.js";

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

function facePayload(tag) {
  // Detected-media face: SIZE retained for 100×50 coords; no GAP after GAPDETECT.
  return `SIZE 100 mm,50 mm\r\nDIRECTION 1\r\nREFERENCE 0,0\r\nCLS\r\nTEXT 10,330,"0",0,2,2,"QTY ${tag}"\r\nPRINT 1,1\r\n`;
}

function batchJob(n = 6, overrides = {}) {
  const rawFacePayloads = Array.from({ length: n }, (_, i) => facePayload(`P0${i + 1}`));
  return {
    id: "job-rfb",
    jobNo: "LBL-RFB",
    leaseToken: "tok",
    windowsPrinterName: "RP4xx Series 200DPI TSPL",
    requestedLabels: n,
    payloadMode: "TSPL_LABEL_BATCH",
    rawFacePayloads,
    sourceType: "CUSTOM_PACKING",
    ...overrides,
  };
}

function isGapDetectPayload(text) {
  return String(text || "").replace(/\s+/g, "").toUpperCase() === "GAPDETECT";
}

async function main() {
  await run("validate: face count must match requestedLabels", () => {
    const bad = validateLabelFaceBatchInput({
      faces: [facePayload("P01")],
      requestedLabels: 6,
    });
    assert.equal(bad.ok, false);
  });

  await run("classify: 0 faces submitted → FAILED printedQty=0", () => {
    const r = classifyLabelFaceBatchResult({
      requestedLabels: 6,
      submittedFaceCount: 0,
      submitError: "boom",
    });
    assert.equal(r.status, "FAILED");
    assert.equal(r.printedQty, 0);
  });

  await run("classify: partial submit → UNCERTAIN printedQty=0", () => {
    const r = classifyLabelFaceBatchResult({
      requestedLabels: 6,
      submittedFaceCount: 3,
      windowsSpoolJobIds: [1, 2, 3],
      submitError: "face 4 failed",
    });
    assert.equal(r.status, "UNCERTAIN");
    assert.equal(r.printedQty, 0);
    assert.equal(r.submittedFaceCount, 3);
  });

  await run("classify: all submitted + drained → COMPLETED", () => {
    const r = classifyLabelFaceBatchResult({
      requestedLabels: 6,
      submittedFaceCount: 6,
      windowsSpoolJobIds: [10, 11, 12, 13, 14, 15],
      drained: true,
    });
    assert.equal(r.status, "COMPLETED");
    assert.equal(r.printedQty, 6);
    assert.deepEqual(r.windowsSpoolJobIds, [10, 11, 12, 13, 14, 15]);
  });

  await run("1 packing label => GAPDETECT once + 1 face RAW document", async () => {
    const job = batchJob(1);
    let rawCalls = 0;
    let gdiCalls = 0;
    const payloads = [];
    const results = [];
    const processor = createJobProcessor({
      getPrinterHealth: async () => ({ status: "READY", name: job.windowsPrinterName, queueLength: 0 }),
      getPrinterHealthLightweight: async () => ({
        status: "READY",
        name: job.windowsPrinterName,
        queueLength: 0,
      }),
      getWindowsPrintJobStatus: async () => ({ ok: true, state: SPOOL_JOB_STATES.ABSENT, present: false }),
      leaseNext: async () => job,
      releaseLease: async () => {},
      markPrinting: async () => {},
      reportResult: async (_j, outcome) => {
        results.push(outcome);
      },
      printRaw: async (buf) => {
        rawCalls += 1;
        payloads.push(buf.toString("utf8"));
        return {
          ok: true,
          windowsSpoolJobId: 100 + rawCalls,
          timing: { windowsSpoolJobId: 100 + rawCalls, bytesWritten: buf.length },
        };
      },
      printDriverPages: async () => {
        gdiCalls += 1;
        throw new Error("GDI must not be called");
      },
      fifo: createPrinterFifo(),
    });
    await processor.processOne();
    assert.equal(rawCalls, 2);
    assert.equal(gdiCalls, 0);
    assert.ok(isGapDetectPayload(payloads[0]));
    assert.ok(payloads[1].includes("PRINT 1,1"));
    assert.equal(results[0].status, "COMPLETED");
    assert.equal(results[0].printedQty, 1);
    assert.equal(results[0].submittedFaceCount, 1);
  });

  await run("6 packing labels => exactly one GAPDETECT before face 1; six PRINT 1,1; one lease", async () => {
    const job = batchJob(6);
    let leaseCount = 0;
    let healthCalls = 0;
    let lightweightCalls = 0;
    let rawCalls = 0;
    let gdiCalls = 0;
    const payloads = [];
    const results = [];
    let fifoHeldDuringBatch = true;
    let inFifo = false;

    const fifo = createPrinterFifo();
    const origRun = fifo.run.bind(fifo);
    fifo.run = async (printer, fn) =>
      origRun(printer, async () => {
        inFifo = true;
        try {
          return await fn();
        } finally {
          inFifo = false;
        }
      });

    const processor = createJobProcessor({
      getPrinterHealth: async () => {
        healthCalls += 1;
        return { status: "READY", name: job.windowsPrinterName, queueLength: 0 };
      },
      getPrinterHealthLightweight: async () => {
        lightweightCalls += 1;
        return { status: "READY", name: job.windowsPrinterName, queueLength: 0 };
      },
      getWindowsPrintJobStatus: async () => ({ ok: true, state: SPOOL_JOB_STATES.ABSENT, present: false }),
      leaseNext: async () => {
        leaseCount += 1;
        return job;
      },
      releaseLease: async () => {},
      markPrinting: async () => {},
      reportResult: async (_j, outcome) => {
        results.push(outcome);
      },
      printRaw: async (buf) => {
        if (!inFifo) fifoHeldDuringBatch = false;
        rawCalls += 1;
        payloads.push(buf.toString("utf8"));
        return {
          ok: true,
          windowsSpoolJobId: 200 + rawCalls,
          timing: { windowsSpoolJobId: 200 + rawCalls, bytesWritten: buf.length },
        };
      },
      printDriverPages: async () => {
        gdiCalls += 1;
        throw new Error("GDI must not be called");
      },
      fifo,
    });

    const lightweightBefore = lightweightCalls;
    await processor.processOne();

    assert.equal(leaseCount, 1, "one lease for six labels");
    assert.equal(rawCalls, 7, "1 GAPDETECT + 6 faces");
    assert.equal(gdiCalls, 0, "no GDI path invoked");
    assert.equal(payloads.length, 7);
    assert.ok(isGapDetectPayload(payloads[0]), "GAPDETECT is first spool write");
    assert.equal(
      payloads.filter((p) => isGapDetectPayload(p)).length,
      1,
      "exactly one GAPDETECT"
    );
    for (let i = 1; i < 7; i++) {
      assert.ok(!isGapDetectPayload(payloads[i]), `no GAPDETECT between/after faces (i=${i})`);
      assert.ok(payloads[i].includes(`P0${i}`), "six distinct face contents preserved");
      assert.equal((payloads[i].match(/\bCLS\b/g) || []).length, 1);
      assert.equal((payloads[i].match(/\bPRINT\s+1\s*,\s*1\b/gi) || []).length, 1);
      assert.match(payloads[i], /TEXT \d+,330,"0",0,2,2,/);
      assert.match(payloads[i], /\bSIZE\b/i);
      // SIZE kept for imaging coords after GAPDETECT; GAP must not reappear.
      assert.doesNotMatch(payloads[i], /(?:^|\r?\n)\s*GAP\b/i);
    }
    assert.equal(results[0].status, "COMPLETED");
    assert.equal(results[0].printedQty, 6);
    assert.equal(results[0].submittedFaceCount, 6);
    assert.equal(results[0].windowsSpoolJobIds.length, 6);
    assert.ok(fifoHeldDuringBatch, "FIFO held for entire batch");
    assert.equal(healthCalls, 1);
    assert.equal(lightweightCalls, lightweightBefore + 1);
    assert.equal(GAPDETECT_TSPL.trim(), "GAPDETECT");
  });

  await run("GAPDETECT does not occur between faces", async () => {
    const job = batchJob(3);
    const payloads = [];
    const processor = createJobProcessor({
      getPrinterHealth: async () => ({ status: "READY", name: job.windowsPrinterName, queueLength: 0 }),
      getPrinterHealthLightweight: async () => ({
        status: "READY",
        name: job.windowsPrinterName,
        queueLength: 0,
      }),
      getWindowsPrintJobStatus: async () => ({ ok: true, state: SPOOL_JOB_STATES.ABSENT, present: false }),
      leaseNext: async () => job,
      releaseLease: async () => {},
      markPrinting: async () => {},
      reportResult: async () => {},
      printRaw: async (buf) => {
        payloads.push(buf.toString("utf8"));
        return {
          ok: true,
          windowsSpoolJobId: 50 + payloads.length,
          timing: { windowsSpoolJobId: 50 + payloads.length, bytesWritten: buf.length },
        };
      },
      fifo: createPrinterFifo(),
    });
    await processor.processOne();
    assert.equal(payloads.length, 4);
    assert.ok(isGapDetectPayload(payloads[0]));
    assert.deepEqual(
      payloads.slice(1).map((p) => isGapDetectPayload(p)),
      [false, false, false]
    );
  });

  await run("no health calls between faces", async () => {
    const job = batchJob(3);
    let lightweightAtEachFace = [];
    let lightweightCalls = 0;
    const processor = createJobProcessor({
      getPrinterHealth: async () => ({ status: "READY", name: job.windowsPrinterName, queueLength: 0 }),
      getPrinterHealthLightweight: async () => {
        lightweightCalls += 1;
        return { status: "READY", name: job.windowsPrinterName, queueLength: 0 };
      },
      getWindowsPrintJobStatus: async () => ({ ok: true, state: SPOOL_JOB_STATES.ABSENT, present: false }),
      leaseNext: async () => job,
      releaseLease: async () => {},
      markPrinting: async () => {},
      reportResult: async () => {},
      printRaw: async (buf) => {
        if (!isGapDetectPayload(buf.toString("utf8"))) {
          lightweightAtEachFace.push(lightweightCalls);
        }
        return {
          ok: true,
          windowsSpoolJobId: 50 + lightweightAtEachFace.length + 1,
          timing: {
            windowsSpoolJobId: 50 + lightweightAtEachFace.length + 1,
            bytesWritten: buf.length,
          },
        };
      },
      fifo: createPrinterFifo(),
    });
    await processor.processOne();
    assert.deepEqual(lightweightAtEachFace, [1, 1, 1], "presend once; unchanged across faces");
  });

  await run("partial face failure after GAPDETECT => UNCERTAIN / printedQty 0", async () => {
    const job = batchJob(6);
    let rawCalls = 0;
    const results = [];
    const processor = createJobProcessor({
      getPrinterHealth: async () => ({ status: "READY", name: job.windowsPrinterName, queueLength: 0 }),
      getPrinterHealthLightweight: async () => ({
        status: "READY",
        name: job.windowsPrinterName,
        queueLength: 0,
      }),
      getWindowsPrintJobStatus: async () => ({ ok: true, state: SPOOL_JOB_STATES.ABSENT, present: false }),
      leaseNext: async () => job,
      releaseLease: async () => {},
      markPrinting: async () => {},
      reportResult: async (_j, outcome) => {
        results.push(outcome);
      },
      printRaw: async (buf) => {
        rawCalls += 1;
        // call 1 = GAPDETECT; calls 2.. = faces; fail on face 3 (rawCalls === 4)
        if (rawCalls === 4) throw new Error("simulated face 3 failure");
        return {
          ok: true,
          windowsSpoolJobId: 300 + rawCalls,
          timing: { windowsSpoolJobId: 300 + rawCalls, bytesWritten: buf.length },
        };
      },
      fifo: createPrinterFifo(),
    });
    await processor.processOne();
    assert.equal(rawCalls, 4);
    assert.equal(results[0].status, "UNCERTAIN");
    assert.equal(results[0].printedQty, 0);
    assert.equal(results[0].submittedFaceCount, 2);
  });

  await run("GAPDETECT failure => FAILED and no face writes", async () => {
    const job = batchJob(6);
    let rawCalls = 0;
    const payloads = [];
    const results = [];
    const processor = createJobProcessor({
      getPrinterHealth: async () => ({ status: "READY", name: job.windowsPrinterName, queueLength: 0 }),
      getPrinterHealthLightweight: async () => ({
        status: "READY",
        name: job.windowsPrinterName,
        queueLength: 0,
      }),
      getWindowsPrintJobStatus: async () => ({ ok: true, state: SPOOL_JOB_STATES.ABSENT, present: false }),
      leaseNext: async () => job,
      releaseLease: async () => {},
      markPrinting: async () => {},
      reportResult: async (_j, outcome) => {
        results.push(outcome);
      },
      printRaw: async (buf) => {
        rawCalls += 1;
        payloads.push(buf.toString("utf8"));
        return { ok: false, error: "simulated GAPDETECT spool failure" };
      },
      fifo: createPrinterFifo(),
    });
    await processor.processOne();
    assert.equal(rawCalls, 1);
    assert.equal(payloads.length, 1);
    assert.ok(isGapDetectPayload(payloads[0]));
    assert.equal(results[0].status, "FAILED");
    assert.equal(results[0].printedQty, 0);
    assert.equal(results[0].submittedFaceCount, 0);
    assert.match(String(results[0].error || ""), /GAPDETECT|gap_detect/i);
  });

  await run("legacy GRN SINGLE_RAW path still uses printRaw once (no GAPDETECT)", async () => {
    const job = {
      id: "job-grn",
      jobNo: "LBL-GRN",
      leaseToken: "tok",
      windowsPrinterName: "RP4xx Series 200DPI TSPL",
      requestedLabels: 1,
      payloadMode: "SINGLE_RAW",
      tsplPayload: 'SIZE 100 mm,50 mm\r\nCLS\r\nPRINT 1,1\r\n',
      sourceType: "GRN",
    };
    let rawCalls = 0;
    let gdiCalls = 0;
    const payloads = [];
    const results = [];
    const processor = createJobProcessor({
      getPrinterHealth: async () => ({ status: "READY", name: job.windowsPrinterName, queueLength: 0 }),
      getPrinterHealthLightweight: async () => ({
        status: "READY",
        name: job.windowsPrinterName,
        queueLength: 0,
      }),
      getWindowsPrintJobStatus: async () => ({ ok: true, state: SPOOL_JOB_STATES.ABSENT, present: false }),
      leaseNext: async () => job,
      releaseLease: async () => {},
      markPrinting: async () => {},
      reportResult: async (_j, outcome) => {
        results.push(outcome);
      },
      printRaw: async (buf) => {
        rawCalls += 1;
        payloads.push(buf.toString("utf8"));
        return {
          ok: true,
          windowsSpoolJobId: 999,
          timing: { windowsSpoolJobId: 999, bytesWritten: buf.length },
        };
      },
      printDriverPages: async () => {
        gdiCalls += 1;
      },
      fifo: createPrinterFifo(),
    });
    await processor.processOne();
    assert.equal(rawCalls, 1);
    assert.equal(gdiCalls, 0);
    assert.equal(payloads.filter((p) => isGapDetectPayload(p)).length, 0);
    assert.equal(results[0].status, "COMPLETED");
    assert.ok(faceDocumentName("LBL", 0).includes("F1"));
  });

  await run("legacy RAW_FACE_BATCH does not issue GAPDETECT", async () => {
    const faces = Array.from({ length: 2 }, (_, i) => `CLS\r\nTEXT 10,10,"0",0,1,1,"L${i}"\r\nPRINT 1,1\r\n`);
    const job = batchJob(2, {
      payloadMode: "RAW_FACE_BATCH",
      rawFacePayloads: faces,
      sourceType: "PACKING",
    });
    const payloads = [];
    const results = [];
    const processor = createJobProcessor({
      getPrinterHealth: async () => ({ status: "READY", name: job.windowsPrinterName, queueLength: 0 }),
      getPrinterHealthLightweight: async () => ({
        status: "READY",
        name: job.windowsPrinterName,
        queueLength: 0,
      }),
      getWindowsPrintJobStatus: async () => ({ ok: true, state: SPOOL_JOB_STATES.ABSENT, present: false }),
      leaseNext: async () => job,
      releaseLease: async () => {},
      markPrinting: async () => {},
      reportResult: async (_j, outcome) => {
        results.push(outcome);
      },
      printRaw: async (buf) => {
        payloads.push(buf.toString("utf8"));
        return {
          ok: true,
          windowsSpoolJobId: 700 + payloads.length,
          timing: { windowsSpoolJobId: 700 + payloads.length, bytesWritten: buf.length },
        };
      },
      fifo: createPrinterFifo(),
    });
    await processor.processOne();
    assert.equal(payloads.length, 2);
    assert.equal(payloads.filter((p) => isGapDetectPayload(p)).length, 0);
    assert.equal(results[0].status, "COMPLETED");
    assert.equal(results[0].submittedFaceCount, 2);
  });

  await run("FIFO: two TSPL_LABEL_BATCH jobs do not interleave RAW submits", async () => {
    const jobA = { ...batchJob(2), id: "a", jobNo: "JOBA" };
    const jobB = { ...batchJob(2), id: "b", jobNo: "JOBB" };
    const order = [];
    const queue = [jobA, jobB];
    const fifo = createPrinterFifo();
    const processor = createJobProcessor({
      getPrinterHealth: async () => ({ status: "READY", name: jobA.windowsPrinterName, queueLength: 0 }),
      getPrinterHealthLightweight: async () => ({
        status: "READY",
        name: jobA.windowsPrinterName,
        queueLength: 0,
      }),
      getWindowsPrintJobStatus: async () => ({ ok: true, state: SPOOL_JOB_STATES.ABSENT, present: false }),
      leaseNext: async () => queue.shift() || null,
      releaseLease: async () => {},
      markPrinting: async () => {},
      reportResult: async () => {},
      printRaw: async (buf, _p, opts) => {
        order.push(opts.documentName);
        await new Promise((r) => setTimeout(r, 15));
        const id = 400 + order.length;
        return {
          ok: true,
          windowsSpoolJobId: id,
          timing: { windowsSpoolJobId: id, bytesWritten: buf.length },
        };
      },
      fifo,
    });
    // Start both cycles overlapping so FIFO must serialize same-printer work.
    const p1 = processor.processOne();
    await new Promise((r) => setTimeout(r, 5));
    const p2 = processor.processOne();
    await Promise.all([p1, p2]);
    // Each job: GAPDETECT + 2 faces = 3 writes; total 6
    assert.equal(order.length, 6, `order=${JSON.stringify(order)}`);
    const aIdx = order.map((d, i) => (String(d).includes("JOBA") ? i : -1)).filter((i) => i >= 0);
    const bIdx = order.map((d, i) => (String(d).includes("JOBB") ? i : -1)).filter((i) => i >= 0);
    assert.equal(aIdx.length, 3);
    assert.equal(bIdx.length, 3);
    assert.ok(Math.max(...aIdx) < Math.min(...bIdx), `order=${JSON.stringify(order)}`);
    assert.ok(String(order[aIdx[0]]).includes("GAPDETECT"));
    assert.ok(String(order[bIdx[0]]).includes("GAPDETECT"));
  });

  console.log(`\nTSPL_LABEL_BATCH tests: ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main();
