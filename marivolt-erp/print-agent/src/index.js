import { ensureConfigured, getConfigDir, loadConfig, logLine } from "./config.js";
import {
  collectHostProfile,
  probeWindowsPrinterHealth,
  resolveConfiguredPrinterHealth,
} from "./detect.js";
import { createTransport } from "./adapters/windowsRawSpooler.js";
import { createJobProcessor } from "./jobProcessor.js";
import { acquireAgentProcessLock } from "./printSafety.js";

const APP_VERSION = "1.4.0";

/** Set by SIGINT/SIGTERM / Windows service stop — stop leasing new jobs. */
let shuttingDown = false;
let inJob = false;

function requestShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logLine(`Shutdown requested (${signal || "signal"})`, { event: "shutdown" });
}

process.on("SIGINT", () => requestShutdown("SIGINT"));
process.on("SIGTERM", () => requestShutdown("SIGTERM"));

async function api(cfg, method, path, body) {
  const url = `${cfg.backendUrl}${path}`;
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (shuttingDown && method === "POST" && path.includes("/lease")) {
      throw new Error("Shutdown in progress — not leasing");
    }
    try {
      const res = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${cfg.secret}`,
          "X-Print-Agent-Id": cfg.agentId,
          "Content-Type": "application/json",
        },
        body: body != null ? JSON.stringify(body) : undefined,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const err = new Error(data.message || `HTTP ${res.status}`);
        err.status = res.status;
        err.code = data.code;
        throw err;
      }
      return data;
    } catch (e) {
      lastErr = e;
      logLine(`API ${method} ${path} attempt ${attempt} failed: ${e.message}`, {
        level: "error",
        event: "api",
      });
      await sleep(1000 * attempt);
    }
  }
  throw lastErr;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function toHeartbeatPrinterRow(h) {
  return {
    name: h.name,
    online: Boolean(h.online),
    connected: Boolean(h.connected),
    status: h.status || "UNKNOWN",
    offline: Boolean(h.offline),
    paused: Boolean(h.paused),
    paperOut: Boolean(h.paperOut),
    doorOpen: Boolean(h.doorOpen),
    queueLength: Number(h.queueLength) || 0,
    statusMessage: h.statusMessage || "",
    lastSeen: h.lastSeen || new Date().toISOString(),
    printerFound: h.printerFound !== false,
  };
}

function createAgentJobProcessor(cfg, transport) {
  return createJobProcessor({
    log: logLine,
    getPrinterHealth: async (printerName) => {
      const name = String(printerName || cfg.windowsPrinterName || "").trim();
      const probe = await probeWindowsPrinterHealth();
      return resolveConfiguredPrinterHealth(name, probe.rows || [], {
        queryFailed: !probe.ok,
        queryError: probe.error,
      });
    },
    leaseNext: async () => {
      const leased = await api(cfg, "POST", "/api/labels/agent/lease", {});
      const job = leased?.job;
      if (job) logLine(`Leased job ${job.jobNo} (${job.id})`, { event: "job_leased" });
      return job || null;
    },
    releaseLease: async (job) => {
      await api(cfg, "POST", `/api/labels/agent/jobs/${job.id}/release`, {
        leaseToken: job.leaseToken,
      });
    },
    markPrinting: async (job) => {
      await api(cfg, "POST", `/api/labels/agent/jobs/${job.id}/printing`, {
        leaseToken: job.leaseToken,
      });
    },
    reportResult: async (job, outcome) => {
      await api(cfg, "POST", `/api/labels/agent/jobs/${job.id}/result`, {
        status: outcome.status,
        printedQty: outcome.printedQty,
        error: outcome.error || "",
        leaseToken: job.leaseToken,
      });
      const event =
        outcome.status === "COMPLETED"
          ? "job_completed"
          : outcome.status === "UNCERTAIN"
            ? "job_uncertain"
            : "job_failed";
      logLine(`${outcome.status} job ${job.jobNo}${outcome.error ? `: ${outcome.error}` : ""}`, {
        event,
        level: outcome.status === "COMPLETED" ? "info" : "error",
      });
    },
    printRaw: async (buf, printerName, opts) => {
      logLine(`Print submitted to spooler for ${opts?.documentName || printerName} → ${printerName}`, {
        event: "print_submitted",
      });
      return transport.printRaw(buf, printerName, opts);
    },
  });
}

async function processOneJob(processor) {
  if (shuttingDown) return false;
  inJob = true;
  try {
    return await processor.processOne();
  } catch (e) {
    logLine(`Job cycle failed: ${e.message}`, { level: "error", event: "job_failed" });
    return true;
  } finally {
    inJob = false;
  }
}

async function sendHeartbeat(cfg) {
  let profile = {
    computerName: "",
    operatingSystem: "",
    windowsVersion: "",
    availablePrinters: [],
    printerHealth: [],
    configuredPrinter: null,
    printerProbeOk: false,
    printerProbeError: "",
  };
  try {
    profile = await collectHostProfile({ windowsPrinterName: cfg.windowsPrinterName });
  } catch (e) {
    logLine(`Host detect warning: ${e.message}`, { level: "error", event: "detect" });
    profile.printerProbeOk = false;
    profile.printerProbeError = String(e?.message || e).slice(0, 200);
  }

  const probeFailed = profile.printerProbeOk === false;
  const printerStatus = (profile.printerHealth || []).map(toHeartbeatPrinterRow);
  if (cfg.windowsPrinterName) {
    const configured =
      profile.configuredPrinter ||
      resolveConfiguredPrinterHealth(cfg.windowsPrinterName, profile.printerHealth || [], {
        queryFailed: probeFailed,
        queryError: profile.printerProbeError,
      });
    const key = String(configured.name || "").toLowerCase();
    if (key && !printerStatus.some((r) => String(r.name).toLowerCase() === key)) {
      printerStatus.unshift(toHeartbeatPrinterRow(configured));
    }
  }

  const primary =
    profile.configuredPrinter ||
    (cfg.windowsPrinterName
      ? resolveConfiguredPrinterHealth(cfg.windowsPrinterName, profile.printerHealth || [], {
          queryFailed: probeFailed,
          queryError: profile.printerProbeError,
        })
      : null);

  await api(cfg, "POST", "/api/labels/agent/heartbeat", {
    computerName: profile.computerName,
    appVersion: APP_VERSION,
    operatingSystem: profile.operatingSystem,
    windowsVersion: profile.windowsVersion,
    availablePrinters: profile.availablePrinters,
    printerStatus,
    printer: primary
      ? {
          name: primary.name,
          connected: Boolean(primary.connected),
          status: primary.status || "UNKNOWN",
          offline: Boolean(primary.offline),
          paused: Boolean(primary.paused),
          paperOut: Boolean(primary.paperOut),
          queueLength: Number(primary.queueLength) || 0,
          statusMessage: primary.statusMessage || "",
          lastSeen: primary.lastSeen || new Date().toISOString(),
        }
      : undefined,
    agentStatus: "ONLINE",
  });

  const pStatus = primary?.status || "UNKNOWN";
  logLine(
    `Heartbeat ok agent=${cfg.agentId} version=${APP_VERSION} computer=${profile.computerName} printer=${primary?.name || "(none)"} printerStatus=${pStatus}`,
    { event: "heartbeat" }
  );
  if (primary && primary.status !== "READY") {
    logLine(
      `Printer health: status=${primary.status} connected=${Boolean(primary.connected)} msg=${primary.statusMessage || ""}`,
      {
        level: primary.status === "DISCONNECTED" || primary.status === "ERROR" ? "error" : "info",
        event: "printer_health",
      }
    );
  }
}

async function checkConfiguredPrinter(cfg) {
  try {
    const probe = await probeWindowsPrinterHealth();
    const primary = resolveConfiguredPrinterHealth(cfg.windowsPrinterName, probe.rows, {
      queryFailed: !probe.ok,
      queryError: probe.error,
    });
    if (!cfg.windowsPrinterName) {
      logLine("No windowsPrinterName configured", { event: "printer_check" });
      return;
    }
    if (primary.printerFound && primary.status === "READY") {
      logLine(`Configured printer READY: ${cfg.windowsPrinterName}`, { event: "printer_check" });
    } else if (!primary.printerFound || primary.status === "DISCONNECTED") {
      logLine(
        `PRINTER UNAVAILABLE / DISCONNECTED: configured "${cfg.windowsPrinterName}" (agent remains ONLINE; ${primary.statusMessage})`,
        { level: "error", event: "printer_unavailable" }
      );
    } else {
      logLine(
        `Configured printer status=${primary.status}: ${cfg.windowsPrinterName} (${primary.statusMessage})`,
        { level: "error", event: "printer_check" }
      );
    }
  } catch (e) {
    logLine(`Printer check failed: ${e.message}`, { level: "error", event: "printer_check" });
  }
}

async function loop() {
  let cfg;
  try {
    cfg = await ensureConfigured();
  } catch (e) {
    try {
      cfg = loadConfig();
    } catch {
      console.error(e.message || e);
      console.error("First-launch registration failed. Set config.json or run interactively.");
      process.exit(1);
    }
  }

  logLine(`Config loaded agent=${cfg.agentId} backend=${cfg.backendUrl}`, { event: "config_loaded" });

  let processLock;
  try {
    processLock = acquireAgentProcessLock(getConfigDir(), cfg.agentId);
  } catch (e) {
    logLine(e.message || String(e), { level: "error", event: "agent_lock" });
    process.exit(1);
  }

  await checkConfiguredPrinter(cfg);

  const transport = createTransport(cfg.connectionType);
  const processor = createAgentJobProcessor(cfg, transport);
  logLine(
    `Marivolt Print Agent ${APP_VERSION} starting. Backend=${cfg.backendUrl} agent=${cfg.agentId}`,
    { event: "service_started" }
  );

  while (!shuttingDown) {
    try {
      await sendHeartbeat(cfg);
      let worked = true;
      while (worked && !shuttingDown) {
        worked = await processOneJob(processor);
      }
    } catch (e) {
      if (shuttingDown) break;
      logLine(`Loop error: ${e.message}`, { level: "error", event: "loop" });
      if (/fetch failed|ECONNREFUSED|ENOTFOUND|network|HTTP 5/i.test(e.message || "")) {
        logLine("Backend unavailable — will retry", { level: "error", event: "backend_unavailable" });
      }
    }
    if (shuttingDown) break;
    await sleep(cfg.pollIntervalMs);
  }

  const waitUntil = Date.now() + 40_000;
  while (inJob && Date.now() < waitUntil) {
    await sleep(500);
  }
  if (inJob) {
    logLine("Shutdown timeout with job in flight — ERP may mark UNCERTAIN", {
      level: "error",
      event: "job_uncertain",
    });
  }

  try {
    await sendHeartbeat(cfg);
  } catch (e) {
    logLine(`Final heartbeat skipped: ${e.message}`, { level: "error", event: "shutdown" });
  }

  try {
    processLock?.release();
  } catch {
    /* ignore */
  }
  logLine("Graceful shutdown complete", { event: "service_stopped" });
  process.exit(0);
}

loop().catch((e) => {
  logLine(`Fatal: ${e.message || e}`, { level: "error", event: "crash" });
  console.error(e);
  process.exit(1);
});
