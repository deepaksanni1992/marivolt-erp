#!/usr/bin/env node
/**
 * Preflight checks before Marivolt Print Agent Windows Service install.
 * Does not install the service. Does not print secrets.
 *
 * Flags:
 *   --reinstall   allow an already-installed MarivoltPrintAgent service
 *   --skip-network  skip WinSW URL probe when a checksum-valid local binary exists
 */
import fs from "fs";
import path from "path";
import {
  PRINT_AGENT_ROOT,
  SERVICE_BIN_DIR,
  SERVICE_ID,
  assertWindows,
  getConfigDir,
  getConfigPath,
  getServiceRuntimeDir,
  isAdministrator,
  queryServiceState,
  resolveNodeExecutable,
  validateConfigForService,
} from "./common.mjs";
import {
  WINSW_RELEASE,
  findValidLocalWinsw,
  probeWinswUrl,
} from "./download-winsw.mjs";

function canWriteDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const probe = path.join(dir, `.marivolt-write-probe-${process.pid}`);
  fs.writeFileSync(probe, "ok", "utf8");
  fs.unlinkSync(probe);
  return true;
}

/**
 * @returns {Promise<{ ok: boolean, checks: Array<{ name: string, ok: boolean, detail: string }> }>}
 */
export async function runPreflight(options = {}) {
  const reinstall = Boolean(options.reinstall);
  const skipNetwork = Boolean(options.skipNetwork);
  const checks = [];
  const add = (name, ok, detail) => {
    checks.push({ name, ok: Boolean(ok), detail: String(detail || "") });
  };

  try {
    assertWindows();
    add("windows", true, process.platform);
  } catch (e) {
    add("windows", false, e.message);
  }

  const admin = isAdministrator();
  add(
    "administrator",
    admin,
    admin
      ? "elevated"
      : "Administrator privileges are required. Open PowerShell as Administrator and run this command again."
  );

  let meta = null;
  try {
    meta = validateConfigForService();
    add("config.json", true, meta.configPath);
  } catch (e) {
    add("config.json", false, e.message);
  }

  try {
    const nodeExe = resolveNodeExecutable();
    add("node", true, nodeExe);
  } catch (e) {
    add("node", false, e.message);
  }

  const printerOk = Boolean(meta?.windowsPrinterName);
  add(
    "printer_config",
    printerOk,
    printerOk
      ? meta.windowsPrinterName
      : "windowsPrinterName missing in config.json"
  );

  try {
    canWriteDir(getServiceRuntimeDir());
    canWriteDir(path.join(getConfigDir(), "logs"));
    canWriteDir(SERVICE_BIN_DIR);
    add("writable_dirs", true, `${getServiceRuntimeDir()}; ${SERVICE_BIN_DIR}`);
  } catch (e) {
    add("writable_dirs", false, e.message);
  }

  let svc = { installed: false, state: "UNKNOWN" };
  try {
    svc = queryServiceState();
  } catch (e) {
    svc = { installed: false, state: "ERROR", raw: String(e.message || e) };
  }
  if (svc.installed && !reinstall) {
    add(
      "service_conflict",
      false,
      `${SERVICE_ID} already installed (state=${svc.state}). Run npm run service:uninstall first, or pass --reinstall.`
    );
  } else if (svc.installed && reinstall) {
    add("service_conflict", true, `reinstall allowed (state=${svc.state})`);
  } else {
    add("service_conflict", true, "not installed");
  }

  const local = findValidLocalWinsw(WINSW_RELEASE);
  if (local) {
    add(
      "winsw_binary",
      true,
      `local checksum OK (${local.path}); download not required`
    );
    add("winsw_url", true, `skipped (valid local ${WINSW_RELEASE.version})`);
  } else if (skipNetwork) {
    add("winsw_binary", false, "no valid local WinSW binary and --skip-network set");
    add("winsw_url", false, "skipped");
  } else {
    add("winsw_binary", false, "no valid local binary; download required");
    try {
      const probe = await probeWinswUrl(WINSW_RELEASE.downloadUrl);
      add(
        "winsw_url",
        probe.ok,
        probe.ok
          ? `${WINSW_RELEASE.downloadUrl} → HTTP ${probe.status}`
          : `URL probe failed (HTTP ${probe.status}). ${WINSW_RELEASE.downloadUrl}`
      );
    } catch (e) {
      add("winsw_url", false, e.message);
    }
  }

  const agentEntry = path.join(PRINT_AGENT_ROOT, "src", "index.js");
  add("agent_entry", fs.existsSync(agentEntry), agentEntry);

  const ok = checks.every((c) => c.ok);
  return {
    ok,
    checks,
    release: {
      version: WINSW_RELEASE.version,
      assetFileName: WINSW_RELEASE.assetFileName,
      downloadUrl: WINSW_RELEASE.downloadUrl,
      sha256: WINSW_RELEASE.sha256,
    },
    meta: meta
      ? {
          agentId: meta.agentId,
          backendUrl: meta.backendUrl,
          windowsPrinterName: meta.windowsPrinterName,
          configPath: meta.configPath,
        }
      : null,
  };
}

export function printPreflightReport(result) {
  console.log("Marivolt Print Agent — service preflight");
  console.log(`WinSW pin: ${result.release.version} / ${result.release.assetFileName}`);
  console.log(`URL: ${result.release.downloadUrl}`);
  console.log("");
  for (const c of result.checks) {
    console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.name}: ${c.detail}`);
  }
  console.log("");
  if (result.ok) {
    console.log("Preflight OK — safe to run npm run service:install");
  } else {
    console.log("Preflight FAILED — fix the items above before installing.");
    console.log("No service was installed.");
  }
}

async function main() {
  const reinstall = process.argv.includes("--reinstall");
  const skipNetwork = process.argv.includes("--skip-network");
  const result = await runPreflight({ reinstall, skipNetwork });
  printPreflightReport(result);
  process.exit(result.ok ? 0 : 1);
}

const isDirect =
  process.argv[1] &&
  path.normalize(path.resolve(process.argv[1])).toLowerCase().endsWith("preflight-service.mjs");

if (isDirect) {
  main().catch((e) => {
    console.error(e.message || e);
    process.exit(1);
  });
}
