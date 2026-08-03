#!/usr/bin/env node
/**
 * Install Marivolt Print Agent as a Windows Service (WinSW).
 * Requires Administrator PowerShell.
 *
 * Optional env:
 *   MARIVOLT_SERVICE_ACCOUNT=DOMAIN\\User or .\\LocalUser
 *   MARIVOLT_SERVICE_PASSWORD=...
 */
import fs from "fs";
import path from "path";
import {
  PRINT_AGENT_ROOT,
  SERVICE_ID,
  SERVICE_DISPLAY_NAME,
  assertAdministrator,
  assertWindows,
  ensureServiceRuntimeLayout,
  getBundledWinswPath,
  getConfigDir,
  getConfigPath,
  getServiceRuntimeDir,
  getWinswExePath,
  getWinswXmlPath,
  resolveNodeExecutable,
  runWinsw,
  validateConfigForService,
  writeWinswXml,
} from "./common.mjs";
import { ensureWinswBinary } from "./download-winsw.mjs";

function copyWinswToRuntime() {
  const bundled = getBundledWinswPath();
  const runtimeExe = getWinswExePath();
  fs.mkdirSync(path.dirname(runtimeExe), { recursive: true });
  fs.copyFileSync(bundled, runtimeExe);
  return runtimeExe;
}

async function main() {
  assertWindows();
  assertAdministrator();

  const meta = validateConfigForService();
  console.log(`Config OK: ${meta.configPath}`);
  console.log(`Agent ID:  ${meta.agentId}`);
  console.log(`Backend:   ${meta.backendUrl}`);
  console.log(`Printer:   ${meta.windowsPrinterName || "(not set)"}`);

  await ensureWinswBinary();
  if (!fs.existsSync(getBundledWinswPath())) {
    throw new Error("WinSW binary missing after download.");
  }

  const { logs } = ensureServiceRuntimeLayout();
  const nodeExe = resolveNodeExecutable();
  const agentEntry = path.join(PRINT_AGENT_ROOT, "src", "index.js");
  if (!fs.existsSync(agentEntry)) {
    throw new Error(`Agent entry not found: ${agentEntry}`);
  }

  const accountUser = process.env.MARIVOLT_SERVICE_ACCOUNT || "";
  const accountPass = process.env.MARIVOLT_SERVICE_PASSWORD;
  const serviceAccount = accountUser
    ? { username: accountUser, password: accountPass }
    : undefined;

  writeWinswXml({
    nodeExe,
    agentEntry,
    workingDirectory: PRINT_AGENT_ROOT,
    logPath: logs,
    serviceAccount,
  });

  copyWinswToRuntime();
  console.log(`WinSW: ${getWinswExePath()}`);
  console.log(`XML:   ${getWinswXmlPath()}`);
  if (serviceAccount) {
    console.log(`Service account: ${serviceAccount.username}`);
  } else {
    console.log("Service account: (default LocalSystem — map printer machine-wide or reinstall with MARIVOLT_SERVICE_ACCOUNT)");
  }

  // Install (idempotent-ish: stop/uninstall first if present)
  const stop = runWinsw(["stop"], { inherit: false });
  if (stop.status !== 0) {
    /* may not be installed yet */
  }
  const uninstall = runWinsw(["uninstall"], { inherit: false });
  if (uninstall.status !== 0) {
    /* may not be installed yet */
  }

  const install = runWinsw(["install"], { inherit: true });
  if (install.status !== 0) {
    throw new Error(`WinSW install failed with exit code ${install.status}`);
  }

  const start = runWinsw(["start"], { inherit: true });
  if (start.status !== 0) {
    throw new Error(
      `Service installed but failed to start (exit ${start.status}). Check logs under ${logs} and printer/service account access.`
    );
  }

  console.log("");
  console.log("========================================");
  console.log(`${SERVICE_DISPLAY_NAME} installed successfully.`);
  console.log(`Service ID:     ${SERVICE_ID}`);
  console.log(`Startup:        Automatic (delayed)`);
  console.log(`Config:         ${getConfigPath()}`);
  console.log(`Config dir:     ${getConfigDir()}`);
  console.log(`Logs:           ${path.join(getConfigDir(), "logs")}`);
  console.log(`Runtime:        ${getServiceRuntimeDir()}`);
  console.log("");
  console.log("Next steps:");
  console.log("  1. npm run service:status");
  console.log("  2. npm run service:verify-printer");
  console.log("  3. Confirm agent ONLINE in ERP Label Settings");
  console.log("  4. Restart Windows and confirm the agent returns ONLINE");
  console.log("========================================");
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
