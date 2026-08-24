import Papa from "papaparse";
import { downloadCsv } from "./purchaseExport.js";
import { API_BASE, loadStoredAuth, apiPostFormData } from "./api.js";

export const CUSTOM_PACKING_COLUMNS = [
  { key: "serialNo", header: "S. No." },
  { key: "partNo", header: "Part No." },
  { key: "description", header: "Description" },
  { key: "qty", header: "Qty" },
  { key: "labelCount", header: "No. of Labels" },
];

export function emptyCustomPackingHeader() {
  return {
    customerName: "",
    customerRef: "",
    brand: "",
    modelName: "",
  };
}

export function newCustomPackingRowId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `cpr-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Session-only row handle (UUID). Not durable across re-import — print state uses LabelPrintJob content fingerprint + occurrence. */
export function emptyCustomPackingTableRow(serialNo = "", seed = {}) {
  const rowId = seed.rowId || newCustomPackingRowId();
  return {
    key: rowId,
    rowId,
    serialNo: serialNo ? String(serialNo) : "",
    partNo: seed.partNo || "",
    description: seed.description || "",
    qty: seed.qty != null ? String(seed.qty) : "1",
    labelCount: seed.labelCount != null ? String(seed.labelCount) : "1",
  };
}

export function rowHasContent(row = {}) {
  return Boolean(
    String(row.serialNo || "").trim() ||
      String(row.partNo || "").trim() ||
      String(row.description || "").trim() ||
      String(row.qty || "").trim() ||
      String(row.labelCount || "").trim()
  );
}

/** Print-critical content fingerprint (header + row). Matches backend content fingerprint (no session rowId). */
export function customPackingRowContentFingerprint(header = {}, row = {}) {
  const head = [
    String(header.customerName || "").trim(),
    String(header.customerRef || "").trim(),
    String(header.brand || "").trim(),
    String(header.modelName || "").trim(),
  ].join("\t");
  const part = [
    String(row.serialNo || "").trim(),
    String(row.partNo || "").trim(),
    String(row.description || "").trim(),
    String(Number(row.qty) || 0),
    String(Math.max(1, Math.floor(Number(row.labelCount) || 1))),
  ].join("\t");
  return `${head}\n${part}`;
}

export function summarizeCustomPackingRows(rows = []) {
  const active = (rows || []).filter(rowHasContent);
  let physicalLabels = 0;
  let totalQtyRepresented = 0;
  for (const row of active) {
    const qty = Number(row.qty) || 0;
    const labelCount = Math.max(1, Math.floor(Number(row.labelCount) || 0));
    physicalLabels += labelCount;
    totalQtyRepresented += qty * labelCount;
  }
  return {
    rowCount: active.length,
    physicalLabels,
    totalQtyRepresented,
  };
}

export function rowDerivedTotal(row = {}) {
  const qty = Number(row.qty) || 0;
  const labelCount = Math.max(0, Math.floor(Number(row.labelCount) || 0));
  return qty * labelCount;
}

function normalizeHeaderKey(value = "") {
  return String(value).trim().replace(/\s+/g, " ").toLowerCase();
}

const HEADER_ALIASES = {
  serialno: "serialNo",
  "s. no.": "serialNo",
  "s no": "serialNo",
  "s.no.": "serialNo",
  partno: "partNo",
  "part no.": "partNo",
  "part no": "partNo",
  description: "description",
  qty: "qty",
  quantity: "qty",
  "label qty": "qty",
  labelcount: "labelCount",
  "no. of labels": "labelCount",
  "no of labels": "labelCount",
  labels: "labelCount",
  copies: "labelCount",
};

function mapImportRecord(record = {}) {
  const mapped = {};
  for (const [rawKey, rawVal] of Object.entries(record || {})) {
    const nk = normalizeHeaderKey(rawKey);
    const target = HEADER_ALIASES[nk];
    if (target) mapped[target] = String(rawVal ?? "").trim();
  }
  return mapped;
}

function isBlankMappedRow(row = {}) {
  return !row.serialNo && !row.partNo && !row.description && !row.qty && !row.labelCount;
}

export function parseCustomPackingCsvText(text = "") {
  const normalized = String(text || "").replace(/^\uFEFF/, "");
  const firstLine = normalized.split(/\r?\n/).find((ln) => ln.trim() !== "") || "";
  let body = normalized;
  if (/^sep\s*=/i.test(firstLine.trim())) {
    body = normalized.split(/\r?\n/).slice(1).join("\n");
  }
  const parsed = Papa.parse(body, { header: true, skipEmptyLines: false, delimiter: "" });
  if (parsed.errors?.length) {
    const first = parsed.errors.find((e) => e.type === "FieldMismatch") || parsed.errors[0];
    throw new Error(first.message || "CSV parse failed");
  }
  const errors = [];
  const rows = [];
  (parsed.data || []).forEach((record, idx) => {
    const mapped = mapImportRecord(record);
    if (isBlankMappedRow(mapped)) return;
    const rowNumber = idx + 2;
    const qty = Number(mapped.qty);
    const labelCount = Number(mapped.labelCount);
    if (!Number.isFinite(qty) || qty <= 0 || !Number.isInteger(qty)) {
      errors.push(`Row ${rowNumber}: Qty must be a positive whole number.`);
      return;
    }
    if (!Number.isFinite(labelCount) || labelCount < 1 || !Number.isInteger(labelCount)) {
      errors.push(`Row ${rowNumber}: No. of Labels must be a positive whole number.`);
      return;
    }
    rows.push(
      emptyCustomPackingTableRow(mapped.serialNo || String(rows.length + 1), {
        partNo: mapped.partNo,
        description: mapped.description,
        qty: String(qty),
        labelCount: String(labelCount),
      })
    );
  });
  if (errors.length) throw new Error(errors.join("\n"));
  if (!rows.length) throw new Error("Spreadsheet has no data rows");
  return rows;
}

function isSupportedSpreadsheetFile(file) {
  const name = String(file?.name || "").toLowerCase();
  const type = String(file?.type || "").toLowerCase();
  return (
    name.endsWith(".csv") ||
    name.endsWith(".xlsx") ||
    name.endsWith(".xls") ||
    type.includes("spreadsheetml") ||
    type.includes("ms-excel") ||
    type === "text/csv" ||
    type === "application/csv"
  );
}

function mapApiRowsToTableRows(apiRows = []) {
  return (apiRows || []).map((row, idx) =>
    emptyCustomPackingTableRow(row.serialNo || String(idx + 1), {
      partNo: row.partNo,
      description: row.description,
      qty: String(row.qty),
      labelCount: String(row.labelCount),
    })
  );
}

export function exportCustomPackingRows(rows = []) {
  const data = (rows || [])
    .filter(rowHasContent)
    .map((row, idx) => ({
      serialNo: row.serialNo || String(idx + 1),
      partNo: row.partNo || "",
      description: row.description || "",
      qty: row.qty || "",
      labelCount: row.labelCount || "",
    }));
  downloadCsv("custom-packing-labels.csv", CUSTOM_PACKING_COLUMNS, data);
}

export async function downloadCustomPackingTemplateXlsx() {
  const auth = loadStoredAuth();
  const headers = {};
  if (auth?.token) headers.Authorization = `Bearer ${auth.token}`;
  if (auth?.company?.id) headers["x-company-id"] = auth.company.id;
  const res = await fetch(`${API_BASE}/labels/jobs/from-custom-packing/template`, { headers });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `Download failed (${res.status})`);
  }
  const blob = await res.blob();
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "custom-packing-label-template.xlsx";
  a.click();
  URL.revokeObjectURL(a.href);
}

export async function importCustomPackingSpreadsheetFile(file) {
  if (!file) throw new Error("No file selected");
  if (!isSupportedSpreadsheetFile(file)) {
    throw new Error("Supported formats: .csv, .xlsx, .xls");
  }
  const form = new FormData();
  form.append("file", file);
  const data = await apiPostFormData("/labels/jobs/from-custom-packing/parse-import", form);
  return mapApiRowsToTableRows(data.rows);
}

/**
 * Full table payload for backend row selection (includes every rowId).
 * Backend filters to body.rowId — never trust FE-only filtering.
 */
export function buildCustomPackingPayload(header, rows) {
  const lines = (rows || [])
    .filter(rowHasContent)
    .map((row, idx) => ({
      rowId: row.rowId || row.key,
      serialNo: row.serialNo || String(idx + 1),
      partNo: row.partNo,
      description: row.description,
      qty: row.qty,
      labelCount: row.labelCount,
    }));
  return {
    header: {
      customerName: header.customerName,
      customerRef: header.customerRef,
      brand: header.brand,
      modelName: header.modelName,
    },
    lines,
  };
}
