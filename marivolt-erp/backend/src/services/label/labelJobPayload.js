/**
 * Shared GRN/standard-label payload + destination freeze for print jobs.
 */
import PrintAgent from "../../models/PrintAgent.js";
import LabelPrintJob from "../../models/LabelPrintJob.js";
import { buildJobTspl, buildTestLabelTspl } from "./tsplGenerator.js";
import { buildJobZpl, buildTestLabelZpl } from "./zplGenerator.js";
import {
  LABEL_LANGUAGE_TSPL,
  LABEL_LANGUAGE_ZPL,
  normalizeLabelLanguage,
} from "./labelLanguages.js";
import {
  assertPrinterCompatible,
  destinationsMatch,
  jobDestinationSnapshot,
  bindIdempotencyKeyToPrinter,
  printerLanguage,
  purposeFromSourceType,
  templateMedia,
} from "./labelPrinterProfile.js";

function upper(v) {
  return String(v || "").trim().toUpperCase();
}

export async function loadAndAssertPrinter(companyId, printer, opts = {}) {
  const agent = opts.agent
    ? opts.agent
    : await PrintAgent.findOne({ companyId, agentId: upper(printer.agentId) }).lean();
  return assertPrinterCompatible(printer, { ...opts, companyId, agent });
}

export function renderStandardLabelPayload(lines, opts = {}) {
  const language = normalizeLabelLanguage(opts.language);
  if (language === LABEL_LANGUAGE_ZPL) {
    return {
      language,
      payloadMode: "SINGLE_RAW",
      tsplPayload: buildJobZpl(lines, opts),
      rawFacePayloads: undefined,
    };
  }
  return {
    language: LABEL_LANGUAGE_TSPL,
    payloadMode: "SINGLE_RAW",
    tsplPayload: buildJobTspl(lines, opts),
    rawFacePayloads: undefined,
  };
}

export function renderTestLabelPayload(info, opts = {}) {
  const language = normalizeLabelLanguage(opts.language);
  if (language === LABEL_LANGUAGE_ZPL) {
    return {
      language,
      tsplPayload: buildTestLabelZpl(info, opts),
    };
  }
  return {
    language: LABEL_LANGUAGE_TSPL,
    tsplPayload: buildTestLabelTspl(info, opts),
  };
}

export function frozenDestinationFields(printer, extras = {}) {
  const snap = jobDestinationSnapshot(printer, extras);
  return {
    printerConfigId: snap.printerConfigId,
    printerCode: snap.printerCode,
    printerDisplayName: snap.printerDisplayName,
    agentId: snap.agentId,
    windowsPrinterName: snap.windowsPrinterName,
    language: snap.language,
    layoutVersion: snap.layoutVersion,
    widthMm: snap.widthMm,
    heightMm: snap.heightMm,
    dpi: snap.dpi,
  };
}

export async function findIdempotentJob(companyId, clientKey, printer) {
  const raw = String(clientKey || "").trim();
  if (!raw) return null;
  const bound = bindIdempotencyKeyToPrinter(raw, printer);
  if (bound) {
    const byBound = await LabelPrintJob.findOne({ companyId, idempotencyKey: bound });
    if (byBound) return byBound;
  }
  const legacy = await LabelPrintJob.findOne({ companyId, idempotencyKey: raw });
  if (legacy && destinationsMatch(legacy, printer)) return legacy;
  return null;
}

export { bindIdempotencyKeyToPrinter, printerLanguage, purposeFromSourceType, templateMedia };
