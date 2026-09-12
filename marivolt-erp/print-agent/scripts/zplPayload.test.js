/**
 * Print-agent ZPL language guards (no hardware).
 */
import assert from "assert";
import { createJobProcessor } from "../src/jobProcessor.js";
import { validateJobLanguagePayload, AGENT_VERSION, resolveJobWindowsQueue } from "../src/payloadLanguage.js";

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

console.log("Print agent ZPL payload");

await run("Agent version is 1.9.0", () => {
  assert.equal(AGENT_VERSION, "1.9.0");
});

await run("ZPL payload with TSPL commands is rejected", () => {
  const r = validateJobLanguagePayload({
    language: "ZPL",
    tsplPayload: "^XA\r\nSIZE 100 mm,50 mm\r\nCLS\r\n^XZ\r\n",
  });
  assert.equal(r.ok, false);
});

await run("TSPL job with ZPL payload is rejected", () => {
  const r = validateJobLanguagePayload({
    language: "TSPL",
    tsplPayload: "^XA\r\n^FO20,20^FDHI^FS\r\n^XZ\r\n",
  });
  assert.equal(r.ok, false);
});

await run("Valid ZPL SINGLE_RAW is accepted", () => {
  const r = validateJobLanguagePayload({
    language: "ZPL",
    payloadMode: "SINGLE_RAW",
    tsplPayload: "^XA\r\n^PW800\r\n^LL400\r\n^XZ\r\n",
  });
  assert.equal(r.ok, true);
  assert.equal(r.language, "ZPL");
});

await run("Processor fails ZPL/TSPL mismatch without writing", async () => {
  const writes = [];
  const results = [];
  const processor = createJobProcessor({
    getPrinterHealth: async () => ({ status: "READY", queueLength: 0, name: "ZDesigner ZD220-203dpi ZPL" }),
    getPrinterHealthLightweight: async () => ({ status: "READY", queueLength: 0, name: "ZDesigner ZD220-203dpi ZPL" }),
    leaseNext: async () => ({
      id: "j1",
      jobNo: "LBLZPL1",
      leaseToken: "tok",
      language: "ZPL",
      windowsPrinterName: "ZDesigner ZD220-203dpi ZPL",
      requestedLabels: 1,
      tsplPayload: "SIZE 100 mm,50 mm\r\nCLS\r\nPRINT 1,1\r\n",
    }),
    releaseLease: async () => {},
    markPrinting: async () => {},
    reportResult: async (_job, outcome) => {
      results.push(outcome);
    },
    printRaw: async (buf, name) => {
      writes.push({ buf, name });
      return { ok: true, windowsSpoolJobId: 1 };
    },
    log: () => {},
  });
  await processor.processOne();
  assert.equal(writes.length, 0);
  assert.equal(results[0]?.status, "FAILED");
});

await run("Processor sends ZPL RAW to the job Windows queue, not the default", async () => {
  const writes = [];
  const processor = createJobProcessor({
    drainTimeoutMs: 10,
    drainPollMs: 0,
    sleepFn: async () => {},
    getPrinterHealth: async (opts) => ({
      status: "READY",
      queueLength: 0,
      name: opts.printerName || "RP4xx Series 200DPI TSPL (Copy 1)",
    }),
    getPrinterHealthLightweight: async (name) => ({
      status: "READY",
      queueLength: 0,
      name,
    }),
    getWindowsPrintJobStatus: async () => ({ present: false, state: "ABSENT" }),
    leaseNext: async () => ({
      id: "j2",
      jobNo: "LBLZPL2",
      leaseToken: "tok",
      language: "ZPL",
      windowsPrinterName: "ZDesigner ZD220-203dpi ZPL",
      requestedLabels: 1,
      tsplPayload: "^XA\r\n^PW800\r\n^LL400\r\n^XZ\r\n",
    }),
    releaseLease: async () => {},
    markPrinting: async () => {},
    reportResult: async () => {},
    printRaw: async (buf, name) => {
      writes.push({ text: buf.toString("utf8"), name });
      return { ok: true, windowsSpoolJobId: 9, timing: { totalMs: 1, bytesWritten: buf.length, windowsSpoolJobId: 9 } };
    },
    log: () => {},
  });
  await processor.processOne();
  assert.equal(writes.length, 1);
  assert.equal(writes[0].name, "ZDesigner ZD220-203dpi ZPL");
  assert.ok(writes[0].text.includes("^XA"));
});

await run("Empty or missing job queue never writes ZPL to config.json Rongta", async () => {
  assert.equal(resolveJobWindowsQueue("").ok, false);
  assert.equal(resolveJobWindowsQueue("ZDesigner ZD220-203dpi ZPL").printerName, "ZDesigner ZD220-203dpi ZPL");
  const writes = [];
  const results = [];
  const released = [];
  const processor = createJobProcessor({
    getPrinterHealth: async (opts) => ({
      status: "READY",
      queueLength: 0,
      name: opts.printerName || "RP4xx Series 200DPI TSPL (Copy 1)",
    }),
    getPrinterHealthLightweight: async (name) => ({
      status: name ? "READY" : "DISCONNECTED",
      queueLength: 0,
      name: name || "RP4xx Series 200DPI TSPL (Copy 1)",
    }),
    leaseNext: async () => ({
      id: "j-missing",
      jobNo: "LBLZPL-MISS",
      leaseToken: "tok",
      language: "ZPL",
      windowsPrinterName: "",
      requestedLabels: 1,
      tsplPayload: "^XA\r\n^PW800\r\n^LL400\r\n^XZ\r\n",
    }),
    releaseLease: async () => {
      released.push("released");
    },
    markPrinting: async () => {},
    reportResult: async (_job, outcome) => {
      results.push(outcome);
    },
    printRaw: async (buf, name) => {
      writes.push({ name, text: buf.toString("utf8") });
      return { ok: true, windowsSpoolJobId: 1 };
    },
    log: () => {},
  });
  await processor.processOne();
  assert.equal(writes.length, 0);
  assert.equal(results[0]?.status, "FAILED");
  assert.match(results[0]?.error || "", /refusing config.json fallback/);
  assert.equal(released.length, 0);
});

await run("Unavailable Zebra queue releases the lease and does not write Rongta", async () => {
  const writes = [];
  const released = [];
  const processor = createJobProcessor({
    getPrinterHealth: async (opts) => ({
      status: opts.printerName === "ZDesigner ZD220-203dpi ZPL" ? "DISCONNECTED" : "READY",
      queueLength: 0,
      name: opts.printerName || "RP4xx Series 200DPI TSPL (Copy 1)",
    }),
    getPrinterHealthLightweight: async (name) => ({
      status: name === "ZDesigner ZD220-203dpi ZPL" ? "DISCONNECTED" : "READY",
      queueLength: 0,
      name: name || "RP4xx Series 200DPI TSPL (Copy 1)",
    }),
    leaseNext: async () => ({
      id: "j-down",
      jobNo: "LBLZPL-DOWN",
      leaseToken: "tok",
      language: "ZPL",
      windowsPrinterName: "ZDesigner ZD220-203dpi ZPL",
      requestedLabels: 1,
      tsplPayload: "^XA\r\n^PW800\r\n^LL400\r\n^XZ\r\n",
    }),
    releaseLease: async () => {
      released.push("released");
    },
    markPrinting: async () => {},
    reportResult: async () => {},
    printRaw: async (buf, name) => {
      writes.push(name);
      return { ok: true, windowsSpoolJobId: 1 };
    },
    log: () => {},
  });
  await processor.processOne();
  assert.equal(writes.length, 0);
  assert.equal(released.length, 1);
});

if (failed) {
  console.error(`\n${failed} failed, ${passed} passed`);
  process.exit(1);
}
console.log(`\n${passed} passed`);
