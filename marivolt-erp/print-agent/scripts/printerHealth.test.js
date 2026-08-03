/**
 * Unit tests for Windows printer health mapping + verify-printer wording.
 */
import assert from "assert";
import {
  mapWindowsPrinterHealth,
  mergePrinterProbeRows,
  resolveConfiguredPrinterHealth,
  resolveUsbDevicePresent,
  looksLikeLocalDevicePort,
  normalizeDetectedPrinters,
  formatVerifyPrinterReport,
  PRINTER_STATE,
} from "../src/detect.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

run("queue exists + USB device present → READY", () => {
  const h = mapWindowsPrinterHealth(
    {
      Name: "RP4xx Series 200DPI TSPL",
      PrinterStatus: "Normal",
      JobCount: 0,
      WorkOffline: false,
      PortName: "USB001",
      usbDevicePresent: true,
    },
    { now }
  );
  assert.strictEqual(h.status, "READY");
  assert.strictEqual(h.connected, true);
  assert.strictEqual(h.queueInstalled, true);
});

run("queue exists + USB device absent → DISCONNECTED (not READY)", () => {
  const h = mapWindowsPrinterHealth(
    {
      Name: "RP4xx Series 200DPI TSPL",
      PrinterStatus: "Normal",
      JobCount: 0,
      WorkOffline: false,
      PortName: "USB001",
      usbDevicePresent: false,
    },
    { now }
  );
  assert.strictEqual(h.status, "DISCONNECTED");
  assert.strictEqual(h.connected, false);
  assert.strictEqual(h.queueInstalled, true);
  assert.ok(!/READY/i.test(h.status));
});

run("PnP resolve: empty list → inconclusive null (not false)", () => {
  const present = resolveUsbDevicePresent("RP4xx", "USB001", []);
  assert.strictEqual(present, null);
});

run("PnP resolve: USBPRINT all Error → false", () => {
  const present = resolveUsbDevicePresent("Other", "USB001", [
    { FriendlyName: "Other", InstanceId: "USBPRINT\\X\\1", Status: "Error", Class: "Printer" },
  ]);
  assert.strictEqual(present, false);
});

run("PnP resolve: named USBPRINT OK → true", () => {
  const present = resolveUsbDevicePresent("RP4xx Series 200DPI TSPL", "USB001", [
    {
      FriendlyName: "RP4xx Series 200DPI TSPL",
      InstanceId: "USBPRINT\\RONGTA\\1",
      Status: "OK",
      Class: "Printer",
    },
  ]);
  assert.strictEqual(present, true);
});

run("PnP resolve: named device Error → false", () => {
  const present = resolveUsbDevicePresent("RP4xx", "USB001", [
    { FriendlyName: "RP4xx", InstanceId: "USBPRINT\\X\\1", Status: "Error", Class: "Printer" },
  ]);
  assert.strictEqual(present, false);
});

run("merge: Normal + USBPRINT Error → DISCONNECTED", () => {
  const merged = mergePrinterProbeRows(
    [{ Name: "RP4xx", PrinterStatus: "Normal", JobCount: 0, WorkOffline: false, PortName: "USB001" }],
    [{ Name: "RP4xx", PrinterStatus: 3, DetectedErrorState: 2, PortName: "USB001" }],
    {
      now,
      pnpDevices: [{ FriendlyName: "RP4xx", InstanceId: "USBPRINT\\R\\1", Status: "Error", Class: "Printer" }],
      pnpChecked: true,
    }
  );
  assert.strictEqual(merged[0].status, "DISCONNECTED");
});

run("merge: Normal + USBPRINT OK → READY", () => {
  const merged = mergePrinterProbeRows(
    [{ Name: "RP4xx", PrinterStatus: "Normal", JobCount: 0, WorkOffline: false, PortName: "USB001" }],
    [{ Name: "RP4xx", PrinterStatus: 3, DetectedErrorState: 2, PortName: "USB001" }],
    {
      now,
      pnpDevices: [{ FriendlyName: "RP4xx", InstanceId: "USBPRINT\\R\\1", Status: "OK", Class: "Printer" }],
      pnpChecked: true,
    }
  );
  assert.strictEqual(merged[0].status, "READY");
});

run("USB Offline → DISCONNECTED", () => {
  const h = mapWindowsPrinterHealth(
    { Name: "RP4xx", PrinterStatus: "Offline", JobCount: 0, WorkOffline: false, PortName: "USB001", usbDevicePresent: true },
    { now }
  );
  assert.strictEqual(h.status, "DISCONNECTED");
});

run("queue exists + Windows offline (network) → OFFLINE", () => {
  const h = mapWindowsPrinterHealth(
    { Name: "NetLabel", PrinterStatus: "Offline", JobCount: 0, WorkOffline: false, PortName: "IP_192.168.1.10" },
    { now }
  );
  assert.strictEqual(h.status, "OFFLINE");
});

run("WorkOffline → OFFLINE", () => {
  const h = mapWindowsPrinterHealth(
    { Name: "RP4xx", PrinterStatus: "Normal", JobCount: 0, WorkOffline: true, PortName: "USB001", usbDevicePresent: true },
    { now }
  );
  assert.strictEqual(h.status, "OFFLINE");
});

run("PrinterState OFFLINE bit on USB → DISCONNECTED", () => {
  const h = mapWindowsPrinterHealth(
    {
      Name: "RP4xx",
      PrinterStatus: "Normal",
      JobCount: 0,
      WorkOffline: false,
      PortName: "USB001",
      PrinterState: PRINTER_STATE.OFFLINE,
      usbDevicePresent: true,
    },
    { now }
  );
  assert.strictEqual(h.status, "DISCONNECTED");
});

run("Availability Off Line on USB → DISCONNECTED", () => {
  const h = mapWindowsPrinterHealth(
    {
      Name: "RP4xx",
      PrinterStatus: "Normal",
      JobCount: 0,
      WorkOffline: false,
      PortName: "USB001",
      Availability: 8,
      usbDevicePresent: true,
    },
    { now }
  );
  assert.strictEqual(h.status, "DISCONNECTED");
});

run("Paused → PAUSED", () => {
  const h = mapWindowsPrinterHealth(
    { Name: "RP4xx", PrinterStatus: "Paused", JobCount: 2, WorkOffline: false, PortName: "USB001", usbDevicePresent: true },
    { now }
  );
  assert.strictEqual(h.status, "PAUSED");
  assert.strictEqual(h.queueLength, 2);
});

run("queue missing → DISCONNECTED", () => {
  const h = resolveConfiguredPrinterHealth("RP4xx Series 200DPI TSPL", [], { now });
  assert.strictEqual(h.status, "DISCONNECTED");
  assert.strictEqual(h.queueInstalled, false);
});

run("query failure → UNKNOWN", () => {
  const h = resolveConfiguredPrinterHealth("RP4xx", [], { now, queryFailed: true, queryError: "timeout" });
  assert.strictEqual(h.status, "UNKNOWN");
  assert.strictEqual(h.queueInstalled, null);
});

run("verify wording: USB connected READY", () => {
  const health = mapWindowsPrinterHealth(
    {
      Name: "RP4xx Series 200DPI TSPL",
      PrinterStatus: "Normal",
      JobCount: 0,
      WorkOffline: false,
      PortName: "USB001",
      usbDevicePresent: true,
    },
    { now }
  );
  const report = formatVerifyPrinterReport({
    configuredName: "RP4xx Series 200DPI TSPL",
    health,
  });
  assert.ok(report.lines.some((l) => l === "Queue installed: YES"));
  assert.ok(report.lines.some((l) => l === "Physical status: READY"));
  assert.ok(report.lines.some((l) => l === "Connected: YES"));
  assert.ok(report.lines.some((l) => l === "Result: PRINTER READY"));
  assert.ok(!report.lines.some((l) => /PRINTER DETECTED/i.test(l)));
  assert.strictEqual(report.exitCode, 0);
});

run("verify wording: USB unplugged queue remains", () => {
  const health = mapWindowsPrinterHealth(
    {
      Name: "RP4xx Series 200DPI TSPL",
      PrinterStatus: "Offline",
      JobCount: 0,
      WorkOffline: false,
      PortName: "USB001",
      usbDevicePresent: false,
    },
    { now }
  );
  const report = formatVerifyPrinterReport({
    configuredName: "RP4xx Series 200DPI TSPL",
    health,
  });
  assert.ok(report.lines.some((l) => l === "Queue installed: YES"));
  assert.ok(report.lines.some((l) => l === "Physical status: DISCONNECTED"));
  assert.ok(report.lines.some((l) => l === "Connected: NO"));
  assert.ok(report.lines.some((l) => l === "Result: PRINTER QUEUE EXISTS, PHYSICAL DEVICE UNAVAILABLE"));
  assert.ok(!report.lines.some((l) => /PRINTER DETECTED/i.test(l)));
});

run("verify wording: queue missing", () => {
  const health = resolveConfiguredPrinterHealth("RP4xx Series 200DPI TSPL", [], { now });
  const report = formatVerifyPrinterReport({
    configuredName: "RP4xx Series 200DPI TSPL",
    health,
  });
  assert.ok(report.lines.some((l) => l === "Queue installed: NO"));
  assert.ok(report.lines.some((l) => l === "Result: PRINTER QUEUE NOT FOUND"));
});

run("verify wording: physical unknown", () => {
  const health = {
    name: "RP4xx Series 200DPI TSPL",
    queueInstalled: true,
    printerFound: true,
    status: "UNKNOWN",
    connected: null,
    portName: "USB001",
    windowsStatus: "Normal",
    statusMessage: "inconclusive",
    lastSeen: now.toISOString(),
    offline: true,
    paused: false,
    paperOut: false,
    doorOpen: false,
    queueLength: 0,
  };
  const report = formatVerifyPrinterReport({
    configuredName: "RP4xx Series 200DPI TSPL",
    health,
  });
  assert.ok(report.lines.some((l) => l === "Result: PRINTER QUEUE EXISTS, PHYSICAL STATE UNKNOWN"));
  assert.ok(report.lines.some((l) => l === "Connected: UNKNOWN"));
});

run("verify-printer.mjs uses shared detect helpers (no PRINTER DETECTED)", () => {
  const src = fs.readFileSync(path.join(__dirname, "../service/verify-printer.mjs"), "utf8");
  assert.ok(src.includes("formatVerifyPrinterReport") || src.includes("resolveConfiguredPrinterHealth"));
  assert.ok(src.includes("probeWindowsPrinterHealth"));
  assert.ok(!src.includes("PRINTER DETECTED"));
  assert.ok(src.includes("Queue installed") || src.includes("formatVerifyPrinterReport"));
});

run("special-character printer name", () => {
  const name = "Rongta RP420 (USB) & Warehouse — مكتب";
  const h = mapWindowsPrinterHealth(
    { Name: name, PrinterStatus: "Normal", JobCount: 0, WorkOffline: false, PortName: "USB001", usbDevicePresent: true },
    { now }
  );
  assert.strictEqual(h.status, "READY");
});

run("looksLikeLocalDevicePort + normalizeDetectedPrinters", () => {
  assert.ok(looksLikeLocalDevicePort("USB001"));
  assert.ok(!looksLikeLocalDevicePort("IP_10.0.0.5"));
  assert.deepStrictEqual(normalizeDetectedPrinters(["A", "a", "B"]), ["A", "B"]);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
