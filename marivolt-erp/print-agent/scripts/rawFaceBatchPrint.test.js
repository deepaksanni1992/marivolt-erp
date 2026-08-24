/**
 * TSPL_LABEL_BATCH Print Agent path — zero physical printing (mocked printRaw).
 */
import assert from "assert";
import {
  classifyLabelFaceBatchResult,
  validateLabelFaceBatchInput,
  faceDocumentName,
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
  return `SIZE 100 mm,50 mm\r\nGAP 3 mm,0\r\nDIRECTION 1\r\nREFERENCE 0,0\r\nCLS\r\nTEXT 10,10,"0",0,1,1,"${tag}"\r\nPRINT 1,1\r\n`;
}

function batchJob(n = 6) {
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
  };
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

  await run("1 packing label => exactly 1 RAW document", async () => {
    const job = batchJob(1);
    let rawCalls = 0;
    let gdiCalls = 0;
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
        return { ok: true, windowsSpoolJobId: 100 + rawCalls, timing: { windowsSpoolJobId: 100 + rawCalls, bytesWritten: buf.length } };
      },
      printDriverPages: async () => {
        gdiCalls += 1;
        throw new Error("GDI must not be called");
      },
      fifo: createPrinterFifo(),
    });
    await processor.processOne();
    assert.equal(rawCalls, 1);
    assert.equal(gdiCalls, 0);
    assert.equal(results[0].status, "COMPLETED");
    assert.equal(results[0].printedQty, 1);
    assert.equal(results[0].submittedFaceCount, 1);
  });

  await run("6 packing labels => exactly 6 RAW documents; no GDI; one lease; FIFO held", async () => {
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
        if (rawCalls > 0 && rawCalls < 6 && inFifo) {
          // health between faces would bump this after first face while still in loop
        }
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
        // Capture health call count at each face submit — must stay 1 (presend only after lease)
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
    assert.equal(rawCalls, 6);
    assert.equal(gdiCalls, 0, "no GDI path invoked");
    assert.equal(payloads.length, 6);
    assert.equal(results[0].status, "COMPLETED");
    assert.equal(results[0].printedQty, 6);
    assert.equal(results[0].submittedFaceCount, 6);
    assert.equal(results[0].windowsSpoolJobIds.length, 6);
    assert.ok(fifoHeldDuringBatch, "FIFO held for entire batch");
    // One lease health + one pre-send lightweight; no health between faces
    assert.equal(healthCalls, 1);
    assert.equal(lightweightCalls, lightweightBefore + 1);
    for (let i = 0; i < 6; i++) {
      assert.ok(payloads[i].includes(`P0${i + 1}`), "six distinct face contents preserved");
      assert.equal((payloads[i].match(/\bCLS\b/g) || []).length, 1);
      assert.equal((payloads[i].match(/\bPRINT\s+1\s*,\s*1\b/gi) || []).length, 1);
    }
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
        lightweightAtEachFace.push(lightweightCalls);
        return {
          ok: true,
          windowsSpoolJobId: 50 + lightweightAtEachFace.length,
          timing: {
            windowsSpoolJobId: 50 + lightweightAtEachFace.length,
            bytesWritten: buf.length,
          },
        };
      },
      fifo: createPrinterFifo(),
    });
    await processor.processOne();
    assert.deepEqual(lightweightAtEachFace, [1, 1, 1], "presend once; unchanged across faces");
  });

  await run("partial failure => UNCERTAIN / printedQty 0", async () => {
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
        if (rawCalls === 3) throw new Error("simulated face 3 failure");
        return {
          ok: true,
          windowsSpoolJobId: 300 + rawCalls,
          timing: { windowsSpoolJobId: 300 + rawCalls, bytesWritten: buf.length },
        };
      },
      fifo: createPrinterFifo(),
    });
    await processor.processOne();
    assert.equal(rawCalls, 3);
    assert.equal(results[0].status, "UNCERTAIN");
    assert.equal(results[0].printedQty, 0);
    assert.equal(results[0].submittedFaceCount, 2);
  });

  await run("legacy GRN SINGLE_RAW path still uses printRaw once", async () => {
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
    assert.equal(results[0].status, "COMPLETED");
    assert.ok(faceDocumentName("LBL", 0).includes("F1"));
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
    assert.equal(order.length, 4, `order=${JSON.stringify(order)}`);
    const aIdx = order.map((d, i) => (String(d).includes("JOBA") ? i : -1)).filter((i) => i >= 0);
    const bIdx = order.map((d, i) => (String(d).includes("JOBB") ? i : -1)).filter((i) => i >= 0);
    assert.equal(aIdx.length, 2);
    assert.equal(bIdx.length, 2);
    assert.ok(Math.max(...aIdx) < Math.min(...bIdx), `order=${JSON.stringify(order)}`);
  });

  console.log(`\nTSPL_LABEL_BATCH tests: ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main();
