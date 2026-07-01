/**
 * Shared print/PDF layout for all Okeanos & Marivolt reports.
 * Header/footer repeat on every page via printDocumentLayout.js (position: fixed in print).
 * Only document body content flows between pages.
 */

import { PRINT_DOCUMENT_LAYOUT_CSS } from "./printDocumentLayout.js";

export const GLOBAL_REPORT_PRINT_CSS = `
${PRINT_DOCUMENT_LAYOUT_CSS}

  body.report-print,
  body.po-print-document,
  body.print-document {
    box-sizing: border-box;
    margin: 24px;
    padding: 0;
  }

  .report-page,
  .report-content,
  .print-page,
  .print-body {
    box-sizing: border-box;
    width: 100%;
    max-width: 100%;
    overflow: visible;
  }

  /* Legacy wrappers — no min-height or padding hacks */
  .print-page {
    position: relative;
  }

  .print-header,
  .quote-header,
  .header.po-print-header,
  header.po-print-header {
    page-break-inside: avoid;
    break-inside: avoid;
  }

  .print-totals,
  .totals.print-totals,
  .totals-section,
  .summary-section,
  .po-totals {
    break-inside: avoid;
    page-break-inside: avoid;
  }

  .po-post-totals,
  .po-doc-note.footer,
  .footer .doc-note {
    break-inside: avoid;
    page-break-inside: avoid;
  }

  .po-footer-simple {
    margin-top: 24px;
    padding-top: 12px;
    border-top: 1px dashed #cfd8e3;
    text-align: center;
    font-size: 11px;
    color: #4b5563;
    break-inside: avoid;
    page-break-inside: avoid;
  }

  @media print {
    @page {
      margin: 12mm;
    }

    html,
    body {
      height: auto !important;
      overflow: visible !important;
    }

    body.report-print,
    body.po-print-document,
    body.print-document {
      margin: 0 !important;
      padding: 0 !important;
    }

    .report-page,
    .report-content,
    .print-page,
    .print-body {
      width: 100% !important;
      max-width: 100% !important;
      overflow: visible !important;
      min-height: unset !important;
      padding-bottom: 0 !important;
    }

    .print-totals,
    .totals,
    .totals-section,
    .summary-section,
    .po-totals {
      break-inside: avoid;
      page-break-inside: avoid;
    }

    table {
      page-break-inside: auto;
    }

    tr {
      page-break-inside: avoid;
      break-inside: avoid;
    }

    thead {
      display: table-header-group;
    }

    tfoot {
      display: table-footer-group;
    }

    .no-print {
      display: none !important;
    }
  }
`;

/** Branded footer block (contact details only — no totals). */
export function renderBrandedPrintFooterHtml({
  reportFooterName = "-",
  reportFooterSubline = "",
  reportAddress = "",
  reportPhone = "",
  reportEmail = "",
  reportWebsite = "",
}) {
  const subline = reportFooterSubline ? `<div>${String(reportFooterSubline)}</div>` : "";
  return `<div class="print-footer page-footer">
      <div class="page-footer-top">
        <div>
          <div>${String(reportFooterName)}</div>
          ${subline}
        </div>
        <div class="page-footer-center">${String(reportAddress)}</div>
        <div class="page-footer-right">
          <div>Mob: ${String(reportPhone)}</div>
          <div>Email: ${String(reportEmail)}</div>
          <div>Web: ${String(reportWebsite)}</div>
        </div>
      </div>
      <div class="page-footer-line"></div>
    </div>`;
}
