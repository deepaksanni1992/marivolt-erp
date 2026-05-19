import { getReportBranding } from "./reportBranding.js";
import { SALES_QUOTATION_STYLE_PRINT_CSS } from "./salesQuotationPrintCss.js";

export function escHtml(v) {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function fmtReportDate(d) {
  if (!d) return "-";
  try {
    return new Date(d).toLocaleDateString();
  } catch {
    return String(d);
  }
}

export function buildReportHeaderHtml({
  documentTitle,
  metaLines = [],
  company = {},
  brandingName = "",
  useQuoteHeaderClass = false,
}) {
  const b = getReportBranding(brandingName || company.companyName || company.name || "");
  const hasCompanyLogo = String(company.logo || company.logoUrl || "").trim().length > 0;
  const headerClass = useQuoteHeaderClass ? "print-header quote-header" : "print-header header";
  const leftClass = useQuoteHeaderClass ? "quote-left" : "header-left";
  const centerClass = useQuoteHeaderClass ? "quote-center" : "header-center";
  const rightClass = useQuoteHeaderClass ? "quote-right" : "header-right";
  const logoClass = useQuoteHeaderClass ? "quote-logo" : "logo";
  const titleClass = useQuoteHeaderClass ? "quote-title" : "title";
  const metaClass = useQuoteHeaderClass ? "quote-meta" : "muted";

  const metaHtml = metaLines
    .map((m) => `<div><b>${escHtml(m.label)}:</b> ${escHtml(m.value ?? "-")}</div>`)
    .join("");

  const logoBlock = b.useBrandedLayout
    ? `<img src="${escHtml(b.printLogo)}" alt="${escHtml(b.companyDisplayName || "Company")} logo" class="${logoClass}" />`
    : hasCompanyLogo
      ? `<img src="${escHtml(company.logo || company.logoUrl)}" alt="logo" class="${logoClass}" />`
      : `<div class="brand-fallback">MV</div>`;

  let rightBlock;
  if (b.useBrandedLayout) {
    const nameTag = useQuoteHeaderClass ? "company-name" : "brand-title";
    const subTag = useQuoteHeaderClass ? "company-subtitle" : "brand-subtitle";
    const detailsClass = useQuoteHeaderClass ? "company-details" : "muted";
    rightBlock = `<div class="${rightClass}${useQuoteHeaderClass ? "" : " is-marivolt"}">
        <h1 class="${nameTag}">${escHtml(b.companyDisplayName)}</h1>
        ${b.companySubtitle ? `<div class="${subTag}">${escHtml(b.companySubtitle)}</div>` : ""}
        <div class="${detailsClass}" style="margin-top:8px;">
          <div>${escHtml(company.address || b.reportAddress)}</div>
          <div>${escHtml(company.email || b.reportEmail)}</div>
          <div>${escHtml(company.phone || b.reportPhone)}</div>
        </div>
      </div>`;
  } else {
    rightBlock = `<div class="${rightClass} ${useQuoteHeaderClass ? "company-details" : "muted"}">
        <div><b>${escHtml(company.companyName || company.name || "")}</b></div>
        <div>${escHtml(company.address || "")}</div>
        <div>${escHtml(company.email || "")}</div>
        <div>${escHtml(company.phone || "")}</div>
      </div>`;
  }

  return `
    <div class="${headerClass}">
      <div class="${leftClass}">${logoBlock}</div>
      <div class="${centerClass}">
        <div class="${titleClass}">${escHtml(documentTitle)}</div>
        <div class="${metaClass}">${metaHtml}</div>
      </div>
      ${rightBlock}
    </div>`;
}

export function buildReportInfoCardsHtml({ left, right }) {
  const renderBox = (box) => {
    if (!box) return "";
    const rows = (box.rows || [])
      .map((r) => `<div><b>${escHtml(r.label)}:</b> ${escHtml(r.value ?? "-")}</div>`)
      .join("");
    return `
      <div class="info-box muted">
        <div class="info-box-title">${escHtml(box.title || "")}</div>
        ${rows}
      </div>`;
  };
  return `<div class="info-grid">${renderBox(left)}${renderBox(right)}</div>`;
}

export function buildReportTableHtml({ columns, rows }) {
  const head = columns
    .map((c) => `<th class="${escHtml(c.className || "")}">${escHtml(c.header)}</th>`)
    .join("");
  const body = (rows || [])
    .map((row) => {
      const trClass = [row.isGroupHeader ? "package-group-header" : "", row.className || ""]
        .filter(Boolean)
        .join(" ");
      const cells = row.cells || [];
      const tds = columns
        .map((col, idx) => {
          const val = cells[idx] ?? "";
          const extra = (row.cellClasses || [])[idx] || "";
          const cls = [col.className || "", extra].filter(Boolean).join(" ");
          return `<td class="${escHtml(cls)}">${escHtml(val)}</td>`;
        })
        .join("");
      return `<tr class="${escHtml(trClass)}">${tds}</tr>`;
    })
    .join("");
  return `
    <table class="report-lines-table">
      <thead><tr>${head}</tr></thead>
      <tbody>${body}</tbody>
    </table>`;
}

export function buildReportTotalsHtml(lines = []) {
  const inner = lines
    .map((ln) => {
      if (ln.bold) {
        return `<div><b><span>${escHtml(ln.label)}</span><span>${escHtml(ln.value)}</span></b></div>`;
      }
      return `<div><span>${escHtml(ln.label)}</span><span>${escHtml(ln.value)}</span></div>`;
    })
    .join("");
  return `<div class="print-totals totals summary-section">${inner}</div>`;
}

export function buildReportDocNoteHtml() {
  return '<div class="footer"><div class="doc-note">This is a computer generated document and does not require signature or stamp.</div></div>';
}

export function buildMarivoltTermsHtml(brandingName = "") {
  const b = getReportBranding(brandingName);
  if (!b.isMarivolt) return "";
  return '<div class="quote-terms">Only Marivolt terms and condition applicable, check here-<a href="https://marivolt.co/about-us">https://marivolt.co/about-us</a></div>';
}

export function buildBrandedFooterHtml(brandingName = "") {
  const b = getReportBranding(brandingName);
  if (!b.useBrandedLayout) return "";
  return `
    <div class="print-footer page-footer">
      <div class="page-footer-top">
        <div>
          <div>${escHtml(b.reportFooterName || "-")}</div>
          ${b.reportFooterSubline ? `<div>${escHtml(b.reportFooterSubline)}</div>` : ""}
        </div>
        <div class="page-footer-center">${escHtml(b.reportAddress)}</div>
        <div class="page-footer-right">
          <div>Mob: ${escHtml(b.reportPhone)}</div>
          <div>Email: ${escHtml(b.reportEmail)}</div>
          <div>Web: ${escHtml(b.reportWebsite)}</div>
        </div>
      </div>
      <div class="page-footer-line"></div>
    </div>`;
}

export const PACKING_LIST_EXTRA_CSS = `
  .report-lines-table { margin-top: 14px; }
  .report-lines-table th.col-sno,
  .report-lines-table td.col-sno { width: 42px; text-align: center; }
  .report-lines-table th.col-center,
  .report-lines-table td.col-center { text-align: center; }
  .report-lines-table th.col-right,
  .report-lines-table td.col-right { text-align: right; }
  tr.package-group-header td {
    background: #eef2f7 !important;
    font-weight: 700;
    color: #1f3a5f;
    border-top: 2px solid #cbd5e1;
    page-break-inside: avoid;
    break-inside: avoid;
  }
  tr.package-group-header td:nth-child(2) {
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  tr.package-item-row td { vertical-align: top; }
  tr.package-group-header + tr.package-item-row,
  tr.package-item-row + tr.package-group-header {
    page-break-before: avoid;
  }
  tr.package-group-header,
  tr.package-group-header + tr.package-item-row {
    page-break-inside: avoid;
    break-inside: avoid;
  }
  tr.package-item-row + tr.package-group-header td { padding-top: 10px; }
`;

export function openCommercialReportPrintWindow({
  title,
  bodyInnerHtml,
  brandingName = "",
  autoPrint = false,
  extraCss = "",
}) {
  const b = getReportBranding(brandingName);
  const html = `
    <html>
      <head>
        <title>${escHtml(title)}</title>
        <style>
${SALES_QUOTATION_STYLE_PRINT_CSS}
${extraCss}
        </style>
      </head>
      <body class="report-print ${b.isMarivolt ? "has-quote-terms" : ""}">
        <div class="print-page">
          <div class="print-body">
            ${bodyInnerHtml}
          </div>
          ${buildBrandedFooterHtml(brandingName)}
        </div>
      </body>
    </html>`;

  const win = window.open("", "_blank", "width=1200,height=900");
  if (!win) return;
  win.document.write(html);
  win.document.close();
  win.focus();
  if (autoPrint) setTimeout(() => win.print(), 300);
}
