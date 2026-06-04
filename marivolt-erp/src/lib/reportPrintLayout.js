/**
 * Shared print/PDF layout for all Okeanos & Marivolt reports.
 * Footer sits at the bottom of .print-page (absolute, not fixed overlay).
 * Totals stay in .print-body with reserved space above the footer.
 */

export const GLOBAL_REPORT_PRINT_CSS = `
  body.report-print,
  body.po-print-document {
    box-sizing: border-box;
    margin: 24px;
    padding-bottom: 0;
  }

  .print-page {
    position: relative;
    box-sizing: border-box;
    width: 100%;
  }

  .print-body {
    box-sizing: border-box;
  }

  .print-header,
  .quote-header,
  .header.po-print-header,
  header.po-print-header {
    page-break-inside: avoid;
    break-inside: avoid;
  }

  /* Screen: footer anchored to bottom of page container */
  .print-page > .print-footer,
  .print-page > .page-footer.print-footer {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    height: auto;
    min-height: 32mm;
    box-sizing: border-box;
  }

  /* Legacy footers outside .print-page — stay in document flow */
  .page-footer:not(.print-footer) {
    position: static;
    margin-top: 24px;
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
      size: A4;
      margin: 12mm;
    }

    html,
    body {
      height: auto !important;
      overflow: visible !important;
    }

    body.report-print,
    body.po-print-document {
      margin: 0 !important;
      padding: 0 !important;
    }

    body.report-print.has-quote-terms,
    body.po-print-document.has-quote-terms {
      padding-bottom: 0 !important;
    }

    .print-page {
      position: relative;
      min-height: 270mm;
      padding-bottom: 45mm !important;
      box-sizing: border-box;
    }

    .print-body {
      padding-bottom: 45mm !important;
    }

    .print-page > .print-footer,
    .print-page > .page-footer.print-footer {
      position: absolute !important;
      left: 0;
      right: 0;
      bottom: 0;
      height: 32mm;
      page-break-inside: avoid;
      break-inside: avoid;
    }

    /* No fixed overlay — only direct footer children of .print-page */
    .print-page > .print-footer,
    .print-page > .page-footer.print-footer,
    .print-page > .po-footer.print-footer {
      position: absolute !important;
    }

    .print-totals,
    .totals,
    .totals-section,
    .summary-section,
    .po-totals {
      break-inside: avoid;
      page-break-inside: avoid;
      margin-bottom: 12mm !important;
    }

    .po-post-totals {
      margin-bottom: 8mm !important;
    }

    .po-doc-note.footer {
      margin-bottom: 4mm !important;
    }

    table {
      page-break-inside: auto;
    }

    tr {
      page-break-inside: avoid;
      break-inside: avoid;
      page-break-after: auto;
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
  const subline = reportFooterSubline
    ? "<motion.div>" + String(reportFooterSubline) + "</motion.div>"
    : "";
  return (
    '<motion.div class="print-footer page-footer">' +
    '<motion.div class="page-footer-top">' +
    "<motion.div><motion.div>" +
    String(reportFooterName) +
    "</motion.div>" +
    subline +
    "</motion.div>" +
    '<motion.div class="page-footer-center">' +
    String(reportAddress) +
    "</motion.div>" +
    '<motion.div class="page-footer-right">' +
    "<motion.div>Mob: " +
    String(reportPhone) +
    "</motion.div>" +
    "<motion.div>Email: " +
    String(reportEmail) +
    "</motion.div>" +
    "<motion.div>Web: " +
    String(reportWebsite) +
    "</motion.div>" +
    "</motion.div>" +
    "</motion.div>" +
    '<motion.div class="page-footer-line"></motion.div>' +
    "</motion.div>"
  )
    .split("motion.")
    .join("");
}
