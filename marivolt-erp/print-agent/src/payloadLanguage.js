/**
 * Agent-side language / payload guards. Never silently rewrite a job.
 */

export const AGENT_LANGUAGES = Object.freeze(["TSPL", "ZPL"]);
export const AGENT_VERSION = "1.9.0";

export function normalizeJobLanguage(job = {}) {
  const explicit = String(job.language || "")
    .trim()
    .toUpperCase();
  if (AGENT_LANGUAGES.includes(explicit)) return explicit;
  const payload = String(job.tsplPayload || "");
  if (/^\s*\^XA/m.test(payload)) return "ZPL";
  return "TSPL";
}

export function agentCapabilities() {
  return {
    languages: ["TSPL", "ZPL"],
    rawZpl: true,
  };
}

export function looksLikeTspl(payload) {
  return /(?:^|\r?\n)\s*(SIZE|GAPDETECT|CLS|PRINT)\b/im.test(String(payload || ""));
}

export function looksLikeZpl(payload) {
  const s = String(payload || "");
  return /\^XA/.test(s) || /\^XZ/.test(s);
}

/**
 * Jobs must name their Windows queue. Never substitute config.json's primary printer
 * (Deepak config may still list Rongta as the heartbeat printer).
 */
export function resolveJobWindowsQueue(jobPrinterName) {
  const name = String(jobPrinterName || "").trim();
  if (!name) {
    return {
      ok: false,
      error: "No Windows printer name on job; refusing config.json fallback",
    };
  }
  return { ok: true, printerName: name };
}

export function validateJobLanguagePayload(job = {}) {
  const language = normalizeJobLanguage(job);
  const payloadMode = String(job.payloadMode || "SINGLE_RAW").toUpperCase();
  const payload = String(job.tsplPayload || "");
  const faces = Array.isArray(job.rawFacePayloads) ? job.rawFacePayloads : [];

  if (language === "ZPL") {
    if (payloadMode === "TSPL_LABEL_BATCH" || payloadMode === "RAW_FACE_BATCH") {
      return {
        ok: false,
        language,
        error: `ZPL jobs cannot use payloadMode ${payloadMode}`,
      };
    }
    if (!payload.trim()) {
      return { ok: false, language, error: "Empty ZPL payload" };
    }
    if (!/\^XA/.test(payload) || !/\^XZ/.test(payload)) {
      return { ok: false, language, error: "ZPL payload must contain ^XA / ^XZ" };
    }
    if (looksLikeTspl(payload)) {
      return { ok: false, language, error: "ZPL payload contains TSPL commands" };
    }
    return { ok: true, language };
  }

  if (payloadMode === "TSPL_LABEL_BATCH" || payloadMode === "RAW_FACE_BATCH") {
    if (!faces.length) {
      return { ok: false, language: "TSPL", error: `${payloadMode} has no face payloads` };
    }
    if (faces.some((f) => looksLikeZpl(f))) {
      return { ok: false, language: "TSPL", error: "TSPL face batch contains ZPL" };
    }
    return { ok: true, language: "TSPL" };
  }

  if (!payload.trim()) {
    return { ok: false, language: "TSPL", error: "Empty TSPL payload" };
  }
  if (looksLikeZpl(payload)) {
    return { ok: false, language: "TSPL", error: "TSPL job contains ZPL payload" };
  }
  return { ok: true, language: "TSPL" };
}
