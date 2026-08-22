/**
 * Manual CUSTOM_PACKING labels — same PACKING_STANDARD_100X50 face as packing stickers.
 * Print-only: does not touch stock, GRN, allocation, packing, reservation, SI, or dispatch.
 */
import crypto from "crypto";
import XLSX from "xlsx";
import LabelPrintJob from "../../models/LabelPrintJob.js";
import { parseExcelBufferToRows, rowGet } from "../../utils/excelParser.js";
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

export const MAX_CUSTOM_PACKING_COPIES = 50;
export const MAX_CUSTOM_PACKING_LINES = 50;
export const CUSTOM_PACKING_TSPL_OPTS = Object.freeze({ omitArticle: true });

export const CUSTOM_PACKING_SPREADSHEET_COLUMNS = Object.freeze([
  { key: "serialNo", header: "S. No." },
  { key: "partNo", header: "Part No." },
  { key: "description", header: "Description" },
  { key: "qty", header: "Qty" },
  { key: "labelCount", header: "No. of Labels" },
]);

const FIELD_LIMITS = Object.freeze({
  customerName: 120,
  customerRef: 80,
  brand: 80,
  modelName: 80,
  serialNo: 40,
  partNo: 80,
  description: 500,
});

/** QTY face text for custom labels — per-sticker quantity only (no "of N"). */
export function formatCustomPackingQtyDisplay(qty) {
  const n = Number(qty);
  if (!Number.isFinite(n) || n <= 0) return "0";
  return Number.isInteger(n) ? String(n) : String(n);
}

/** @deprecated Legacy "5 of 9" display — retained for historical job reads only. */
export function formatCustomPackingQtyDisplayLegacy(labelQty, totalQty) {
  const n = Math.max(0, Math.floor(Number(labelQty) || 0));
  if (totalQty === null || totalQty === undefined || String(totalQty).trim() === "") {
    return String(n);
  }
  const d = Math.floor(Number(totalQty));
  if (!Number.isFinite(d) || d <= 0) return String(n);
  return `${n} of ${d}`;
}

export function resolveCustomPackingHeader(body = {}) {
  const header = body.header && typeof body.header === "object" ? body.header : {};
  return {
    customerName: clip(header.customerName ?? body.customerName, FIELD_LIMITS.customerName),
    customerRef: clip(header.customerRef ?? body.customerRef, FIELD_LIMITS.customerRef),
    brand: clip(header.brand ?? body.brand, FIELD_LIMITS.brand),
    modelName: clip(header.modelName ?? header.model ?? body.modelName ?? body.model, FIELD_LIMITS.modelName),
  };
}

export function buildCustomPackingFingerprint(header = {}, lines = []) {
  const head = [
    t(header.customerName),
    t(header.customerRef),
    t(header.brand),
    t(header.modelName),
  ].join("\t");
  const parts = (lines || []).map((ln) =>
    [
      t(ln.serialNo),
      t(ln.partNo),
      t(ln.description),
      String(Number(ln.qty) || 0),
      String(Math.max(1, Math.floor(Number(ln.lineCopies || ln.labelCount) || 1))),
    ].join("\t")
  );
  return [head, ...parts].join("\n");
}

export function hashCustomPackingFingerprint(fingerprint) {
  return crypto.createHash("sha256").update(String(fingerprint || ""), "utf8").digest("hex").slice(0, 16);
}

export function buildCustomPackingIdempotencyKey(header = {}, lines = []) {
  const fp = buildCustomPackingFingerprint(header, lines);
  return `custom-packing:${hashCustomPackingFingerprint(fp)}`;
}

export function summarizeCustomPackingBatch(lines = []) {
  const rowCount = lines.length;
  const physicalLabels = lines.reduce(
    (s, ln) => s + Math.max(1, Math.floor(Number(ln.lineCopies || ln.labelCount) || 1)),
    0
  );
  const totalQtyRepresented = lines.reduce((s, ln) => {
    const qty = Number(ln.qty) || 0;
    const count = Math.max(1, Math.floor(Number(ln.lineCopies || ln.labelCount) || 1));
    return s + qty * count;
  }, 0);
  return { rowCount, physicalLabels, totalQtyRepresented };
}

function clip(value, max) {
  const s = t(value);
  if (s.length <= max) return s;
  return s.slice(0, max);
}

function isBlankImportRow(raw = {}) {
  const serialNo = rowGet(raw, "S. No.", "S No.", "S.No.", "Serial No.", "serialNo");
  const partNo = rowGet(raw, "Part No.", "Part No", "PartNo", "partNo", "SPN");
  const description = rowGet(raw, "Description", "description");
  const qty = rowGet(raw, "Qty", "qty", "Quantity", "Label Qty", "labelQty");
  const labelCount = rowGet(
    raw,
    "No. of Labels",
    "No of Labels",
    "Labels",
    "labelCount",
    "Copies",
    "copies"
  );
  return !serialNo && !partNo && !description && !qty && !labelCount;
}

function parsePositiveQty(raw, rowLabel) {
  const s = t(raw);
  if (!s) throw err(`Row ${rowLabel}: Qty is required`, 400, "LABEL_QTY_INVALID");
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) {
    throw err(`Row ${rowLabel}: Qty must be a number greater than 0`, 400, "LABEL_QTY_INVALID");
  }
  if (!Number.isInteger(n)) {
    throw err(`Row ${rowLabel}: Qty must be a whole number`, 400, "LABEL_QTY_INVALID");
  }
  return n;
}

function parseLabelCount(raw, rowLabel) {
  const s = t(raw);
  if (!s) throw err(`Row ${rowLabel}: No. of Labels is required`, 400, "LABEL_COPIES_INVALID");
  const n = Number(s);
  if (!Number.isFinite(n) || n < 1 || !Number.isInteger(n)) {
    throw err(`Row ${rowLabel}: No. of Labels must be a positive whole number`, 400, "LABEL_COPIES_INVALID");
  }
  if (n > MAX_CUSTOM_PACKING_COPIES) {
    throw err(
      `Row ${rowLabel}: No. of Labels cannot exceed ${MAX_CUSTOM_PACKING_COPIES}`,
      400,
      "LABEL_COPIES_MAX"
    );
  }
  return n;
}

/**
 * Parse spreadsheet rows (CSV object rows or Excel rowGet maps) into canonical row objects.
 */
export function parseCustomPackingSpreadsheetRows(rawRows = []) {
  const rows = [];
  for (const entry of rawRows) {
    const rowNumber = entry?.rowNumber || entry?._rowNumber || rows.length + 2;
    const data = entry?.data && typeof entry.data === "object" ? entry.data : entry || {};
    if (isBlankImportRow(data)) continue;
    const rowLabel = String(rowNumber);
    rows.push({
      serialNo: rowGet(data, "S. No.", "S No.", "S.No.", "Serial No.", "serialNo"),
      partNo: rowGet(data, "Part No.", "Part No", "PartNo", "partNo", "SPN"),
      description: rowGet(data, "Description", "description"),
      qty: parsePositiveQty(rowGet(data, "Qty", "qty", "Quantity", "Label Qty", "labelQty"), rowLabel),
      labelCount: parseLabelCount(
        rowGet(data, "No. of Labels", "No of Labels", "Labels", "labelCount", "Copies", "copies"),
        rowLabel
      ),
    });
  }
  if (!rows.length) {
    throw err("Spreadsheet has no data rows", 400, "LABEL_NO_LINES");
  }
  if (rows.length > MAX_CUSTOM_PACKING_LINES) {
    throw err(`Maximum ${MAX_CUSTOM_PACKING_LINES} rows per batch`, 400, "LABEL_MAX_EXCEEDED");
  }
  return rows;
}

export function parseCustomPackingSpreadsheetBuffer(buffer, filename = "") {
  const lower = String(filename || "").toLowerCase();
  if (lower.endsWith(".csv")) {
    const text = Buffer.isBuffer(buffer) ? buffer.toString("utf8") : String(buffer || "");
    const lines = text.split(/\r?\n/).filter((ln) => ln.trim() !== "");
    if (!lines.length) return [];
    const headers = lines[0].split(",").map((h) => h.trim().replace(/^"|"$/g, ""));
    return lines.slice(1).map((line, idx) => {
      const cells = line.split(",").map((c) => c.trim().replace(/^"|"$/g, ""));
      const data = {};
      headers.forEach((h, j) => {
        if (h) data[h] = cells[j] ?? "";
      });
      return { rowNumber: idx + 2, data };
    });
  }
  return parseExcelBufferToRows(buffer);
}

export function buildCustomPackingTemplateWorkbook() {
  const headers = CUSTOM_PACKING_SPREADSHEET_COLUMNS.map((c) => c.header);
  const ws = XLSX.utils.aoa_to_sheet([
    headers,
    ["1", "OR-220", "O-RING", 25, 2],
    ["2", "123456", "GASKET", 1, 4],
  ]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Custom Packing Labels");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
}

function resolveHeaderForRequest(body = {}, rawLines = []) {
  const header = resolveCustomPackingHeader(body);
  const hasHeader =
    header.customerName || header.customerRef || header.brand || header.modelName;
  if (hasHeader) return header;
  const first = rawLines[0] && typeof rawLines[0] === "object" ? rawLines[0] : {};
  return {
    customerName: clip(first.customerName, FIELD_LIMITS.customerName),
    customerRef: clip(first.customerRef, FIELD_LIMITS.customerRef),
    brand: clip(first.brand, FIELD_LIMITS.brand),
    modelName: clip(first.modelName ?? first.model, FIELD_LIMITS.modelName),
  };
}

/**
 * Normalize and validate manual lines from request body.
 * Returns packing-face line objects ready for TSPL / LabelPrintJob.
 */
export function normalizeCustomPackingLines(body = {}) {
  const rawLines = Array.isArray(body.lines) ? body.lines : Array.isArray(body) ? body : [];
  if (!rawLines.length) {
    throw err("Add at least one custom label row", 400, "LABEL_NO_LINES");
  }
  if (rawLines.length > MAX_CUSTOM_PACKING_LINES) {
    throw err(`Maximum ${MAX_CUSTOM_PACKING_LINES} custom labels per job`, 400, "LABEL_MAX_EXCEEDED");
  }

  const header = resolveHeaderForRequest(body, rawLines);
  const lines = [];

  for (let i = 0; i < rawLines.length; i++) {
    const raw = rawLines[i] && typeof rawLines[i] === "object" ? rawLines[i] : {};
    const rowLabel = String(i + 1);

    const serialNo = clip(raw.serialNo ?? raw.sNo ?? raw.serial, FIELD_LIMITS.serialNo);
    const partNo = clip(raw.partNo ?? raw.spn, FIELD_LIMITS.partNo);
    const description = clip(raw.description, FIELD_LIMITS.description);

    const qtyRaw = raw.qty ?? raw.labelQty;
    const qty = Math.floor(Number(qtyRaw));
    if (!Number.isFinite(qty) || qty <= 0) {
      throw err(`Row ${rowLabel}: Qty must be a number greater than 0`, 400, "LABEL_QTY_INVALID");
    }

    const labelCountRaw = raw.labelCount ?? raw.copies ?? raw.lineCopies ?? 1;
    const labelCountNum = Number(labelCountRaw);
    if (!Number.isFinite(labelCountNum) || labelCountNum < 1) {
      throw err(`Row ${rowLabel}: No. of Labels must be a positive whole number`, 400, "LABEL_COPIES_INVALID");
    }
    if (!Number.isInteger(labelCountNum)) {
      throw err(`Row ${rowLabel}: No. of Labels must be a positive whole number`, 400, "LABEL_COPIES_INVALID");
    }
    const labelCount = labelCountNum;
    if (labelCount > MAX_CUSTOM_PACKING_COPIES) {
      throw err(
        `Row ${rowLabel}: No. of Labels cannot exceed ${MAX_CUSTOM_PACKING_COPIES}`,
        400,
        "LABEL_COPIES_MAX"
      );
    }

    const qtyDisplay = formatCustomPackingQtyDisplay(qty);
    const meta = packingLabelDescriptionMeta({ description }, CUSTOM_PACKING_TSPL_OPTS);

    lines.push({
      customerName: header.customerName,
      customerRef: header.customerRef,
      brand: header.brand,
      modelName: header.modelName,
      article: "",
      serialNo: serialNo || String(i + 1),
      partNo,
      spn: partNo,
      description,
      qty,
      labelQty: qty,
      totalQty: 0,
      qtyDisplay,
      uom: "PCS",
      lineCopies: labelCount,
      labelCount,
      descriptionTruncated: meta.descriptionTruncated === true,
      packingLineId: "",
      allocationLineId: "",
      packageId: "",
      materialCode: "",
    });
  }
  return { header, lines };
}

export function expandCustomPackingPreviewLabels(lines = [], opts = CUSTOM_PACKING_TSPL_OPTS) {
  const out = [];
  for (const ln of lines) {
    const copies = Math.max(1, Math.floor(Number(ln.lineCopies || ln.labelCount) || 1));
    for (let i = 0; i < copies; i++) {
      out.push({
        ...ln,
        physicalLabelNo: out.length + 1,
        previewRows: packingLabelPreviewRows(ln, opts),
        descriptionTruncated: ln.descriptionTruncated === true,
      });
    }
  }
  return out;
}

export async function previewCustomPackingLabels(req, body = {}) {
  const settings = await getLabelSettings(req.companyId);
  if (!settings.enabled) {
    throw err("Label printing is disabled. Enable it in Label Settings.", 400, "LABEL_DISABLED");
  }
  const { header, lines } = normalizeCustomPackingLines(body);
  await ensurePackingStandardTemplate();
  const tsplPayload = buildPackingJobTspl(lines, CUSTOM_PACKING_TSPL_OPTS);
  const requestedLabels = lines.reduce((s, ln) => s + Math.max(1, Number(ln.lineCopies) || 1), 0);
  const descriptionTruncated = lines.some((ln) => ln.descriptionTruncated === true);
  const summary = summarizeCustomPackingBatch(lines);
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
    customSelectionFingerprint: buildCustomPackingFingerprint(header, lines),
    header,
    summary,
    labels: expandCustomPackingPreviewLabels(lines),
    tsplPayload,
  };
}

export async function createJobsFromCustomPacking(req, body = {}) {
  const companyId = req.companyId;
  const settings = await getLabelSettings(companyId);
  if (!settings.enabled) {
    throw err("Label printing is disabled. Enable it in Label Settings.", 400, "LABEL_DISABLED");
  }

  const { header, lines } = normalizeCustomPackingLines(body);
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

  const fingerprint = buildCustomPackingFingerprint(header, lines);
  const idempotencyKey = buildCustomPackingIdempotencyKey(header, lines);

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

  const tsplPayload = buildPackingJobTspl(lines, CUSTOM_PACKING_TSPL_OPTS);
  const jobLines = lines.map((ln) => ({
    article: ln.article || "",
    description: ln.description,
    spn: ln.partNo,
    partNo: ln.partNo,
    materialCode: "",
    qty: ln.qty,
    totalQty: 0,
    labelQty: ln.qty,
    qtyDisplay: ln.qtyDisplay,
    uom: "PCS",
    customerName: ln.customerName,
    customerRef: ln.customerRef,
    brand: ln.brand,
    modelName: ln.modelName,
    serialNo: ln.serialNo,
    lineCopies: ln.lineCopies,
    labelCount: ln.labelCount,
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
