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
  packingLabelPreviewRows,
  packingLabelDescriptionMeta,
  buildPackingLabelBatchPayloads,
  measurePackingLabelGeometry,
} from "./tsplGenerator.js";
import { LABEL_PAYLOAD_MODE_TSPL_LABEL_BATCH } from "./labelPayloadModes.js";
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
      // Content identity only — session rowId is NOT part of printable fingerprint.
      t(ln.serialNo),
      t(ln.partNo),
      t(ln.description),
      String(Number(ln.qty) || 0),
      String(Math.max(1, Math.floor(Number(ln.lineCopies || ln.labelCount) || 1))),
    ].join("\t")
  );
  return [head, ...parts].join("\n");
}

/**
 * Printable content fingerprint for one custom packing row (header + line).
 * Durable across modal reload / re-import when contents are unchanged.
 * Does NOT include session rowId (that is ephemeral UI identity).
 */
export function buildCustomPackingContentFingerprint(header = {}, line = {}) {
  return buildCustomPackingFingerprint(header, [line]);
}

export function hashCustomPackingFingerprint(fingerprint) {
  return crypto.createHash("sha256").update(String(fingerprint || ""), "utf8").digest("hex").slice(0, 16);
}

/** Whole-batch key (legacy / multi-line diagnostics). Prefer row-scoped key for print. */
export function buildCustomPackingIdempotencyKey(header = {}, lines = []) {
  const fp = buildCustomPackingFingerprint(header, lines);
  return `custom-packing:${hashCustomPackingFingerprint(fp)}`;
}

/**
 * First-print idempotency for a single session row.
 * Includes session rowId so identical-content duplicates can each enqueue once,
 * while content hash still changes after edit-after-print.
 */
export function buildCustomPackingRowIdempotencyKey(header = {}, line = {}) {
  const rowId = t(line.customPackingRowId || line.rowId);
  if (!rowId) return "";
  const fp = buildCustomPackingContentFingerprint(header, line);
  return `custom-packing-row:${rowId}:${hashCustomPackingFingerprint(fp)}`;
}

/**
 * Rebuild content fingerprint from a persisted LabelPrintJob line
 * (header fields are denormalized onto the line at enqueue time).
 */
export function contentFingerprintFromCustomPackingJobLine(ln = {}) {
  return buildCustomPackingContentFingerprint(
    {
      customerName: ln.customerName,
      customerRef: ln.customerRef,
      brand: ln.brand,
      modelName: ln.modelName,
    },
    ln
  );
}

function jobLineCustomPackingRowId(job) {
  const ln = Array.isArray(job?.lines) && job.lines[0] ? job.lines[0] : null;
  return t(ln?.customPackingRowId || ln?.rowId);
}

function jobContentFingerprint(job) {
  const stored = t(job?.packingSelectionFingerprint);
  if (stored) return stored;
  const ln = Array.isArray(job?.lines) && job.lines[0] ? job.lines[0] : null;
  if (!ln) return "";
  return contentFingerprintFromCustomPackingJobLine(ln);
}

function summarizeBoundJobs(boundJobs = []) {
  if (!boundJobs.length) {
    return {
      status: "NOT_PRINTED",
      jobId: "",
      originalJobId: "",
      message: "",
    };
  }
  const byCreated = [...boundJobs].sort(
    (a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0)
  );
  const completed = byCreated.filter((j) => String(j.status || "").toUpperCase() === "COMPLETED");
  if (completed.length) {
    const original =
      completed.find((j) => j.isReprint !== true) ||
      completed.find((j) => !j.parentJobId) ||
      completed[0];
    const latest = completed[completed.length - 1];
    return {
      status: "PRINTED",
      jobId: String(latest._id || latest.id || ""),
      originalJobId: String(original._id || original.id || ""),
      message: "",
    };
  }
  const latest = byCreated[byCreated.length - 1];
  const st = String(latest.status || "").toUpperCase();
  if (st === "UNCERTAIN" || st === "PARTIAL") {
    return {
      status: "UNCERTAIN",
      jobId: String(latest._id || latest.id || ""),
      originalJobId: "",
      message: "Print status uncertain — confirm from Label Queue before reprinting",
    };
  }
  if (st === "PENDING" || st === "LEASED" || st === "PRINTING") {
    return {
      status: "PRINTING",
      jobId: String(latest._id || latest.id || ""),
      originalJobId: "",
      message: "",
    };
  }
  if (st === "FAILED") {
    return {
      status: "FAILED",
      jobId: "",
      originalJobId: "",
      message: latest.lastError || latest.error || "Print failed",
    };
  }
  return {
    status: "NOT_PRINTED",
    jobId: "",
    originalJobId: "",
    message: "",
  };
}

/**
 * Pure resolver: map current table rows → print UI state from persisted LabelPrintJob history.
 *
 * Custom Packing has no persisted source document. Session rowId (UUID) is ephemeral and is
 * NOT durable across modal close / re-import. After reload, rows are reconstructed by:
 *   content fingerprint + occurrence claim among identical fingerprints.
 * Do NOT introduce a CustomPacking persistence model here.
 *
 * Matching order:
 * 1) Same session customPackingRowId + same content fingerprint (strong)
 * 2) Same content fingerprint, occurrence-claimed (survives re-import / new UUIDs)
 * 3) Same session rowId but different content → NOT_PRINTED (edit-after-print); old jobs stay in history
 *
 * Conservative claim-count: N historical first-print lineages for a fingerprint may hydrate
 * at most N identical imported rows as PRINTED/Reprint; remaining identical rows stay Print.
 * Example: 1 COMPLETED lineage + 3 identical imports → 1 Reprint, 2 Print.
 */
export function resolveCustomPackingRowPrintStatesFromJobs(header = {}, lines = [], jobs = []) {
  const uiRows = (lines || []).map((ln, idx) => {
    const rowId = t(ln.customPackingRowId || ln.rowId);
    const contentFingerprint = buildCustomPackingContentFingerprint(header, ln);
    return { idx, rowId, contentFingerprint, line: ln };
  });

  const annotatedJobs = (jobs || [])
    .filter((j) => String(j.sourceType || "").toUpperCase() === "CUSTOM_PACKING" || !j.sourceType)
    .map((j) => ({
      job: j,
      rowId: jobLineCustomPackingRowId(j),
      contentFingerprint: jobContentFingerprint(j),
      createdAt: j.createdAt ? new Date(j.createdAt).getTime() : 0,
    }))
    .filter((x) => x.contentFingerprint)
    .sort((a, b) => a.createdAt - b.createdAt);

  const claimedJobIds = new Set();
  const bindings = new Map(); // ui idx → bound annotated jobs[]

  function bind(idx, annList) {
    const list = annList.filter((a) => a?.job && !claimedJobIds.has(String(a.job._id || a.job.id)));
    for (const a of list) claimedJobIds.add(String(a.job._id || a.job.id));
    bindings.set(idx, list);
  }

  // Pass 1: session rowId + matching content
  for (const row of uiRows) {
    if (!row.rowId) continue;
    const matches = annotatedJobs.filter(
      (a) =>
        a.rowId === row.rowId &&
        a.contentFingerprint === row.contentFingerprint &&
        !claimedJobIds.has(String(a.job._id || a.job.id))
    );
    if (matches.length) bind(row.idx, matches);
  }

  // Pass 2: content fingerprint occurrence claim (re-import / new session UUIDs)
  const poolByFp = new Map();
  for (const a of annotatedJobs) {
    if (claimedJobIds.has(String(a.job._id || a.job.id))) continue;
    if (!poolByFp.has(a.contentFingerprint)) poolByFp.set(a.contentFingerprint, []);
    poolByFp.get(a.contentFingerprint).push(a);
  }

  const uiByFp = new Map();
  for (const row of uiRows) {
    if (bindings.has(row.idx)) continue;
    if (!uiByFp.has(row.contentFingerprint)) uiByFp.set(row.contentFingerprint, []);
    uiByFp.get(row.contentFingerprint).push(row);
  }

  for (const [fp, rowsForFp] of uiByFp.entries()) {
    const pool = poolByFp.get(fp) || [];
    // Group into first-print lineages: each first print + descendant reprints = one claim slot.
    const lineages = [];
    const lineageByJobId = new Map();
    for (const a of pool) {
      const id = String(a.job._id || a.job.id || "");
      const parentId = a.job.parentJobId ? String(a.job.parentJobId) : "";
      if (a.job.isReprint === true && parentId && lineageByJobId.has(parentId)) {
        const lineage = lineageByJobId.get(parentId);
        lineage.push(a);
        if (id) lineageByJobId.set(id, lineage);
        continue;
      }
      if (a.job.isReprint === true && lineages.length) {
        // Fallback: same-content reprint without resolvable parent → attach to latest lineage
        const lineage = lineages[lineages.length - 1];
        lineage.push(a);
        if (id) lineageByJobId.set(id, lineage);
        continue;
      }
      const lineage = [a];
      lineages.push(lineage);
      if (id) lineageByJobId.set(id, lineage);
    }
    for (let i = 0; i < rowsForFp.length; i++) {
      const lineage = lineages[i];
      if (lineage?.length) bind(rowsForFp[i].idx, lineage);
    }
  }

  return uiRows.map((row) => {
    const bound = bindings.get(row.idx) || [];
    // Session rowId with different content → treat as needing new first print (do not bind old content)
    if (!bound.length && row.rowId) {
      const editedPrior = annotatedJobs.some(
        (a) => a.rowId === row.rowId && a.contentFingerprint !== row.contentFingerprint
      );
      if (editedPrior) {
        return {
          rowId: row.rowId,
          contentFingerprint: row.contentFingerprint,
          status: "NOT_PRINTED",
          jobId: "",
          originalJobId: "",
          message: "Row changed after print — use Print for the new content",
        };
      }
    }
    const summary = summarizeBoundJobs(bound.map((a) => a.job));
    return {
      rowId: row.rowId,
      contentFingerprint: row.contentFingerprint,
      status: summary.status,
      jobId: summary.jobId,
      originalJobId: summary.originalJobId,
      message: summary.message,
    };
  });
}

/**
 * Load persisted CUSTOM_PACKING jobs and resolve Print/Reprint state for the current table.
 */
export async function resolveCustomPackingRowPrintStatuses(req, body = {}) {
  const companyId = req.companyId;
  const { header, lines } = normalizeCustomPackingLines(body);
  const limit = Math.min(500, Math.max(1, Number(body.historyLimit) || 300));
  const jobs = await LabelPrintJob.find({
    companyId,
    sourceType: "CUSTOM_PACKING",
  })
    .sort({ createdAt: -1 })
    .limit(limit)
    .select(
      "status isReprint parentJobId packingSelectionFingerprint lines customPackingRowId createdAt lastError sourceType jobNo"
    )
    .lean();

  // Resolve oldest-first for stable occurrence claiming; find returns newest-first.
  const chronological = [...jobs].reverse();
  const rows = resolveCustomPackingRowPrintStatesFromJobs(header, lines, chronological);
  return {
    mode: "CUSTOM_PACKING",
    sourceType: "CUSTOM_PACKING",
    rows,
  };
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
  void filename;
  if (!buffer?.length) return [];
  return parseExcelBufferToRows(buffer, {
    preserveFormattedTextColumns: ["Part No.", "Part No", "PartNo", "partNo", "SPN"],
  });
}

export function buildCustomPackingTemplateWorkbook() {
  const headers = CUSTOM_PACKING_SPREADSHEET_COLUMNS.map((c) => c.header);
  const ws = XLSX.utils.aoa_to_sheet([
    headers,
    ["1", "OR-220", "O-RING", 25, 2],
    ["2", "123456", "GASKET", 1, 4],
  ]);
  for (const ref of ["B2", "B3"]) {
    if (ws[ref]) {
      ws[ref].t = "s";
      ws[ref].z = "@";
    }
  }
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
    const customPackingRowId = t(raw.customPackingRowId ?? raw.rowId);

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
      customPackingRowId,
      materialCode: "",
    });
  }
  return { header, lines };
}

/**
 * Row-level print/preview selection: exactly one line identified by body.rowId.
 * Backend does not trust the client to send a pre-filtered single-line body alone —
 * rowId must match a line in body.lines.
 */
export function resolveCustomPackingPrintSelection(body = {}) {
  const rowId = t(body.rowId ?? body.customPackingRowId);
  if (!rowId) {
    throw err("rowId is required to print or preview a custom packing row", 400, "LABEL_ROW_REQUIRED");
  }
  const { header, lines } = normalizeCustomPackingLines(body);
  const matched = lines.filter((ln) => t(ln.customPackingRowId) === rowId);
  if (matched.length === 0) {
    throw err("Selected custom packing row was not found", 400, "LABEL_ROW_NOT_FOUND");
  }
  if (matched.length > 1) {
    throw err("Selected custom packing rowId is ambiguous", 400, "LABEL_ROW_AMBIGUOUS");
  }
  const line = matched[0];
  if (!t(line.customPackingRowId)) {
    throw err("Selected row is missing a stable rowId", 400, "LABEL_ROW_REQUIRED");
  }
  return { header, lines: [line], rowId };
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
  // Row-level preview when rowId is present; otherwise allow full-batch preview for tools/tests.
  const selected = t(body.rowId ?? body.customPackingRowId)
    ? resolveCustomPackingPrintSelection(body)
    : (() => {
        const { header, lines } = normalizeCustomPackingLines(body);
        return { header, lines, rowId: "" };
      })();
  const { header, lines, rowId } = selected;
  await ensurePackingStandardTemplate();
  const rawFacePayloads = buildPackingLabelBatchPayloads(lines, CUSTOM_PACKING_TSPL_OPTS);
  const requestedLabels = rawFacePayloads.length;
  const descriptionTruncated = lines.some((ln) => ln.descriptionTruncated === true);
  const summary = summarizeCustomPackingBatch(lines);
  return {
    mode: "CUSTOM_PACKING",
    sourceType: "CUSTOM_PACKING",
    sourceNo: "CUSTOM",
    templateCode: PACKING_STANDARD_TEMPLATE_CODE,
    payloadMode: LABEL_PAYLOAD_MODE_TSPL_LABEL_BATCH,
    rowId: rowId || t(lines[0]?.customPackingRowId),
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
    tsplPayload: "",
    faceCount: rawFacePayloads.length,
  };
}

export async function createJobsFromCustomPacking(req, body = {}) {
  const companyId = req.companyId;
  const settings = await getLabelSettings(companyId);
  if (!settings.enabled) {
    throw err("Label printing is disabled. Enable it in Label Settings.", 400, "LABEL_DISABLED");
  }

  // Row-scoped first print only (no global multi-row enqueue).
  const { header, lines, rowId } = resolveCustomPackingPrintSelection(body);
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
  const idempotencyKey = buildCustomPackingRowIdempotencyKey(header, lines[0]);

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

  const rawFacePayloads = buildPackingLabelBatchPayloads(lines, CUSTOM_PACKING_TSPL_OPTS);
  if (rawFacePayloads.length !== requestedLabels) {
    throw err(
      `TSPL_LABEL_BATCH face count ${rawFacePayloads.length} != requestedLabels ${requestedLabels}`,
      400,
      "LABEL_FACE_COUNT"
    );
  }
  for (const ln of lines) {
    const g = measurePackingLabelGeometry(ln, CUSTOM_PACKING_TSPL_OPTS);
    if (!g.withinLabel || !g.qtyWithinLabel) {
      throw err("Packing label geometry exceeds 100×50 page bounds", 400, "LABEL_GEOMETRY");
    }
  }
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
    customPackingRowId: ln.customPackingRowId || rowId,
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
      tsplPayload: "",
      payloadMode: LABEL_PAYLOAD_MODE_TSPL_LABEL_BATCH,
      rawFacePayloads,
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
    description: `Custom packing label job ${job.jobNo} queued (${requestedLabels} stickers, row ${rowId})`,
  });
  return job;
}
