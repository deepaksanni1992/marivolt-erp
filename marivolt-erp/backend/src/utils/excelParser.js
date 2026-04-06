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
 * @param {{ sheetName?: string }} [options]
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

    rows.push({ rowNumber: i + 1, data });
  }
  return rows;
}

/**
 * Convert first sheet to array of plain objects (legacy / simple use).
 * @param {Buffer} buffer
 */
export function parseExcelBufferToJson(buffer) {
  return parseExcelBufferToRows(buffer).map((r) => r.data);
}
