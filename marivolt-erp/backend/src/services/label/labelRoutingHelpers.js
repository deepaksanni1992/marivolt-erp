import crypto from "crypto";

/** Online if heartbeat within this window (ms). */
export const AGENT_ONLINE_MS = 90_000;

/** Printer health is CURRENT only within this window (aligned with agent heartbeat). */
export const PRINTER_HEALTH_STALE_MS = AGENT_ONLINE_MS;

export const HEARTBEAT_LIMITS = Object.freeze({
  computerName: 120,
  operatingSystem: 80,
  windowsVersion: 80,
  appVersion: 40,
  department: 80,
  description: 240,
  lastError: 500,
  lastIp: 120,
  printerName: 200,
  availablePrinters: 50,
  printerStatus: 50,
  statusMessage: 240,
});

export const PRINTER_HEALTH_STATUSES = Object.freeze([
  "READY",
  "OFFLINE",
  "DISCONNECTED",
  "PAPER_OUT",
  "DOOR_OPEN",
  "PAUSED",
  "ERROR",
  "UNKNOWN",
]);

export function clampStr(v, max) {
  return String(v ?? "")
    .trim()
    .slice(0, Math.max(0, max));
}

export function normalizePrinterNames(list = []) {
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    const name = clampStr(raw, HEARTBEAT_LIMITS.printerName);
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
    if (out.length >= HEARTBEAT_LIMITS.availablePrinters) break;
  }
  return out;
}

function normalizePrinterHealthStatus(raw) {
  const s = String(raw || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "_");
  if (PRINTER_HEALTH_STATUSES.includes(s)) return s;
  // Legacy boolean-only heartbeats
  return "";
}

/**
 * Normalize one printerStatus heartbeat row (additive; keeps legacy {name,online}).
 */
export function normalizePrinterStatusRow(row = {}) {
  const name = clampStr(row?.name, HEARTBEAT_LIMITS.printerName);
  if (!name) return null;

  let status = normalizePrinterHealthStatus(row?.status);
  if (!status) {
    if (row?.online === true) status = "READY";
    else if (row?.online === false) status = "OFFLINE";
    else status = "UNKNOWN";
  }

  const connected =
    row?.connected != null ? Boolean(row.connected) : status === "READY" || status === "PAUSED";
  const offline =
    row?.offline != null
      ? Boolean(row.offline)
      : ["OFFLINE", "DISCONNECTED", "PAPER_OUT", "DOOR_OPEN", "ERROR"].includes(status);
  const paused = row?.paused != null ? Boolean(row.paused) : status === "PAUSED";
  const paperOut = row?.paperOut != null ? Boolean(row.paperOut) : status === "PAPER_OUT";
  const doorOpen = row?.doorOpen != null ? Boolean(row.doorOpen) : status === "DOOR_OPEN";
  const queueLength = Math.max(0, Math.min(100000, Number(row?.queueLength) || 0));
  const statusMessage = clampStr(row?.statusMessage || row?.message || "", HEARTBEAT_LIMITS.statusMessage);
  let lastSeen = null;
  if (row?.lastSeen) {
    const d = new Date(row.lastSeen);
    if (!Number.isNaN(d.getTime())) lastSeen = d;
  }
  if (!lastSeen) lastSeen = new Date();

  const online = status === "READY";

  return {
    name,
    status,
    connected,
    offline,
    paused,
    paperOut,
    doorOpen,
    queueLength,
    statusMessage,
    lastSeen,
    online,
    printerFound: row?.printerFound !== false,
  };
}

export function normalizePrinterStatusList(list = []) {
  const seen = new Set();
  const out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const row = normalizePrinterStatusRow(raw);
    if (!row) continue;
    const key = row.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
    if (out.length >= HEARTBEAT_LIMITS.printerStatus) break;
  }
  return out;
}

/**
 * Resolve physical printer health for a mapped Windows queue from agent telemetry.
 * Independent of agent ONLINE/OFFLINE.
 */
export function resolveMappedPrinterHealth(agent, windowsPrinterName, { agentOnline = null } = {}) {
  const want = clampStr(windowsPrinterName, HEARTBEAT_LIMITS.printerName);
  const online =
    agentOnline != null ? Boolean(agentOnline) : isAgentOnline(agent);

  if (!online) {
    return {
      printerStatus: "UNKNOWN",
      printerConnected: false,
      printerOffline: true,
      printerPaused: false,
      printerPaperOut: false,
      printerQueueLength: 0,
      printerStatusMessage: "Agent offline — printer status unknown",
      lastPrinterSeen: null,
      printerFound: false,
    };
  }

  if (!want) {
    return {
      printerStatus: "UNKNOWN",
      printerConnected: false,
      printerOffline: true,
      printerPaused: false,
      printerPaperOut: false,
      printerQueueLength: 0,
      printerStatusMessage: "No windows printer name mapped",
      lastPrinterSeen: agent?.lastHeartbeatAt || null,
      printerFound: false,
    };
  }

  const rows = Array.isArray(agent?.printerStatus) ? agent.printerStatus : [];
  const match = rows.find((r) => String(r?.name || "").toLowerCase() === want.toLowerCase());
  if (!match) {
    // Legacy agents: only availablePrinters names, no detailed health
    const listed = (agent?.availablePrinters || []).some(
      (n) => String(n).toLowerCase() === want.toLowerCase()
    );
    if (listed) {
      return {
        printerStatus: "UNKNOWN",
        printerConnected: true,
        printerOffline: false,
        printerPaused: false,
        printerPaperOut: false,
        printerQueueLength: 0,
        printerStatusMessage: "Legacy agent heartbeat (name present; detailed health unavailable)",
        lastPrinterSeen: agent?.lastHeartbeatAt || null,
        printerFound: true,
      };
    }
    return {
      printerStatus: "DISCONNECTED",
      printerConnected: false,
      printerOffline: true,
      printerPaused: false,
      printerPaperOut: false,
      printerQueueLength: 0,
      printerStatusMessage: "Configured printer not reported by agent",
      lastPrinterSeen: agent?.lastHeartbeatAt || null,
      printerFound: false,
    };
  }

  const normalized = normalizePrinterStatusRow(match) || match;
  const seenAt = normalized.lastSeen ? new Date(normalized.lastSeen).getTime() : 0;
  const hbAt = agent?.lastHeartbeatAt ? new Date(agent.lastHeartbeatAt).getTime() : 0;
  const freshness = Math.max(seenAt || 0, hbAt || 0);
  const now = Date.now();
  if (!freshness || now - freshness > PRINTER_HEALTH_STALE_MS) {
    return {
      printerStatus: "UNKNOWN",
      printerConnected: false,
      printerOffline: true,
      printerPaused: false,
      printerPaperOut: false,
      printerQueueLength: 0,
      printerStatusMessage: "Stale printer health — waiting for a fresh heartbeat",
      lastPrinterSeen: normalized.lastSeen || agent?.lastHeartbeatAt || null,
      printerFound: normalized.printerFound !== false,
    };
  }

  return {
    printerStatus: normalized.status || "UNKNOWN",
    printerConnected: Boolean(normalized.connected),
    printerOffline: Boolean(normalized.offline),
    printerPaused: Boolean(normalized.paused),
    printerPaperOut: Boolean(normalized.paperOut),
    printerQueueLength: Number(normalized.queueLength) || 0,
    printerStatusMessage: normalized.statusMessage || "",
    lastPrinterSeen: normalized.lastSeen || agent?.lastHeartbeatAt || null,
    printerFound: normalized.printerFound !== false,
  };
}

export function isAgentOnline(agent, now = Date.now()) {
  if (!agent || agent.isActive === false) return false;
  const hb = agent.lastHeartbeatAt ? new Date(agent.lastHeartbeatAt).getTime() : 0;
  return agent.status === "ONLINE" && hb && now - hb < AGENT_ONLINE_MS;
}

/**
 * Deterministic printer ranking among candidates.
 * Prefer: online agent → lowest pending → freshest heartbeat → stable code.
 */
export function rankPrinterCandidates(candidates = [], agentMap = {}, pendingMap = {}, now = Date.now()) {
  return [...candidates]
    .filter((p) => p && p.isActive !== false && String(p.windowsPrinterName || "").trim())
    .map((p) => {
      const agent = agentMap[String(p.agentId || "").toUpperCase()] || null;
      const online = isAgentOnline(agent, now) ? 1 : 0;
      const agentActive = agent && agent.isActive !== false ? 1 : 0;
      const pending = Number(pendingMap[String(p._id)] || pendingMap[p.code] || 0) || 0;
      const hb = agent?.lastHeartbeatAt ? new Date(agent.lastHeartbeatAt).getTime() : 0;
      const heartbeatAge = hb ? now - hb : Number.MAX_SAFE_INTEGER;
      return { printer: p, online, agentActive, pending, heartbeatAge, code: String(p.code || "") };
    })
    .filter((r) => r.agentActive)
    .sort((a, b) => {
      if (b.online !== a.online) return b.online - a.online;
      if (a.pending !== b.pending) return a.pending - b.pending;
      if (a.heartbeatAge !== b.heartbeatAge) return a.heartbeatAge - b.heartbeatAge;
      return a.code.localeCompare(b.code);
    })
    .map((r) => r.printer);
}

export function pickBestPrinter(candidates, agentMap, pendingMap, now) {
  const ranked = rankPrinterCandidates(candidates, agentMap, pendingMap, now);
  return ranked[0] || null;
}

export function timingSafeEqualUtf8(a, b) {
  const aa = Buffer.from(String(a || ""), "utf8");
  const bb = Buffer.from(String(b || ""), "utf8");
  if (aa.length !== bb.length) {
    crypto.timingSafeEqual(aa, aa);
    return false;
  }
  return crypto.timingSafeEqual(aa, bb);
}

/** Soft validation for agent version strings (non-fatal). */
export function sanitizeAppVersion(v) {
  const s = clampStr(v, HEARTBEAT_LIMITS.appVersion);
  if (!s) return "";
  // Allow semver-ish / free text but strip control chars
  return s.replace(/[\x00-\x1f\x7f]/g, "");
}

export function newInstallationId() {
  return crypto.randomUUID();
}
