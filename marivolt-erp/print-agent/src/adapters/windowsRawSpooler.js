import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { PrintTransportAdapter } from "./base.js";
import { spoolDocumentName } from "../printSafety.js";

/**
 * Send raw bytes to a Windows named printer via Win32 WritePrinter (PowerShell).
 * Diagnostic: captures StartDocPrinter JobId + stage timings (measurement only).
 * Isolated so TCP/9100 can be added later without changing the agent loop.
 */
export class WindowsRawSpoolerAdapter extends PrintTransportAdapter {
  async printRaw(buffer, printerName, opts = {}) {
    const documentName = String(opts.documentName || "").trim() || spoolDocumentName(opts.jobNo);
    const bytesRequested = Buffer.isBuffer(buffer) ? buffer.length : Buffer.byteLength(String(buffer || ""), "utf8");
    const printRawStartedAt = Date.now();
    const diag = {
      documentName,
      bytesRequested,
      bytesWritten: null,
      windowsSpoolJobId: null,
      windowsSpoolJobIdCaptured: false,
      openPrinterMs: null,
      startDocMs: null,
      writePrinterMs: null,
      endDocMs: null,
      powershellSpawnMs: null,
      powershellExitMs: null,
      totalMs: null,
      stages: {},
    };

    if (process.platform !== "win32") {
      const out = path.join(os.tmpdir(), `marivolt-label-${Date.now()}.tspl`);
      fs.writeFileSync(out, buffer);
      diag.bytesWritten = bytesRequested;
      diag.totalMs = Date.now() - printRawStartedAt;
      diag.mocked = true;
      return {
        ok: true,
        mocked: true,
        path: out,
        submitted: true,
        windowsJobName: documentName,
        windowsSpoolJobId: null,
        timing: diag,
      };
    }
    const name = String(printerName || "").trim();
    if (!name) throw new Error("windowsPrinterName is required");

    const tmp = path.join(os.tmpdir(), `marivolt-label-${Date.now()}-${Math.random().toString(16).slice(2)}.bin`);
    fs.writeFileSync(tmp, buffer);
    const docEsc = String(documentName).replace(/\\/g, "\\\\").replace(/"/g, '\\"');

    // StartDocPrinter returns DWORD job id (0 = failure). Capture for diagnostics only.
    const ps = `
$ErrorActionPreference = 'Stop'
$diag = [ordered]@{
  openPrinterMs = $null
  startDocMs = $null
  writePrinterMs = $null
  endDocMs = $null
  bytesRequested = 0
  bytesWritten = 0
  windowsSpoolJobId = $null
  ok = $false
  error = ''
}
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class RawPrinterHelperDiag {
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
  public static extern uint StartDocPrinter(IntPtr hPrinter, int level, [In] DOCINFOA di);
  [DllImport("winspool.Drv", EntryPoint="EndDocPrinter")]
  public static extern bool EndDocPrinter(IntPtr hPrinter);
  [DllImport("winspool.Drv", EntryPoint="StartPagePrinter")]
  public static extern bool StartPagePrinter(IntPtr hPrinter);
  [DllImport("winspool.Drv", EntryPoint="EndPagePrinter")]
  public static extern bool EndPagePrinter(IntPtr hPrinter);
  [DllImport("winspool.Drv", EntryPoint="WritePrinter", SetLastError=true)]
  public static extern bool WritePrinter(IntPtr hPrinter, IntPtr pBytes, int dwCount, out int dwWritten);
  public class SendResult {
    public bool Ok;
    public uint JobId;
    public int BytesWritten;
    public long OpenPrinterMs;
    public long StartDocMs;
    public long WritePrinterMs;
    public long EndDocMs;
    public string Error;
  }
  public static SendResult SendBytes(string printer, byte[] bytes, string docName) {
    var r = new SendResult();
    var sw = System.Diagnostics.Stopwatch.StartNew();
    IntPtr hPrinter;
    if (!OpenPrinter(printer, out hPrinter, IntPtr.Zero)) {
      r.Error = "OpenPrinter failed";
      r.OpenPrinterMs = sw.ElapsedMilliseconds;
      return r;
    }
    r.OpenPrinterMs = sw.ElapsedMilliseconds;
    sw.Restart();
    var di = new DOCINFOA();
    di.pDocName = string.IsNullOrEmpty(docName) ? "Marivolt JOB" : docName;
    di.pDataType = "RAW";
    uint jobId = StartDocPrinter(hPrinter, 1, di);
    r.StartDocMs = sw.ElapsedMilliseconds;
    if (jobId == 0) {
      r.Error = "StartDocPrinter failed";
      ClosePrinter(hPrinter);
      return r;
    }
    r.JobId = jobId;
    StartPagePrinter(hPrinter);
    IntPtr p = Marshal.AllocCoTaskMem(bytes.Length);
    Marshal.Copy(bytes, 0, p, bytes.Length);
    int written;
    sw.Restart();
    bool writeOk = WritePrinter(hPrinter, p, bytes.Length, out written);
    r.WritePrinterMs = sw.ElapsedMilliseconds;
    r.BytesWritten = written;
    Marshal.FreeCoTaskMem(p);
    EndPagePrinter(hPrinter);
    sw.Restart();
    bool endOk = EndDocPrinter(hPrinter);
    r.EndDocMs = sw.ElapsedMilliseconds;
    ClosePrinter(hPrinter);
    // Partial writes: Ok stays true so Node can mark UNCERTAIN (not FAILED/retry).
    // Write/EndDoc hard failures: Ok=false → PowerShell throws → FAILED.
    if (!writeOk) {
      r.Ok = false;
      r.Error = "WritePrinter failed";
    } else if (!endOk) {
      r.Ok = false;
      r.Error = "EndDocPrinter failed";
    } else {
      r.Ok = true;
    }
    return r;
  }
}
"@
$printer = '${name.replace(/'/g, "''")}'
$bytes = [System.IO.File]::ReadAllBytes('${tmp.replace(/'/g, "''")}')
$diag.bytesRequested = $bytes.Length
$result = [RawPrinterHelperDiag]::SendBytes($printer, $bytes, "${docEsc}")
$diag.openPrinterMs = $result.OpenPrinterMs
$diag.startDocMs = $result.StartDocMs
$diag.writePrinterMs = $result.WritePrinterMs
$diag.endDocMs = $result.EndDocMs
$diag.bytesWritten = $result.BytesWritten
$diag.windowsSpoolJobId = $result.JobId
$diag.ok = $result.Ok
if (-not $result.Ok) {
  $winErr = $([ComponentModel.Win32Exception]::new([Runtime.InteropServices.Marshal]::GetLastWin32Error()).Message)
  $msg = if ($result.Error) { $result.Error } else { "WritePrinter failed" }
  $diag.error = "$msg (Win32: $winErr)"
  $diag | ConvertTo-Json -Compress
  throw "$msg for $printer (Win32: $winErr)"
}
$diag | ConvertTo-Json -Compress
`;

    const powershellSpawnAt = Date.now();
    diag.powershellSpawnMs = 0;
    try {
      const stdout = await runPowershell(ps);
      diag.powershellExitMs = Date.now() - powershellSpawnAt;
      diag.powershellSpawnMs = diag.powershellExitMs;
      const parsed = parseDiagStdout(stdout);
      if (parsed) {
        diag.openPrinterMs = numOrNull(parsed.openPrinterMs);
        diag.startDocMs = numOrNull(parsed.startDocMs);
        diag.writePrinterMs = numOrNull(parsed.writePrinterMs);
        diag.endDocMs = numOrNull(parsed.endDocMs);
        diag.bytesWritten = numOrNull(parsed.bytesWritten);
        const jobId = numOrNull(parsed.windowsSpoolJobId);
        if (jobId != null && jobId > 0) {
          diag.windowsSpoolJobId = jobId;
          diag.windowsSpoolJobIdCaptured = true;
        }
        diag.stages = {
          openPrinterMs: diag.openPrinterMs,
          startDocMs: diag.startDocMs,
          writePrinterMs: diag.writePrinterMs,
          endDocMs: diag.endDocMs,
        };
      } else {
        diag.bytesWritten = bytesRequested;
      }
      diag.totalMs = Date.now() - printRawStartedAt;
      return {
        ok: true,
        submitted: true,
        windowsJobName: documentName,
        windowsSpoolJobId: diag.windowsSpoolJobIdCaptured ? diag.windowsSpoolJobId : null,
        timing: diag,
      };
    } catch (e) {
      diag.powershellExitMs = Date.now() - powershellSpawnAt;
      diag.totalMs = Date.now() - printRawStartedAt;
      e.timing = diag;
      throw e;
    } finally {
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* ignore */
      }
    }
  }
}

function numOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Prefer last JSON object line from PowerShell stdout. */
export function parseDiagStdout(stdout = "") {
  const text = String(stdout || "").trim();
  if (!text) return null;
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (!line.startsWith("{")) continue;
    try {
      return JSON.parse(line);
    } catch {
      /* try previous */
    }
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
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
