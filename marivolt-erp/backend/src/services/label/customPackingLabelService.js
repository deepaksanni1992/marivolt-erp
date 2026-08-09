/**
 * Manual CUSTOM_PACKING labels — same PACKING_STANDARD_100X50 face as packing stickers.
 * Print-only: does not touch stock, GRN, allocation, packing, reservation, SI, or dispatch.
 */
import crypto from "crypto";
import LabelPrintJob from "../../models/LabelPrintJob.js";
import { getLabelSettings } from "./labelSettingsService.js";
import { resolvePrinterForJob } from "./printerManager.js";
import {
  PACKING_STANDARD_TEMPLATE_CODE,
  ensurePackingStandardTemplate,
} from "./labelTemplateService.js";
import {
  buildPackingJobTspl,
  packingLabelPreviewRows,
  packingLabelDescriptionMeta,
} from "./tsplGenerator.js";
import { auditLabelEvent, recordLabelHistory } from "./labelAudit.js";

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

function err(message, statusCode = 400, code) {
  const e = new Error(message);
  e.statusCode = statusCode;
  if (code) e.code = code;
  return e;
}

const MAX_COPIES = 50;
const MAX_LINES = 50;

const FIELD_LIMITS = Object.freeze({
  customerName: 120,
  customerRef: 80,
  brand: 80,
  modelName: 80,
  article: 80,
  serialNo: 40,
  partNo: 80,
  description: 500,
});

/** QTY face text: "5 of 9" or "5" when total blank. */
export function formatCustomPackingQtyDisplay(labelQty, totalQty) {
  const n = Math.max(0, Math.floor(Number(labelQty) || 0));
  if (totalQty === null || totalQty === undefined || String(totalQty).trim() === "") {
    return String(n);
  }
  const d = Math.floor(Number(totalQty));
  if (!Number.isFinite(d) || d <= 0) return String(n);
  return `${n} of ${d}`;
}

export function buildCustomPackingFingerprint(lines = []) {
  const parts = (lines || []).map((ln) =>
    [
      t(ln.customerName),
      t(ln.customerRef),
      t(ln.brand),
      t(ln.modelName),
      upper(ln.article),
      t(ln.serialNo),
      t(ln.partNo),
      t(ln.description),
      String(Math.max(0, Math.floor(Number(ln.labelQty) || 0))),
      ln.totalQty === null || ln.totalQty === undefined || String(ln.totalQty).trim() === ""
        ? ""
        : String(Math.max(0, Math.floor(Number(ln.totalQty) || 0))),
      String(Math.max(1, Math.floor(Number(ln.lineCopies || ln.copies) || 1))),
    ].join("\t")
  );
  return parts.join("\n");
}

export function hashCustomPackingFingerprint(fingerprint) {
  return crypto.createHash("sha256").update(String(fingerprint || ""), "utf8").digest("hex").slice(0, 16);
}

export function buildCustomPackingIdempotencyKey(lines = []) {
  const fp = buildCustomPackingFingerprint(lines);
  return `custom-packing:${hashCustomPackingFingerprint(fp)}`;
}

function clip(value, max) {
  const s = t(value);
  if (s.length <= max) return s;
  return s.slice(0, max);
}

/**
 * Normalize and validate manual lines from request body.
 * Returns packing-face line objects ready for TSPL / LabelPrintJob.
 */
export function normalizeCustomPackingLines(rawLines = []) {
  if (!Array.isArray(rawLines) || !rawLines.length) {
    throw err("Add at least one custom label line", 400, "LABEL_NO_LINES");
  }
  if (rawLines.length > MAX_LINES) {
    throw err(`Maximum ${MAX_LINES} custom labels per job`, 400, "LABEL_MAX_EXCEEDED");
  }

  const lines = [];
  for (let i = 0; i < rawLines.length; i++) {
    const raw = rawLines[i] && typeof rawLines[i] === "object" ? rawLines[i] : {};
    const customerName = clip(raw.customerName, FIELD_LIMITS.customerName);
    const customerRef = clip(raw.customerRef, FIELD_LIMITS.customerRef);
    const brand = clip(raw.brand, FIELD_LIMITS.brand);
    const modelName = clip(raw.modelName ?? raw.model, FIELD_LIMITS.modelName);
    const article = clip(raw.article, FIELD_LIMITS.article);
    const serialNo = clip(raw.serialNo ?? raw.sNo ?? raw.serial, FIELD_LIMITS.serialNo);
    const partNo = clip(raw.partNo ?? raw.spn, FIELD_LIMITS.partNo);
    const description = clip(raw.description, FIELD_LIMITS.description);

    const labelQtyRaw = raw.labelQty;
    const labelQty = Math.floor(Number(labelQtyRaw));
    if (!Number.isFinite(labelQty) || labelQty <= 0) {
      throw err(`Line ${i + 1}: Label Qty must be a number greater than 0`, 400, "LABEL_QTY_INVALID");
    }

    const totalBlank =
      raw.totalQty === null || raw.totalQty === undefined || String(raw.totalQty).trim() === "";
    let totalQty = null;
    if (!totalBlank) {
      totalQty = Math.floor(Number(raw.totalQty));
      if (!Number.isFinite(totalQty) || totalQty <= 0) {
        throw err(`Line ${i + 1}: Total Qty must be blank or a number greater than 0`, 400, "LABEL_QTY_INVALID");
      }
      if (totalQty < labelQty) {
        throw err(
          `Line ${i + 1}: Total Qty must be greater than or equal to Label Qty`,
          400,
          "LABEL_QTY_INVALID"
        );
      }
    }

    const copies = Math.floor(Number(raw.copies ?? raw.lineCopies ?? 1));
    if (!Number.isFinite(copies) || copies < 1) {
      throw err(`Line ${i + 1}: Copies must be at least 1`, 400, "LABEL_COPIES_INVALID");
    }
    if (copies > MAX_COPIES) {
      throw err(`Line ${i + 1}: Copies cannot exceed ${MAX_COPIES}`, 400, "LABEL_COPIES_MAX");
    }

    const qtyDisplay = formatCustomPackingQtyDisplay(labelQty, totalBlank ? "" : totalQty);
    const meta = packingLabelDescriptionMeta({ description });

    lines.push({
      customerName,
      customerRef,
      brand,
      modelName,
      article: upper(article),
      serialNo: serialNo || String(i + 1),
      partNo,
      spn: partNo,
      description,
      labelQty,
      totalQty: totalBlank ? 0 : totalQty,
      qty: totalBlank ? labelQty : totalQty,
      qtyDisplay,
      uom: "PCS",
      lineCopies: copies,
      descriptionTruncated: meta.descriptionTruncated === true,
      packingLineId: "",
      allocationLineId: "",
      packageId: "",
      materialCode: "",
    });
  }
  return lines;
}

export async function previewCustomPackingLabels(req, body = {}) {
  const settings = await getLabelSettings(req.companyId);
  if (!settings.enabled) {
    throw err("Label printing is disabled. Enable it in Label Settings.", 400, "LABEL_DISABLED");
  }
  const lines = normalizeCustomPackingLines(body.lines);
  await ensurePackingStandardTemplate();
  const tsplPayload = buildPackingJobTspl(lines, {});
  const requestedLabels = lines.reduce((s, ln) => s + Math.max(1, Number(ln.lineCopies) || 1), 0);
  const descriptionTruncated = lines.some((ln) => ln.descriptionTruncated === true);
  return {
    mode: "CUSTOM_PACKING",
    sourceType: "CUSTOM_PACKING",
    sourceNo: "CUSTOM",
    templateCode: PACKING_STANDARD_TEMPLATE_CODE,
    requestedLabels,
    descriptionTruncated,
    requiresTruncationConfirmation: descriptionTruncated,
    overflowWarning: descriptionTruncated
      ? "Description exceeds printable area. Review label before printing."
      : "",
    overflowDetail: descriptionTruncated ? "Printed text will be truncated." : "",
    customSelectionFingerprint: buildCustomPackingFingerprint(lines),
    labels: lines.map((ln) => ({
      ...ln,
      previewRows: packingLabelPreviewRows(ln),
      descriptionTruncated: ln.descriptionTruncated === true,
      tsplSample: buildPackingJobTspl([{ ...ln, lineCopies: 1 }], {}),
    })),
    tsplPayload,
  };
}

export async function createJobsFromCustomPacking(req, body = {}) {
  const companyId = req.companyId;
  const settings = await getLabelSettings(companyId);
  if (!settings.enabled) {
    throw err("Label printing is disabled. Enable it in Label Settings.", 400, "LABEL_DISABLED");
  }

  const lines = normalizeCustomPackingLines(body.lines);
  const descriptionTruncated = lines.some((ln) => ln.descriptionTruncated === true);
  const confirmTruncation =
    body.confirmDescriptionTruncation === true || body.confirmTruncatedDescription === true;
  if (descriptionTruncated && !confirmTruncation) {
    throw err(
      "Description exceeds printable area. Confirm truncation before printing.",
      400,
      "LABEL_DESCRIPTION_OVERFLOW"
    );
  }

  const fingerprint = buildCustomPackingFingerprint(lines);
  const idempotencyKey = buildCustomPackingIdempotencyKey(lines);

  if (idempotencyKey) {
    const existing = await LabelPrintJob.findOne({ companyId, idempotencyKey });
    if (existing) return existing;
  }

  await ensurePackingStandardTemplate();
  const printer = await resolvePrinterForJob(companyId, body.printerCode, {
    warehouseCode: upper(body.warehouseCode) || undefined,
  });

  const requestedLabels = lines.reduce((s, ln) => s + Math.max(1, Number(ln.lineCopies) || 1), 0);
  if (requestedLabels > settings.maxPerJob) {
    throw err(
      `Requested labels (${requestedLabels}) exceed max per job (${settings.maxPerJob})`,
      400,
      "LABEL_MAX_EXCEEDED"
    );
  }

  const tsplPayload = buildPackingJobTspl(lines, {});
  const jobLines = lines.map((ln) => ({
    article: ln.article,
    description: ln.description,
    spn: ln.partNo,
    partNo: ln.partNo,
    materialCode: "",
    qty: ln.totalQty || ln.labelQty,
    totalQty: ln.totalQty || 0,
    labelQty: ln.labelQty,
    qtyDisplay: ln.qtyDisplay,
    uom: "PCS",
    customerName: ln.customerName,
    customerRef: ln.customerRef,
    brand: ln.brand,
    modelName: ln.modelName,
    serialNo: ln.serialNo,
    lineCopies: ln.lineCopies,
    packingLineId: "",
    allocationLineId: "",
    packageId: "",
    descriptionTruncated: ln.descriptionTruncated === true,
  }));

  let job;
  try {
    job = await LabelPrintJob.create({
      companyId,
      jobNo: jobNo(),
      sourceType: "CUSTOM_PACKING",
      sourceId: null,
      sourceNo: "CUSTOM",
      warehouseCode: t(printer.warehouseCode),
      printerConfigId: printer._id,
      agentId: upper(printer.agentId),
      windowsPrinterName: t(printer.windowsPrinterName),
      templateCode: PACKING_STANDARD_TEMPLATE_CODE,
      copies: 1,
      requestedLabels,
      printedLabels: 0,
      remainingLabels: requestedLabels,
      lines: jobLines,
      tsplPayload,
      status: "PENDING",
      createdByUserId: req.user?.id || req.user?._id || null,
      createdByName: t(req.user?.name || req.user?.email || ""),
      idempotencyKey,
      isReprint: false,
      packingMode: "CUSTOM_PACKING",
      allocationId: null,
      packingId: null,
      descriptionTruncated,
      packingSelectionFingerprint: fingerprint,
    });
  } catch (e) {
    if (idempotencyKey && (e?.code === 11000 || String(e?.message || "").includes("duplicate"))) {
      const existing = await LabelPrintJob.findOne({ companyId, idempotencyKey });
      if (existing) return existing;
    }
    throw e;
  }

  await recordLabelHistory({
    jobId: job._id,
    companyId,
    agentId: job.agentId,
    windowsPrinterName: job.windowsPrinterName,
    requestedQty: requestedLabels,
    printedQty: 0,
    status: "PENDING",
    templateCode: job.templateCode,
    userId: job.createdByUserId,
    userName: job.createdByName,
    event: "ENQUEUE:CUSTOM_PACKING",
  });
  await auditLabelEvent(req, {
    action: "CREATE",
    job,
    description: `Custom packing label job ${job.jobNo} queued (${requestedLabels} stickers)`,
  });
  return job;
}
