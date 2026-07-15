import { escHtml } from "./commercialReportLayout.js";
import { getReportBranding } from "./reportBranding.js";

export function quotationPrintTermsText(quotation) {
  return String(quotation?.termsAndConditions || quotation?.resolvedTermsAndConditions || "").trim();
}

export const documentPrintTermsText = quotationPrintTermsText;

export function quotationHasPrintTerms(quotation) {
  return quotationPrintTermsText(quotation).length > 0;
}

export const documentHasPrintTerms = quotationHasPrintTerms;

export function buildQuotationPrintHeaderHtml(quotation, company = {}) {
  const q = quotation || {};
  const hasCompanyLogo = String(company.logo || "").trim().length > 0;
  const companyName = String(company.companyName || "").toLowerCase();
  const {
    useBrandedLayout,
    printLogo,
    companyDisplayName,
    companySubtitle,
    reportAddress,
    reportEmail,
    reportPhone,
  } = getReportBranding(companyName);
  const fmtDate = (d) => (d ? new Date(d).toLocaleDateString() : "-");

  return `
        <div class="print-header quote-header">
          <div class="quote-left">
            ${
              useBrandedLayout
                ? `<img src="${printLogo}" alt="${escHtml(companyDisplayName || "Company")} logo" class="quote-logo" />`
                : hasCompanyLogo
                  ? `<img src="${escHtml(company.logo)}" alt="${escHtml(company.companyName || "Company")} logo" class="quote-logo" />`
                  : `<div class="brand-fallback">MV</div>`
            }
          </div>
          <div class="quote-center">
            <div class="quote-title">Quotation</div>
            <div class="quote-meta">
              <div><b>No:</b> ${escHtml(q.quotationNo || "-")}</div>
              <div><b>Date:</b> ${fmtDate(q.quotationDate)}</div>
              <div><b>Validity:</b> ${fmtDate(q.validityDate)}</div>
            </div>
          </div>
          ${
            useBrandedLayout
              ? `<div class="quote-right">
                <h1 class="company-name">${escHtml(companyDisplayName || company.companyName || "")}</h1>
                ${companySubtitle ? `<div class="company-subtitle">${escHtml(companySubtitle)}</div>` : ""}
                <div class="company-details">
                  <div>${escHtml(company.address || reportAddress)}</div>
                  <div>${escHtml(company.email || reportEmail)}</div>
                  <div>${escHtml(company.phone || reportPhone)}</div>
                </div>
              </div>`
              : `<div class="quote-right company-details">
                <div><b>${escHtml(company.companyName || "")}</b></div>
                <div>${escHtml(company.address || "")}</div>
                <div>${escHtml(company.email || "")}</div>
                <div>${escHtml(company.phone || "")}</div>
              </div>`
          }
        </div>`;
}

export function buildOAPrintHeaderHtml(oa, company = {}) {
  const o = oa || {};
  const hasCompanyLogo = String(company.logo || "").trim().length > 0;
  const companyName = String(company.companyName || "").toLowerCase();
  const {
    useBrandedLayout,
    printLogo,
    companyDisplayName,
    companySubtitle,
    reportAddress,
    reportEmail,
    reportPhone,
  } = getReportBranding(companyName);
  const fmtDate = (d) => (d ? new Date(d).toLocaleDateString() : "-");

  return `
        <div class="print-header header">
          <div class="header-left">
            ${
              useBrandedLayout
                ? `<img src="${printLogo}" alt="${escHtml(companyDisplayName || "Company")} logo" class="logo" />`
                : hasCompanyLogo
                  ? `<img src="${escHtml(company.logo)}" alt="${escHtml(company.companyName || "Company")} logo" class="logo" />`
                  : `<div class="brand-fallback">MV</div>`
            }
          </div>
          <div class="header-center">
            <div class="title">Order Acknowledgement</div>
            <div class="muted">
              <div><b>No:</b> ${escHtml(o.oaNo || "-")}</div>
              <div><b>Date:</b> ${fmtDate(o.oaDate)}</div>
              <div><b>Linked Quotation:</b> ${escHtml(o.linkedQuotationNo || "-")}</div>
            </div>
          </div>
          ${
            useBrandedLayout
              ? `<div class="header-right is-marivolt">
                <h1 class="brand-title">${escHtml(companyDisplayName || company.companyName || "")}</h1>
                ${companySubtitle ? `<div class="brand-subtitle">${escHtml(companySubtitle)}</div>` : ""}
                <div class="muted" style="margin-top:8px;">
                  <div>${escHtml(company.address || reportAddress)}</div>
                  <div>${escHtml(company.email || reportEmail)}</div>
                  <div>${escHtml(company.phone || reportPhone)}</div>
                </div>
              </div>`
              : `<div class="header-right muted">
                <div><b>${escHtml(company.companyName || "")}</b></div>
                <div>${escHtml(company.address || "")}</div>
                <div>${escHtml(company.email || "")}</div>
                <div>${escHtml(company.phone || "")}</div>
              </div>`
          }
        </div>`;
}

export function buildQuotationPrintBrandedFooterHtml(branding) {
  const {
    useBrandedLayout,
    reportFooterName,
    reportFooterSubline,
    reportAddress,
    reportPhone,
    reportEmail,
    reportWebsite,
  } = branding;
  if (!useBrandedLayout) return "";
  return `
        <div class="print-footer page-footer document-footer">
          <div class="page-footer-top">
            <div>
              <div>${escHtml(reportFooterName || "-")}</div>
              ${reportFooterSubline ? `<div>${escHtml(reportFooterSubline)}</div>` : ""}
            </div>
            <div class="page-footer-center">${escHtml(reportAddress)}</div>
            <div class="page-footer-right">
              <div>Mob: ${escHtml(reportPhone)}</div>
              <div>Email: ${escHtml(reportEmail)}</div>
              <div>Web: ${escHtml(reportWebsite)}</div>
            </div>
          </div>
          <div class="page-footer-line"></div>
        </div>`;
}

export const DEFAULT_PRINT_DOC_NOTE =
  "This is digital copy, No Signature/Stamp required";

export function buildPrintDocNoteHtml(noteText = DEFAULT_PRINT_DOC_NOTE) {
  return `<div class="footer document-footer footer-note computer-generated-note"><div class="doc-note">${escHtml(noteText)}</div></div>`;
}

/** Footer slot: doc note + branded band — direct child of .print-page */
export function buildPrintPageFooterHtml(branding, noteText = DEFAULT_PRINT_DOC_NOTE) {
  return `<div class="print-page-footer">${buildPrintDocNoteHtml(noteText)}${buildQuotationPrintBrandedFooterHtml(branding)}</div>`;
}

/** @deprecated Use buildPrintPageFooterHtml */
export function buildPrintPageClosingHtml(branding, noteText = DEFAULT_PRINT_DOC_NOTE) {
  return buildPrintPageFooterHtml(branding, noteText);
}

/** Standard print page: header + body + footer siblings inside .print-page */
export function buildPrintPageShellHtml({ pageClass = "", headerHtml = "", bodyHtml = "", footerHtml = "" }) {
  const classes = ["print-page", pageClass].filter(Boolean).join(" ");
  return `<div class="${classes}">
${headerHtml}
<div class="print-body">${bodyHtml}</div>
${footerHtml}
</div>`;
}

/**
 * Split terms into page-sized chunks (paragraphs / lines) for explicit terms pages.
 * Each chunk becomes one .print-page with its own header and footer.
 */
export function paginateTermsHtml(termsText, maxCharsPerPage = 2200) {
  const text = String(termsText || "").trim();
  if (!text) return [];

  let blocks = text
    .split(/\n\n+/)
    .map((b) => b.trim())
    .filter(Boolean);

  if (blocks.length <= 1) {
    const lines = text
      .split(/\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.length > 1) blocks = lines;
    else blocks = [text];
  }

  const chunks = [];
  let current = "";
  for (const block of blocks) {
    const addition = current ? `\n\n${block}` : block;
    if (current && current.length + addition.length > maxCharsPerPage) {
      chunks.push(current);
      current = block;
    } else {
      current = current ? `${current}\n\n${block}` : block;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

export function buildQuotationTermsContinuationPagesHtml(headerHtml, termsText, branding, noteText = DEFAULT_PRINT_DOC_NOTE) {
  const chunks = paginateTermsHtml(termsText);
  if (!chunks.length) return "";
  const footerHtml = buildPrintPageFooterHtml(branding, noteText);
  return chunks
    .map((chunk, index) =>
      buildPrintPageShellHtml({
        pageClass: "terms-page quote-terms-print-page",
        headerHtml,
        bodyHtml: `${index === 0 ? '<div class="quote-terms-heading">Terms &amp; Conditions</div>' : ""}<div class="quote-terms quote-terms-full">${escHtml(chunk)}</div>`,
        footerHtml,
      }),
    )
    .join("");
}
