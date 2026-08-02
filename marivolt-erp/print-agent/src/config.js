import fs from "fs";
import os from "os";
import path from "path";

const DEFAULT_DIR =
  process.platform === "win32"
    ? path.join(process.env.PROGRAMDATA || "C:\\\\ProgramData", "MarivoltPrintAgent")
    : path.join(os.homedir(), ".marivolt-print-agent");

export function getConfigDir() {
  return process.env.MARIVOLT_AGENT_DIR || DEFAULT_DIR;
}

export function getConfigPath() {
  return path.join(getConfigDir(), "config.json");
}

export function loadConfig() {
  const p = getConfigPath();
  if (!fs.existsSync(p)) {
    throw new Error(`Config not found: ${p}. Copy config.example.json and fill in values.`);
  }
  const raw = JSON.parse(fs.readFileSync(p, "utf8"));
  const cfg = {
    backendUrl: String(raw.backendUrl || "").replace(/\/$/, ""),
    agentId: String(raw.agentId || "").trim().toUpperCase(),
    secret: String(raw.secret || "").trim(),
    windowsPrinterName: String(raw.windowsPrinterName || "").trim(),
    pollIntervalMs: Math.max(2000, Number(raw.pollIntervalMs) || 5000),
    connectionType: raw.connectionType || "WINDOWS_SPOOLER",
  };
  if (!cfg.backendUrl || !cfg.agentId || !cfg.secret) {
    throw new Error("backendUrl, agentId, and secret are required in config.json");
  }
  return cfg;
}

export function ensureLogDir() {
  const dir = path.join(getConfigDir(), "logs");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function logLine(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try {
    const dir = ensureLogDir();
    const file = path.join(dir, `agent-${new Date().toISOString().slice(0, 10)}.log`);
    fs.appendFileSync(file, line + "\n");
  } catch {
    /* ignore */
  }
}
