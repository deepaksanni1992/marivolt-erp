#!/usr/bin/env node
/**
 * Verify configured Windows printer queue vs physical device health.
 * Distinguishes "queue installed" from "USB/device ready".
 * Run as the same account the service will use when possible.
 */
import { assertWindows, validateConfigForService } from "./common.mjs";
import {
  normalizeDetectedPrinters,
  probeWindowsPrinterHealth,
  resolveConfiguredPrinterHealth,
  formatVerifyPrinterReport,
  looksLikeLocalDevicePort,
} from "../src/detect.js";

async function main() {
  assertWindows();
  const meta = validateConfigForService();
  const configuredName = meta.windowsPrinterName || "";

  console.log(`Agent: ${meta.agentId}`);

  if (!configuredName) {
    const report = formatVerifyPrinterReport({ configuredName: "", health: null });
    report.lines.forEach((l) => console.log(l));
    process.exit(report.exitCode);
  }

  const probe = await probeWindowsPrinterHealth();
  const names = normalizeDetectedPrinters(probe.rows.map((h) => h.name));
  console.log(`Detected queues (${names.length}):`);
  names.forEach((p, i) => console.log(`  ${i + 1}. ${p}`));
  if (!probe.ok) {
    console.log(`Probe warning: ${probe.error || "query failed"}`);
  }

  let health = resolveConfiguredPrinterHealth(configuredName, probe.rows, {
    queryFailed: !probe.ok,
    queryError: probe.error,
  });

  // Strict CLI: never claim READY for USB/local queues without confirmed PnP presence.
  if (
    health.status === "READY" &&
    looksLikeLocalDevicePort(health.portName) &&
    health.usbDevicePresent !== true
  ) {
    health = {
      ...health,
      status: "UNKNOWN",
      connected: null,
      online: false,
      offline: true,
      statusMessage:
        health.statusMessage ||
        "Queue reports ready but USB/PnP presence could not be confirmed",
    };
  }

  const report = formatVerifyPrinterReport({
    configuredName,
    health,
    queryFailed: !probe.ok,
  });
  report.lines.forEach((l) => console.log(l));

  if (report.exitCode !== 0) {
    console.log("");
    console.log("Hints:");
    console.log("- Queue installed ≠ physical USB device connected.");
    console.log("- Windows often keeps the printer queue after the USB cable is unplugged.");
    console.log("- Printer queues installed only for an interactive user are often invisible to LocalSystem.");
    console.log("- Install the printer machine-wide, or reinstall the service with MARIVOLT_SERVICE_ACCOUNT.");
    console.log("- Confirm the exact Windows printer name matches ERP mapping.");
  }

  process.exit(report.exitCode);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
