import { execFile } from "child_process";
import { promisify } from "util";
import os from "os";

const execFileAsync = promisify(execFile);

/** Canonical physical printer statuses reported to ERP. */
export const PRINTER_STATUSES = Object.freeze([
  "READY",
  "OFFLINE",
  "DISCONNECTED",
  "PAPER_OUT",
  "DOOR_OPEN",
  "PAUSED",
  "ERROR",
  "UNKNOWN",
]);

/**
 * Mapping precedence (deterministic):
 * 1. Query failed → UNKNOWN (caller)
 * 2. Configured queue missing → DISCONNECTED
 * 3. WorkOffline / Windows Offline → OFFLINE (USB Offline → DISCONNECTED)
 * 4. Paused → PAUSED
 * 5. Paper out (reliable signal only) → PAPER_OUT
 * 6. Door open (reliable signal only) → DOOR_OPEN
 * 7. Error / jammed / intervention → ERROR
 * 8. Otherwise idle/printing/... → READY
 */
export const PRINTER_HEALTH_PRECEDENCE = Object.freeze([
  "UNKNOWN",
  "DISCONNECTED",
  "OFFLINE",
  "PAUSED",
  "PAPER_OUT",
  "DOOR_OPEN",
  "ERROR",
  "READY",
]);

/** Stale printer health window — aligned with agent online threshold (ms). */
export const PRINTER_HEALTH_STALE_MS = 90_000;

export function detectComputerName() {
  return String(os.hostname() || "").slice(0, 120);
}

export function detectOperatingSystem() {
  return `${os.type()} ${os.arch()}`.trim().slice(0, 80);
}

export function detectWindowsVersion() {
  try {
    return `${os.platform()} ${os.release()}`.trim().slice(0, 80);
  } catch {
    return String(os.platform()).slice(0, 80);
  }
}

export function normalizeDetectedPrinters(names = []) {
  const seen = new Set();
  const out = [];
  for (const raw of names) {
    const name = String(raw || "").trim().slice(0, 200);
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
    if (out.length >= 50) break;
  }
  return out;
}

function asArray(payload) {
  if (payload == null) return [];
  return Array.isArray(payload) ? payload : [payload];
}

function normalizePortName(port) {
  return String(port || "").trim().toUpperCase();
}

export function looksLikeLocalDevicePort(port) {
  const p = normalizePortName(port);
  if (!p) return false;
  return (
    p.startsWith("USB") ||
    p.startsWith("DOT4") ||
    p.startsWith("LPT") ||
    p.startsWith("COM") ||
    p.includes("USB") ||
    p.startsWith("WSD")
  );
}

/** Win32_Printer.PrinterStatus numeric codes (CIM). */
const WMI_PRINTER_STATUS = Object.freeze({
  1: "Other",
  2: "Unknown",
  3: "Idle",
  4: "Printing",
  5: "Warmup",
  6: "StoppedPrinting",
  7: "Offline",
});

/** Win32_Printer.DetectedErrorState numeric codes (CIM). */
const WMI_DETECTED_ERROR = Object.freeze({
  0: "Unknown",
  1: "Other",
  2: "NoError",
  3: "LowPaper",
  4: "NoPaper",
  5: "LowToner",
  6: "NoToner",
  7: "DoorOpen",
  8: "Jammed",
  9: "Offline",
  10: "ServiceRequested",
  11: "OutputBinFull",
});

function emptyHealth(partial = {}) {
  const { now: nowOpt, ...rest } = partial || {};
  const now = nowOpt || new Date();
  const lastSeenRaw = rest.lastSeen || now;
  const lastSeen =
    typeof lastSeenRaw?.toISOString === "function"
      ? lastSeenRaw.toISOString()
      : String(lastSeenRaw || now.toISOString());
  return {
    name: "",
    printerFound: false,
    connected: false,
    status: "UNKNOWN",
    offline: true,
    paused: false,
    paperOut: false,
    doorOpen: false,
    queueLength: 0,
    statusMessage: "Printer status unknown",
    portName: "",
    online: false,
    ...rest,
    lastSeen,
  };
}

/**
 * Map combined Windows spooler/CIM signals to Marivolt printer health.
 * Pure function — unit-testable without Windows.
 *
 * @param {object|null} row
 *   Get-Printer: Name, PrinterStatus (string), JobCount, WorkOffline, PortName
 *   Optional CIM overlays: WmiPrinterStatus (number|string), DetectedErrorState (number|string)
 */
export function mapWindowsPrinterHealth(row, opts = {}) {
  const now = opts.now || new Date();
  const lastSeen = now.toISOString();

  if (!row || !String(row.Name || row.name || "").trim()) {
    return emptyHealth({
      now,
      lastSeen,
      status: "DISCONNECTED",
      statusMessage: "Printer not found in Windows printer list",
      printerFound: false,
      connected: false,
      online: false,
    });
  }

  const name = String(row.Name || row.name || "").trim().slice(0, 200);
  const portName = String(row.PortName || row.portName || "").slice(0, 120);
  const localPort = looksLikeLocalDevicePort(portName);
  const workOffline = Boolean(row.WorkOffline ?? row.workOffline);
  const queueLength = Math.max(0, Number(row.JobCount ?? row.jobCount ?? 0) || 0);

  const gpStatus = String(row.PrinterStatus || row.printerStatus || row.Status || "").trim();
  const gpKey = gpStatus.toLowerCase().replace(/\s+/g, "");

  let wmiStatusNum = row.WmiPrinterStatus ?? row.wmiPrinterStatus;
  if (typeof wmiStatusNum === "string" && /^\d+$/.test(wmiStatusNum)) wmiStatusNum = Number(wmiStatusNum);
  const wmiStatusLabel =
    typeof wmiStatusNum === "number"
      ? WMI_PRINTER_STATUS[wmiStatusNum] || String(wmiStatusNum)
      : String(row.WmiPrinterStatusLabel || "");

  let detectedErr = row.DetectedErrorState ?? row.detectedErrorState;
  if (typeof detectedErr === "string" && /^\d+$/.test(detectedErr)) detectedErr = Number(detectedErr);
  const detectedLabel =
    typeof detectedErr === "number"
      ? WMI_DETECTED_ERROR[detectedErr] || String(detectedErr)
      : String(row.DetectedErrorStateLabel || "");

  const wmiOffline =
    wmiStatusNum === 7 ||
    String(wmiStatusLabel).toLowerCase() === "offline" ||
    detectedErr === 9 ||
    String(detectedLabel).toLowerCase() === "offline";

  const paperOutSignal =
    detectedErr === 4 ||
    detectedErr === 3 ||
    gpKey === "paperout" ||
    gpKey === "nopaper" ||
    gpKey.includes("paperout") ||
    gpKey === "outofpaper" ||
    String(detectedLabel).toLowerCase() === "nopaper" ||
    String(detectedLabel).toLowerCase() === "lowpaper";

  const doorOpenSignal =
    detectedErr === 7 ||
    gpKey === "dooropen" ||
    gpKey.includes("dooropen") ||
    String(detectedLabel).toLowerCase() === "dooropen";

  const pausedSignal = gpKey === "paused" || gpKey.includes("paused");

  const errorSignal =
    detectedErr === 8 ||
    detectedErr === 10 ||
    detectedErr === 11 ||
    gpKey === "error" ||
    gpKey === "paperjam" ||
    gpKey === "paperproblem" ||
    gpKey === "userintervention" ||
    gpKey === "outofmemory" ||
    gpKey === "outputbinfull" ||
    gpKey === "jammed" ||
    String(detectedLabel).toLowerCase() === "jammed" ||
    String(detectedLabel).toLowerCase() === "servicerequested" ||
    String(detectedLabel).toLowerCase() === "outputbinfull";

  const notAvailableSignal =
    gpKey === "notavailable" ||
    gpKey === "serverunknown" ||
    gpKey === "pendingdeletion";

  const offlineSignal =
    workOffline ||
    wmiOffline ||
    gpKey === "offline" ||
    gpKey.includes("offline");

  let status = "UNKNOWN";
  let connected = true;
  let paused = false;
  let paperOut = false;
  let doorOpen = false;
  let offline = false;
  let statusMessage = gpStatus || wmiStatusLabel || detectedLabel || "Unknown";

  // Precedence 3 → 8 (query failure / missing handled by callers)
  if (offlineSignal) {
    if (localPort && !workOffline) {
      // USB/local device reporting offline is treated as physical disconnect
      status = "DISCONNECTED";
      connected = false;
      offline = true;
      statusMessage = workOffline
        ? "Printer marked Work Offline in Windows"
        : "Local/USB printer offline or disconnected";
    } else if (workOffline) {
      status = "OFFLINE";
      offline = true;
      connected = true;
      statusMessage = "Printer marked Work Offline in Windows";
    } else {
      status = "OFFLINE";
      offline = true;
      connected = !localPort;
      statusMessage = gpStatus || wmiStatusLabel || "Printer is offline";
    }
  } else if (pausedSignal) {
    status = "PAUSED";
    paused = true;
    statusMessage = "Printer is paused";
  } else if (paperOutSignal) {
    status = "PAPER_OUT";
    paperOut = true;
    offline = true;
    statusMessage = "Paper out / low paper (Windows signal)";
  } else if (doorOpenSignal) {
    status = "DOOR_OPEN";
    doorOpen = true;
    offline = true;
    statusMessage = "Door open (Windows signal)";
  } else if (errorSignal || notAvailableSignal) {
    if (notAvailableSignal && (localPort || !portName)) {
      status = "DISCONNECTED";
      connected = false;
      offline = true;
      statusMessage = "Printer device not available (likely disconnected)";
    } else {
      status = "ERROR";
      offline = true;
      statusMessage = gpStatus || detectedLabel || "Printer error";
    }
  } else if (
    !gpKey &&
    wmiStatusNum == null &&
    detectedErr == null
  ) {
    status = "UNKNOWN";
    statusMessage = "Printer status unknown";
  } else if (
    gpKey === "unknown" ||
    gpKey === "other" ||
    wmiStatusNum === 1 ||
    wmiStatusNum === 2
  ) {
    status = "UNKNOWN";
    statusMessage = gpStatus || wmiStatusLabel || "Printer status unknown";
  } else if (
    gpKey === "normal" ||
    gpKey === "idle" ||
    gpKey === "printing" ||
    gpKey === "busy" ||
    gpKey === "waiting" ||
    gpKey === "processing" ||
    gpKey === "initialization" ||
    gpKey === "initializing" ||
    gpKey === "warmingup" ||
    gpKey === "warmup" ||
    gpKey === "powersave" ||
    gpKey === "tonerlow" ||
    gpKey === "ioactive" ||
    gpKey === "manualfeed" ||
    wmiStatusNum === 3 ||
    wmiStatusNum === 4 ||
    wmiStatusNum === 5 ||
    detectedErr === 2 ||
    detectedErr === 5 ||
    detectedErr === 6
  ) {
    status = "READY";
    connected = true;
    offline = false;
    statusMessage = gpStatus || wmiStatusLabel || "Ready";
  } else {
    status = "UNKNOWN";
    statusMessage = gpStatus || wmiStatusLabel || detectedLabel || "Unrecognized printer status";
  }

  return {
    name,
    printerFound: true,
    connected,
    status,
    offline,
    paused,
    paperOut,
    doorOpen,
    queueLength,
    statusMessage: String(statusMessage).slice(0, 240),
    lastSeen,
    portName,
    online: status === "READY",
  };
}

/**
 * Merge Get-Printer rows with Win32_Printer CIM overlays (by name).
 * Does not interpolate names into shell — merge is in-process.
 */
export function mergePrinterProbeRows(getPrinterRows = [], wmiRows = [], opts = {}) {
  const now = opts.now || new Date();
  const wmiByName = new Map();
  for (const w of asArray(wmiRows)) {
    const n = String(w?.Name || w?.name || "").trim().toLowerCase();
    if (n) wmiByName.set(n, w);
  }
  const out = [];
  const seen = new Set();
  for (const gp of asArray(getPrinterRows)) {
    const name = String(gp?.Name || gp?.name || "").trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const wmi = wmiByName.get(key) || {};
    out.push(
      mapWindowsPrinterHealth(
        {
          Name: name,
          PrinterStatus: gp.PrinterStatus ?? gp.printerStatus,
          JobCount: gp.JobCount ?? gp.jobCount,
          WorkOffline: gp.WorkOffline ?? gp.workOffline ?? wmi.WorkOffline,
          PortName: gp.PortName ?? gp.portName ?? wmi.PortName,
          WmiPrinterStatus: wmi.PrinterStatus,
          DetectedErrorState: wmi.DetectedErrorState,
        },
        { now }
      )
    );
    if (out.length >= 50) break;
  }
  // Include WMI-only printers not returned by Get-Printer (rare)
  for (const [key, wmi] of wmiByName) {
    if (seen.has(key)) continue;
    const name = String(wmi.Name || wmi.name || "").trim();
    if (!name) continue;
    out.push(
      mapWindowsPrinterHealth(
        {
          Name: name,
          PrinterStatus: WMI_PRINTER_STATUS[wmi.PrinterStatus] || "",
          JobCount: 0,
          WorkOffline: wmi.WorkOffline,
          PortName: wmi.PortName,
          WmiPrinterStatus: wmi.PrinterStatus,
          DetectedErrorState: wmi.DetectedErrorState,
        },
        { now }
      )
    );
    if (out.length >= 50) break;
  }
  return out;
}

/**
 * Build health for a configured queue name against detected rows.
 * Missing queue → DISCONNECTED. Query failure → UNKNOWN.
 */
export function resolveConfiguredPrinterHealth(configuredName, healthRows = [], opts = {}) {
  const want = String(configuredName || "").trim().toLowerCase();
  const now = opts.now || new Date();
  const lastSeen = now.toISOString();
  if (opts.queryFailed) {
    return emptyHealth({
      now,
      lastSeen,
      name: String(configuredName || "").trim().slice(0, 200),
      status: "UNKNOWN",
      statusMessage: opts.queryError || "Windows printer query failed",
      printerFound: false,
      connected: false,
      online: false,
    });
  }
  if (!want) {
    return emptyHealth({
      now,
      lastSeen,
      status: "UNKNOWN",
      statusMessage: "No windowsPrinterName configured",
      printerFound: false,
      connected: false,
      online: false,
    });
  }
  const match = (healthRows || []).find((h) => String(h.name || "").toLowerCase() === want);
  if (match) return { ...match, name: match.name || configuredName };
  return emptyHealth({
    now,
    lastSeen,
    name: String(configuredName).trim().slice(0, 200),
    status: "DISCONNECTED",
    statusMessage: "Configured printer not found in Windows printer list",
    printerFound: false,
    connected: false,
    online: false,
    offline: true,
  });
}

/** List installed Windows printers via PowerShell (empty on non-Windows). */
export async function detectWindowsPrinters() {
  const { rows } = await probeWindowsPrinterHealth();
  return normalizeDetectedPrinters(rows.map((h) => h.name));
}

/**
 * Query Windows spooler + CIM for printer readiness.
 * Uses fixed PowerShell (no interpolated printer names → no injection).
 * Returns { ok, rows, error }.
 */
export async function probeWindowsPrinterHealth() {
  if (process.platform !== "win32") {
    return { ok: false, rows: [], error: "not-windows" };
  }
  try {
    // Fixed script only — never interpolate untrusted names into -Command text.
    const ps = [
      "$ErrorActionPreference='Stop'",
      "$gp = @(Get-Printer | Select-Object Name,PrinterStatus,JobCount,WorkOffline,PortName)",
      "$wmi = @()",
      "try { $wmi = @(Get-CimInstance -ClassName Win32_Printer -ErrorAction Stop | Select-Object Name,PrinterStatus,DetectedErrorState,WorkOffline,PortName) } catch { $wmi = @() }",
      "@{ getPrinter = $gp; wmi = $wmi } | ConvertTo-Json -Compress -Depth 5",
    ].join("; ");
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", ps],
      { windowsHide: true, timeout: 12000, maxBuffer: 2 * 1024 * 1024 }
    );
    const text = String(stdout || "").trim();
    if (!text) return { ok: false, rows: [], error: "empty-output" };
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { ok: false, rows: [], error: "malformed-json" };
    }
    const now = new Date();
    const rows = mergePrinterProbeRows(parsed.getPrinter || parsed.GetPrinter, parsed.wmi || parsed.Wmi, {
      now,
    });
    return { ok: true, rows, error: "" };
  } catch (e) {
    const msg = String(e?.message || e || "query-failed").slice(0, 200);
    const timedOut = /TIMEOUT|ETIMEDOUT/i.test(msg) || e?.killed;
    return { ok: false, rows: [], error: timedOut ? "timeout" : msg };
  }
}

/** @deprecated use probeWindowsPrinterHealth — kept for callers expecting an array */
export async function detectWindowsPrinterHealth() {
  const { rows } = await probeWindowsPrinterHealth();
  return rows;
}

export async function collectHostProfile(opts = {}) {
  const probe = await probeWindowsPrinterHealth();
  const availablePrinters = normalizeDetectedPrinters(probe.rows.map((h) => h.name));
  const configured = opts.windowsPrinterName
    ? resolveConfiguredPrinterHealth(opts.windowsPrinterName, probe.rows, {
        queryFailed: !probe.ok,
        queryError: probe.error,
      })
    : null;
  return {
    computerName: detectComputerName(),
    operatingSystem: detectOperatingSystem(),
    windowsVersion: detectWindowsVersion(),
    availablePrinters,
    printerHealth: probe.rows,
    printerProbeOk: probe.ok,
    printerProbeError: probe.error || "",
    configuredPrinter: configured,
  };
}
