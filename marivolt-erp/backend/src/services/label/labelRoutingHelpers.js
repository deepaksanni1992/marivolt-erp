import crypto from "crypto";

/** Online if heartbeat within this window (ms). */
export const AGENT_ONLINE_MS = 90_000;

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
});

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
