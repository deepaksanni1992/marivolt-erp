#!/usr/bin/env node
/**
 * Preflight checks before Marivolt Print Agent Windows Service install.
 * Does not install the service. Does not print secrets.
 *
 * Flags:
 *   --reinstall   allow an already-installed MarivoltPrintAgent service
 *   --skip-network  skip WinSW URL probe (only PASS if a checksum-valid local binary exists)
 */
import fs from "fs";
import path from "path";
import {
  PRINT_AGENT_ROOT,
  SERVICE_BIN_DIR,
  SERVICE_ID,
  assertWindows,
  getConfigDir,
  getServiceRuntimeDir,
  isAdministrator,
  queryServiceState,
  resolveNodeExecutable,
  validateConfigForService,
} from "./common.mjs";
import {
  WINSW_RELEASE,
  findLocalWinswCandidates,
  findValidLocalWinsw,
  probeWinswUrl,
  safeUnlink,
  validateWinswBinary,
} from "./download-winsw.mjs";

function canWriteDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const probe = path.join(dir, `.marivolt-write-probe-${process.pid}`);
  fs.writeFileSync(probe, "ok", "utf8");
  fs.unlinkSync(probe);
  return true;
}

/**
 * Quarantine invalid local WinSW candidates so they are not reused.
 * Renames to *.invalid.<timestamp> when possible; deletes if rename fails.
 */
export function quarantineInvalidLocalWinsw(release = WINSW_RELEASE) {
  const quarantined = [];
  for (const p of findLocalWinswCandidates()) {
    if (!fs.existsSync(p)) continue;
    const v = validateWinswBinary(p, release);
    if (v.ok) continue;
    const stamp = Date.now();
    const dest = `${p}.invalid.${stamp}`;
    try {
      fs.renameSync(p, dest);
      quarantined.push({ from: p, to: dest, reason: v.reason });
    } catch {
      safeUnlink(p);
      quarantined.push({ from: p, to: null, reason: v.reason });
    }
  }
  return quarantined;
}

/**
 * Evaluate WinSW source readiness.
 * PASS when localBinaryValid || remoteDownloadAvailable.
 *
 * @returns {Promise<{
 *   ok: boolean,
 *   localBinaryValid: boolean,
 *   remoteDownloadAvailable: boolean,
 *   checks: Array<{ name: string, ok: boolean, level?: string, detail: string }>,
 *   quarantined: Array<object>
 * }>}
 */
export async function evaluateWinswSource(options = {}) {
  const release = options.release || WINSW_RELEASE;
  const skipNetwork = Boolean(options.skipNetwork);
  const findValid = options.findValidLocalWinsw || findValidLocalWinsw;
  const probe = options.probeWinswUrl || probeWinswUrl;
  const quarantine = options.quarantineInvalidLocalWinsw || quarantineInvalidLocalWinsw;
  const listCandidates = options.findLocalWinswCandidates || findLocalWinswCandidates;

  const checks = [];
  const add = (name, ok, detail, level) => {
    const entry = { name, ok: Boolean(ok), detail: String(detail || "") };
    if (level) entry.level = level;
    checks.push(entry);
  };

  const local = findValid(release);
  const localBinaryValid = Boolean(local);

  let hasInvalidLocal = false;
  if (!localBinaryValid) {
    for (const p of listCandidates()) {
      if (fs.existsSync(p)) {
        const v = validateWinswBinary(p, release);
        if (!v.ok) {
          hasInvalidLocal = true;
          break;
        }
      }
    }
  }

  let remoteDownloadAvailable = false;
  let probeStatus = null;
  let quarantined = [];

  if (localBinaryValid) {
    add(
      "winsw_source",
      true,
      `local checksum OK (${local.path}); download not required`
    );
    if (skipNetwork) {
      add("winsw_url", true, `skipped (valid local ${release.version})`);
      remoteDownloadAvailable = false;
    } else {
      try {
        const probeResult = await probe(release.downloadUrl);
        probeStatus = probeResult.status;
        remoteDownloadAvailable = Boolean(probeResult.ok);
        add(
          "winsw_url",
          true,
          probeResult.ok
            ? `${release.downloadUrl} → HTTP ${probeResult.status} (not required; local binary present)`
            : `URL probe ${probeResult.status} (ignored; valid local binary present)`
        );
      } catch {
        add(
          "winsw_url",
          true,
          "URL probe skipped/failed (ignored; valid local binary present)"
        );
      }
    }
  } else if (skipNetwork) {
    add(
      "winsw_source",
      false,
      "No valid local WinSW binary and --skip-network set; cannot download."
    );
    add("winsw_url", false, "skipped");
  } else {
    try {
      const probeResult = await probe(release.downloadUrl);
      probeStatus = probeResult.status;
      remoteDownloadAvailable = Boolean(probeResult.ok);
    } catch (e) {
      probeStatus = String(e?.message || e);
      remoteDownloadAvailable = false;
    }

    if (remoteDownloadAvailable) {
      if (hasInvalidLocal) {
        quarantined = quarantine(release);
        add(
          "winsw_source",
          true,
          "Invalid local WinSW binary will be replaced.",
          "WARN"
        );
      } else {
        add(
          "winsw_source",
          true,
          `No local WinSW binary found; installer will download and verify ${release.version}.`,
          "WARN"
        );
      }
      add(
        "winsw_source",
        true,
        `official WinSW ${release.version} available for verified download`
      );
      add("winsw_url", true, `${release.downloadUrl} → HTTP ${probeStatus}`);
    } else {
      if (hasInvalidLocal) {
        add(
          "winsw_source",
          false,
          `Invalid local WinSW binary and download URL unavailable (HTTP ${probeStatus}).`
        );
      } else {
        add(
          "winsw_source",
          false,
          `No local WinSW binary and download URL unavailable (HTTP ${probeStatus}).`
        );
      }
      add(
        "winsw_url",
        false,
        `URL probe failed (HTTP ${probeStatus}). ${release.downloadUrl}`
      );
    }
  }

  const ok = localBinaryValid || remoteDownloadAvailable;
  return {
    ok,
    localBinaryValid,
    remoteDownloadAvailable,
    probeStatus,
    checks,
    quarantined,
  };
}

/**
 * @returns {Promise<{ ok: boolean, checks: Array, release: object, meta: object|null, winsw: object }>}
 */
export async function runPreflight(options = {}) {
  const reinstall = Boolean(options.reinstall);
  const skipNetwork = Boolean(options.skipNetwork);
  const checks = [];
  const add = (name, ok, detail, level) => {
    const entry = { name, ok: Boolean(ok), detail: String(detail || "") };
    if (level) entry.level = level;
    checks.push(entry);
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

  const winsw = await evaluateWinswSource({
    skipNetwork,
    release: options.release || WINSW_RELEASE,
    findValidLocalWinsw: options.findValidLocalWinsw,
    probeWinswUrl: options.probeWinswUrl,
    quarantineInvalidLocalWinsw: options.quarantineInvalidLocalWinsw,
    findLocalWinswCandidates: options.findLocalWinswCandidates,
  });
  for (const c of winsw.checks) checks.push(c);

  const agentEntry = path.join(PRINT_AGENT_ROOT, "src", "index.js");
  add("agent_entry", fs.existsSync(agentEntry), agentEntry);

  // Hard checks still must all pass; WinSW soft WARN entries have ok:true
  const ok = checks.every((c) => c.ok);
  return {
    ok,
    checks,
    winsw: {
      localBinaryValid: winsw.localBinaryValid,
      remoteDownloadAvailable: winsw.remoteDownloadAvailable,
      sourceOk: winsw.ok,
      quarantined: winsw.quarantined,
    },
    release: {
      version: WINSW_RELEASE.version,
      assetFileName: WINSW_RELEASE.assetFileName,
      downloadUrl: WINSW_RELEASE.downloadUrl,
      sha256: WINSW_RELEASE.sha256,
      expectedBytes: WINSW_RELEASE.expectedBytes,
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

function formatCheckLine(c) {
  if (!c.ok) return `FAIL  ${c.name}: ${c.detail}`;
  if (c.level === "WARN") return `WARN  ${c.name}: ${c.detail}`;
  return `PASS  ${c.name}: ${c.detail}`;
}

export function printPreflightReport(result) {
  console.log("Marivolt Print Agent — service preflight");
  console.log(`WinSW pin: ${result.release.version} / ${result.release.assetFileName}`);
  console.log(`URL: ${result.release.downloadUrl}`);
  console.log("");
  for (const c of result.checks) {
    console.log(formatCheckLine(c));
  }
  console.log("");
  if (result.ok) {
    console.log("Preflight PASSED — ready to install.");
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
