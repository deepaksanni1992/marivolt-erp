#!/usr/bin/env node
/**
 * Uninstall Marivolt Print Agent Windows Service.
 * Preserves config.json and logs unless --purge is passed.
 */
import fs from "fs";
import { execFileSync } from "child_process";
import {
  SERVICE_DISPLAY_NAME,
  SERVICE_ID,
  assertAdministrator,
  assertWindows,
  getConfigDir,
  getServiceRuntimeDir,
  getWinswExePath,
  runWinsw,
} from "./common.mjs";

function main() {
  assertWindows();
  assertAdministrator();

  const purge = process.argv.includes("--purge");

  if (!fs.existsSync(getWinswExePath())) {
    console.log("WinSW runtime not found — attempting sc.exe delete as fallback.");
    try {
      try {
        execFileSync("sc.exe", ["stop", SERVICE_ID], { stdio: "ignore", windowsHide: true });
      } catch {
        /* ignore */
      }
      execFileSync("sc.exe", ["delete", SERVICE_ID], { stdio: "inherit", windowsHide: true });
    } catch (e) {
      console.error(String(e?.message || e));
    }
  } else {
    runWinsw(["stop"], { inherit: true });
    const r = runWinsw(["uninstall"], { inherit: true });
    if (r.status !== 0) {
      console.error(`WinSW uninstall exited with ${r.status} (service may already be removed).`);
    }
  }

  if (purge) {
    const runtime = getServiceRuntimeDir();
    console.log(`--purge: removing service runtime under ${runtime}`);
    fs.rmSync(runtime, { recursive: true, force: true });
    console.log("Config and logs were preserved (ProgramData root). Delete manually if required.");
  } else {
    console.log("Preserved:");
    console.log(`  Config/logs: ${getConfigDir()}`);
    console.log(`  Service runtime: ${getServiceRuntimeDir()}`);
    console.log("Use --purge to remove the service runtime folder only.");
  }

  console.log(`${SERVICE_DISPLAY_NAME} (${SERVICE_ID}) uninstall finished.`);
}

main();
