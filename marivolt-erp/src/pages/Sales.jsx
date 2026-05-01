import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Papa from "papaparse";
import PageHeader from "../components/erp/PageHeader.jsx";
import Modal from "../components/erp/Modal.jsx";
import { FormField, TextInput } from "../components/erp/FormField.jsx";
import { apiGet, apiGetWithQuery, apiPatch, apiPost, apiPut } from "../lib/api.js";
import { SALES_QUOTATION_STYLE_PRINT_CSS } from "../lib/salesQuotationPrintCss.js";
import { useAuth } from "../context/AuthContext.jsx";

const salesTabs = [
  "Customer Master",
  "Quotation",
  "Order Acknowledgement",
  "Proforma Invoice",
  "Sales Invoice",
  "CIPL",
  "Reports",
];

const reportsCatalog = [
  {
    group: "Quotation Reports",
    key: "pre-sales",
    items: [
      { id: "quotation-summary", title: "Quotation Summary", desc: "Company-wise quotation register with value, status, and conversion snapshot." },
      { id: "pending-quotation", title: "Pending Quotation Report", desc: "Open quotations requiring follow-up by status and age." },
    ],
  },
  {
    group: "Order Confirmation Reports",
    key: "oa",
    items: [
      { id: "order-acknowledgement", title: "Order Acknowledgement Report", desc: "Track OA issuance, linked quotation references, and confirmation state." },
      { id: "pending-order-acknowledgement", title: "Pending Order Acknowledgement Report", desc: "OA records pending closure or downstream conversion." },
    ],
  },
  {
    group: "Invoice Reports",
    key: "invoice",
    items: [
      { id: "proforma", title: "Proforma Invoice Report", desc: "Review proforma lifecycle, validity, and conversion progress." },
      { id: "sales-invoice-summary", title: "Sales Invoice Summary", desc: "Customer-level invoicing totals including paid and unpaid split." },
      { id: "sales-invoice-article-wise", title: "Sales Invoice Summary Article Wise", desc: "Article performance report by quantity, value, and customer count." },
      { id: "sales-branch-wise", title: "Sales Report Summary Branch Wise", desc: "Branch/location-wise invoicing performance in extensible format." },
    ],
  },
  {
    group: "Export / Shipment Reports",
    key: "shipment",
    items: [{ id: "cipl", title: "CIPL Report", desc: "Shipment and export package report with value and logistics markers." }],
  },
];

const statusOptions = ["DRAFT", "SENT", "APPROVED", "REJECTED", "EXPIRED", "CONVERTED", "CANCELLED"];
const oaStatusOptions = ["DRAFT", "CONFIRMED", "CLOSED", "CANCELLED"];
const proformaStatusOptions = ["DRAFT", "ISSUED", "PAID_PENDING_SHIPMENT", "CONVERTED", "CANCELLED"];
const salesInvoiceStatusOptions = ["DRAFT", "ISSUED", "PARTIALLY_PAID", "PAID", "CANCELLED"];
const ciplStatusOptions = ["DRAFT", "ISSUED", "SHIPPED", "CANCELLED"];

const reportStatusOptionsById = {
  "quotation-summary": statusOptions,
  "pending-quotation": statusOptions,
  "order-acknowledgement": oaStatusOptions,
  "pending-order-acknowledgement": oaStatusOptions,
  proforma: proformaStatusOptions,
  "sales-invoice-summary": salesInvoiceStatusOptions,
  "sales-invoice-article-wise": salesInvoiceStatusOptions,
  "sales-branch-wise": salesInvoiceStatusOptions,
  cipl: ciplStatusOptions,
};

const emptyLine = () => ({
  serialNo: 0,
  article: "",
  partNumber: "",
  description: "",
  qty: 1,
  uom: "PCS",
  price: 0,
  totalPrice: 0,
  remarks: "",
  materialCode: "",
  availability: "",
});

/** Sample CSV aligned with quotation line columns (Article, Description, and positive QTY required per row). */
const QUOTATION_LINES_CSV_TEMPLATE = `Article,Part number,Description,UOM,QTY,Price,Remarks,Material code,Availability
51228,034.02.112,Sample spare part,PCS,1,25.00,Optional note,ABC123,In stock`;

function normCsvHeader(s) {
  return String(s ?? "")
    .replace(/^\uFEFF/, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/_/g, " ");
}

function compactHeader(s) {
  return normCsvHeader(s).replace(/\s/g, "");
}

/** First matching non-empty header among aliases (compares normalized compact keys). */
function pickCsv(row, aliases) {
  if (!row || typeof row !== "object") return "";
  const keyMap = Object.keys(row).map((k) => ({ raw: k, c: compactHeader(k) }));
  for (const a of aliases) {
    const want = compactHeader(a);
    const hit = keyMap.find((x) => x.c === want);
    if (!hit) continue;
    const v = row[hit.raw];
    if (v === undefined || v === null || String(v).trim() === "") continue;
    return String(v).trim();
  }
  return "";
}

function parseMoneyOrQty(raw) {
  const s = String(raw ?? "").trim().replace(/,/g, "");
  const n = Number.parseFloat(s);
  return Number.isFinite(n) ? n : NaN;
}

function quotationLinesFromCsvRows(csvRows) {
  const out = [];
  if (!Array.isArray(csvRows)) return out;
  for (const row of csvRows) {
    if (!row || typeof row !== "object") continue;
    const hasAnyCell = Object.keys(row).some((k) => String(row[k] ?? "").trim() !== "");
    if (!hasAnyCell) continue;
    const article = pickCsv(row, ["article", "item", "item code", "itemcode", "sku"]);
    const description = pickCsv(row, ["description", "desc", "item description"]);
    const qtyRaw = pickCsv(row, ["qty", "quantity", "q"]);
    const qty = qtyRaw === "" ? NaN : parseMoneyOrQty(qtyRaw);
    if (!article || !description || !(qty > 0)) continue;
    const partNumber = pickCsv(row, ["part number", "part no", "partno", "maker part"]);
    const uom = pickCsv(row, ["uom", "unit", "unit of measure"]) || "PCS";
    const priceRaw = pickCsv(row, ["price", "unit price", "sale price", "unitprice", "rate"]);
    const price = Number.isFinite(parseMoneyOrQty(priceRaw)) ? Math.max(0, parseMoneyOrQty(priceRaw)) : 0;
    const remarks = pickCsv(row, ["remarks", "notes", "note"]);
    const materialCode = pickCsv(row, ["material code", "material", "materialcode"]);
    const availability = pickCsv(row, ["availability", "stock", "avail"]);
    out.push({
      serialNo: out.length + 1,
      article: article.toUpperCase(),
      partNumber,
      description,
      uom,
      qty,
      price,
      totalPrice: qty * price,
      remarks,
      materialCode,
      availability,
    });
  }
  return out;
}

function quotationDetailToEditableForm(q) {
  if (!q) return null;
  const linesSrc = Array.isArray(q.lines) && q.lines.length ? q.lines : [];
  const lines =
    linesSrc.length > 0
      ? linesSrc.map((l, idx) => {
          const qty = Number(l.qty) || 0;
          const price = Number(l.price) || 0;
          const totalPrice = Number(l.totalPrice) || qty * price;
          return {
            serialNo: l.serialNo ?? idx + 1,
            article: l.article || "",
            partNumber: l.partNumber || "",
            description: l.description || "",
            qty,
            uom: l.uom || "PCS",
            price,
            totalPrice,
            remarks: l.remarks || "",
            materialCode: l.materialCode || "",
            availability: l.availability || "",
          };
        })
      : [emptyLine()];
  return {
    quotationNo: q.quotationNo || "",
    quotationDate: q.quotationDate ? new Date(q.quotationDate).toISOString().slice(0, 10) : "",
    validityDate: q.validityDate ? new Date(q.validityDate).toISOString().slice(0, 10) : "",
    customerId: String(q.customerId || ""),
    customerName: q.customerName || "",
    customerReference: q.customerReference || "",
    attention: q.attention || "",
    engine: q.engine || "",
    model: q.model || "",
    config: q.config || "",
    esn: q.esn || "",
    paymentTerms: q.paymentTerms || "",
    deliveryTerms: q.deliveryTerms || "",
    incoterm: q.incoterm || "",
    currency: q.currency || "USD",
    exchangeRate: q.exchangeRate ?? 1,
    portOfLoading: q.portOfLoading || "",
    portOfDischarge: q.portOfDischarge || "",
    finalDestination: q.finalDestination || "",
    remarks: q.remarks || "",
    internalNotes: q.internalNotes || "",
    customer: q.customer || {
      billingAddress: "",
      shippingAddress: "",
      contactPerson: "",
      email: "",
      phone: "",
      country: "",
    },
    lines,
  };
}

function orderAcknowledgementLocked(oa) {
  if (!oa) return true;
  const st = String(oa.status || "").toUpperCase();
  if (["APPROVED", "CONVERTED", "CLOSED", "CANCELLED"].includes(st)) return true;
  const conv = Array.isArray(oa.convertedTo) ? oa.convertedTo.map(String) : [];
  return conv.includes("PROFORMA") || conv.includes("SALES_INVOICE");
}

/** Shown badge when OA was converted to PI/SI even if legacy records never updated status to APPROVED. */
function orderAcknowledgementDisplayStatus(oa) {
  if (!oa) return "";
  const st = String(oa.status || "").toUpperCase();
  if (st === "CANCELLED" || st === "CLOSED" || st === "CONVERTED") return st;
  const conv = Array.isArray(oa.convertedTo) ? oa.convertedTo.map(String) : [];
  if (conv.includes("PROFORMA") || conv.includes("SALES_INVOICE")) return "APPROVED";
  return String(oa.status || "");
}

function oaDetailToEditableForm(oa) {
  if (!oa) return null;
  const linesSrc = Array.isArray(oa.lines) && oa.lines.length ? oa.lines : [];
  const lines =
    linesSrc.length > 0
      ? linesSrc.map((l, idx) => {
          const qty = Number(l.qty) || 0;
          const price = Number(l.price) || 0;
          const totalPrice = Number(l.totalPrice) || qty * price;
          return {
            serialNo: l.serialNo ?? idx + 1,
            article: l.article || "",
            partNumber: l.partNumber || "",
            description: l.description || "",
            qty,
            uom: l.uom || "PCS",
            price,
            totalPrice,
            remarks: l.remarks || "",
            materialCode: l.materialCode || "",
            availability: l.availability || "",
          };
        })
      : [emptyLine()];
  const pod =
    oa.customerPODate != null && oa.customerPODate !== ""
      ? new Date(oa.customerPODate).toISOString().slice(0, 10)
      : "";
  const oad = oa.oaDate ? new Date(oa.oaDate).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10);
  return {
    customerName: oa.customerName || "",
    customerPORef: oa.customerPORef || "",
    customerPODate: pod,
    acknowledgementNotes: oa.acknowledgementNotes || "",
    deliverySchedule: oa.deliverySchedule || "",
    paymentTerms: oa.paymentTerms || "",
    incoterm: oa.incoterm || "",
    dispatchTerms: oa.dispatchTerms || "",
    currency: String(oa.currency || "USD").toUpperCase(),
    oaDate: oad,
    status: oa.status || "DRAFT",
    lines,
  };
}

function money(n) {
  return Number(n || 0).toFixed(2);
}

function statusBadgeClass(status = "") {
  const key = String(status).toUpperCase();
  if (["APPROVED", "PAID", "CLOSED", "CONFIRMED", "CONVERTED", "ISSUED", "SHIPPED"].includes(key)) {
    return "bg-emerald-50 text-emerald-700 ring-emerald-200";
  }
  if (["DRAFT", "SENT", "PARTIALLY_PAID", "PAID_PENDING_SHIPMENT"].includes(key)) {
    return "bg-amber-50 text-amber-700 ring-amber-200";
  }
  if (["CANCELLED", "REJECTED", "EXPIRED"].includes(key)) {
    return "bg-rose-50 text-rose-700 ring-rose-200";
  }
  return "bg-slate-100 text-slate-700 ring-slate-200";
}

const reportColumnsById = {
  "quotation-summary": [
    ["Quotation No", (r) => r.quotationNo || ""],
    ["Date", (r) => (r.quotationDate ? new Date(r.quotationDate).toLocaleDateString() : "")],
    ["Customer", (r) => r.customerName || ""],
    ["Customer Ref", (r) => r.customerReference || ""],
    ["Engine", (r) => r.engine || ""],
    ["Model", (r) => r.model || ""],
    ["ESN", (r) => r.esn || ""],
    ["Line Items", (r) => r.lineItems || 0],
    ["Total", (r) => money(r.totalAmount)],
    ["Status", (r) => r.status || ""],
  ],
  "pending-quotation": [
    ["Quotation No", (r) => r.quotationNo || ""],
    ["Date", (r) => (r.quotationDate ? new Date(r.quotationDate).toLocaleDateString() : "")],
    ["Customer", (r) => r.customerName || ""],
    ["Article Count", (r) => r.articleCount || 0],
    ["Total", (r) => money(r.totalAmount)],
    ["Age (Days)", (r) => r.ageDays || 0],
    ["Status", (r) => r.status || ""],
    ["Follow-up Remarks", (r) => r.followUpRemarks || ""],
  ],
  "order-acknowledgement": [
    ["OA No", (r) => r.oaNo || ""],
    ["OA Date", (r) => (r.oaDate ? new Date(r.oaDate).toLocaleDateString() : "")],
    ["Linked Quotation", (r) => r.linkedQuotationNo || ""],
    ["Customer", (r) => r.customerName || ""],
    ["Customer PO Ref", (r) => r.customerPORef || ""],
    ["Delivery Terms", (r) => r.deliveryTerms || ""],
    ["Total", (r) => money(r.totalAmount)],
    ["Status", (r) => r.status || ""],
  ],
  "pending-order-acknowledgement": [
    ["OA No", (r) => r.oaNo || ""],
    ["Customer", (r) => r.customerName || ""],
    ["Quotation Link", (r) => r.linkedQuotationNo || ""],
    ["Amount", (r) => money(r.amount)],
    ["Age (Days)", (r) => r.ageDays || 0],
    ["Status", (r) => r.status || ""],
  ],
  proforma: [
    ["Proforma No", (r) => r.proformaNo || ""],
    ["Date", (r) => (r.proformaDate ? new Date(r.proformaDate).toLocaleDateString() : "")],
    ["Linked Quotation/OA", (r) => r.linkedOANo || r.linkedQuotationNo || ""],
    ["Customer", (r) => r.customerName || ""],
    ["Amount", (r) => money(r.amount)],
    ["Status", (r) => r.status || ""],
    ["Validity", (r) => r.validity || ""],
    ["Payment Terms", (r) => r.paymentTerms || ""],
  ],
  "sales-invoice-summary": [
    ["Invoice No", (r) => r.invoiceNo || ""],
    ["Date", (r) => (r.invoiceDate ? new Date(r.invoiceDate).toLocaleDateString() : "")],
    ["Customer", (r) => r.customerName || ""],
    ["Linked Proforma", (r) => r.linkedProformaNo || ""],
    ["Linked OA", (r) => r.linkedOANo || ""],
    ["Currency", (r) => r.currency || "USD"],
    ["Invoice Value", (r) => money(r.invoiceValue)],
    ["Paid Amount", (r) => money(r.paidAmount)],
    ["Balance Amount", (r) => money(r.balanceAmount)],
    ["Payment Status", (r) => r.paymentStatus || ""],
  ],
  "sales-invoice-article-wise": [
    ["Article", (r) => r.article || ""],
    ["Description", (r) => r.description || ""],
    ["Total Qty Sold", (r) => r.totalQtySold || 0],
    ["Total Sales Value", (r) => money(r.totalSalesValue)],
    ["No. of Invoices", (r) => r.invoiceCount || 0],
    ["Customers Count", (r) => r.customersCount || 0],
    ["Avg Selling Price", (r) => money(r.avgSellingPrice)],
  ],
  "sales-branch-wise": [
    ["Branch", (r) => r.branch || "UNSPECIFIED"],
    ["No. of Invoices", (r) => r.noOfInvoices || 0],
    ["No. of Customers", (r) => r.noOfCustomers || 0],
    ["Total Qty Sold", (r) => r.totalQtySold || 0],
    ["Total Sales Value", (r) => money(r.totalSalesValue)],
    ["Paid Amount", (r) => money(r.paidAmount)],
    ["Unpaid Amount", (r) => money(r.unpaidAmount)],
  ],
  cipl: [
    ["CIPL No", (r) => r.ciplNo || ""],
    ["Date", (r) => (r.date ? new Date(r.date).toLocaleDateString() : "")],
    ["Customer/Consignee", (r) => r.customerOrConsignee || ""],
    ["Linked Ref", (r) => r.linkedReference || ""],
    ["Destination", (r) => r.destination || ""],
    ["Port of Loading", (r) => r.portOfLoading || ""],
    ["Port of Discharge", (r) => r.portOfDischarge || ""],
    ["Package Count", (r) => r.packageCount || 0],
    ["Net Weight", (r) => money(r.netWeight)],
    ["Gross Weight", (r) => money(r.grossWeight)],
    ["Value", (r) => money(r.value)],
    ["Status", (r) => r.status || ""],
  ],
};

function escapeCsvValue(value) {
  const raw = String(value ?? "");
  const escaped = raw.replace(/"/g, '""');
  return /[",\n]/.test(escaped) ? `"${escaped}"` : escaped;
}

function renderPrintWindow(data, autoPrint = false) {
  const q = data?.quotation || {};
  const company = q.companySnapshot || {};
  const customer = q.customer || {};
  const rows = q.lines || [];
  const hasCompanyLogo = String(company.logo || "").trim().length > 0;
  const companyName = String(company.companyName || "").toLowerCase();
  const isMarivolt = companyName.includes("marivolt");
  const marivoltPrintLogo = "/brand/marivolt-icon.png";
  const html = `
    <html>
      <head>
        <title>${q.quotationNo || "Quotation"}</title>
        <style>
${SALES_QUOTATION_STYLE_PRINT_CSS}
        </style>
      </head>
      <body class="${isMarivolt ? "has-quote-terms" : ""}">
        <div class="header">
          <div class="header-left">
            ${
              isMarivolt
                ? `<img src="${marivoltPrintLogo}" alt="Marivolt icon" class="logo" />`
                : hasCompanyLogo
                ? `<img src="${company.logo}" alt="${company.companyName || "Company"} logo" class="logo" />`
                : `<div class="brand-fallback">MV</div>`
            }
          </div>
          <div class="header-center">
            <div class="title">Quotation</div>
            <div class="muted">
              <div><b>No:</b> ${q.quotationNo || "-"}</div>
              <div><b>Date:</b> ${q.quotationDate ? new Date(q.quotationDate).toLocaleDateString() : "-"}</div>
              <div><b>Validity:</b> ${q.validityDate ? new Date(q.validityDate).toLocaleDateString() : "-"}</div>
            </div>
          </div>
          ${
            isMarivolt
              ? `<div class="header-right is-marivolt">
                <h1 class="brand-title">MariVolt</h1>
                <div class="brand-subtitle">Marine Engine Spares</div>
                <div class="muted" style="margin-top:8px;">
                  <div>${company.address || "LV09B, Hamriyah freezone phase 2, Sharjah, UAE"}</div>
                  <div>${company.email || "sales@marivolt.co"}</div>
                  <div>${company.phone || "+971-543053047"}</div>
                </div>
              </div>`
              : `<div class="header-right muted">
                <div><b>${company.companyName || ""}</b></div>
                <div>${company.address || ""}</div>
                <div>${company.email || ""}</div>
                <div>${company.phone || ""}</div>
              </div>`
          }
        </div>
        <div class="info-grid">
          <div class="info-box muted">
            <div class="info-box-title">Customer &amp; Address Info</div>
            <div><b>Customer:</b> ${q.customerName || "-"}</div>
            <div><b>Customer Ref:</b> ${q.customerReference || "-"}</div>
            <div><b>Attention:</b> ${q.attention || "-"}</div>
            <div><b>Billing:</b> ${customer.billingAddress || "-"}</div>
            <div><b>Shipping:</b> ${customer.shippingAddress || "-"}</div>
          </div>
          <div class="info-box muted">
            <div class="info-box-title">Engine Details</div>
            <div><b>Engine:</b> ${q.engine || "-"}</div>
            <div><b>Model:</b> ${q.model || "-"}</div>
            <div><b>Config:</b> ${q.config || "-"}</div>
            <div><b>ESN:</b> ${q.esn || "-"}</div>
            <div><b>Currency:</b> ${q.currency || "-"}</div>
          </div>
        </div>
        <table>
          <thead>
            <tr>
              <th>Serial number</th><th>Part number</th><th>Description</th><th>UOM</th><th class="right">QTY</th><th class="right">Price</th><th class="right">Total price</th><th class="remarks-col">Remarks</th><th>Availability</th>
            </tr>
          </thead>
          <tbody>
            ${rows
              .map(
                (line) => `
              <tr>
                <td>${line.serialNo || ""}</td>
                <td>${line.partNumber || ""}</td>
                <td>${line.description || ""}</td>
                <td>${line.uom || ""}</td>
                <td class="right">${line.qty || 0}</td>
                <td class="right">${money(line.price)}</td>
                <td class="right">${money(line.totalPrice)}</td>
                <td class="remarks-col">${line.remarks || ""}</td>
                <td>${line.availability || ""}</td>
              </tr>`
              )
              .join("")}
          </tbody>
        </table>
        <div class="totals">
          <div><span>Subtotal</span><span>${money(q.subTotal)}</span></div>
          <div><span>Discount</span><span>${money(q.discountTotal)}</span></div>
          <div><span>Tax</span><span>${money(q.taxTotal)}</span></div>
          <div><b>Grand Total</b><b>${money(q.grandTotal)} ${q.currency || ""}</b></div>
        </div>
        ${
          isMarivolt
            ? `<div class="quote-terms">Only Marivolt terms and condition applicable, check here-<a href="https://marivolt.co/about-us">https://marivolt.co/about-us</a></div>`
            : ""
        }
        <div class="footer">
          <div class="doc-note">This is a computer generated documents and does not required signature or stamp.</div>
        </div>
        ${
          isMarivolt
            ? `<div class="page-footer">
          <div class="page-footer-top">
            <div>
              <div>Marivolt FZE</div>
              <div>LV09B</div>
            </div>
            <div class="page-footer-center">Hamriyah freezone phase 2, Sharjah, UAE</div>
            <div class="page-footer-right">
              <div>Mob: +971-543053047</div>
              <div>Email: sales@marivolt.co</div>
              <div>Web: www.marivolt.co</div>
            </div>
          </div>
          <div class="page-footer-line"></div>
        </div>`
            : ""
        }
      </body>
    </html>
  `;
  const w = window.open("", "_blank", "width=1200,height=900");
  if (!w) return;
  w.document.write(html);
  w.document.close();
  w.focus();
  if (autoPrint) {
    setTimeout(() => w.print(), 300);
  }
}

function renderOrderAcknowledgementPrintWindow(payload, autoPrint = false) {
  const oa = payload?.orderAcknowledgement || {};
  const company = payload?.company || {};
  const rows = oa.lines || [];
  const hasCompanyLogo = String(company.logo || "").trim().length > 0;
  const companyName = String(company.companyName || "").toLowerCase();
  const isMarivolt = companyName.includes("marivolt");
  const marivoltPrintLogo = "/brand/marivolt-icon.png";
  const fmtDate = (d) => (d ? new Date(d).toLocaleDateString() : "-");

  const html = `
    <html>
      <head>
        <title>${oa.oaNo || "Order Acknowledgement"}</title>
        <style>
${SALES_QUOTATION_STYLE_PRINT_CSS}
        </style>
      </head>
      <body class="${isMarivolt ? "has-quote-terms" : ""}">
        <div class="header">
          <div class="header-left">
            ${
              isMarivolt
                ? `<img src="${marivoltPrintLogo}" alt="Marivolt icon" class="logo" />`
                : hasCompanyLogo
                ? `<img src="${company.logo}" alt="${company.companyName || "Company"} logo" class="logo" />`
                : `<div class="brand-fallback">MV</div>`
            }
          </div>
          <div class="header-center">
            <div class="title">Order Acknowledgement</div>
            <div class="muted">
              <div><b>No:</b> ${oa.oaNo || "-"}</div>
              <div><b>Date:</b> ${fmtDate(oa.oaDate)}</div>
              <div><b>Linked Quotation:</b> ${oa.linkedQuotationNo || "-"}</div>
            </div>
          </div>
          ${
            isMarivolt
              ? `<div class="header-right is-marivolt">
                <h1 class="brand-title">MariVolt</h1>
                <div class="brand-subtitle">Marine Engine Spares</div>
                <div class="muted" style="margin-top:8px;">
                  <div>${company.address || "LV09B, Hamriyah freezone phase 2, Sharjah, UAE"}</div>
                  <div>${company.email || "sales@marivolt.co"}</div>
                  <div>${company.phone || "+971-543053047"}</div>
                </div>
              </div>`
              : `<div class="header-right muted">
                <div><b>${company.companyName || ""}</b></div>
                <div>${company.address || ""}</div>
                <div>${company.email || ""}</div>
                <div>${company.phone || ""}</div>
              </div>`
          }
        </div>
        <div class="info-grid">
          <div class="info-box muted">
            <div class="info-box-title">Customer &amp; Address Info</div>
            <div><b>Customer:</b> ${oa.customerName || "-"}</div>
            <div><b>Customer Ref:</b> ${oa.customerPORef || "-"}</div>
            <div><b>Attention:</b> -</div>
            <div><b>Billing:</b> -</div>
            <div><b>Shipping:</b> -</div>
          </div>
          <div class="info-box muted">
            <div class="info-box-title">Engine Details</div>
            <div><b>Engine:</b> -</div>
            <div><b>Model:</b> -</div>
            <div><b>Config:</b> -</div>
            <div><b>ESN:</b> -</div>
            <div><b>Currency:</b> ${oa.currency || "-"}</div>
          </div>
        </div>
        <table>
          <thead>
            <tr>
              <th>Serial number</th><th>Part number</th><th>Description</th><th>UOM</th><th class="right">QTY</th><th class="right">Price</th><th class="right">Total price</th><th class="remarks-col">Remarks</th><th>Availability</th>
            </tr>
          </thead>
          <tbody>
            ${rows
              .map(
                (line) => `
              <tr>
                <td>${line.serialNo ?? ""}</td>
                <td>${line.partNumber || ""}</td>
                <td>${line.description || ""}</td>
                <td>${line.uom || ""}</td>
                <td class="right">${line.qty || 0}</td>
                <td class="right">${money(line.price)}</td>
                <td class="right">${money(line.totalPrice)}</td>
                <td class="remarks-col">${line.remarks || ""}</td>
                <td>${line.availability || ""}</td>
              </tr>`
              )
              .join("")}
          </tbody>
        </table>
        <div class="totals">
          <div><span>Subtotal</span><span>${money(oa.subTotal)}</span></div>
          <div><span>Discount</span><span>${money(oa.discountTotal)}</span></div>
          <div><span>Tax</span><span>${money(oa.taxTotal)}</span></div>
          <div><b>Grand Total</b><b>${money(oa.grandTotal)} ${oa.currency || ""}</b></div>
        </div>
        ${
          isMarivolt
            ? `<div class="quote-terms">Only Marivolt terms and condition applicable, check here-<a href="https://marivolt.co/about-us">https://marivolt.co/about-us</a></div>`
            : ""
        }
        <div class="footer">
          <div class="doc-note">This is a computer generated documents and does not required signature or stamp.</div>
        </div>
        ${
          isMarivolt
            ? `<div class="page-footer">
          <div class="page-footer-top">
            <div>
              <div>Marivolt FZE</div>
              <div>LV09B</div>
            </div>
            <div class="page-footer-center">Hamriyah freezone phase 2, Sharjah, UAE</div>
            <div class="page-footer-right">
              <div>Mob: +971-543053047</div>
              <div>Email: sales@marivolt.co</div>
              <div>Web: www.marivolt.co</div>
            </div>
          </div>
          <div class="page-footer-line"></div>
        </div>`
            : ""
        }
      </body>
    </html>
  `;
  const w = window.open("", "_blank", "width=1200,height=900");
  if (!w) return;
  w.document.write(html);
  w.document.close();
  w.focus();
  if (autoPrint) setTimeout(() => w.print(), 300);
}

function renderFlowDocPrintWindow({
  title,
  doc,
  company,
  docNoLabel,
  docNoValue,
  dateLabel,
  dateValue,
  linkedLabel = "",
  linkedValue = "",
  autoPrint = false,
}) {
  const rows = doc?.lines || [];
  const hasCompanyLogo = String(company?.logo || company?.logoUrl || "").trim().length > 0;
  const companyName = String(company?.name || company?.companyName || "").toLowerCase();
  const isMarivolt = companyName.includes("marivolt");
  const marivoltPrintLogo = "/brand/marivolt-icon.png";
  const html = `
    <html>
      <head>
        <title>${docNoValue || title}</title>
        <style>
${SALES_QUOTATION_STYLE_PRINT_CSS}
        </style>
      </head>
      <body class="${isMarivolt ? "has-quote-terms" : ""}">
        <div class="header">
          <div class="header-left">
            ${
              isMarivolt
                ? `<img src="${marivoltPrintLogo}" alt="Marivolt icon" class="logo" />`
                : hasCompanyLogo
                ? `<img src="${company?.logo || company?.logoUrl}" alt="${company?.name || company?.companyName || "Company"} logo" class="logo" />`
                : `<div class="brand-fallback">MV</div>`
            }
          </div>
          <div class="header-center">
            <div class="title">${title}</div>
            <div class="muted">
              <div><b>${docNoLabel}:</b> ${docNoValue || "-"}</div>
              <div><b>${dateLabel}:</b> ${dateValue ? new Date(dateValue).toLocaleDateString() : "-"}</div>
              ${linkedLabel ? `<div><b>${linkedLabel}:</b> ${linkedValue || "-"}</div>` : ""}
              <div><b>Customer:</b> ${doc?.customerName || "-"}</div>
            </div>
          </div>
          ${
            isMarivolt
              ? `<div class="header-right is-marivolt">
                <h1 class="brand-title">MariVolt</h1>
                <div class="brand-subtitle">Marine Engine Spares</div>
                <div class="muted" style="margin-top:8px;">
                  <div>${company?.address || "LV09B, Hamriyah freezone phase 2, Sharjah, UAE"}</div>
                  <div>${company?.email || "sales@marivolt.co"}</div>
                  <div>${company?.phone || "+971-543053047"}</div>
                </div>
              </div>`
              : `<div class="header-right muted">
                <div><b>${company?.name || company?.companyName || ""}</b></div>
                <div>${company?.address || ""}</div>
                <div>${company?.email || ""}</div>
                <div>${company?.phone || ""}</div>
              </div>`
          }
        </div>
        <div class="info-grid">
          <div class="info-box muted">
            <div class="info-box-title">Customer &amp; Address Info</div>
            <div><b>Customer:</b> ${doc?.customerName || "-"}</div>
            <div><b>Reference:</b> ${linkedValue || "-"}</div>
            <div><b>Attention:</b> -</div>
            <div><b>Billing:</b> ${doc?.billingAddress || "-"}</div>
            <div><b>Shipping:</b> ${doc?.shippingAddress || "-"}</div>
          </div>
          <div class="info-box muted">
            <div class="info-box-title">Dispatch &amp; Terms</div>
            <div><b>Dispatch:</b> ${doc?.dispatchDetails || "-"}</div>
            <div><b>Payment Terms:</b> ${doc?.paymentTerms || "-"}</div>
            <div><b>Status:</b> ${doc?.status || "-"}</div>
            <div><b>Currency:</b> ${doc?.currency || "-"}</div>
            <div><b>Remarks:</b> ${doc?.remarks || "-"}</div>
          </div>
        </div>
        <table>
          <thead>
            <tr>
              <th>Serial number</th><th>Part number</th><th>Description</th><th>UOM</th><th class="right">QTY</th><th class="right">Price</th><th class="right">Total price</th><th class="remarks-col">Remarks</th><th>Availability</th>
            </tr>
          </thead>
          <tbody>
            ${rows
              .map(
                (line) => `
              <tr>
                <td>${line.serialNo ?? ""}</td>
                <td>${line.partNumber || ""}</td>
                <td>${line.description || ""}</td>
                <td>${line.uom || ""}</td>
                <td class="right">${line.qty || 0}</td>
                <td class="right">${money(line.price)}</td>
                <td class="right">${money(line.totalPrice)}</td>
                <td class="remarks-col">${line.remarks || ""}</td>
                <td>${line.availability || ""}</td>
              </tr>`
              )
              .join("")}
          </tbody>
        </table>
        <div class="totals">
          <div><span>Subtotal</span><span>${money(doc?.subTotal)}</span></div>
          <div><span>Discount</span><span>${money(doc?.discountTotal)}</span></div>
          <div><span>Tax</span><span>${money(doc?.taxTotal)}</span></div>
          <div><b>Grand Total</b><b>${money(doc?.grandTotal)} ${doc?.currency || ""}</b></div>
        </div>
        ${
          isMarivolt
            ? `<div class="quote-terms">Only Marivolt terms and condition applicable, check here-<a href="https://marivolt.co/about-us">https://marivolt.co/about-us</a></div>`
            : ""
        }
        <div class="footer">
          <div class="doc-note">This is a computer generated documents and does not required signature or stamp.</div>
        </div>
        ${
          isMarivolt
            ? `<div class="page-footer">
          <div class="page-footer-top">
            <div>
              <div>Marivolt FZE</div>
              <div>LV09B</div>
            </div>
            <div class="page-footer-center">Hamriyah freezone phase 2, Sharjah, UAE</div>
            <div class="page-footer-right">
              <div>Mob: +971-543053047</div>
              <div>Email: sales@marivolt.co</div>
              <div>Web: www.marivolt.co</div>
            </div>
          </div>
          <div class="page-footer-line"></div>
        </div>`
            : ""
        }
      </body>
    </html>
  `;
  const win = window.open("", "_blank", "width=1200,height=900");
  if (!win) return;
  win.document.write(html);
  win.document.close();
  win.focus();
  if (autoPrint) setTimeout(() => win.print(), 300);
}

export default function Sales() {
  const qc = useQueryClient();
  const { auth } = useAuth();
  const activeCompany = auth?.company;
  const [activeTab, setActiveTab] = useState("Quotation");
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const limit = 20;
  const quotationCsvInputRef = useRef(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [isQuotationNoEdited, setIsQuotationNoEdited] = useState(false);
  const [customerCreateOpen, setCustomerCreateOpen] = useState(false);
  const [detailId, setDetailId] = useState(null);
  const [oaCreateOpen, setOaCreateOpen] = useState(false);
  const [proformaCreateOpen, setProformaCreateOpen] = useState(false);
  const [salesInvoiceCreateOpen, setSalesInvoiceCreateOpen] = useState(false);
  const [ciplCreateOpen, setCiplCreateOpen] = useState(false);
  const [err, setErr] = useState("");
  const [detailQuotationDraftForm, setDetailQuotationDraftForm] = useState(null);
  const [detailOADraftForm, setDetailOADraftForm] = useState(null);
  const [selectedReportId, setSelectedReportId] = useState("");
  const [reportPage, setReportPage] = useState(1);
  const [reportFilters, setReportFilters] = useState({
    search: "",
    dateFrom: "",
    dateTo: "",
    customer: "",
    status: "",
  });

  const [form, setForm] = useState({
    quotationNo: "",
    quotationDate: new Date().toISOString().slice(0, 10),
    validityDate: "",
    customerId: "",
    customerName: "",
    customerReference: "",
    attention: "",
    engine: "",
    model: "",
    config: "",
    esn: "",
    paymentTerms: "",
    deliveryTerms: "",
    incoterm: "",
    currency: "USD",
    exchangeRate: 1,
    portOfLoading: "",
    portOfDischarge: "",
    finalDestination: "",
    remarks: "",
    internalNotes: "",
    customer: {
      billingAddress: "",
      shippingAddress: "",
      contactPerson: "",
      email: "",
      phone: "",
      country: "",
    },
    lines: [emptyLine()],
  });

  const { data, isLoading, error } = useQuery({
    queryKey: ["sales-quotations", page, search, status],
    queryFn: () =>
      apiGetWithQuery("/quotations", {
        page,
        limit,
        search: search || undefined,
        status: status || undefined,
      }),
  });

  const { data: detail } = useQuery({
    queryKey: ["quotation-detail", detailId],
    queryFn: () => apiGet(`/quotations/${detailId}`),
    enabled: !!detailId,
  });

  const { data: customerData, isLoading: customerLoading } = useQuery({
    queryKey: ["sales-customers", page, search],
    queryFn: () =>
      apiGetWithQuery("/sales/customers", {
        page,
        limit,
        search: search || undefined,
      }),
    enabled: activeTab === "Customer Master" || activeTab === "Quotation",
  });

  const { data: customerLookupData } = useQuery({
    queryKey: ["sales-customers-lookup"],
    queryFn: () =>
      apiGetWithQuery("/sales/customers", {
        page: 1,
        limit: 500,
      }),
    enabled: activeTab === "Quotation" || createOpen,
  });

  const { data: oaData, isLoading: oaLoading } = useQuery({
    queryKey: ["sales-oa", page, search],
    queryFn: () =>
      apiGetWithQuery("/sales/order-acknowledgements", {
        page,
        limit,
        search: search || undefined,
      }),
    enabled: activeTab === "Order Acknowledgement",
  });

  const { data: proformaData, isLoading: proformaLoading } = useQuery({
    queryKey: ["sales-proforma", page, search],
    queryFn: () =>
      apiGetWithQuery("/sales/proforma-invoices", {
        page,
        limit,
        search: search || undefined,
      }),
    enabled: activeTab === "Proforma Invoice",
  });

  const { data: salesInvoiceData, isLoading: salesInvoiceLoading } = useQuery({
    queryKey: ["sales-sales-invoices", page, search],
    queryFn: () =>
      apiGetWithQuery("/sales/sales-invoices", {
        page,
        limit,
        search: search || undefined,
      }),
    enabled: activeTab === "Sales Invoice",
  });

  const { data: ciplData, isLoading: ciplLoading } = useQuery({
    queryKey: ["sales-cipl", page, search],
    queryFn: () =>
      apiGetWithQuery("/sales/cipls", {
        page,
        limit,
        search: search || undefined,
      }),
    enabled: activeTab === "CIPL",
  });

  const { data: salesSummary, isLoading: summaryLoading } = useQuery({
    queryKey: ["sales-summary", activeCompany?._id],
    queryFn: () => apiGet("/sales/summary"),
    enabled: !!activeCompany?._id,
  });

  const activeReportId = selectedReportId || "quotation-summary";
  const reportTitleById = reportsCatalog.flatMap((section) => section.items).reduce((acc, item) => {
    acc[item.id] = item.title;
    return acc;
  }, {});
  const reportEndpointById = {
    "quotation-summary": "/sales/reports/quotation-summary",
    "pending-quotation": "/sales/reports/pending-quotation",
    "order-acknowledgement": "/sales/reports/order-acknowledgement",
    "pending-order-acknowledgement": "/sales/reports/pending-order-acknowledgement",
    proforma: "/sales/reports/proforma",
    "sales-invoice-summary": "/sales/reports/sales-invoice-summary",
    "sales-invoice-article-wise": "/sales/reports/sales-invoice-article-wise",
    "sales-branch-wise": "/sales/reports/sales-branch-wise",
    cipl: "/sales/reports/cipl",
  };
  const reportApiPath = reportEndpointById[activeReportId] || null;
  const activeReportTitle = reportTitleById[activeReportId] || "Selected Report";

  const { data: activeReportData, isLoading: reportLoading } = useQuery({
    queryKey: ["sales-report", activeCompany?._id, activeReportId, reportPage, reportFilters],
    queryFn: () =>
      apiGetWithQuery(reportApiPath, {
        page: reportPage,
        limit: 20,
        search: reportFilters.search || undefined,
        dateFrom: reportFilters.dateFrom || undefined,
        dateTo: reportFilters.dateTo || undefined,
        customer: reportFilters.customer || undefined,
        status: reportFilters.status || undefined,
      }),
    enabled: activeTab === "Reports" && !!reportApiPath && !!activeCompany?._id,
  });
  const activeReportRows = activeReportData?.rows || [];
  const activeExportColumns = reportColumnsById[activeReportId] || [];

  function downloadBlobFile(filename, blob, type) {
    const url = URL.createObjectURL(new Blob([blob], { type }));
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  function exportActiveReportCsv() {
    if (!activeExportColumns.length || !activeReportRows.length) return;
    const header = activeExportColumns.map(([label]) => escapeCsvValue(label)).join(",");
    const lines = activeReportRows.map((row) => activeExportColumns.map(([, getter]) => escapeCsvValue(getter(row))).join(","));
    const csv = [header, ...lines].join("\n");
    downloadBlobFile(`${activeReportId}-${new Date().toISOString().slice(0, 10)}.csv`, `\ufeff${csv}`, "text/csv;charset=utf-8;");
  }

  function exportActiveReportExcel() {
    if (!activeExportColumns.length || !activeReportRows.length) return;
    const headers = activeExportColumns.map(([label]) => `<th>${label}</th>`).join("");
    const rows = activeReportRows
      .map((row) => `<tr>${activeExportColumns.map(([, getter]) => `<td>${String(getter(row) ?? "")}</td>`).join("")}</tr>`)
      .join("");
    const html = `<table><thead><tr>${headers}</tr></thead><tbody>${rows}</tbody></table>`;
    downloadBlobFile(`${activeReportId}-${new Date().toISOString().slice(0, 10)}.xls`, html, "application/vnd.ms-excel");
  }

  function openReportPrintWindow(autoPrint = false) {
    if (!activeExportColumns.length || !activeReportRows.length) return;
    const headers = activeExportColumns.map(([label]) => `<th>${label}</th>`).join("");
    const rows = activeReportRows
      .map((row) => `<tr>${activeExportColumns.map(([, getter]) => `<td>${String(getter(row) ?? "")}</td>`).join("")}</tr>`)
      .join("");
    const html = `
      <html>
        <head>
          <title>${activeReportTitle}</title>
          <style>
            body { font-family: Arial, sans-serif; margin: 24px; color: #111; }
            h1 { margin: 0 0 8px; font-size: 20px; }
            .meta { margin-bottom: 14px; color: #444; font-size: 12px; }
            table { width: 100%; border-collapse: collapse; }
            th, td { border: 1px solid #ddd; padding: 7px; font-size: 12px; text-align: left; }
            th { background: #f3f4f6; }
          </style>
        </head>
        <body>
          <h1>${activeReportTitle}</h1>
          <div class="meta">Company: ${activeCompany?.name || activeCompany?.code || "-"} | Generated: ${new Date().toLocaleString()}</div>
          <table>
            <thead><tr>${headers}</tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </body>
      </html>
    `;
    const win = window.open("", "_blank", "width=1200,height=900");
    if (!win) return;
    win.document.write(html);
    win.document.close();
    win.focus();
    if (autoPrint) {
      setTimeout(() => {
        win.print();
      }, 300);
    }
  }

  function exportListCsv(filename, rows, columns) {
    if (!rows?.length) return;
    const header = columns.map((c) => escapeCsvValue(c.label)).join(",");
    const body = rows.map((row) => columns.map((c) => escapeCsvValue(c.value(row))).join(","));
    const csv = [header, ...body].join("\n");
    downloadBlobFile(`${filename}-${new Date().toISOString().slice(0, 10)}.csv`, `\ufeff${csv}`, "text/csv;charset=utf-8;");
  }

  async function openFlowDocumentPrint(type, id, autoPrint = false) {
    try {
      const company = activeCompany || {};
      if (type === "oa") {
        const payload = await apiGet(`/sales/order-acknowledgements/${id}/print`);
        renderOrderAcknowledgementPrintWindow(
          {
            orderAcknowledgement: payload?.orderAcknowledgement,
            company: payload?.company || company,
          },
          autoPrint
        );
        return;
      }
      if (type === "proforma") {
        const doc = await apiGet(`/sales/proforma-invoices/${id}`);
        renderFlowDocPrintWindow({
          title: "Proforma Invoice",
          doc,
          company,
          docNoLabel: "Proforma No",
          docNoValue: doc?.proformaNo,
          dateLabel: "Date",
          dateValue: doc?.proformaDate,
          linkedLabel: "Linked OA",
          linkedValue: doc?.linkedOANo || doc?.linkedQuotationNo,
          autoPrint,
        });
        return;
      }
      if (type === "sales-invoice") {
        const doc = await apiGet(`/sales/sales-invoices/${id}`);
        renderFlowDocPrintWindow({
          title: "Sales Invoice",
          doc,
          company,
          docNoLabel: "Invoice No",
          docNoValue: doc?.invoiceNo,
          dateLabel: "Date",
          dateValue: doc?.invoiceDate,
          linkedLabel: "Linked Proforma",
          linkedValue: doc?.linkedProformaNo || doc?.linkedOANo,
          autoPrint,
        });
        return;
      }
      if (type === "cipl") {
        const doc = await apiGet(`/sales/cipls/${id}`);
        renderFlowDocPrintWindow({
          title: "CIPL",
          doc,
          company,
          docNoLabel: "CIPL No",
          docNoValue: doc?.ciplNo,
          dateLabel: "Date",
          dateValue: doc?.ciplDate,
          linkedLabel: "Linked Reference",
          linkedValue: doc?.linkedSalesInvoiceNo || doc?.linkedQuotationNo || doc?.linkedOANo,
          autoPrint,
        });
      }
    } catch (e) {
      setErr(e.message);
    }
  }

  const { data: oaDetail } = useQuery({
    queryKey: ["oa-detail", detailId],
    queryFn: () => apiGet(`/sales/order-acknowledgements/${detailId}`),
    enabled: !!detailId && activeTab === "Order Acknowledgement",
  });

  const { data: proformaDetail } = useQuery({
    queryKey: ["proforma-detail", detailId],
    queryFn: () => apiGet(`/sales/proforma-invoices/${detailId}`),
    enabled: !!detailId && activeTab === "Proforma Invoice",
  });

  const { data: salesInvoiceDetail } = useQuery({
    queryKey: ["sales-invoice-detail", detailId],
    queryFn: () => apiGet(`/sales/sales-invoices/${detailId}`),
    enabled: !!detailId && activeTab === "Sales Invoice",
  });

  const { data: ciplDetail } = useQuery({
    queryKey: ["cipl-detail", detailId],
    queryFn: () => apiGet(`/sales/cipls/${detailId}`),
    enabled: !!detailId && activeTab === "CIPL",
  });

  const createMutation = useMutation({
    mutationFn: () => apiPost("/quotations", form),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["sales-quotations"] });
      setCreateOpen(false);
      setIsQuotationNoEdited(false);
      setForm({
        quotationNo: "",
        quotationDate: new Date().toISOString().slice(0, 10),
        validityDate: "",
        customerId: "",
        customerName: "",
        customerReference: "",
        attention: "",
        engine: "",
        model: "",
        config: "",
        esn: "",
        paymentTerms: "",
        deliveryTerms: "",
        incoterm: "",
        currency: "USD",
        exchangeRate: 1,
        portOfLoading: "",
        portOfDischarge: "",
        finalDestination: "",
        remarks: "",
        internalNotes: "",
        customer: {
          billingAddress: "",
          shippingAddress: "",
          contactPerson: "",
          email: "",
          phone: "",
          country: "",
        },
        lines: [emptyLine()],
      });
    },
    onError: (e) => setErr(e.message),
  });

  function downloadQuotationLinesCsvTemplate() {
    const url = URL.createObjectURL(
      new Blob([`${QUOTATION_LINES_CSV_TEMPLATE}\n`], { type: "text/csv;charset=utf-8" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = "quotation-lines-template.csv";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function handleQuotationLinesCsvSelected(e) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    Papa.parse(file, {
      header: true,
      skipEmptyLines: "greedy",
      dynamicTyping: false,
      complete: (results) => {
        const imported = quotationLinesFromCsvRows(results.data || []);
        if (!imported.length) {
          setErr(
            "No valid CSV rows. Each row needs Article (or Item/SKU), Description, and a positive QTY. Optional: Part number, UOM, Price, Remarks, Material code, Availability.",
          );
          return;
        }
        setErr("");
        setForm((f) => {
          const prev = f.lines || [];
          const hasRealLine = prev.some(
            (l) => String(l.article || "").trim() !== "" || String(l.description || "").trim() !== "",
          );
          const base = hasRealLine ? prev : [];
          const merged = [...base, ...imported].map((line, i) => ({ ...line, serialNo: i + 1 }));
          return { ...f, lines: merged.length ? merged : [emptyLine()] };
        });
      },
      error: (parseErr) => setErr(parseErr.message || "Could not read CSV file"),
    });
  }

  const statusMutation = useMutation({
    mutationFn: ({ id, nextStatus }) => apiPatch(`/quotations/${id}/status`, { status: nextStatus }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["sales-quotations"] });
      if (detailId) qc.invalidateQueries({ queryKey: ["quotation-detail", detailId] });
    },
    onError: (e) => setErr(e.message),
  });

  const duplicateMutation = useMutation({
    mutationFn: (id) => apiPost(`/quotations/${id}/duplicate`, {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["sales-quotations"] });
    },
    onError: (e) => setErr(e.message),
  });

  const updateQuotationDetailMutation = useMutation({
    mutationFn: () => apiPut(`/quotations/${detailId}`, detailQuotationDraftForm),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["sales-quotations"] });
      if (detailId) qc.invalidateQueries({ queryKey: ["quotation-detail", detailId] });
    },
    onError: (e) => setErr(e.message),
  });

  useEffect(() => {
    if (activeTab !== "Quotation" || !detailId) {
      setDetailQuotationDraftForm(null);
      return;
    }
    if (!detail) {
      setDetailQuotationDraftForm(null);
      return;
    }
    if (detail.status !== "DRAFT") {
      setDetailQuotationDraftForm(null);
      return;
    }
    setDetailQuotationDraftForm(quotationDetailToEditableForm(detail));
  }, [activeTab, detailId, detail]);

  const putOrderAcknowledgementMutation = useMutation({
    mutationFn: ({ body }) => apiPut(`/sales/order-acknowledgements/${detailId}`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["sales-oa"] });
      if (detailId) qc.invalidateQueries({ queryKey: ["oa-detail", detailId] });
    },
    onError: (e) => setErr(e.message),
  });

  useEffect(() => {
    if (activeTab !== "Order Acknowledgement" || !detailId) {
      setDetailOADraftForm(null);
      return;
    }
    if (!oaDetail) {
      setDetailOADraftForm(null);
      return;
    }
    if (orderAcknowledgementLocked(oaDetail)) {
      setDetailOADraftForm(null);
      return;
    }
    setDetailOADraftForm(oaDetailToEditableForm(oaDetail));
  }, [activeTab, detailId, oaDetail]);

  const [customerForm, setCustomerForm] = useState({
    name: "",
    contactName: "",
    phone: "",
    email: "",
    address: "",
    paymentTerms: "CREDIT",
    notes: "",
  });

  const createCustomerMutation = useMutation({
    mutationFn: () => apiPost("/sales/customers", customerForm),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["sales-customers"] });
      qc.invalidateQueries({ queryKey: ["sales-customers-lookup"] });
      setCustomerCreateOpen(false);
      setCustomerForm({
        name: "",
        contactName: "",
        phone: "",
        email: "",
        address: "",
        paymentTerms: "CREDIT",
        notes: "",
      });
    },
    onError: (e) => setErr(e.message),
  });

  const convertToOAMutation = useMutation({
    mutationFn: (id) => apiPost(`/sales/convert/quotation/${id}/to-oa`, {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["sales-oa"] });
      qc.invalidateQueries({ queryKey: ["sales-quotations"] });
    },
    onError: (e) => setErr(e.message),
  });

  const convertToProformaFromQuotationMutation = useMutation({
    mutationFn: (id) => apiPost(`/sales/convert/quotation/${id}/to-proforma`, {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["sales-proforma"] });
      qc.invalidateQueries({ queryKey: ["sales-quotations"] });
    },
    onError: (e) => setErr(e.message),
  });

  const convertToCiplFromQuotationMutation = useMutation({
    mutationFn: (id) => apiPost(`/sales/convert/quotation/${id}/to-cipl`, {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["sales-cipl"] });
      qc.invalidateQueries({ queryKey: ["sales-quotations"] });
    },
    onError: (e) => setErr(e.message),
  });

  const convertToProformaFromOAMutation = useMutation({
    mutationFn: (id) => apiPost(`/sales/convert/oa/${id}/to-proforma`, {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["sales-proforma"] });
      qc.invalidateQueries({ queryKey: ["sales-oa"] });
      if (detailId) qc.invalidateQueries({ queryKey: ["oa-detail", detailId] });
    },
    onError: (e) => setErr(e.message),
  });

  const convertToCiplFromOAMutation = useMutation({
    mutationFn: (id) => apiPost(`/sales/convert/oa/${id}/to-cipl`, {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["sales-cipl"] });
      qc.invalidateQueries({ queryKey: ["sales-oa"] });
      if (detailId) qc.invalidateQueries({ queryKey: ["oa-detail", detailId] });
    },
    onError: (e) => setErr(e.message),
  });

  const convertToSalesInvoiceFromOAMutation = useMutation({
    mutationFn: (id) => apiPost(`/sales/convert/oa/${id}/to-sales-invoice`, {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["sales-sales-invoices"] });
      qc.invalidateQueries({ queryKey: ["sales-oa"] });
      if (detailId) qc.invalidateQueries({ queryKey: ["oa-detail", detailId] });
    },
    onError: (e) => setErr(e.message),
  });

  const convertProformaToSalesInvoiceMutation = useMutation({
    mutationFn: (id) => apiPost(`/sales/convert/proforma/${id}/to-sales-invoice`, {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["sales-sales-invoices"] });
      qc.invalidateQueries({ queryKey: ["sales-proforma"] });
    },
    onError: (e) => setErr(e.message),
  });

  const convertToCiplFromSalesInvoiceMutation = useMutation({
    mutationFn: (id) => apiPost(`/sales/convert/sales-invoice/${id}/to-cipl`, {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["sales-cipl"] });
      qc.invalidateQueries({ queryKey: ["sales-sales-invoices"] });
    },
    onError: (e) => setErr(e.message),
  });

  const [oaForm, setOaForm] = useState({
    oaDate: new Date().toISOString().slice(0, 10),
    customerName: "",
    paymentTerms: "",
    deliverySchedule: "",
    currency: "USD",
    lines: [emptyLine()],
  });

  const [proformaForm, setProformaForm] = useState({
    proformaDate: new Date().toISOString().slice(0, 10),
    customerName: "",
    paymentTerms: "",
    shipmentTerms: "",
    bankDetails: "",
    currency: "USD",
    lines: [emptyLine()],
  });

  const [salesInvoiceForm, setSalesInvoiceForm] = useState({
    invoiceDate: new Date().toISOString().slice(0, 10),
    customerName: "",
    paymentTerms: "",
    dispatchDetails: "",
    currency: "USD",
    lines: [emptyLine()],
  });

  const [ciplForm, setCiplForm] = useState({
    ciplDate: new Date().toISOString().slice(0, 10),
    customerName: "",
    consigneeName: "",
    shipmentMode: "",
    incoterm: "",
    currency: "USD",
    lines: [emptyLine()],
  });

  const { data: nextQuotationNoData } = useQuery({
    queryKey: ["next-quotation-number", form.quotationDate],
    queryFn: () => apiGetWithQuery("/quotations/next-number", { date: form.quotationDate || undefined }),
    enabled: createOpen,
  });

  useEffect(() => {
    if (!createOpen) return;
    if (isQuotationNoEdited) return;
    const nextNo = String(nextQuotationNoData?.quotationNo || "").trim();
    if (!nextNo) return;
    setForm((prev) => {
      if (prev.quotationNo === nextNo) return prev;
      return { ...prev, quotationNo: nextNo };
    });
  }, [createOpen, isQuotationNoEdited, nextQuotationNoData?.quotationNo]);

  const createOAMutation = useMutation({
    mutationFn: () => apiPost("/sales/order-acknowledgements", oaForm),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["sales-oa"] });
      setOaCreateOpen(false);
      setOaForm({
        oaDate: new Date().toISOString().slice(0, 10),
        customerName: "",
        paymentTerms: "",
        deliverySchedule: "",
        currency: "USD",
        lines: [emptyLine()],
      });
    },
    onError: (e) => setErr(e.message),
  });

  const createProformaMutation = useMutation({
    mutationFn: () => apiPost("/sales/proforma-invoices", proformaForm),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["sales-proforma"] });
      setProformaCreateOpen(false);
      setProformaForm({
        proformaDate: new Date().toISOString().slice(0, 10),
        customerName: "",
        paymentTerms: "",
        shipmentTerms: "",
        bankDetails: "",
        currency: "USD",
        lines: [emptyLine()],
      });
    },
    onError: (e) => setErr(e.message),
  });

  const createSalesInvoiceMutation = useMutation({
    mutationFn: () => apiPost("/sales/sales-invoices", salesInvoiceForm),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["sales-sales-invoices"] });
      setSalesInvoiceCreateOpen(false);
      setSalesInvoiceForm({
        invoiceDate: new Date().toISOString().slice(0, 10),
        customerName: "",
        paymentTerms: "",
        dispatchDetails: "",
        currency: "USD",
        lines: [emptyLine()],
      });
    },
    onError: (e) => setErr(e.message),
  });

  const createCiplMutation = useMutation({
    mutationFn: () => apiPost("/sales/cipls", ciplForm),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["sales-cipl"] });
      setCiplCreateOpen(false);
      setCiplForm({
        ciplDate: new Date().toISOString().slice(0, 10),
        customerName: "",
        consigneeName: "",
        shipmentMode: "",
        incoterm: "",
        currency: "USD",
        lines: [emptyLine()],
      });
    },
    onError: (e) => setErr(e.message),
  });

  const rows = data?.items ?? [];
  const total = data?.total ?? 0;
  const oaRows = oaData?.items ?? [];
  const proformaRows = proformaData?.items ?? [];
  const salesInvoiceRows = salesInvoiceData?.items ?? [];
  const ciplRows = ciplData?.items ?? [];
  const customerRows = customerData?.items ?? [];
  const customerOptions = customerLookupData?.items ?? customerRows;
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const oaTotalPages = Math.max(1, Math.ceil((oaData?.total ?? 0) / limit));
  const proformaTotalPages = Math.max(1, Math.ceil((proformaData?.total ?? 0) / limit));
  const salesInvoiceTotalPages = Math.max(1, Math.ceil((salesInvoiceData?.total ?? 0) / limit));
  const ciplTotalPages = Math.max(1, Math.ceil((ciplData?.total ?? 0) / limit));
  const customerTotalPages = Math.max(1, Math.ceil((customerData?.total ?? 0) / limit));

  const tabContent = useMemo(() => {
    if (activeTab === "Customer Master") return "customer-master";
    if (activeTab === "Quotation") return "quotation";
    if (activeTab === "Order Acknowledgement") return "oa";
    if (activeTab === "Proforma Invoice") return "proforma";
    if (activeTab === "Sales Invoice") return "sales-invoice";
    if (activeTab === "CIPL") return "cipl";
    if (activeTab === "Reports") return "reports";
    return "coming";
  }, [activeTab]);

  return (
    <div>
      <PageHeader title="Sales" subtitle="Company-wise sales workflow and reporting.">
        <div className="flex flex-wrap items-center justify-end gap-2">
          <span className="rounded-full bg-sky-50 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-sky-700 ring-1 ring-sky-200">
            {activeCompany?.code || activeCompany?.name || "No company"}
          </span>
          <button
            type="button"
            onClick={() => {
              setErr("");
              if (activeTab === "Customer Master") setCustomerCreateOpen(true);
              else if (activeTab === "Quotation") {
                setIsQuotationNoEdited(false);
                setCreateOpen(true);
              }
              else if (activeTab === "Order Acknowledgement") setOaCreateOpen(true);
              else if (activeTab === "Proforma Invoice") setProformaCreateOpen(true);
              else if (activeTab === "Sales Invoice") setSalesInvoiceCreateOpen(true);
              else if (activeTab === "CIPL") setCiplCreateOpen(true);
            }}
            className="rounded-xl bg-gray-900 px-3 py-2 text-sm font-semibold text-white shadow-sm"
          >
            {activeTab === "Customer Master"
              ? "New customer"
              : activeTab === "Quotation"
              ? "New quotation"
              : activeTab === "Order Acknowledgement"
              ? "New OA"
              : activeTab === "Proforma Invoice"
              ? "New proforma"
              : activeTab === "Sales Invoice"
              ? "New sales invoice"
              : activeTab === "CIPL"
              ? "New CIPL"
              : "Create new"}
          </button>
        </div>
      </PageHeader>

      <div className="mb-4 rounded-2xl border bg-white p-4 shadow-sm">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
          {[
            { label: "Total Quotations", value: salesSummary?.totalQuotations },
            { label: "Pending Quotations", value: salesSummary?.pendingQuotations },
            { label: "Total OA", value: salesSummary?.totalOA },
            { label: "Pending OA", value: salesSummary?.pendingOA },
            { label: "Total Proformas", value: salesSummary?.totalProformas },
            { label: "Sales Invoices", value: salesSummary?.totalSalesInvoices },
            { label: "Unpaid Invoices", value: salesSummary?.unpaidSalesInvoices },
            { label: "Total Sales Value", value: `USD ${money(salesSummary?.totalSalesValue)}` },
            { label: "Total CIPL", value: salesSummary?.totalCipl },
            { label: "This Month Sales", value: `USD ${money(salesSummary?.thisMonthSales)}` },
          ].map((kpi) => (
            <div key={kpi.label} className="rounded-xl border border-gray-200 bg-gradient-to-b from-white to-gray-50 p-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">{kpi.label}</p>
              <p className="mt-2 text-xl font-semibold text-gray-900">{summaryLoading ? "..." : kpi.value ?? 0}</p>
            </div>
          ))}
        </div>
      </div>

      <div className="mb-4 flex flex-wrap gap-2 rounded-2xl border bg-white p-2 shadow-sm">
        {salesTabs.map((tab) => (
          <button
            key={tab}
            type="button"
            onClick={() => setActiveTab(tab)}
            className={`rounded-xl px-3 py-1.5 text-sm font-medium transition ${
              activeTab === tab
                ? "bg-gray-900 text-white shadow-sm"
                : "text-gray-600 hover:bg-gray-100 hover:text-gray-900"
            }`}
          >
            {tab === "Order Acknowledgement" ? "Order Ack." : tab === "Proforma Invoice" ? "Proforma" : tab}
          </button>
        ))}
      </div>

      {(error || err) && (
        <div className="mb-4 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {error?.message || err}
        </div>
      )}

      {tabContent === "reports" ? (
        <div className="space-y-4">
          <div className="rounded-2xl border bg-white p-4 shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h3 className="text-base font-semibold text-gray-900">Sales Reports Center</h3>
                <p className="mt-1 text-sm text-gray-600">
                  Structured, company-wise reports for quotation, confirmation, invoice, and shipment analytics.
                </p>
              </div>
              <span className="rounded-full bg-indigo-50 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-indigo-700 ring-1 ring-indigo-200">
                {activeCompany?.code || activeCompany?.name || "No company"}
              </span>
            </div>
          </div>

          {reportsCatalog.map((section) => (
            <div key={section.key} className="rounded-2xl border bg-white p-4 shadow-sm">
              <div className="mb-3 flex items-center justify-between">
                <h4 className="text-sm font-semibold uppercase tracking-wide text-gray-700">{section.group}</h4>
                <span className="text-xs text-gray-500">{section.items.length} reports</span>
              </div>
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                {section.items.map((report) => (
                  <div key={report.id} className="rounded-xl border border-gray-200 bg-gradient-to-b from-white to-gray-50 p-3">
                    <p className="text-sm font-semibold text-gray-900">{report.title}</p>
                    <p className="mt-1 min-h-10 text-xs text-gray-600">{report.desc}</p>
                    <div className="mt-3 flex items-center justify-between">
                      <button
                        type="button"
                        className="rounded-lg border border-gray-300 bg-white px-2.5 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-100"
                        onClick={() => {
                          setSelectedReportId(report.id);
                          setReportPage(1);
                        }}
                      >
                        Open report
                      </button>
                      <span className="text-[11px] font-medium text-emerald-700">Live</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}

          <div className="rounded-2xl border bg-white p-4 shadow-sm">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <h4 className="text-sm font-semibold uppercase tracking-wide text-gray-700">{activeReportTitle}</h4>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  className="rounded-lg border border-gray-300 bg-white px-2.5 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-100 disabled:opacity-50"
                  onClick={exportActiveReportCsv}
                  disabled={!activeReportRows.length || reportLoading}
                >
                  Export CSV
                </button>
                <button
                  type="button"
                  className="rounded-lg border border-gray-300 bg-white px-2.5 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-100 disabled:opacity-50"
                  onClick={exportActiveReportExcel}
                  disabled={!activeReportRows.length || reportLoading}
                >
                  Export Excel
                </button>
                <button
                  type="button"
                  className="rounded-lg border border-gray-300 bg-white px-2.5 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-100 disabled:opacity-50"
                  onClick={() => openReportPrintWindow(true)}
                  disabled={!activeReportRows.length || reportLoading}
                >
                  Export PDF
                </button>
                <button
                  type="button"
                  className="rounded-lg bg-gray-900 px-2.5 py-1.5 text-xs font-medium text-white shadow-sm disabled:opacity-50"
                  onClick={() => openReportPrintWindow(false)}
                  disabled={!activeReportRows.length || reportLoading}
                >
                  Print
                </button>
              </div>
            </div>

            {reportApiPath ? (
              <>
                <div className="mb-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
                  <TextInput
                    placeholder="Search doc/customer/ref"
                    value={reportFilters.search}
                    onChange={(e) => {
                      setReportFilters((prev) => ({ ...prev, search: e.target.value }));
                      setReportPage(1);
                    }}
                  />
                  <TextInput
                    type="date"
                    value={reportFilters.dateFrom}
                    onChange={(e) => {
                      setReportFilters((prev) => ({ ...prev, dateFrom: e.target.value }));
                      setReportPage(1);
                    }}
                  />
                  <TextInput
                    type="date"
                    value={reportFilters.dateTo}
                    onChange={(e) => {
                      setReportFilters((prev) => ({ ...prev, dateTo: e.target.value }));
                      setReportPage(1);
                    }}
                  />
                  <TextInput
                    placeholder="Customer"
                    value={reportFilters.customer}
                    onChange={(e) => {
                      setReportFilters((prev) => ({ ...prev, customer: e.target.value }));
                      setReportPage(1);
                    }}
                  />
                  <select
                    className="w-full rounded-xl border border-gray-300 bg-white px-3 py-2 text-sm outline-none focus:border-gray-500"
                    value={reportFilters.status}
                    onChange={(e) => {
                      setReportFilters((prev) => ({ ...prev, status: e.target.value }));
                      setReportPage(1);
                    }}
                  >
                    <option value="">All statuses</option>
                    {(reportStatusOptionsById[activeReportId] || []).map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="mb-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                  {Object.entries(activeReportData?.totals || {}).map(([key, val]) => (
                    <div key={key} className="rounded-xl border border-gray-200 bg-gray-50 p-3">
                      <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">
                        {key.replace(/([A-Z])/g, " $1").trim()}
                      </p>
                      <p className="mt-1 text-lg font-semibold text-gray-900">
                        {String(key).toLowerCase().includes("value") || String(key).toLowerCase().includes("amount")
                          ? `USD ${money(val)}`
                          : val ?? 0}
                      </p>
                    </div>
                  ))}
                </div>

                <div className="overflow-hidden rounded-2xl border">
                  <div className="overflow-x-auto">
                    <table className="min-w-full text-left text-sm">
                      <thead className="sticky top-0 z-10 border-b bg-gray-100 text-xs font-semibold uppercase tracking-wide text-gray-700">
                        <tr>
                          {activeReportId === "quotation-summary" && (
                            <>
                              <th className="px-3 py-2">Quotation No</th>
                              <th className="px-3 py-2">Date</th>
                              <th className="px-3 py-2">Customer</th>
                              <th className="px-3 py-2">Customer Ref</th>
                              <th className="px-3 py-2">Engine</th>
                              <th className="px-3 py-2">Model</th>
                              <th className="px-3 py-2">ESN</th>
                              <th className="px-3 py-2">Line Items</th>
                              <th className="px-3 py-2 text-right">Total</th>
                              <th className="px-3 py-2">Status</th>
                            </>
                          )}
                          {activeReportId === "pending-quotation" && (
                            <>
                              <th className="px-3 py-2">Quotation No</th>
                              <th className="px-3 py-2">Date</th>
                              <th className="px-3 py-2">Customer</th>
                              <th className="px-3 py-2">Article Count</th>
                              <th className="px-3 py-2 text-right">Total</th>
                              <th className="px-3 py-2">Age (Days)</th>
                              <th className="px-3 py-2">Status</th>
                              <th className="px-3 py-2">Follow-up Remarks</th>
                            </>
                          )}
                          {activeReportId === "order-acknowledgement" && (
                            <>
                              <th className="px-3 py-2">OA No</th>
                              <th className="px-3 py-2">OA Date</th>
                              <th className="px-3 py-2">Linked Quotation</th>
                              <th className="px-3 py-2">Customer</th>
                              <th className="px-3 py-2">Customer PO Ref</th>
                              <th className="px-3 py-2">Delivery Terms</th>
                              <th className="px-3 py-2 text-right">Total</th>
                              <th className="px-3 py-2">Status</th>
                            </>
                          )}
                          {activeReportId === "pending-order-acknowledgement" && (
                            <>
                              <th className="px-3 py-2">OA No</th>
                              <th className="px-3 py-2">Customer</th>
                              <th className="px-3 py-2">Quotation Link</th>
                              <th className="px-3 py-2 text-right">Amount</th>
                              <th className="px-3 py-2">Age (Days)</th>
                              <th className="px-3 py-2">Status</th>
                            </>
                          )}
                          {activeReportId === "proforma" && (
                            <>
                              <th className="px-3 py-2">Proforma No</th>
                              <th className="px-3 py-2">Date</th>
                              <th className="px-3 py-2">Linked Quotation/OA</th>
                              <th className="px-3 py-2">Customer</th>
                              <th className="px-3 py-2 text-right">Amount</th>
                              <th className="px-3 py-2">Status</th>
                              <th className="px-3 py-2">Validity</th>
                              <th className="px-3 py-2">Payment Terms</th>
                            </>
                          )}
                          {activeReportId === "sales-invoice-summary" && (
                            <>
                              <th className="px-3 py-2">Invoice No</th>
                              <th className="px-3 py-2">Date</th>
                              <th className="px-3 py-2">Customer</th>
                              <th className="px-3 py-2">Linked Proforma</th>
                              <th className="px-3 py-2">Linked OA</th>
                              <th className="px-3 py-2">Currency</th>
                              <th className="px-3 py-2 text-right">Invoice Value</th>
                              <th className="px-3 py-2 text-right">Paid</th>
                              <th className="px-3 py-2 text-right">Balance</th>
                              <th className="px-3 py-2">Payment Status</th>
                            </>
                          )}
                          {activeReportId === "sales-invoice-article-wise" && (
                            <>
                              <th className="px-3 py-2">Article</th>
                              <th className="px-3 py-2">Description</th>
                              <th className="px-3 py-2 text-right">Total Qty Sold</th>
                              <th className="px-3 py-2 text-right">Total Sales Value</th>
                              <th className="px-3 py-2 text-right">Invoices</th>
                              <th className="px-3 py-2 text-right">Customers</th>
                              <th className="px-3 py-2 text-right">Avg Selling Price</th>
                            </>
                          )}
                          {activeReportId === "sales-branch-wise" && (
                            <>
                              <th className="px-3 py-2">Branch</th>
                              <th className="px-3 py-2 text-right">No. of Invoices</th>
                              <th className="px-3 py-2 text-right">No. of Customers</th>
                              <th className="px-3 py-2 text-right">Total Qty Sold</th>
                              <th className="px-3 py-2 text-right">Total Sales Value</th>
                              <th className="px-3 py-2 text-right">Paid Amount</th>
                              <th className="px-3 py-2 text-right">Unpaid Amount</th>
                            </>
                          )}
                          {activeReportId === "cipl" && (
                            <>
                              <th className="px-3 py-2">CIPL No</th>
                              <th className="px-3 py-2">Date</th>
                              <th className="px-3 py-2">Customer/Consignee</th>
                              <th className="px-3 py-2">Linked Ref</th>
                              <th className="px-3 py-2">Destination</th>
                              <th className="px-3 py-2">Port of Loading</th>
                              <th className="px-3 py-2">Port of Discharge</th>
                              <th className="px-3 py-2 text-right">Packages</th>
                              <th className="px-3 py-2 text-right">Net Wt</th>
                              <th className="px-3 py-2 text-right">Gross Wt</th>
                              <th className="px-3 py-2 text-right">Value</th>
                              <th className="px-3 py-2">Status</th>
                            </>
                          )}
                        </tr>
                      </thead>
                      <tbody>
                        {reportLoading ? (
                          <tr>
                            <td className="px-3 py-8 text-center text-gray-500" colSpan={12}>
                              Loading report...
                            </td>
                          </tr>
                        ) : (activeReportData?.rows || []).length === 0 ? (
                          <tr>
                            <td className="px-3 py-8 text-center text-gray-500" colSpan={12}>
                              No rows found for current filters. Adjust date/status/customer and try again.
                            </td>
                          </tr>
                        ) : (
                          (activeReportData?.rows || []).map((row) => (
                            <tr key={row._id} className="border-b border-gray-100 hover:bg-gray-50/80">
                              {activeReportId === "quotation-summary" && (
                                <>
                                  <td className="px-3 py-2 font-mono text-xs">{row.quotationNo}</td>
                                  <td className="px-3 py-2">{row.quotationDate ? new Date(row.quotationDate).toLocaleDateString() : "-"}</td>
                                  <td className="px-3 py-2">{row.customerName}</td>
                                  <td className="px-3 py-2">{row.customerReference || "-"}</td>
                                  <td className="px-3 py-2">{row.engine || "-"}</td>
                                  <td className="px-3 py-2">{row.model || "-"}</td>
                                  <td className="px-3 py-2">{row.esn || "-"}</td>
                                  <td className="px-3 py-2">{row.lineItems || 0}</td>
                                  <td className="px-3 py-2 text-right">USD {money(row.totalAmount)}</td>
                                  <td className="px-3 py-2">
                                    <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ${statusBadgeClass(row.status)}`}>
                                      {row.status}
                                    </span>
                                  </td>
                                </>
                              )}
                              {activeReportId === "pending-quotation" && (
                                <>
                                  <td className="px-3 py-2 font-mono text-xs">{row.quotationNo}</td>
                                  <td className="px-3 py-2">{row.quotationDate ? new Date(row.quotationDate).toLocaleDateString() : "-"}</td>
                                  <td className="px-3 py-2">{row.customerName}</td>
                                  <td className="px-3 py-2">{row.articleCount || 0}</td>
                                  <td className="px-3 py-2 text-right">USD {money(row.totalAmount)}</td>
                                  <td className="px-3 py-2">{row.ageDays || 0}</td>
                                  <td className="px-3 py-2">
                                    <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ${statusBadgeClass(row.status)}`}>
                                      {row.status}
                                    </span>
                                  </td>
                                  <td className="px-3 py-2">{row.followUpRemarks || "-"}</td>
                                </>
                              )}
                              {activeReportId === "order-acknowledgement" && (
                                <>
                                  <td className="px-3 py-2 font-mono text-xs">{row.oaNo}</td>
                                  <td className="px-3 py-2">{row.oaDate ? new Date(row.oaDate).toLocaleDateString() : "-"}</td>
                                  <td className="px-3 py-2">{row.linkedQuotationNo || "-"}</td>
                                  <td className="px-3 py-2">{row.customerName}</td>
                                  <td className="px-3 py-2">{row.customerPORef || "-"}</td>
                                  <td className="px-3 py-2">{row.deliveryTerms || "-"}</td>
                                  <td className="px-3 py-2 text-right">USD {money(row.totalAmount)}</td>
                                  <td className="px-3 py-2">
                                    <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ${statusBadgeClass(row.status)}`}>
                                      {row.status}
                                    </span>
                                  </td>
                                </>
                              )}
                              {activeReportId === "pending-order-acknowledgement" && (
                                <>
                                  <td className="px-3 py-2 font-mono text-xs">{row.oaNo}</td>
                                  <td className="px-3 py-2">{row.customerName}</td>
                                  <td className="px-3 py-2">{row.linkedQuotationNo || "-"}</td>
                                  <td className="px-3 py-2 text-right">USD {money(row.amount)}</td>
                                  <td className="px-3 py-2">{row.ageDays || 0}</td>
                                  <td className="px-3 py-2">
                                    <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ${statusBadgeClass(row.status)}`}>
                                      {row.status}
                                    </span>
                                  </td>
                                </>
                              )}
                              {activeReportId === "proforma" && (
                                <>
                                  <td className="px-3 py-2 font-mono text-xs">{row.proformaNo}</td>
                                  <td className="px-3 py-2">{row.proformaDate ? new Date(row.proformaDate).toLocaleDateString() : "-"}</td>
                                  <td className="px-3 py-2">{row.linkedOANo || row.linkedQuotationNo || "-"}</td>
                                  <td className="px-3 py-2">{row.customerName}</td>
                                  <td className="px-3 py-2 text-right">USD {money(row.amount)}</td>
                                  <td className="px-3 py-2">
                                    <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ${statusBadgeClass(row.status)}`}>
                                      {row.status}
                                    </span>
                                  </td>
                                  <td className="px-3 py-2">{row.validity || "-"}</td>
                                  <td className="px-3 py-2">{row.paymentTerms || "-"}</td>
                                </>
                              )}
                              {activeReportId === "sales-invoice-summary" && (
                                <>
                                  <td className="px-3 py-2 font-mono text-xs">{row.invoiceNo}</td>
                                  <td className="px-3 py-2">{row.invoiceDate ? new Date(row.invoiceDate).toLocaleDateString() : "-"}</td>
                                  <td className="px-3 py-2">{row.customerName}</td>
                                  <td className="px-3 py-2">{row.linkedProformaNo || "-"}</td>
                                  <td className="px-3 py-2">{row.linkedOANo || "-"}</td>
                                  <td className="px-3 py-2">{row.currency || "USD"}</td>
                                  <td className="px-3 py-2 text-right">{row.currency || "USD"} {money(row.invoiceValue)}</td>
                                  <td className="px-3 py-2 text-right">{row.currency || "USD"} {money(row.paidAmount)}</td>
                                  <td className="px-3 py-2 text-right">{row.currency || "USD"} {money(row.balanceAmount)}</td>
                                  <td className="px-3 py-2">
                                    <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ${statusBadgeClass(row.paymentStatus)}`}>
                                      {row.paymentStatus}
                                    </span>
                                  </td>
                                </>
                              )}
                              {activeReportId === "sales-invoice-article-wise" && (
                                <>
                                  <td className="px-3 py-2 font-mono text-xs">{row.article}</td>
                                  <td className="px-3 py-2">{row.description || "-"}</td>
                                  <td className="px-3 py-2 text-right">{row.totalQtySold || 0}</td>
                                  <td className="px-3 py-2 text-right">USD {money(row.totalSalesValue)}</td>
                                  <td className="px-3 py-2 text-right">{row.invoiceCount || 0}</td>
                                  <td className="px-3 py-2 text-right">{row.customersCount || 0}</td>
                                  <td className="px-3 py-2 text-right">USD {money(row.avgSellingPrice)}</td>
                                </>
                              )}
                              {activeReportId === "sales-branch-wise" && (
                                <>
                                  <td className="px-3 py-2">{row.branch || "UNSPECIFIED"}</td>
                                  <td className="px-3 py-2 text-right">{row.noOfInvoices || 0}</td>
                                  <td className="px-3 py-2 text-right">{row.noOfCustomers || 0}</td>
                                  <td className="px-3 py-2 text-right">{row.totalQtySold || 0}</td>
                                  <td className="px-3 py-2 text-right">USD {money(row.totalSalesValue)}</td>
                                  <td className="px-3 py-2 text-right">USD {money(row.paidAmount)}</td>
                                  <td className="px-3 py-2 text-right">USD {money(row.unpaidAmount)}</td>
                                </>
                              )}
                              {activeReportId === "cipl" && (
                                <>
                                  <td className="px-3 py-2 font-mono text-xs">{row.ciplNo}</td>
                                  <td className="px-3 py-2">{row.date ? new Date(row.date).toLocaleDateString() : "-"}</td>
                                  <td className="px-3 py-2">{row.customerOrConsignee || "-"}</td>
                                  <td className="px-3 py-2">{row.linkedReference || "-"}</td>
                                  <td className="px-3 py-2">{row.destination || "-"}</td>
                                  <td className="px-3 py-2">{row.portOfLoading || "-"}</td>
                                  <td className="px-3 py-2">{row.portOfDischarge || "-"}</td>
                                  <td className="px-3 py-2 text-right">{row.packageCount || 0}</td>
                                  <td className="px-3 py-2 text-right">{money(row.netWeight)}</td>
                                  <td className="px-3 py-2 text-right">{money(row.grossWeight)}</td>
                                  <td className="px-3 py-2 text-right">USD {money(row.value)}</td>
                                  <td className="px-3 py-2">
                                    <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ${statusBadgeClass(row.status)}`}>
                                      {row.status}
                                    </span>
                                  </td>
                                </>
                              )}
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>
                  <div className="flex items-center justify-between border-t px-3 py-2 text-sm text-gray-600">
                    <span>
                      Page {activeReportData?.page || 1}/{Math.max(1, Math.ceil((activeReportData?.total || 0) / (activeReportData?.limit || 20)))} ·{" "}
                      {activeReportData?.total || 0} records
                    </span>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        className="rounded-lg border px-2 py-1 disabled:opacity-40"
                        disabled={(activeReportData?.page || 1) <= 1}
                        onClick={() => setReportPage((p) => Math.max(1, p - 1))}
                      >
                        Prev
                      </button>
                      <button
                        type="button"
                        className="rounded-lg border px-2 py-1 disabled:opacity-40"
                        disabled={(activeReportData?.page || 1) >= Math.max(1, Math.ceil((activeReportData?.total || 0) / (activeReportData?.limit || 20)))}
                        onClick={() => setReportPage((p) => p + 1)}
                      >
                        Next
                      </button>
                    </div>
                  </div>
                </div>
              </>
            ) : (
              <p className="text-sm text-gray-600">
                This report will be implemented in Phase 4. You can still browse and select it from the catalog.
              </p>
            )}
          </div>
        </div>
      ) : tabContent === "coming" ? (
        <div className="rounded-2xl border bg-white p-8 text-sm text-gray-600">
          {activeTab} in next sales phase.
        </div>
      ) : tabContent === "customer-master" ? (
        <>
          <div className="mb-3 flex flex-wrap items-end gap-2 rounded-2xl border bg-white p-3 shadow-sm">
            <TextInput
              placeholder="Search customer/contact/email"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
              className="w-72"
            />
          </div>
          <div className="overflow-hidden rounded-2xl border bg-white">
            <div className="overflow-x-auto">
              <table className="min-w-full text-left text-sm">
                <thead className="sticky top-0 z-10 border-b bg-gray-100 text-xs font-semibold uppercase tracking-wide text-gray-700">
                  <tr>
                    <th className="px-3 py-2">Customer</th>
                    <th className="px-3 py-2">Contact</th>
                    <th className="px-3 py-2">Phone</th>
                    <th className="px-3 py-2">Email</th>
                    <th className="px-3 py-2">Payment Terms</th>
                    <th className="px-3 py-2">Address</th>
                  </tr>
                </thead>
                <tbody>
                  {customerLoading ? (
                    <tr>
                      <td colSpan={6} className="px-3 py-8 text-center text-gray-500">
                        Loading...
                      </td>
                    </tr>
                  ) : customerRows.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="px-3 py-8 text-center text-gray-500">
                        No customers found.
                      </td>
                    </tr>
                  ) : (
                    customerRows.map((r) => (
                      <tr key={r._id} className="border-b border-gray-100 hover:bg-gray-50/80">
                        <td className="px-3 py-2">{r.name}</td>
                        <td className="px-3 py-2">{r.contactName || "-"}</td>
                        <td className="px-3 py-2">{r.phone || "-"}</td>
                        <td className="px-3 py-2">{r.email || "-"}</td>
                        <td className="px-3 py-2">{r.paymentTerms || "-"}</td>
                        <td className="px-3 py-2">{r.address || "-"}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
            <div className="flex items-center justify-between border-t px-3 py-2 text-sm text-gray-600">
              <span>
                Page {page}/{customerTotalPages} · {customerData?.total ?? 0} customers
              </span>
              <div className="flex gap-2">
                <button
                  type="button"
                  className="rounded-lg border px-2 py-1 disabled:opacity-40"
                  disabled={page <= 1}
                  onClick={() => setPage((p) => p - 1)}
                >
                  Prev
                </button>
                <button
                  type="button"
                  className="rounded-lg border px-2 py-1 disabled:opacity-40"
                  disabled={page >= customerTotalPages}
                  onClick={() => setPage((p) => p + 1)}
                >
                  Next
                </button>
              </div>
            </div>
          </div>
        </>
      ) : tabContent === "quotation" ? (
        <>
          <div className="mb-3 flex flex-wrap items-end gap-2 rounded-2xl border bg-white p-3 shadow-sm">
            <TextInput
              placeholder="Search quote/customer/ref"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
              className="w-64"
            />
            <select
              className="rounded-xl border px-3 py-2 text-sm"
              value={status}
              onChange={(e) => {
                setStatus(e.target.value);
                setPage(1);
              }}
            >
              <option value="">All statuses</option>
              {statusOptions.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="rounded-xl border px-3 py-2 text-sm"
              onClick={() =>
                exportListCsv("quotation-list", rows, [
                  { label: "Quotation No", value: (r) => r.quotationNo },
                  { label: "Customer", value: (r) => r.customerName },
                  { label: "Date", value: (r) => (r.quotationDate ? new Date(r.quotationDate).toLocaleDateString() : "") },
                  { label: "Status", value: (r) => r.status },
                  { label: "Currency", value: (r) => r.currency || "USD" },
                  { label: "Grand Total", value: (r) => money(r.grandTotal) },
                ])
              }
            >
              Export CSV
            </button>
          </div>

          <div className="overflow-hidden rounded-2xl border bg-white">
            <div className="overflow-x-auto">
              <table className="min-w-full text-left text-sm">
                <thead className="sticky top-0 z-10 border-b bg-gray-100 text-xs font-semibold uppercase tracking-wide text-gray-700">
                  <tr>
                    <th className="px-3 py-2">Quotation No</th>
                    <th className="px-3 py-2">Customer</th>
                    <th className="px-3 py-2">Engine</th>
                    <th className="px-3 py-2">Model</th>
                    <th className="px-3 py-2">ESN</th>
                    <th className="px-3 py-2">Date</th>
                    <th className="px-3 py-2">Validity</th>
                    <th className="px-3 py-2">Status</th>
                    <th className="px-3 py-2 text-right">Grand Total</th>
                    <th className="px-3 py-2">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {isLoading ? (
                    <tr>
                      <td colSpan={10} className="px-3 py-8 text-center text-gray-500">
                        Loading…
                      </td>
                    </tr>
                  ) : rows.length === 0 ? (
                    <tr>
                      <td colSpan={10} className="px-3 py-8 text-center text-gray-500">
                        No quotations found.
                      </td>
                    </tr>
                  ) : (
                    rows.map((r) => (
                      <tr key={r._id} className="border-b border-gray-100 hover:bg-gray-50/80">
                        <td className="px-3 py-2 font-mono text-xs">{r.quotationNo}</td>
                        <td className="px-3 py-2">{r.customerName}</td>
                        <td className="px-3 py-2">{r.engine || "-"}</td>
                        <td className="px-3 py-2">{r.model || "-"}</td>
                        <td className="px-3 py-2">{r.esn || "-"}</td>
                        <td className="px-3 py-2">{r.quotationDate ? new Date(r.quotationDate).toLocaleDateString() : "—"}</td>
                        <td className="px-3 py-2">{r.validityDate ? new Date(r.validityDate).toLocaleDateString() : "—"}</td>
                        <td className="px-3 py-2">
                          <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ${statusBadgeClass(r.status)}`}>
                            {r.status}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-right">
                          {r.currency} {money(r.grandTotal)}
                        </td>
                        <td className="px-3 py-2">
                          <div className="flex flex-wrap gap-1">
                            <button
                              type="button"
                              className="rounded-lg border px-2 py-1 text-xs"
                              onClick={() => setDetailId(r._id)}
                            >
                              Open
                            </button>
                            <button
                              type="button"
                              className="rounded-lg border px-2 py-1 text-xs"
                              onClick={() => duplicateMutation.mutate(r._id)}
                            >
                              Duplicate
                            </button>
                            <button
                              type="button"
                              className="rounded-lg border px-2 py-1 text-xs"
                              onClick={() => {
                                apiGet(`/quotations/${r._id}/print-data`)
                                  .then((data) => renderPrintWindow(data))
                                  .catch((e) => setErr(e.message));
                              }}
                            >
                              Print
                            </button>
                            <button
                              type="button"
                              className="rounded-lg border px-2 py-1 text-xs"
                              onClick={() => {
                                apiGet(`/quotations/${r._id}/print-data`)
                                  .then((data) => renderPrintWindow(data, true))
                                  .catch((e) => setErr(e.message));
                              }}
                            >
                              Export PDF
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
            <div className="flex items-center justify-between border-t px-3 py-2 text-sm text-gray-600">
              <span>
                Page {page}/{totalPages} · {total} quotations
              </span>
              <div className="flex gap-2">
                <button
                  type="button"
                  className="rounded-lg border px-2 py-1 disabled:opacity-40"
                  disabled={page <= 1}
                  onClick={() => setPage((p) => p - 1)}
                >
                  Prev
                </button>
                <button
                  type="button"
                  className="rounded-lg border px-2 py-1 disabled:opacity-40"
                  disabled={page >= totalPages}
                  onClick={() => setPage((p) => p + 1)}
                >
                  Next
                </button>
              </div>
            </div>
          </div>
        </>
      ) : tabContent === "oa" ? (
        <>
          <div className="mb-3 flex flex-wrap items-end gap-2 rounded-2xl border bg-white p-3 shadow-sm">
            <TextInput
              placeholder="Search OA/customer"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
              className="w-64"
            />
            <button
              type="button"
              className="rounded-xl border px-3 py-2 text-sm"
              onClick={() =>
                exportListCsv("oa-list", oaRows, [
                  { label: "OA No", value: (r) => r.oaNo },
                  { label: "OA Date", value: (r) => (r.oaDate ? new Date(r.oaDate).toLocaleDateString() : "") },
                  { label: "Customer", value: (r) => r.customerName },
                  { label: "Linked Quotation", value: (r) => r.linkedQuotationNo || "" },
                  { label: "Status", value: (r) => orderAcknowledgementDisplayStatus(r) },
                  { label: "Currency", value: (r) => r.currency || "USD" },
                  { label: "Total", value: (r) => money(r.grandTotal) },
                ])
              }
            >
              Export CSV
            </button>
          </div>
          <div className="overflow-hidden rounded-2xl border bg-white">
            <div className="overflow-x-auto">
              <table className="min-w-full text-left text-sm">
                <thead className="sticky top-0 z-10 border-b bg-gray-100 text-xs font-semibold uppercase tracking-wide text-gray-700">
                  <tr>
                    <th className="px-3 py-2">OA No</th>
                    <th className="px-3 py-2">Customer</th>
                    <th className="px-3 py-2">Date</th>
                    <th className="px-3 py-2">Status</th>
                    <th className="px-3 py-2 text-right">Grand Total</th>
                    <th className="px-3 py-2">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {oaLoading ? (
                    <tr>
                      <td colSpan={6} className="px-3 py-8 text-center text-gray-500">
                        Loading...
                      </td>
                    </tr>
                  ) : oaRows.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="px-3 py-8 text-center text-gray-500">
                        No OA found.
                      </td>
                    </tr>
                  ) : (
                    oaRows.map((r) => {
                      const converted = Array.isArray(r.convertedTo) ? r.convertedTo.map(String) : [];
                      const hasPIFromOA = converted.includes("PROFORMA");
                      const hasSIFromOA = converted.includes("SALES_INVOICE");
                      return (
                      <tr key={r._id} className="border-b border-gray-100 hover:bg-gray-50/80">
                        <td className="px-3 py-2 font-mono text-xs">{r.oaNo}</td>
                        <td className="px-3 py-2">{r.customerName}</td>
                        <td className="px-3 py-2">{r.oaDate ? new Date(r.oaDate).toLocaleDateString() : "—"}</td>
                        <td className="px-3 py-2">
                          <span
                            className={`inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ${statusBadgeClass(orderAcknowledgementDisplayStatus(r))}`}
                          >
                            {orderAcknowledgementDisplayStatus(r)}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-right">
                          {r.currency} {money(r.grandTotal)}
                        </td>
                        <td className="px-3 py-2">
                          <div className="flex flex-wrap gap-1">
                            <button type="button" className="rounded-lg border px-2 py-1 text-xs" onClick={() => setDetailId(r._id)}>
                              Open
                            </button>
                            <button type="button" className="rounded-lg border px-2 py-1 text-xs" onClick={() => openFlowDocumentPrint("oa", r._id)}>
                              Print
                            </button>
                            <button type="button" className="rounded-lg border px-2 py-1 text-xs" onClick={() => openFlowDocumentPrint("oa", r._id, true)}>
                              Export PDF
                            </button>
                            <button
                              type="button"
                              className={`rounded-lg border px-2 py-1 text-xs ${hasPIFromOA ? "opacity-40" : ""}`}
                              disabled={hasPIFromOA}
                              title={hasPIFromOA ? "Proforma already created from this OA" : ""}
                              onClick={() => convertToProformaFromOAMutation.mutate(r._id)}
                            >
                              Convert to PI
                            </button>
                            <button
                              type="button"
                              className={`rounded-lg border px-2 py-1 text-xs ${hasSIFromOA ? "opacity-40" : ""}`}
                              disabled={hasSIFromOA}
                              title={hasSIFromOA ? "Sales invoice already created from this OA" : ""}
                              onClick={() => convertToSalesInvoiceFromOAMutation.mutate(r._id)}
                            >
                              Convert to SI
                            </button>
                            <button
                              type="button"
                              className="rounded-lg border px-2 py-1 text-xs"
                              onClick={() => convertToCiplFromOAMutation.mutate(r._id)}
                            >
                              Convert to CIPL
                            </button>
                          </div>
                        </td>
                      </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
            <div className="flex items-center justify-between border-t px-3 py-2 text-sm text-gray-600">
              <span>
                Page {page}/{oaTotalPages} · {oaData?.total ?? 0} OA
              </span>
              <div className="flex gap-2">
                <button type="button" className="rounded-lg border px-2 py-1 disabled:opacity-40" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                  Prev
                </button>
                <button
                  type="button"
                  className="rounded-lg border px-2 py-1 disabled:opacity-40"
                  disabled={page >= oaTotalPages}
                  onClick={() => setPage((p) => p + 1)}
                >
                  Next
                </button>
              </div>
            </div>
          </div>
        </>
      ) : tabContent === "proforma" ? (
        <>
          <div className="mb-3 flex flex-wrap items-end gap-2 rounded-2xl border bg-white p-3 shadow-sm">
            <TextInput
              placeholder="Search PI/customer"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
              className="w-64"
            />
            <button
              type="button"
              className="rounded-xl border px-3 py-2 text-sm"
              onClick={() =>
                exportListCsv("proforma-list", proformaRows, [
                  { label: "Proforma No", value: (r) => r.proformaNo },
                  { label: "Date", value: (r) => (r.proformaDate ? new Date(r.proformaDate).toLocaleDateString() : "") },
                  { label: "Customer", value: (r) => r.customerName },
                  { label: "Status", value: (r) => r.status },
                  { label: "Currency", value: (r) => r.currency || "USD" },
                  { label: "Total", value: (r) => money(r.grandTotal) },
                ])
              }
            >
              Export CSV
            </button>
          </div>
          <div className="overflow-hidden rounded-2xl border bg-white">
            <div className="overflow-x-auto">
              <table className="min-w-full text-left text-sm">
                <thead className="sticky top-0 z-10 border-b bg-gray-100 text-xs font-semibold uppercase tracking-wide text-gray-700">
                  <tr>
                    <th className="px-3 py-2">PI No</th>
                    <th className="px-3 py-2">Customer</th>
                    <th className="px-3 py-2">Date</th>
                    <th className="px-3 py-2">Status</th>
                    <th className="px-3 py-2 text-right">Grand Total</th>
                    <th className="px-3 py-2">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {proformaLoading ? (
                    <tr>
                      <td colSpan={6} className="px-3 py-8 text-center text-gray-500">
                        Loading...
                      </td>
                    </tr>
                  ) : proformaRows.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="px-3 py-8 text-center text-gray-500">
                        No Proforma found.
                      </td>
                    </tr>
                  ) : (
                    proformaRows.map((r) => (
                      <tr key={r._id} className="border-b border-gray-100 hover:bg-gray-50/80">
                        <td className="px-3 py-2 font-mono text-xs">{r.proformaNo}</td>
                        <td className="px-3 py-2">{r.customerName}</td>
                        <td className="px-3 py-2">{r.proformaDate ? new Date(r.proformaDate).toLocaleDateString() : "—"}</td>
                        <td className="px-3 py-2">
                          <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ${statusBadgeClass(r.status)}`}>
                            {r.status}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-right">
                          {r.currency} {money(r.grandTotal)}
                        </td>
                        <td className="px-3 py-2">
                          <div className="flex flex-wrap gap-1">
                            <button type="button" className="rounded-lg border px-2 py-1 text-xs" onClick={() => setDetailId(r._id)}>
                              Open
                            </button>
                            <button type="button" className="rounded-lg border px-2 py-1 text-xs" onClick={() => openFlowDocumentPrint("proforma", r._id)}>
                              Print
                            </button>
                            <button type="button" className="rounded-lg border px-2 py-1 text-xs" onClick={() => openFlowDocumentPrint("proforma", r._id, true)}>
                              Export PDF
                            </button>
                            <button
                              type="button"
                              className="rounded-lg border px-2 py-1 text-xs"
                              onClick={() => convertProformaToSalesInvoiceMutation.mutate(r._id)}
                            >
                              Convert to SI
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
            <div className="flex items-center justify-between border-t px-3 py-2 text-sm text-gray-600">
              <span>
                Page {page}/{proformaTotalPages} · {proformaData?.total ?? 0} PI
              </span>
              <div className="flex gap-2">
                <button type="button" className="rounded-lg border px-2 py-1 disabled:opacity-40" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                  Prev
                </button>
                <button
                  type="button"
                  className="rounded-lg border px-2 py-1 disabled:opacity-40"
                  disabled={page >= proformaTotalPages}
                  onClick={() => setPage((p) => p + 1)}
                >
                  Next
                </button>
              </div>
            </div>
          </div>
        </>
      ) : tabContent === "sales-invoice" ? (
        <>
          <div className="mb-3 flex flex-wrap items-end gap-2 rounded-2xl border bg-white p-3 shadow-sm">
            <TextInput
              placeholder="Search invoice/customer"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
              className="w-64"
            />
            <button
              type="button"
              className="rounded-xl border px-3 py-2 text-sm"
              onClick={() =>
                exportListCsv("sales-invoice-list", salesInvoiceRows, [
                  { label: "Invoice No", value: (r) => r.invoiceNo },
                  { label: "Date", value: (r) => (r.invoiceDate ? new Date(r.invoiceDate).toLocaleDateString() : "") },
                  { label: "Customer", value: (r) => r.customerName },
                  { label: "Status", value: (r) => r.status },
                  { label: "Currency", value: (r) => r.currency || "USD" },
                  { label: "Total", value: (r) => money(r.grandTotal) },
                ])
              }
            >
              Export CSV
            </button>
          </div>
          <div className="overflow-hidden rounded-2xl border bg-white">
            <div className="overflow-x-auto">
              <table className="min-w-full text-left text-sm">
                <thead className="sticky top-0 z-10 border-b bg-gray-100 text-xs font-semibold uppercase tracking-wide text-gray-700">
                  <tr>
                    <th className="px-3 py-2">Invoice No</th>
                    <th className="px-3 py-2">Customer</th>
                    <th className="px-3 py-2">Date</th>
                    <th className="px-3 py-2">Status</th>
                    <th className="px-3 py-2 text-right">Grand Total</th>
                    <th className="px-3 py-2">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {salesInvoiceLoading ? (
                    <tr>
                      <td colSpan={6} className="px-3 py-8 text-center text-gray-500">
                        Loading...
                      </td>
                    </tr>
                  ) : salesInvoiceRows.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="px-3 py-8 text-center text-gray-500">
                        No Sales Invoice found.
                      </td>
                    </tr>
                  ) : (
                    salesInvoiceRows.map((r) => (
                      <tr key={r._id} className="border-b border-gray-100 hover:bg-gray-50/80">
                        <td className="px-3 py-2 font-mono text-xs">{r.invoiceNo}</td>
                        <td className="px-3 py-2">{r.customerName}</td>
                        <td className="px-3 py-2">{r.invoiceDate ? new Date(r.invoiceDate).toLocaleDateString() : "—"}</td>
                        <td className="px-3 py-2">
                          <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ${statusBadgeClass(r.status)}`}>
                            {r.status}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-right">
                          {r.currency} {money(r.grandTotal)}
                        </td>
                        <td className="px-3 py-2">
                          <div className="flex flex-wrap gap-1">
                            <button type="button" className="rounded-lg border px-2 py-1 text-xs" onClick={() => setDetailId(r._id)}>
                              Open
                            </button>
                            <button type="button" className="rounded-lg border px-2 py-1 text-xs" onClick={() => openFlowDocumentPrint("sales-invoice", r._id)}>
                              Print
                            </button>
                            <button type="button" className="rounded-lg border px-2 py-1 text-xs" onClick={() => openFlowDocumentPrint("sales-invoice", r._id, true)}>
                              Export PDF
                            </button>
                            <button
                              type="button"
                              className="rounded-lg border px-2 py-1 text-xs"
                              onClick={() => convertToCiplFromSalesInvoiceMutation.mutate(r._id)}
                            >
                              Convert to CIPL
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
            <div className="flex items-center justify-between border-t px-3 py-2 text-sm text-gray-600">
              <span>
                Page {page}/{salesInvoiceTotalPages} · {salesInvoiceData?.total ?? 0} Sales Invoices
              </span>
              <div className="flex gap-2">
                <button
                  type="button"
                  className="rounded-lg border px-2 py-1 disabled:opacity-40"
                  disabled={page <= 1}
                  onClick={() => setPage((p) => p - 1)}
                >
                  Prev
                </button>
                <button
                  type="button"
                  className="rounded-lg border px-2 py-1 disabled:opacity-40"
                  disabled={page >= salesInvoiceTotalPages}
                  onClick={() => setPage((p) => p + 1)}
                >
                  Next
                </button>
              </div>
            </div>
          </div>
        </>
      ) : (
        <>
          <div className="mb-3 flex flex-wrap items-end gap-2 rounded-2xl border bg-white p-3 shadow-sm">
            <TextInput
              placeholder="Search CIPL/customer"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
              className="w-64"
            />
            <button
              type="button"
              className="rounded-xl border px-3 py-2 text-sm"
              onClick={() =>
                exportListCsv("cipl-list", ciplRows, [
                  { label: "CIPL No", value: (r) => r.ciplNo },
                  { label: "Date", value: (r) => (r.ciplDate ? new Date(r.ciplDate).toLocaleDateString() : "") },
                  { label: "Customer", value: (r) => r.customerName },
                  { label: "Status", value: (r) => r.status },
                  { label: "Currency", value: (r) => r.currency || "USD" },
                  { label: "Total", value: (r) => money(r.grandTotal) },
                ])
              }
            >
              Export CSV
            </button>
          </div>
          <div className="overflow-hidden rounded-2xl border bg-white">
            <div className="overflow-x-auto">
              <table className="min-w-full text-left text-sm">
                <thead className="sticky top-0 z-10 border-b bg-gray-100 text-xs font-semibold uppercase tracking-wide text-gray-700">
                  <tr>
                    <th className="px-3 py-2">CIPL No</th>
                    <th className="px-3 py-2">Customer</th>
                    <th className="px-3 py-2">Date</th>
                    <th className="px-3 py-2">Status</th>
                    <th className="px-3 py-2 text-right">Grand Total</th>
                    <th className="px-3 py-2">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {ciplLoading ? (
                    <tr>
                      <td colSpan={6} className="px-3 py-8 text-center text-gray-500">
                        Loading...
                      </td>
                    </tr>
                  ) : ciplRows.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="px-3 py-8 text-center text-gray-500">
                        No CIPL found.
                      </td>
                    </tr>
                  ) : (
                    ciplRows.map((r) => (
                      <tr key={r._id} className="border-b border-gray-100 hover:bg-gray-50/80">
                        <td className="px-3 py-2 font-mono text-xs">{r.ciplNo}</td>
                        <td className="px-3 py-2">{r.customerName}</td>
                        <td className="px-3 py-2">{r.ciplDate ? new Date(r.ciplDate).toLocaleDateString() : "—"}</td>
                        <td className="px-3 py-2">
                          <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ${statusBadgeClass(r.status)}`}>
                            {r.status}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-right">
                          {r.currency} {money(r.grandTotal)}
                        </td>
                        <td className="px-3 py-2">
                          <button type="button" className="rounded-lg border px-2 py-1 text-xs" onClick={() => setDetailId(r._id)}>
                            Open
                          </button>
                          <button type="button" className="rounded-lg border px-2 py-1 text-xs" onClick={() => openFlowDocumentPrint("cipl", r._id)}>
                            Print
                          </button>
                          <button type="button" className="rounded-lg border px-2 py-1 text-xs" onClick={() => openFlowDocumentPrint("cipl", r._id, true)}>
                            Export PDF
                          </button>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
            <div className="flex items-center justify-between border-t px-3 py-2 text-sm text-gray-600">
              <span>
                Page {page}/{ciplTotalPages} · {ciplData?.total ?? 0} CIPL
              </span>
              <div className="flex gap-2">
                <button
                  type="button"
                  className="rounded-lg border px-2 py-1 disabled:opacity-40"
                  disabled={page <= 1}
                  onClick={() => setPage((p) => p - 1)}
                >
                  Prev
                </button>
                <button
                  type="button"
                  className="rounded-lg border px-2 py-1 disabled:opacity-40"
                  disabled={page >= ciplTotalPages}
                  onClick={() => setPage((p) => p + 1)}
                >
                  Next
                </button>
              </div>
            </div>
          </div>
        </>
      )}

      <Modal
        open={!!detailId}
        onClose={() => setDetailId(null)}
        title={
          tabContent === "quotation"
            ? "Quotation View"
            : tabContent === "oa"
              ? "Order Acknowledgement View"
              : tabContent === "proforma"
                ? "Proforma View"
                : tabContent === "sales-invoice"
                  ? "Sales Invoice View"
                  : "CIPL View"
        }
        wide
        expanded
      >
        {tabContent === "quotation" && !detail ? (
          <p className="text-sm text-gray-500">Loading...</p>
        ) : tabContent === "quotation" && detail?.status === "DRAFT" && !detailQuotationDraftForm ? (
          <p className="text-sm text-gray-500">Loading...</p>
        ) : tabContent === "quotation" && detail?.status === "DRAFT" && detailQuotationDraftForm ? (
          <div className="space-y-4 text-sm">
            <div className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900 ring-1 ring-amber-200">
              Draft quotation — edit below, save changes, then use status buttons to approve when ready. Conversion to OA / Proforma is only available after <b>APPROVED</b>.
            </div>
            <div className="grid gap-3 sm:grid-cols-4">
              <FormField label="Quotation No">
                <TextInput value={detailQuotationDraftForm.quotationNo} onChange={(e) => setDetailQuotationDraftForm((f) => ({ ...f, quotationNo: e.target.value }))} />
              </FormField>
              <FormField label="Quotation Date">
                <TextInput type="date" value={detailQuotationDraftForm.quotationDate} onChange={(e) => setDetailQuotationDraftForm((f) => ({ ...f, quotationDate: e.target.value }))} />
              </FormField>
              <FormField label="Validity Date">
                <TextInput type="date" value={detailQuotationDraftForm.validityDate || ""} onChange={(e) => setDetailQuotationDraftForm((f) => ({ ...f, validityDate: e.target.value }))} />
              </FormField>
              <FormField label="Currency">
                <TextInput value={detailQuotationDraftForm.currency} onChange={(e) => setDetailQuotationDraftForm((f) => ({ ...f, currency: e.target.value.toUpperCase() }))} />
              </FormField>
              <FormField label="Customer *">
                <select
                  className="w-full rounded-xl border px-3 py-2 text-sm"
                  value={detailQuotationDraftForm.customerId || ""}
                  onChange={(e) => {
                    const selectedId = e.target.value;
                    const selected = customerOptions.find((c) => c._id === selectedId);
                    setDetailQuotationDraftForm((f) => ({ ...f, customerId: selectedId, customerName: selected?.name || "" }));
                  }}
                >
                  <option value="">Select customer</option>
                  {customerOptions.map((c) => (
                    <option key={c._id} value={c._id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </FormField>
              <FormField label="Customer Ref">
                <TextInput value={detailQuotationDraftForm.customerReference} onChange={(e) => setDetailQuotationDraftForm((f) => ({ ...f, customerReference: e.target.value }))} />
              </FormField>
              <FormField label="Attention">
                <TextInput value={detailQuotationDraftForm.attention || ""} onChange={(e) => setDetailQuotationDraftForm((f) => ({ ...f, attention: e.target.value }))} />
              </FormField>
              <FormField label="Engine">
                <TextInput value={detailQuotationDraftForm.engine || ""} onChange={(e) => setDetailQuotationDraftForm((f) => ({ ...f, engine: e.target.value }))} />
              </FormField>
              <FormField label="Model">
                <TextInput value={detailQuotationDraftForm.model || ""} onChange={(e) => setDetailQuotationDraftForm((f) => ({ ...f, model: e.target.value }))} />
              </FormField>
              <FormField label="Config">
                <TextInput value={detailQuotationDraftForm.config || ""} onChange={(e) => setDetailQuotationDraftForm((f) => ({ ...f, config: e.target.value }))} />
              </FormField>
              <FormField label="ESN">
                <TextInput value={detailQuotationDraftForm.esn || ""} onChange={(e) => setDetailQuotationDraftForm((f) => ({ ...f, esn: e.target.value }))} />
              </FormField>
            </div>

            <div className="mt-1">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-sm font-medium">Quotation Lines</span>
                <button
                  type="button"
                  className="text-sm underline"
                  onClick={() => setDetailQuotationDraftForm((f) => ({ ...f, lines: [...f.lines, emptyLine()] }))}
                >
                  + Add line
                </button>
              </div>
              <div className="w-full overflow-x-auto rounded-xl border">
                <table className="min-w-[1400px] w-full text-xs">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="px-2 py-2 text-left">S/N</th>
                      <th className="px-2 py-2 text-left">Article</th>
                      <th className="px-2 py-2 text-left">Part number</th>
                      <th className="px-2 py-2 text-left">Description</th>
                      <th className="px-2 py-2 text-left">UOM</th>
                      <th className="px-2 py-2 text-right">QTY</th>
                      <th className="px-2 py-2 text-right">Price</th>
                      <th className="px-2 py-2 text-right">Total</th>
                      <th className="px-2 py-2 text-left">Remarks</th>
                      <th className="px-2 py-2 text-left">Material</th>
                      <th className="px-2 py-2 text-left">Availability</th>
                      <th className="px-2 py-2 text-left">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detailQuotationDraftForm.lines.map((line, idx) => {
                      const qty = Number(line.qty || 0);
                      const price = Number(line.price || 0);
                      const totalPrice = qty * price;
                      return (
                        <tr key={idx} className="border-t">
                          <td className="px-2 py-1">{idx + 1}</td>
                          <td className="px-2 py-1">
                            <TextInput
                              value={line.article || ""}
                              onChange={(e) => {
                                const lines = [...detailQuotationDraftForm.lines];
                                lines[idx] = { ...line, article: e.target.value.toUpperCase(), serialNo: idx + 1, totalPrice };
                                setDetailQuotationDraftForm((f) => ({ ...f, lines }));
                              }}
                            />
                          </td>
                          <td className="px-2 py-1">
                            <TextInput
                              value={line.partNumber || ""}
                              onChange={(e) => {
                                const lines = [...detailQuotationDraftForm.lines];
                                lines[idx] = { ...line, partNumber: e.target.value, serialNo: idx + 1, totalPrice };
                                setDetailQuotationDraftForm((f) => ({ ...f, lines }));
                              }}
                            />
                          </td>
                          <td className="px-2 py-1">
                            <TextInput
                              value={line.description || ""}
                              onChange={(e) => {
                                const lines = [...detailQuotationDraftForm.lines];
                                lines[idx] = { ...line, description: e.target.value, serialNo: idx + 1, totalPrice };
                                setDetailQuotationDraftForm((f) => ({ ...f, lines }));
                              }}
                            />
                          </td>
                          <td className="px-2 py-1">
                            <TextInput
                              value={line.uom || ""}
                              onChange={(e) => {
                                const lines = [...detailQuotationDraftForm.lines];
                                lines[idx] = { ...line, uom: e.target.value, serialNo: idx + 1, totalPrice };
                                setDetailQuotationDraftForm((f) => ({ ...f, lines }));
                              }}
                            />
                          </td>
                          <td className="px-2 py-1">
                            <TextInput
                              type="number"
                              value={line.qty}
                              onChange={(e) => {
                                const nextQty = Number(e.target.value);
                                const lines = [...detailQuotationDraftForm.lines];
                                lines[idx] = { ...line, qty: nextQty, serialNo: idx + 1, totalPrice: nextQty * price };
                                setDetailQuotationDraftForm((f) => ({ ...f, lines }));
                              }}
                            />
                          </td>
                          <td className="px-2 py-1">
                            <TextInput
                              type="number"
                              step="0.01"
                              value={line.price}
                              onChange={(e) => {
                                const nextPrice = Number(e.target.value);
                                const lines = [...detailQuotationDraftForm.lines];
                                lines[idx] = { ...line, price: nextPrice, serialNo: idx + 1, totalPrice: qty * nextPrice };
                                setDetailQuotationDraftForm((f) => ({ ...f, lines }));
                              }}
                            />
                          </td>
                          <td className="px-2 py-1 text-right">{money(totalPrice)}</td>
                          <td className="px-2 py-1">
                            <TextInput
                              value={line.remarks || ""}
                              onChange={(e) => {
                                const lines = [...detailQuotationDraftForm.lines];
                                lines[idx] = { ...line, remarks: e.target.value, serialNo: idx + 1, totalPrice };
                                setDetailQuotationDraftForm((f) => ({ ...f, lines }));
                              }}
                            />
                          </td>
                          <td className="px-2 py-1">
                            <TextInput
                              value={line.materialCode || ""}
                              onChange={(e) => {
                                const lines = [...detailQuotationDraftForm.lines];
                                lines[idx] = { ...line, materialCode: e.target.value, serialNo: idx + 1, totalPrice };
                                setDetailQuotationDraftForm((f) => ({ ...f, lines }));
                              }}
                            />
                          </td>
                          <td className="px-2 py-1">
                            <TextInput
                              value={line.availability || ""}
                              onChange={(e) => {
                                const lines = [...detailQuotationDraftForm.lines];
                                lines[idx] = { ...line, availability: e.target.value, serialNo: idx + 1, totalPrice };
                                setDetailQuotationDraftForm((f) => ({ ...f, lines }));
                              }}
                            />
                          </td>
                          <td className="px-2 py-1">
                            <button
                              type="button"
                              className="rounded-xl border px-2 py-1 text-xs"
                              onClick={() => {
                                const lines = detailQuotationDraftForm.lines.filter((_, i) => i !== idx).map((l, i2) => ({ ...l, serialNo: i2 + 1 }));
                                setDetailQuotationDraftForm((f) => ({ ...f, lines: lines.length ? lines : [emptyLine()] }));
                              }}
                            >
                              Remove
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="ml-auto w-full max-w-sm rounded-xl border bg-white p-3">
              <div className="flex justify-between py-1">
                <span>Subtotal</span>
                <span>
                  {money(
                    detailQuotationDraftForm.lines.reduce((acc, l) => acc + Number(l.qty || 0) * Number(l.price || 0), 0)
                  )}
                </span>
              </div>
              <div className="flex justify-between py-1"><span>Discount</span><span>{money(detail.discountTotal)}</span></div>
              <div className="flex justify-between py-1"><span>Tax</span><span>{money(detail.taxTotal)}</span></div>
              <div className="flex justify-between py-1 text-base font-semibold">
                <span>Grand Total</span>
                <span>
                  {money(detailQuotationDraftForm.lines.reduce((acc, l) => acc + Number(l.qty || 0) * Number(l.price || 0), 0))}{" "}
                  {detailQuotationDraftForm.currency || ""}
                </span>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                className="rounded-xl bg-gray-900 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
                disabled={updateQuotationDetailMutation.isPending || !detailId}
                onClick={() => updateQuotationDetailMutation.mutate()}
              >
                {updateQuotationDetailMutation.isPending ? "Saving…" : "Save changes"}
              </button>
              <button type="button" className="rounded-xl border px-2 py-1 text-xs opacity-40" disabled title="Approve the quotation first">
                Convert to OA
              </button>
              <button type="button" className="rounded-xl border px-2 py-1 text-xs opacity-40" disabled title="Approve the quotation first">
                Convert to PI
              </button>
              <button type="button" className="rounded-xl border px-2 py-1 text-xs opacity-40" disabled title="Approve the quotation first">
                Convert to CIPL
              </button>
            </div>

            <div className="flex flex-wrap gap-2">
              {statusOptions.map((s) => (
                <button
                  key={s}
                  type="button"
                  disabled={s === detail.status || statusMutation.isPending}
                  className="rounded-xl border px-2 py-1 text-xs disabled:opacity-40"
                  onClick={() => statusMutation.mutate({ id: detail._id, nextStatus: s })}
                >
                  {s}
                </button>
              ))}
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className="rounded-xl border px-2 py-1 text-xs"
                onClick={() => {
                  apiGet(`/quotations/${detail._id}/print-data`)
                    .then((data) => renderPrintWindow(data))
                    .catch((e) => setErr(e.message));
                }}
              >
                Print
              </button>
              <button
                type="button"
                className="rounded-xl border px-2 py-1 text-xs"
                onClick={() => {
                  apiGet(`/quotations/${detail._id}/print-data`)
                    .then((data) => renderPrintWindow(data, true))
                    .catch((e) => setErr(e.message));
                }}
              >
                Export PDF
              </button>
            </div>
          </div>
        ) : tabContent === "quotation" && detail ? (
          <div className="space-y-4 text-sm">
            <div className="grid gap-3 sm:grid-cols-3">
              <div>
                <div className="text-gray-500">No</div>
                <div className="font-mono text-base">{detail.quotationNo}</div>
              </div>
              <div>
                <div className="text-gray-500">Customer</div>
                <div className="text-base">{detail.customerName}</div>
              </div>
              <div>
                <div className="text-gray-500">Status</div>
                <div>
                  <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ${statusBadgeClass(detail.status)}`}>
                    {detail.status}
                  </span>
                </div>
              </div>
            </div>

            {(detail.status === "APPROVED" || detail.status === "CONVERTED") && (
              <p className="text-xs text-gray-600">This quotation is locked — only print/export is allowed.</p>
            )}

            <div className="grid gap-3 md:grid-cols-2">
              <div className="rounded-xl border bg-gray-50 p-3">
                <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">Customer &amp; Address Info</div>
                <div><span className="font-medium">Customer:</span> {detail.customerName || "-"}</div>
                <div><span className="font-medium">Customer Ref:</span> {detail.customerReference || "-"}</div>
                <div><span className="font-medium">Attention:</span> {detail.attention || "-"}</div>
                <div><span className="font-medium">Billing:</span> {detail.customer?.billingAddress || "-"}</div>
                <div><span className="font-medium">Shipping:</span> {detail.customer?.shippingAddress || "-"}</div>
              </div>
              <div className="rounded-xl border bg-gray-50 p-3">
                <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">Engine Details</div>
                <div><span className="font-medium">Engine:</span> {detail.engine || "-"}</div>
                <div><span className="font-medium">Model:</span> {detail.model || "-"}</div>
                <div><span className="font-medium">Config:</span> {detail.config || "-"}</div>
                <div><span className="font-medium">ESN:</span> {detail.esn || "-"}</div>
                <div><span className="font-medium">Currency:</span> {detail.currency || "-"}</div>
              </div>
            </div>

            <div className="overflow-x-auto rounded-xl border">
              <table className="min-w-full text-sm">
                <thead className="bg-gray-100">
                  <tr>
                    <th className="px-3 py-2 text-left">S/N</th>
                    <th className="px-3 py-2 text-left">Part no</th>
                    <th className="px-3 py-2 text-left">Description</th>
                    <th className="px-3 py-2 text-left">UOM</th>
                    <th className="px-3 py-2 text-right">Qty</th>
                    <th className="px-3 py-2 text-right">Price</th>
                    <th className="px-3 py-2 text-right">Total</th>
                    <th className="px-3 py-2 text-left">Remarks</th>
                    <th className="px-3 py-2 text-left">Availability</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.lines?.map((line) => (
                    <tr key={line._id} className="border-t">
                      <td className="px-3 py-2">{line.serialNo}</td>
                      <td className="px-3 py-2">{line.partNumber}</td>
                      <td className="px-3 py-2">{line.description}</td>
                      <td className="px-3 py-2">{line.uom}</td>
                      <td className="px-3 py-2 text-right">{line.qty}</td>
                      <td className="px-3 py-2 text-right">{money(line.price)}</td>
                      <td className="px-3 py-2 text-right">{money(line.totalPrice)}</td>
                      <td className="px-3 py-2">{line.remarks || "-"}</td>
                      <td className="px-3 py-2">{line.availability || "-"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="ml-auto w-full max-w-sm rounded-xl border bg-white p-3">
              <div className="flex justify-between py-1"><span>Subtotal</span><span>{money(detail.subTotal)}</span></div>
              <div className="flex justify-between py-1"><span>Discount</span><span>{money(detail.discountTotal)}</span></div>
              <div className="flex justify-between py-1"><span>Tax</span><span>{money(detail.taxTotal)}</span></div>
              <div className="flex justify-between py-1 text-base font-semibold">
                <span>Grand Total</span>
                <span>{money(detail.grandTotal)} {detail.currency || ""}</span>
              </div>
            </div>

            <div className="flex flex-wrap gap-2">
              {statusOptions.map((s) => (
                <button
                  key={s}
                  type="button"
                  disabled={
                    s === detail.status ||
                    statusMutation.isPending ||
                    detail.status === "APPROVED" ||
                    detail.status === "CONVERTED"
                  }
                  className="rounded-xl border px-2 py-1 text-xs disabled:opacity-40"
                  onClick={() => statusMutation.mutate({ id: detail._id, nextStatus: s })}
                >
                  {s}
                </button>
              ))}
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className="rounded-xl border px-2 py-1 text-xs"
                onClick={() => {
                  apiGet(`/quotations/${detail._id}/print-data`)
                    .then((data) => renderPrintWindow(data))
                    .catch((e) => setErr(e.message));
                }}
              >
                Print
              </button>
              <button
                type="button"
                className="rounded-xl border px-2 py-1 text-xs"
                onClick={() => {
                  apiGet(`/quotations/${detail._id}/print-data`)
                    .then((data) => renderPrintWindow(data, true))
                    .catch((e) => setErr(e.message));
                }}
              >
                Export PDF
              </button>
              <button
                type="button"
                className={`rounded-xl border px-2 py-1 text-xs ${detail.status !== "APPROVED" ? "opacity-40" : ""}`}
                disabled={detail.status !== "APPROVED" || convertToOAMutation.isPending}
                title={detail.status !== "APPROVED" ? "Quotation must be APPROVED" : ""}
                onClick={() => convertToOAMutation.mutate(detail._id)}
              >
                Convert to OA
              </button>
              <button
                type="button"
                className={`rounded-xl border px-2 py-1 text-xs ${detail.status !== "APPROVED" ? "opacity-40" : ""}`}
                disabled={detail.status !== "APPROVED" || convertToProformaFromQuotationMutation.isPending}
                title={detail.status !== "APPROVED" ? "Quotation must be APPROVED" : ""}
                onClick={() => convertToProformaFromQuotationMutation.mutate(detail._id)}
              >
                Convert to PI
              </button>
              <button
                type="button"
                className={`rounded-xl border px-2 py-1 text-xs ${detail.status !== "APPROVED" ? "opacity-40" : ""}`}
                disabled={detail.status !== "APPROVED" || convertToCiplFromQuotationMutation.isPending}
                title={detail.status !== "APPROVED" ? "Quotation must be APPROVED" : ""}
                onClick={() => convertToCiplFromQuotationMutation.mutate(detail._id)}
              >
                Convert to CIPL
              </button>
            </div>
          </div>
        ) : tabContent === "quotation" ? (
          <p className="text-sm text-gray-500">Loading...</p>
        ) : tabContent === "oa" ? (
          !oaDetail ? (
            <p className="text-sm text-gray-500">Loading...</p>
          ) : !orderAcknowledgementLocked(oaDetail) && !detailOADraftForm ? (
            <p className="text-sm text-gray-500">Loading...</p>
          ) : !orderAcknowledgementLocked(oaDetail) && detailOADraftForm ? (
            <div className="space-y-4 text-sm">
              <div className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900 ring-1 ring-amber-200">
                Draft / open OA — edit and save below. Convert to PI or SI is available while not yet converted to those documents. Once converted to a Proforma or Sales Invoice this OA locks and shows{" "}
                <b>APPROVED</b>.
              </div>
              <div className="grid gap-3 sm:grid-cols-4">
                <FormField label="OA No">
                  <TextInput value={oaDetail.oaNo || ""} disabled className="bg-gray-50" />
                </FormField>
                <FormField label="OA Date">
                  <TextInput
                    type="date"
                    value={detailOADraftForm.oaDate}
                    onChange={(e) => setDetailOADraftForm((f) => ({ ...f, oaDate: e.target.value }))}
                  />
                </FormField>
                <FormField label="Currency">
                  <TextInput
                    value={detailOADraftForm.currency}
                    onChange={(e) => setDetailOADraftForm((f) => ({ ...f, currency: e.target.value.toUpperCase() }))}
                  />
                </FormField>
                <FormField label="Status">
                  <TextInput value={detailOADraftForm.status || ""} disabled className="bg-gray-50" />
                </FormField>
                <FormField label="Customer *">
                  <TextInput
                    value={detailOADraftForm.customerName}
                    onChange={(e) => setDetailOADraftForm((f) => ({ ...f, customerName: e.target.value }))}
                  />
                </FormField>
                <FormField label="Customer PO ref">
                  <TextInput
                    value={detailOADraftForm.customerPORef || ""}
                    onChange={(e) => setDetailOADraftForm((f) => ({ ...f, customerPORef: e.target.value }))}
                  />
                </FormField>
                <FormField label="Customer PO date">
                  <TextInput
                    type="date"
                    value={detailOADraftForm.customerPODate || ""}
                    onChange={(e) => setDetailOADraftForm((f) => ({ ...f, customerPODate: e.target.value }))}
                  />
                </FormField>
                <FormField label="Payment terms">
                  <TextInput
                    value={detailOADraftForm.paymentTerms || ""}
                    onChange={(e) => setDetailOADraftForm((f) => ({ ...f, paymentTerms: e.target.value }))}
                  />
                </FormField>
                <FormField label="Incoterm">
                  <TextInput value={detailOADraftForm.incoterm || ""} onChange={(e) => setDetailOADraftForm((f) => ({ ...f, incoterm: e.target.value }))} />
                </FormField>
                <FormField label="Delivery / schedule">
                  <TextInput
                    value={detailOADraftForm.deliverySchedule || ""}
                    onChange={(e) => setDetailOADraftForm((f) => ({ ...f, deliverySchedule: e.target.value }))}
                  />
                </FormField>
                <FormField label="Dispatch terms">
                  <TextInput
                    value={detailOADraftForm.dispatchTerms || ""}
                    onChange={(e) => setDetailOADraftForm((f) => ({ ...f, dispatchTerms: e.target.value }))}
                  />
                </FormField>
              </div>
              <FormField label="Acknowledgement notes">
                <textarea
                  className="w-full rounded-xl border px-3 py-2 text-sm"
                  rows={3}
                  value={detailOADraftForm.acknowledgementNotes || ""}
                  onChange={(e) => setDetailOADraftForm((f) => ({ ...f, acknowledgementNotes: e.target.value }))}
                />
              </FormField>
              <div className="text-xs text-gray-600">Linked Quotation: {oaDetail.linkedQuotationNo || "-"}</div>

              <div className="mt-1">
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-sm font-medium">OA Lines</span>
                  <button
                    type="button"
                    className="text-sm underline"
                    onClick={() => setDetailOADraftForm((f) => ({ ...f, lines: [...f.lines, emptyLine()] }))}
                  >
                    + Add line
                  </button>
                </div>
                <div className="w-full overflow-x-auto rounded-xl border">
                  <table className="min-w-[1200px] w-full text-xs">
                    <thead className="bg-gray-50">
                      <tr>
                        <th className="px-2 py-2 text-left">S/N</th>
                        <th className="px-2 py-2 text-left">Article</th>
                        <th className="px-2 py-2 text-left">Part number</th>
                        <th className="px-2 py-2 text-left">Description</th>
                        <th className="px-2 py-2 text-left">UOM</th>
                        <th className="px-2 py-2 text-right">QTY</th>
                        <th className="px-2 py-2 text-right">Price</th>
                        <th className="px-2 py-2 text-right">Total</th>
                        <th className="px-2 py-2 text-left">Remarks</th>
                        <th className="px-2 py-2 text-left">Material</th>
                        <th className="px-2 py-2 text-left">Avail.</th>
                        <th className="px-2 py-2 text-left">Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detailOADraftForm.lines.map((line, idx) => {
                        const qty = Number(line.qty || 0);
                        const price = Number(line.price || 0);
                        const totalPrice = qty * price;
                        return (
                          <tr key={idx} className="border-t">
                            <td className="px-2 py-1">{idx + 1}</td>
                            <td className="px-2 py-1">
                              <TextInput
                                value={line.article || ""}
                                onChange={(e) => {
                                  const lines = [...detailOADraftForm.lines];
                                  lines[idx] = { ...line, article: e.target.value.toUpperCase(), serialNo: idx + 1, totalPrice };
                                  setDetailOADraftForm((f) => ({ ...f, lines }));
                                }}
                              />
                            </td>
                            <td className="px-2 py-1">
                              <TextInput
                                value={line.partNumber || ""}
                                onChange={(e) => {
                                  const lines = [...detailOADraftForm.lines];
                                  lines[idx] = { ...line, partNumber: e.target.value, serialNo: idx + 1, totalPrice };
                                  setDetailOADraftForm((f) => ({ ...f, lines }));
                                }}
                              />
                            </td>
                            <td className="px-2 py-1">
                              <TextInput
                                value={line.description || ""}
                                onChange={(e) => {
                                  const lines = [...detailOADraftForm.lines];
                                  lines[idx] = { ...line, description: e.target.value, serialNo: idx + 1, totalPrice };
                                  setDetailOADraftForm((f) => ({ ...f, lines }));
                                }}
                              />
                            </td>
                            <td className="px-2 py-1">
                              <TextInput
                                value={line.uom || ""}
                                onChange={(e) => {
                                  const lines = [...detailOADraftForm.lines];
                                  lines[idx] = { ...line, uom: e.target.value, serialNo: idx + 1, totalPrice };
                                  setDetailOADraftForm((f) => ({ ...f, lines }));
                                }}
                              />
                            </td>
                            <td className="px-2 py-1">
                              <TextInput
                                type="number"
                                value={line.qty}
                                onChange={(e) => {
                                  const nextQty = Number(e.target.value);
                                  const lines = [...detailOADraftForm.lines];
                                  lines[idx] = { ...line, qty: nextQty, serialNo: idx + 1, totalPrice: nextQty * price };
                                  setDetailOADraftForm((f) => ({ ...f, lines }));
                                }}
                              />
                            </td>
                            <td className="px-2 py-1">
                              <TextInput
                                type="number"
                                step="0.01"
                                value={line.price}
                                onChange={(e) => {
                                  const nextPrice = Number(e.target.value);
                                  const lines = [...detailOADraftForm.lines];
                                  lines[idx] = { ...line, price: nextPrice, serialNo: idx + 1, totalPrice: qty * nextPrice };
                                  setDetailOADraftForm((f) => ({ ...f, lines }));
                                }}
                              />
                            </td>
                            <td className="px-2 py-1 text-right">{money(totalPrice)}</td>
                            <td className="px-2 py-1">
                              <TextInput
                                value={line.remarks || ""}
                                onChange={(e) => {
                                  const lines = [...detailOADraftForm.lines];
                                  lines[idx] = { ...line, remarks: e.target.value, serialNo: idx + 1, totalPrice };
                                  setDetailOADraftForm((f) => ({ ...f, lines }));
                                }}
                              />
                            </td>
                            <td className="px-2 py-1">
                              <TextInput
                                value={line.materialCode || ""}
                                onChange={(e) => {
                                  const lines = [...detailOADraftForm.lines];
                                  lines[idx] = { ...line, materialCode: e.target.value, serialNo: idx + 1, totalPrice };
                                  setDetailOADraftForm((f) => ({ ...f, lines }));
                                }}
                              />
                            </td>
                            <td className="px-2 py-1">
                              <TextInput
                                value={line.availability || ""}
                                onChange={(e) => {
                                  const lines = [...detailOADraftForm.lines];
                                  lines[idx] = { ...line, availability: e.target.value, serialNo: idx + 1, totalPrice };
                                  setDetailOADraftForm((f) => ({ ...f, lines }));
                                }}
                              />
                            </td>
                            <td className="px-2 py-1">
                              <button
                                type="button"
                                className="rounded-xl border px-2 py-1 text-xs"
                                onClick={() => {
                                  const lines = detailOADraftForm.lines.filter((_, i) => i !== idx).map((l, i2) => ({ ...l, serialNo: i2 + 1 }));
                                  setDetailOADraftForm((f) => ({ ...f, lines: lines.length ? lines : [emptyLine()] }));
                                }}
                              >
                                Remove
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="ml-auto w-full max-w-sm rounded-xl border bg-white p-3">
                <div className="flex justify-between py-1">
                  <span>Subtotal</span>
                  <span>
                    {money(detailOADraftForm.lines.reduce((acc, l) => acc + Number(l.qty || 0) * Number(l.price || 0), 0))}
                  </span>
                </div>
                <div className="flex justify-between py-1 text-base font-semibold">
                  <span>Grand Total</span>
                  <span>
                    {money(detailOADraftForm.lines.reduce((acc, l) => acc + Number(l.qty || 0) * Number(l.price || 0), 0))}{" "}
                    {detailOADraftForm.currency || ""}
                  </span>
                </div>
              </div>

              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  className="rounded-xl bg-gray-900 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
                  disabled={putOrderAcknowledgementMutation.isPending || !detailId}
                  onClick={() => putOrderAcknowledgementMutation.mutate({ body: detailOADraftForm })}
                >
                  {putOrderAcknowledgementMutation.isPending ? "Saving…" : "Save changes"}
                </button>
                <button type="button" className="rounded-xl border px-2 py-1 text-xs" onClick={() => openFlowDocumentPrint("oa", oaDetail._id)}>
                  Print
                </button>
                <button type="button" className="rounded-xl border px-2 py-1 text-xs" onClick={() => openFlowDocumentPrint("oa", oaDetail._id, true)}>
                  Export PDF
                </button>
                {(() => {
                  const conv = Array.isArray(oaDetail.convertedTo) ? oaDetail.convertedTo.map(String) : [];
                  const hasPI = conv.includes("PROFORMA");
                  const hasSI = conv.includes("SALES_INVOICE");
                  return (
                    <>
                      <button
                        type="button"
                        className={`rounded-xl border px-2 py-1 text-xs ${hasPI ? "opacity-40" : ""}`}
                        disabled={hasPI || convertToProformaFromOAMutation.isPending}
                        title={hasPI ? "Proforma already linked" : ""}
                        onClick={() => convertToProformaFromOAMutation.mutate(oaDetail._id)}
                      >
                        Convert to PI
                      </button>
                      <button
                        type="button"
                        className={`rounded-xl border px-2 py-1 text-xs ${hasSI ? "opacity-40" : ""}`}
                        disabled={hasSI || convertToSalesInvoiceFromOAMutation.isPending}
                        title={hasSI ? "Sales invoice already linked (from OA)" : ""}
                        onClick={() => convertToSalesInvoiceFromOAMutation.mutate(oaDetail._id)}
                      >
                        Convert to SI
                      </button>
                    </>
                  );
                })()}
                <button
                  type="button"
                  className="rounded-xl border px-2 py-1 text-xs"
                  onClick={() => convertToCiplFromOAMutation.mutate(oaDetail._id)}
                >
                  Convert to CIPL
                </button>
              </div>

              <div className="flex flex-wrap gap-2">
                {oaStatusOptions.map((s) => (
                  <button
                    key={s}
                    type="button"
                    disabled={s === detailOADraftForm.status || putOrderAcknowledgementMutation.isPending}
                    className="rounded-xl border px-2 py-1 text-xs disabled:opacity-40"
                    onClick={() =>
                      putOrderAcknowledgementMutation.mutate({ body: { ...detailOADraftForm, status: s } })
                    }
                  >
                    Set {s}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            (() => {
              const oc = Array.isArray(oaDetail.convertedTo) ? oaDetail.convertedTo.map(String) : [];
              const dupPIOpen = oc.includes("PROFORMA");
              const dupSIOpen = oc.includes("SALES_INVOICE");
              const displaySt = orderAcknowledgementDisplayStatus(oaDetail);
              return (
            <div className="space-y-3 text-sm">
              <p className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-700 ring-1 ring-slate-200">
                {dupPIOpen || dupSIOpen || displaySt === "APPROVED"
                  ? "This OA shows as Approved after conversion to PI and/or Sales Invoice — it cannot be edited. Print or export PDF when you need to share it."
                  : "This OA cannot be edited in its current state. Print or export PDF when you need to share it."}
              </p>
              <div className="grid gap-2 sm:grid-cols-3">
                <div>
                  <div className="text-gray-500">OA No</div>
                  <div className="font-mono">{oaDetail.oaNo}</div>
                </div>
                <div>
                  <div className="text-gray-500">Customer</div>
                  <div>{oaDetail.customerName}</div>
                </div>
                <div>
                  <div className="text-gray-500">Status</div>
                  <div>
                    <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ${statusBadgeClass(displaySt)}`}>
                      {displaySt}
                    </span>
                  </div>
                </div>
              </div>
              <div className="text-xs text-gray-600">Linked Quotation: {oaDetail.linkedQuotationNo || "-"}</div>
              {(oaDetail.acknowledgementNotes || oaDetail.deliverySchedule) && (
                <div className="rounded-xl border bg-gray-50 p-3 text-xs">
                  {oaDetail.deliverySchedule ? (
                    <div>
                      <span className="font-semibold text-gray-500">Delivery: </span>
                      {oaDetail.deliverySchedule}
                    </div>
                  ) : null}
                  {oaDetail.acknowledgementNotes ? (
                    <div className={oaDetail.deliverySchedule ? "mt-2 whitespace-pre-wrap" : "whitespace-pre-wrap"}>
                      <span className="font-semibold text-gray-500">Notes: </span>
                      {oaDetail.acknowledgementNotes}
                    </div>
                  ) : null}
                </div>
              )}
              <div className="overflow-x-auto rounded-xl border">
                <table className="min-w-full text-sm">
                  <thead className="bg-gray-100">
                    <tr>
                      <th className="px-3 py-2 text-left">S/N</th>
                      <th className="px-3 py-2 text-left">Article</th>
                      <th className="px-3 py-2 text-left">Part no</th>
                      <th className="px-3 py-2 text-left">Description</th>
                      <th className="px-3 py-2 text-left">UOM</th>
                      <th className="px-3 py-2 text-right">Qty</th>
                      <th className="px-3 py-2 text-right">Price</th>
                      <th className="px-3 py-2 text-right">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {oaDetail.lines?.map((line) => (
                      <tr key={line._id} className="border-t">
                        <td className="px-3 py-2">{line.serialNo}</td>
                        <td className="px-3 py-2">{line.article || "—"}</td>
                        <td className="px-3 py-2">{line.partNumber}</td>
                        <td className="px-3 py-2">{line.description}</td>
                        <td className="px-3 py-2">{line.uom}</td>
                        <td className="px-3 py-2 text-right">{line.qty}</td>
                        <td className="px-3 py-2 text-right">{money(line.price)}</td>
                        <td className="px-3 py-2 text-right">{money(line.totalPrice)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="ml-auto w-full max-w-sm rounded-xl border bg-white p-3">
                <div className="flex justify-between py-1"><span>Subtotal</span><span>{money(oaDetail.subTotal)}</span></div>
                <div className="flex justify-between py-1"><span>Discount</span><span>{money(oaDetail.discountTotal)}</span></div>
                <div className="flex justify-between py-1"><span>Tax</span><span>{money(oaDetail.taxTotal)}</span></div>
                <div className="flex justify-between py-1 text-base font-semibold">
                  <span>Grand Total</span>
                  <span>{money(oaDetail.grandTotal)} {oaDetail.currency || ""}</span>
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <button type="button" className="rounded-xl border px-2 py-1 text-xs" onClick={() => openFlowDocumentPrint("oa", oaDetail._id)}>
                  Print
                </button>
                <button type="button" className="rounded-xl border px-2 py-1 text-xs" onClick={() => openFlowDocumentPrint("oa", oaDetail._id, true)}>
                  Export PDF
                </button>
              </div>
              <div className="flex flex-wrap gap-2 opacity-70">
                <button
                  type="button"
                  className={`rounded-xl border px-2 py-1 text-xs ${dupPIOpen ? "opacity-40" : ""}`}
                  disabled={dupPIOpen}
                  onClick={() => convertToProformaFromOAMutation.mutate(oaDetail._id)}
                >
                  Convert to PI
                </button>
                <button
                  type="button"
                  className={`rounded-xl border px-2 py-1 text-xs ${dupSIOpen ? "opacity-40" : ""}`}
                  disabled={dupSIOpen}
                  onClick={() => convertToSalesInvoiceFromOAMutation.mutate(oaDetail._id)}
                >
                  Convert to SI
                </button>
                <button type="button" className="rounded-xl border px-2 py-1 text-xs" onClick={() => convertToCiplFromOAMutation.mutate(oaDetail._id)}>
                  Convert to CIPL
                </button>
              </div>
            </div>
              );
            })()
          )
        ) : tabContent === "proforma" ? (
          !proformaDetail ? (
          <p className="text-sm text-gray-500">Loading...</p>
        ) : (
          <div className="space-y-3 text-sm">
            <div className="grid gap-2 sm:grid-cols-3">
              <div>
                <div className="text-gray-500">PI No</div>
                <div className="font-mono">{proformaDetail.proformaNo}</div>
              </div>
              <div>
                <div className="text-gray-500">Customer</div>
                <div>{proformaDetail.customerName}</div>
              </div>
              <div>
                <div className="text-gray-500">Status</div>
                <div>
                  <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ${statusBadgeClass(proformaDetail.status)}`}>
                    {proformaDetail.status}
                  </span>
                </div>
              </div>
            </div>
            <div className="text-xs text-gray-600">
              Linked Quotation: {proformaDetail.linkedQuotationNo || "-"} | Linked OA: {proformaDetail.linkedOANo || "-"}
            </div>
            <div className="overflow-x-auto rounded-xl border">
              <table className="min-w-full text-sm">
                <thead className="bg-gray-100">
                  <tr>
                    <th className="px-3 py-2 text-left">S/N</th>
                    <th className="px-3 py-2 text-left">Part no</th>
                    <th className="px-3 py-2 text-left">Description</th>
                    <th className="px-3 py-2 text-left">UOM</th>
                    <th className="px-3 py-2 text-right">Qty</th>
                    <th className="px-3 py-2 text-right">Price</th>
                    <th className="px-3 py-2 text-right">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {proformaDetail.lines?.map((line) => (
                    <tr key={line._id} className="border-t">
                      <td className="px-3 py-2">{line.serialNo}</td>
                      <td className="px-3 py-2">{line.partNumber}</td>
                      <td className="px-3 py-2">{line.description}</td>
                      <td className="px-3 py-2">{line.uom}</td>
                      <td className="px-3 py-2 text-right">{line.qty}</td>
                      <td className="px-3 py-2 text-right">{money(line.price)}</td>
                      <td className="px-3 py-2 text-right">{money(line.totalPrice)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="ml-auto w-full max-w-sm rounded-xl border bg-white p-3">
              <div className="flex justify-between py-1"><span>Subtotal</span><span>{money(proformaDetail.subTotal)}</span></div>
              <div className="flex justify-between py-1"><span>Discount</span><span>{money(proformaDetail.discountTotal)}</span></div>
              <div className="flex justify-between py-1"><span>Tax</span><span>{money(proformaDetail.taxTotal)}</span></div>
              <div className="flex justify-between py-1 text-base font-semibold">
                <span>Grand Total</span>
                <span>{money(proformaDetail.grandTotal)} {proformaDetail.currency || ""}</span>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <button type="button" className="rounded-xl border px-2 py-1 text-xs" onClick={() => openFlowDocumentPrint("proforma", proformaDetail._id)}>
                Print
              </button>
              <button type="button" className="rounded-xl border px-2 py-1 text-xs" onClick={() => openFlowDocumentPrint("proforma", proformaDetail._id, true)}>
                Export PDF
              </button>
            </div>
            <div className="flex flex-wrap gap-2">
              {proformaStatusOptions.map((s) => (
                <button key={s} type="button" className="rounded-xl border px-2 py-1 text-xs" disabled>
                  {s}
                </button>
              ))}
            </div>
            <button
              type="button"
              className="rounded-xl border px-2 py-1 text-xs"
              onClick={() => convertProformaToSalesInvoiceMutation.mutate(proformaDetail._id)}
            >
              Convert to SI
            </button>
          </div>
        )
        ) : tabContent === "sales-invoice" ? (
          !salesInvoiceDetail ? (
            <p className="text-sm text-gray-500">Loading...</p>
          ) : (
            <div className="space-y-3 text-sm">
              <div className="grid gap-2 sm:grid-cols-3">
                <div>
                  <div className="text-gray-500">Invoice No</div>
                  <div className="font-mono">{salesInvoiceDetail.invoiceNo}</div>
                </div>
                <div>
                  <div className="text-gray-500">Customer</div>
                  <div>{salesInvoiceDetail.customerName}</div>
                </div>
                <div>
                  <div className="text-gray-500">Status</div>
                  <div>
                    <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ${statusBadgeClass(salesInvoiceDetail.status)}`}>
                      {salesInvoiceDetail.status}
                    </span>
                  </div>
                </div>
              </div>
              <div className="text-xs text-gray-600">
                Linked PI: {salesInvoiceDetail.linkedProformaNo || "-"} | Linked OA: {salesInvoiceDetail.linkedOANo || "-"}
              </div>
              <div className="overflow-x-auto rounded-xl border">
                <table className="min-w-full text-sm">
                  <thead className="bg-gray-100">
                    <tr>
                      <th className="px-3 py-2 text-left">S/N</th>
                      <th className="px-3 py-2 text-left">Part no</th>
                      <th className="px-3 py-2 text-left">Description</th>
                      <th className="px-3 py-2 text-left">UOM</th>
                      <th className="px-3 py-2 text-right">Qty</th>
                      <th className="px-3 py-2 text-right">Price</th>
                      <th className="px-3 py-2 text-right">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {salesInvoiceDetail.lines?.map((line) => (
                      <tr key={line._id} className="border-t">
                        <td className="px-3 py-2">{line.serialNo}</td>
                        <td className="px-3 py-2">{line.partNumber}</td>
                        <td className="px-3 py-2">{line.description}</td>
                        <td className="px-3 py-2">{line.uom}</td>
                        <td className="px-3 py-2 text-right">{line.qty}</td>
                        <td className="px-3 py-2 text-right">{money(line.price)}</td>
                        <td className="px-3 py-2 text-right">{money(line.totalPrice)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="ml-auto w-full max-w-sm rounded-xl border bg-white p-3">
                <div className="flex justify-between py-1"><span>Subtotal</span><span>{money(salesInvoiceDetail.subTotal)}</span></div>
                <div className="flex justify-between py-1"><span>Discount</span><span>{money(salesInvoiceDetail.discountTotal)}</span></div>
                <div className="flex justify-between py-1"><span>Tax</span><span>{money(salesInvoiceDetail.taxTotal)}</span></div>
                <div className="flex justify-between py-1 text-base font-semibold">
                  <span>Grand Total</span>
                  <span>{money(salesInvoiceDetail.grandTotal)} {salesInvoiceDetail.currency || ""}</span>
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <button type="button" className="rounded-xl border px-2 py-1 text-xs" onClick={() => openFlowDocumentPrint("sales-invoice", salesInvoiceDetail._id)}>
                  Print
                </button>
                <button type="button" className="rounded-xl border px-2 py-1 text-xs" onClick={() => openFlowDocumentPrint("sales-invoice", salesInvoiceDetail._id, true)}>
                  Export PDF
                </button>
              </div>
              <div className="flex flex-wrap gap-2">
                {salesInvoiceStatusOptions.map((s) => (
                  <button key={s} type="button" className="rounded-xl border px-2 py-1 text-xs" disabled>
                    {s}
                  </button>
                ))}
              </div>
              <button
                type="button"
                className="rounded-xl border px-2 py-1 text-xs"
                onClick={() => convertToCiplFromSalesInvoiceMutation.mutate(salesInvoiceDetail._id)}
              >
                Convert to CIPL
              </button>
            </div>
          )
        ) : !ciplDetail ? (
          <p className="text-sm text-gray-500">Loading...</p>
        ) : (
          <div className="space-y-3 text-sm">
            <div className="grid gap-2 sm:grid-cols-3">
              <div>
                <div className="text-gray-500">CIPL No</div>
                <div className="font-mono">{ciplDetail.ciplNo}</div>
              </div>
              <div>
                <div className="text-gray-500">Customer</div>
                <div>{ciplDetail.customerName}</div>
              </div>
              <div>
                <div className="text-gray-500">Status</div>
                <div>
                  <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ${statusBadgeClass(ciplDetail.status)}`}>
                    {ciplDetail.status}
                  </span>
                </div>
              </div>
            </div>
            <div className="text-xs text-gray-600">
              Linked Quotation: {ciplDetail.linkedQuotationNo || "-"} | Linked OA: {ciplDetail.linkedOANo || "-"} | Linked Invoice:{" "}
              {ciplDetail.linkedSalesInvoiceNo || "-"}
            </div>
            <div className="overflow-x-auto rounded-xl border">
              <table className="min-w-full text-sm">
                <thead className="bg-gray-100">
                  <tr>
                    <th className="px-3 py-2 text-left">S/N</th>
                    <th className="px-3 py-2 text-left">Part no</th>
                    <th className="px-3 py-2 text-left">Description</th>
                    <th className="px-3 py-2 text-left">UOM</th>
                    <th className="px-3 py-2 text-right">Qty</th>
                    <th className="px-3 py-2 text-right">Price</th>
                    <th className="px-3 py-2 text-right">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {ciplDetail.lines?.map((line) => (
                    <tr key={line._id} className="border-t">
                      <td className="px-3 py-2">{line.serialNo}</td>
                      <td className="px-3 py-2">{line.partNumber}</td>
                      <td className="px-3 py-2">{line.description}</td>
                      <td className="px-3 py-2">{line.uom}</td>
                      <td className="px-3 py-2 text-right">{line.qty}</td>
                      <td className="px-3 py-2 text-right">{money(line.price)}</td>
                      <td className="px-3 py-2 text-right">{money(line.totalPrice)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="ml-auto w-full max-w-sm rounded-xl border bg-white p-3">
              <div className="flex justify-between py-1"><span>Subtotal</span><span>{money(ciplDetail.subTotal)}</span></div>
              <div className="flex justify-between py-1"><span>Discount</span><span>{money(ciplDetail.discountTotal)}</span></div>
              <div className="flex justify-between py-1"><span>Tax</span><span>{money(ciplDetail.taxTotal)}</span></div>
              <div className="flex justify-between py-1 text-base font-semibold">
                <span>Grand Total</span>
                <span>{money(ciplDetail.grandTotal)} {ciplDetail.currency || ""}</span>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <button type="button" className="rounded-xl border px-2 py-1 text-xs" onClick={() => openFlowDocumentPrint("cipl", ciplDetail._id)}>
                Print
              </button>
              <button type="button" className="rounded-xl border px-2 py-1 text-xs" onClick={() => openFlowDocumentPrint("cipl", ciplDetail._id, true)}>
                Export PDF
              </button>
            </div>
            <div className="flex flex-wrap gap-2">
              {ciplStatusOptions.map((s) => (
                <button key={s} type="button" className="rounded-xl border px-2 py-1 text-xs" disabled>
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
      </Modal>

      <Modal open={customerCreateOpen} onClose={() => setCustomerCreateOpen(false)} title="New Customer" wide>
        <div className="grid gap-3 sm:grid-cols-3">
          <FormField label="Customer Name *">
            <TextInput value={customerForm.name} onChange={(e) => setCustomerForm((f) => ({ ...f, name: e.target.value }))} />
          </FormField>
          <FormField label="Contact Name">
            <TextInput
              value={customerForm.contactName}
              onChange={(e) => setCustomerForm((f) => ({ ...f, contactName: e.target.value }))}
            />
          </FormField>
          <FormField label="Phone">
            <TextInput value={customerForm.phone} onChange={(e) => setCustomerForm((f) => ({ ...f, phone: e.target.value }))} />
          </FormField>
          <FormField label="Email">
            <TextInput value={customerForm.email} onChange={(e) => setCustomerForm((f) => ({ ...f, email: e.target.value }))} />
          </FormField>
          <FormField label="Payment Terms">
            <select
              className="w-full rounded-xl border px-3 py-2 text-sm"
              value={customerForm.paymentTerms}
              onChange={(e) => setCustomerForm((f) => ({ ...f, paymentTerms: e.target.value }))}
            >
              <option value="CREDIT">CREDIT</option>
              <option value="ADVANCE">ADVANCE</option>
            </select>
          </FormField>
          <FormField label="Address">
            <TextInput
              value={customerForm.address}
              onChange={(e) => setCustomerForm((f) => ({ ...f, address: e.target.value }))}
            />
          </FormField>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" className="rounded-xl border px-4 py-2 text-sm" onClick={() => setCustomerCreateOpen(false)}>
            Cancel
          </button>
          <button
            type="button"
            className="rounded-xl bg-gray-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
            disabled={createCustomerMutation.isPending}
            onClick={() => createCustomerMutation.mutate()}
          >
            {createCustomerMutation.isPending ? "Saving..." : "Create Customer"}
          </button>
        </div>
      </Modal>

      <Modal
        open={createOpen}
        onClose={() => {
          setIsQuotationNoEdited(false);
          setCreateOpen(false);
        }}
        title="New Quotation"
        subtitle="Enter header details, add lines manually or import from CSV. Required per line: Article, Description, quantity."
        xlarge
      >
        <div className="grid gap-3 sm:grid-cols-4">
          <FormField label="Quotation No">
            <TextInput
              value={form.quotationNo || ""}
              onChange={(e) => {
                setIsQuotationNoEdited(true);
                setForm((f) => ({ ...f, quotationNo: e.target.value }));
              }}
            />
          </FormField>
          <FormField label="Quotation Date">
            <TextInput
              type="date"
              value={form.quotationDate}
              onChange={(e) => {
                setIsQuotationNoEdited(false);
                setForm((f) => ({ ...f, quotationDate: e.target.value }));
              }}
            />
          </FormField>
          <FormField label="Validity Date">
            <TextInput
              type="date"
              value={form.validityDate}
              onChange={(e) => setForm((f) => ({ ...f, validityDate: e.target.value }))}
            />
          </FormField>
          <FormField label="Currency">
            <TextInput
              value={form.currency}
              onChange={(e) => setForm((f) => ({ ...f, currency: e.target.value.toUpperCase() }))}
            />
          </FormField>
          <FormField label="Customer *">
            <select
              className="w-full rounded-xl border px-3 py-2 text-sm"
              value={form.customerId || ""}
              onChange={(e) => {
                const selectedId = e.target.value;
                const selected = customerOptions.find((c) => c._id === selectedId);
                setForm((f) => ({
                  ...f,
                  customerId: selectedId,
                  customerName: selected?.name || "",
                }));
              }}
            >
              <option value="">Select customer from Customer Master</option>
              {customerOptions.map((c) => (
                <option key={c._id} value={c._id}>
                  {c.name}
                </option>
              ))}
            </select>
          </FormField>
          <FormField label="Customer Ref">
            <TextInput
              value={form.customerReference}
              onChange={(e) => setForm((f) => ({ ...f, customerReference: e.target.value }))}
            />
          </FormField>
          <FormField label="Attention">
            <TextInput
              value={form.attention}
              onChange={(e) => setForm((f) => ({ ...f, attention: e.target.value }))}
            />
          </FormField>
          <FormField label="Engine">
            <TextInput value={form.engine} onChange={(e) => setForm((f) => ({ ...f, engine: e.target.value }))} />
          </FormField>
          <FormField label="Model">
            <TextInput value={form.model} onChange={(e) => setForm((f) => ({ ...f, model: e.target.value }))} />
          </FormField>
          <FormField label="Config">
            <TextInput value={form.config || ""} onChange={(e) => setForm((f) => ({ ...f, config: e.target.value }))} />
          </FormField>
          <FormField label="ESN">
            <TextInput value={form.esn} onChange={(e) => setForm((f) => ({ ...f, esn: e.target.value }))} />
          </FormField>
        </div>

        <div className="mt-6">
          <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <span className="text-sm font-semibold text-slate-800">Quotation lines</span>
            <div className="flex flex-wrap items-center gap-2">
              <input
                ref={quotationCsvInputRef}
                type="file"
                accept=".csv,text/csv"
                className="hidden"
                onChange={handleQuotationLinesCsvSelected}
              />
              <button
                type="button"
                className="rounded-xl border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-800 shadow-sm hover:bg-slate-50"
                onClick={() => quotationCsvInputRef.current?.click()}
              >
                Import CSV
              </button>
              <button
                type="button"
                className="rounded-xl border border-transparent px-3 py-1.5 text-sm font-medium text-slate-600 underline underline-offset-2 hover:text-slate-900"
                onClick={downloadQuotationLinesCsvTemplate}
              >
                Download sample CSV
              </button>
              <button
                type="button"
                className="rounded-xl bg-slate-900 px-3 py-1.5 text-sm font-semibold text-white shadow-sm hover:bg-slate-800"
                onClick={() => setForm((f) => ({ ...f, lines: [...f.lines, emptyLine()] }))}
              >
                + Add line
              </button>
            </div>
          </div>
          <div className="w-full overflow-x-auto rounded-xl border border-slate-200 shadow-sm">
            <table className="min-w-[1400px] w-full text-xs">
              <thead className="bg-slate-50">
                <tr>
                  <th className="px-2 py-2 text-left">Serial number</th>
                  <th className="px-2 py-2 text-left">Article</th>
                  <th className="px-2 py-2 text-left">Part number</th>
                  <th className="px-2 py-2 text-left">Description</th>
                  <th className="px-2 py-2 text-left">UOM</th>
                  <th className="px-2 py-2 text-right">QTY</th>
                  <th className="px-2 py-2 text-right">Price</th>
                  <th className="px-2 py-2 text-right">Total price</th>
                  <th className="px-2 py-2 text-left">Remarks</th>
                  <th className="px-2 py-2 text-left">Material code</th>
                  <th className="px-2 py-2 text-left">Availability</th>
                  <th className="px-2 py-2 text-left">Action</th>
                </tr>
              </thead>
              <tbody>
                {form.lines.map((line, idx) => {
                  const qty = Number(line.qty || 0);
                  const price = Number(line.price || 0);
                  const totalPrice = qty * price;
                  return (
                    <tr key={idx} className="border-t">
                      <td className="px-2 py-1">{idx + 1}</td>
                      <td className="px-2 py-1">
                        <TextInput
                          value={line.article || ""}
                          onChange={(e) => {
                            const lines = [...form.lines];
                            lines[idx] = { ...line, article: e.target.value.toUpperCase(), serialNo: idx + 1, totalPrice };
                            setForm((f) => ({ ...f, lines }));
                          }}
                        />
                      </td>
                      <td className="px-2 py-1">
                        <TextInput
                          value={line.partNumber || ""}
                          onChange={(e) => {
                            const lines = [...form.lines];
                            lines[idx] = { ...line, partNumber: e.target.value, serialNo: idx + 1, totalPrice };
                            setForm((f) => ({ ...f, lines }));
                          }}
                        />
                      </td>
                      <td className="px-2 py-1">
                        <TextInput
                          value={line.description || ""}
                          onChange={(e) => {
                            const lines = [...form.lines];
                            lines[idx] = { ...line, description: e.target.value, serialNo: idx + 1, totalPrice };
                            setForm((f) => ({ ...f, lines }));
                          }}
                        />
                      </td>
                      <td className="px-2 py-1">
                        <TextInput
                          value={line.uom || ""}
                          onChange={(e) => {
                            const lines = [...form.lines];
                            lines[idx] = { ...line, uom: e.target.value, serialNo: idx + 1, totalPrice };
                            setForm((f) => ({ ...f, lines }));
                          }}
                        />
                      </td>
                      <td className="px-2 py-1">
                        <TextInput
                          type="number"
                          value={line.qty}
                          onChange={(e) => {
                            const nextQty = Number(e.target.value);
                            const lines = [...form.lines];
                            lines[idx] = { ...line, qty: nextQty, serialNo: idx + 1, totalPrice: nextQty * price };
                            setForm((f) => ({ ...f, lines }));
                          }}
                        />
                      </td>
                      <td className="px-2 py-1">
                        <TextInput
                          type="number"
                          step="0.01"
                          value={line.price}
                          onChange={(e) => {
                            const nextPrice = Number(e.target.value);
                            const lines = [...form.lines];
                            lines[idx] = { ...line, price: nextPrice, serialNo: idx + 1, totalPrice: qty * nextPrice };
                            setForm((f) => ({ ...f, lines }));
                          }}
                        />
                      </td>
                      <td className="px-2 py-1 text-right">{money(totalPrice)}</td>
                      <td className="px-2 py-1">
                        <TextInput
                          value={line.remarks || ""}
                          onChange={(e) => {
                            const lines = [...form.lines];
                            lines[idx] = { ...line, remarks: e.target.value, serialNo: idx + 1, totalPrice };
                            setForm((f) => ({ ...f, lines }));
                          }}
                        />
                      </td>
                      <td className="px-2 py-1">
                        <TextInput
                          value={line.materialCode || ""}
                          onChange={(e) => {
                            const lines = [...form.lines];
                            lines[idx] = { ...line, materialCode: e.target.value, serialNo: idx + 1, totalPrice };
                            setForm((f) => ({ ...f, lines }));
                          }}
                        />
                      </td>
                      <td className="px-2 py-1">
                        <TextInput
                          value={line.availability || ""}
                          onChange={(e) => {
                            const lines = [...form.lines];
                            lines[idx] = { ...line, availability: e.target.value, serialNo: idx + 1, totalPrice };
                            setForm((f) => ({ ...f, lines }));
                          }}
                        />
                      </td>
                      <td className="px-2 py-1">
                        <button
                          type="button"
                          className="rounded-xl border px-2 py-1 text-xs"
                          onClick={() => {
                            const lines = form.lines.filter((_, i) => i !== idx).map((l, i2) => ({ ...l, serialNo: i2 + 1 }));
                            setForm((f) => ({ ...f, lines: lines.length ? lines : [emptyLine()] }));
                          }}
                        >
                          Remove
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            className="rounded-xl border px-4 py-2 text-sm"
            onClick={() => {
              setIsQuotationNoEdited(false);
              setCreateOpen(false);
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            className="rounded-xl bg-gray-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
            disabled={createMutation.isPending}
            onClick={() => {
              setErr("");
              if (!form.customerId) {
                setErr("Please select customer from Customer Master");
                return;
              }
              createMutation.mutate();
            }}
          >
            {createMutation.isPending ? "Saving..." : "Create Quotation"}
          </button>
        </div>
      </Modal>

      <Modal open={oaCreateOpen} onClose={() => setOaCreateOpen(false)} title="New Order Acknowledgement" wide>
        <div className="grid gap-3 sm:grid-cols-4">
          <FormField label="OA Date">
            <TextInput type="date" value={oaForm.oaDate} onChange={(e) => setOaForm((f) => ({ ...f, oaDate: e.target.value }))} />
          </FormField>
          <FormField label="Customer *">
            <TextInput value={oaForm.customerName} onChange={(e) => setOaForm((f) => ({ ...f, customerName: e.target.value }))} />
          </FormField>
          <FormField label="Payment Terms">
            <TextInput value={oaForm.paymentTerms} onChange={(e) => setOaForm((f) => ({ ...f, paymentTerms: e.target.value }))} />
          </FormField>
          <FormField label="Currency">
            <TextInput value={oaForm.currency} onChange={(e) => setOaForm((f) => ({ ...f, currency: e.target.value.toUpperCase() }))} />
          </FormField>
        </div>
        <div className="mt-4">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-sm font-medium">OA Lines</span>
            <button type="button" className="text-sm underline" onClick={() => setOaForm((f) => ({ ...f, lines: [...f.lines, emptyLine()] }))}>
              + Add line
            </button>
          </div>
          <div className="space-y-2">
            {oaForm.lines.map((line, idx) => (
              <div key={idx} className="grid gap-2 rounded-xl border p-2 sm:grid-cols-8">
                <TextInput
                  placeholder="Item code"
                  value={line.itemCode}
                  onChange={(e) => {
                    const lines = [...oaForm.lines];
                    lines[idx] = { ...line, itemCode: e.target.value };
                    setOaForm((f) => ({ ...f, lines }));
                  }}
                />
                <TextInput
                  placeholder="Description"
                  value={line.description}
                  onChange={(e) => {
                    const lines = [...oaForm.lines];
                    lines[idx] = { ...line, description: e.target.value };
                    setOaForm((f) => ({ ...f, lines }));
                  }}
                />
                <TextInput
                  type="number"
                  placeholder="Qty"
                  value={line.qty}
                  onChange={(e) => {
                    const lines = [...oaForm.lines];
                    lines[idx] = { ...line, qty: Number(e.target.value) };
                    setOaForm((f) => ({ ...f, lines }));
                  }}
                />
                <TextInput
                  placeholder="Unit"
                  value={line.unit}
                  onChange={(e) => {
                    const lines = [...oaForm.lines];
                    lines[idx] = { ...line, unit: e.target.value };
                    setOaForm((f) => ({ ...f, lines }));
                  }}
                />
                <TextInput
                  type="number"
                  step="0.01"
                  placeholder="Price"
                  value={line.salePrice}
                  onChange={(e) => {
                    const lines = [...oaForm.lines];
                    lines[idx] = { ...line, salePrice: Number(e.target.value) };
                    setOaForm((f) => ({ ...f, lines }));
                  }}
                />
                <TextInput
                  type="number"
                  step="0.01"
                  placeholder="Disc %"
                  value={line.discountPct}
                  onChange={(e) => {
                    const lines = [...oaForm.lines];
                    lines[idx] = { ...line, discountPct: Number(e.target.value) };
                    setOaForm((f) => ({ ...f, lines }));
                  }}
                />
                <TextInput
                  type="number"
                  step="0.01"
                  placeholder="Tax %"
                  value={line.taxPct}
                  onChange={(e) => {
                    const lines = [...oaForm.lines];
                    lines[idx] = { ...line, taxPct: Number(e.target.value) };
                    setOaForm((f) => ({ ...f, lines }));
                  }}
                />
                <button
                  type="button"
                  className="rounded-xl border px-2 py-1 text-xs"
                  onClick={() => {
                    const lines = oaForm.lines.filter((_, i) => i !== idx);
                    setOaForm((f) => ({ ...f, lines: lines.length ? lines : [emptyLine()] }));
                  }}
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" className="rounded-xl border px-4 py-2 text-sm" onClick={() => setOaCreateOpen(false)}>
            Cancel
          </button>
          <button
            type="button"
            className="rounded-xl bg-gray-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
            disabled={createOAMutation.isPending}
            onClick={() => createOAMutation.mutate()}
          >
            {createOAMutation.isPending ? "Saving..." : "Create OA"}
          </button>
        </div>
      </Modal>

      <Modal open={proformaCreateOpen} onClose={() => setProformaCreateOpen(false)} title="New Proforma Invoice" wide>
        <div className="grid gap-3 sm:grid-cols-4">
          <FormField label="PI Date">
            <TextInput
              type="date"
              value={proformaForm.proformaDate}
              onChange={(e) => setProformaForm((f) => ({ ...f, proformaDate: e.target.value }))}
            />
          </FormField>
          <FormField label="Customer *">
            <TextInput value={proformaForm.customerName} onChange={(e) => setProformaForm((f) => ({ ...f, customerName: e.target.value }))} />
          </FormField>
          <FormField label="Payment Terms">
            <TextInput value={proformaForm.paymentTerms} onChange={(e) => setProformaForm((f) => ({ ...f, paymentTerms: e.target.value }))} />
          </FormField>
          <FormField label="Currency">
            <TextInput value={proformaForm.currency} onChange={(e) => setProformaForm((f) => ({ ...f, currency: e.target.value.toUpperCase() }))} />
          </FormField>
        </div>
        <div className="mt-4">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-sm font-medium">PI Lines</span>
            <button
              type="button"
              className="text-sm underline"
              onClick={() => setProformaForm((f) => ({ ...f, lines: [...f.lines, emptyLine()] }))}
            >
              + Add line
            </button>
          </div>
          <div className="space-y-2">
            {proformaForm.lines.map((line, idx) => (
              <div key={idx} className="grid gap-2 rounded-xl border p-2 sm:grid-cols-8">
                <TextInput
                  placeholder="Item code"
                  value={line.itemCode}
                  onChange={(e) => {
                    const lines = [...proformaForm.lines];
                    lines[idx] = { ...line, itemCode: e.target.value };
                    setProformaForm((f) => ({ ...f, lines }));
                  }}
                />
                <TextInput
                  placeholder="Description"
                  value={line.description}
                  onChange={(e) => {
                    const lines = [...proformaForm.lines];
                    lines[idx] = { ...line, description: e.target.value };
                    setProformaForm((f) => ({ ...f, lines }));
                  }}
                />
                <TextInput
                  type="number"
                  placeholder="Qty"
                  value={line.qty}
                  onChange={(e) => {
                    const lines = [...proformaForm.lines];
                    lines[idx] = { ...line, qty: Number(e.target.value) };
                    setProformaForm((f) => ({ ...f, lines }));
                  }}
                />
                <TextInput
                  placeholder="Unit"
                  value={line.unit}
                  onChange={(e) => {
                    const lines = [...proformaForm.lines];
                    lines[idx] = { ...line, unit: e.target.value };
                    setProformaForm((f) => ({ ...f, lines }));
                  }}
                />
                <TextInput
                  type="number"
                  step="0.01"
                  placeholder="Price"
                  value={line.salePrice}
                  onChange={(e) => {
                    const lines = [...proformaForm.lines];
                    lines[idx] = { ...line, salePrice: Number(e.target.value) };
                    setProformaForm((f) => ({ ...f, lines }));
                  }}
                />
                <TextInput
                  type="number"
                  step="0.01"
                  placeholder="Disc %"
                  value={line.discountPct}
                  onChange={(e) => {
                    const lines = [...proformaForm.lines];
                    lines[idx] = { ...line, discountPct: Number(e.target.value) };
                    setProformaForm((f) => ({ ...f, lines }));
                  }}
                />
                <TextInput
                  type="number"
                  step="0.01"
                  placeholder="Tax %"
                  value={line.taxPct}
                  onChange={(e) => {
                    const lines = [...proformaForm.lines];
                    lines[idx] = { ...line, taxPct: Number(e.target.value) };
                    setProformaForm((f) => ({ ...f, lines }));
                  }}
                />
                <button
                  type="button"
                  className="rounded-xl border px-2 py-1 text-xs"
                  onClick={() => {
                    const lines = proformaForm.lines.filter((_, i) => i !== idx);
                    setProformaForm((f) => ({ ...f, lines: lines.length ? lines : [emptyLine()] }));
                  }}
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" className="rounded-xl border px-4 py-2 text-sm" onClick={() => setProformaCreateOpen(false)}>
            Cancel
          </button>
          <button
            type="button"
            className="rounded-xl bg-gray-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
            disabled={createProformaMutation.isPending}
            onClick={() => createProformaMutation.mutate()}
          >
            {createProformaMutation.isPending ? "Saving..." : "Create PI"}
          </button>
        </div>
      </Modal>

      <Modal open={salesInvoiceCreateOpen} onClose={() => setSalesInvoiceCreateOpen(false)} title="New Sales Invoice" wide>
        <div className="grid gap-3 sm:grid-cols-4">
          <FormField label="Invoice Date">
            <TextInput
              type="date"
              value={salesInvoiceForm.invoiceDate}
              onChange={(e) => setSalesInvoiceForm((f) => ({ ...f, invoiceDate: e.target.value }))}
            />
          </FormField>
          <FormField label="Customer *">
            <TextInput
              value={salesInvoiceForm.customerName}
              onChange={(e) => setSalesInvoiceForm((f) => ({ ...f, customerName: e.target.value }))}
            />
          </FormField>
          <FormField label="Payment Terms">
            <TextInput
              value={salesInvoiceForm.paymentTerms}
              onChange={(e) => setSalesInvoiceForm((f) => ({ ...f, paymentTerms: e.target.value }))}
            />
          </FormField>
          <FormField label="Currency">
            <TextInput
              value={salesInvoiceForm.currency}
              onChange={(e) => setSalesInvoiceForm((f) => ({ ...f, currency: e.target.value.toUpperCase() }))}
            />
          </FormField>
        </div>
        <div className="mt-4">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-sm font-medium">Invoice Lines</span>
            <button
              type="button"
              className="text-sm underline"
              onClick={() => setSalesInvoiceForm((f) => ({ ...f, lines: [...f.lines, emptyLine()] }))}
            >
              + Add line
            </button>
          </div>
          <div className="space-y-2">
            {salesInvoiceForm.lines.map((line, idx) => (
              <div key={idx} className="grid gap-2 rounded-xl border p-2 sm:grid-cols-8">
                <TextInput
                  placeholder="Item code"
                  value={line.itemCode}
                  onChange={(e) => {
                    const lines = [...salesInvoiceForm.lines];
                    lines[idx] = { ...line, itemCode: e.target.value };
                    setSalesInvoiceForm((f) => ({ ...f, lines }));
                  }}
                />
                <TextInput
                  placeholder="Description"
                  value={line.description}
                  onChange={(e) => {
                    const lines = [...salesInvoiceForm.lines];
                    lines[idx] = { ...line, description: e.target.value };
                    setSalesInvoiceForm((f) => ({ ...f, lines }));
                  }}
                />
                <TextInput
                  type="number"
                  placeholder="Qty"
                  value={line.qty}
                  onChange={(e) => {
                    const lines = [...salesInvoiceForm.lines];
                    lines[idx] = { ...line, qty: Number(e.target.value) };
                    setSalesInvoiceForm((f) => ({ ...f, lines }));
                  }}
                />
                <TextInput
                  placeholder="Unit"
                  value={line.unit}
                  onChange={(e) => {
                    const lines = [...salesInvoiceForm.lines];
                    lines[idx] = { ...line, unit: e.target.value };
                    setSalesInvoiceForm((f) => ({ ...f, lines }));
                  }}
                />
                <TextInput
                  type="number"
                  step="0.01"
                  placeholder="Price"
                  value={line.salePrice}
                  onChange={(e) => {
                    const lines = [...salesInvoiceForm.lines];
                    lines[idx] = { ...line, salePrice: Number(e.target.value) };
                    setSalesInvoiceForm((f) => ({ ...f, lines }));
                  }}
                />
                <TextInput
                  type="number"
                  step="0.01"
                  placeholder="Disc %"
                  value={line.discountPct}
                  onChange={(e) => {
                    const lines = [...salesInvoiceForm.lines];
                    lines[idx] = { ...line, discountPct: Number(e.target.value) };
                    setSalesInvoiceForm((f) => ({ ...f, lines }));
                  }}
                />
                <TextInput
                  type="number"
                  step="0.01"
                  placeholder="Tax %"
                  value={line.taxPct}
                  onChange={(e) => {
                    const lines = [...salesInvoiceForm.lines];
                    lines[idx] = { ...line, taxPct: Number(e.target.value) };
                    setSalesInvoiceForm((f) => ({ ...f, lines }));
                  }}
                />
                <button
                  type="button"
                  className="rounded-xl border px-2 py-1 text-xs"
                  onClick={() => {
                    const lines = salesInvoiceForm.lines.filter((_, i) => i !== idx);
                    setSalesInvoiceForm((f) => ({ ...f, lines: lines.length ? lines : [emptyLine()] }));
                  }}
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" className="rounded-xl border px-4 py-2 text-sm" onClick={() => setSalesInvoiceCreateOpen(false)}>
            Cancel
          </button>
          <button
            type="button"
            className="rounded-xl bg-gray-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
            disabled={createSalesInvoiceMutation.isPending}
            onClick={() => createSalesInvoiceMutation.mutate()}
          >
            {createSalesInvoiceMutation.isPending ? "Saving..." : "Create Sales Invoice"}
          </button>
        </div>
      </Modal>

      <Modal open={ciplCreateOpen} onClose={() => setCiplCreateOpen(false)} title="New CIPL" wide>
        <div className="grid gap-3 sm:grid-cols-4">
          <FormField label="CIPL Date">
            <TextInput type="date" value={ciplForm.ciplDate} onChange={(e) => setCiplForm((f) => ({ ...f, ciplDate: e.target.value }))} />
          </FormField>
          <FormField label="Customer *">
            <TextInput value={ciplForm.customerName} onChange={(e) => setCiplForm((f) => ({ ...f, customerName: e.target.value }))} />
          </FormField>
          <FormField label="Consignee">
            <TextInput value={ciplForm.consigneeName} onChange={(e) => setCiplForm((f) => ({ ...f, consigneeName: e.target.value }))} />
          </FormField>
          <FormField label="Currency">
            <TextInput value={ciplForm.currency} onChange={(e) => setCiplForm((f) => ({ ...f, currency: e.target.value.toUpperCase() }))} />
          </FormField>
        </div>
        <div className="mt-4">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-sm font-medium">CIPL Lines</span>
            <button type="button" className="text-sm underline" onClick={() => setCiplForm((f) => ({ ...f, lines: [...f.lines, emptyLine()] }))}>
              + Add line
            </button>
          </div>
          <div className="space-y-2">
            {ciplForm.lines.map((line, idx) => (
              <div key={idx} className="grid gap-2 rounded-xl border p-2 sm:grid-cols-8">
                <TextInput
                  placeholder="Item code"
                  value={line.itemCode}
                  onChange={(e) => {
                    const lines = [...ciplForm.lines];
                    lines[idx] = { ...line, itemCode: e.target.value };
                    setCiplForm((f) => ({ ...f, lines }));
                  }}
                />
                <TextInput
                  placeholder="Description"
                  value={line.description}
                  onChange={(e) => {
                    const lines = [...ciplForm.lines];
                    lines[idx] = { ...line, description: e.target.value };
                    setCiplForm((f) => ({ ...f, lines }));
                  }}
                />
                <TextInput
                  type="number"
                  placeholder="Qty"
                  value={line.qty}
                  onChange={(e) => {
                    const lines = [...ciplForm.lines];
                    lines[idx] = { ...line, qty: Number(e.target.value) };
                    setCiplForm((f) => ({ ...f, lines }));
                  }}
                />
                <TextInput
                  placeholder="Unit"
                  value={line.unit}
                  onChange={(e) => {
                    const lines = [...ciplForm.lines];
                    lines[idx] = { ...line, unit: e.target.value };
                    setCiplForm((f) => ({ ...f, lines }));
                  }}
                />
                <TextInput
                  type="number"
                  step="0.01"
                  placeholder="Price"
                  value={line.salePrice}
                  onChange={(e) => {
                    const lines = [...ciplForm.lines];
                    lines[idx] = { ...line, salePrice: Number(e.target.value) };
                    setCiplForm((f) => ({ ...f, lines }));
                  }}
                />
                <TextInput
                  type="number"
                  step="0.01"
                  placeholder="Disc %"
                  value={line.discountPct}
                  onChange={(e) => {
                    const lines = [...ciplForm.lines];
                    lines[idx] = { ...line, discountPct: Number(e.target.value) };
                    setCiplForm((f) => ({ ...f, lines }));
                  }}
                />
                <TextInput
                  type="number"
                  step="0.01"
                  placeholder="Tax %"
                  value={line.taxPct}
                  onChange={(e) => {
                    const lines = [...ciplForm.lines];
                    lines[idx] = { ...line, taxPct: Number(e.target.value) };
                    setCiplForm((f) => ({ ...f, lines }));
                  }}
                />
                <button
                  type="button"
                  className="rounded-xl border px-2 py-1 text-xs"
                  onClick={() => {
                    const lines = ciplForm.lines.filter((_, i) => i !== idx);
                    setCiplForm((f) => ({ ...f, lines: lines.length ? lines : [emptyLine()] }));
                  }}
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" className="rounded-xl border px-4 py-2 text-sm" onClick={() => setCiplCreateOpen(false)}>
            Cancel
          </button>
          <button
            type="button"
            className="rounded-xl bg-gray-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
            disabled={createCiplMutation.isPending}
            onClick={() => createCiplMutation.mutate()}
          >
            {createCiplMutation.isPending ? "Saving..." : "Create CIPL"}
          </button>
        </div>
      </Modal>
    </div>
  );
}
