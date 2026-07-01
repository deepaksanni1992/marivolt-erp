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
  "This is a computer generated documents and does not required signature or stamp.";

export function buildPrintDocNoteHtml(noteText = DEFAULT_PRINT_DOC_NOTE) {
  return `<div class="footer document-footer footer-note computer-generated-note"><div class="doc-note">${escHtml(noteText)}</div></div>`;
}

/** Doc note + branded footer — must stay inside .print-body (same page wrapper as content). */
export function buildPrintPageClosingHtml(branding, noteText = DEFAULT_PRINT_DOC_NOTE) {
  return `${buildPrintDocNoteHtml(noteText)}${buildQuotationPrintBrandedFooterHtml(branding)}`;
}

export function buildQuotationTermsContinuationPagesHtml(headerHtml, termsText, brandedFooterHtml) {
  const terms = String(termsText || "").trim();
  if (!terms) return "";
  const docNote = buildPrintDocNoteHtml();
  return `
      <div class="print-page terms-page quote-terms-print-page">
        <div class="print-body">
          ${headerHtml}
          <div class="quote-terms-heading">Terms &amp; Conditions</div>
          <div class="quote-terms quote-terms-full">${escHtml(terms)}</div>
          ${docNote}
          ${brandedFooterHtml}
        </div>
      </div>`;
}
