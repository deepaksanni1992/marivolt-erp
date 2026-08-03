import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import readline from "readline";
import { collectHostProfile } from "./detect.js";

const DEFAULT_DIR =
  process.platform === "win32"
    ? path.join(process.env.PROGRAMDATA || "C:\\ProgramData", "MarivoltPrintAgent")
    : path.join(os.homedir(), ".marivolt-print-agent");

const MAX_LOG_BYTES = 10 * 1024 * 1024; // 10 MB
const LOG_RETAIN_DAYS = 14;

export function getConfigDir() {
  return process.env.MARIVOLT_AGENT_DIR || DEFAULT_DIR;
}

export function getConfigPath() {
  return path.join(getConfigDir(), "config.json");
}

export function ensureLogDir() {
  const dir = path.join(getConfigDir(), "logs");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function redactSecrets(msg) {
  let s = String(msg ?? "");
  s = s.replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, "Bearer ***");
  s = s.replace(/("secret"\s*:\s*")[^"]*(")/gi, "$1***$2");
  s = s.replace(/(bootstrapToken["']?\s*[:=]\s*["']?)[^"',\s]+/gi, "$1***");
  return s;
}

function rotateIfNeeded(filePath) {
  try {
    if (!fs.existsSync(filePath)) return;
    const st = fs.statSync(filePath);
    if (st.size < MAX_LOG_BYTES) return;
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const rotated = `${filePath}.${stamp}.bak`;
    fs.renameSync(filePath, rotated);
  } catch {
    /* ignore */
  }
}

function pruneOldLogs(dir) {
  try {
    const cutoff = Date.now() - LOG_RETAIN_DAYS * 24 * 60 * 60 * 1000;
    for (const name of fs.readdirSync(dir)) {
      if (!/\.(log|bak)$/i.test(name) && !/^agent-/i.test(name)) continue;
      const full = path.join(dir, name);
      try {
        const st = fs.statSync(full);
        if (st.mtimeMs < cutoff) fs.unlinkSync(full);
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
}

/**
 * Structured agent logging.
 * Writes console + agent.log (+ agent-error.log for errors) under ProgramData logs.
 * Also appends a dated agent-YYYY-MM-DD.log for backward compatibility.
 */
export function logLine(msg, { level = "info", event = "" } = {}) {
  const safe = redactSecrets(msg);
  const ts = new Date().toISOString();
  const prefix = event ? `[${ts}] [${level}] [${event}]` : `[${ts}] [${level}]`;
  const line = `${prefix} ${safe}`;
  if (level === "error") console.error(line);
  else console.log(line);
  try {
    const dir = ensureLogDir();
    pruneOldLogs(dir);
    const mainLog = path.join(dir, "agent.log");
    const errLog = path.join(dir, "agent-error.log");
    const daily = path.join(dir, `agent-${ts.slice(0, 10)}.log`);
    rotateIfNeeded(mainLog);
    rotateIfNeeded(errLog);
    fs.appendFileSync(mainLog, line + "\n");
    fs.appendFileSync(daily, line + "\n");
    if (level === "error") fs.appendFileSync(errLog, line + "\n");
  } catch {
    /* ignore */
  }
}

function ask(rl, question, fallback = "") {
  return new Promise((resolve) => {
    rl.question(`${question}${fallback ? ` [${fallback}]` : ""}: `, (answer) => {
      const v = String(answer || "").trim();
      resolve(v || fallback);
    });
  });
}

export function saveConfig(cfg) {
  const dir = getConfigDir();
  fs.mkdirSync(dir, { recursive: true });
  const p = getConfigPath();
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2), "utf8");
  return p;
}

function ensureInstallationId(raw = {}) {
  if (raw.installationId && String(raw.installationId).trim()) {
    return String(raw.installationId).trim();
  }
  return crypto.randomUUID();
}

export function loadConfig() {
  const p = getConfigPath();
  if (!fs.existsSync(p)) {
    throw new Error(`Config not found: ${p}. Run first-time setup or copy config.example.json.`);
  }
  const raw = JSON.parse(fs.readFileSync(p, "utf8"));
  const installationId = ensureInstallationId(raw);
  const cfg = {
    backendUrl: String(raw.backendUrl || "").replace(/\/$/, ""),
    agentId: String(raw.agentId || "").trim().toUpperCase(),
    secret: String(raw.secret || "").trim(),
    windowsPrinterName: String(raw.windowsPrinterName || "").trim(),
    pollIntervalMs: Math.max(2000, Number(raw.pollIntervalMs) || 5000),
    connectionType: raw.connectionType || "WINDOWS_SPOOLER",
    companyId: String(raw.companyId || "").trim(),
    warehouseCode: String(raw.warehouseCode || "").trim().toUpperCase(),
    agentName: String(raw.agentName || "").trim(),
    installationId,
  };
  if (!cfg.backendUrl || !cfg.agentId || !cfg.secret) {
    throw new Error("backendUrl, agentId, and secret are required in config.json");
  }
  // Persist installationId for legacy configs that lacked it (no re-bootstrap)
  if (!raw.installationId) {
    try {
      saveConfig({ ...raw, installationId });
    } catch {
      /* ignore */
    }
  }
  return cfg;
}

/**
 * Interactive first-launch: detect host, ask Company/Warehouse/Name, bootstrap register.
 * Existing config.json skips wizard entirely (backward compatible).
 * When stdin is not a TTY (Windows Service), never enter the interactive wizard.
 */
export async function ensureConfigured() {
  const p = getConfigPath();
  if (fs.existsSync(p)) {
    try {
      return loadConfig();
    } catch (e) {
      logLine(`Existing config invalid: ${e.message}`, { level: "error", event: "config" });
    }
  }

  if (!process.stdin.isTTY) {
    throw new Error(
      `Config not found at ${p}. Complete first-launch with interactive npm start before installing the Windows Service.`
    );
  }

  const profile = await collectHostProfile();
  const installationId = crypto.randomUUID();
  console.log("");
  console.log("=== Marivolt Print Agent — first launch ===");
  console.log(`Installation ID:   ${installationId}`);
  console.log(`Detected computer: ${profile.computerName}`);
  console.log(`Detected OS:       ${profile.operatingSystem} (${profile.windowsVersion})`);
  console.log(
    `Detected printers: ${profile.availablePrinters.length ? profile.availablePrinters.join(", ") : "(none)"}`
  );
  console.log("");
  console.log("Note: ERP printer mapping is configured by an admin after registration.");
  console.log("");

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const backendUrl = (await ask(rl, "Backend URL (https://…)", process.env.MARIVOLT_BACKEND_URL || "")).replace(
      /\/$/,
      ""
    );
    const companyId = await ask(rl, "Company ID (Mongo ObjectId)", process.env.MARIVOLT_COMPANY_ID || "");
    const warehouseCode = (await ask(rl, "Warehouse code", "MAIN")).toUpperCase();
    const agentName = await ask(rl, "Friendly agent name", `${profile.computerName} Agent`);
    const bootstrapToken = await ask(rl, "Bootstrap token (from Label Settings)", "");
    let windowsPrinterName = profile.availablePrinters[0] || "";
    if (profile.availablePrinters.length) {
      console.log("Available printers (local only — not auto-mapped in ERP):");
      profile.availablePrinters.forEach((n, i) => console.log(`  ${i + 1}. ${n}`));
      const pick = await ask(rl, "Default local Windows printer number or name", "1");
      const idx = Number(pick) - 1;
      windowsPrinterName =
        Number.isFinite(idx) && profile.availablePrinters[idx]
          ? profile.availablePrinters[idx]
          : pick || windowsPrinterName;
    } else {
      windowsPrinterName = await ask(rl, "Windows printer name (exact)", "");
    }

    if (!backendUrl || !companyId || !bootstrapToken) {
      throw new Error("backendUrl, companyId, and bootstrapToken are required for first-time registration");
    }

    const res = await fetch(`${backendUrl}/api/labels/agent/bootstrap`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        companyId,
        bootstrapToken,
        installationId,
        name: agentName,
        warehouseCode,
        computerName: profile.computerName,
        operatingSystem: profile.operatingSystem,
        windowsVersion: profile.windowsVersion,
        availablePrinters: profile.availablePrinters,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.message || `Bootstrap failed HTTP ${res.status}`);
    }
    if (data.idempotent && !data.secret) {
      throw new Error(
        `Agent ${data.agent?.agentId || ""} already registered for this installation, but no local secret is available. Restore config.json or rotate secret in ERP.`
      );
    }
    if (!data.secret || !data.agent?.agentId) {
      throw new Error("Bootstrap response missing agentId/secret");
    }

    const cfg = {
      backendUrl,
      companyId,
      warehouseCode,
      agentName,
      installationId,
      agentId: data.agent.agentId,
      secret: data.secret,
      windowsPrinterName,
      pollIntervalMs: 5000,
      connectionType: "WINDOWS_SPOOLER",
    };
    const saved = saveConfig(cfg);
    console.log("");
    console.log(`Registered agent ${cfg.agentId}`);
    console.log(`Secret saved to ${saved} (shown once from API — keep this file secure).`);
    console.log("Ask an admin to map an ERP printer to this agent before printing jobs.");
    console.log("");
    return cfg;
  } finally {
    rl.close();
  }
}
