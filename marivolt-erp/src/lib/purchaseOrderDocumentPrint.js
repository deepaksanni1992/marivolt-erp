import { getReportBranding } from "./reportBranding.js";
import { downloadSearchableReportPdf } from "./reportPdfClient.js";
import { calcPoTotalsFromDoc } from "./poTotals.js";
import { PDF_OPTS_ITEM_LINES, PO_LINE_COLGROUP, PO_LINE_TABLE_HEAD } from "./reportTableLayout.js";
import { SALES_QUOTATION_STYLE_PRINT_CSS } from "./salesQuotationPrintCss.js";

/** Supplier-facing part reference only (no internal article / SPN). */
export function supplierPartNumberForPrint(line) {
  const v = String(line?.supplierPartNumber ?? "").trim();
  return v || "—";
}

/** Material code for supplier-facing PO print when enabled on the PO. */
export function materialCodeForPrint(line) {
  const v = String(line?.materialCode ?? line?.itemCode ?? "").trim();
  return v || "—";
}

function escapeHtml(s) {
  if (s == null || s === "") return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function absAssetUrl(path) {
  if (!path) return "";
  if (/^https?:\/\//i.test(path)) return path;
  if (typeof window === "undefined") return path;
  const p = path.startsWith("/") ? path : `/${path}`;
  return `${window.location.origin}${p}`;
}

function formatPoDateLocale(val) {
  if (!val) return "—";
  const d = typeof val === "string" || typeof val === "number" ? new Date(val) : val;
  if (Number.isNaN(d.getTime())) return escapeHtml(String(val));
  return escapeHtml(d.toLocaleDateString());
}

/**
 * Full formatted PO HTML for print / Save as PDF (matches on-screen preview branding).
 */
export function buildPurchaseOrderDocumentHtml(doc, company = null) {
  const lines = Array.isArray(doc?.lines) ? doc.lines : [];
  const { subTotal, discountTotal, packingCost, handlingCost, miscellaneousCost, grandTotal: grand } =
    calcPoTotalsFromDoc(doc);
  const cur = escapeHtml(doc.currency || "USD");

  const buyer = {
    name: escapeHtml(doc.buyerLegalName || "—"),
    address: escapeHtml(doc.buyerAddressLine || "—").replace(/\n/g, "<br/>"),
    phone: escapeHtml(doc.buyerPhone || "—"),
    email: escapeHtml(doc.buyerEmail || "—"),
    web: escapeHtml(doc.buyerWeb || ""),
    trn: escapeHtml(doc.buyerTrnNo || ""),
  };

  const unsaved = doc.__unsavedDraft === true;
  const poNoRaw = unsaved ? "Draft (not saved)" : doc.poNumber || "—";
  const poNo = escapeHtml(poNoRaw);

  const brandingName = String(doc.buyerLegalName || company?.name || "").trim();
  const b = getReportBranding(brandingName);
  const companyLogo = String(company?.logoUrl || company?.logo || "").trim();
  const logoRel = b.useBrandedLayout ? b.printLogo : companyLogo;
  const logoSrc = logoRel ? absAssetUrl(logoRel) : "";

  const isOkeanos = b.isOkeanos;
  const isMarivolt = b.isMarivolt;
  const poDateLocale = formatPoDateLocale(doc.orderDate);
  const rightAddress =
    doc.buyerAddressLine && String(doc.buyerAddressLine).trim()
      ? escapeHtml(doc.buyerAddressLine).replace(/\n/g, "<br/>")
      : escapeHtml(b.reportAddress || "");
  const rightEmail =
    doc.buyerEmail && String(doc.buyerEmail).trim()
      ? escapeHtml(doc.buyerEmail)
      : escapeHtml(b.reportEmail || "");
  const rightPhone =
    doc.buyerPhone && String(doc.buyerPhone).trim()
      ? escapeHtml(doc.buyerPhone)
      : escapeHtml(b.reportPhone || "");

  const machine = {
    vertical: escapeHtml(doc.vertical || "—"),
    brand: escapeHtml(doc.brand || doc.engine || "—"),
    model: escapeHtml(doc.model || "—"),
    config: escapeHtml(doc.config || "—"),
    esn: escapeHtml(doc.esn || "—"),
    currency: cur,
  };

  const thBg = isOkeanos ? "#f5f5f5" : "#1f3a5f";
  const thColor = isOkeanos ? "#374151" : "#ffffff";
  const thBorder = isOkeanos ? "#ddd" : "#1f3a5f";

  const showMaterialCode = doc?.showMaterialCodeOnPrint === true;
  const showMachineDetails = doc?.showMachineDetailsOnPrint === true;
  const lineColSpan = showMaterialCode ? 10 : 9;
  const partyGridCols = showMachineDetails ? "1fr 1fr 1fr" : "1fr 1fr";

  const lineRows = lines
    .map((l, i) => {
      const qty = Number(l.qty) || 0;
      const rate = Number(l.unitPrice) || 0;
      const tot = qty * rate;
      const stripe = i % 2 === 0 ? "#ffffff" : "#f9fafb";
      return `<tr style="background:${stripe}">
        <td class="col-sno" style="border:1px solid #e5e7eb;padding:6px 8px;color:#6b7280;font-size:11px">${i + 1}</td>
        <td class="col-desc" style="border:1px solid #e5e7eb;padding:6px 8px;font-size:12px">${escapeHtml(l.description || "—")}</td>
        <td class="col-part" style="border:1px solid #e5e7eb;padding:6px 8px;font-size:11px">${escapeHtml(supplierPartNumberForPrint(l))}</td>
        ${
          showMaterialCode
            ? `<td class="col-article" style="border:1px solid #e5e7eb;padding:6px 8px;font-size:11px;font-family:monospace">${escapeHtml(materialCodeForPrint(l))}</td>`
            : ""
        }
        <td class="col-uom" style="border:1px solid #e5e7eb;padding:6px 8px;font-size:12px">${escapeHtml(l.uom || "PCS")}</td>
        <td class="col-qty" style="border:1px solid #e5e7eb;padding:6px 8px;font-size:12px">${escapeHtml(String(qty))}</td>
        <td class="col-price" style="border:1px solid #e5e7eb;padding:6px 8px;font-size:12px">${rate.toFixed(2)}</td>
        <td class="col-total" style="border:1px solid #e5e7eb;padding:6px 8px;font-size:12px;font-weight:600">${tot.toFixed(2)}</td>
        <td class="col-lead" style="border:1px solid #e5e7eb;padding:6px 8px;font-size:12px">${escapeHtml(l.leadTime || "—")}</td>
        <td class="col-remarks" style="border:1px solid #e5e7eb;padding:6px 8px;font-size:12px;color:#4b5563">${escapeHtml(l.remarks || "—")}</td>
      </tr>`;
    })
    .join("");

  const emptyLinesRow = `<tr><td colspan="${lineColSpan}" style="border:1px solid #e5e7eb;padding:24px;text-align:center;color:#6b7280">No line items.</td></tr>`;

  const headerOkeanos = `
    <header style="display:grid;grid-template-columns:1fr 1fr 1fr;align-items:center;gap:16px;border-bottom:2px solid #e5e7eb;padding-bottom:20px;margin-bottom:20px;" class="po-print-header">
      <div style="min-height:118px;display:flex;align-items:center;justify-content:flex-start">
        ${logoSrc ? `<img src="${escapeHtml(logoSrc)}" alt="Logo" style="max-height:118px;max-width:208px;height:auto;object-fit:contain"/>` : `<div style="font-size:24px;font-weight:800;color:#1f3a5f">OKE</div>`}
      </div>
      <div style="text-align:center">
        <h1 style="margin:0;font-size:22px;font-weight:700;color:#111">Purchase order</h1>
        <div style="margin-top:10px;font-size:13px;line-height:1.6;color:#555">
          <div><strong>No:</strong> ${poNo}</div>
          <div><strong>Date:</strong> ${poDateLocale}</div>
          <div><strong>Currency:</strong> ${cur}</div>
          ${doc.ref ? `<div><strong>Ref:</strong> ${escapeHtml(doc.ref)}</div>` : ""}
        </div>
        <div style="margin-top:12px">
          ${unsaved ? `<span style="display:inline-block;padding:4px 12px;font-size:11px;font-weight:600;background:#f3f4f6;border:1px solid #e5e7eb;border-radius:9999px">Unsaved draft</span>` : doc.status ? `<span style="display:inline-block;padding:4px 12px;font-size:11px;font-weight:600;text-transform:uppercase;background:#f3f4f6;border:1px solid #e5e7eb;border-radius:9999px">${escapeHtml(doc.status)}</span>` : ""}
        </div>
      </div>
      <div style="text-align:right;font-size:12px;line-height:1.6;color:#4a5568">
        <div style="font-size:32px;font-weight:800;line-height:1;color:#1f3a5f">${escapeHtml(b.companyDisplayName)}</div>
        ${b.companySubtitle ? `<div style="margin-top:6px;font-size:14px;font-weight:600;color:#2c5282">${escapeHtml(b.companySubtitle)}</div>` : ""}
        <div style="margin-top:12px">
          ${rightAddress ? `<div>${rightAddress}</div>` : ""}
          ${rightEmail ? `<div>${rightEmail}</div>` : ""}
          ${rightPhone ? `<div>${rightPhone}</div>` : ""}
        </div>
      </div>
    </header>`;

  const headerDefault = `
    <header style="display:grid;grid-template-columns:1fr 1fr 1fr;align-items:center;gap:16px;border-bottom:2px solid #e5e7eb;padding-bottom:20px;margin-bottom:20px;" class="po-print-header">
      <div style="min-height:118px;display:flex;align-items:center;justify-content:flex-start">
        ${logoSrc ? `<img src="${escapeHtml(logoSrc)}" alt="Logo" style="max-height:118px;max-width:208px;height:auto;object-fit:contain"/>` : `<div style="font-size:24px;font-weight:800;color:#1f3a5f">${escapeHtml(String(company?.code || "MV").slice(0, 4))}</div>`}
      </div>
      <div style="text-align:center">
        <h1 style="margin:0;font-size:22px;font-weight:700;color:#111">Purchase order</h1>
        <div style="margin-top:10px;font-size:13px;line-height:1.6;color:#555">
          <div><strong>No:</strong> ${poNo}</div>
          <div><strong>Date:</strong> ${poDateLocale}</div>
          <div><strong>Currency:</strong> ${cur}</div>
          ${doc.ref ? `<div><strong>Ref:</strong> ${escapeHtml(doc.ref)}</div>` : ""}
        </div>
        <div style="margin-top:12px">
          ${unsaved ? `<span style="display:inline-block;padding:4px 12px;font-size:11px;font-weight:600;background:#f3f4f6;border:1px solid #e5e7eb;border-radius:9999px">Unsaved draft</span>` : doc.status ? `<span style="display:inline-block;padding:4px 12px;font-size:11px;font-weight:600;text-transform:uppercase;background:#f3f4f6;border:1px solid #e5e7eb;border-radius:9999px">${escapeHtml(doc.status)}</span>` : ""}
        </div>
      </div>
      <div style="text-align:right;font-size:12px;line-height:1.6;color:#4a5568">
        <div style="font-size:32px;font-weight:800;line-height:1;color:#1f3a5f">${buyer.name !== "—" ? buyer.name : escapeHtml(b.companyDisplayName || company?.name || "—")}</div>
        ${b.companySubtitle ? `<div style="margin-top:6px;font-size:14px;font-weight:600;color:#2c5282">${escapeHtml(b.companySubtitle)}</div>` : ""}
        <div style="margin-top:12px">
          ${rightAddress ? `<div>${rightAddress}</div>` : ""}
          ${rightEmail ? `<div>${rightEmail}</div>` : ""}
          ${rightPhone ? `<div>${rightPhone}</div>` : ""}
        </div>
      </div>
    </header>`;

  const commercialGrid = [
    ["Delivery", doc.delivery],
    ["Insurance", doc.insurance],
    ["Packing", doc.packing],
    ["Freight", doc.freight],
    ["Taxes", doc.taxes],
    ["Payment", doc.payment],
  ].filter(([, v]) => v != null && String(v).trim() !== "");

  const commercialHtml =
    commercialGrid.length > 0
      ? `<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin:16px 0;font-size:11px">
          ${commercialGrid
            .map(
              ([k, v]) =>
                `<div style="border:1px solid #f3f4f6;border-radius:8px;padding:10px;background:#fafafa"><div style="font-weight:700;text-transform:uppercase;color:#6b7280">${escapeHtml(k)}</div><div style="margin-top:6px;color:#374151">${escapeHtml(String(v))}</div></div>`,
            )
            .join("")}
        </div>`
      : "";

  const termsBlock =
    doc.termsAndConditions && String(doc.termsAndConditions).trim()
      ? `<div style="margin-top:16px;page-break-inside:avoid">
          <div style="font-size:10px;font-weight:700;text-transform:uppercase;color:#6b7280;margin-bottom:8px">Terms &amp; conditions</div>
          <div style="border:1px solid #e5e7eb;border-radius:8px;padding:12px;background:#f9fafb;font-size:11px;line-height:1.55;color:#374151;white-space:pre-wrap">${escapeHtml(doc.termsAndConditions)}</div>
        </div>`
      : "";

  const closing = doc.closingNote ? escapeHtml(doc.closingNote) : "";

  const footerBranded = b.useBrandedLayout
    ? `${escapeHtml(b.reportFooterName)}${b.reportWebsite ? ` · ${escapeHtml(b.reportWebsite)}` : ""}`
    : `Purchase order — ${buyer.name}`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <title>${poNo} — Purchase order</title>
  <style>
${SALES_QUOTATION_STYLE_PRINT_CSS}
    body.po-print-document { font-family: Arial, Helvetica, sans-serif; color: #111; font-size: 12px; }
    table { border-collapse: collapse; width: 100%; }
    .po-print-header { page-break-inside: avoid; }
  </style>
</head>
<body class="report-print po-print-document${b.useBrandedLayout ? " has-branded-footer" : ""}${isMarivolt && doc.termsAndConditions && String(doc.termsAndConditions).trim() ? " has-quote-terms" : ""}">
  <div class="print-page main-page po-page">
  <div class="print-body">
  ${isOkeanos ? headerOkeanos : headerDefault}

  <div style="display:grid;grid-template-columns:${partyGridCols};gap:12px;margin-bottom:16px">
    <div class="info-box muted">
      <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.3px;color:#6b7280">Buyer</div>
      <div style="margin-top:8px;font-size:14px;font-weight:600;color:#111">${buyer.name}</div>
      <div style="margin-top:8px;font-size:12px;line-height:1.5;color:#4a5568">${buyer.address}</div>
      <div style="margin-top:10px;font-size:12px;color:#4a5568">Tel: ${buyer.phone}</div>
      <div style="font-size:12px">${buyer.email}</div>
      ${buyer.trn ? `<div style="margin-top:6px;font-size:12px;color:#4a5568">TRN: ${buyer.trn}</div>` : ""}
    </div>
    <div class="info-box muted">
      <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.3px;color:#6b7280">Supplier</div>
      <div style="margin-top:8px;font-size:14px;font-weight:600;color:#111">${escapeHtml(doc.supplierName || "—")}</div>
      ${doc.supplierAddress ? `<div style="margin-top:8px;font-size:12px;line-height:1.5;color:#4a5568">${escapeHtml(doc.supplierAddress).replace(/\n/g, "<br/>")}</div>` : ""}
      <div style="margin-top:10px;font-size:12px;color:#4a5568">
        ${doc.supplierPhone ? `<div>Tel: ${escapeHtml(doc.supplierPhone)}</div>` : ""}
        ${doc.supplierEmail ? `<div>${escapeHtml(doc.supplierEmail)}</div>` : ""}
      </div>
    </div>
    ${
      showMachineDetails
        ? `<div class="info-box muted">
      <div class="info-box-title">Machine Details</div>
      <div><b>Vertical:</b> ${machine.vertical}</div>
      <div><b>Brand:</b> ${machine.brand}</div>
      <div><b>Model:</b> ${machine.model}</div>
      <div><b>Config:</b> ${machine.config}</div>
      <div><b>ESN:</b> ${machine.esn}</div>
      <div><b>Currency:</b> ${machine.currency}</div>
    </div>`
        : ""
    }
  </div>

  ${doc.contactPerson || doc.delivery || doc.payment ? `
  <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;padding-top:12px;margin-bottom:12px;border-top:1px solid #e5e7eb;font-size:12px;color:#555">
    ${doc.contactPerson ? `<div><span style="font-weight:600;color:#6b7280">Contact: </span>${escapeHtml(doc.contactPerson)}</div>` : "<div></div>"}
    ${doc.delivery ? `<div style="text-align:center"><span style="font-weight:600;color:#6b7280">Delivery: </span>${escapeHtml(doc.delivery)}</div>` : "<div></div>"}
    ${doc.payment ? `<div style="text-align:right"><span style="font-weight:600;color:#6b7280">Payment: </span>${escapeHtml(doc.payment)}</div>` : "<div></div>"}
  </div>` : ""}

  ${doc.remarks ? `<div style="border:1px dashed #e5e7eb;border-radius:6px;padding:10px 12px;margin-bottom:12px;font-size:12px;color:#374151"><strong style="color:#6b7280">Header remarks:</strong> ${escapeHtml(doc.remarks)}</div>` : ""}

  ${commercialHtml}

  <table class="po-lines-table report-table" style="margin-top:12px">
    ${PO_LINE_COLGROUP(showMaterialCode)}
    <thead>
      <tr style="background:${thBg};color:${thColor}">
        ${PO_LINE_TABLE_HEAD(thBorder, thBg, thColor, showMaterialCode)}
      </tr>
    </thead>
    <tbody>${lines.length ? lineRows : emptyLinesRow}</tbody>
  </table>

  <div class="print-totals po-totals totals-section" style="display:flex;justify-content:flex-end;border-top:1px solid #e5e7eb;padding-top:16px">
    <div style="width:280px;font-size:13px">
      <div style="display:flex;justify-content:space-between;color:#4b5563;margin-bottom:6px"><span>Line items subtotal</span><span style="font-weight:600;color:#111">${cur} ${subTotal.toFixed(2)}</span></div>
      <div style="display:flex;justify-content:space-between;color:#4b5563;margin-bottom:6px"><span>Packing cost</span><span style="font-weight:600;color:#111">${cur} ${packingCost.toFixed(2)}</span></div>
      <div style="display:flex;justify-content:space-between;color:#4b5563;margin-bottom:6px"><span>Handling cost</span><span style="font-weight:600;color:#111">${cur} ${handlingCost.toFixed(2)}</span></div>
      <div style="display:flex;justify-content:space-between;color:#4b5563;margin-bottom:6px"><span>Miscellaneous cost</span><span style="font-weight:600;color:#111">${cur} ${miscellaneousCost.toFixed(2)}</span></div>
      <div style="display:flex;justify-content:space-between;color:#4b5563;margin-bottom:6px"><span>Discount</span><span style="font-weight:600;color:#111">${cur} ${discountTotal.toFixed(2)}</span></div>
      <div style="display:flex;justify-content:space-between;padding-top:8px;border-top:1px solid #e5e7eb;font-size:16px;font-weight:700;color:#1f3a5f"><span>Grand total</span><span>${cur} ${grand.toFixed(2)}</span></div>
    </div>
  </div>

  <div class="po-post-totals">
  ${doc.specialRemarks != null && String(doc.specialRemarks).trim() !== "" ? `
  <div style="margin-top:16px;border:1px solid #fef3c7;background:#fffbeb;border-radius:8px;padding:12px;font-size:11px">
    <div style="font-weight:700;text-transform:uppercase;color:#92400e;margin-bottom:6px">Special remarks</div>
    <div style="white-space:pre-wrap;color:#451a03">${escapeHtml(doc.specialRemarks)}</div>
  </div>` : ""}

  ${termsBlock}

  ${closing ? `<div style="margin-top:14px;padding:12px;border:1px solid #e5e7eb;border-radius:8px;font-size:11px;font-style:italic;color:#4b5563">${closing}</div>` : ""}
  </div>

  </div>
  <div class="print-page-footer">
  <div class="footer po-doc-note document-footer footer-note computer-generated-note">
    <div class="doc-note">This is digital copy, No Signature/Stamp required</div>
  </div>
  ${
    !b.useBrandedLayout
      ? `<div class="po-footer-simple">${footerBranded}</div>`
      : ""
  }
  ${
    b.useBrandedLayout
      ? `<div class="print-footer po-footer page-footer document-footer">
          <div class="page-footer-top">
            <div>
              <div>${escapeHtml(b.reportFooterName) || "-"}</div>
              ${b.reportFooterSubline ? `<div>${escapeHtml(b.reportFooterSubline)}</div>` : ""}
            </div>
            <div class="page-footer-center">${escapeHtml(b.reportAddress)}</div>
            <div class="page-footer-right">
              <div>Mob: ${escapeHtml(b.reportPhone)}</div>
              <div>Email: ${escapeHtml(b.reportEmail)}</div>
              <div>Web: ${escapeHtml(b.reportWebsite)}</div>
            </div>
          </div>
          <div class="page-footer-line"></div>
        </div>`
      : ""
  }
  </div>
  </div>

  <p class="no-print" style="margin-top:24px;font-size:11px;color:#6b7280">
    Use <strong>Export PDF</strong> in the ERP for a searchable PDF download.
  </p>
</body>
</html>`;
}

/**
 * Download a searchable PDF for the full formatted PO document.
 */
export function exportPurchaseOrderDocumentPdf(doc, company) {
  const html = buildPurchaseOrderDocumentHtml(doc, company);
  const poNo = doc?.__unsavedDraft ? "purchase-order-draft" : doc?.poNumber || "purchase-order";
  return downloadSearchableReportPdf({ html, filename: poNo, options: PDF_OPTS_ITEM_LINES });
}

/**
 * Writes the PO HTML into an existing window (e.g. opened synchronously on click to avoid pop-up blocking).
 */
export function writePurchaseOrderDocumentToWindow(win, doc, company) {
  if (!win || win.closed) return;
  const html = buildPurchaseOrderDocumentHtml(doc, company);
  win.document.open();
  win.document.write(html);
  win.document.close();
}

/**
 * Opens a new tab with the full PO document, or downloads searchable PDF when exportPdf is true.
 */
export function openPurchaseOrderDocumentWindow(doc, company, { autoPrint = false, exportPdf = false } = {}) {
  const html = buildPurchaseOrderDocumentHtml(doc, company);
  if (exportPdf || autoPrint) {
    const poNo = doc?.__unsavedDraft ? "purchase-order-draft" : doc?.poNumber || "purchase-order";
    return downloadSearchableReportPdf({ html, filename: poNo, options: PDF_OPTS_ITEM_LINES });
  }
  const w = window.open("about:blank", "_blank");
  if (!w) {
    window.alert("Pop-up blocked. Allow pop-ups for this site to view or print the PO.");
    return;
  }
  writePurchaseOrderDocumentToWindow(w, doc, company);
}
