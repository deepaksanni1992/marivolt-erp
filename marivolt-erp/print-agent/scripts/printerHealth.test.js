/**
 * Unit tests for Windows printer health mapping (no live spooler required).
 */
import assert from "assert";
import {
  mapWindowsPrinterHealth,
  mergePrinterProbeRows,
  resolveConfiguredPrinterHealth,
  looksLikeLocalDevicePort,
  normalizeDetectedPrinters,
} from "../src/detect.js";

let passed = 0;
let failed = 0;

function run(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed += 1;
    console.error(`  ✗ ${name}`);
    console.error(`    ${e.message}`);
  }
}

console.log("\nPrint Agent printer health mapping\n");

const now = new Date("2026-08-03T10:00:00.000Z");

run("Normal USB printer → READY", () => {
  const h = mapWindowsPrinterHealth(
    { Name: "RP4xx Series 200DPI TSPL", PrinterStatus: "Normal", JobCount: 0, WorkOffline: false, PortName: "USB001" },
    { now }
  );
  assert.strictEqual(h.status, "READY");
  assert.strictEqual(h.connected, true);
  assert.strictEqual(h.online, true);
  assert.strictEqual(h.offline, false);
});

run("USB Offline → DISCONNECTED", () => {
  const h = mapWindowsPrinterHealth(
    { Name: "RP4xx", PrinterStatus: "Offline", JobCount: 0, WorkOffline: false, PortName: "USB001" },
    { now }
  );
  assert.strictEqual(h.status, "DISCONNECTED");
  assert.strictEqual(h.connected, false);
  assert.strictEqual(h.online, false);
});

run("WMI PrinterStatus Offline on USB → DISCONNECTED", () => {
  const h = mapWindowsPrinterHealth(
    {
      Name: "RP4xx",
      PrinterStatus: "Normal",
      JobCount: 0,
      WorkOffline: false,
      PortName: "USB001",
      WmiPrinterStatus: 7,
      DetectedErrorState: 2,
    },
    { now }
  );
  assert.strictEqual(h.status, "DISCONNECTED");
});

run("WMI DetectedErrorState Offline on USB → DISCONNECTED", () => {
  const h = mapWindowsPrinterHealth(
    {
      Name: "RP4xx",
      PrinterStatus: "Normal",
      JobCount: 0,
      WorkOffline: false,
      PortName: "USB001",
      WmiPrinterStatus: 3,
      DetectedErrorState: 9,
    },
    { now }
  );
  assert.strictEqual(h.status, "DISCONNECTED");
});

run("Network Offline → OFFLINE (not DISCONNECTED)", () => {
  const h = mapWindowsPrinterHealth(
    { Name: "NetLabel", PrinterStatus: "Offline", JobCount: 0, WorkOffline: false, PortName: "IP_192.168.1.10" },
    { now }
  );
  assert.strictEqual(h.status, "OFFLINE");
  assert.strictEqual(h.connected, true);
});

run("WorkOffline → OFFLINE (precedence over Normal)", () => {
  const h = mapWindowsPrinterHealth(
    { Name: "RP4xx", PrinterStatus: "Normal", JobCount: 0, WorkOffline: true, PortName: "USB001" },
    { now }
  );
  assert.strictEqual(h.status, "OFFLINE");
  assert.strictEqual(h.offline, true);
});

run("Paused → PAUSED", () => {
  const h = mapWindowsPrinterHealth(
    { Name: "RP4xx", PrinterStatus: "Paused", JobCount: 2, WorkOffline: false, PortName: "USB001" },
    { now }
  );
  assert.strictEqual(h.status, "PAUSED");
  assert.strictEqual(h.paused, true);
  assert.strictEqual(h.queueLength, 2);
});

run("PaperOut → PAPER_OUT", () => {
  const h = mapWindowsPrinterHealth(
    { Name: "RP4xx", PrinterStatus: "PaperOut", JobCount: 0, WorkOffline: false, PortName: "USB001" },
    { now }
  );
  assert.strictEqual(h.status, "PAPER_OUT");
  assert.strictEqual(h.paperOut, true);
});

run("WMI NoPaper DetectedErrorState → PAPER_OUT", () => {
  const h = mapWindowsPrinterHealth(
    {
      Name: "RP4xx",
      PrinterStatus: "Normal",
      JobCount: 0,
      WorkOffline: false,
      PortName: "USB001",
      DetectedErrorState: 4,
    },
    { now }
  );
  assert.strictEqual(h.status, "PAPER_OUT");
});

run("DoorOpen → DOOR_OPEN", () => {
  const h = mapWindowsPrinterHealth(
    { Name: "RP4xx", PrinterStatus: "DoorOpen", JobCount: 0, WorkOffline: false, PortName: "USB001" },
    { now }
  );
  assert.strictEqual(h.status, "DOOR_OPEN");
  assert.strictEqual(h.doorOpen, true);
});

run("NotAvailable on USB → DISCONNECTED", () => {
  const h = mapWindowsPrinterHealth(
    { Name: "RP4xx", PrinterStatus: "NotAvailable", JobCount: 0, WorkOffline: false, PortName: "USB001" },
    { now }
  );
  assert.strictEqual(h.status, "DISCONNECTED");
});

run("Error → ERROR", () => {
  const h = mapWindowsPrinterHealth(
    { Name: "RP4xx", PrinterStatus: "Error", JobCount: 0, WorkOffline: false, PortName: "USB001" },
    { now }
  );
  assert.strictEqual(h.status, "ERROR");
});

run("Jammed DetectedErrorState → ERROR", () => {
  const h = mapWindowsPrinterHealth(
    {
      Name: "RP4xx",
      PrinterStatus: "Normal",
      JobCount: 0,
      WorkOffline: false,
      PortName: "USB001",
      DetectedErrorState: 8,
    },
    { now }
  );
  assert.strictEqual(h.status, "ERROR");
});

run("missing row → DISCONNECTED", () => {
  const h = mapWindowsPrinterHealth(null, { now });
  assert.strictEqual(h.status, "DISCONNECTED");
  assert.strictEqual(h.printerFound, false);
});

run("configured missing from list → DISCONNECTED", () => {
  const h = resolveConfiguredPrinterHealth("RP4xx Series 200DPI TSPL", [], { now });
  assert.strictEqual(h.status, "DISCONNECTED");
  assert.strictEqual(h.printerFound, false);
  assert.ok(h.name.includes("RP4xx"));
});

run("query failed → UNKNOWN (not DISCONNECTED)", () => {
  const h = resolveConfiguredPrinterHealth("RP4xx", [], {
    now,
    queryFailed: true,
    queryError: "timeout",
  });
  assert.strictEqual(h.status, "UNKNOWN");
  assert.ok(String(h.statusMessage).includes("timeout") || String(h.statusMessage).toLowerCase().includes("fail"));
});

run("configured found READY", () => {
  const rows = [
    mapWindowsPrinterHealth(
      { Name: "RP4xx Series 200DPI TSPL", PrinterStatus: "Normal", JobCount: 1, WorkOffline: false, PortName: "USB001" },
      { now }
    ),
  ];
  const h = resolveConfiguredPrinterHealth("RP4xx Series 200DPI TSPL", rows, { now });
  assert.strictEqual(h.status, "READY");
  assert.strictEqual(h.queueLength, 1);
});

run("special-character printer name (spaces, brackets, ampersand, unicode)", () => {
  const name = "Rongta RP420 (USB) & Warehouse — مكتب";
  const h = mapWindowsPrinterHealth(
    { Name: name, PrinterStatus: "Normal", JobCount: 0, WorkOffline: false, PortName: "USB001" },
    { now }
  );
  assert.strictEqual(h.name, name);
  assert.strictEqual(h.status, "READY");
  const resolved = resolveConfiguredPrinterHealth(name, [h], { now });
  assert.strictEqual(resolved.status, "READY");
});

run("multiple printers + duplicate queue names safely deduped", () => {
  const merged = mergePrinterProbeRows(
    [
      { Name: "A", PrinterStatus: "Normal", JobCount: 0, WorkOffline: false, PortName: "USB001" },
      { Name: "a", PrinterStatus: "Paused", JobCount: 3, WorkOffline: false, PortName: "USB001" },
      { Name: "B", PrinterStatus: "Offline", JobCount: 0, WorkOffline: false, PortName: "USB002" },
    ],
    [],
    { now }
  );
  assert.strictEqual(merged.length, 2);
  assert.strictEqual(merged[0].status, "READY");
  assert.strictEqual(merged[1].status, "DISCONNECTED");
});

run("merge overlays WMI Offline onto Get-Printer Normal (USB unplug fallback)", () => {
  const merged = mergePrinterProbeRows(
    [{ Name: "RP4xx", PrinterStatus: "Normal", JobCount: 0, WorkOffline: false, PortName: "USB001" }],
    [{ Name: "RP4xx", PrinterStatus: 7, DetectedErrorState: 9, WorkOffline: false, PortName: "USB001" }],
    { now }
  );
  assert.strictEqual(merged.length, 1);
  assert.strictEqual(merged[0].status, "DISCONNECTED");
});

run("negative/invalid JobCount → non-negative queueLength", () => {
  const h = mapWindowsPrinterHealth(
    { Name: "RP4xx", PrinterStatus: "Normal", JobCount: -5, WorkOffline: false, PortName: "USB001" },
    { now }
  );
  assert.strictEqual(h.queueLength, 0);
});

run("looksLikeLocalDevicePort recognizes USB/DOT4", () => {
  assert.ok(looksLikeLocalDevicePort("USB001"));
  assert.ok(looksLikeLocalDevicePort("DOT4_001"));
  assert.ok(!looksLikeLocalDevicePort("IP_10.0.0.5"));
});

run("normalizeDetectedPrinters caps and dedupes", () => {
  const names = normalizeDetectedPrinters(["A", "a", "B", "", null]);
  assert.deepStrictEqual(names, ["A", "B"]);
});

run("WorkOffline precedes Paused when both signals present", () => {
  const h = mapWindowsPrinterHealth(
    { Name: "RP4xx", PrinterStatus: "Paused", JobCount: 0, WorkOffline: true, PortName: "USB001" },
    { now }
  );
  assert.strictEqual(h.status, "OFFLINE");
});

run("Paused precedes PaperOut when offline not set", () => {
  // Get-Printer rarely combines these; ensure paused wins when status string is Paused
  const h = mapWindowsPrinterHealth(
    { Name: "RP4xx", PrinterStatus: "Paused", JobCount: 0, WorkOffline: false, PortName: "USB001", DetectedErrorState: 4 },
    { now }
  );
  assert.strictEqual(h.status, "PAUSED");
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
