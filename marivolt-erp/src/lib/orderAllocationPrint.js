import { deliverReportHtml } from "./reportPdfClient.js";
import { buildPrintDocumentHtml, PRINT_DOC_NOTE_HTML_ALT } from "./printDocumentLayout.js";
import { getReportBranding } from "./reportBranding.js";
import { buildQuotationPrintBrandedFooterHtml } from "./salesQuotationDocumentPrint.js";
import {
  ORDER_ALLOCATION_COLGROUP,
  ORDER_ALLOCATION_LINE_TABLE_HEAD,
  PDF_OPTS_ITEM_LINES,
} from "./reportTableLayout.js";
import { SALES_QUOTATION_STYLE_PRINT_CSS } from "./salesQuotationPrintCss.js";

function money(n) {
  return Number(n || 0).toFixed(2);
}

/** Print / PDF (via print dialog) order allocation — quotation-style header, no line prices in table. */
export function renderOrderAllocationPrintWindow(allocation, company = {}, autoPrint = false) {
  if (!allocation) return;
  const lines = Array.isArray(allocation.lines) ? allocation.lines : [];
  const hasCompanyLogo = String(company?.logo || company?.logoUrl || "").trim().length > 0;
  const companyName = String(company?.name || company?.companyName || "").toLowerCase();
  const branding = getReportBranding(companyName);
  const { useBrandedLayout, printLogo, companyDisplayName, companySubtitle, reportAddress, reportEmail, reportPhone } =
    branding;
  const headerHtml = `
        <div class="print-header header">
          <div class="header-left">
            ${
              useBrandedLayout
                ? `<img src="${printLogo}" alt="${companyDisplayName}" class="logo" />`
                : hasCompanyLogo
                  ? `<img src="${company?.logo || company?.logoUrl}" alt="${company?.name || company?.companyName || "Company"} logo" class="logo" />`
                  : `<div class="brand-fallback">MV</div>`
            }
          </div>
          <div class="header-center">
            <div class="title">Order Allocation</div>
            <div class="muted">
              <div><b>Allocation No:</b> ${allocation.allocationNo || "-"}</div>
              <div><b>Date:</b> ${allocation.allocationDate ? new Date(allocation.allocationDate).toLocaleDateString() : "-"}</div>
              <div><b>Status:</b> ${allocation.status || "-"}</div>
              <div><b>Currency:</b> ${allocation.currency || "USD"}</div>
            </div>
          </div>
          ${
            useBrandedLayout
              ? `<div class="header-right is-marivolt">
                <h1 class="brand-title">${companyDisplayName}</h1>
                ${companySubtitle ? `<div class="brand-subtitle">${companySubtitle}</div>` : ""}
                <div class="muted" style="margin-top:8px;">
                  <div>${reportAddress}</div>
                  <div>${reportEmail}</div>
                  <div>${reportPhone}</div>
                </div>
              </div>`
              : `<div class="header-right muted">
                <div><b>${company?.name || company?.companyName || "-"}</b></div>
                <div>${company?.address || ""}</div>
                <div>${company?.email || ""}</div>
                <div>${company?.phone || ""}</div>
              </div>`
          }
        </div>`;
  const contentHtml = `
          <div class="info-box muted">
            <div class="info-box-title">Customer &amp; References</div>
            <div><b>Customer:</b> ${allocation.customerName || "-"}</div>
            <div><b>Linked OA:</b> ${allocation.linkedOANo || "-"}</div>
            <div><b>Linked PI:</b> ${allocation.linkedProformaNo || "-"}</div>
            <div><b>Linked Quotation:</b> ${allocation.linkedQuotationNo || "-"}</div>
          </div>
          <div class="info-box muted">
            <div class="info-box-title">Machine Details</div>
            <div><b>Vertical:</b> ${allocation.vertical || "-"}</div>
            <div><b>Brand:</b> ${allocation.engine || "-"}</div>
            <div><b>Model:</b> ${allocation.model || "-"}</div>
            <div><b>Config:</b> ${allocation.config || "-"}</div>
            <div><b>ESN:</b> ${allocation.esn || "-"}</div>
            <div><b>Currency:</b> ${allocation.currency || "USD"}</div>
          </div>
          <div class="info-box muted">
            <div class="info-box-title">Totals</div>
            <div><b>Sub total:</b> ${allocation.currency || "USD"} ${money(allocation.subTotal)}</div>
            <div><b>Grand total:</b> ${allocation.currency || "USD"} ${money(allocation.grandTotal)}</div>
          </div>
        </div>
        <table class="report-table">
          ${ORDER_ALLOCATION_COLGROUP}
          <thead>
            <tr>${ORDER_ALLOCATION_LINE_TABLE_HEAD}</tr>
          </thead>
          <tbody>
            ${lines
              .map(
                (line, i) => `<tr>
                  <td class="col-sno">${line.serialNo ?? i + 1}</td>
                  <td class="col-article">${line.article || ""}</td>
                  <td class="col-part">${line.partNumber || ""}</td>
                  <td class="col-desc">${line.description || ""}</td>
                  <td class="col-uom">${line.uom || "PCS"}</td>
                  <td class="col-qty">${line.qty ?? 0}</td>
                  <td class="col-qty">${line.shippedQty ?? 0}</td>
                  <td class="col-qty">${line.pendingQty ?? ""}</td>
                  <td class="col-remarks">${line.remarks || ""}</td>
                  <td class="col-availability">${line.availability || ""}</td>
                </tr>`
              )
              .join("")}
          </tbody>
        </table>
        ${
          branding.isMarivolt
            ? `<div class="quote-terms">Only Marivolt terms and condition applicable, check here-<a href="https://marivolt.co/about-us">https://marivolt.co/about-us</a></div>`
            : ""
        }
        ${PRINT_DOC_NOTE_HTML_ALT}`;
  const html = buildPrintDocumentHtml({
    title: `Order Allocation ${allocation.allocationNo || ""}`,
    bodyClass: "report-print print-document",
    headerHtml,
    contentHtml,
    footerHtml: buildQuotationPrintBrandedFooterHtml(branding),
    styleCss: SALES_QUOTATION_STYLE_PRINT_CSS,
  });
  return deliverReportHtml(html, {
    exportPdf: autoPrint,
    filename: allocation?.allocationNo || "order-allocation",
    pdfOptions: autoPrint ? PDF_OPTS_ITEM_LINES : {},
  });
}

export function orderAllocationCsvHeaders() {
  return [
    "Allocation No",
    "Allocation Date",
    "Customer",
    "Linked OA",
    "Linked PI",
    "Currency",
    "Status",
    "Line S/N",
    "Article",
    "Part no",
    "Description",
    "UOM",
    "Qty",
    "Shipped Qty",
    "Pending Qty",
    "Unit Price",
    "Line Total",
    "Remarks",
    "Availability",
  ];
}

export function orderAllocationCsvRows(allocation) {
  const lines = Array.isArray(allocation?.lines) ? allocation.lines : [];
  const base = [
    allocation?.allocationNo || "",
    allocation?.allocationDate ? new Date(allocation.allocationDate).toISOString().slice(0, 10) : "",
    allocation?.customerName || "",
    allocation?.linkedOANo || "",
    allocation?.linkedProformaNo || "",
    allocation?.currency || "USD",
    allocation?.status || "",
  ];
  if (!lines.length) {
    return [[...base, "", "", "", "", "", "", "", "", "", "", "", "", ""]];
  }
  return lines.map((line, i) => [
    ...base,
    String(line.serialNo ?? i + 1),
    line.article || "",
    line.partNumber || "",
    line.description || "",
    line.uom || "PCS",
    line.qty ?? "",
    line.shippedQty ?? "",
    line.pendingQty ?? "",
    line.price ?? "",
    line.totalPrice ?? "",
    line.remarks || "",
    line.availability || "",
  ]);
}
