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
 * 3. USB/local PnP device absent → DISCONNECTED
 * 4. WorkOffline / Windows Offline → OFFLINE (USB Offline → DISCONNECTED)
 * 5. Paused → PAUSED
 * 6. Paper out (reliable signal only) → PAPER_OUT
 * 7. Door open (reliable signal only) → DOOR_OPEN
 * 8. Error / jammed / intervention → ERROR
 * 9. Otherwise idle/printing/... → READY
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

/** Winspool PrinterState bit flags (Win32_Printer.PrinterState). */
export const PRINTER_STATE = Object.freeze({
  PAUSED: 0x00000001,
  ERROR: 0x00000002,
  PENDING_DELETION: 0x00000004,
  PAPER_JAM: 0x00000008,
  PAPER_OUT: 0x00000010,
  MANUAL_FEED: 0x00000020,
  PAPER_PROBLEM: 0x00000040,
  OFFLINE: 0x00000080,
  IO_ACTIVE: 0x00000100,
  BUSY: 0x00000200,
  PRINTING: 0x00000400,
  OUTPUT_BIN_FULL: 0x00000800,
  NOT_AVAILABLE: 0x00001000,
  WAITING: 0x00002000,
  PROCESSING: 0x00004000,
  INITIALIZING: 0x00008000,
  WARMING_UP: 0x00010000,
  TONER_LOW: 0x00020000,
  NO_TONER: 0x00040000,
  USER_INTERVENTION: 0x00100000,
  OUT_OF_MEMORY: 0x00200000,
  DOOR_OPEN: 0x00400000,
});

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
    queueInstalled: false,
    connected: false,
    status: "UNKNOWN",
    offline: true,
    paused: false,
    paperOut: false,
    doorOpen: false,
    queueLength: 0,
    statusMessage: "Printer status unknown",
    portName: "",
    windowsStatus: "",
    usbDevicePresent: null,
    online: false,
    ...rest,
    lastSeen,
  };
}

/**
 * Determine whether a USB/local PnP printer device appears present.
 * Returns true | false | null (null = not applicable or inconclusive).
 *
 * Prefer USBPRINT/DOT4PRINT Status. An empty PnP list is inconclusive — many
 * drivers leave the queue installed; absence of USBPRINT OK is the strong signal.
 */
export function resolveUsbDevicePresent(printerName, portName, pnpDevices, opts = {}) {
  if (!looksLikeLocalDevicePort(portName)) return null;
  if (!Array.isArray(pnpDevices)) return null;
  if (opts.pnpQueryFailed) return null;

  const want = String(printerName || "")
    .trim()
    .toLowerCase();
  const rows = pnpDevices
    .map((d) => ({
      friendlyName: String(d?.FriendlyName || d?.friendlyName || d?.Name || "").trim(),
      instanceId: String(d?.InstanceId || d?.instanceId || d?.DeviceID || "").trim(),
      status: String(d?.Status || d?.status || "").trim().toUpperCase(),
      className: String(d?.Class || d?.class || d?.PNPClass || "").trim(),
    }))
    .filter((d) => d.friendlyName || d.instanceId);

  if (!rows.length) return null;

  const isOk = (d) => d.status === "OK";
  const isPrintIface = (d) => /USBPRINT|DOT4PRINT/i.test(d.instanceId);
  const isPrinterClass = (d) => /^Printer$/i.test(d.className) || /print/i.test(d.friendlyName);

  if (want) {
    const named = rows.filter((d) => {
      const fn = d.friendlyName.toLowerCase();
      return fn && (fn === want || fn.includes(want) || want.includes(fn));
    });
    const namedPrint = named.filter((d) => isPrintIface(d) || isPrinterClass(d));
    if (namedPrint.length) {
      if (namedPrint.some(isOk)) return true;
      return false;
    }
  }

  const usbPrint = rows.filter(isPrintIface);
  if (usbPrint.length) {
    if (usbPrint.some(isOk)) return usbPrint.length === 1 ? true : null;
    return false;
  }

  // No USBPRINT/DOT4 interfaces observed — inconclusive for this driver/port.
  return null;
}

/**
 * Map combined Windows spooler/CIM/PnP signals to Marivolt printer health.
 * Pure function — unit-testable without Windows.
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
      queueInstalled: false,
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

  let availability = row.Availability ?? row.availability;
  if (typeof availability === "string" && /^\d+$/.test(availability)) availability = Number(availability);

  let printerState = row.PrinterState ?? row.printerState ?? 0;
  if (typeof printerState === "string" && /^\d+$/.test(printerState)) printerState = Number(printerState);
  printerState = Number(printerState) || 0;

  let usbDevicePresent = row.usbDevicePresent;
  if (usbDevicePresent === undefined) {
    usbDevicePresent = resolveUsbDevicePresent(name, portName, opts.pnpDevices, {
      pnpQueryFailed: opts.pnpQueryFailed,
    });
  }
  if (usbDevicePresent !== true && usbDevicePresent !== false) usbDevicePresent = usbDevicePresent == null ? null : Boolean(usbDevicePresent);

  const windowsStatus =
    gpStatus ||
    wmiStatusLabel ||
    (availability != null ? `Availability=${availability}` : "") ||
    detectedLabel ||
    "";

  const stateOffline = Boolean(printerState & PRINTER_STATE.OFFLINE);
  const statePaused = Boolean(printerState & PRINTER_STATE.PAUSED);
  const statePaperOut = Boolean(printerState & PRINTER_STATE.PAPER_OUT);
  const stateDoorOpen = Boolean(printerState & PRINTER_STATE.DOOR_OPEN);
  const stateError = Boolean(
    printerState &
      (PRINTER_STATE.ERROR |
        PRINTER_STATE.PAPER_JAM |
        PRINTER_STATE.PAPER_PROBLEM |
        PRINTER_STATE.USER_INTERVENTION |
        PRINTER_STATE.OUT_OF_MEMORY |
        PRINTER_STATE.OUTPUT_BIN_FULL)
  );
  const stateNotAvailable = Boolean(printerState & PRINTER_STATE.NOT_AVAILABLE);

  // Availability: 7 Power Off, 8 Off Line
  const availabilityOffline = availability === 7 || availability === 8;

  const wmiOffline =
    wmiStatusNum === 7 ||
    String(wmiStatusLabel).toLowerCase() === "offline" ||
    detectedErr === 9 ||
    String(detectedLabel).toLowerCase() === "offline" ||
    stateOffline ||
    availabilityOffline;

  const paperOutSignal =
    statePaperOut ||
    detectedErr === 4 ||
    detectedErr === 3 ||
    gpKey === "paperout" ||
    gpKey === "nopaper" ||
    gpKey.includes("paperout") ||
    gpKey === "outofpaper" ||
    String(detectedLabel).toLowerCase() === "nopaper" ||
    String(detectedLabel).toLowerCase() === "lowpaper";

  const doorOpenSignal =
    stateDoorOpen ||
    detectedErr === 7 ||
    gpKey === "dooropen" ||
    gpKey.includes("dooropen") ||
    String(detectedLabel).toLowerCase() === "dooropen";

  const pausedSignal = statePaused || gpKey === "paused" || gpKey.includes("paused");

  const errorSignal =
    stateError ||
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
    stateNotAvailable ||
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
  let statusMessage = windowsStatus || "Unknown";

  // USB/local queue with confirmed absent PnP device — never READY.
  if (localPort && usbDevicePresent === false) {
    return {
      name,
      printerFound: true,
      queueInstalled: true,
      connected: false,
      status: "DISCONNECTED",
      offline: true,
      paused: false,
      paperOut: false,
      doorOpen: false,
      queueLength,
      statusMessage: "USB/local device not present (queue remains installed)",
      lastSeen,
      portName,
      windowsStatus,
      usbDevicePresent: false,
      online: false,
    };
  }

  // Precedence: offline → paused → paper → door → error → ready/unknown
  if (offlineSignal) {
    if (localPort && !workOffline) {
      status = "DISCONNECTED";
      connected = false;
      offline = true;
      statusMessage = "Local/USB printer offline or disconnected";
    } else if (workOffline) {
      status = "OFFLINE";
      offline = true;
      connected = true;
      statusMessage = "Printer marked Work Offline in Windows";
    } else {
      status = "OFFLINE";
      offline = true;
      connected = !localPort;
      statusMessage = windowsStatus || "Printer is offline";
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
  } else if (!gpKey && wmiStatusNum == null && detectedErr == null && !printerState) {
    status = "UNKNOWN";
    statusMessage = "Printer status unknown";
  } else if (gpKey === "unknown" || gpKey === "other" || wmiStatusNum === 1 || wmiStatusNum === 2) {
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
    detectedErr === 6 ||
    Boolean(
      printerState &
        (PRINTER_STATE.PRINTING |
          PRINTER_STATE.BUSY |
          PRINTER_STATE.IO_ACTIVE |
          PRINTER_STATE.WARMING_UP |
          PRINTER_STATE.PROCESSING |
          PRINTER_STATE.WAITING |
          PRINTER_STATE.INITIALIZING)
    )
  ) {
    // Optional strict mode (verify CLI): local queue without confirmed PnP → UNKNOWN, never false READY.
    if (localPort && usbDevicePresent !== true && opts.requireUsbPresenceForReady) {
      status = "UNKNOWN";
      connected = null;
      offline = true;
      statusMessage =
        "Queue reports ready but USB/PnP presence could not be confirmed (driver may not expose disconnect)";
    } else {
      status = "READY";
      connected = true;
      offline = false;
      statusMessage = gpStatus || wmiStatusLabel || "Ready";
    }
  } else {
    status = "UNKNOWN";
    statusMessage = gpStatus || wmiStatusLabel || detectedLabel || "Unrecognized printer status";
  }

  return {
    name,
    printerFound: true,
    queueInstalled: true,
    connected: connected === null ? null : Boolean(connected),
    status,
    offline,
    paused,
    paperOut,
    doorOpen,
    queueLength,
    statusMessage: String(statusMessage).slice(0, 240),
    lastSeen,
    portName,
    windowsStatus,
    usbDevicePresent,
    online: status === "READY",
  };
}

/**
 * Merge Get-Printer rows with Win32_Printer CIM overlays + PnP presence (by name).
 * Does not interpolate names into shell — merge is in-process.
 */
export function mergePrinterProbeRows(getPrinterRows = [], wmiRows = [], opts = {}) {
  const now = opts.now || new Date();
  const pnpDevices = asArray(opts.pnpDevices);
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
    const portName = gp.PortName ?? gp.portName ?? wmi.PortName;
    out.push(
      mapWindowsPrinterHealth(
        {
          Name: name,
          PrinterStatus: gp.PrinterStatus ?? gp.printerStatus,
          JobCount: gp.JobCount ?? gp.jobCount,
          WorkOffline: gp.WorkOffline ?? gp.workOffline ?? wmi.WorkOffline,
          PortName: portName,
          WmiPrinterStatus: wmi.PrinterStatus,
          DetectedErrorState: wmi.DetectedErrorState,
          Availability: wmi.Availability,
          PrinterState: wmi.PrinterState,
        },
        {
          now,
          pnpDevices,
          pnpChecked: opts.pnpChecked !== false,
          pnpQueryFailed: Boolean(opts.pnpQueryFailed),
        }
      )
    );
    if (out.length >= 50) break;
  }
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
          Availability: wmi.Availability,
          PrinterState: wmi.PrinterState,
        },
        {
          now,
          pnpDevices,
          pnpChecked: opts.pnpChecked !== false,
          pnpQueryFailed: Boolean(opts.pnpQueryFailed),
        }
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
      queueInstalled: null,
      connected: null,
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
      queueInstalled: false,
      connected: false,
      online: false,
    });
  }
  const match = (healthRows || []).find((h) => String(h.name || "").toLowerCase() === want);
  if (match) {
    return {
      ...match,
      name: match.name || configuredName,
      queueInstalled: match.queueInstalled !== false,
      printerFound: true,
    };
  }
  return emptyHealth({
    now,
    lastSeen,
    name: String(configuredName).trim().slice(0, 200),
    status: "DISCONNECTED",
    statusMessage: "Configured printer not found in Windows printer list",
    printerFound: false,
    queueInstalled: false,
    connected: false,
    online: false,
    offline: true,
  });
}

function yesNoUnknown(v) {
  if (v === true) return "YES";
  if (v === false) return "NO";
  return "UNKNOWN";
}

/**
 * Format service:verify-printer report lines from shared health.
 * Does not claim physical presence from queue existence alone.
 */
export function formatVerifyPrinterReport({ configuredName, health, queryFailed = false } = {}) {
  const h = health || emptyHealth({ name: configuredName || "" });
  const queueInstalled = h.queueInstalled;
  const status = String(h.status || "UNKNOWN").toUpperCase();
  const connectedLabel =
    h.connected === true ? "YES" : h.connected === false ? "NO" : "UNKNOWN";

  let result;
  let exitCode = 0;
  if (!String(configuredName || "").trim()) {
    result = "NO CONFIGURED PRINTER";
    exitCode = 2;
  } else if (queryFailed || status === "UNKNOWN") {
    if (queueInstalled === true) {
      result = "PRINTER QUEUE EXISTS, PHYSICAL STATE UNKNOWN";
      exitCode = 4;
    } else if (queueInstalled === false) {
      result = "PRINTER QUEUE NOT FOUND";
      exitCode = 3;
    } else {
      result = "PRINTER QUEUE EXISTS, PHYSICAL STATE UNKNOWN";
      exitCode = 4;
    }
  } else if (queueInstalled === false || status === "DISCONNECTED" && h.printerFound === false) {
    result = "PRINTER QUEUE NOT FOUND";
    exitCode = 3;
  } else if (status === "READY") {
    result = "PRINTER READY";
    exitCode = 0;
  } else if (status === "DISCONNECTED" || status === "OFFLINE") {
    result = "PRINTER QUEUE EXISTS, PHYSICAL DEVICE UNAVAILABLE";
    exitCode = 5;
  } else if (status === "PAUSED") {
    result = "PRINTER QUEUE EXISTS, PHYSICAL DEVICE PAUSED";
    exitCode = 6;
  } else if (status === "PAPER_OUT" || status === "DOOR_OPEN" || status === "ERROR") {
    result = `PRINTER QUEUE EXISTS, PHYSICAL DEVICE ${status}`;
    exitCode = 7;
  } else {
    result = "PRINTER QUEUE EXISTS, PHYSICAL STATE UNKNOWN";
    exitCode = 4;
  }

  // Never use the misleading legacy label.
  if (/PRINTER DETECTED/i.test(result)) {
    result = "PRINTER QUEUE EXISTS, PHYSICAL STATE UNKNOWN";
    exitCode = 4;
  }

  const lines = [
    `Configured printer: ${configuredName || "(none)"}`,
    `Queue installed: ${yesNoUnknown(queueInstalled)}`,
    `Physical status: ${status}`,
    `Connected: ${connectedLabel}`,
  ];
  if (h.portName) lines.push(`Port: ${h.portName}`);
  if (h.windowsStatus) lines.push(`Windows status: ${h.windowsStatus}`);
  if (h.offline != null) lines.push(`Offline: ${yesNoUnknown(Boolean(h.offline))}`);
  if (h.paused) lines.push(`Paused: YES`);
  if (h.paperOut) lines.push(`Paper out: YES`);
  if (h.doorOpen) lines.push(`Door open: YES`);
  if (h.queueLength != null) lines.push(`Queue length: ${Number(h.queueLength) || 0}`);
  if (h.statusMessage) lines.push(`Status message: ${h.statusMessage}`);
  if (h.lastSeen) lines.push(`Last seen: ${h.lastSeen}`);
  if (h.usbDevicePresent === true) lines.push(`USB/PnP device: PRESENT`);
  if (h.usbDevicePresent === false) lines.push(`USB/PnP device: ABSENT`);
  lines.push(`Result: ${result}`);

  return { lines, result, exitCode, health: h };
}

/** List installed Windows printers via PowerShell (empty on non-Windows). */
export async function detectWindowsPrinters() {
  const { rows } = await probeWindowsPrinterHealth();
  return normalizeDetectedPrinters(rows.map((h) => h.name));
}

/**
 * Query Windows spooler + CIM + PnP for printer readiness.
 * Uses fixed PowerShell (no interpolated printer names → no injection).
 * Returns { ok, rows, error, pnpChecked }.
 */
export async function probeWindowsPrinterHealth() {
  const wallStarted = Date.now();
  if (process.platform !== "win32") {
    return {
      ok: false,
      rows: [],
      error: "not-windows",
      pnpChecked: false,
      timing: { totalMs: Date.now() - wallStarted, powershellSpawnMs: 0 },
    };
  }
  try {
    // Fixed script only — never interpolate untrusted names into -Command text.
    // Phase timings are diagnostic only (measurement); output shape still includes getPrinter/wmi/pnp.
    const ps = [
      "$ErrorActionPreference='Stop'",
      "$sw = [System.Diagnostics.Stopwatch]::StartNew()",
      "$tGet = 0; $tWmi = 0; $tPnp = 0",
      "$sw.Restart(); $gp = @(Get-Printer | Select-Object Name,PrinterStatus,JobCount,WorkOffline,PortName); $tGet = $sw.ElapsedMilliseconds",
      "$wmi = @()",
      "$sw.Restart(); try { $wmi = @(Get-CimInstance -ClassName Win32_Printer -ErrorAction Stop | Select-Object Name,PrinterStatus,DetectedErrorState,WorkOffline,PortName,Availability,PrinterState) } catch { $wmi = @() }; $tWmi = $sw.ElapsedMilliseconds",
      "$pnp = @()",
      "$pnpFailed = $false",
      "$sw.Restart()",
      "try { $pnp = @(Get-PnpDevice -ErrorAction SilentlyContinue | Where-Object { $_.InstanceId -match 'USBPRINT|DOT4PRINT' -or $_.Class -in @('Printer','USB','USBDevice') -or $_.FriendlyName -match 'print|Rongta|RP4' } | Select-Object FriendlyName,InstanceId,Status,Class) } catch { $pnpFailed = $true; $pnp = @() }",
      "if (-not $pnp) { try { $pnp = @(Get-CimInstance Win32_PnPEntity -ErrorAction SilentlyContinue | Where-Object { $_.DeviceID -match 'USBPRINT|DOT4PRINT' -or $_.PNPClass -in @('Printer','USB') } | Select-Object @{N='FriendlyName';E={$_.Name}}, @{N='InstanceId';E={$_.DeviceID}}, Status, @{N='Class';E={$_.PNPClass}}) } catch { $pnpFailed = $true } }",
      "$tPnp = $sw.ElapsedMilliseconds",
      "@{ getPrinter = $gp; wmi = $wmi; pnp = $pnp; pnpFailed = $pnpFailed; timing = @{ getPrinterMs = $tGet; cimWmiMs = $tWmi; pnpMs = $tPnp } } | ConvertTo-Json -Compress -Depth 6",
    ].join("; ");
    const spawnStarted = Date.now();
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", ps],
      { windowsHide: true, timeout: 15000, maxBuffer: 3 * 1024 * 1024 }
    );
    const powershellWallMs = Date.now() - spawnStarted;
    const text = String(stdout || "").trim();
    if (!text) {
      return {
        ok: false,
        rows: [],
        error: "empty-output",
        pnpChecked: false,
        timing: { totalMs: Date.now() - wallStarted, powershellSpawnMs: powershellWallMs },
      };
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return {
        ok: false,
        rows: [],
        error: "malformed-json",
        pnpChecked: false,
        timing: { totalMs: Date.now() - wallStarted, powershellSpawnMs: powershellWallMs },
      };
    }
    const now = new Date();
    const pnpFailed = Boolean(parsed.pnpFailed || parsed.PnpFailed);
    const rows = mergePrinterProbeRows(parsed.getPrinter || parsed.GetPrinter, parsed.wmi || parsed.Wmi, {
      now,
      pnpDevices: parsed.pnp || parsed.Pnp || [],
      pnpChecked: true,
      pnpQueryFailed: pnpFailed,
    });
    const phase = parsed.timing || parsed.Timing || {};
    const getPrinterMs = Number(phase.getPrinterMs ?? phase.GetPrinterMs) || 0;
    const cimWmiMs = Number(phase.cimWmiMs ?? phase.CimWmiMs) || 0;
    const pnpMs = Number(phase.pnpMs ?? phase.PnpMs) || 0;
    const scriptPhasesMs = getPrinterMs + cimWmiMs + pnpMs;
    const timing = {
      totalMs: Date.now() - wallStarted,
      powershellSpawnMs: powershellWallMs,
      getPrinterMs,
      cimWmiMs,
      pnpMs,
      /** Approximate PowerShell process overhead = wall PS time minus internal phase sum. */
      powershellOverheadMs: Math.max(0, powershellWallMs - scriptPhasesMs),
    };
    return { ok: true, rows, error: "", pnpChecked: true, pnpQueryFailed: pnpFailed, timing };
  } catch (e) {
    const msg = String(e?.message || e || "query-failed").slice(0, 200);
    const timedOut = /TIMEOUT|ETIMEDOUT/i.test(msg) || e?.killed;
    return {
      ok: false,
      rows: [],
      error: timedOut ? "timeout" : msg,
      pnpChecked: false,
      timing: { totalMs: Date.now() - wallStarted, powershellSpawnMs: Date.now() - wallStarted },
    };
  }
}

/** @deprecated use probeWindowsPrinterHealth — kept for callers expecting an array */
export async function detectWindowsPrinterHealth() {
  const { rows } = await probeWindowsPrinterHealth();
  return rows;
}

/**
 * Verify configured printer using the shared physical-health probe.
 */
export async function verifyConfiguredPrinter(configuredName) {
  const probe = await probeWindowsPrinterHealth();
  const health = resolveConfiguredPrinterHealth(configuredName, probe.rows, {
    queryFailed: !probe.ok,
    queryError: probe.error,
  });
  return formatVerifyPrinterReport({
    configuredName,
    health,
    queryFailed: !probe.ok,
  });
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
