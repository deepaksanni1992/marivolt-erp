/** Print/PDF layout for purchase orders (Okeanos + Marivolt). Keeps totals above fixed footer. */
export const PO_DOCUMENT_PRINT_CSS = `
  body.po-print-document {
    box-sizing: border-box;
    margin: 24px;
    padding-bottom: 24px;
  }
  body.po-print-document.has-branded-footer {
    padding-bottom: 0;
  }
  .po-page {
    box-sizing: border-box;
    position: relative;
    min-height: 100%;
    padding-bottom: 120px;
  }
  .po-lines-table {
    width: 100%;
    border-collapse: collapse;
    margin-top: 12px;
  }
  .po-lines-table thead {
    display: table-header-group;
  }
  .po-lines-table tbody tr {
    page-break-inside: avoid;
    break-inside: avoid;
  }
  .po-totals {
    page-break-inside: avoid;
    break-inside: avoid;
    margin-top: 16px;
  }
  .po-post-totals {
    page-break-inside: avoid;
    break-inside: avoid;
  }
  .po-doc-note.footer {
    margin-top: 28px;
    page-break-inside: avoid;
    break-inside: avoid;
  }
  .po-bottom-reserve {
    display: block;
    height: 0;
    visibility: hidden;
  }
  .po-footer.page-footer {
    position: fixed;
    left: 40px;
    right: 40px;
    bottom: 20px;
    height: 80px;
    box-sizing: border-box;
    z-index: 1;
  }
  .po-footer-simple {
    margin-top: 32px;
    padding-top: 12px;
    padding-bottom: 12px;
    border-top: 1px dashed #cfd8e3;
    text-align: center;
    font-size: 11px;
    color: #4b5563;
    page-break-inside: avoid;
    break-inside: avoid;
  }
  @media print {
    @page {
      margin: 10mm 10mm 40mm 10mm;
    }
    html,
    body.po-print-document {
      margin: 0 !important;
      padding: 0 !important;
    }
    body.po-print-document.has-branded-footer {
      padding-bottom: 0 !important;
    }
    body.po-print-document.has-quote-terms {
      padding-bottom: 0 !important;
    }
    .po-page {
      padding: 12mm 10mm 140px 10mm;
      min-height: auto;
    }
    .po-lines-table {
      page-break-inside: auto;
    }
    .po-lines-table thead {
      display: table-header-group;
    }
    .po-lines-table tbody tr {
      page-break-inside: avoid;
      break-inside: avoid;
    }
    .po-totals {
      page-break-inside: avoid;
      break-inside: avoid;
      page-break-before: auto;
      margin-top: 16px;
      margin-bottom: 120px;
    }
    .po-post-totals {
      page-break-inside: avoid;
      break-inside: avoid;
      margin-bottom: 48px;
    }
    .po-doc-note.footer {
      margin-top: 20px;
      margin-bottom: 100px;
      page-break-inside: avoid;
      break-inside: avoid;
    }
    .po-bottom-reserve {
      height: 120px;
      min-height: 120px;
      page-break-inside: avoid;
      break-inside: avoid;
    }
    body.po-print-document .po-footer.page-footer {
      position: fixed !important;
      bottom: 20px !important;
      left: 40px !important;
      right: 40px !important;
      height: 80px !important;
      z-index: 1;
    }
    body.po-print-document .page-footer:not(.po-footer) {
      position: static !important;
    }
    .no-print {
      display: none !important;
    }
  }
`;
