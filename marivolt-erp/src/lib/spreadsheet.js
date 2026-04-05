import * as XLSX from "xlsx";

/**
 * First sheet → array of row objects (headers = keys).
 */
export function parseSpreadsheetFile(file) {
  return file.arrayBuffer().then((ab) => {
    const wb = XLSX.read(ab, { type: "array" });
    const name = wb.SheetNames[0];
    if (!name) return [];
    const sheet = wb.Sheets[name];
    return XLSX.utils.sheet_to_json(sheet, { defval: "", raw: false });
  });
}
