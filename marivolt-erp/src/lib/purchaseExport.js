import { GLOBAL_REPORT_PRINT_CSS } from "./reportPrintLayout.js";
import { downloadSearchableReportPdf } from "./reportPdfClient.js";
import {
  buildExportTableColgroup,
  buildExportTableHeadHtml,
  buildExportTableRowHtml,
  GLOBAL_REPORT_TABLE_CSS,
  PDF_OPTS_ITEM_LINES,
} from "./reportTableLayout.js";

function escCsv(v) {
  const s = v == null ? "" : String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function escHtml(v) {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escXml(v) {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Multi-sheet Excel (.xls) via SpreadsheetML — sheets: { name, columns, rows }[] */
export function downloadExcelWorkbook(filename, sheets = []) {
  const sheetXml = sheets
    .map((sheet) => {
      const cols = sheet.columns || [];
      const header = cols.map((c) => `<Cell><Data ss:Type="String">${escXml(c.header || c.key)}</Data></Cell>`).join("");
      const body = (sheet.rows || [])
        .map(
          (row) =>
            `<Row>${cols
              .map((c) => {
                const raw = row[c.key];
                const isNum = typeof raw === "number" && Number.isFinite(raw);
                const type = isNum ? "Number" : "String";
                const val = isNum ? raw : escXml(raw ?? "");
                return `<Cell><Data ss:Type="${type}">${val}</Data></Cell>`;
              })
              .join("")}</Row>`,
        )
        .join("");
      const safeName = escXml(String(sheet.name || "Sheet").slice(0, 31));
      return `<Worksheet ss:Name="${safeName}"><Table><Row>${header}</Row>${body}</Table></Worksheet>`;
    })
    .join("");

  const xml = `<?xml version="1.0"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
${sheetXml}
</Workbook>`;

  const blob = new Blob([xml], { type: "application/vnd.ms-excel" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename.endsWith(".xls") ? filename : `${filename}.xls`;
  a.click();
  URL.revokeObjectURL(a.href);
}

/** columns: { key, header }[] — rows are plain objects */
export function downloadCsv(filename, columns, rows) {
  const header = columns.map((c) => c.header || c.key).join(",");
  const lines = rows.map((row) => columns.map((c) => escCsv(row[c.key])).join(","));
  const blob = new Blob(["\ufeff" + [header, ...lines].join("\r\n")], {
    type: "text/csv;charset=utf-8",
  });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename.endsWith(".csv") ? filename : `${filename}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

const TABLE_EXPORT_CSS = `
  body { font-family: Arial, sans-serif; margin: 24px; color: #111; }
  h1 { font-size: 18px; margin: 0 0 6px; }
  .subtitle, .meta { color: #555; font-size: 12px; margin-bottom: 12px; }
  table.data-table th { background: #1c1c1c; color: #fff; }
  table.data-table tr:nth-child(even) td { background: #f8f8f8; }
`;

/** Searchable PDF export for tabular reports (stock, GRN, ledgers, etc.). */
export async function downloadPdfTable(
  title,
  subtitle,
  columns,
  rows,
  fileBaseName,
  company = null,
) {
  const head = buildExportTableHeadHtml(columns);
  const body = (rows || []).length
    ? (rows || [])
        .map((row) => `<tr>${buildExportTableRowHtml(columns, row)}</tr>`)
        .join("")
    : `<tr><td colspan="${columns.length}">No data</td></tr>`;

  let companyBlock = "";
  if (company?.name) {
    const companyLine = [company.name, company.address, company.email, company.phone]
      .filter(Boolean)
      .map(escHtml)
      .join(" | ");
    if (companyLine) {
      companyBlock = `<div class="meta">${companyLine}</div>`;
    }
  }

  const html = `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8"/>
    <title>${escHtml(title)}</title>
    <style>
${TABLE_EXPORT_CSS}
${GLOBAL_REPORT_PRINT_CSS}
${GLOBAL_REPORT_TABLE_CSS}
    </style>
  </head>
  <body class="report-print">
    <div class="print-page">
      <div class="print-body">
        <h1>${escHtml(title)}</h1>
        ${subtitle ? `<div class="subtitle">${escHtml(subtitle)}</div>` : ""}
        ${companyBlock}
        <table class="data-table report-table">
          ${buildExportTableColgroup(columns)}
          <thead><tr>${head}</tr></thead>
          <tbody>${body}</tbody>
        </table>
      </div>
    </div>
  </body>
</html>`;

  const name = (fileBaseName || title)
    .replace(/[^\w-]+/g, "-")
    .replace(/^-|-$/g, "");

  await downloadSearchableReportPdf({
    html,
    filename: name || "export",
    options: PDF_OPTS_ITEM_LINES,
  });
}
