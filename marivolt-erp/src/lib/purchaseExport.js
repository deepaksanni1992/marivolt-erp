import { GLOBAL_REPORT_PRINT_CSS } from "./reportPrintLayout.js";
import { downloadSearchableReportPdf } from "./reportPdfClient.js";

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
  table.data-table { width: 100%; border-collapse: collapse; font-size: 11px; }
  table.data-table th,
  table.data-table td {
    border: 1px solid #ddd;
    padding: 6px;
    text-align: left;
    word-wrap: break-word;
    overflow-wrap: anywhere;
    vertical-align: top;
  }
  table.data-table th {
    background: #1c1c1c;
    color: #fff;
    font-weight: 700;
  }
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
  const head = columns
    .map((c) => `<th>${escHtml(c.header || c.key)}</th>`)
    .join("");
  const body = (rows || []).length
    ? (rows || [])
        .map(
          (row) =>
            `<tr>${columns.map((c) => `<td>${escHtml(row[c.key])}</td>`).join("")}</tr>`,
        )
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
    </style>
  </head>
  <body class="report-print">
    <div class="print-page">
      <div class="print-body">
        <h1>${escHtml(title)}</h1>
        ${subtitle ? `<div class="subtitle">${escHtml(subtitle)}</div>` : ""}
        ${companyBlock}
        <table class="data-table">
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
    options: { landscape: true, printBackground: true },
  });
}
