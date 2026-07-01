function escHtml(v) {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Reusable print shell: fixed header + flowing content + fixed footer on every printed page.
 * Used by all ERP printable documents (HTML string builders and PrintLayout React components).
 *
 * Per-page top/bottom space uses named @page margins so content on page 2+ is not hidden
 * under the fixed header (padding on the content slot only applies to the first page).
 */
export const PRINT_DOCUMENT_LAYOUT_CSS = `
  .print-layout {
    box-sizing: border-box;
    width: 100%;
    max-width: 100%;
  }

  .print-layout-header-slot,
  .print-layout-footer-slot,
  .print-layout-content-slot {
    box-sizing: border-box;
    width: 100%;
    max-width: 100%;
  }

  /* Screen preview: natural document flow */
  @media screen {
    .print-layout-header-slot {
      position: relative;
    }
    .print-layout-footer-slot {
      position: relative;
      margin-top: 24px;
    }
    .print-layout-content-slot {
      padding: 0;
    }
  }

  /* Default paper — preserve existing A4 format */
  @page {
    size: A4;
    margin: 12mm;
  }

  /* Branded documents: reserve header/footer band on every printed page */
  @page document-branded {
    size: A4;
    margin-top: 42mm;
    margin-right: 12mm;
    margin-bottom: 26mm;
    margin-left: 12mm;
  }

  /* Wide export PDF (420mm) — same header/footer bands, existing export paper size */
  @page document-branded-wide {
    size: 420mm 297mm;
    margin-top: 42mm;
    margin-right: 8mm;
    margin-bottom: 26mm;
    margin-left: 8mm;
  }

  /* Print: header and footer repeat on every page; only content flows */
  @media print {
    .print-layout.has-print-header {
      page: document-branded;
    }

    body.pdf-export-page .print-layout.has-print-header {
      page: document-branded-wide;
    }

    .print-layout-header-slot {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      z-index: 1000;
      background: #fff;
    }

    .print-layout.has-print-footer .print-layout-footer-slot {
      position: fixed;
      bottom: 0;
      left: 0;
      right: 0;
      z-index: 1000;
      background: #fff;
      break-inside: avoid;
      page-break-inside: avoid;
    }

    /* @page margins reserve space on every page — no single-page padding hack */
    .print-layout.has-print-header .print-layout-content-slot,
    .print-layout.has-print-footer .print-layout-content-slot {
      padding-top: 0;
      padding-bottom: 0;
    }

    .print-layout-content-slot table thead {
      display: table-header-group;
    }

    .print-layout-content-slot table tfoot {
      display: table-footer-group;
    }

    .print-layout-content-slot table tr {
      break-inside: avoid;
      page-break-inside: avoid;
    }
  }

  .print-terms-section {
    break-before: page;
    page-break-before: always;
    break-inside: auto;
    page-break-inside: auto;
  }

  .print-terms-section .quote-terms-full {
    break-inside: auto;
    page-break-inside: auto;
  }

  .print-keep-together,
  .print-signature-block,
  .si-bank-block,
  .po-post-totals {
    break-inside: avoid;
    page-break-inside: avoid;
  }
`;

export const PRINT_DOC_NOTE_HTML =
  '<div class="footer"><div class="doc-note">This is a computer generated documents and does not required signature or stamp.</div></div>';

export const PRINT_DOC_NOTE_HTML_ALT =
  '<div class="footer"><div class="doc-note">This is a computer generated document and does not require signature or stamp.</div></div>';

/** Terms block — only rendered when text exists; starts on a new page after main content. */
export function buildPrintTermsSectionHtml(termsText, docNoteHtml = "") {
  const terms = String(termsText || "").trim();
  if (!terms) return "";
  return `
    <section class="print-terms-section">
      <div class="quote-terms-heading">Terms &amp; Conditions</div>
      <div class="quote-terms quote-terms-full">${escHtml(terms)}</div>
      ${docNoteHtml || ""}
    </section>`;
}

/**
 * Standard printable document shell.
 *
 * <PrintLayout> equivalent for HTML string builders:
 *   header  → print-layout-header-slot
 *   content → print-layout-content-slot
 *   footer  → print-layout-footer-slot
 *   terms   → appended inside content (new page when present)
 */
export function buildPrintDocumentHtml({
  title = "Document",
  bodyClass = "report-print print-document",
  headerHtml = "",
  contentHtml = "",
  footerHtml = "",
  termsHtml = "",
  termsText = "",
  termsDocNoteHtml = "",
  extraCss = "",
  styleCss = "",
  includeDoctype = true,
} = {}) {
  const hasHeader = Boolean(String(headerHtml || "").trim());
  const hasFooter = Boolean(String(footerHtml || "").trim());
  const resolvedTerms =
    String(termsHtml || "").trim() ||
    buildPrintTermsSectionHtml(termsText, termsDocNoteHtml || PRINT_DOC_NOTE_HTML);
  const layoutClasses = [
    "print-layout",
    hasHeader ? "has-print-header" : "",
    hasFooter ? "has-print-footer" : "",
  ]
    .filter(Boolean)
    .join(" ");

  const doc = `${includeDoctype ? "<!DOCTYPE html>\n" : ""}<html>
  <head>
    <meta charset="utf-8" />
    <title>${escHtml(title)}</title>
    <style>
${styleCss}
${PRINT_DOCUMENT_LAYOUT_CSS}
${extraCss}
    </style>
  </head>
  <body class="${escHtml(bodyClass)}">
    <div class="${layoutClasses}">
      ${hasHeader ? `<div class="print-layout-header-slot print-header-slot">${headerHtml}</div>` : ""}
      <div class="print-layout-content-slot print-content-slot">
        ${contentHtml}
        ${resolvedTerms}
      </div>
      ${hasFooter ? `<div class="print-layout-footer-slot print-footer-slot">${footerHtml}</div>` : ""}
    </div>
  </body>
</html>`;
  return doc;
}

/** @deprecated Use buildPrintTermsSectionHtml — kept for existing imports. */
export function buildQuotationTermsContinuationPagesHtml(_headerHtml, termsText, _brandedFooterHtml, docNoteHtml = "") {
  return buildPrintTermsSectionHtml(termsText, docNoteHtml || PRINT_DOC_NOTE_HTML);
}
