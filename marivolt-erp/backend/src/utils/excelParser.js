import XLSX from "xlsx";

/**
 * Trim cell values; coerce numbers and dates to readable strings.
 * @param {unknown} v
 * @returns {string}
 */
export function trimCell(v) {
  if (v == null || v === "") return "";
  if (typeof v === "number" && !Number.isNaN(v)) return String(v);
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v.toISOString().slice(0, 10);
  return String(v).trim();
}

function normalizeHeaderName(value = "") {
  return String(value).trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Prefer Excel formatted display text for specific identifier columns only.
 * @param {import('xlsx').CellObject | undefined} cell
 * @param {boolean} useFormatted
 */
function cellValue(cell, useFormatted) {
  if (!cell) return "";
  if (useFormatted && cell.w != null && String(cell.w).trim() !== "") {
    return String(cell.w).trim();
  }
  return trimCell(cell.v);
}

/**
 * Case- and spacing-insensitive lookup on a row object (Excel header → value).
 * @param {Record<string, string>} row
 * @param {...string} headerCandidates
 * @returns {string}
 */
export function rowGet(row, ...headerCandidates) {
  if (!row || typeof row !== "object") return "";
  const byNorm = new Map();
  for (const [k, val] of Object.entries(row)) {
    const nk = String(k).trim().replace(/\s+/g, " ").toLowerCase();
    if (!nk) continue;
    if (!byNorm.has(nk)) byNorm.set(nk, trimCell(val));
  }
  for (const c of headerCandidates) {
    const nc = String(c).trim().replace(/\s+/g, " ").toLowerCase();
    const out = byNorm.get(nc);
    if (out !== undefined && out !== "") return out;
  }
  return "";
}

/**
 * Read first sheet (or named sheet) into { rowNumber, data }[].
 * rowNumber is 1-based Excel row index (includes header row as row 1; data starts row 2+).
 * @param {Buffer} buffer
 * @param {{ sheetName?: string, preserveFormattedTextColumns?: string[] }} [options]
 * @returns {{ rowNumber: number, data: Record<string, string> }[]}
 */
export function parseExcelBufferToRows(buffer, options = {}) {
  const wb = XLSX.read(buffer, { type: "buffer", cellDates: true });
  const sheetName = options.sheetName || wb.SheetNames[0];
  if (!sheetName) throw new Error("Workbook has no sheets");
  const sheet = wb.Sheets[sheetName];
  const aoa = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "", raw: false });
  if (!aoa.length) return [];

  const headerLine = aoa[0] || [];
  const headers = headerLine.map((h) => trimCell(h));

  const preserveNorm = new Set(
    (options.preserveFormattedTextColumns || []).map((h) => normalizeHeaderName(h))
  );
  const preserveColIndexes = preserveNorm.size
    ? headers
        .map((h, j) => (preserveNorm.has(normalizeHeaderName(h)) ? j : -1))
        .filter((j) => j >= 0)
    : [];

  const rows = [];
  for (let i = 1; i < aoa.length; i++) {
    const line = aoa[i] || [];
    const cells = line.map((c) => trimCell(c));
    const allEmpty = cells.every((c) => c === "");
    if (allEmpty) continue;

    /** @type {Record<string, string>} */
    const data = {};
    headers.forEach((h, j) => {
      if (!h) return;
      data[h] = cells[j] ?? "";
    });

    const rowNumber = i + 1;
    if (preserveColIndexes.length) {
      for (const j of preserveColIndexes) {
        const h = headers[j];
        if (!h) continue;
        const addr = XLSX.utils.encode_cell({ r: rowNumber - 1, c: j });
        data[h] = cellValue(sheet[addr], true);
      }
    }

    rows.push({ rowNumber, data });
  }
  return rows;
}

/**
 * Convert first sheet to array of plain objects (legacy / simple use).
 * @param {Buffer} buffer
 * @param {{ sheetName?: string, preserveFormattedTextColumns?: string[] }} [options]
 */
export function parseExcelBufferToJson(buffer, options = {}) {
  return parseExcelBufferToRows(buffer, options).map((r) => r.data);
}
