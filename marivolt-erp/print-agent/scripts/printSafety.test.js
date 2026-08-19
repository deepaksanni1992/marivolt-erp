/**
 * Print-agent hardening: READY gate, per-printer FIFO, spool drain, UNCERTAIN.
 */
import assert from "assert";
import fs from "fs";
import os from "os";
import path from "path";
import {
  acquireAgentProcessLock,
  classifyPrintResult,
  createPrinterFifo,
  isLeaseEligiblePrinterStatus,
  spoolDocumentName,
  waitForQueueDrain,
} from "../src/printSafety.js";
import { createJobProcessor } from "../src/jobProcessor.js";

let passed = 0;
let failed = 0;

function run(name, fn) {
  const p = Promise.resolve().then(fn);
  return p.then(
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

function ruJob(n, printer = "RP4xx Series 200DPI TSPL") {
  const ru = `MAR-RU-${String(n).padStart(6, "0")}`;
  const jobNo = `LBL-RU-${n}`;
  return {
    id: `job-${n}`,
    jobNo,
    leaseToken: `tok-${n}`,
    windowsPrinterName: printer,
    requestedLabels: 1,
    tsplPayload: `SIZE 100 mm,50 mm\r\nTEXT 10,10,\"3\",0,1,1,\"${ru}\"\r\nPRINT 1,1\r\n`,
  };
}

function makeHarness({ health, jobs, printRaw } = {}) {
  const leased = [];
  const results = [];
  const releases = [];
  const printing = [];
  const writes = [];
  const writeStarts = [];
  const queue = [...(jobs || [])];
  const processor = createJobProcessor({
    drainTimeoutMs: 200,
    drainPollMs: 0,
    sleepFn: async () => {},
    getPrinterHealth: async (name) => health(name),
    leaseNext: async () => {
      const job = queue.shift() || null;
      if (job) leased.push(job.jobNo);
      return job;
    },
    releaseLease: async (job) => {
      releases.push(job.jobNo);
    },
    markPrinting: async (job) => {
      printing.push(job.jobNo);
    },
    reportResult: async (job, outcome) => {
      results.push({ jobNo: job.jobNo, ...outcome });
    },
    printRaw: async (buf, printerName, opts) => {
      writeStarts.push({ jobNo: opts.documentName, t: Date.now() });
      const out = printRaw ? await printRaw(buf, printerName, opts) : { ok: true };
      writes.push({
        jobNo: opts.documentName,
        printerName,
        payload: buf.toString("utf8"),
      });
      return out;
    },
  });
  return { processor, leased, results, releases, printing, writes, writeStarts, remaining: queue };
}

async function drainAll(processor, max = 40) {
  for (let i = 0; i < max; i += 1) {
    const worked = await processor.processOne();
    if (!worked) break;
  }
}

console.log("\nPrint agent printSafety / jobProcessor\n");

await run("READY is the only lease-eligible status", () => {
  assert.strictEqual(isLeaseEligiblePrinterStatus("READY"), true);
  for (const s of ["OFFLINE", "DISCONNECTED", "PAUSED", "ERROR", "UNKNOWN", "PAPER_OUT", "DOOR_OPEN", "WORK OFFLINE"]) {
    assert.strictEqual(isLeaseEligiblePrinterStatus(s), false, s);
  }
});

await run("spool document name is unique per ERP jobNo", () => {
  assert.strictEqual(spoolDocumentName("LBL202608191400055D"), "Marivolt LBL202608191400055D");
  assert.notStrictEqual(spoolDocumentName("LBL-A"), spoolDocumentName("LBL-B"));
  assert.ok(!spoolDocumentName("LBL1").includes("Marivolt Label"));
});

await run("classify: write ok + drain + READY → COMPLETED", () => {
  const r = classifyPrintResult({
    wrote: true,
    drained: true,
    timeout: false,
    printerReadyAfterWrite: true,
  });
  assert.strictEqual(r.status, "COMPLETED");
});

await run("classify: disconnect after write → UNCERTAIN", () => {
  const r = classifyPrintResult({
    wrote: true,
    drained: false,
    timeout: false,
    printerReadyAfterWrite: false,
  });
  assert.strictEqual(r.status, "UNCERTAIN");
});

await run("classify: drain timeout → UNCERTAIN", () => {
  const r = classifyPrintResult({
    wrote: true,
    drained: false,
    timeout: true,
    printerReadyAfterWrite: true,
  });
  assert.strictEqual(r.status, "UNCERTAIN");
});

await run("waitForQueueDrain: elevated then empty while READY", async () => {
  let n = 0;
  const out = await waitForQueueDrain({
    timeoutMs: 200,
    pollMs: 0,
    baselineQueueLength: 0,
    sleepFn: async () => {},
    getHealth: async () => {
      n += 1;
      return { status: "READY", queueLength: n === 1 ? 1 : 0 };
    },
  });
  assert.strictEqual(out.drained, true);
  assert.strictEqual(out.timeout, false);
});

await run("waitForQueueDrain: DISCONNECTED after submit", async () => {
  let n = 0;
  const out = await waitForQueueDrain({
    timeoutMs: 200,
    pollMs: 0,
    baselineQueueLength: 0,
    sleepFn: async () => {},
    getHealth: async () => {
      n += 1;
      if (n === 1) return { status: "READY", queueLength: 1 };
      return { status: "DISCONNECTED", queueLength: 1 };
    },
  });
  assert.strictEqual(out.drained, false);
  assert.strictEqual(out.printerReady, false);
  assert.strictEqual(out.finalPrinterStatus, "DISCONNECTED");
});

await run("five RU burst: FIFO, unique payloads, drain before next write", async () => {
  const jobs = [3, 4, 5, 6, 7].map((n) => ruJob(n));
  let phase = "idle";
  const h = makeHarness({
    jobs,
    health: () => {
      if (phase === "queued") {
        phase = "idle";
        return { status: "READY", name: jobs[0].windowsPrinterName, queueLength: 1 };
      }
      return { status: "READY", name: jobs[0].windowsPrinterName, queueLength: 0 };
    },
    printRaw: async () => {
      phase = "queued";
      return { ok: true };
    },
  });
  await drainAll(h.processor);
  assert.strictEqual(h.writes.length, 5);
  assert.deepStrictEqual(
    h.writes.map((w) => w.payload.match(/MAR-RU-\d+/)[0]),
    ["MAR-RU-000003", "MAR-RU-000004", "MAR-RU-000005", "MAR-RU-000006", "MAR-RU-000007"]
  );
  assert.ok(h.results.every((r) => r.status === "COMPLETED"));
  assert.ok(h.results.every((r) => r.printedQty === 1));
  const docNames = h.writes.map((w) => w.jobNo);
  assert.deepStrictEqual(docNames, jobs.map((j) => `Marivolt ${j.jobNo}`));
  assert.strictEqual(new Set(h.writes.map((w) => w.payload)).size, 5);
});

await run("ten rapid jobs: 0 drops, 0 duplicates, FIFO", async () => {
  const jobs = Array.from({ length: 10 }, (_, i) => ruJob(i + 1));
  let phase = "idle";
  const h = makeHarness({
    jobs,
    health: () => {
      if (phase === "queued") {
        phase = "idle";
        return { status: "READY", queueLength: 1, name: "RP4xx Series 200DPI TSPL" };
      }
      return { status: "READY", queueLength: 0, name: "RP4xx Series 200DPI TSPL" };
    },
    printRaw: async () => {
      phase = "queued";
      return { ok: true };
    },
  });
  await drainAll(h.processor, 20);
  assert.strictEqual(h.writes.length, 10);
  assert.strictEqual(h.results.length, 10);
  assert.strictEqual(h.results.filter((r) => r.status === "COMPLETED").length, 10);
  const rus = h.writes.map((w) => w.payload.match(/MAR-RU-\d+/)[0]);
  assert.deepStrictEqual(
    rus,
    Array.from({ length: 10 }, (_, i) => `MAR-RU-${String(i + 1).padStart(6, "0")}`)
  );
  assert.strictEqual(new Set(rus).size, 10);
});

await run("DISCONNECTED: 0 WritePrinter, 0 COMPLETED, jobs stay pending", async () => {
  const jobs = [3, 4, 5, 6, 7].map((n) => ruJob(n));
  const h = makeHarness({
    jobs,
    health: () => ({ status: "DISCONNECTED", queueLength: 0, name: "RP4xx Series 200DPI TSPL" }),
  });
  await drainAll(h.processor);
  assert.strictEqual(h.writes.length, 0);
  assert.strictEqual(h.leased.length, 0);
  assert.strictEqual(h.results.length, 0);
  assert.strictEqual(h.remaining.length, 5);
});

await run("OFFLINE: 0 WritePrinter, 0 COMPLETED, jobs stay pending", async () => {
  const jobs = [3, 4, 5, 6, 7].map((n) => ruJob(n));
  const h = makeHarness({
    jobs,
    health: () => ({ status: "OFFLINE", queueLength: 0, name: "RP4xx Series 200DPI TSPL" }),
  });
  await drainAll(h.processor);
  assert.strictEqual(h.writes.length, 0);
  assert.strictEqual(h.leased.length, 0);
  assert.strictEqual(h.results.length, 0);
  assert.strictEqual(h.remaining.length, 5);
});

await run("READY then DISCONNECT before drain → UNCERTAIN, no next send", async () => {
  const jobs = [3, 4].map((n) => ruJob(n));
  let writes = 0;
  let polls = 0;
  const h = makeHarness({
    jobs,
    health: () => {
      if (writes === 0) return { status: "READY", queueLength: 0, name: "RP4xx Series 200DPI TSPL" };
      polls += 1;
      if (polls === 1) return { status: "READY", queueLength: 1, name: "RP4xx Series 200DPI TSPL" };
      return { status: "DISCONNECTED", queueLength: 1, name: "RP4xx Series 200DPI TSPL" };
    },
    printRaw: async () => {
      writes += 1;
      return { ok: true };
    },
  });
  await h.processor.processOne();
  await h.processor.processOne();
  assert.strictEqual(h.writes.length, 1);
  assert.strictEqual(h.results[0].status, "UNCERTAIN");
  assert.ok(!h.results.some((r) => r.status === "COMPLETED"));
  assert.strictEqual(h.remaining.length, 1);
});

await run("READY + drain → COMPLETED printed=1", async () => {
  let phase = "idle";
  const h = makeHarness({
    jobs: [ruJob(3)],
    health: () => {
      if (phase === "queued") {
        phase = "idle";
        return { status: "READY", queueLength: 1, name: "P" };
      }
      return { status: "READY", queueLength: 0, name: "P" };
    },
    printRaw: async () => {
      phase = "queued";
      return { ok: true };
    },
  });
  await h.processor.processOne();
  assert.strictEqual(h.results[0].status, "COMPLETED");
  assert.strictEqual(h.results[0].printedQty, 1);
});

await run("post-lease recheck releases to PENDING without WritePrinter", async () => {
  let n = 0;
  const h = makeHarness({
    jobs: [ruJob(3)],
    health: () => {
      n += 1;
      if (n === 1) return { status: "READY", queueLength: 0, name: "P" };
      return { status: "OFFLINE", queueLength: 0, name: "P" };
    },
  });
  await h.processor.processOne();
  assert.strictEqual(h.leased.length, 1);
  assert.strictEqual(h.releases.length, 1);
  assert.strictEqual(h.writes.length, 0);
  assert.strictEqual(h.results.length, 0);
  assert.strictEqual(h.printing.length, 0);
});

await run("reprint job uses the same READY gate (offline stays unsent)", async () => {
  const job = { ...ruJob(3), isReprint: true, jobNo: "LBL-REPRINT-3" };
  const h = makeHarness({
    jobs: [job],
    health: () => ({ status: "OFFLINE", queueLength: 0, name: "P" }),
  });
  await drainAll(h.processor);
  assert.strictEqual(h.writes.length, 0);
  assert.strictEqual(h.results.length, 0);
});

await run("per-printer FIFO serializes the same printer", async () => {
  const fifo = createPrinterFifo();
  const order = [];
  await Promise.all([
    fifo.run("RP4xx", async () => {
      order.push("a-start");
      await new Promise((r) => setTimeout(r, 25));
      order.push("a-end");
    }),
    fifo.run("RP4xx", async () => {
      order.push("b-start");
      order.push("b-end");
    }),
  ]);
  assert.deepStrictEqual(order, ["a-start", "a-end", "b-start", "b-end"]);
});

await run("different printers are not globally serialized", async () => {
  const fifo = createPrinterFifo();
  const order = [];
  await Promise.all([
    fifo.run("Printer A", async () => {
      order.push("A-start");
      await new Promise((r) => setTimeout(r, 40));
      order.push("A-end");
    }),
    fifo.run("Printer B", async () => {
      order.push("B-start");
      order.push("B-end");
    }),
  ]);
  assert.ok(order.indexOf("B-end") < order.indexOf("A-end"));
  assert.ok(order.includes("A-start") && order.includes("B-start"));
});

await run("same printer: next WritePrinter waits for previous drain (parallel loops)", async () => {
  const jobs = [3, 4].map((n) => ruJob(n));
  let activeWrites = 0;
  let maxActive = 0;
  let phase = "idle";
  const h = makeHarness({
    jobs,
    health: async () => {
      if (phase === "hold") return { status: "READY", queueLength: 1, name: "P" };
      return { status: "READY", queueLength: 0, name: "P" };
    },
    printRaw: async () => {
      activeWrites += 1;
      maxActive = Math.max(maxActive, activeWrites);
      phase = "hold";
      await new Promise((r) => setTimeout(r, 20));
      phase = "idle";
      activeWrites -= 1;
      return { ok: true };
    },
  });
  await Promise.all([h.processor.processOne(), h.processor.processOne()]);
  assert.strictEqual(h.writes.length, 2);
  assert.strictEqual(maxActive, 1);
  assert.deepStrictEqual(
    h.writes.map((w) => w.payload.match(/MAR-RU-\d+/)[0]),
    ["MAR-RU-000003", "MAR-RU-000004"]
  );
});

await run("Printer A and B may print independently", async () => {
  const jobs = [ruJob(3, "Printer A"), ruJob(4, "Printer B")];
  let aHold;
  const aGate = new Promise((r) => {
    aHold = r;
  });
  const events = [];
  const h = makeHarness({
    jobs,
    health: () => ({ status: "READY", queueLength: 0, name: "x" }),
    printRaw: async (buf, printerName) => {
      events.push(`${printerName}-start`);
      if (printerName === "Printer A") await aGate;
      events.push(`${printerName}-end`);
      return { ok: true };
    },
  });
  const p1 = h.processor.processOne();
  const p2 = h.processor.processOne();
  for (let i = 0; i < 80 && !events.includes("Printer A-start"); i += 1) {
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.ok(events.includes("Printer A-start"), "Printer A should have started RAW submit");
  aHold();
  await Promise.all([p1, p2]);
  assert.ok(events.includes("Printer B-end"));
  assert.ok(events.indexOf("Printer B-end") < events.indexOf("Printer A-end"));
});

await run("process lock blocks a second live PID for the same agentId", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "marivolt-agent-lock-"));
  const a = acquireAgentProcessLock(dir, "AGTB3A953D7", { pid: 111, alive: () => true });
  assert.throws(() => acquireAgentProcessLock(dir, "AGTB3A953D7", { pid: 222, alive: (p) => p === 111 }), {
    code: "AGENT_PROCESS_LOCK",
  });
  a.release();
  const b = acquireAgentProcessLock(dir, "AGTB3A953D7", { pid: 222, alive: () => false });
  b.release();
});

await run("stale lock PID is reused", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "marivolt-agent-lock-"));
  fs.writeFileSync(path.join(dir, "agent-AGT1.lock"), "99999");
  const a = acquireAgentProcessLock(dir, "AGT1", { pid: 7, alive: () => false });
  assert.strictEqual(fs.readFileSync(a.lockPath, "utf8"), "7");
  a.release();
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
