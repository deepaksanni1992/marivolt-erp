/**
 * Label printer languages. Additive: missing/blank job.language is TSPL (legacy jobs).
 */

export const LABEL_LANGUAGE_TSPL = "TSPL";
export const LABEL_LANGUAGE_ZPL = "ZPL";

export const LABEL_LANGUAGES = Object.freeze([LABEL_LANGUAGE_TSPL, LABEL_LANGUAGE_ZPL]);

/** First agent version that may accept ZPL RAW jobs. */
export const MIN_AGENT_VERSION_ZPL = "1.9.0";

export function normalizeLabelLanguage(raw, { defaultLanguage = LABEL_LANGUAGE_TSPL } = {}) {
  const v = String(raw || "")
    .trim()
    .toUpperCase();
  if (LABEL_LANGUAGES.includes(v)) return v;
  return defaultLanguage;
}

export function compareAgentVersions(a, b) {
  const parse = (v) =>
    String(v || "")
      .trim()
      .replace(/^[vV]/, "")
      .split(/[.+-]/)
      .map((p) => {
        const n = Number.parseInt(p, 10);
        return Number.isFinite(n) ? n : 0;
      });
  const aa = parse(a);
  const bb = parse(b);
  const len = Math.max(aa.length, bb.length, 3);
  for (let i = 0; i < len; i += 1) {
    const x = aa[i] || 0;
    const y = bb[i] || 0;
    if (x !== y) return x - y;
  }
  return 0;
}

export function agentVersionAtLeast(version, minimum) {
  if (!String(version || "").trim()) return false;
  return compareAgentVersions(version, minimum) >= 0;
}

/**
 * ZPL capability: explicit heartbeat languages, or appVersion >= 1.9.0.
 * Missing capabilities + old/empty version → TSPL only (STORE / un-upgraded Deepak).
 */
export function agentSupportsZpl(agent) {
  if (!agent || agent.isActive === false) return false;
  const langs = Array.isArray(agent.capabilities?.languages)
    ? agent.capabilities.languages.map((x) => String(x || "").trim().toUpperCase())
    : [];
  if (langs.includes(LABEL_LANGUAGE_ZPL)) return true;
  if (agent.capabilities?.rawZpl === true) return true;
  return agentVersionAtLeast(agent.appVersion, MIN_AGENT_VERSION_ZPL);
}

export function looksLikeZplPayload(payload) {
  const s = String(payload || "");
  return /^\s*\^XA/im.test(s) || /\^XZ\s*$/im.test(s);
}

export function looksLikeTsplPayload(payload) {
  const s = String(payload || "");
  return /(?:^|\r?\n)\s*(SIZE|GAPDETECT|CLS|PRINT)\b/im.test(s);
}
