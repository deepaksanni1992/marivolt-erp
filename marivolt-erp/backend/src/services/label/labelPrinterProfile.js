/**
 * Printer-profile purpose / media / language helpers.
 * Empty supportedPurposes or media on a printer = unrestricted (STORE / legacy).
 */
import PrintAgent from "../../models/PrintAgent.js";
import {
  LABEL_LANGUAGE_TSPL,
  LABEL_LANGUAGE_ZPL,
  MIN_AGENT_VERSION_ZPL,
  normalizeLabelLanguage,
  agentSupportsZpl,
  agentVersionAtLeast,
} from "./labelLanguages.js";
import { isAgentOnline } from "./labelRoutingHelpers.js";
import {
  LABEL_HEIGHT_MM,
  LABEL_WIDTH_MM,
  MARIVOLT_STANDARD_TEMPLATE_CODE,
  PACKING_STANDARD_TEMPLATE_CODE,
  PACKING_QR_LANDSCAPE_V1_TEMPLATE_CODE,
} from "../../models/LabelTemplate.js";
import { PACKING_QR_LANDSCAPE_V1_CODE } from "./packingQrLandscapeV1.js";

export const LABEL_PURPOSE_GRN = "GRN";
export const LABEL_PURPOSE_GRN_PREPOST = "GRN_PREPOST";
export const LABEL_PURPOSE_STOCK = "STOCK";
export const LABEL_PURPOSE_MANUAL = "MANUAL";
export const LABEL_PURPOSE_PACKING = "PACKING";
export const LABEL_PURPOSE_CUSTOM_PACKING = "CUSTOM_PACKING";
export const LABEL_PURPOSE_ASN = "ASN";
export const LABEL_PURPOSE_TEST = "TEST";

export const LABEL_PURPOSES = Object.freeze([
  LABEL_PURPOSE_GRN,
  LABEL_PURPOSE_GRN_PREPOST,
  LABEL_PURPOSE_STOCK,
  LABEL_PURPOSE_MANUAL,
  LABEL_PURPOSE_PACKING,
  LABEL_PURPOSE_CUSTOM_PACKING,
  LABEL_PURPOSE_ASN,
  LABEL_PURPOSE_TEST,
]);

export const ZPL_GRN_LAYOUT_VERSION = 1;
export const ZPL_ASN_RU_LAYOUT_VERSION = 1;
export const ZPL_DOTS_PER_MM = 8;
export const ZPL_WIDTH_MM = 100;
export const ZPL_HEIGHT_MM = 50;
export const ZPL_WIDTH_DOTS = 800;
export const ZPL_HEIGHT_DOTS = 400;

const LANDSCAPE_CODES = new Set([
  String(PACKING_QR_LANDSCAPE_V1_TEMPLATE_CODE || "").toUpperCase(),
  String(PACKING_QR_LANDSCAPE_V1_CODE || "").toUpperCase(),
]);

function t(v) {
  return String(v ?? "").trim();
}

function upper(v) {
  return t(v).toUpperCase();
}

export function labelRoutingError(message, code, statusCode = 400) {
  const err = new Error(message);
  err.code = code || "LABEL_PRINTER_INCOMPATIBLE";
  err.statusCode = statusCode;
  return err;
}

/** Incoming GRN/RU and packing/dispatch must name a printer so jobs cannot silently hit another laptop. */
export function requirePrinterCode(printerCode, purpose) {
  if (t(printerCode)) return t(printerCode);
  throw labelRoutingError(
    `Select a printer for ${purpose || "these"} labels. Automatic routing is disabled so this job cannot be sent to another laptop.`,
    "LABEL_PRINTER_REQUIRED"
  );
}

export function purposeFromSourceType(sourceType, { templateCode } = {}) {
  const st = upper(sourceType);
  if (st === "GRN") return LABEL_PURPOSE_GRN;
  if (st === "GRN_PREPOST") return LABEL_PURPOSE_GRN_PREPOST;
  if (st === "STOCK") return LABEL_PURPOSE_STOCK;
  if (st === "MANUAL") return LABEL_PURPOSE_MANUAL;
  if (st === "PACKING") return LABEL_PURPOSE_PACKING;
  if (st === "CUSTOM_PACKING") return LABEL_PURPOSE_CUSTOM_PACKING;
  if (st === "ASN") return LABEL_PURPOSE_ASN;
  if (st === "TEST") return LABEL_PURPOSE_TEST;
  if (isLandscapeTemplate(templateCode)) return LABEL_PURPOSE_PACKING;
  return LABEL_PURPOSE_GRN;
}

export function isLandscapeTemplate(templateCode) {
  return LANDSCAPE_CODES.has(upper(templateCode));
}

export function templateMedia(templateCode, { purpose } = {}) {
  const code = upper(templateCode);
  if (isLandscapeTemplate(code)) {
    return {
      templateCode: code || PACKING_QR_LANDSCAPE_V1_CODE,
      widthMm: 100,
      heightMm: 150,
      language: LABEL_LANGUAGE_TSPL,
    };
  }
  if (code === PACKING_STANDARD_TEMPLATE_CODE) {
    return {
      templateCode: PACKING_STANDARD_TEMPLATE_CODE,
      widthMm: LABEL_WIDTH_MM,
      heightMm: LABEL_HEIGHT_MM,
      language: LABEL_LANGUAGE_TSPL,
    };
  }
  if (purpose === LABEL_PURPOSE_ASN) {
    return {
      templateCode: code || MARIVOLT_STANDARD_TEMPLATE_CODE,
      widthMm: LABEL_WIDTH_MM,
      heightMm: LABEL_HEIGHT_MM,
      language: null,
    };
  }
  return {
    templateCode: code || MARIVOLT_STANDARD_TEMPLATE_CODE,
    widthMm: LABEL_WIDTH_MM,
    heightMm: LABEL_HEIGHT_MM,
    language: null,
  };
}

export function printerLanguage(printer) {
  return normalizeLabelLanguage(printer?.language, { defaultLanguage: LABEL_LANGUAGE_TSPL });
}

export function printerPurposes(printer) {
  const raw = Array.isArray(printer?.supportedPurposes) ? printer.supportedPurposes : [];
  const list = raw.map(upper).filter((p) => LABEL_PURPOSES.includes(p));
  return list;
}

export function printerAllowsPurpose(printer, purpose) {
  const want = upper(purpose);
  if (!want) return true;
  const list = printerPurposes(printer);
  if (!list.length) return true;
  return list.includes(want);
}

export function printerHasMediaLock(printer) {
  const w = Number(printer?.widthMm);
  const h = Number(printer?.heightMm);
  return Number.isFinite(w) && w > 0 && Number.isFinite(h) && h > 0;
}

export function printerSupportsTemplate(printer, templateCode) {
  const codes = Array.isArray(printer?.supportedTemplateCodes)
    ? printer.supportedTemplateCodes.map(upper).filter(Boolean)
    : [];
  if (!codes.length) return true;
  const want = upper(templateCode);
  if (!want) return true;
  return codes.includes(want);
}

function mediaMatches(printer, widthMm, heightMm) {
  if (!printerHasMediaLock(printer)) return true;
  if (widthMm == null || heightMm == null) return true;
  return Number(printer.widthMm) === Number(widthMm) && Number(printer.heightMm) === Number(heightMm);
}

export function jobDestinationSnapshot(printer, extras = {}) {
  const language = extras.language || printerLanguage(printer);
  const layoutVersion =
    extras.layoutVersion != null
      ? Number(extras.layoutVersion)
      : language === LABEL_LANGUAGE_ZPL
        ? extras.purpose === LABEL_PURPOSE_ASN
          ? ZPL_ASN_RU_LAYOUT_VERSION
          : ZPL_GRN_LAYOUT_VERSION
        : 1;
  const widthMm =
    extras.widthMm != null
      ? Number(extras.widthMm)
      : printerHasMediaLock(printer)
        ? Number(printer.widthMm)
        : LABEL_WIDTH_MM;
  const heightMm =
    extras.heightMm != null
      ? Number(extras.heightMm)
      : printerHasMediaLock(printer)
        ? Number(printer.heightMm)
        : LABEL_HEIGHT_MM;
  const dpi = extras.dpi != null ? Number(extras.dpi) : Number(printer?.dpi) || 203;
  return {
    printerConfigId: printer?._id || null,
    printerCode: upper(printer?.code),
    printerDisplayName: t(printer?.displayName || printer?.code),
    agentId: upper(printer?.agentId),
    windowsPrinterName: t(printer?.windowsPrinterName),
    language,
    layoutVersion,
    widthMm,
    heightMm,
    dpi,
  };
}

export function destinationsMatch(job, printer) {
  if (!job || !printer) return false;
  if (job.printerConfigId && printer._id && String(job.printerConfigId) === String(printer._id)) {
    return true;
  }
  const jobCode = upper(job.printerCode);
  if (jobCode && jobCode === upper(printer.code)) return true;
  return (
    upper(job.agentId) === upper(printer.agentId) &&
    t(job.windowsPrinterName).toLowerCase() === t(printer.windowsPrinterName).toLowerCase()
  );
}

const PRINTER_KEY_RE = /:prt:[A-Z0-9._-]+$/i;

export function bindIdempotencyKeyToPrinter(key, printer) {
  const raw = t(key).slice(0, 120);
  if (!raw) return null;
  const code = upper(printer?.code || "AUTO") || "AUTO";
  if (PRINTER_KEY_RE.test(raw)) return raw.slice(0, 120);
  const bound = `${raw}:prt:${code}`;
  return bound.slice(0, 120);
}

export async function loadPrinterAgent(companyId, printer) {
  if (!printer?.agentId) return null;
  return PrintAgent.findOne({ companyId, agentId: upper(printer.agentId) }).lean();
}

/**
 * Validate printer for a label job. Never silently swaps destination.
 */
export function assertPrinterCompatible(printer, opts = {}) {
  const purpose = upper(opts.purpose);
  const templateCode = upper(opts.templateCode);
  const media = templateMedia(templateCode, { purpose });
  const language = printerLanguage(printer);
  const agent = opts.agent || null;

  if (!printer || printer.isActive === false) {
    throw labelRoutingError("Printer not found or inactive", "LABEL_PRINTER_MISSING");
  }
  if (!t(printer.windowsPrinterName)) {
    throw labelRoutingError(
      `Printer ${printer.code || ""} has no Windows printer name configured`,
      "LABEL_PRINTER_MISSING"
    );
  }
  if (opts.companyId && printer.companyId && String(printer.companyId) !== String(opts.companyId)) {
    throw labelRoutingError("Printer does not belong to this company", "LABEL_PRINTER_COMPANY", 403);
  }
  if (!agent || agent.isActive === false) {
    throw labelRoutingError(
      `Printer ${printer.code} is mapped to a disabled or missing agent (${printer.agentId || "—"})`,
      "LABEL_PRINTER_MISSING"
    );
  }
  if (upper(agent.agentId) !== upper(printer.agentId)) {
    throw labelRoutingError(
      `Printer ${printer.code} is not assigned to agent ${agent.agentId}`,
      "LABEL_PRINTER_AGENT_MISMATCH"
    );
  }
  if (opts.requireAgentId && upper(opts.requireAgentId) !== upper(printer.agentId)) {
    throw labelRoutingError(
      `Printer ${printer.code} belongs to agent ${printer.agentId}, not ${opts.requireAgentId}`,
      "LABEL_PRINTER_AGENT_MISMATCH"
    );
  }

  if (purpose && !printerAllowsPurpose(printer, purpose)) {
    throw labelRoutingError(
      `Printer ${printer.code} is not configured for ${purpose} labels`,
      "LABEL_PRINTER_PURPOSE_MISMATCH"
    );
  }
  if (templateCode && !printerSupportsTemplate(printer, templateCode)) {
    throw labelRoutingError(
      `Printer ${printer.code} does not support template ${templateCode}`,
      "LABEL_PRINTER_TEMPLATE_INCOMPATIBLE"
    );
  }

  if (language === LABEL_LANGUAGE_ZPL) {
    if (purpose === LABEL_PURPOSE_PACKING || purpose === LABEL_PURPOSE_CUSTOM_PACKING) {
      throw labelRoutingError(
        `Packing/dispatch labels require TSPL and cannot print on Zebra printer ${printer.code}`,
        "LABEL_PRINTER_TEMPLATE_INCOMPATIBLE"
      );
    }
    if (isLandscapeTemplate(templateCode)) {
      throw labelRoutingError(
        `Landscape packing template cannot print as ZPL on ${printer.code}`,
        "LABEL_PRINTER_TEMPLATE_INCOMPATIBLE"
      );
    }
    if (templateCode === PACKING_STANDARD_TEMPLATE_CODE) {
      throw labelRoutingError(
        `Packing 100×50 TSPL template cannot print as ZPL on ${printer.code}`,
        "LABEL_PRINTER_TEMPLATE_INCOMPATIBLE"
      );
    }
  }

  const wantLang = opts.language ? normalizeLabelLanguage(opts.language) : media.language;
  if (wantLang && language !== wantLang) {
    throw labelRoutingError(
      `Printer ${printer.code} speaks ${language}, but this label requires ${wantLang}`,
      "LABEL_PRINTER_LANGUAGE_MISMATCH"
    );
  }

  const widthMm = opts.widthMm != null ? Number(opts.widthMm) : media.widthMm;
  const heightMm = opts.heightMm != null ? Number(opts.heightMm) : media.heightMm;
  if (!mediaMatches(printer, widthMm, heightMm)) {
    throw labelRoutingError(
      `Printer ${printer.code} media is ${printer.widthMm}×${printer.heightMm} mm; label is ${widthMm}×${heightMm} mm`,
      "LABEL_PRINTER_MEDIA_MISMATCH"
    );
  }

  if (language === LABEL_LANGUAGE_ZPL && agent) {
    if (isAgentOnline(agent) && !agentSupportsZpl(agent)) {
      throw labelRoutingError(
        `Print agent ${agent.agentId} version ${agent.appVersion || "unknown"} cannot print ZPL. Update MarivoltPrintAgent to ${MIN_AGENT_VERSION_ZPL} or later.`,
        "LABEL_AGENT_ZPL_UNSUPPORTED",
        409
      );
    }
  }

  return {
    printer,
    agent,
    language,
    purpose: purpose || "",
    templateCode: templateCode || media.templateCode,
    widthMm,
    heightMm,
    dpi: Number(printer.dpi) || (language === LABEL_LANGUAGE_ZPL ? 203 : 203),
    layoutVersion:
      language === LABEL_LANGUAGE_ZPL
        ? purpose === LABEL_PURPOSE_ASN
          ? ZPL_ASN_RU_LAYOUT_VERSION
          : ZPL_GRN_LAYOUT_VERSION
        : 1,
  };
}

export function serializePrinterDestination(printer, agent = null, extras = {}) {
  const snap = jobDestinationSnapshot(printer, extras);
  return {
    ...snap,
    agentName: t(agent?.name || ""),
    agentComputerName: t(agent?.computerName || ""),
    printerModel: t(printer?.printerModel || ""),
    language: snap.language,
    supportedPurposes: printerPurposes(printer),
    windowsPrinterName: snap.windowsPrinterName,
  };
}

export { agentSupportsZpl, agentVersionAtLeast, MIN_AGENT_VERSION_ZPL };
