import { execFile } from "child_process";
import { promisify } from "util";
import os from "os";

const execFileAsync = promisify(execFile);

export function detectComputerName() {
  return String(os.hostname() || "").slice(0, 120);
}

export function detectOperatingSystem() {
  return `${os.type()} ${os.arch()}`.trim().slice(0, 80);
}

export function detectWindowsVersion() {
  try {
    return `${os.platform()} ${os.release()}`.trim().slice(0, 80);
  } catch {
    return String(os.platform()).slice(0, 80);
  }
}

export function normalizeDetectedPrinters(names = []) {
  const seen = new Set();
  const out = [];
  for (const raw of names) {
    const name = String(raw || "").trim().slice(0, 200);
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
    if (out.length >= 50) break;
  }
  return out;
}

/** List installed Windows printers via PowerShell (empty on non-Windows). */
export async function detectWindowsPrinters() {
  if (process.platform !== "win32") return [];
  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-Command", "Get-Printer | Select-Object -ExpandProperty Name"],
      { windowsHide: true, timeout: 15000 }
    );
    return normalizeDetectedPrinters(String(stdout || "").split(/\r?\n/));
  } catch {
    return [];
  }
}

export async function collectHostProfile() {
  const availablePrinters = await detectWindowsPrinters();
  return {
    computerName: detectComputerName(),
    operatingSystem: detectOperatingSystem(),
    windowsVersion: detectWindowsVersion(),
    availablePrinters,
  };
}
