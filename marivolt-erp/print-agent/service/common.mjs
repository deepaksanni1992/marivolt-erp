/**
 * Shared helpers for Marivolt Print Agent Windows service management.
 * Isolated from print-job processing (src/index.js).
 */
import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync, spawnSync } from "child_process";
import { fileURLToPath } from "url";
import { getConfigDir, getConfigPath, loadConfig } from "../src/config.js";

export { getConfigDir, getConfigPath };

export const SERVICE_ID = "MarivoltPrintAgent";
export const SERVICE_DISPLAY_NAME = "Marivolt Print Agent";
export const SERVICE_DESCRIPTION =
  "Background service for receiving Marivolt ERP label jobs and printing them through configured Windows printer queues.";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PRINT_AGENT_ROOT = path.resolve(__dirname, "..");
export const SERVICE_DIR = path.join(PRINT_AGENT_ROOT, "service");
export const SERVICE_BIN_DIR = path.join(SERVICE_DIR, "bin");
export const WINSW_EXE_NAME = "MarivoltPrintAgent.exe";
export const WINSW_XML_NAME = "MarivoltPrintAgent.xml";

/** Runtime copies of WinSW live under ProgramData (not beside source). */
export function getServiceRuntimeDir() {
  return path.join(getConfigDir(), "service");
}

export function getWinswExePath() {
  return path.join(getServiceRuntimeDir(), WINSW_EXE_NAME);
}

export function getWinswXmlPath() {
  return path.join(getServiceRuntimeDir(), WINSW_XML_NAME);
}

export function getBundledWinswPath() {
  return path.join(SERVICE_BIN_DIR, WINSW_EXE_NAME);
}

export function assertWindows() {
  if (process.platform !== "win32") {
    throw new Error("Marivolt Print Agent Windows Service is only supported on Windows.");
  }
}

export function isAdministrator() {
  if (process.platform !== "win32") return false;
  try {
    execFileSync("net", ["session"], { stdio: "ignore", windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

export function assertAdministrator() {
  if (!isAdministrator()) {
    throw new Error(
      "Administrator privileges are required. Open PowerShell as Administrator and run this command again."
    );
  }
}

export function resolveNodeExecutable() {
  const exe = process.execPath;
  if (!exe || !fs.existsSync(exe)) {
    throw new Error("Could not resolve Node.js executable path (process.execPath).");
  }
  return exe;
}

export function validateConfigForService() {
  const p = getConfigPath();
  if (!fs.existsSync(p)) {
    throw new Error(
      `Config not found: ${p}\nRegister/bootstrap the agent first (npm start) or copy config.example.json.`
    );
  }
  const cfg = loadConfig();
  // Do not return secret to callers that might log it
  return {
    configPath: p,
    backendUrl: cfg.backendUrl,
    agentId: cfg.agentId,
    windowsPrinterName: cfg.windowsPrinterName,
    pollIntervalMs: cfg.pollIntervalMs,
    hasSecret: Boolean(cfg.secret),
  };
}

function xmlEscape(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Build WinSW XML. Never embeds agent secret.
 * @param {{ nodeExe: string, agentEntry: string, workingDirectory: string, logPath: string, serviceAccount?: { username: string, password?: string } }} opts
 */
export function buildWinswXml(opts) {
  const nodeExe = opts.nodeExe;
  const agentEntry = opts.agentEntry;
  const workingDirectory = opts.workingDirectory;
  const logPath = opts.logPath;
  const account = opts.serviceAccount;

  let accountXml = "";
  if (account?.username) {
    // Password optional when using managed accounts / gMSA patterns; LocalSystem = omit block
    const user = xmlEscape(account.username);
    const pass = account.password != null ? xmlEscape(account.password) : "";
    accountXml = `
  <serviceaccount>
    <username>${user}</username>
    ${pass ? `<password>${pass}</password>` : ""}
    <allowservicelogon>true</allowservicelogon>
  </serviceaccount>`;
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<!-- Marivolt Print Agent — WinSW service definition. Generated; do not put secrets here. -->
<service>
  <id>${SERVICE_ID}</id>
  <name>${xmlEscape(SERVICE_DISPLAY_NAME)}</name>
  <description>${xmlEscape(SERVICE_DESCRIPTION)}</description>
  <executable>${xmlEscape(nodeExe)}</executable>
  <arguments>"${xmlEscape(agentEntry)}"</arguments>
  <workingdirectory>${xmlEscape(workingDirectory)}</workingdirectory>
  <logpath>${xmlEscape(logPath)}</logpath>
  <log mode="roll-by-size">
    <sizeThreshold>10240</sizeThreshold>
    <keepFiles>14</keepFiles>
  </log>
  <env name="MARIVOLT_AGENT_DIR" value="${xmlEscape(getConfigDir())}" />
  <env name="NODE_ENV" value="production" />
  <startmode>Automatic</startmode>
  <delayedAutoStart>true</delayedAutoStart>
  <stoptimeout>45 sec</stoptimeout>
  <onfailure action="restart" delay="10 sec" />
  <onfailure action="restart" delay="30 sec" />
  <onfailure action="restart" delay="60 sec" />
  <resetfailure>1 hour</resetfailure>
  <priority>Normal</priority>${accountXml}
</service>
`;
}

export function ensureServiceRuntimeLayout() {
  const runtime = getServiceRuntimeDir();
  const logs = path.join(getConfigDir(), "logs");
  fs.mkdirSync(runtime, { recursive: true });
  fs.mkdirSync(logs, { recursive: true });
  return { runtime, logs };
}

export function writeWinswXml(opts) {
  ensureServiceRuntimeLayout();
  const xml = buildWinswXml(opts);
  const xmlPath = getWinswXmlPath();
  fs.writeFileSync(xmlPath, xml, "utf8");
  if (/secret|bootstrap|Authorization/i.test(xml) && /Bearer\s+[A-Za-z0-9]/i.test(xml)) {
    throw new Error("Refusing to write WinSW XML that appears to contain a secret.");
  }
  return xmlPath;
}

export function runWinsw(args, { inherit = true } = {}) {
  const exe = getWinswExePath();
  if (!fs.existsSync(exe)) {
    throw new Error(`WinSW executable not found: ${exe}. Run service:install to download it.`);
  }
  const r = spawnSync(exe, args, {
    cwd: getServiceRuntimeDir(),
    windowsHide: true,
    encoding: "utf8",
    stdio: inherit ? "inherit" : "pipe",
  });
  return r;
}

export function queryServiceState() {
  assertWindows();
  try {
    const out = execFileSync("sc.exe", ["query", SERVICE_ID], {
      encoding: "utf8",
      windowsHide: true,
    });
    const stateMatch = out.match(/STATE\s*:\s*\d+\s+(\w+)/i);
    return {
      installed: true,
      state: stateMatch ? stateMatch[1] : "UNKNOWN",
      raw: out,
    };
  } catch (e) {
    const msg = String(e?.stderr || e?.message || e);
    if (/1060|does not exist|specified service does not exist/i.test(msg)) {
      return { installed: false, state: "NOT_INSTALLED", raw: msg };
    }
    return { installed: false, state: "UNKNOWN", raw: msg };
  }
}

export function queryServiceStartType() {
  try {
    const out = execFileSync("sc.exe", ["qc", SERVICE_ID], {
      encoding: "utf8",
      windowsHide: true,
    });
    const m = out.match(/START_TYPE\s*:\s*\d+\s+(\w+)/i);
    return m ? m[1] : "UNKNOWN";
  } catch {
    return "UNKNOWN";
  }
}

export function computerName() {
  return os.hostname();
}
