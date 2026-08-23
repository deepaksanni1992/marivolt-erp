import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

/**
 * Lightweight Windows print-job status by spool JobId.
 * Uses a single small PowerShell command — no CIM/PnP/full printer inventory.
 */

export const SPOOL_JOB_STATES = Object.freeze({
  ABSENT: "ABSENT",
  QUEUED: "QUEUED",
  PRINTING: "PRINTING",
  ERROR: "ERROR",
  PAUSED: "PAUSED",
  UNKNOWN: "UNKNOWN",
  QUERY_FAILED: "QUERY_FAILED",
});

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

function mapJobStatus(raw) {
  const s = String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "");
  if (!s) return SPOOL_JOB_STATES.UNKNOWN;
  if (/error|failed|deleted|blocked|userintervention|offline/.test(s)) return SPOOL_JOB_STATES.ERROR;
  if (/paused|pause/.test(s)) return SPOOL_JOB_STATES.PAUSED;
  if (/printing|spooling|retained|restart/.test(s)) return SPOOL_JOB_STATES.PRINTING;
  if (/normal|pending|waiting|sentto/.test(s)) return SPOOL_JOB_STATES.QUEUED;
  return SPOOL_JOB_STATES.QUEUED;
}

/**
 * @param {string} printerName
 * @param {number|string} windowsSpoolJobId
 * @returns {Promise<{
 *   ok: boolean,
 *   present: boolean,
 *   state: string,
 *   jobStatusRaw: string,
 *   document: string,
 *   queryMs: number,
 *   error: string
 * }>}
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
    "  $j = Get-PrintJob -PrinterName $printer -ID $id -ErrorAction Stop | Select-Object -First 1 Id,JobStatus,Document",
    "  if ($null -eq $j) { @{ present=$false; jobStatus=''; document='' } | ConvertTo-Json -Compress }",
    "  else { @{ present=$true; jobStatus=[string]$j.JobStatus; document=[string]$j.Document } | ConvertTo-Json -Compress }",
    "} catch {",
    "  $msg = [string]$_.Exception.Message",
    `  if ($msg -match '${PS_ABSENT_MATCH}') {`,
    "    @{ present=$false; jobStatus=''; document=''; notFound=$true } | ConvertTo-Json -Compress",
    "  } else {",
    "    @{ present=$false; jobStatus=''; document=''; queryFailed=$true; error=$msg } | ConvertTo-Json -Compress",
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
        document: "",
        queryMs: Date.now() - started,
        error: "malformed-json",
      };
    }
    if (parsed.queryFailed || parsed.QueryFailed) {
      const qErr = String(parsed.error || parsed.Error || "query-failed").slice(0, 200);
      // Defensive: if PS still tagged queryFailed but the text is a clear not-found, treat ABSENT.
      if (isWindowsSpoolJobAbsentMessage(qErr)) {
        return {
          ok: true,
          present: false,
          state: SPOOL_JOB_STATES.ABSENT,
          jobStatusRaw: "",
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
        document: "",
        queryMs: Date.now() - started,
        error: "",
      };
    }
    const raw = String(parsed.jobStatus || parsed.JobStatus || "");
    return {
      ok: true,
      present: true,
      state: mapJobStatus(raw),
      jobStatusRaw: raw,
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

/** Pure mapper exported for unit tests. */
export function mapWindowsJobStatusText(raw) {
  return mapJobStatus(raw);
}
