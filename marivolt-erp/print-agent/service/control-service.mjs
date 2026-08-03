#!/usr/bin/env node
/**
 * Control Marivolt Print Agent Windows Service: start | stop | restart | status
 */
import fs from "fs";
import path from "path";
import {
  SERVICE_DISPLAY_NAME,
  SERVICE_ID,
  assertAdministrator,
  assertWindows,
  computerName,
  getConfigDir,
  getConfigPath,
  getServiceRuntimeDir,
  queryServiceStartType,
  queryServiceState,
  runWinsw,
  validateConfigForService,
} from "./common.mjs";
import { detectWindowsPrinters } from "../src/detect.js";

async function status() {
  assertWindows();
  const svc = queryServiceState();
  const startType = svc.installed ? queryServiceStartType() : "N/A";
  let meta = null;
  try {
    meta = validateConfigForService();
  } catch (e) {
    meta = { error: e.message };
  }

  let printerDetected = "Unknown";
  if (meta?.windowsPrinterName) {
    try {
      const printers = await detectWindowsPrinters();
      const want = meta.windowsPrinterName.toLowerCase();
      printerDetected = printers.some((p) => p.toLowerCase() === want) ? "Yes" : "No";
    } catch {
      printerDetected = "Unknown";
    }
  } else if (meta && !meta.error) {
    printerDetected = "N/A (not configured)";
  }

  let lastHeartbeat = "n/a";
  try {
    const logDir = path.join(getConfigDir(), "logs");
    const agentLog = path.join(logDir, "agent.log");
    if (fs.existsSync(agentLog)) {
      const text = fs.readFileSync(agentLog, "utf8");
      const lines = text.trim().split(/\r?\n/);
      const hb = [...lines].reverse().find((l) => /heartbeat/i.test(l));
      if (hb) lastHeartbeat = hb.slice(0, 120);
    }
  } catch {
    /* ignore */
  }

  console.log(`Service: ${SERVICE_ID}`);
  console.log(`Display: ${SERVICE_DISPLAY_NAME}`);
  console.log(`Status: ${svc.installed ? svc.state : "NOT_INSTALLED"}`);
  console.log(`Startup: ${startType}`);
  console.log(`Computer: ${computerName()}`);
  if (meta?.error) {
    console.log(`Config: ERROR — ${meta.error}`);
  } else {
    console.log(`Agent ID: ${meta.agentId}`);
    console.log(`Backend: ${meta.backendUrl}`);
    console.log(`Configured printer: ${meta.windowsPrinterName || "(none)"}`);
    console.log(`Printer detected: ${printerDetected}`);
    console.log(`Config path: ${getConfigPath()}`);
  }
  console.log(`Log path: ${path.join(getConfigDir(), "logs")}`);
  console.log(`Service runtime: ${getServiceRuntimeDir()}`);
  console.log(`Last local heartbeat log: ${lastHeartbeat}`);
}

function control(action) {
  assertWindows();
  if (action === "status") {
    return status();
  }
  assertAdministrator();
  const r = runWinsw([action], { inherit: true });
  if (r.status !== 0) {
    process.exit(r.status || 1);
  }
}

const action = String(process.argv[2] || "status").toLowerCase();
const allowed = new Set(["start", "stop", "restart", "status"]);
if (!allowed.has(action)) {
  console.error(`Usage: node service/control-service.mjs <start|stop|restart|status>`);
  process.exit(1);
}

Promise.resolve(control(action)).catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
