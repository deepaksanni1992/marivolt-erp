import { ensureConfigured, loadConfig, logLine } from "./config.js";
import { collectHostProfile, detectWindowsPrinters } from "./detect.js";
import { createTransport } from "./adapters/windowsRawSpooler.js";

const APP_VERSION = "1.2.0";

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

async function processOneJob(cfg, transport) {
  if (shuttingDown) return false;
  const leased = await api(cfg, "POST", "/api/labels/agent/lease", {});
  const job = leased?.job;
  if (!job) return false;

  inJob = true;
  logLine(`Leased job ${job.jobNo} (${job.id})`, { event: "job_leased" });
  const printerName = job.windowsPrinterName || cfg.windowsPrinterName;
  if (!printerName) {
    await api(cfg, "POST", `/api/labels/agent/jobs/${job.id}/result`, {
      status: "FAILED",
      error: "No Windows printer name configured",
      leaseToken: job.leaseToken,
      printedQty: 0,
    });
    inJob = false;
    return true;
  }

  try {
    await api(cfg, "POST", `/api/labels/agent/jobs/${job.id}/printing`, {
      leaseToken: job.leaseToken,
    });
    logLine(`Print submitted to spooler for ${job.jobNo} → ${printerName}`, {
      event: "print_submitted",
    });
    const buf = Buffer.from(job.tsplPayload || "", "utf8");
    if (!buf.length) throw new Error("Empty TSPL payload");
    await transport.printRaw(buf, printerName);
    await api(cfg, "POST", `/api/labels/agent/jobs/${job.id}/result`, {
      status: "COMPLETED",
      printedQty: job.requestedLabels,
      leaseToken: job.leaseToken,
    });
    logLine(`Completed job ${job.jobNo}`, { event: "job_completed" });
  } catch (e) {
    logLine(`Job ${job.jobNo} failed: ${e.message}`, { level: "error", event: "job_failed" });
    try {
      await api(cfg, "POST", `/api/labels/agent/jobs/${job.id}/result`, {
        status: "FAILED",
        error: e.message,
        leaseToken: job.leaseToken,
        printedQty: 0,
      });
    } catch (reportErr) {
      logLine(`Could not report failure (may become UNCERTAIN): ${reportErr.message}`, {
        level: "error",
        event: "job_uncertain",
      });
    }
  } finally {
    inJob = false;
  }
  return true;
}

async function sendHeartbeat(cfg) {
  let profile = {
    computerName: "",
    operatingSystem: "",
    windowsVersion: "",
    availablePrinters: [],
  };
  try {
    profile = await collectHostProfile();
  } catch (e) {
    logLine(`Host detect warning: ${e.message}`, { level: "error", event: "detect" });
  }
  await api(cfg, "POST", "/api/labels/agent/heartbeat", {
    computerName: profile.computerName,
    appVersion: APP_VERSION,
    operatingSystem: profile.operatingSystem,
    windowsVersion: profile.windowsVersion,
    availablePrinters: profile.availablePrinters,
    printerStatus: (profile.availablePrinters || []).map((name) => ({
      name,
      online: true,
    })),
  });
  logLine(
    `Heartbeat ok agent=${cfg.agentId} version=${APP_VERSION} computer=${profile.computerName}`,
    { event: "heartbeat" }
  );
}

async function checkConfiguredPrinter(cfg) {
  try {
    const printers = await detectWindowsPrinters();
    const want = String(cfg.windowsPrinterName || "").trim().toLowerCase();
    if (!want) {
      logLine("No windowsPrinterName configured", { event: "printer_check" });
      return;
    }
    const found = printers.some((p) => p.toLowerCase() === want);
    if (found) {
      logLine(`Configured printer found: ${cfg.windowsPrinterName}`, { event: "printer_check" });
    } else {
      logLine(
        `PRINTER UNAVAILABLE: configured "${cfg.windowsPrinterName}" not in Windows printer list (agent remains ONLINE; jobs may fail until printer is visible to this account)`,
        { level: "error", event: "printer_unavailable" }
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
    // Non-interactive fallback: require existing config
    try {
      cfg = loadConfig();
    } catch {
      console.error(e.message || e);
      console.error("First-launch registration failed. Set config.json or run interactively.");
      process.exit(1);
    }
  }

  logLine(`Config loaded agent=${cfg.agentId} backend=${cfg.backendUrl}`, { event: "config_loaded" });
  await checkConfiguredPrinter(cfg);

  const transport = createTransport(cfg.connectionType);
  logLine(
    `Marivolt Print Agent ${APP_VERSION} starting. Backend=${cfg.backendUrl} agent=${cfg.agentId}`,
    { event: "service_started" }
  );

  while (!shuttingDown) {
    try {
      await sendHeartbeat(cfg);
      let worked = true;
      while (worked && !shuttingDown) {
        worked = await processOneJob(cfg, transport);
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

  // Wait briefly if a job is mid-flight
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

  logLine("Graceful shutdown complete", { event: "service_stopped" });
  process.exit(0);
}

loop().catch((e) => {
  logLine(`Fatal: ${e.message || e}`, { level: "error", event: "crash" });
  console.error(e);
  process.exit(1);
});
