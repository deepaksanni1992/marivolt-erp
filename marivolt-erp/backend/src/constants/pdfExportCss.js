/**
 * Export PDF only — not used by browser Print preview.
 * Wide custom page (420mm × 297mm) for item-heavy reports.
 */
export const PDF_EXPORT_PAGE_WIDTH = "420mm";
export const PDF_EXPORT_PAGE_HEIGHT = "297mm";
export const PDF_EXPORT_CONTENT_WIDTH = "404mm";

export const PDF_EXPORT_WIDE_CSS = `
@page {
  size: 420mm 297mm;
  margin-top: 42mm;
  margin-right: 8mm;
  margin-bottom: 26mm;
  margin-left: 8mm;
}

.pdf-export-page,
.report-page,
.print-page,
.print-body {
  width: ${PDF_EXPORT_CONTENT_WIDTH};
  max-width: ${PDF_EXPORT_CONTENT_WIDTH};
  min-width: ${PDF_EXPORT_CONTENT_WIDTH};
  box-sizing: border-box;
  overflow: visible;
}

.report-table,
table.report-lines-table,
table.po-lines-table,
table.data-table {
  width: 100%;
  max-width: 100%;
  table-layout: fixed;
  border-collapse: collapse;
  box-sizing: border-box;
}

.report-table th,
.report-table td,
table.report-lines-table th,
table.report-lines-table td,
table.po-lines-table th,
table.po-lines-table td,
table.data-table th,
table.data-table td {
  box-sizing: border-box;
}
`;
