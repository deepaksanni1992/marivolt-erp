#!/usr/bin/env node
/**
 * Install Marivolt Print Agent as a Windows Service (WinSW).
 * Requires Administrator PowerShell.
 *
 * Optional env:
 *   MARIVOLT_SERVICE_ACCOUNT=DOMAIN\\User or .\\LocalUser
 *   MARIVOLT_SERVICE_PASSWORD=...
 *
 * Flags:
 *   --reinstall   allow replacing an already-installed service
 */
import fs from "fs";
import path from "path";
import {
  PRINT_AGENT_ROOT,
  SERVICE_ID,
  SERVICE_DISPLAY_NAME,
  ensureServiceRuntimeLayout,
  getConfigDir,
  getConfigPath,
  getServiceRuntimeDir,
  getWinswExePath,
  getWinswXmlPath,
  queryServiceState,
  resolveNodeExecutable,
  runWinsw,
  writeWinswXml,
} from "./common.mjs";
import {
  WINSW_RELEASE,
  copyVerifiedWinswToRuntime,
  ensureWinswBinary,
} from "./download-winsw.mjs";
import { printPreflightReport, runPreflight } from "./preflight-service.mjs";

async function main() {
  const reinstall = process.argv.includes("--reinstall");

  const preflight = await runPreflight({ reinstall });
  printPreflightReport(preflight);
  if (!preflight.ok) {
    throw new Error("Preflight failed. No service was installed.");
  }

  const meta = preflight.meta;
  console.log("");
  console.log(`Config OK: ${meta.configPath}`);
  console.log(`Agent ID:  ${meta.agentId}`);
  console.log(`Backend:   ${meta.backendUrl}`);
  console.log(`Printer:   ${meta.windowsPrinterName || "(not set)"}`);
  console.log(`WinSW:     ${WINSW_RELEASE.version} (${WINSW_RELEASE.assetFileName})`);

  // Download / validate binary BEFORE writing service registration
  let bundled;
  try {
    bundled = await ensureWinswBinary();
  } catch (e) {
    // Guaranteed: no WinSW install/start was attempted yet
    throw e;
  }
  if (!fs.existsSync(bundled)) {
    throw new Error("WinSW binary missing after ensure. No service was installed.");
  }

  const { logs } = ensureServiceRuntimeLayout();
  const nodeExe = resolveNodeExecutable();
  const agentEntry = path.join(PRINT_AGENT_ROOT, "src", "index.js");
  if (!fs.existsSync(agentEntry)) {
    throw new Error(`Agent entry not found: ${agentEntry}. No service was installed.`);
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

  copyVerifiedWinswToRuntime(bundled);
  console.log(`WinSW: ${getWinswExePath()}`);
  console.log(`XML:   ${getWinswXmlPath()}`);
  if (serviceAccount) {
    console.log(`Service account: ${serviceAccount.username}`);
  } else {
    console.log(
      "Service account: (default LocalSystem — map printer machine-wide or reinstall with MARIVOLT_SERVICE_ACCOUNT)"
    );
  }

  // Install (idempotent when --reinstall): stop/uninstall first if present
  const before = queryServiceState();
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
    // Roll back any partial registration
    try {
      runWinsw(["uninstall"], { inherit: false });
    } catch {
      /* ignore */
    }
    throw new Error(
      `WinSW install failed with exit code ${install.status}. No lasting service registration was left when possible.`
    );
  }

  const start = runWinsw(["start"], { inherit: true });
  if (start.status !== 0) {
    try {
      runWinsw(["stop"], { inherit: false });
      runWinsw(["uninstall"], { inherit: false });
    } catch {
      /* ignore */
    }
    const after = queryServiceState();
    throw new Error(
      `Service installed but failed to start (exit ${start.status}). Attempted rollback (installed=${after.installed}). Check logs under ${logs} and printer/service account access.`
    );
  }

  console.log("");
  console.log("========================================");
  console.log(`${SERVICE_DISPLAY_NAME} installed successfully.`);
  console.log(`Service ID:     ${SERVICE_ID}`);
  console.log(`Startup:        Automatic (delayed)`);
  console.log(`WinSW version:  ${WINSW_RELEASE.version}`);
  console.log(`Config:         ${getConfigPath()}`);
  console.log(`Config dir:     ${getConfigDir()}`);
  console.log(`Logs:           ${path.join(getConfigDir(), "logs")}`);
  console.log(`Runtime:        ${getServiceRuntimeDir()}`);
  if (before.installed) {
    console.log(`Note: replaced previous service registration (was ${before.state}).`);
  }
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
