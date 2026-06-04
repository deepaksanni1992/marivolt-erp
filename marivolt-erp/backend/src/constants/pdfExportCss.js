/**
 * CSS injected only during Puppeteer PDF export (not browser Print).
 * Matches printable landscape width so tables are not squeezed/clipped.
 */
export function buildPdfExportCss(landscape = false) {
  const pageRule = landscape
    ? `@page { size: A4 landscape; margin: 10mm; }`
    : `@page { size: A4; margin: 10mm; }`;

  const landscapeContainer = landscape
    ? `
  .pdf-export-page,
  body.report-print,
  body.po-print-document,
  .report-page,
  .report-content,
  .print-page,
  .print-body {
    width: 277mm;
    max-width: 277mm;
    margin-left: auto;
    margin-right: auto;
    box-sizing: border-box;
    overflow: visible;
  }`
    : `
  .pdf-export-page,
  body.report-print,
  body.po-print-document,
  .report-page,
  .report-content,
  .print-page,
  .print-body {
    box-sizing: border-box;
    width: 100%;
    max-width: 100%;
    overflow: visible;
  }`;

  return `
${pageRule}
${landscapeContainer}

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
`;
}
