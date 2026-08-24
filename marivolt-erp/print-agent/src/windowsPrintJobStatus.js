import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

/**
 * Lightweight Windows print-job status by spool JobId.
 * Uses a single small PowerShell command — no CIM/PnP/full printer inventory.
 *
 * PrintJobStatus bit flags (System.Printing / JOB_INFO_1):
 *   None=0, Paused=1, Error=2, Deleting=4, Spooling=8, Printing=16,
 *   Offline=32, PaperOut=64, Printed=128, Deleted=256, Blocked=512,
 *   UserIntervention=1024, Restarted=2048, Completed=4096, Retained=8192
 */

export const SPOOL_JOB_STATES = Object.freeze({
  ABSENT: "ABSENT",
  QUEUED: "QUEUED",
  PRINTING: "PRINTING",
  SPOOLING: "SPOOLING",
  /**
   * JOB_STATUS_PRINTED — only auto-success flag while the job row is still visible.
   * Failure bits always override.
   */
  PRINTED: "PRINTED",
  /**
   * Windows JOB_STATUS_COMPLETE alone — job may be sent but not proven printed.
   * Ambiguous: keep polling for PRINTED or ABSENT (never auto-COMPLETED alone).
   */
  WIN_COMPLETED: "WIN_COMPLETED",
  /**
   * Deleted / Deleting without a prior/current PRINTED bit — transitional/ambiguous
   * (cancel/remove is possible). Keep polling for ABSENT; do not auto-COMPLETED.
   */
  REMOVING: "REMOVING",
  ERROR: "ERROR",
  PAUSED: "PAUSED",
  UNKNOWN: "UNKNOWN",
  QUERY_FAILED: "QUERY_FAILED",
});

/** Win32 / System.Printing PrintJobStatus bits we care about. */
export const PRINT_JOB_STATUS_BITS = Object.freeze({
  NONE: 0,
  PAUSED: 1,
  ERROR: 2,
  DELETING: 4,
  SPOOLING: 8,
  PRINTING: 16,
  OFFLINE: 32,
  PAPEROUT: 64,
  PRINTED: 128,
  DELETED: 256,
  BLOCKED: 512,
  USER_INTERVENTION: 1024,
  RESTARTED: 2048,
  COMPLETED: 4096,
  RETAINED: 8192,
});

const FAIL_BITS =
  PRINT_JOB_STATUS_BITS.PAUSED |
  PRINT_JOB_STATUS_BITS.ERROR |
  PRINT_JOB_STATUS_BITS.OFFLINE |
  PRINT_JOB_STATUS_BITS.PAPEROUT |
  PRINT_JOB_STATUS_BITS.BLOCKED |
  PRINT_JOB_STATUS_BITS.USER_INTERVENTION;

/**
 * True when Windows/PowerShell text means the specific spool JobId is gone
 * (completed / already removed) — not a generic query failure.
 * Live wording: "The specified job does not exist."
 */
export function isWindowsSpoolJobAbsentMessage(message = "") {
  const msg = String(message || "");
  if (!msg.trim()) return false;
  return /no\s+print\s+job|cannot\s+find|not\s+found|objectnotfound|itemnotfound|does\s+not\s+exist/i.test(
    msg
  );
}

/** PowerShell -match fragment kept in sync with isWindowsSpoolJobAbsentMessage. */
const PS_ABSENT_MATCH =
  "No print job|cannot find|not found|ObjectNotFound|ItemNotFound|does not exist";

const FLAG_NAME_TO_BIT = Object.freeze({
  none: 0,
  paused: PRINT_JOB_STATUS_BITS.PAUSED,
  error: PRINT_JOB_STATUS_BITS.ERROR,
  deleting: PRINT_JOB_STATUS_BITS.DELETING,
  spooling: PRINT_JOB_STATUS_BITS.SPOOLING,
  printing: PRINT_JOB_STATUS_BITS.PRINTING,
  offline: PRINT_JOB_STATUS_BITS.OFFLINE,
  paperout: PRINT_JOB_STATUS_BITS.PAPEROUT,
  printed: PRINT_JOB_STATUS_BITS.PRINTED,
  deleted: PRINT_JOB_STATUS_BITS.DELETED,
  blocked: PRINT_JOB_STATUS_BITS.BLOCKED,
  userintervention: PRINT_JOB_STATUS_BITS.USER_INTERVENTION,
  restarted: PRINT_JOB_STATUS_BITS.RESTARTED,
  completed: PRINT_JOB_STATUS_BITS.COMPLETED,
  retained: PRINT_JOB_STATUS_BITS.RETAINED,
  // Legacy Get-PrintJob wordings
  normal: 0,
  pending: 0,
  waiting: 0,
  senttoprinter: PRINT_JOB_STATUS_BITS.COMPLETED,
});

/**
 * Parse Get-PrintJob JobStatus which may be a number, numeric string, or
 * flag names ("Printed,Deleted" / "Printing").
 * @returns {number} bitmask
 */
export function parsePrintJobStatusBits(raw) {
  if (raw == null || raw === "") return 0;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return raw >>> 0;
  }
  const s = String(raw).trim();
  if (!s) return 0;
  if (/^\d+$/.test(s)) return (Number(s) >>> 0);
  // Flag names, possibly comma/space separated
  let bits = 0;
  const parts = s.split(/[,|;+/]+|\s+/).map((p) => p.trim().toLowerCase()).filter(Boolean);
  for (const p of parts) {
    const key = p.replace(/[^a-z]/g, "");
    if (Object.prototype.hasOwnProperty.call(FLAG_NAME_TO_BIT, key)) {
      bits |= FLAG_NAME_TO_BIT[key];
    }
  }
  return bits >>> 0;
}

/**
 * Map raw JobStatus bits → agent state.
 *
 * Conservative success (while present): PRINTED bit only (no failure bits).
 * Deleted/Deleting alone → REMOVING (ambiguous; not ERROR, not COMPLETED).
 * Windows Completed alone → WIN_COMPLETED (ambiguous; wait for PRINTED/ABSENT).
 * Failure bits always win over Printed/Completed/Deleted.
 */
export function mapJobStatusBits(bits) {
  const b = (Number(bits) || 0) >>> 0;
  if (b & FAIL_BITS) {
    if (b & PRINT_JOB_STATUS_BITS.PAUSED) return SPOOL_JOB_STATES.PAUSED;
    return SPOOL_JOB_STATES.ERROR;
  }
  // Only JOB_STATUS_PRINTED is auto-success while the row is still visible.
  if (b & PRINT_JOB_STATUS_BITS.PRINTED) return SPOOL_JOB_STATES.PRINTED;
  if (b & (PRINT_JOB_STATUS_BITS.DELETED | PRINT_JOB_STATUS_BITS.DELETING)) {
    return SPOOL_JOB_STATES.REMOVING;
  }
  if (b & PRINT_JOB_STATUS_BITS.COMPLETED) return SPOOL_JOB_STATES.WIN_COMPLETED;
  if (b & PRINT_JOB_STATUS_BITS.PRINTING) return SPOOL_JOB_STATES.PRINTING;
  if (b & PRINT_JOB_STATUS_BITS.SPOOLING) return SPOOL_JOB_STATES.SPOOLING;
  if (b === 0 || b === PRINT_JOB_STATUS_BITS.RETAINED || b & PRINT_JOB_STATUS_BITS.RESTARTED) {
    return SPOOL_JOB_STATES.QUEUED;
  }
  return SPOOL_JOB_STATES.QUEUED;
}

function mapJobStatus(raw) {
  return mapJobStatusBits(parsePrintJobStatusBits(raw));
}

/**
 * @param {string} printerName
 * @param {number|string} windowsSpoolJobId
 */
export async function getWindowsPrintJobStatus(printerName, windowsSpoolJobId) {
  const started = Date.now();
  const name = String(printerName || "").trim();
  const jobId = Number(windowsSpoolJobId);
  if (!name) {
    return {
      ok: false,
      present: false,
      state: SPOOL_JOB_STATES.QUERY_FAILED,
      jobStatusRaw: "",
      jobStatusBits: 0,
      pagesPrinted: null,
      totalPages: null,
      document: "",
      queryMs: 0,
      error: "printer name required",
    };
  }
  if (!Number.isFinite(jobId) || jobId <= 0) {
    return {
      ok: false,
      present: false,
      state: SPOOL_JOB_STATES.QUERY_FAILED,
      jobStatusRaw: "",
      jobStatusBits: 0,
      pagesPrinted: null,
      totalPages: null,
      document: "",
      queryMs: 0,
      error: "invalid windows spool job id",
    };
  }
  if (process.platform !== "win32") {
    return {
      ok: true,
      present: false,
      state: SPOOL_JOB_STATES.ABSENT,
      jobStatusRaw: "",
      jobStatusBits: 0,
      pagesPrinted: null,
      totalPages: null,
      document: "",
      queryMs: Date.now() - started,
      error: "",
      mocked: true,
    };
  }

  const printerEsc = name.replace(/'/g, "''");
  const ps = [
    "$ErrorActionPreference='Stop'",
    `$printer='${printerEsc}'`,
    `$id=${Math.floor(jobId)}`,
    "try {",
    "  $j = Get-PrintJob -PrinterName $printer -ID $id -ErrorAction Stop | Select-Object -First 1 Id,JobStatus,Document,DocumentName,PagesPrinted,TotalPages",
    "  if ($null -eq $j) { @{ present=$false; jobStatus=''; jobStatusBits=0; document=''; pagesPrinted=$null; totalPages=$null } | ConvertTo-Json -Compress }",
    "  else {",
    "    $bits = 0; try { $bits = [uint32]$j.JobStatus } catch { $bits = 0 }",
    "    $doc = [string]($(if ($j.DocumentName) { $j.DocumentName } else { $j.Document }))",
    "    @{ present=$true; jobStatus=[string]$j.JobStatus; jobStatusBits=$bits; document=$doc; pagesPrinted=$j.PagesPrinted; totalPages=$j.TotalPages } | ConvertTo-Json -Compress",
    "  }",
    "} catch {",
    "  $msg = [string]$_.Exception.Message",
    `  if ($msg -match '${PS_ABSENT_MATCH}') {`,
    "    @{ present=$false; jobStatus=''; jobStatusBits=0; document=''; notFound=$true } | ConvertTo-Json -Compress",
    "  } else {",
    "    @{ present=$false; jobStatus=''; jobStatusBits=0; document=''; queryFailed=$true; error=$msg } | ConvertTo-Json -Compress",
    "  }",
    "}",
  ].join("; ");

  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", ps],
      { windowsHide: true, timeout: 8000, maxBuffer: 512 * 1024 }
    );
    const text = String(stdout || "").trim();
    let parsed = {};
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      return {
        ok: false,
        present: false,
        state: SPOOL_JOB_STATES.QUERY_FAILED,
        jobStatusRaw: "",
        jobStatusBits: 0,
        pagesPrinted: null,
        totalPages: null,
        document: "",
        queryMs: Date.now() - started,
        error: "malformed-json",
      };
    }
    if (parsed.queryFailed || parsed.QueryFailed) {
      const qErr = String(parsed.error || parsed.Error || "query-failed").slice(0, 200);
      if (isWindowsSpoolJobAbsentMessage(qErr)) {
        return {
          ok: true,
          present: false,
          state: SPOOL_JOB_STATES.ABSENT,
          jobStatusRaw: "",
          jobStatusBits: 0,
          pagesPrinted: null,
          totalPages: null,
          document: "",
          queryMs: Date.now() - started,
          error: "",
        };
      }
      return {
        ok: false,
        present: false,
        state: SPOOL_JOB_STATES.QUERY_FAILED,
        jobStatusRaw: "",
        jobStatusBits: 0,
        pagesPrinted: null,
        totalPages: null,
        document: "",
        queryMs: Date.now() - started,
        error: qErr,
      };
    }
    const present = Boolean(parsed.present || parsed.Present);
    if (!present) {
      return {
        ok: true,
        present: false,
        state: SPOOL_JOB_STATES.ABSENT,
        jobStatusRaw: "",
        jobStatusBits: 0,
        pagesPrinted: null,
        totalPages: null,
        document: "",
        queryMs: Date.now() - started,
        error: "",
      };
    }
    const raw = String(parsed.jobStatus || parsed.JobStatus || "");
    const bitsFromPs = Number(parsed.jobStatusBits ?? parsed.JobStatusBits);
    const bits = Number.isFinite(bitsFromPs)
      ? bitsFromPs >>> 0
      : parsePrintJobStatusBits(raw);
    return {
      ok: true,
      present: true,
      state: mapJobStatusBits(bits),
      jobStatusRaw: raw,
      jobStatusBits: bits,
      pagesPrinted:
        parsed.pagesPrinted == null && parsed.PagesPrinted == null
          ? null
          : Number(parsed.pagesPrinted ?? parsed.PagesPrinted),
      totalPages:
        parsed.totalPages == null && parsed.TotalPages == null
          ? null
          : Number(parsed.totalPages ?? parsed.TotalPages),
      document: String(parsed.document || parsed.Document || "").slice(0, 120),
      queryMs: Date.now() - started,
      error: "",
    };
  } catch (e) {
    const msg = String(e?.message || e || "query-failed").slice(0, 200);
    if (isWindowsSpoolJobAbsentMessage(msg)) {
      return {
        ok: true,
        present: false,
        state: SPOOL_JOB_STATES.ABSENT,
        jobStatusRaw: "",
        jobStatusBits: 0,
        pagesPrinted: null,
        totalPages: null,
        document: "",
        queryMs: Date.now() - started,
        error: "",
      };
    }
    return {
      ok: false,
      present: false,
      state: SPOOL_JOB_STATES.QUERY_FAILED,
      jobStatusRaw: "",
      jobStatusBits: 0,
      pagesPrinted: null,
      totalPages: null,
      document: "",
      queryMs: Date.now() - started,
      error: msg,
    };
  }
}

/**
 * Lightweight readiness for a single named printer (no CIM/PnP inventory).
 * @param {string} printerName
 */
export async function probePrinterReadyLightweight(printerName) {
  const started = Date.now();
  const name = String(printerName || "").trim();
  if (!name) {
    return {
      name: "",
      status: "UNKNOWN",
      queueLength: 0,
      printerFound: false,
      ok: false,
      timing: { totalMs: 0 },
      error: "printer name required",
    };
  }
  if (process.platform !== "win32") {
    return {
      name,
      status: "READY",
      queueLength: 0,
      printerFound: true,
      ok: true,
      mocked: true,
      timing: { totalMs: Date.now() - started },
      error: "",
    };
  }
  const printerEsc = name.replace(/'/g, "''");
  const ps = [
    "$ErrorActionPreference='Stop'",
    `$n='${printerEsc}'`,
    "try {",
    "  $p = Get-Printer -Name $n -ErrorAction Stop | Select-Object -First 1 Name,PrinterStatus,JobCount,WorkOffline",
    "  @{ found=$true; name=[string]$p.Name; printerStatus=[string]$p.PrinterStatus; jobCount=[int]($p.JobCount); workOffline=[bool]$p.WorkOffline } | ConvertTo-Json -Compress",
    "} catch {",
    "  @{ found=$false; name=$n; printerStatus=''; jobCount=0; workOffline=$false; error=[string]$_.Exception.Message } | ConvertTo-Json -Compress",
    "}",
  ].join("; ");
  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", ps],
      { windowsHide: true, timeout: 8000, maxBuffer: 256 * 1024 }
    );
    const parsed = JSON.parse(String(stdout || "").trim() || "{}");
    const found = Boolean(parsed.found || parsed.Found);
    const workOffline = Boolean(parsed.workOffline || parsed.WorkOffline);
    const gp = String(parsed.printerStatus || parsed.PrinterStatus || "").toLowerCase();
    let status = "UNKNOWN";
    if (!found) status = "DISCONNECTED";
    else if (workOffline || /offline/.test(gp)) status = "OFFLINE";
    else if (/paused|pause/.test(gp)) status = "PAUSED";
    else if (/error|door|paper|jam/.test(gp)) status = "ERROR";
    else if (/normal|idle|printing|warming|busy|0/.test(gp) || gp === "") status = "READY";
    else status = "READY";
    return {
      name: String(parsed.name || parsed.Name || name),
      status,
      queueLength: Math.max(0, Number(parsed.jobCount ?? parsed.JobCount) || 0),
      printerFound: found,
      online: found && !workOffline,
      connected: found && !workOffline,
      ok: true,
      timing: { totalMs: Date.now() - started, mode: "lightweight" },
      error: found ? "" : String(parsed.error || "").slice(0, 200),
    };
  } catch (e) {
    return {
      name,
      status: "UNKNOWN",
      queueLength: 0,
      printerFound: false,
      ok: false,
      timing: { totalMs: Date.now() - started, mode: "lightweight" },
      error: String(e?.message || e).slice(0, 200),
    };
  }
}

/** Pure mapper exported for unit tests (accepts raw text or bits). */
export function mapWindowsJobStatusText(raw) {
  return mapJobStatus(raw);
}

export function isTerminalSpoolSuccessState(state) {
  const s = String(state || "");
  return s === SPOOL_JOB_STATES.ABSENT || s === SPOOL_JOB_STATES.PRINTED;
}
