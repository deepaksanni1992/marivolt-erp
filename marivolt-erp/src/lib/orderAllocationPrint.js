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
  const isMarivolt = companyName.includes("marivolt");
  const isOkeanos = companyName.includes("okeanos");
  const useBrandedLayout = isMarivolt || isOkeanos;
  const printLogo = isMarivolt ? "/brand/marivolt-icon.png" : isOkeanos ? "/brand/okeanos-logo.png" : "";
  const companyDisplayName = isMarivolt ? "MariVolt" : isOkeanos ? "OKEANOS" : (company?.name || company?.companyName || "-");
  const companySubtitle = useBrandedLayout ? "Marine Engine Spares" : "";
  const reportAddress = isMarivolt
    ? "LV09B, Hamriyah freezone phase 2, Sharjah, UAE"
    : isOkeanos
      ? "C1 Building, Ajman Freezone, Ajman, UAE"
      : (company?.address || "");
  const reportEmail = isMarivolt ? "sales@marivolt.co" : isOkeanos ? "Sales@okeanos.pro" : (company?.email || "");
  const reportPhone = isMarivolt ? "+971-543053047" : isOkeanos ? "+971-543050000" : (company?.phone || "");
  const reportWebsite = isMarivolt ? "www.marivolt.co" : isOkeanos ? "www.okfze.com" : "";
  const reportFooterName = isMarivolt ? "Marivolt FZE" : isOkeanos ? "Okeanos FZE" : companyDisplayName;
  const reportFooterSubline = isMarivolt ? "LV09B" : "";
  const html = `
    <html>
      <head>
        <title>Order Allocation ${allocation.allocationNo || ""}</title>
        <style>
${SALES_QUOTATION_STYLE_PRINT_CSS}
        </style>
      </head>
      <body class="report-print ${isMarivolt ? "has-quote-terms" : ""}"><div class="print-page"><div class="print-body">
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
        </div>
        <div class="info-grid">
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
        <table>
          <thead>
            <tr>
              <th>S/N</th><th>Article</th><th>Part no</th><th>Description</th><th>UOM</th>
              <th class="right">Qty</th><th class="right">Shipped</th><th class="right">Pending</th>
              <th class="remarks-col">Remarks</th><th>Availability</th>
            </tr>
          </thead>
          <tbody>
            ${lines
              .map(
                (line, i) => `<tr>
                  <td>${line.serialNo ?? i + 1}</td>
                  <td>${line.article || ""}</td>
                  <td>${line.partNumber || ""}</td>
                  <td>${line.description || ""}</td>
                  <td>${line.uom || "PCS"}</td>
                  <td class="right">${line.qty ?? 0}</td>
                  <td class="right">${line.shippedQty ?? 0}</td>
                  <td class="right">${line.pendingQty ?? ""}</td>
                  <td class="remarks-col">${line.remarks || ""}</td>
                  <td>${line.availability || ""}</td>
                </tr>`
              )
              .join("")}
          </tbody>
        </table>
        ${
          isMarivolt
            ? `<div class="quote-terms">Only Marivolt terms and condition applicable, check here-<a href="https://marivolt.co/about-us">https://marivolt.co/about-us</a></div>`
            : ""
        }
        <div class="footer">
          <div class="doc-note">This is a computer generated document and does not require signature or stamp.</div>
        </div>
        </div>
        ${
          useBrandedLayout
            ? `<div class="print-footer page-footer">
          <div class="page-footer-top">
            <div>
              <div>${reportFooterName || "-"}</div>
              ${reportFooterSubline ? `<div>${reportFooterSubline}</div>` : ""}
            </div>
            <div class="page-footer-center">${reportAddress}</div>
            <div class="page-footer-right">
              <div>Mob: ${reportPhone}</div>
              <div>Email: ${reportEmail}</div>
              <div>Web: ${reportWebsite}</div>
            </div>
          </div>
          <div class="page-footer-line"></div>
        </div>`
            : ""
        }
      </div>
      </body>
    </html>
  `;
  const win = window.open("", "_blank", "width=1200,height=900");
  if (!win) {
    window.alert("Allow pop-ups for this site to print or export PDF.");
    return;
  }
  win.document.write(html);
  win.document.close();
  win.focus();
  if (autoPrint) setTimeout(() => win.print(), 300);
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
