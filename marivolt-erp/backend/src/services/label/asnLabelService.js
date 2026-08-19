import crypto from "crypto";
import LabelPrintJob from "../../models/LabelPrintJob.js";
import ReceivingUnit from "../../models/ReceivingUnit.js";
import {
  getLabelSettings,
} from "./labelSettingsService.js";
import { resolvePrinterForJob } from "./printerManager.js";
import {
  MARIVOLT_STANDARD_TEMPLATE_CODE,
  ensureMarivoltStandardTemplate,
} from "./labelTemplateService.js";
import { encodeBarcodeValue } from "./barcodeGenerator.js";
import { buildJobTspl, buildSingleLabelTspl } from "./tsplGenerator.js";
import { auditLabelEvent, recordLabelHistory } from "./labelAudit.js";
import { resolveLabelCompanyBranding } from "./labelCompanyBranding.js";
import Company from "../../models/Company.js";
import { isSuccessfulLabelJobStatus } from "../../utils/grnLabelDistribution.js";
import { ReceivingUnitError, buildReceivingUnitLabelFingerprint } from "../../utils/receivingUnitRules.js";
import {
  applyReceivingUnitPrintResult,
  getReceivingUnitById,
  listReceivingUnitsForAsn,
  loadAsnForCompany,
  loadPersistedRusForPrint,
  previewPayloadFromReceivingUnits,
  serializeRu,
} from "../receivingUnitService.js";
import { actorName } from "../../utils/asnRules.js";

function t(v) {
  return String(v ?? "").trim();
}

function upper(v) {
  return t(v).toUpperCase();
}

function jobNo() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `LBL${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${crypto.randomBytes(2).toString("hex").toUpperCase()}`;
}

export function isAsnLabelJob(job) {
  return String(job?.sourceType || "").toUpperCase() === "ASN";
}

export function asnLabelTsplOpts({ companyName, copies = 1 } = {}) {
  return {
    copies: Math.max(1, Number(copies) || 1),
    companyName,
    barcodeMode: "LABEL_ID",
    faceVariant: "ASN_RU",
  };
}

export function buildAsnRuJobLine(ru, asn = {}) {
  const ruNo = upper(ru.ruNo);
  const barcode = encodeBarcodeValue({ mode: "LABEL_ID", labelId: ruNo });
  const plannedQty = Number(ru.plannedQty) || 0;
  return {
    article: upper(ru.article),
    description: t(ru.description),
    spn: t(ru.spn),
    partNo: t(ru.partNo),
    qty: plannedQty,
    uom: t(ru.uom) || "PCS",
    poNo: t(asn.sourcePoNo),
    asnNo: t(ru.asnNo || asn.asnNo),
    barcodeValue: barcode.value,
    labelId: ruNo,
    ruNo,
    receivingUnitId: ru._id,
    asnLineId: ru.asnLineId,
    labelQty: 1,
    qtyPerLabel: plannedQty,
    labelCount: 1,
    labelDistribution: [plannedQty],
  };
}

async function loadCompanyName(companyId) {
  const company = await Company.findById(companyId).select("code name shortName").lean();
  return resolveLabelCompanyBranding(company);
}

/**
 * One LabelPrintJob per Receiving Unit so COMPLETED maps 1:1 to that RU.
 * copies is always 1 for distinct RU identities.
 */
async function enqueueOneRuJob(req, { asn, ru, printer, companyName, settings, isReprint = false, reason = "", parentJobId = null }) {
  const status = String(ru.status || "").toUpperCase();
  if (status === "CANCELLED") {
    throw new ReceivingUnitError(`Receiving Unit ${ru.ruNo} is cancelled`, 400, "RU_CANCELLED");
  }
  if (status === "SUPERSEDED") {
    throw new ReceivingUnitError(
      `Receiving Unit ${ru.ruNo} was superseded. Use the current replacement label.`,
      400,
      "RU_SUPERSEDED"
    );
  }
  if (isReprint && status !== "PRINTED") {
    throw new ReceivingUnitError(
      `Receiving Unit ${ru.ruNo} can only be reprinted after a successful print`,
      400,
      "RU_REPRINT_NOT_PRINTED"
    );
  }
  const copies = 1;
  const line = buildAsnRuJobLine(ru, asn);
  const requestedLabels = 1;
  if (requestedLabels > settings.maxPerJob) {
    throw new ReceivingUnitError(
      `Requested labels (${requestedLabels}) exceed max per job (${settings.maxPerJob})`,
      400,
      "LABEL_MAX_EXCEEDED"
    );
  }
  const fingerprint = buildReceivingUnitLabelFingerprint([ru]);
  const inflight = await LabelPrintJob.findOne({
    companyId: req.companyId,
    sourceType: "ASN",
    "lines.receivingUnitId": ru._id,
    status: { $in: ["PENDING", "LEASED", "PRINTING"] },
  }).sort({ createdAt: -1 });
  if (inflight && !isReprint) return inflight;

  const tsplPayload = buildJobTspl([line], asnLabelTsplOpts({ companyName, copies }));
  const job = await LabelPrintJob.create({
    companyId: req.companyId,
    jobNo: jobNo(),
    sourceType: "ASN",
    sourceId: asn._id,
    sourceNo: upper(asn.asnNo),
    labelConfigFingerprint: fingerprint,
    warehouseCode: t(printer.warehouseCode),
    printerConfigId: printer._id,
    agentId: upper(printer.agentId),
    windowsPrinterName: t(printer.windowsPrinterName),
    templateCode: MARIVOLT_STANDARD_TEMPLATE_CODE,
    copies,
    requestedLabels,
    printedLabels: 0,
    remainingLabels: requestedLabels,
    lines: [line],
    tsplPayload,
    status: "PENDING",
    isReprint,
    reprintReason: isReprint ? t(reason) : "",
    parentJobId,
    createdByUserId: req.user?.id || req.user?._id || null,
    createdByName: t(req.user?.name || req.user?.email || actorName(req)),
  });

  await ReceivingUnit.updateOne(
    { _id: ru._id, companyId: req.companyId, status: { $in: ["PLANNED", "PRINTED"] } },
    { $set: { lastLabelJobId: job._id } }
  );

  await recordLabelHistory({
    jobId: job._id,
    companyId: req.companyId,
    agentId: job.agentId,
    windowsPrinterName: job.windowsPrinterName,
    requestedQty: requestedLabels,
    printedQty: 0,
    status: "PENDING",
    templateCode: job.templateCode,
    userId: job.createdByUserId,
    userName: job.createdByName,
    event: isReprint ? `REPRINT:${reason}` : "ENQUEUE",
  });
  await auditLabelEvent(req, {
    action: isReprint ? "OTHER" : "CREATE",
    job,
    description: isReprint
      ? `ASN RU reprint ${job.jobNo} ${ru.ruNo}`
      : `ASN RU job ${job.jobNo} queued for ${ru.ruNo}`,
  });
  return job;
}

export async function previewJobsFromAsn(req, body = {}) {
  const asn = await loadAsnForCompany(req.companyId, body.asnId || req.params?.id);
  const rus = await loadPersistedRusForPrint(req.companyId, asn._id, body.receivingUnitIds);
  const companyName = await loadCompanyName(req.companyId);
  const faces = previewPayloadFromReceivingUnits(rus, asn).map((face) => {
    const line = buildAsnRuJobLine(face, asn);
    const tspl = buildSingleLabelTspl(line, {
      ...asnLabelTsplOpts({ companyName, copies: 1 }),
      qtyPerLabel: face.plannedQty,
    });
    return { ...face, tsplPreview: tspl.slice(0, 1500) };
  });
  return {
    asnId: asn._id,
    asnNo: asn.asnNo,
    templateCode: MARIVOLT_STANDARD_TEMPLATE_CODE,
    barcodeMode: "LABEL_ID",
    faces,
  };
}

export async function createJobsFromAsn(req, body = {}) {
  const companyId = req.companyId;
  const settings = await getLabelSettings(companyId);
  if (!settings.enabled) {
    const err = new Error("Label printing is disabled. Enable it in Label Settings.");
    err.code = "LABEL_DISABLED";
    err.statusCode = 400;
    throw err;
  }

  const asn = await loadAsnForCompany(companyId, body.asnId);
  const listing = await listReceivingUnitsForAsn(companyId, asn._id);
  if (!listing.eligible) {
    throw new ReceivingUnitError(
      "Receiving Unit labels can only be printed when the ASN is SHIPPED or ARRIVED",
      400,
      "RU_ASN_STATUS"
    );
  }

  const rus = (await loadPersistedRusForPrint(companyId, asn._id, body.receivingUnitIds)).filter(
    (ru) => String(ru.status || "").toUpperCase() === "PLANNED"
  );
  if (!rus.length) {
    throw new ReceivingUnitError("No planned Receiving Units to print", 400, "RU_NOTHING_TO_PRINT");
  }

  await ensureMarivoltStandardTemplate();
  const printer = await resolvePrinterForJob(companyId, body.printerCode, {
    warehouseCode: upper(body.warehouseCode),
  });
  const companyName = await loadCompanyName(companyId);

  const jobs = [];
  for (const ru of rus) {
    const job = await enqueueOneRuJob(req, { asn, ru, printer, companyName, settings });
    jobs.push(job);
  }
  return { jobs, count: jobs.length, asnNo: asn.asnNo };
}

export async function reprintReceivingUnit(req, asnId, ruId, body = {}) {
  const settings = await getLabelSettings(req.companyId);
  if (!settings.enabled) {
    const err = new Error("Label printing is disabled. Enable it in Label Settings.");
    err.code = "LABEL_DISABLED";
    err.statusCode = 400;
    throw err;
  }
  if (!settings.allowManualReprint) {
    const err = new Error("Manual reprint is disabled");
    err.statusCode = 403;
    throw err;
  }
  const reason = t(body.reason);
  if (!reason) {
    const err = new Error("Reprint reason is required");
    err.statusCode = 400;
    throw err;
  }

  const asn = await loadAsnForCompany(req.companyId, asnId);
  const ru = await getReceivingUnitById(req.companyId, ruId);
  if (String(ru.asnId) !== String(asn._id)) {
    throw new ReceivingUnitError("Receiving Unit does not belong to this ASN", 404, "RU_ASN_MISMATCH");
  }
  if (ru.status === "CANCELLED") {
    throw new ReceivingUnitError(`Receiving Unit ${ru.ruNo} is cancelled`, 400, "RU_CANCELLED");
  }
  if (ru.status === "SUPERSEDED") {
    throw new ReceivingUnitError(
      `Receiving Unit ${ru.ruNo} was superseded. Use the current replacement label.`,
      400,
      "RU_SUPERSEDED"
    );
  }

  await ensureMarivoltStandardTemplate();
  const printer = await resolvePrinterForJob(req.companyId, body.printerCode, {
    warehouseCode: upper(body.warehouseCode),
  });
  const companyName = await loadCompanyName(req.companyId);
  const job = await enqueueOneRuJob(req, {
    asn,
    ru,
    printer,
    companyName,
    settings,
    isReprint: true,
    reason,
    parentJobId: ru.lastLabelJobId || null,
  });
  return { job, receivingUnit: serializeRu(ru) };
}

export async function reprintAllReceivingUnits(req, asnId, body = {}) {
  const settings = await getLabelSettings(req.companyId);
  if (!settings.enabled) {
    const err = new Error("Label printing is disabled. Enable it in Label Settings.");
    err.code = "LABEL_DISABLED";
    err.statusCode = 400;
    throw err;
  }
  if (!settings.allowManualReprint) {
    const err = new Error("Manual reprint is disabled");
    err.statusCode = 403;
    throw err;
  }
  const reason = t(body.reason);
  if (!reason) {
    const err = new Error("Reprint reason is required");
    err.statusCode = 400;
    throw err;
  }

  const asn = await loadAsnForCompany(req.companyId, asnId);
  const listing = await listReceivingUnitsForAsn(req.companyId, asn._id);
  if (!listing.eligible) {
    throw new ReceivingUnitError(
      "Receiving Unit labels can only be reprinted when the ASN is SHIPPED or ARRIVED",
      400,
      "RU_ASN_STATUS"
    );
  }

  const rus = (listing.receivingUnits || []).filter((ru) => String(ru.status || "").toUpperCase() === "PRINTED");
  if (!rus.length) {
    throw new ReceivingUnitError(
      "No printed Receiving Units to reprint. Print RU Labels first.",
      400,
      "RU_REPRINT_NOT_PRINTED"
    );
  }

  await ensureMarivoltStandardTemplate();
  const printer = await resolvePrinterForJob(req.companyId, body.printerCode, {
    warehouseCode: upper(body.warehouseCode),
  });
  const companyName = await loadCompanyName(req.companyId);
  const jobs = [];
  const identities = [];
  for (const ru of rus) {
    const before = { ruNo: ru.ruNo, barcodeValue: ru.barcodeValue, plannedQty: ru.plannedQty };
    const job = await enqueueOneRuJob(req, {
      asn,
      ru,
      printer,
      companyName,
      settings,
      isReprint: true,
      reason,
      parentJobId: ru.lastLabelJobId || null,
    });
    jobs.push(job);
    identities.push(before);
  }
  return {
    jobs,
    count: jobs.length,
    asnNo: asn.asnNo,
    isReprint: true,
    receivingUnits: identities,
    ruPlanVersionUnchanged: true,
  };
}

export { applyReceivingUnitPrintResult, isSuccessfulLabelJobStatus };
