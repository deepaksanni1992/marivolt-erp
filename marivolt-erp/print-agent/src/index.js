import { ensureConfigured, loadConfig, logLine } from "./config.js";
import { collectHostProfile } from "./detect.js";
import { createTransport } from "./adapters/windowsRawSpooler.js";

const APP_VERSION = "1.1.0";

async function api(cfg, method, path, body) {
  const url = `${cfg.backendUrl}${path}`;
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
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
      logLine(`API ${method} ${path} attempt ${attempt} failed: ${e.message}`);
      await sleep(1000 * attempt);
    }
  }
  throw lastErr;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function processOneJob(cfg, transport) {
  const leased = await api(cfg, "POST", "/api/labels/agent/lease", {});
  const job = leased?.job;
  if (!job) return false;

  logLine(`Leased job ${job.jobNo} (${job.id})`);
  const printerName = job.windowsPrinterName || cfg.windowsPrinterName;
  if (!printerName) {
    await api(cfg, "POST", `/api/labels/agent/jobs/${job.id}/result`, {
      status: "FAILED",
      error: "No Windows printer name configured",
      leaseToken: job.leaseToken,
      printedQty: 0,
    });
    return true;
  }

  try {
    await api(cfg, "POST", `/api/labels/agent/jobs/${job.id}/printing`, {
      leaseToken: job.leaseToken,
    });
    const buf = Buffer.from(job.tsplPayload || "", "utf8");
    if (!buf.length) throw new Error("Empty TSPL payload");
    await transport.printRaw(buf, printerName);
    await api(cfg, "POST", `/api/labels/agent/jobs/${job.id}/result`, {
      status: "COMPLETED",
      printedQty: job.requestedLabels,
      leaseToken: job.leaseToken,
    });
    logLine(`Completed job ${job.jobNo}`);
  } catch (e) {
    logLine(`Job ${job.jobNo} failed: ${e.message}`);
    try {
      await api(cfg, "POST", `/api/labels/agent/jobs/${job.id}/result`, {
        status: "FAILED",
        error: e.message,
        leaseToken: job.leaseToken,
        printedQty: 0,
      });
    } catch (reportErr) {
      logLine(`Could not report failure (may become UNCERTAIN): ${reportErr.message}`);
    }
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
    logLine(`Host detect warning: ${e.message}`);
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

  const transport = createTransport(cfg.connectionType);
  logLine(`Marivolt Print Agent ${APP_VERSION} starting. Backend=${cfg.backendUrl} agent=${cfg.agentId}`);

  for (;;) {
    try {
      await sendHeartbeat(cfg);
      let worked = true;
      while (worked) {
        worked = await processOneJob(cfg, transport);
      }
    } catch (e) {
      logLine(`Loop error: ${e.message}`);
    }
    await sleep(cfg.pollIntervalMs);
  }
}

loop().catch((e) => {
  console.error(e);
  process.exit(1);
});
