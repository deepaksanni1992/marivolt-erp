import { deliverReportHtml } from "./reportPdfClient.js";
import { getReportBranding } from "./reportBranding.js";
import { GLOBAL_REPORT_PRINT_CSS } from "./reportPrintLayout.js";
import { GLOBAL_REPORT_TABLE_CSS } from "./reportTableLayout.js";
import { SALES_QUOTATION_STYLE_PRINT_CSS } from "./salesQuotationPrintCss.js";

function esc(v) {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmtDate(v) {
  if (!v) return "—";
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString();
}

function fmtQty(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

export function buildCustomsInvoicePrintHtml({ header = {}, rows = [], companyName = "" } = {}) {
  const branding = getReportBranding(companyName || header.companyCode || "");
  const {
    useBrandedLayout,
    printLogo,
    companyDisplayName,
    companySubtitle,
    reportAddress,
    reportEmail,
    reportPhone,
  } = branding;

  const lineRows = (rows || [])
    .map(
      (r, i) => `<tr>
        <td class="num">${i + 1}</td>
        <td>${esc(r.articleNumber)}</td>
        <td>${esc(r.partNumber)}</td>
        <td>${esc(r.description)}</td>
        <td class="num">${fmtQty(r.qty)}</td>
        <td>${esc(r.boeNumber)}</td>
        <td>${fmtDate(r.boeDate)}</td>
        <td>${esc(r.supplierInvoiceNumber)}</td>
        <td>${fmtDate(r.supplierInvoiceDate)}</td>
        <td>${esc(r.countryOfOrigin)}</td>
        <td>${esc(r.hsCode)}</td>
        <td>${esc(r.blNumber)}</td>
        <td>${esc(r.awbNumber)}</td>
      </tr>`,
    )
    .join("");

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Customs Invoice ${esc(header.customsInvoiceNumber)}</title>
  <style>
${SALES_QUOTATION_STYLE_PRINT_CSS}
${GLOBAL_REPORT_PRINT_CSS}
${GLOBAL_REPORT_TABLE_CSS}
    table.customs-invoice-table { width: 100%; border-collapse: collapse; font-size: 10px; }
    table.customs-invoice-table th, table.customs-invoice-table td {
      border: 1px solid #d1d5db; padding: 5px 3px; vertical-align: top;
    }
    table.customs-invoice-table th { background: #f3f4f6; text-align: left; }
    table.customs-invoice-table td.num { text-align: right; white-space: nowrap; }
  </style>
</head>
<body class="report-print ${branding.isMarivolt ? "has-quote-terms" : ""}">
<div class="print-page"><div class="print-body">
  <div class="print-header header">
    <div class="header-left">
      ${useBrandedLayout ? `<img src="${printLogo}" alt="${esc(companyDisplayName)}" class="logo" />` : `<div class="brand-fallback">MV</div>`}
    </div>
    <div class="header-center">
      <div class="title">Customs Invoice</div>
      <div class="muted" style="font-size:12px;line-height:1.6;margin-top:6px;">
        <div><b>Customs Invoice No:</b> ${esc(header.customsInvoiceNumber)}</div>
        <div><b>Sales Invoice No:</b> ${esc(header.salesInvoiceNumber)}</div>
        <div><b>Customer:</b> ${esc(header.customerName)}</div>
        <div><b>Date:</b> ${fmtDate(header.invoiceDate)}</div>
        <div><b>Status:</b> ${esc(header.status)}</div>
      </div>
    </div>
    ${
      useBrandedLayout
        ? `<div class="header-right is-marivolt">
            <h1 class="brand-title">${esc(companyDisplayName)}</h1>
            ${companySubtitle ? `<div class="brand-subtitle">${esc(companySubtitle)}</div>` : ""}
            <div class="muted" style="margin-top:8px;font-size:12px;">
              <div>${esc(reportAddress)}</div>
              <div>${esc(reportEmail)}</div>
              <div>${esc(reportPhone)}</div>
            </div>
          </div>`
        : `<div class="header-right muted"><div><b>${esc(companyName)}</b></div></div>`
    }
  </div>
  <table class="customs-invoice-table report-table report-lines-table">
    <thead>
      <tr>
        <th>#</th>
        <th>Article</th>
        <th>Part</th>
        <th>Description</th>
        <th>Allocated Qty</th>
        <th>BOE Number</th>
        <th>BOE Date</th>
        <th>Supplier Invoice No</th>
        <th>Supplier Invoice Date</th>
        <th>COO</th>
        <th>HS Code</th>
        <th>BL</th>
        <th>AWB</th>
      </tr>
    </thead>
    <tbody>
      ${lineRows || `<tr><td colspan="13" style="text-align:center;color:#6b7280;">No allocation lines</td></tr>`}
    </tbody>
  </table>
</div></div>
</body>
</html>`;
}

export async function printCustomsInvoice(payload, { exportPdf = false, companyName = "" } = {}) {
  const html = buildCustomsInvoicePrintHtml({
    header: payload?.header || payload,
    rows: payload?.rows || [],
    companyName,
  });
  const filename = `customs-invoice-${payload?.header?.customsInvoiceNumber || "report"}`;
  return deliverReportHtml(html, { exportPdf, filename });
}
