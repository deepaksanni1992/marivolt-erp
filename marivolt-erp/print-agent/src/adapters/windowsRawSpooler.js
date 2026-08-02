import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { PrintTransportAdapter } from "./base.js";

/**
 * Send raw bytes to a Windows named printer via Win32 WritePrinter (PowerShell).
 * Isolated so TCP/9100 can be added later without changing the agent loop.
 */
export class WindowsRawSpoolerAdapter extends PrintTransportAdapter {
  async printRaw(buffer, printerName) {
    if (process.platform !== "win32") {
      // Dev/mock: write payload to temp file and succeed
      const out = path.join(os.tmpdir(), `marivolt-label-${Date.now()}.tspl`);
      fs.writeFileSync(out, buffer);
      return { ok: true, mocked: true, path: out };
    }
    const name = String(printerName || "").trim();
    if (!name) throw new Error("windowsPrinterName is required");

    const tmp = path.join(os.tmpdir(), `marivolt-label-${Date.now()}-${Math.random().toString(16).slice(2)}.bin`);
    fs.writeFileSync(tmp, buffer);

    const ps = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class RawPrinterHelper {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Ansi)]
  public class DOCINFOA {
    [MarshalAs(UnmanagedType.LPStr)] public string pDocName;
    [MarshalAs(UnmanagedType.LPStr)] public string pOutputFile;
    [MarshalAs(UnmanagedType.LPStr)] public string pDataType;
  }
  [DllImport("winspool.Drv", EntryPoint="OpenPrinterA", SetLastError=true)]
  public static extern bool OpenPrinter(string szPrinter, out IntPtr hPrinter, IntPtr pd);
  [DllImport("winspool.Drv", EntryPoint="ClosePrinter")]
  public static extern bool ClosePrinter(IntPtr hPrinter);
  [DllImport("winspool.Drv", EntryPoint="StartDocPrinterA", SetLastError=true)]
  public static extern bool StartDocPrinter(IntPtr hPrinter, int level, [In] DOCINFOA di);
  [DllImport("winspool.Drv", EntryPoint="EndDocPrinter")]
  public static extern bool EndDocPrinter(IntPtr hPrinter);
  [DllImport("winspool.Drv", EntryPoint="StartPagePrinter")]
  public static extern bool StartPagePrinter(IntPtr hPrinter);
  [DllImport("winspool.Drv", EntryPoint="EndPagePrinter")]
  public static extern bool EndPagePrinter(IntPtr hPrinter);
  [DllImport("winspool.Drv", EntryPoint="WritePrinter", SetLastError=true)]
  public static extern bool WritePrinter(IntPtr hPrinter, IntPtr pBytes, int dwCount, out int dwWritten);
  public static bool SendBytes(string printer, byte[] bytes) {
    IntPtr hPrinter;
    if (!OpenPrinter(printer, out hPrinter, IntPtr.Zero)) return false;
    var di = new DOCINFOA();
    di.pDocName = "Marivolt Label";
    di.pDataType = "RAW";
    if (!StartDocPrinter(hPrinter, 1, di)) { ClosePrinter(hPrinter); return false; }
    StartPagePrinter(hPrinter);
    IntPtr p = Marshal.AllocCoTaskMem(bytes.Length);
    Marshal.Copy(bytes, 0, p, bytes.Length);
    int written;
    bool ok = WritePrinter(hPrinter, p, bytes.Length, out written);
    Marshal.FreeCoTaskMem(p);
    EndPagePrinter(hPrinter);
    EndDocPrinter(hPrinter);
    ClosePrinter(hPrinter);
    return ok;
  }
}
"@
$printer = '${name.replace(/'/g, "''")}'
$bytes = [System.IO.File]::ReadAllBytes('${tmp.replace(/'/g, "''")}')
$ok = [RawPrinterHelper]::SendBytes($printer, $bytes)
if (-not $ok) { throw "WritePrinter failed for $printer (Win32 error $($([ComponentModel.Win32Exception]::new([Runtime.InteropServices.Marshal]::GetLastWin32Error()).Message)))" }
Write-Output "OK"
`;

    try {
      await runPowershell(ps);
      return { ok: true };
    } finally {
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* ignore */
      }
    }
  }
}

function runPowershell(script) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { windowsHide: true }
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(stderr || stdout || `PowerShell exited ${code}`));
    });
  });
}

/** Future stub */
export class Tcp9100Adapter extends PrintTransportAdapter {
  async printRaw() {
    throw new Error("TCP 9100 adapter not implemented in Phase 1");
  }
}

export function createTransport(connectionType = "WINDOWS_SPOOLER") {
  if (connectionType === "TCP_9100") return new Tcp9100Adapter();
  return new WindowsRawSpoolerAdapter();
}
