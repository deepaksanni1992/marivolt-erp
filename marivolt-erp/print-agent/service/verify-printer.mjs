#!/usr/bin/env node
/**
 * Verify the configured Windows printer is visible to this process/account.
 * Run as the same account the service will use when possible.
 */
import {
  assertWindows,
  validateConfigForService,
} from "./common.mjs";
import { detectWindowsPrinters } from "../src/detect.js";

async function main() {
  assertWindows();
  const meta = validateConfigForService();
  const printers = await detectWindowsPrinters();
  console.log(`Agent: ${meta.agentId}`);
  console.log(`Configured printer: ${meta.windowsPrinterName || "(none)"}`);
  console.log(`Detected printers (${printers.length}):`);
  printers.forEach((p, i) => console.log(`  ${i + 1}. ${p}`));

  if (!meta.windowsPrinterName) {
    console.log("Result: NO CONFIGURED PRINTER");
    process.exit(2);
  }
  const want = meta.windowsPrinterName.toLowerCase();
  const found = printers.some((p) => p.toLowerCase() === want);
  if (found) {
    console.log("Result: PRINTER DETECTED");
    process.exit(0);
  }
  console.log("Result: PRINTER UNAVAILABLE");
  console.log("");
  console.log("Hints:");
  console.log("- Printer queues installed only for an interactive user are often invisible to LocalSystem.");
  console.log("- Install the printer machine-wide, or reinstall the service with MARIVOLT_SERVICE_ACCOUNT.");
  console.log("- Confirm the exact Windows printer name matches ERP mapping.");
  process.exit(3);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
