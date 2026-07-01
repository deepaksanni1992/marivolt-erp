/**
 * Shared print/PDF layout for all Okeanos & Marivolt reports.
 * Screen preview: footer anchored to bottom of main page via absolute positioning.
 * Print/PDF: footer flows inside .print-body — never as a separate page fragment.
 */

export const GLOBAL_REPORT_PRINT_CSS = `
  body.report-print,
  body.po-print-document {
    box-sizing: border-box;
    margin: 24px;
    padding-bottom: 0;
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

  /* Screen preview only — anchor footer to bottom of main page without affecting print pagination */
  @media screen {
    .print-page.main-page,
    .print-page.po-page {
      min-height: 270mm;
      padding-bottom: 45mm;
      box-sizing: border-box;
    }

    .print-page.main-page .print-body,
    .print-page.po-page .print-body {
      padding-bottom: 45mm;
    }

    .print-page.main-page .print-body > .print-footer,
    .print-page.main-page .print-body > .page-footer.print-footer,
    .print-page.po-page .print-body > .print-footer,
    .print-page.po-page .print-body > .page-footer.print-footer {
      position: absolute;
      left: 0;
      right: 0;
      bottom: 0;
      height: auto;
      min-height: 32mm;
      box-sizing: border-box;
    }
  }

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

    .print-page {
      position: relative;
      break-after: page;
      page-break-after: always;
      min-height: unset !important;
      padding-bottom: 0 !important;
      box-sizing: border-box;
    }

    .print-page:last-of-type,
    .print-page:last-child {
      break-after: auto !important;
      page-break-after: auto !important;
    }

    .print-page.terms-page,
    .print-page.quote-terms-print-page {
      break-before: page;
      page-break-before: always;
      min-height: unset !important;
      padding-bottom: 0 !important;
    }

    .print-body {
      padding-bottom: 0 !important;
    }

    body.report-print.has-quote-terms .print-page.main-page .print-body,
    body.report-print.has-quote-terms .print-body,
    body.po-print-document.has-quote-terms .print-body {
      padding-bottom: 0 !important;
    }

    body.report-print.has-quote-terms .page-footer-line,
    body.po-print-document.has-quote-terms .page-footer-line {
      display: none !important;
    }

    .print-page .print-footer,
    .print-page .page-footer.print-footer,
    .print-page .document-footer,
    .print-page .footer,
    .print-page .footer-note,
    .print-page .computer-generated-note {
      position: static !important;
      left: auto !important;
      right: auto !important;
      bottom: auto !important;
      height: auto !important;
      min-height: 0 !important;
      break-before: avoid !important;
      page-break-before: avoid !important;
      break-after: avoid !important;
      page-break-after: avoid !important;
      page-break-inside: avoid !important;
      break-inside: avoid !important;
    }

    .footer-only-page,
    .blank-page,
    .empty-page,
    .print-spacer-page {
      display: none !important;
    }

    .page-break:last-child,
    .force-page-break:last-child {
      display: none !important;
      break-after: auto !important;
      page-break-after: auto !important;
    }

    .print-totals,
    .totals,
    .totals-section,
    .summary-section,
    .po-totals {
      break-inside: avoid;
      page-break-inside: avoid;
      margin-bottom: 6mm !important;
    }

    .print-totals + .footer,
    .totals + .footer,
    .summary-section + .footer {
      break-inside: avoid;
      page-break-inside: avoid;
      page-break-after: avoid;
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
    '<motion.div class="print-footer page-footer document-footer">' +
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
