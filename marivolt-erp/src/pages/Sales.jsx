import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Papa from "papaparse";
import PageHeader from "../components/erp/PageHeader.jsx";
import Modal from "../components/erp/Modal.jsx";
import { FormField, TextInput } from "../components/erp/FormField.jsx";
import ReceivePaymentModal from "../components/accounts/ReceivePaymentModal.jsx";
import { apiDelete, apiGet, apiGetWithQuery, apiPatch, apiPost, apiPostFormData, apiPut } from "../lib/api.js";
import { GLOBAL_REPORT_PRINT_CSS } from "../lib/reportPrintLayout.js";
import { SALES_QUOTATION_STYLE_PRINT_CSS } from "../lib/salesQuotationPrintCss.js";
import {
  buildTaxInvoiceHeaderHtml,
  formatInvoiceAmountInWords,
  renderSiBankFooterHtml,
} from "../lib/salesInvoicePrint.js";
import {
  orderAllocationCsvHeaders,
  orderAllocationCsvRows,
  renderOrderAllocationPrintWindow,
} from "../lib/orderAllocationPrint.js";
import { useAuth } from "../context/AuthContext.jsx";
import { getReportBranding } from "../lib/reportBranding.js";
import { renderRtsPackingListPrintWindow } from "../lib/rtsPackingListPrint.js";
import { deliverReportHtml, downloadSearchableReportPdf } from "../lib/reportPdfClient.js";
import {
  exportColumnClass,
  GLOBAL_REPORT_TABLE_CSS,
  SALES_COMMERCIAL_LINE_TABLE_HEAD,
  SALES_INVOICE_LINE_TABLE_HEAD,
} from "../lib/reportTableLayout.js";

/** Document types allowed when uploading from Sales Dispatch flow (subset of backend DOCUMENT_TYPES). */
const SHIPPING_DOC_TYPE_OPTIONS = ["Shipping Document", "Packing List", "Other"];

const salesTabs = [
  "Customer Master",
  "Quotation",
  "Order Acknowledgement",
  "Proforma Invoice",
  "Order Allocation",
  "Sales Invoice",
  "Dispatch Status",
  "Sales Return",
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
      { id: "order-allocation", title: "Order Allocation Report", desc: "Allocation register for Store processing (without pricing)." },
      { id: "backorder", title: "Backorder Report", desc: "Customer-level shortage report for allocated lines still waiting for stock." },
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
const oaStatusOptions = ["DRAFT", "ACTIVE", "CONFIRMED", "CLOSED", "CANCELLED"];
const proformaStatusOptions = ["DRAFT", "ISSUED", "PAID_PENDING_SHIPMENT", "APPROVED", "CONVERTED", "CANCELLED"];
const salesInvoiceStatusOptions = ["DRAFT", "ISSUED", "DISPATCHED", "PARTIALLY_PAID", "PAID", "CANCELLED"];
const orderAllocationStatusOptions = ["OPEN", "APPROVED", "CLOSED", "CANCELLED"];
const rtsStatusOptions = ["DRAFT", "APPROVED", "CONVERTED_TO_INVOICE", "CANCELLED"];

const reportStatusOptionsById = {
  "quotation-summary": statusOptions,
  "pending-quotation": statusOptions,
  "order-acknowledgement": oaStatusOptions,
  "pending-order-acknowledgement": oaStatusOptions,
  "order-allocation": orderAllocationStatusOptions,
  rts: rtsStatusOptions,
  backorder: orderAllocationStatusOptions,
  proforma: proformaStatusOptions,
  "sales-invoice-summary": salesInvoiceStatusOptions,
  "sales-invoice-article-wise": salesInvoiceStatusOptions,
  "sales-branch-wise": salesInvoiceStatusOptions,
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

/** Same Article + same Part number = one logical line (trimmed, case-insensitive part). */
function quotationLineDuplicateKey(line) {
  const art = String(line?.article ?? "")
    .trim()
    .toUpperCase();
  const part = String(line?.partNumber ?? "")
    .trim()
    .toUpperCase();
  return `${art}||${part}`;
}

/** Repeated Article+Part in the CSV: keep the last row for each key (spreadsheet-style). */
function dedupeQuotationCsvRowsByArticlePartLastWins(rows) {
  const map = new Map();
  for (const row of rows) {
    map.set(quotationLineDuplicateKey(row), row);
  }
  return Array.from(map.values());
}

function findQuotationImportConflicts(baseLines, dedupedImported) {
  const keyToIndex = new Map();
  for (let i = 0; i < (baseLines || []).length; i++) {
    const l = baseLines[i];
    if (String(l?.article ?? "").trim() === "") continue;
    const k = quotationLineDuplicateKey(l);
    if (!keyToIndex.has(k)) keyToIndex.set(k, i);
  }
  const conflicts = [];
  for (const row of dedupedImported) {
    const k = quotationLineDuplicateKey(row);
    if (keyToIndex.has(k)) {
      conflicts.push({ key: k, existingIndex: keyToIndex.get(k), importedRow: row });
    }
  }
  return conflicts;
}

function renumberQuotationSerialLines(lines) {
  const arr = lines?.length ? lines : [emptyLine()];
  return arr.map((l, i) => {
    const qty = Number(l.qty) || 0;
    const price = Number(l.price) || 0;
    return { ...l, serialNo: i + 1, totalPrice: qty * price };
  });
}

/**
 * @param {"override"|"skip"} mode — override replaces matching rows; skip only appends rows whose Article+Part are new.
 */
function mergeQuotationCsvLinesIntoBase(baseIn, dedupedImported, mode) {
  const base = (baseIn || []).map((l) => ({ ...l }));
  const keyToIndex = new Map();
  for (let i = 0; i < base.length; i++) {
    if (String(base[i]?.article ?? "").trim() === "") continue;
    const k = quotationLineDuplicateKey(base[i]);
    if (!keyToIndex.has(k)) keyToIndex.set(k, i);
  }

  if (mode === "skip") {
    const out = [...base];
    for (const row of dedupedImported) {
      const k = quotationLineDuplicateKey(row);
      if (keyToIndex.has(k)) continue;
      const qty = Number(row.qty) || 0;
      const price = Number(row.price) || 0;
      out.push({ ...row, serialNo: out.length + 1, totalPrice: qty * price });
      keyToIndex.set(k, out.length - 1);
    }
    return renumberQuotationSerialLines(out.length ? out : [emptyLine()]);
  }

  for (const row of dedupedImported) {
    const k = quotationLineDuplicateKey(row);
    const qty = Number(row.qty) || 0;
    const price = Number(row.price) || 0;
    const totalPrice = qty * price;
    const idx = keyToIndex.get(k);
    if (idx !== undefined) {
      base[idx] = { ...row, serialNo: idx + 1, totalPrice };
    } else {
      base.push({ ...row, serialNo: base.length + 1, totalPrice });
      keyToIndex.set(k, base.length - 1);
    }
  }
  return renumberQuotationSerialLines(base.length ? base : [emptyLine()]);
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
    vertical: q.vertical || "",
    engine: q.engine || "",
    model: q.model || "",
    config: q.config || "",
    esn: q.esn || "",
    paymentTerms: q.paymentTerms || "",
    deliveryTerms: q.deliveryTerms || "",
    incoterm: q.incoterm || "",
    discountType: q.discountType || "NONE",
    discountValue: Number(q.discountValue) || 0,
    packingCost: Number(q.packingCost) || 0,
    clearanceCost: Number(q.clearanceCost) || 0,
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

function calcQuotationTotalsView(src) {
  const subTotal = (src?.lines || []).reduce((acc, l) => acc + Number(l.qty || 0) * Number(l.price || 0), 0);
  const discountType = String(src?.discountType || "NONE").toUpperCase();
  const discountValue = Math.max(0, Number(src?.discountValue) || 0);
  const discountTotal =
    discountType === "PERCENT"
      ? Math.min(subTotal, (subTotal * discountValue) / 100)
      : discountType === "FLAT"
      ? Math.min(subTotal, discountValue)
      : 0;
  const packingCost = Math.max(0, Number(src?.packingCost) || 0);
  const clearanceCost = Math.max(0, Number(src?.clearanceCost) || 0);
  return {
    subTotal,
    discountTotal,
    packingCost,
    clearanceCost,
    grandTotal: subTotal - discountTotal + packingCost + clearanceCost,
  };
}

function orderAcknowledgementHasActiveProforma(oa) {
  if (!oa) return false;
  if (typeof oa.hasActiveProforma === "boolean") return oa.hasActiveProforma;
  const conv = Array.isArray(oa.convertedTo) ? oa.convertedTo.map(String) : [];
  return conv.includes("PROFORMA");
}

function orderAcknowledgementLocked(oa) {
  if (!oa) return true;
  const st = String(oa.status || "").toUpperCase();
  if (["CLOSED", "CANCELLED"].includes(st)) return true;
  if (st === "ACTIVE" || st === "DRAFT" || st === "CONFIRMED") return false;
  const conv = Array.isArray(oa.convertedTo) ? oa.convertedTo.map(String) : [];
  if (conv.includes("SALES_INVOICE")) return true;
  if (orderAcknowledgementHasActiveProforma(oa)) return true;
  if (["APPROVED", "CONVERTED"].includes(st)) return true;
  return false;
}

function orderAcknowledgementCanCancel(oa) {
  if (!oa) return false;
  if (typeof oa.canCancelOA === "boolean") return oa.canCancelOA;
  const st = String(oa.status || "").toUpperCase();
  if (st === "CANCELLED") return false;
  if (!["ACTIVE", "APPROVED", "CONFIRMED", "CONVERTED"].includes(st)) return false;
  return !orderAcknowledgementHasActiveProforma(oa);
}

function orderAcknowledgementCancelBlockReason(oa) {
  if (!oa) return "Order acknowledgement not found.";
  if (oa.cancelOABlockReason) return oa.cancelOABlockReason;
  if (String(oa.status || "").toUpperCase() === "CANCELLED") return "Order acknowledgement is already cancelled.";
  if (!orderAcknowledgementCanCancel(oa)) {
    if (orderAcknowledgementHasActiveProforma(oa)) {
      return "Cannot cancel OA because active downstream document exists.";
    }
    return "Only approved or active order acknowledgements can be cancelled.";
  }
  return "";
}

/** Shown badge when OA was converted to PI/SI even if legacy records never updated status to APPROVED. */
function orderAcknowledgementDisplayStatus(oa) {
  if (!oa) return "";
  const st = String(oa.status || "").toUpperCase();
  if (st === "CANCELLED" || st === "CLOSED" || st === "CONVERTED" || st === "ACTIVE") return st;
  const conv = Array.isArray(oa.convertedTo) ? oa.convertedTo.map(String) : [];
  if (orderAcknowledgementHasActiveProforma(oa) || conv.includes("SALES_INVOICE")) return "APPROVED";
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
    vertical: oa.vertical || "",
    engine: oa.engine || "",
    model: oa.model || "",
    config: oa.config || "",
    esn: oa.esn || "",
    oaDate: oad,
    status: oa.status || "DRAFT",
    lines,
  };
}

/** Only DRAFT proformas can be edited in Sales (matches backend). */
function proformaIsDraft(p) {
  return !!p && String(p.status || "").trim().toUpperCase() === "DRAFT";
}

/** Legacy rows used CONVERTED; new conversions store APPROVED — both show as Approved in the UI. */
function proformaDisplayStatus(p) {
  if (!p) return "";
  const st = String(p.status || "").trim().toUpperCase();
  if (st === "CANCELLED") return "CANCELLED";
  if (st === "PAID_PENDING_SHIPMENT") return "PAID";
  if (st === "APPROVED" || st === "CONVERTED") return "APPROVED";
  return st || "DRAFT";
}

function proformaDetailToEditableForm(p) {
  if (!p) return null;
  const linesSrc = Array.isArray(p.lines) && p.lines.length ? p.lines : [];
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
  const pd = p.proformaDate ? new Date(p.proformaDate).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10);
  const validityStr =
    typeof p.validity === "string"
      ? p.validity
      : p.validity
        ? new Date(p.validity).toISOString().slice(0, 10)
        : "";
  return {
    proformaDate: pd,
    customerName: p.customerName || "",
    paymentTerms: p.paymentTerms || "",
    bankDetails: p.bankDetails || "",
    validity: validityStr,
    shipmentTerms: p.shipmentTerms || "",
    remarks: p.remarks || "",
    currency: String(p.currency || "USD").toUpperCase(),
    vertical: p.vertical || "",
    engine: p.engine || "",
    model: p.model || "",
    config: p.config || "",
    esn: p.esn || "",
    status: p.status || "DRAFT",
    lines,
  };
}

function salesInvoiceIsDraft(inv) {
  return !!inv && String(inv.status || "").trim().toUpperCase() === "DRAFT";
}

function salesInvoiceDetailToEditableForm(inv) {
  if (!inv) return null;
  const linesSrc = Array.isArray(inv.lines) && inv.lines.length ? inv.lines : [];
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
  const invoiceDate = inv.invoiceDate ? new Date(inv.invoiceDate).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10);
  return {
    invoiceDate,
    customerName: inv.customerName || "",
    paymentTerms: inv.paymentTerms || "",
    dispatchDetails: inv.dispatchDetails || "",
    shippingAddress: inv.shippingAddress || "",
    billingAddress: inv.billingAddress || "",
    customerReference: inv.customerReference || "",
    loadingPort: inv.loadingPort || "",
    dischargePort: inv.dischargePort || "",
    consignee: inv.consignee || "",
    customerVatNo: inv.customerVatNo || "",
    currency: String(inv.currency || "USD").toUpperCase(),
    vertical: inv.vertical || "",
    engine: inv.engine || "",
    model: inv.model || "",
    config: inv.config || "",
    esn: inv.esn || "",
    status: inv.status || "DRAFT",
    remarks: inv.remarks || "",
    lines,
  };
}

const proformaManualStatusOptions = ["DRAFT", "ISSUED", "PAID_PENDING_SHIPMENT", "APPROVED", "CANCELLED"];

function money(n) {
  return Number(n || 0).toFixed(2);
}

function statusBadgeClass(status = "") {
  const key = String(status).toUpperCase();
  if (["APPROVED", "PAID", "CLOSED", "CONFIRMED", "CONVERTED", "ISSUED", "SHIPPED"].includes(key)) {
    return "bg-emerald-50 text-emerald-700 ring-emerald-200";
  }
  if (["DRAFT", "SENT", "PARTIALLY_PAID", "PAID_PENDING_SHIPMENT", "PARTIAL"].includes(key)) {
    return "bg-amber-50 text-amber-700 ring-amber-200";
  }
  if (["UNPAID"].includes(key)) {
    return "bg-slate-100 text-slate-700 ring-slate-300";
  }
  if (["CANCELLED", "REJECTED", "EXPIRED"].includes(key)) {
    return "bg-rose-50 text-rose-700 ring-rose-200";
  }
  return "bg-slate-100 text-slate-700 ring-slate-200";
}

function quotationLockedStatus(status = "") {
  const st = String(status || "").toUpperCase();
  return st === "APPROVED" || st === "CONVERTED" || st === "CANCELLED";
}

const machineDetailColumns = [
  ["Vertical", (r) => r.vertical || ""],
  ["Brand", (r) => r.engine || ""],
  ["Model", (r) => r.model || ""],
  ["Config", (r) => r.config || ""],
  ["ESN", (r) => r.esn || ""],
];

const reportColumnsById = {
  "quotation-summary": [
    ["Quotation No", (r) => r.quotationNo || ""],
    ["Date", (r) => (r.quotationDate ? new Date(r.quotationDate).toLocaleDateString() : "")],
    ["Customer", (r) => r.customerName || ""],
    ["Customer Ref", (r) => r.customerReference || ""],
    ...machineDetailColumns,
    ["Line Items", (r) => r.lineItems || 0],
    ["Total", (r) => money(r.totalAmount)],
    ["Status", (r) => r.status || ""],
  ],
  "pending-quotation": [
    ["Quotation No", (r) => r.quotationNo || ""],
    ["Date", (r) => (r.quotationDate ? new Date(r.quotationDate).toLocaleDateString() : "")],
    ["Customer", (r) => r.customerName || ""],
    ...machineDetailColumns,
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
    ...machineDetailColumns,
    ["Total", (r) => money(r.totalAmount)],
    ["Status", (r) => r.status || ""],
  ],
  "pending-order-acknowledgement": [
    ["OA No", (r) => r.oaNo || ""],
    ["Customer", (r) => r.customerName || ""],
    ["Quotation Link", (r) => r.linkedQuotationNo || ""],
    ...machineDetailColumns,
    ["Amount", (r) => money(r.amount)],
    ["Age (Days)", (r) => r.ageDays || 0],
    ["Status", (r) => r.status || ""],
  ],
  "order-allocation": [
    ["Allocation No", (r) => r.allocationNo || ""],
    ["Date", (r) => (r.allocationDate ? new Date(r.allocationDate).toLocaleDateString() : "")],
    ["Linked OA", (r) => r.linkedOANo || ""],
    ["Linked PI", (r) => r.linkedProformaNo || ""],
    ["Customer", (r) => r.customerName || ""],
    ...machineDetailColumns,
    ["Line Count", (r) => r.lineCount || 0],
    ["Status", (r) => r.status || ""],
  ],
  rts: [
    ["RTS No", (r) => r.rtsNo || ""],
    ["Date", (r) => (r.rtsDate ? new Date(r.rtsDate).toLocaleDateString() : "")],
    ["Allocation No", (r) => r.linkedOrderAllocationNo || ""],
    ["Customer", (r) => r.customerName || ""],
    ...machineDetailColumns,
    ["Line Count", (r) => r.lineCount || 0],
    ["Box Count", (r) => r.boxCount || 0],
    ["Total Weight Kg", (r) => money(r.totalWeightKg || 0)],
    ["Status", (r) => r.status || ""],
  ],
  backorder: [
    ["Customer", (r) => r.customer || r.customerName || ""],
    ["Article", (r) => r.article || ""],
    ["Ref No", (r) => r.refNo || r.referenceNo || ""],
    ["Ordered Qty", (r) => r.orderedQty || 0],
    ["Allocated Qty", (r) => r.allocatedQty || 0],
    ["Pending Qty", (r) => r.pendingQty || 0],
    ["RTS Qty", (r) => r.rtsQty || 0],
    ["Invoice Qty", (r) => r.invoiceQty || 0],
    ["Available", (r) => r.available ?? ""],
    ["Expected GRN", (r) => r.expectedGrn || ""],
  ],
  proforma: [
    ["Proforma No", (r) => r.proformaNo || ""],
    ["Date", (r) => (r.proformaDate ? new Date(r.proformaDate).toLocaleDateString() : "")],
    ["Linked Quotation/OA", (r) => r.linkedOANo || r.linkedQuotationNo || ""],
    ["Customer", (r) => r.customerName || ""],
    ...machineDetailColumns,
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
    ...machineDetailColumns,
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
    ...machineDetailColumns,
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
  const { isMarivolt, useBrandedLayout, printLogo, companyDisplayName, companySubtitle, reportAddress, reportEmail, reportPhone, reportWebsite, reportFooterName, reportFooterSubline } = getReportBranding(companyName);
  const html = `
    <html>
      <head>
        <title>${q.quotationNo || "Quotation"}</title>
        <style>
${SALES_QUOTATION_STYLE_PRINT_CSS}
        </style>
      </head>
      <body class="report-print ${isMarivolt ? "has-quote-terms" : ""}"><div class="print-page"><div class="print-body">
        <div class="print-header quote-header">
          <div class="quote-left">
            ${
              useBrandedLayout
                ? `<img src="${printLogo}" alt="${companyDisplayName || "Company"} logo" class="quote-logo" />`
                : hasCompanyLogo
                ? `<img src="${company.logo}" alt="${company.companyName || "Company"} logo" class="quote-logo" />`
                : `<div class="brand-fallback">MV</div>`
            }
          </div>
          <div class="quote-center">
            <div class="quote-title">Quotation</div>
            <div class="quote-meta">
              <div><b>No:</b> ${q.quotationNo || "-"}</div>
              <div><b>Date:</b> ${q.quotationDate ? new Date(q.quotationDate).toLocaleDateString() : "-"}</div>
              <div><b>Validity:</b> ${q.validityDate ? new Date(q.validityDate).toLocaleDateString() : "-"}</div>
            </div>
          </div>
          ${
            useBrandedLayout
              ? `<div class="quote-right">
                <h1 class="company-name">${companyDisplayName || (company.companyName || "")}</h1>
                ${companySubtitle ? `<div class="company-subtitle">${companySubtitle}</div>` : ""}
                <div class="company-details">
                  <div>${company.address || reportAddress}</div>
                  <div>${company.email || reportEmail}</div>
                  <div>${company.phone || reportPhone}</div>
                </div>
              </div>`
              : `<div class="quote-right company-details">
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
            <div class="info-box-title">Machine Details</div>
            <div><b>Vertical:</b> ${q.vertical || "-"}</div>
            <div><b>Brand:</b> ${q.engine || "-"}</div>
            <div><b>Model:</b> ${q.model || "-"}</div>
            <div><b>Config:</b> ${q.config || "-"}</div>
            <div><b>ESN:</b> ${q.esn || "-"}</div>
            <div><b>Currency:</b> ${q.currency || "-"}</div>
          </div>
        </div>
        <table class="report-table">
          <thead>
            <tr>${SALES_COMMERCIAL_LINE_TABLE_HEAD}</tr>
          </thead>
          <tbody>
            ${rows
              .map(
                (line) => `
              <tr>
                <td class="col-sno">${line.serialNo || ""}</td>
                <td class="col-part">${line.partNumber || ""}</td>
                <td class="col-desc">${line.description || ""}</td>
                <td class="col-uom">${line.uom || ""}</td>
                <td class="col-qty right">${line.qty || 0}</td>
                <td class="col-price right">${money(line.price)}</td>
                <td class="col-total right">${money(line.totalPrice)}</td>
                <td class="col-remarks">${line.remarks || ""}</td>
                <td class="col-avail">${line.availability || ""}</td>
              </tr>`
              )
              .join("")}
          </tbody>
        </table>
        <div class="print-totals totals summary-section">
          <div><span>Subtotal</span><span>${money(q.subTotal)}</span></div>
          <div><span>Packing Cost</span><span>${money(q.packingCost)}</span></div>
          <div><span>Clearance Cost</span><span>${money(q.clearanceCost)}</span></div>
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
  return deliverReportHtml(html, {
    exportPdf: autoPrint,
    filename: q.quotationNo || "quotation",
  });
}

function renderOrderAcknowledgementPrintWindow(payload, autoPrint = false) {
  const oa = payload?.orderAcknowledgement || {};
  const company = payload?.company || {};
  const rows = oa.lines || [];
  const hasCompanyLogo = String(company.logo || "").trim().length > 0;
  const companyName = String(company.companyName || "").toLowerCase();
  const { isMarivolt, useBrandedLayout, printLogo, companyDisplayName, companySubtitle, reportAddress, reportEmail, reportPhone, reportWebsite, reportFooterName, reportFooterSubline } = getReportBranding(companyName);
  const fmtDate = (d) => (d ? new Date(d).toLocaleDateString() : "-");

  const html = `
    <html>
      <head>
        <title>${oa.oaNo || "Order Acknowledgement"}</title>
        <style>
${SALES_QUOTATION_STYLE_PRINT_CSS}
        </style>
      </head>
      <body class="report-print ${isMarivolt ? "has-quote-terms" : ""}"><div class="print-page"><div class="print-body">
        <div class="print-header header">
          <div class="header-left">
            ${
              useBrandedLayout
                ? `<img src="${printLogo}" alt="${companyDisplayName || "Company"} logo" class="logo" />`
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
            useBrandedLayout
              ? `<div class="header-right is-marivolt">
                <h1 class="brand-title">${companyDisplayName || (company.companyName || "")}</h1>
                ${companySubtitle ? `<div class="brand-subtitle">${companySubtitle}</div>` : ""}
                <div class="muted" style="margin-top:8px;">
                  <div>${company.address || reportAddress}</div>
                  <div>${company.email || reportEmail}</div>
                  <div>${company.phone || reportPhone}</div>
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
            <div class="info-box-title">Machine Details</div>
            <div><b>Vertical:</b> ${oa.vertical || "-"}</div>
            <div><b>Brand:</b> ${oa.engine || "-"}</div>
            <div><b>Model:</b> ${oa.model || "-"}</div>
            <div><b>Config:</b> ${oa.config || "-"}</div>
            <div><b>ESN:</b> ${oa.esn || "-"}</div>
            <div><b>Currency:</b> ${oa.currency || "-"}</div>
          </div>
        </div>
        <table class="report-table">
          <thead>
            <tr>${SALES_COMMERCIAL_LINE_TABLE_HEAD}</tr>
          </thead>
          <tbody>
            ${rows
              .map(
                (line) => `
              <tr>
                <td class="col-sno">${line.serialNo ?? ""}</td>
                <td class="col-part">${line.partNumber || ""}</td>
                <td class="col-desc">${line.description || ""}</td>
                <td class="col-uom">${line.uom || ""}</td>
                <td class="col-qty right">${line.qty || 0}</td>
                <td class="col-price right">${money(line.price)}</td>
                <td class="col-total right">${money(line.totalPrice)}</td>
                <td class="col-remarks">${line.remarks || ""}</td>
                <td class="col-avail">${line.availability || ""}</td>
              </tr>`
              )
              .join("")}
          </tbody>
        </table>
        <div class="print-totals totals summary-section">
          <div><span>Subtotal</span><span>${money(oa.subTotal)}</span></div>
          <div><span>Packing Cost</span><span>${money(oa.packingCost)}</span></div>
          <div><span>Clearance Cost</span><span>${money(oa.clearanceCost)}</span></div>
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
  const oaNo = oa.oaNo || "order-acknowledgement";
  return deliverReportHtml(html, { exportPdf: autoPrint, filename: oaNo });
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
  salesInvoiceLayout = false,
  includeBankFooter = false,
  bankDetail = null,
  amountInWords = "",
  autoPrint = false,
}) {
  const rows = doc?.lines || [];
  const hasCompanyLogo = String(company?.logo || company?.logoUrl || "").trim().length > 0;
  const companyName = String(company?.name || company?.companyName || "").toLowerCase();
  const { isMarivolt, useBrandedLayout, printLogo, companyDisplayName, companySubtitle, reportAddress, reportEmail, reportPhone, reportWebsite, reportFooterName, reportFooterSubline } = getReportBranding(companyName);
  const lineTableHeaderHtml = salesInvoiceLayout
    ? SALES_INVOICE_LINE_TABLE_HEAD
    : SALES_COMMERCIAL_LINE_TABLE_HEAD;
  const lineTableRowsHtml = salesInvoiceLayout
    ? rows
        .map(
          (line) => `
              <tr>
                <td class="col-sno">${line.serialNo ?? ""}</td>
                <td class="col-part">${line.partNumber || ""}</td>
                <td class="col-desc">${line.description || ""}</td>
                <td class="col-uom">${line.uom || ""}</td>
                <td class="col-qty right">${line.qty || 0}</td>
                <td class="col-price right">${money(line.price)}</td>
                <td class="col-total right">${money(line.totalPrice)}</td>
                <td class="col-weight right">${line.unitWeightKg == null ? "" : money(line.unitWeightKg)}</td>
                <td class="col-weight right">${line.totalWeightKg == null ? "" : money(line.totalWeightKg)}</td>
              </tr>`
        )
        .join("")
    : rows
        .map(
          (line) => `
              <tr>
                <td class="col-sno">${line.serialNo ?? ""}</td>
                <td class="col-part">${line.partNumber || ""}</td>
                <td class="col-desc">${line.description || ""}</td>
                <td class="col-uom">${line.uom || ""}</td>
                <td class="col-qty right">${line.qty || 0}</td>
                <td class="col-price right">${money(line.price)}</td>
                <td class="col-total right">${money(line.totalPrice)}</td>
                <td class="col-remarks">${line.remarks || ""}</td>
                <td class="col-avail">${line.availability || ""}</td>
              </tr>`
        )
        .join("");
  const invoiceDateFormatted = dateValue ? new Date(dateValue).toLocaleDateString() : "—";
  const flowDocClassicTop = `
        <div class="print-header header">
          <div class="header-left">
            ${
              useBrandedLayout
                ? `<img src="${printLogo}" alt="${companyDisplayName || "Company"} logo" class="logo" />`
                : hasCompanyLogo
                ? `<img src="${company?.logo || company?.logoUrl}" alt="${company?.name || company?.companyName || "Company"} logo" class="logo" />`
                : `<div class="brand-fallback">MV</div>`
            }
          </div>
          <div class="header-center">
            <div class="title">${title}</div>
            <div class="muted">
              <div><b>${docNoLabel}:</b> ${docNoValue || "-"}</div>
              <div><b>${dateLabel}:</b> ${invoiceDateFormatted}</div>
              ${linkedLabel ? `<div><b>${linkedLabel}:</b> ${linkedValue || "-"}</div>` : ""}
              <div><b>Customer:</b> ${doc?.customerName || "-"}</div>
            </div>
          </div>
          ${
            useBrandedLayout
              ? `<div class="header-right is-marivolt">
                <h1 class="brand-title">${companyDisplayName || (company?.name || company?.companyName || "")}</h1>
                ${companySubtitle ? `<div class="brand-subtitle">${companySubtitle}</div>` : ""}
                <div class="muted" style="margin-top:8px;">
                  <div>${company?.address || reportAddress}</div>
                  <div>${company?.email || reportEmail}</div>
                  <div>${company?.phone || reportPhone}</div>
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
        <div class="info-grid">
          <div class="info-box muted">
            <div class="info-box-title">Machine Details</div>
            <div><b>Vertical:</b> ${doc?.vertical || "-"}</div>
            <div><b>Brand:</b> ${doc?.engine || "-"}</div>
            <div><b>Model:</b> ${doc?.model || "-"}</div>
            <div><b>Config:</b> ${doc?.config || "-"}</div>
            <div><b>ESN:</b> ${doc?.esn || "-"}</div>
            <div><b>Currency:</b> ${doc?.currency || "-"}</div>
          </div>
        </div>`;
  const taxInvoiceQuotationHeader = `
        <div class="print-header header">
          <div class="header-left">
            ${
              useBrandedLayout
                ? `<img src="${printLogo}" alt="${companyDisplayName || "Company"} logo" class="logo" />`
                : hasCompanyLogo
                ? `<img src="${company?.logo || company?.logoUrl}" alt="${company?.name || company?.companyName || "Company"} logo" class="logo" />`
                : `<div class="brand-fallback">MV</div>`
            }
          </div>
          <div class="header-center">
            <div class="title">Tax Invoice</div>
            <div class="muted">
              <div><b>No:</b> ${docNoValue || doc?.invoiceNo || "-"}</div>
              <div><b>Date:</b> ${invoiceDateFormatted}</div>
            </div>
          </div>
          ${
            useBrandedLayout
              ? `<div class="header-right is-marivolt">
                <h1 class="brand-title">${companyDisplayName || (company?.name || company?.companyName || "")}</h1>
                ${companySubtitle ? `<div class="brand-subtitle">${companySubtitle}</div>` : ""}
                <div class="muted" style="margin-top:8px;">
                  <div>${company?.address || reportAddress}</div>
                  <div>${company?.email || reportEmail}</div>
                  <div>${company?.phone || reportPhone}</div>
                </div>
              </div>`
              : `<div class="header-right muted">
                <div><b>${company?.name || company?.companyName || ""}</b></div>
                <div>${company?.address || ""}</div>
                <div>${company?.email || ""}</div>
                <div>${company?.phone || ""}</div>
              </div>`
          }
        </div>`;
  const taxInvoiceGridHtml = salesInvoiceLayout
    ? buildTaxInvoiceHeaderHtml({
        doc,
        company,
        invoiceNo: docNoValue || doc?.invoiceNo || "",
        invoiceDateStr: invoiceDateFormatted,
        isMarivolt,
      })
    : "";
  const html = `
    <html>
      <head>
        <title>${docNoValue || title}</title>
        <style>
${SALES_QUOTATION_STYLE_PRINT_CSS}
        </style>
      </head>
      <body class="report-print ${isMarivolt ? "has-quote-terms" : ""}"><div class="print-page"><div class="print-body">
        ${salesInvoiceLayout ? taxInvoiceQuotationHeader + taxInvoiceGridHtml : flowDocClassicTop}
        <table class="report-table${salesInvoiceLayout ? " cols-invoice" : ""}">
          <thead>
            <tr>
              ${lineTableHeaderHtml}
            </tr>
          </thead>
          <tbody>
            ${lineTableRowsHtml}
          </tbody>
        </table>
        <div class="print-totals totals summary-section">
          <div><span>Subtotal</span><span>${money(doc?.subTotal)}</span></div>
          <div><span>Packing Cost</span><span>${money(doc?.packingCost)}</span></div>
          <div><span>Clearance Cost</span><span>${money(doc?.clearanceCost)}</span></div>
          <div><span>Discount</span><span>${money(doc?.discountTotal)}</span></div>
          <div><span>Tax</span><span>${money(doc?.taxTotal)}</span></div>
          <div><b>Grand Total</b><b>${money(doc?.grandTotal)} ${doc?.currency || ""}</b></div>
        </div>
        ${
          salesInvoiceLayout || includeBankFooter
            ? renderSiBankFooterHtml({
                bankDetail,
                amountInWords,
                company,
                docCurrency: doc?.currency,
              })
            : ""
        }
        ${
          isMarivolt
            ? `<div class="quote-terms">Only Marivolt terms and condition applicable, check here-<a href="https://marivolt.co/about-us">https://marivolt.co/about-us</a></div>`
            : ""
        }
        <div class="footer">
          <div class="doc-note">${
            salesInvoiceLayout
              ? "This is a computer generated document."
              : "This is a computer generated documents and does not required signature or stamp."
          }</div>
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
  const fileBase =
    docNoValue || doc?.proformaNo || doc?.invoiceNo || doc?.dispatchNo || title || "document";
  return deliverReportHtml(html, {
    exportPdf: autoPrint,
    filename: String(fileBase).replace(/[^\w.\-]+/g, "-") || "document",
  });
}

function renderPackingListPrintWindow({ rts, company, autoPrint = false }) {
  renderRtsPackingListPrintWindow({ rts, company, autoPrint });
}

function rtsCsvRowsForSales(doc) {
  const boxes = Array.isArray(doc?.packingDetails?.boxes) ? doc.packingDetails.boxes : [];
  const lines = Array.isArray(doc?.lines) ? doc.lines : [];
  const base = {
    rtsNo: doc?.rtsNo || "",
    rtsDate: doc?.rtsDate ? new Date(doc.rtsDate).toISOString().slice(0, 10) : "",
    allocationNo: doc?.linkedOrderAllocationNo || "",
    customer: doc?.customerName || "",
    totalWeightKg: doc?.packingDetails?.totalWeightKg ?? "",
  };
  return [
    ...boxes.map((b) => ({
      recordType: "BOX",
      ...base,
      boxMaterial: b?.material || "",
      boxCount: b?.count ?? "",
      boxDimensionsMm: b?.dimensionsMm || "",
      boxRemarks: b?.remarks || "",
      serialNo: "",
      article: "",
      partNo: "",
      description: "",
      uom: "",
      qty: "",
      unitWeightKg: "",
      totalLineWeightKg: "",
    })),
    ...lines.map((line) => ({
      recordType: "ITEM",
      ...base,
      boxMaterial: "",
      boxCount: "",
      boxDimensionsMm: "",
      boxRemarks: "",
      serialNo: line?.serialNo ?? "",
      article: line?.article || "",
      partNo: line?.partNumber || "",
      description: line?.description || "",
      uom: line?.uom || "",
      qty: line?.qty ?? 0,
      coo: line?.coo || "Germany",
      unitWeightKg: line?.unitWeightKg ?? "",
      totalLineWeightKg: line?.totalWeightKg ?? "",
    })),
  ];
}

/** Aligns with backend customer PUT/DELETE: super_admin, company_admin, admin only. */
function canEditSalesCustomerMaster(role) {
  const r = String(role || "").toLowerCase().trim();
  return ["super_admin", "company_admin", "admin"].includes(r);
}

function canManageSalesQuotationDeletion(role, username) {
  const r = String(role || "").toLowerCase().trim();
  const u = String(username || "").toLowerCase().trim();
  if (u === "deepak007") return true;
  return ["super_admin", "company_admin", "admin"].includes(r);
}

function quotationListCanDelete(row, hasAdminDelete) {
  if (!hasAdminDelete || !row) return false;
  if (typeof row.canDeleteQuotation === "boolean") return row.canDeleteQuotation;
  const st = String(row.status || "").toUpperCase();
  return ["DRAFT", "APPROVED", "CONVERTED"].includes(st);
}

function quotationListDeleteTitle(row, hasAdminDelete) {
  if (!hasAdminDelete) return "Only administrators can delete quotations.";
  if (row?.deleteQuotationBlockReason) return row.deleteQuotationBlockReason;
  if (quotationListCanDelete(row, hasAdminDelete)) return "Delete quotation permanently";
  return "This quotation cannot be deleted.";
}

function formatFileBytes(n) {
  if (n == null || Number.isNaN(Number(n))) return "—";
  const v = Number(n);
  if (v < 1024) return `${Math.round(v)} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
  return `${(v / (1024 * 1024)).toFixed(1)} MB`;
}

export default function Sales() {
  const qc = useQueryClient();
  const { auth } = useAuth();
  const activeCompany = auth?.company;
  /** Auth persists `company.id` (not `_id`); align with `getActiveCompanyId()` in api.js */
  const activeCompanyId = activeCompany?.id ?? activeCompany?._id ?? null;
  const summaryCurrency = String(activeCompany?.currency || "USD").trim().toUpperCase() || "USD";
  const invalidateStockViews = useCallback(() => {
    qc.invalidateQueries({ queryKey: ["stock-summary"] });
    qc.invalidateQueries({ queryKey: ["stock-ledger-unified"] });
    qc.invalidateQueries({ queryKey: ["stock-negative-allocations"] });
    qc.invalidateQueries({ queryKey: ["stock-customer-allocations"] });
    qc.invalidateQueries({ queryKey: ["sales-report"] });
  }, [qc]);
  const [activeTab, setActiveTab] = useState("Quotation");
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [brandFilter, setBrandFilter] = useState("");
  const [verticalFilter, setVerticalFilter] = useState("");
  const limit = 20;
  const quotationCsvInputRef = useRef(null);
  /** Latest quotation line grid for CSV import (Papa.parse completes async). */
  const quotationFormLinesRef = useRef([]);
  /** { base, dedupedImported, conflicts, internalDupRemoved } */
  const [quotationCsvDupModal, setQuotationCsvDupModal] = useState(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [isQuotationNoEdited, setIsQuotationNoEdited] = useState(false);
  const [customerCreateOpen, setCustomerCreateOpen] = useState(false);
  const [customerEditOpen, setCustomerEditOpen] = useState(false);
  const [customerEditId, setCustomerEditId] = useState(null);
  const [customerEditForm, setCustomerEditForm] = useState({
    name: "",
    contactName: "",
    phone: "",
    email: "",
    address: "",
    paymentTerms: "CREDIT",
    notes: "",
  });
  const canEditCustomers = canEditSalesCustomerMaster(auth?.user?.role);
  const canDeleteQuotations = canManageSalesQuotationDeletion(auth?.user?.role, auth?.user?.username);
  const shippingFileRef = useRef(null);
  const [shippingDocsAfterDispatch, setShippingDocsAfterDispatch] = useState(null);
  const [shippingDocForm, setShippingDocForm] = useState({
    documentType: "Shipping Document",
    remarks: "",
  });
  const [shippingDownloadBusyId, setShippingDownloadBusyId] = useState(null);
  const paymentSlipInputRef = useRef(null);
  const [receivePaymentModal, setReceivePaymentModal] = useState({ open: false, proforma: null });
  const [negativeAllocConfirm, setNegativeAllocConfirm] = useState({
    open: false,
    source: "",
    id: "",
    error: null,
  });
  const [negativeAllocReason, setNegativeAllocReason] = useState("");
  const [receiveInvoicePaymentModal, setReceiveInvoicePaymentModal] = useState({ open: false, invoice: null });
  const [viewPaymentsModal, setViewPaymentsModal] = useState({ open: false, proforma: null });
  const [receivePaymentForm, setReceivePaymentForm] = useState({
    receiptDate: new Date().toISOString().slice(0, 10),
    amountReceived: 0,
    currency: "USD",
    paymentMode: "BANK_TRANSFER",
    bankCashAccountName: "",
    bankAccountId: "",
    cashAccountId: "",
    paymentReference: "",
    remarks: "",
    adminOverride: false,
    attachmentFile: null,
  });
  const [srCreateOpen, setSrCreateOpen] = useState(false);
  const [srForm, setSrForm] = useState({
    customerName: "",
    warehouse: "MAIN",
    currency: "USD",
    linkedSalesDispatchId: "",
    linkedSalesDispatchNo: "",
    linkedSalesInvoiceId: "",
    linkedSalesInvoiceNo: "",
    remarks: "",
    lines: [{ article: "", partNumber: "", description: "", qty: 1, uom: "PCS", unitPrice: 0, reason: "" }],
  });
  const [detailId, setDetailId] = useState(null);
  const [oaCreateOpen, setOaCreateOpen] = useState(false);
  const [proformaCreateOpen, setProformaCreateOpen] = useState(false);
  const [salesInvoiceCreateOpen, setSalesInvoiceCreateOpen] = useState(false);
  const [ciplCreateOpen, setCiplCreateOpen] = useState(false);
  const [err, setErr] = useState("");
  /** { open, kind: "SI"|"ALC"|"RTS"|"OA"|"PI", id, reason, preview, step: "form"|"confirm" } */
  const [salesCancelModal, setSalesCancelModal] = useState(null);
  const [detailQuotationDraftForm, setDetailQuotationDraftForm] = useState(null);
  const [detailOADraftForm, setDetailOADraftForm] = useState(null);
  const [detailProformaDraftForm, setDetailProformaDraftForm] = useState(null);
  const [detailSalesInvoiceDraftForm, setDetailSalesInvoiceDraftForm] = useState(null);
  const [selectedReportId, setSelectedReportId] = useState("");
  const reportViewerRef = useRef(null);
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
    vertical: "",
    engine: "",
    model: "",
    config: "",
    esn: "",
    paymentTerms: "",
    deliveryTerms: "",
    incoterm: "",
    discountType: "NONE",
    discountValue: 0,
    packingCost: 0,
    clearanceCost: 0,
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

  useEffect(() => {
    quotationFormLinesRef.current = form.lines;
  }, [form.lines]);

  const { data, isLoading, error } = useQuery({
    queryKey: ["sales-quotations", page, search, status, brandFilter, verticalFilter],
    queryFn: () =>
      apiGetWithQuery("/quotations", {
        page,
        limit,
        search: search || undefined,
        status: status || undefined,
        brand: brandFilter || undefined,
        vertical: verticalFilter || undefined,
      }),
  });
  const { data: quotationFacets } = useQuery({
    queryKey: ["sales-quotation-facets"],
    queryFn: () => apiGet("/quotations/facets"),
    enabled: activeTab === "Quotation" || createOpen,
  });

  const { data: detail } = useQuery({
    queryKey: ["quotation-detail", detailId],
    queryFn: () => apiGet(`/quotations/${detailId}`),
    enabled: !!detailId,
  });

  const { data: bankDetailsData } = useQuery({
    queryKey: ["accounts-bank-details-payment"],
    queryFn: () => apiGetWithQuery("/accounts/bank-details", { page: 1, limit: 200 }),
    enabled: receivePaymentModal.open || receiveInvoicePaymentModal.open,
  });

  const { data: proformaPaymentsData } = useQuery({
    queryKey: ["proforma-payments", viewPaymentsModal.proforma?._id],
    queryFn: () => apiGet(`/payment-receipts/by-proforma/${viewPaymentsModal.proforma._id}`),
    enabled: viewPaymentsModal.open && !!viewPaymentsModal.proforma?._id,
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

  const { data: allocationData, isLoading: allocationLoading } = useQuery({
    queryKey: ["sales-order-allocation", page, search],
    queryFn: () =>
      apiGetWithQuery("/sales/order-allocations", {
        page,
        limit,
        search: search || undefined,
      }),
    enabled: activeTab === "Order Allocation",
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

  const { data: readyPackingInvoiceData } = useQuery({
    queryKey: ["sales-packings-ready-invoice", search],
    queryFn: () =>
      apiGetWithQuery("/sales/sales-invoices/packings/ready", {
        search: search || undefined,
      }),
    enabled: activeTab === "Sales Invoice",
  });

  const { data: salesDispatchData, isLoading: legacySalesDispatchLoading } = useQuery({
    queryKey: ["sales-sales-dispatch", page, search],
    queryFn: () =>
      apiGetWithQuery("/sales/sales-dispatches", {
        page,
        limit,
        search: search || undefined,
      }),
    enabled: activeTab === "Sales Return" || srCreateOpen,
  });

  const { data: dispatchStatusData, isLoading: dispatchStatusLoading } = useQuery({
    queryKey: ["sales-dispatch-status", search],
    queryFn: () =>
      apiGetWithQuery("/sales/dispatch-status", {
        customer: search || undefined,
      }),
    enabled: activeTab === "Dispatch Status",
  });

  const { data: salesReturnData, isLoading: salesReturnLoading } = useQuery({
    queryKey: ["sales-sales-returns", page, search],
    queryFn: () =>
      apiGetWithQuery("/sales/sales-returns", {
        page,
        limit,
        search: search || undefined,
      }),
    enabled: activeTab === "Sales Return",
  });

  const { data: shippingDocsForDispatchData, isLoading: shippingDocsListLoading } = useQuery({
    queryKey: ["shipping-docs-for-dispatch", shippingDocsAfterDispatch?.dispatchId],
    queryFn: () =>
      apiGetWithQuery("/documents", {
        page: 1,
        limit: 100,
        moduleName: "Sales Dispatch",
        relatedId: String(shippingDocsAfterDispatch.dispatchId),
      }),
    enabled: !!shippingDocsAfterDispatch?.dispatchId,
  });

  const { data: salesSummary, isLoading: summaryLoading } = useQuery({
    queryKey: ["sales-summary", activeCompanyId],
    queryFn: () => apiGet("/sales/summary"),
    enabled: !!activeCompanyId && !!auth?.token,
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
    "order-allocation": "/sales/reports/order-allocation",
    rts: "/sales/reports/rts",
    proforma: "/sales/reports/proforma",
    "sales-invoice-summary": "/sales/reports/sales-invoice-summary",
    "sales-invoice-article-wise": "/sales/reports/sales-invoice-article-wise",
    "sales-branch-wise": "/sales/reports/sales-branch-wise",
    cipl: "/sales/reports/cipl",
    backorder: "/sales/reports/backorder",
  };
  const reportApiPath = reportEndpointById[activeReportId] || null;
  const activeReportTitle = reportTitleById[activeReportId] || "Selected Report";

  const {
    data: activeReportData,
    isLoading: reportLoading,
    isError: reportIsError,
    error: reportQueryError,
  } = useQuery({
    queryKey: ["sales-report", activeCompanyId, activeReportId, reportPage, reportFilters],
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
    enabled: activeTab === "Reports" && !!reportApiPath && !!activeCompanyId && !!auth?.token,
  });
  const activeReportRows = activeReportData?.rows || activeReportData?.items || [];
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
    if (!activeExportColumns.length) return;
    const header = activeExportColumns.map(([label]) => escapeCsvValue(label)).join(",");
    const lines = activeReportRows.map((row) => activeExportColumns.map(([, getter]) => escapeCsvValue(getter(row))).join(","));
    const csv = lines.length ? [header, ...lines].join("\n") : header;
    downloadBlobFile(`${activeReportId}-${new Date().toISOString().slice(0, 10)}.csv`, `\ufeff${csv}`, "text/csv;charset=utf-8");
  }

  function exportActiveReportExcel() {
    if (!activeExportColumns.length) return;
    const headers = activeExportColumns.map(([label]) => `<th>${label}</th>`).join("");
    const rows = activeReportRows.length
      ? activeReportRows
          .map((row) => `<tr>${activeExportColumns.map(([, getter]) => `<td>${String(getter(row) ?? "")}</td>`).join("")}</tr>`)
          .join("")
      : `<tr><td colspan="${activeExportColumns.length}">No data for current filters.</td></tr>`;
    const html = `<table><thead><tr>${headers}</tr></thead><tbody>${rows}</tbody></table>`;
    downloadBlobFile(`${activeReportId}-${new Date().toISOString().slice(0, 10)}.xls`, html, "application/vnd.ms-excel");
  }

  function openReportPrintWindow(autoPrint = false) {
    if (!activeExportColumns.length) return;
    const headers = activeExportColumns
      .map(([label]) => {
        const cls = exportColumnClass("", label);
        const align = ["col-qty", "col-price", "col-total"].includes(cls) ? " right" : "";
        return `<th class="${cls}${align}">${label}</th>`;
      })
      .join("");
    const rows = activeReportRows.length
      ? activeReportRows
          .map((row) => {
            const cells = activeExportColumns
              .map(([label, getter]) => {
                const cls = exportColumnClass("", label);
                const align = ["col-qty", "col-price", "col-total"].includes(cls) ? " right" : "";
                return `<td class="${cls}${align}">${String(getter(row) ?? "")}</td>`;
              })
              .join("");
            return `<tr>${cells}</tr>`;
          })
          .join("")
      : `<tr><td colspan="${activeExportColumns.length}" style="padding:12px;color:#666;">No data for current filters.</td></tr>`;
    const html = `
      <html>
        <head>
          <title>${activeReportTitle}</title>
          <style>
            body { font-family: Arial, sans-serif; margin: 24px; color: #111; }
            h1 { margin: 0 0 8px; font-size: 20px; }
            .meta { margin-bottom: 14px; color: #444; font-size: 12px; }
            th, td { border: 1px solid #ddd; }
            th { background: #f3f4f6; }
${GLOBAL_REPORT_PRINT_CSS}
${GLOBAL_REPORT_TABLE_CSS}
          </style>
        </head>
        <body class="report-print">
          <div class="print-page">
          <div class="print-body">
          <h1>${activeReportTitle}</h1>
          <div class="meta">Company: ${activeCompany?.name || activeCompany?.code || "-"} | Generated: ${new Date().toLocaleString()}</div>
          <table class="report-table data-table">
            <thead><tr>${headers}</tr></thead>
            <tbody>${rows}</tbody>
          </table>
          </div>
          </div>
        </body>
      </html>
    `;
    if (autoPrint) {
      const fileBase = `${activeReportId}-${new Date().toISOString().slice(0, 10)}`;
      return downloadSearchableReportPdf({
        html,
        filename: fileBase,
        options: { landscape: true },
      });
    }
    return deliverReportHtml(html, {
      exportPdf: false,
      filename: activeReportTitle || "report",
    });
  }

  function exportListCsv(filename, rows, columns) {
    if (!rows?.length) return;
    const header = columns.map((c) => escapeCsvValue(c.label)).join(",");
    const body = rows.map((row) => columns.map((c) => escapeCsvValue(c.value(row))).join(","));
    const csv = [header, ...body].join("\n");
    downloadBlobFile(`${filename}-${new Date().toISOString().slice(0, 10)}.csv`, `\ufeff${csv}`, "text/csv;charset=utf-8;");
  }

  async function fetchBankDetailForCurrency(currencyCode) {
    const raw = String(currencyCode || "USD").trim().toUpperCase();
    const candidates = [];
    const pushUnique = (v) => {
      const n = String(v || "").trim().toUpperCase();
      if (!n || candidates.includes(n)) return;
      candidates.push(n);
    };
    pushUnique(raw);
    if (raw === "EUR") pushUnique("EURO");
    if (raw === "EURO") pushUnique("EUR");
    if (raw === "USD") pushUnique("US DOLLAR");
    if (raw === "AED") pushUnique("DIRHAM");

    for (const code of candidates) {
      try {
        const curEnc = encodeURIComponent(code);
        const bdRes = await apiGet(`/accounts/bank-details/for-currency/${curEnc}`);
        const bankDetail = bdRes?.bankDetail ?? null;
        if (bankDetail) return bankDetail;
      } catch {
        // try next alias
      }
    }
    return null;
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
        const bankDetail = await fetchBankDetailForCurrency(doc?.currency);
        const amountInWords = formatInvoiceAmountInWords(doc?.grandTotal, doc?.currency);
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
          includeBankFooter: true,
          bankDetail,
          amountInWords,
          autoPrint,
        });
        return;
      }
      if (type === "sales-invoice") {
        const doc = await apiGet(`/sales/sales-invoices/${id}`);
        const bankDetail = await fetchBankDetailForCurrency(doc?.currency);
        const amountInWords = formatInvoiceAmountInWords(doc?.grandTotal, doc?.currency);
        renderFlowDocPrintWindow({
          title: "Tax invoice",
          doc,
          company,
          docNoLabel: "Invoice No",
          docNoValue: doc?.invoiceNo,
          dateLabel: "Date",
          dateValue: doc?.invoiceDate,
          linkedLabel: "Linked Proforma",
          linkedValue: doc?.linkedProformaNo || doc?.linkedOANo,
          salesInvoiceLayout: true,
          bankDetail,
          amountInWords,
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
        return;
      }
      if (type === "sales-dispatch") {
        const doc = await apiGet(`/sales/sales-dispatches/${id}`);
        const bankDetail = await fetchBankDetailForCurrency(doc?.currency);
        const amountInWords = formatInvoiceAmountInWords(doc?.grandTotal, doc?.currency);
        const invoiceNoForPrint = String(doc?.linkedSalesInvoiceNo || "").trim() || doc?.dispatchNo;
        renderFlowDocPrintWindow({
          title: "Tax invoice",
          doc,
          company,
          docNoLabel: "Invoice No",
          docNoValue: invoiceNoForPrint,
          dateLabel: "Date",
          dateValue: doc?.dispatchDate,
          linkedLabel: "",
          linkedValue: "",
          salesInvoiceLayout: true,
          bankDetail,
          amountInWords,
          autoPrint,
        });
        return;
      }
      if (type === "rts") {
        const rts = await apiGet(`/sales/rts/${id}`);
        renderPackingListPrintWindow({
          rts,
          company,
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

  const { data: salesInvoicePaymentsData } = useQuery({
    queryKey: ["sales-invoice-payments", detailId],
    queryFn: () => apiGet(`/payment-receipts/by-sales-invoice/${detailId}`),
    enabled: !!detailId && activeTab === "Sales Invoice",
  });

  const { data: salesDispatchDetail } = useQuery({
    queryKey: ["sales-dispatch-detail", detailId],
    queryFn: () => apiGet(`/sales/sales-dispatches/${detailId}`),
    enabled: false,
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
        vertical: "",
        engine: "",
        model: "",
        config: "",
        esn: "",
        paymentTerms: "",
        deliveryTerms: "",
        incoterm: "",
        discountType: "NONE",
        discountValue: 0,
        packingCost: 0,
        clearanceCost: 0,
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
        const importedRaw = quotationLinesFromCsvRows(results.data || []);
        if (!importedRaw.length) {
          setErr(
            "No valid CSV rows. Each row needs Article (or Item/SKU), Description, and a positive QTY. Optional: Part number, UOM, Price, Remarks, Material code, Availability.",
          );
          return;
        }
        setErr("");
        const prev = quotationFormLinesRef.current || [];
        const hasRealLine = prev.some(
          (l) => String(l.article || "").trim() !== "" || String(l.description || "").trim() !== "",
        );
        const base = hasRealLine ? prev.map((l) => ({ ...l })) : [];
        const dedupedImported = dedupeQuotationCsvRowsByArticlePartLastWins(importedRaw);
        const internalDupRemoved = importedRaw.length - dedupedImported.length;
        const conflicts = findQuotationImportConflicts(base, dedupedImported);
        if (conflicts.length > 0) {
          setQuotationCsvDupModal({ base, dedupedImported, conflicts, internalDupRemoved });
          return;
        }
        setForm((f) => ({
          ...f,
          lines: mergeQuotationCsvLinesIntoBase(base, dedupedImported, "skip"),
        }));
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

  const deleteQuotationMutation = useMutation({
    mutationFn: (id) => apiDelete(`/quotations/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["sales-quotations"] });
      if (detailId) qc.invalidateQueries({ queryKey: ["quotation-detail", detailId] });
      setDetailId(null);
      setErr("");
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

  const putProformaMutation = useMutation({
    mutationFn: ({ body }) => apiPut(`/sales/proforma-invoices/${detailId}`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["sales-proforma"] });
      if (detailId) qc.invalidateQueries({ queryKey: ["proforma-detail", detailId] });
    },
    onError: (e) => setErr(e.message),
  });

  useEffect(() => {
    if (activeTab !== "Proforma Invoice" || !detailId) {
      setDetailProformaDraftForm(null);
      return;
    }
    if (!proformaDetail) {
      setDetailProformaDraftForm(null);
      return;
    }
    if (!proformaIsDraft(proformaDetail)) {
      setDetailProformaDraftForm(null);
      return;
    }
    setDetailProformaDraftForm(proformaDetailToEditableForm(proformaDetail));
  }, [activeTab, detailId, proformaDetail]);

  const putSalesInvoiceMutation = useMutation({
    mutationFn: ({ body }) => apiPut(`/sales/sales-invoices/${detailId}`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["sales-sales-invoices"] });
      if (detailId) qc.invalidateQueries({ queryKey: ["sales-invoice-detail", detailId] });
    },
    onError: (e) => setErr(e.message),
  });

  useEffect(() => {
    if (activeTab !== "Sales Invoice" || !detailId) {
      setDetailSalesInvoiceDraftForm(null);
      return;
    }
    if (!salesInvoiceDetail) {
      setDetailSalesInvoiceDraftForm(null);
      return;
    }
    if (!salesInvoiceIsDraft(salesInvoiceDetail)) {
      setDetailSalesInvoiceDraftForm(null);
      return;
    }
    setDetailSalesInvoiceDraftForm(salesInvoiceDetailToEditableForm(salesInvoiceDetail));
  }, [activeTab, detailId, salesInvoiceDetail]);

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

  const updateCustomerMutation = useMutation({
    mutationFn: () => apiPut(`/sales/customers/${customerEditId}`, customerEditForm),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["sales-customers"] });
      qc.invalidateQueries({ queryKey: ["sales-customers-lookup"] });
      setCustomerEditOpen(false);
      setCustomerEditId(null);
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

  const convertProformaToCiplMutation = useMutation({
    mutationFn: (id) => apiPost(`/sales/convert/proforma/${id}/to-cipl`, {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["sales-cipl"] });
      qc.invalidateQueries({ queryKey: ["sales-proforma"] });
      if (detailId) qc.invalidateQueries({ queryKey: ["proforma-detail", detailId] });
    },
    onError: (e) => setErr(e.message),
  });

  const convertToOrderAllocationFromOAMutation = useMutation({
    mutationFn: ({ id, allowNegative = false, reason = "" }) =>
      apiPost(`/sales/convert/oa/${id}/to-order-allocation`, {
        allowNegative,
        allowNegativeReason: reason,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["sales-oa"] });
      qc.invalidateQueries({ queryKey: ["store-order-allocations"] });
      invalidateStockViews();
      if (detailId) qc.invalidateQueries({ queryKey: ["oa-detail", detailId] });
    },
    onError: (e, vars) => {
      if (e?.code === "STOCK_INSUFFICIENT") {
        setNegativeAllocConfirm({ open: true, source: "oa", id: vars?.id, error: e });
        return;
      }
      setErr(e.message);
    },
  });

  const convertToOrderAllocationFromProformaMutation = useMutation({
    mutationFn: ({ id, allowNegative = false, reason = "" }) =>
      apiPost(`/sales/convert/proforma/${id}/to-order-allocation`, {
        allowNegative,
        allowNegativeReason: reason,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["sales-proforma"] });
      qc.invalidateQueries({ queryKey: ["store-order-allocations"] });
      invalidateStockViews();
      if (detailId) qc.invalidateQueries({ queryKey: ["proforma-detail", detailId] });
    },
    onError: (e, vars) => {
      if (e?.code === "STOCK_INSUFFICIENT") {
        setNegativeAllocConfirm({ open: true, source: "proforma", id: vars?.id, error: e });
        return;
      }
      setErr(e.message);
    },
  });

  const recalcProformaPaymentStateMutation = useMutation({
    mutationFn: () => apiPost(`/sales/proforma-invoices/recalc-payment-state`, {}),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ["sales-proforma"] });
      qc.invalidateQueries({ queryKey: ["proforma-payments"] });
      if (detailId) qc.invalidateQueries({ queryKey: ["proforma-detail", detailId] });
      const scanned = Number(res?.scanned ?? 0);
      const updated = Number(res?.updated ?? 0);
      const receiptsPatched = Number(res?.receiptsPatched ?? 0);
      setErr(
        `Refreshed payment state for ${scanned} proforma${scanned === 1 ? "" : "s"} ` +
          `(${updated} updated, ${receiptsPatched} legacy receipt${receiptsPatched === 1 ? "" : "s"} relinked).`
      );
    },
    onError: (e) => setErr(e.message),
  });

  const createPaymentReceiptMutation = useMutation({
    mutationFn: async ({ sourceType, doc, form }) => {
      const fd = new FormData();
      if (sourceType === "PROFORMA_INVOICE") fd.append("proformaInvoiceId", doc._id);
      if (sourceType === "SALES_INVOICE") fd.append("salesInvoiceId", doc._id);
      fd.append("sourceType", sourceType);
      fd.append("receiptDate", form.receiptDate);
      fd.append("amountReceived", String(Number(form.amountReceived) || 0));
      fd.append("currency", form.currency || doc.currency || "USD");
      fd.append("paymentMode", form.paymentMode || "BANK_TRANSFER");
      fd.append("bankCashAccountName", form.bankCashAccountName || "");
      fd.append("customerName", doc.customerName || "");
      fd.append("paymentReference", form.paymentReference || "");
      fd.append("remarks", form.remarks || "");
      if (form.bankAccountId) fd.append("bankAccountId", form.bankAccountId);
      if (form.cashAccountId) fd.append("cashAccountId", form.cashAccountId);
      if (form.adminOverride) fd.append("adminOverride", "true");
      if (form.allowOverpayment) fd.append("allowOverpayment", "true");
      const file = form.attachmentFile || paymentSlipInputRef.current?.files?.[0];
      if (file) fd.append("attachment", file);
      try {
        return await apiPostFormData("/payment-receipts", fd);
      } catch (err) {
        // Phase-8.2 — overpayment confirm-and-continue flow.
        const code = err?.code || err?.response?.data?.code;
        if (code === "OVERPAYMENT") {
          const detail = err?.details || err?.response?.data?.details || [];
          const message =
            err?.message ||
            "This payment exceeds the document balance.";
          const lines = Array.isArray(detail)
            ? detail
                .map(
                  (d) =>
                    `• ${d.targetNo}: invoice ${Number(d.invoiceTotal || 0).toFixed(2)}, would become ${Number(d.wouldBecome || 0).toFixed(2)} (over by ${Number(d.overBy || 0).toFixed(2)})`
                )
                .join("\n")
            : "";
          if (typeof window !== "undefined") {
            const ok = window.confirm(`${message}\n\n${lines}\n\nProceed and record the overpayment?`);
            if (!ok) throw err;
          }
          fd.append("allowOverpayment", "true");
          return apiPostFormData("/payment-receipts", fd);
        }
        throw err;
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["sales-proforma"] });
      qc.invalidateQueries({ queryKey: ["sales-sales-invoices"] });
      qc.invalidateQueries({ queryKey: ["proforma-payments"] });
      qc.invalidateQueries({ queryKey: ["cashBank"] });
      qc.invalidateQueries({ queryKey: ["customerLedger"] });
      setReceivePaymentModal({ open: false, proforma: null });
      setReceiveInvoicePaymentModal({ open: false, invoice: null });
      setReceivePaymentForm({
        receiptDate: new Date().toISOString().slice(0, 10),
        amountReceived: 0,
        currency: "USD",
        paymentMode: "BANK_TRANSFER",
        bankCashAccountName: "",
        bankAccountId: "",
        cashAccountId: "",
        paymentReference: "",
        remarks: "",
        adminOverride: false,
        allowOverpayment: false,
        attachmentFile: null,
      });
      if (paymentSlipInputRef.current) paymentSlipInputRef.current.value = "";
      if (detailId) qc.invalidateQueries({ queryKey: ["proforma-detail", detailId] });
      setErr("");
    },
    onError: (e) => setErr(e.message),
  });

  const cancelPaymentReceiptMutation = useMutation({
    mutationFn: ({ id, reason }) => apiPatch(`/payment-receipts/${id}/cancel`, { cancellationReason: reason }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["sales-proforma"] });
      qc.invalidateQueries({ queryKey: ["proforma-payments"] });
      qc.invalidateQueries({ queryKey: ["cashBank"] });
      qc.invalidateQueries({ queryKey: ["customerLedger"] });
      if (detailId) qc.invalidateQueries({ queryKey: ["proforma-detail", detailId] });
      setErr("");
    },
    onError: (e) => setErr(e.message),
  });

  const salesCancelMutation = useMutation({
    mutationFn: async ({ kind, id, reason, dryRun }) => {
      const dry = dryRun ? "?dryRun=1" : "";
      if (kind === "PI") {
        return apiPatch(`/sales/proforma-invoices/${id}/cancel${dry}`, { cancellationReason: reason, reason });
      }
      if (kind === "OA") {
        return apiPatch(`/sales/order-acknowledgements/${id}/cancel${dry}`, { cancellationReason: reason, reason });
      }
      const paths = {
        SI: `/sales/invoices/${id}/cancel`,
        ALC: `/sales/allocations/${id}/cancel`,
        RTS: `/sales/rts/${id}/cancel`,
      };
      return apiPost(`${paths[kind]}${dry}`, { cancellationReason: reason, reason });
    },
    onSuccess: (_data, variables) => {
      if (variables.dryRun) return;
      setSalesCancelModal(null);
      qc.invalidateQueries({ queryKey: ["sales-sales-invoices"] });
      qc.invalidateQueries({ queryKey: ["sales-order-allocation"] });
      qc.invalidateQueries({ queryKey: ["store-rts"] });
      qc.invalidateQueries({ queryKey: ["store-order-allocations"] });
      qc.invalidateQueries({ queryKey: ["sales-oa"] });
      qc.invalidateQueries({ queryKey: ["sales-proforma"] });
      qc.invalidateQueries({ queryKey: ["sales-quotations"] });
      qc.invalidateQueries({ queryKey: ["quotation-detail"] });
      if (detailId) qc.invalidateQueries({ queryKey: ["oa-detail", detailId] });
      qc.invalidateQueries({ queryKey: ["stockBalances"] });
      qc.invalidateQueries({ queryKey: ["inventoryLedger"] });
      invalidateStockViews();
      if (variables.kind === "OA") setDetailId(null);
      setErr("");
    },
    onError: (e) => setErr(e.message),
  });

  const openOACancelModal = useCallback(
    async (oaId) => {
      setErr("");
      try {
        const preview = await salesCancelMutation.mutateAsync({
          kind: "OA",
          id: oaId,
          reason: "-",
          dryRun: true,
        });
        setSalesCancelModal({
          open: true,
          kind: "OA",
          id: oaId,
          reason: "",
          preview,
          confirmMessage: "Cancel this OA and release the quotation for editing?",
        });
      } catch (e) {
        setErr(e.message);
      }
    },
    [salesCancelMutation]
  );

  const openShippingDispatchDocument = useCallback(async (docId, inline) => {
    setShippingDownloadBusyId(docId);
    try {
      const path = inline ? `/documents/${docId}/download?inline=1` : `/documents/${docId}/download`;
      const data = await apiGet(path);
      if (!data?.url) {
        setErr("No download URL returned.");
        return;
      }
      const a = document.createElement("a");
      a.href = data.url;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.style.display = "none";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    } catch (e) {
      setErr(e.message || "Could not open file.");
    } finally {
      setShippingDownloadBusyId(null);
    }
  }, []);

  const openPaymentReceiptAttachment = useCallback(async (receiptId, inline = true) => {
    try {
      const path = inline
        ? `/payment-receipts/${receiptId}/attachment-url?inline=1`
        : `/payment-receipts/${receiptId}/attachment-url`;
      const data = await apiGet(path);
      if (!data?.url) throw new Error("No signed URL returned.");
      const a = document.createElement("a");
      a.href = data.url;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.style.display = "none";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    } catch (e) {
      setErr(e.message || "Could not open payment slip.");
    }
  }, []);

  const uploadShippingDispatchDocMutation = useMutation({
    mutationFn: async () => {
      const ctx = shippingDocsAfterDispatch;
      if (!ctx?.dispatchId) throw new Error("Missing dispatch.");
      const file = shippingFileRef.current?.files?.[0];
      if (!file) throw new Error("Choose a file (PDF, images, Office formats — max 10 MB).");
      const fd = new FormData();
      fd.append("documentType", shippingDocForm.documentType);
      fd.append("refNo", ctx.dispatchNo || "");
      fd.append("partyName", ctx.customerName || "");
      fd.append("moduleName", "Sales Dispatch");
      fd.append("relatedId", String(ctx.dispatchId));
      fd.append("remarks", shippingDocForm.remarks || "");
      fd.append("file", file);
      return apiPostFormData("/documents/upload", fd);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["shipping-docs-for-dispatch"] });
      qc.invalidateQueries({ queryKey: ["documents"] });
      if (shippingFileRef.current) shippingFileRef.current.value = "";
      setShippingDocForm((f) => ({ ...f, remarks: "" }));
    },
    onError: (e) => setErr(e.message),
  });

  const convertToSalesDispatchFromSalesInvoiceMutation = useMutation({
    mutationFn: (id) => apiPost(`/sales/convert/sales-invoice/${id}/to-sales-dispatch`, {}),
    onSuccess: (dispatch) => {
      qc.invalidateQueries({ queryKey: ["sales-sales-dispatch"] });
      qc.invalidateQueries({ queryKey: ["sales-sales-invoices"] });
      qc.invalidateQueries({ queryKey: ["accountsSalesDispatches"] });
      qc.invalidateQueries({ queryKey: ["sales-dispatch-status"] });
      if (detailId) qc.invalidateQueries({ queryKey: ["sales-invoice-detail", detailId] });
      setErr("");
      setShippingDocForm({ documentType: "Shipping Document", remarks: "" });
      if (shippingFileRef.current) shippingFileRef.current.value = "";
      setShippingDocsAfterDispatch({
        dispatchId: dispatch._id,
        dispatchNo: dispatch.dispatchNo || "",
        customerName: dispatch.customerName || "",
        linkedInvoiceNo: dispatch.linkedSalesInvoiceNo || "",
      });
    },
    onError: (e) => setErr(e.message),
  });

  const patchSalesDispatchMutation = useMutation({
    mutationFn: ({ id, body }) => apiPatch(`/sales/sales-dispatches/${id}`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["sales-sales-dispatch"] });
      qc.invalidateQueries({ queryKey: ["sales-dispatch-detail"] });
      qc.invalidateQueries({ queryKey: ["accountsSalesDispatches"] });
      qc.invalidateQueries({ queryKey: ["sales-dispatch-status"] });
    },
    onError: (e) => setErr(e.message),
  });

  const createSalesReturnMutation = useMutation({
    mutationFn: () => {
      const body = {
        customerName: String(srForm.customerName || "").trim(),
        warehouse: srForm.warehouse,
        currency: srForm.currency,
        remarks: srForm.remarks,
        lines: srForm.lines
          .filter((l) => String(l.article || "").trim())
          .map((l) => ({
            article: String(l.article || "").trim().toUpperCase(),
            partNumber: l.partNumber || "",
            description: l.description || "",
            qty: Number(l.qty) || 0,
            uom: l.uom || "PCS",
            unitPrice: Number(l.unitPrice) || 0,
            reason: l.reason || "",
          })),
      };
      if (!body.customerName) throw new Error("Customer name is required.");
      if (!body.lines.length) throw new Error("Add at least one line with an article code.");
      if (srForm.linkedSalesDispatchId) {
        body.linkedSalesDispatchId = srForm.linkedSalesDispatchId;
        body.linkedSalesDispatchNo = srForm.linkedSalesDispatchNo;
      }
      if (srForm.linkedSalesInvoiceId) {
        body.linkedSalesInvoiceId = srForm.linkedSalesInvoiceId;
        body.linkedSalesInvoiceNo = srForm.linkedSalesInvoiceNo;
      }
      return apiPost("/sales/sales-returns", body);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["sales-sales-returns"] });
      setSrCreateOpen(false);
      setSrForm({
        customerName: "",
        warehouse: "MAIN",
        currency: "USD",
        linkedSalesDispatchId: "",
        linkedSalesDispatchNo: "",
        linkedSalesInvoiceId: "",
        linkedSalesInvoiceNo: "",
        remarks: "",
        lines: [{ article: "", partNumber: "", description: "", qty: 1, uom: "PCS", unitPrice: 0, reason: "" }],
      });
    },
    onError: (e) => setErr(e.message),
  });

  const postSalesReturnMutation = useMutation({
    mutationFn: (id) => apiPatch(`/sales/sales-returns/${id}/post`, {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["sales-sales-returns"] });
      qc.invalidateQueries({ queryKey: ["inventoryLedger"] });
    },
    onError: (e) => setErr(e.message),
  });

  const [oaForm, setOaForm] = useState({
    oaDate: new Date().toISOString().slice(0, 10),
    customerName: "",
    paymentTerms: "",
    deliverySchedule: "",
    currency: "USD",
    vertical: "",
    engine: "",
    model: "",
    config: "",
    esn: "",
    lines: [emptyLine()],
  });

  const [proformaForm, setProformaForm] = useState({
    proformaDate: new Date().toISOString().slice(0, 10),
    customerName: "",
    paymentTerms: "",
    shipmentTerms: "",
    bankDetails: "",
    currency: "USD",
    vertical: "",
    engine: "",
    model: "",
    config: "",
    esn: "",
    lines: [emptyLine()],
  });

  const [salesInvoiceForm, setSalesInvoiceForm] = useState({
    invoiceDate: new Date().toISOString().slice(0, 10),
    customerName: "",
    paymentTerms: "",
    dispatchDetails: "",
    shippingAddress: "",
    billingAddress: "",
    customerReference: "",
    loadingPort: "",
    dischargePort: "",
    consignee: "",
    customerVatNo: "",
    currency: "USD",
    vertical: "",
    engine: "",
    model: "",
    config: "",
    esn: "",
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
        vertical: "",
        engine: "",
        model: "",
        config: "",
        esn: "",
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
        vertical: "",
        engine: "",
        model: "",
        config: "",
        esn: "",
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
        shippingAddress: "",
        billingAddress: "",
        customerReference: "",
        loadingPort: "",
        dischargePort: "",
        consignee: "",
        customerVatNo: "",
        currency: "USD",
        vertical: "",
        engine: "",
        model: "",
        config: "",
        esn: "",
        lines: [emptyLine()],
      });
    },
    onError: (e) => setErr(e.message),
  });

  const createSalesInvoiceFromPackingMutation = useMutation({
    mutationFn: (packingId) => apiPost(`/sales/sales-invoices/from-packing/${packingId}`, {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["sales-sales-invoices"] });
      qc.invalidateQueries({ queryKey: ["sales-packings-ready-invoice"] });
      qc.invalidateQueries({ queryKey: ["sales-dispatch-status"] });
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
  const allocationRows = allocationData?.items ?? [];
  const salesInvoiceRows = salesInvoiceData?.items ?? [];
  const salesDispatchRows =
    activeTab === "Dispatch Status" ? dispatchStatusData?.items ?? [] : salesDispatchData?.items ?? [];
  const salesDispatchLoading =
    activeTab === "Dispatch Status" ? dispatchStatusLoading : legacySalesDispatchLoading;
  const customerRows = customerData?.items ?? [];
  const customerOptions = customerLookupData?.items ?? customerRows;
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const oaTotalPages = Math.max(1, Math.ceil((oaData?.total ?? 0) / limit));
  const proformaTotalPages = Math.max(1, Math.ceil((proformaData?.total ?? 0) / limit));
  const allocationTotalPages = Math.max(1, Math.ceil((allocationData?.total ?? 0) / limit));
  const salesInvoiceTotalPages = Math.max(1, Math.ceil((salesInvoiceData?.total ?? 0) / limit));
  const salesDispatchTotalPages =
    activeTab === "Dispatch Status"
      ? 1
      : Math.max(1, Math.ceil((salesDispatchData?.total ?? 0) / limit));
  const salesReturnRows = salesReturnData?.items ?? [];
  const salesReturnTotalPages = Math.max(1, Math.ceil((salesReturnData?.total ?? 0) / limit));
  const customerTotalPages = Math.max(1, Math.ceil((customerData?.total ?? 0) / limit));
  const createQuotationTotals = calcQuotationTotalsView(form);

  const tabContent = useMemo(() => {
    if (activeTab === "Customer Master") return "customer-master";
    if (activeTab === "Quotation") return "quotation";
    if (activeTab === "Order Acknowledgement") return "oa";
    if (activeTab === "Proforma Invoice") return "proforma";
    if (activeTab === "Order Allocation") return "allocation";
    if (activeTab === "Sales Invoice") return "sales-invoice";
    if (activeTab === "Dispatch Status") return "dispatch-status";
    if (activeTab === "Sales Return") return "sales-return";
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
            disabled={
              activeTab === "Order Allocation" ||
              activeTab === "Reports" ||
              activeTab === "Dispatch Status" ||
              activeTab === "Sales Invoice"
            }
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
              else if (activeTab === "Sales Return") setSrCreateOpen(true);
            }}
            className="rounded-xl bg-gray-900 px-3 py-2 text-sm font-semibold text-white shadow-sm disabled:opacity-40"
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
              ? "Create from Packing"
              : activeTab === "Dispatch Status"
              ? "Create from dispatched invoice"
              : activeTab === "Sales Return"
              ? "New sales return"
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
            { label: "Total Sales Value", value: `${summaryCurrency} ${money(salesSummary?.totalSalesValue)}` },
            { label: "Total CIPL", value: salesSummary?.totalCipl },
            { label: "This Month Sales", value: `${summaryCurrency} ${money(salesSummary?.thisMonthSales)}` },
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

      <Modal
        open={!!salesCancelModal?.open}
        onClose={() => {
          if (!salesCancelMutation.isPending) setSalesCancelModal(null);
        }}
        title="Confirm cancellation"
      >
        {salesCancelModal?.open ? (
          <div className="space-y-3 text-sm">
            <p className="text-gray-700">
              {salesCancelModal.kind === "OA" && salesCancelModal.confirmMessage
                ? salesCancelModal.confirmMessage
                : (
                  <>
                    Cancelling{" "}
                    {salesCancelModal.kind === "SI"
                      ? "this sales invoice"
                      : salesCancelModal.kind === "ALC"
                      ? "this order allocation"
                      : salesCancelModal.kind === "RTS"
                      ? "this RTS"
                      : salesCancelModal.kind === "OA"
                      ? "this order acknowledgement"
                      : "this proforma"}{" "}
                    applies a single-step stock reversal (see preview below).
                  </>
                )}
            </p>
            {Array.isArray(salesCancelModal.preview?.stockImpact) && salesCancelModal.preview.stockImpact.length > 0 ? (
              <div className="rounded-lg border bg-gray-50 p-2">
                <p className="mb-2 text-xs font-semibold uppercase text-gray-600">Stock impact preview</p>
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-left text-gray-500">
                      <th className="py-1">Article</th>
                      <th className="py-1 text-right">Qty</th>
                      <th className="py-1 text-right">Move</th>
                    </tr>
                  </thead>
                  <tbody>
                    {salesCancelModal.preview.stockImpact.map((row, i) => (
                      <tr key={i} className="border-t border-gray-200">
                        <td className="py-1 font-mono">{row.article}</td>
                        <td className="py-1 text-right tabular-nums">{row.qty}</td>
                        <td className="py-1 text-right text-gray-600">
                          {row.from} → {row.to}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
            <FormField label="Cancellation reason (required)">
              <TextInput
                value={salesCancelModal.reason}
                onChange={(e) => setSalesCancelModal((m) => (m ? { ...m, reason: e.target.value } : m))}
                placeholder="e.g. Customer requested to stop shipment"
              />
            </FormField>
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                className="rounded-lg border px-3 py-1.5"
                disabled={salesCancelMutation.isPending}
                onClick={() => setSalesCancelModal(null)}
              >
                Close
              </button>
              <button
                type="button"
                disabled={salesCancelMutation.isPending || !String(salesCancelModal.reason || "").trim()}
                className="rounded-lg bg-gray-900 px-3 py-1.5 text-white disabled:opacity-50"
                onClick={() =>
                  salesCancelMutation.mutate({
                    kind: salesCancelModal.kind,
                    id: salesCancelModal.id,
                    reason: String(salesCancelModal.reason || "").trim(),
                    dryRun: false,
                  })
                }
              >
                {salesCancelMutation.isPending ? "Working…" : "Confirm cancel"}
              </button>
            </div>
          </div>
        ) : null}
      </Modal>

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

          <div ref={reportViewerRef} className="scroll-mt-24 rounded-2xl border bg-white p-4 shadow-sm">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <div>
                <h4 className="text-sm font-semibold uppercase tracking-wide text-gray-700">{activeReportTitle}</h4>
                <p className="mt-1 text-xs text-gray-500">Filters and exports apply to this report. Pick another report from the catalog below.</p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  className="rounded-lg border border-gray-300 bg-white px-2.5 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-100 disabled:opacity-50"
                  onClick={exportActiveReportCsv}
                  disabled={!activeExportColumns.length || reportLoading || reportIsError || !reportApiPath}
                >
                  Export CSV
                </button>
                <button
                  type="button"
                  className="rounded-lg border border-gray-300 bg-white px-2.5 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-100 disabled:opacity-50"
                  onClick={exportActiveReportExcel}
                  disabled={!activeExportColumns.length || reportLoading || reportIsError || !reportApiPath}
                >
                  Export Excel
                </button>
                <button
                  type="button"
                  className="rounded-lg border border-gray-300 bg-white px-2.5 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-100 disabled:opacity-50"
                  onClick={() => openReportPrintWindow(true)}
                  disabled={!activeExportColumns.length || reportLoading || reportIsError || !reportApiPath}
                >
                  Export PDF
                </button>
                <button
                  type="button"
                  className="rounded-lg bg-gray-900 px-2.5 py-1.5 text-xs font-medium text-white shadow-sm disabled:opacity-50"
                  onClick={() => openReportPrintWindow(false)}
                  disabled={!activeExportColumns.length || reportLoading || reportIsError || !reportApiPath}
                >
                  Print
                </button>
              </div>
            </div>

            {reportApiPath ? (
              <>
                {reportIsError ? (
                  <div className="mb-3 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">
                    {reportQueryError?.message || "Could not load this report. Check your connection and try again."}
                  </div>
                ) : null}
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
                              <th className="px-3 py-2">Vertical</th>
                              <th className="px-3 py-2">Brand</th>
                              <th className="px-3 py-2">Model</th>
                              <th className="px-3 py-2">Config</th>
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
                              <th className="px-3 py-2">Vertical</th>
                              <th className="px-3 py-2">Brand</th>
                              <th className="px-3 py-2">Model</th>
                              <th className="px-3 py-2">Config</th>
                              <th className="px-3 py-2">ESN</th>
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
                              <th className="px-3 py-2">Vertical</th>
                              <th className="px-3 py-2">Brand</th>
                              <th className="px-3 py-2">Model</th>
                              <th className="px-3 py-2">Config</th>
                              <th className="px-3 py-2">ESN</th>
                              <th className="px-3 py-2 text-right">Total</th>
                              <th className="px-3 py-2">Status</th>
                            </>
                          )}
                          {activeReportId === "pending-order-acknowledgement" && (
                            <>
                              <th className="px-3 py-2">OA No</th>
                              <th className="px-3 py-2">Customer</th>
                              <th className="px-3 py-2">Quotation Link</th>
                              <th className="px-3 py-2">Vertical</th>
                              <th className="px-3 py-2">Brand</th>
                              <th className="px-3 py-2">Model</th>
                              <th className="px-3 py-2">Config</th>
                              <th className="px-3 py-2">ESN</th>
                              <th className="px-3 py-2 text-right">Amount</th>
                              <th className="px-3 py-2">Age (Days)</th>
                              <th className="px-3 py-2">Status</th>
                            </>
                          )}
                          {activeReportId === "order-allocation" && (
                            <>
                              <th className="px-3 py-2">Allocation No</th>
                              <th className="px-3 py-2">Date</th>
                              <th className="px-3 py-2">Linked OA</th>
                              <th className="px-3 py-2">Linked PI</th>
                              <th className="px-3 py-2">Customer</th>
                              <th className="px-3 py-2">Vertical</th>
                              <th className="px-3 py-2">Brand</th>
                              <th className="px-3 py-2">Model</th>
                              <th className="px-3 py-2">Config</th>
                              <th className="px-3 py-2">ESN</th>
                              <th className="px-3 py-2 text-right">Line Count</th>
                              <th className="px-3 py-2">Status</th>
                            </>
                          )}
                          {activeReportId === "rts" && (
                            <>
                              <th className="px-3 py-2">RTS No</th>
                              <th className="px-3 py-2">Date</th>
                              <th className="px-3 py-2">Allocation No</th>
                              <th className="px-3 py-2">Customer</th>
                              <th className="px-3 py-2">Vertical</th>
                              <th className="px-3 py-2">Brand</th>
                              <th className="px-3 py-2">Model</th>
                              <th className="px-3 py-2">Config</th>
                              <th className="px-3 py-2">ESN</th>
                              <th className="px-3 py-2 text-right">Line Count</th>
                              <th className="px-3 py-2 text-right">Box Count</th>
                              <th className="px-3 py-2 text-right">Total Weight Kg</th>
                              <th className="px-3 py-2">Status</th>
                            </>
                          )}
                          {activeReportId === "backorder" && (
                            <>
                              <th className="px-3 py-2">Customer</th>
                              <th className="px-3 py-2">Article</th>
                              <th className="px-3 py-2">Ref No</th>
                              <th className="px-3 py-2 text-right">Ordered Qty</th>
                              <th className="px-3 py-2 text-right">Allocated Qty</th>
                              <th className="px-3 py-2 text-right">Pending Qty</th>
                              <th className="px-3 py-2 text-right">RTS Qty</th>
                              <th className="px-3 py-2 text-right">Invoice Qty</th>
                              <th className="px-3 py-2 text-right">Available</th>
                              <th className="px-3 py-2">Expected GRN</th>
                            </>
                          )}
                          {activeReportId === "proforma" && (
                            <>
                              <th className="px-3 py-2">Proforma No</th>
                              <th className="px-3 py-2">Date</th>
                              <th className="px-3 py-2">Linked Quotation/OA</th>
                              <th className="px-3 py-2">Customer</th>
                              <th className="px-3 py-2">Vertical</th>
                              <th className="px-3 py-2">Brand</th>
                              <th className="px-3 py-2">Model</th>
                              <th className="px-3 py-2">Config</th>
                              <th className="px-3 py-2">ESN</th>
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
                              <th className="px-3 py-2">Vertical</th>
                              <th className="px-3 py-2">Brand</th>
                              <th className="px-3 py-2">Model</th>
                              <th className="px-3 py-2">Config</th>
                              <th className="px-3 py-2">ESN</th>
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
                              <th className="px-3 py-2">Vertical</th>
                              <th className="px-3 py-2">Brand</th>
                              <th className="px-3 py-2">Model</th>
                              <th className="px-3 py-2">Config</th>
                              <th className="px-3 py-2">ESN</th>
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
                        ) : reportIsError ? (
                          <tr>
                            <td className="px-3 py-8 text-center text-gray-500" colSpan={12}>
                              Report failed to load. See the message above or adjust filters and retry.
                            </td>
                          </tr>
                        ) : activeReportRows.length === 0 ? (
                          <tr>
                            <td className="px-3 py-8 text-center text-gray-500" colSpan={12}>
                              No rows found for current filters. Adjust date/status/customer and try again.
                            </td>
                          </tr>
                        ) : (
                          activeReportRows.map((row) => (
                            <tr key={row._id} className="border-b border-gray-100 hover:bg-gray-50/80">
                              {activeReportId === "quotation-summary" && (
                                <>
                                  <td className="px-3 py-2 font-mono text-xs">{row.quotationNo}</td>
                                  <td className="px-3 py-2">{row.quotationDate ? new Date(row.quotationDate).toLocaleDateString() : "-"}</td>
                                  <td className="px-3 py-2">{row.customerName}</td>
                                  <td className="px-3 py-2">{row.customerReference || "-"}</td>
                                  <td className="px-3 py-2">{row.vertical || "-"}</td>
                                  <td className="px-3 py-2">{row.engine || "-"}</td>
                                  <td className="px-3 py-2">{row.model || "-"}</td>
                                  <td className="px-3 py-2">{row.config || "-"}</td>
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
                                  <td className="px-3 py-2">{row.vertical || "-"}</td>
                                  <td className="px-3 py-2">{row.engine || "-"}</td>
                                  <td className="px-3 py-2">{row.model || "-"}</td>
                                  <td className="px-3 py-2">{row.config || "-"}</td>
                                  <td className="px-3 py-2">{row.esn || "-"}</td>
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
                                  <td className="px-3 py-2">{row.vertical || "-"}</td>
                                  <td className="px-3 py-2">{row.engine || "-"}</td>
                                  <td className="px-3 py-2">{row.model || "-"}</td>
                                  <td className="px-3 py-2">{row.config || "-"}</td>
                                  <td className="px-3 py-2">{row.esn || "-"}</td>
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
                                  <td className="px-3 py-2">{row.vertical || "-"}</td>
                                  <td className="px-3 py-2">{row.engine || "-"}</td>
                                  <td className="px-3 py-2">{row.model || "-"}</td>
                                  <td className="px-3 py-2">{row.config || "-"}</td>
                                  <td className="px-3 py-2">{row.esn || "-"}</td>
                                  <td className="px-3 py-2 text-right">USD {money(row.amount)}</td>
                                  <td className="px-3 py-2">{row.ageDays || 0}</td>
                                  <td className="px-3 py-2">
                                    <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ${statusBadgeClass(row.status)}`}>
                                      {row.status}
                                    </span>
                                  </td>
                                </>
                              )}
                              {activeReportId === "order-allocation" && (
                                <>
                                  <td className="px-3 py-2 font-mono text-xs">{row.allocationNo}</td>
                                  <td className="px-3 py-2">{row.allocationDate ? new Date(row.allocationDate).toLocaleDateString() : "-"}</td>
                                  <td className="px-3 py-2">{row.linkedOANo || "-"}</td>
                                  <td className="px-3 py-2">{row.linkedProformaNo || "-"}</td>
                                  <td className="px-3 py-2">{row.customerName || "-"}</td>
                                  <td className="px-3 py-2">{row.vertical || "-"}</td>
                                  <td className="px-3 py-2">{row.engine || "-"}</td>
                                  <td className="px-3 py-2">{row.model || "-"}</td>
                                  <td className="px-3 py-2">{row.config || "-"}</td>
                                  <td className="px-3 py-2">{row.esn || "-"}</td>
                                  <td className="px-3 py-2 text-right">{row.lineCount || 0}</td>
                                  <td className="px-3 py-2">
                                    <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ${statusBadgeClass(row.status)}`}>
                                      {row.status}
                                    </span>
                                  </td>
                                </>
                              )}
                              {activeReportId === "rts" && (
                                <>
                                  <td className="px-3 py-2 font-mono text-xs">{row.rtsNo}</td>
                                  <td className="px-3 py-2">{row.rtsDate ? new Date(row.rtsDate).toLocaleDateString() : "-"}</td>
                                  <td className="px-3 py-2">{row.linkedOrderAllocationNo || "-"}</td>
                                  <td className="px-3 py-2">{row.customerName || "-"}</td>
                                  <td className="px-3 py-2">{row.vertical || "-"}</td>
                                  <td className="px-3 py-2">{row.engine || "-"}</td>
                                  <td className="px-3 py-2">{row.model || "-"}</td>
                                  <td className="px-3 py-2">{row.config || "-"}</td>
                                  <td className="px-3 py-2">{row.esn || "-"}</td>
                                  <td className="px-3 py-2 text-right">{row.lineCount || 0}</td>
                                  <td className="px-3 py-2 text-right">{row.boxCount || 0}</td>
                                  <td className="px-3 py-2 text-right">{money(row.totalWeightKg || 0)}</td>
                                  <td className="px-3 py-2">
                                    <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ${statusBadgeClass(row.status)}`}>
                                      {row.status}
                                    </span>
                                  </td>
                                </>
                              )}
                              {activeReportId === "backorder" && (
                                <>
                                  <td className="px-3 py-2">{row.customer || row.customerName || "-"}</td>
                                  <td className="px-3 py-2 font-mono text-xs">{row.article || "-"}</td>
                                  <td className="px-3 py-2 font-mono text-xs">{row.refNo || row.referenceNo || "-"}</td>
                                  <td className="px-3 py-2 text-right">{row.orderedQty || 0}</td>
                                  <td className="px-3 py-2 text-right">{row.allocatedQty || 0}</td>
                                  <td className="px-3 py-2 text-right font-semibold text-amber-700">{row.pendingQty || 0}</td>
                                  <td className="px-3 py-2 text-right">{row.rtsQty || 0}</td>
                                  <td className="px-3 py-2 text-right">{row.invoiceQty || 0}</td>
                                  <td className={`px-3 py-2 text-right font-semibold ${Number(row.available || 0) < 0 ? "text-rose-700" : ""}`}>
                                    {row.available ?? ""}
                                  </td>
                                  <td className="px-3 py-2">{row.expectedGrn || "-"}</td>
                                </>
                              )}
                              {activeReportId === "proforma" && (
                                <>
                                  <td className="px-3 py-2 font-mono text-xs">{row.proformaNo}</td>
                                  <td className="px-3 py-2">{row.proformaDate ? new Date(row.proformaDate).toLocaleDateString() : "-"}</td>
                                  <td className="px-3 py-2">{row.linkedOANo || row.linkedQuotationNo || "-"}</td>
                                  <td className="px-3 py-2">{row.customerName}</td>
                                  <td className="px-3 py-2">{row.vertical || "-"}</td>
                                  <td className="px-3 py-2">{row.engine || "-"}</td>
                                  <td className="px-3 py-2">{row.model || "-"}</td>
                                  <td className="px-3 py-2">{row.config || "-"}</td>
                                  <td className="px-3 py-2">{row.esn || "-"}</td>
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
                                  <td className="px-3 py-2">{row.vertical || "-"}</td>
                                  <td className="px-3 py-2">{row.engine || "-"}</td>
                                  <td className="px-3 py-2">{row.model || "-"}</td>
                                  <td className="px-3 py-2">{row.config || "-"}</td>
                                  <td className="px-3 py-2">{row.esn || "-"}</td>
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
                                  <td className="px-3 py-2">{row.vertical || "-"}</td>
                                  <td className="px-3 py-2">{row.engine || "-"}</td>
                                  <td className="px-3 py-2">{row.model || "-"}</td>
                                  <td className="px-3 py-2">{row.config || "-"}</td>
                                  <td className="px-3 py-2">{row.esn || "-"}</td>
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
                          window.setTimeout(() => {
                            reportViewerRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
                          }, 0);
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
            {!canEditCustomers ? (
              <p className="text-xs text-gray-500">
                Only admins can edit customer records. Contact an administrator to update details.
              </p>
            ) : null}
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
                    {canEditCustomers ? <th className="px-3 py-2 text-right">Actions</th> : null}
                  </tr>
                </thead>
                <tbody>
                  {customerLoading ? (
                    <tr>
                      <td colSpan={canEditCustomers ? 7 : 6} className="px-3 py-8 text-center text-gray-500">
                        Loading...
                      </td>
                    </tr>
                  ) : customerRows.length === 0 ? (
                    <tr>
                      <td colSpan={canEditCustomers ? 7 : 6} className="px-3 py-8 text-center text-gray-500">
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
                        {canEditCustomers ? (
                          <td className="px-3 py-2 text-right">
                            <button
                              type="button"
                              className="rounded-lg border border-gray-300 bg-white px-2 py-1 text-xs font-medium text-gray-800 hover:bg-gray-50"
                              onClick={() => {
                                setErr("");
                                setCustomerEditId(r._id);
                                setCustomerEditForm({
                                  name: r.name || "",
                                  contactName: r.contactName || "",
                                  phone: r.phone || "",
                                  email: r.email || "",
                                  address: r.address || "",
                                  paymentTerms: r.paymentTerms === "ADVANCE" ? "ADVANCE" : "CREDIT",
                                  notes: r.notes || "",
                                });
                                setCustomerEditOpen(true);
                              }}
                            >
                              Edit
                            </button>
                          </td>
                        ) : null}
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
            <select
              className="w-44 rounded-xl border px-3 py-2 text-sm"
              value={brandFilter}
              onChange={(e) => {
                setBrandFilter(e.target.value);
                setPage(1);
              }}
            >
              <option value="">All brands</option>
              {(quotationFacets?.brands || []).map((brand) => (
                <option key={brand} value={brand}>
                  {brand}
                </option>
              ))}
            </select>
            <select
              className="w-44 rounded-xl border px-3 py-2 text-sm"
              value={verticalFilter}
              onChange={(e) => {
                setVerticalFilter(e.target.value);
                setPage(1);
              }}
            >
              <option value="">All verticals</option>
              {(quotationFacets?.verticals || []).map((vertical) => (
                <option key={vertical} value={vertical}>
                  {vertical}
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
                  { label: "Brand", value: (r) => r.engine || "" },
                  { label: "Vertical", value: (r) => r.vertical || "" },
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
                    <th className="px-3 py-2">Brand</th>
                    <th className="px-3 py-2">Vertical</th>
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
                        <td className="px-3 py-2">{r.vertical || "-"}</td>
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
                            {canDeleteQuotations ? (
                              <button
                                type="button"
                                className="rounded-lg border border-rose-300 px-2 py-1 text-xs text-rose-700 disabled:opacity-50"
                                disabled={
                                  deleteQuotationMutation.isPending || !quotationListCanDelete(r, canDeleteQuotations)
                                }
                                title={quotationListDeleteTitle(r, canDeleteQuotations)}
                                onClick={() => {
                                  if (!quotationListCanDelete(r, canDeleteQuotations)) return;
                                  if (!window.confirm("Delete this quotation? This action cannot be undone.")) return;
                                  deleteQuotationMutation.mutate(r._id);
                                }}
                              >
                                {deleteQuotationMutation.isPending ? "Deleting…" : "Delete"}
                              </button>
                            ) : null}
                            {String(r.status || "").toUpperCase() !== "CANCELLED" ? (
                              <button
                                type="button"
                                className="rounded-lg border px-2 py-1 text-xs"
                                onClick={() => duplicateMutation.mutate(r._id)}
                              >
                                Duplicate
                              </button>
                            ) : null}
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
          <div className="mb-3 rounded-2xl border bg-white p-3 shadow-sm">
            <div className="mb-2 flex items-center justify-between gap-2">
              <div>
                <h3 className="text-sm font-semibold">Ready for Invoice</h3>
                <p className="text-xs text-gray-500">Posted packing documents with pending invoice quantity.</p>
              </div>
              <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-semibold text-emerald-800 ring-1 ring-emerald-200">
                Packing → Sales Invoice
              </span>
            </div>
            <div className="max-h-56 overflow-auto">
              <table className="min-w-full text-left text-xs">
                <thead className="bg-gray-100 uppercase text-gray-600">
                  <tr>
                    <th className="px-2 py-2">Packing No</th>
                    <th className="px-2 py-2">Customer</th>
                    <th className="px-2 py-2">Allocation</th>
                    <th className="px-2 py-2">OA</th>
                    <th className="px-2 py-2">PI</th>
                    <th className="px-2 py-2 text-right">Packed</th>
                    <th className="px-2 py-2 text-right">Pending Invoice</th>
                    <th className="px-2 py-2">Status</th>
                    <th className="px-2 py-2 text-right">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {(readyPackingInvoiceData?.items || []).length === 0 ? (
                    <tr>
                      <td colSpan={9} className="px-2 py-4 text-center text-gray-500">
                        No packing documents ready for invoice.
                      </td>
                    </tr>
                  ) : (
                    (readyPackingInvoiceData?.items || []).map((p) => (
                      <tr key={p._id} className="border-t">
                        <td className="px-2 py-2 font-mono">{p.packingNo}</td>
                        <td className="px-2 py-2">{p.customerName}</td>
                        <td className="px-2 py-2 font-mono">{p.allocationNo}</td>
                        <td className="px-2 py-2">{p.linkedOANo || "—"}</td>
                        <td className="px-2 py-2">{p.linkedProformaNo || "—"}</td>
                        <td className="px-2 py-2 text-right">{p.packedQty}</td>
                        <td className="px-2 py-2 text-right font-semibold">{p.pendingInvoiceQty}</td>
                        <td className="px-2 py-2">
                          <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ${statusBadgeClass(p.invoiceStatus || "NOT_INVOICED")}`}>
                            {p.invoiceStatus || "NOT_INVOICED"}
                          </span>
                        </td>
                        <td className="px-2 py-2 text-right">
                          <button
                            type="button"
                            className="rounded-lg border px-2 py-1 text-xs"
                            disabled={createSalesInvoiceFromPackingMutation.isPending}
                            onClick={() => createSalesInvoiceFromPackingMutation.mutate(p._id)}
                          >
                            Create Invoice
                          </button>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
          <div className="overflow-hidden rounded-2xl border bg-white">
            <div className="overflow-x-auto">
              <table className="min-w-full text-left text-sm">
                <thead className="sticky top-0 z-10 border-b bg-gray-100 text-xs font-semibold uppercase tracking-wide text-gray-700">
                  <tr>
                    <th className="px-3 py-2">OA No</th>
                    <th className="px-3 py-2">Customer</th>
                    <th className="px-3 py-2">Packing</th>
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
                      const hasPIFromOA = orderAcknowledgementHasActiveProforma(r);
                      const isCancelled = String(r.status || "").toUpperCase() === "CANCELLED";
                      const canCancelOa = orderAcknowledgementCanCancel(r);
                      const cancelOaTitle = canCancelOa
                        ? "Cancel OA and release linked quotation"
                        : orderAcknowledgementCancelBlockReason(r);
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
                            <button
                              type="button"
                              className={`rounded-lg border border-amber-300 px-2 py-1 text-xs text-amber-900 ${!canCancelOa ? "opacity-40" : "hover:bg-amber-50"}`}
                              disabled={!canCancelOa}
                              title={cancelOaTitle}
                              onClick={() => openOACancelModal(r._id)}
                            >
                              Cancel OA
                            </button>
                            <button type="button" className="rounded-lg border px-2 py-1 text-xs" onClick={() => openFlowDocumentPrint("oa", r._id)}>
                              Print
                            </button>
                            <button type="button" className="rounded-lg border px-2 py-1 text-xs" onClick={() => openFlowDocumentPrint("oa", r._id, true)}>
                              Export PDF
                            </button>
                            <button
                              type="button"
                              className={`rounded-lg border px-2 py-1 text-xs ${hasPIFromOA || isCancelled ? "opacity-40" : ""}`}
                              disabled={hasPIFromOA || isCancelled}
                              title={isCancelled ? "Cancelled OA cannot be converted" : hasPIFromOA ? "Proforma already created from this OA" : ""}
                              onClick={() => convertToProformaFromOAMutation.mutate(r._id)}
                            >
                              Convert to PI
                            </button>
                            <button
                              type="button"
                              className={`rounded-lg border px-2 py-1 text-xs ${isCancelled ? "opacity-40" : ""}`}
                              disabled={isCancelled}
                              title={isCancelled ? "Cancelled OA cannot be converted" : ""}
                              onClick={() => convertToCiplFromOAMutation.mutate(r._id)}
                            >
                              Convert to CIPL
                            </button>
                            <button
                              type="button"
                              className={`rounded-lg border px-2 py-1 text-xs ${isCancelled ? "opacity-40" : ""}`}
                              disabled={isCancelled}
                              title={isCancelled ? "Cancelled OA cannot be converted" : ""}
                              onClick={() => convertToOrderAllocationFromOAMutation.mutate({ id: r._id })}
                            >
                              Convert to Order Allocation
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
                  { label: "Status", value: (r) => proformaDisplayStatus(r) },
                  { label: "Currency", value: (r) => r.currency || "USD" },
                  { label: "Total", value: (r) => money(r.grandTotal) },
                ])
              }
            >
              Export CSV
            </button>
            <button
              type="button"
              className="rounded-xl border px-3 py-2 text-sm disabled:opacity-50"
              disabled={recalcProformaPaymentStateMutation.isLoading}
              title="Recompute totalReceived / paymentStatus / status for all proformas from posted receipts"
              onClick={() => recalcProformaPaymentStateMutation.mutate()}
            >
              {recalcProformaPaymentStateMutation.isLoading ? "Refreshing..." : "Refresh payment state"}
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
                    <th className="px-3 py-2">Payment</th>
                    <th className="px-3 py-2 text-right">Received</th>
                    <th className="px-3 py-2 text-right">Balance</th>
                    <th className="px-3 py-2 text-right">Grand Total</th>
                    <th className="px-3 py-2">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {proformaLoading ? (
                    <tr>
                      <td colSpan={10} className="px-3 py-8 text-center text-gray-500">
                        Loading...
                      </td>
                    </tr>
                  ) : proformaRows.length === 0 ? (
                    <tr>
                      <td colSpan={10} className="px-3 py-8 text-center text-gray-500">
                        No Proforma found.
                      </td>
                    </tr>
                  ) : (
                    proformaRows.map((r) => {
                      const rowStatus = String(r.status || "").toUpperCase();
                      const piApproved = ["APPROVED", "CONVERTED"].includes(rowStatus);
                      const st = String(r.status || "").toUpperCase();
                      const isCancelled = rowStatus === "CANCELLED";
                      const paymentStatus = String(r.paymentStatus || "UNPAID").toUpperCase();
                      const received = Number(r.totalReceivedAmount || 0);
                      const balance = Number(r.balanceAmount ?? r.grandTotal ?? 0);
                      const canMarkPaid = !["CANCELLED", "CONVERTED"].includes(st) && paymentStatus !== "PAID";
                      const canCancelPi = !["CANCELLED", "CONVERTED"].includes(st);
                      return (
                      <tr key={r._id} className="border-b border-gray-100 hover:bg-gray-50/80">
                        <td className="px-3 py-2 font-mono text-xs">{r.proformaNo}</td>
                        <td className="px-3 py-2">{r.customerName}</td>
                        <td className="px-3 py-2">{r.proformaDate ? new Date(r.proformaDate).toLocaleDateString() : "—"}</td>
                        <td className="px-3 py-2">
                          <span
                            className={`inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ${statusBadgeClass(proformaDisplayStatus(r))}`}
                          >
                            {proformaDisplayStatus(r)}
                          </span>
                        </td>
                        <td className="px-3 py-2">
                          <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ${statusBadgeClass(paymentStatus)}`}>
                            {paymentStatus.replaceAll("_", " ")}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-right">{r.currency} {money(received)}</td>
                        <td className="px-3 py-2 text-right">{r.currency} {money(balance)}</td>
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
                              className={`rounded-lg border px-2 py-1 text-xs ${!canMarkPaid ? "opacity-40" : ""}`}
                              disabled={!canMarkPaid}
                              title={!canMarkPaid ? "Proforma already fully paid or unavailable for payment posting" : "Record payment receipt"}
                              onClick={() => {
                                setReceivePaymentModal({ open: true, proforma: r });
                                setReceivePaymentForm((f) => ({
                                  ...f,
                                  receiptDate: new Date().toISOString().slice(0, 10),
                                  amountReceived: Number(r.balanceAmount ?? r.grandTotal ?? 0),
                                  currency: r.currency || "USD",
                                  paymentMode: "BANK_TRANSFER",
                                  bankCashAccountName: "",
                                  bankAccountId: "",
                                  cashAccountId: "",
                                  paymentReference: "",
                                  remarks: "",
                                  adminOverride: false,
                                  attachmentFile: null,
                                }));
                                if (paymentSlipInputRef.current) paymentSlipInputRef.current.value = "";
                              }}
                            >
                              Mark payment received
                            </button>
                            <button
                              type="button"
                              className="rounded-lg border px-2 py-1 text-xs"
                              onClick={() => setViewPaymentsModal({ open: true, proforma: r })}
                            >
                              View Payments
                            </button>
                            <button
                              type="button"
                              className={`rounded-lg border px-2 py-1 text-xs ${!canCancelPi ? "opacity-40" : ""}`}
                              disabled={!canCancelPi}
                              title={!canCancelPi ? "Cannot cancel" : "Cancel proforma"}
                              onClick={() =>
                                setSalesCancelModal({
                                  open: true,
                                  kind: "PI",
                                  id: r._id,
                                  reason: "",
                                  preview: { stockImpact: [] },
                                })
                              }
                            >
                              Cancel PI
                            </button>
                            <button
                              type="button"
                              className={`rounded-lg border px-2 py-1 text-xs ${piApproved || isCancelled ? "opacity-40" : ""}`}
                              disabled={piApproved || isCancelled}
                              title={isCancelled ? "Cancelled proforma cannot be converted" : piApproved ? "Already converted from this PI" : ""}
                              onClick={() => convertProformaToCiplMutation.mutate(r._id)}
                            >
                              Convert to CIPL
                            </button>
                            {(() => {
                              const piStatus = String(r.status || "").toUpperCase();
                              const allocReady =
                                ["APPROVED", "PAID_PENDING_SHIPMENT"].includes(piStatus) ||
                                paymentStatus === "PAID";
                              const allocDisabled = isCancelled || !allocReady;
                              return (
                                <button
                                  type="button"
                                  className={`rounded-lg border px-2 py-1 text-xs ${allocDisabled ? "opacity-40" : ""}`}
                                  disabled={allocDisabled}
                                  title={
                                    isCancelled
                                      ? "Cancelled proforma cannot be converted"
                                      : !allocReady
                                      ? "Proforma must be APPROVED or PAID before allocation"
                                      : ""
                                  }
                                  onClick={() => convertToOrderAllocationFromProformaMutation.mutate({ id: r._id })}
                                >
                                  Convert to Order Allocation
                                </button>
                              );
                            })()}
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
      ) : tabContent === "allocation" ? (
        <>
          <div className="mb-3 flex flex-wrap items-end gap-2 rounded-2xl border bg-white p-3 shadow-sm">
            <TextInput
              placeholder="Search allocation/customer"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
              className="w-64"
            />
          </div>
          <div className="overflow-hidden rounded-2xl border bg-white">
            <div className="overflow-x-auto">
              <table className="min-w-full text-left text-sm">
                <thead className="sticky top-0 z-10 border-b bg-gray-100 text-xs font-semibold uppercase tracking-wide text-gray-700">
                  <tr>
                    <th className="px-3 py-2">Allocation No</th>
                    <th className="px-3 py-2">Date</th>
                    <th className="px-3 py-2">Customer</th>
                    <th className="px-3 py-2">Linked OA</th>
                    <th className="px-3 py-2">Linked PI</th>
                    <th className="px-3 py-2">Status</th>
                    <th className="px-3 py-2">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {allocationLoading ? (
                    <tr>
                      <td colSpan={7} className="px-3 py-8 text-center text-gray-500">
                        Loading...
                      </td>
                    </tr>
                  ) : allocationRows.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="px-3 py-8 text-center text-gray-500">
                        No order allocation found.
                      </td>
                    </tr>
                  ) : (
                    allocationRows.map((r) => (
                      <tr key={r._id} className="border-b border-gray-100 hover:bg-gray-50/80">
                        <td className="px-3 py-2 font-mono text-xs">{r.allocationNo}</td>
                        <td className="px-3 py-2">{r.allocationDate ? new Date(r.allocationDate).toLocaleDateString() : "-"}</td>
                        <td className="px-3 py-2">{r.customerName}</td>
                        <td className="px-3 py-2">{r.linkedOANo || "-"}</td>
                        <td className="px-3 py-2">{r.linkedProformaNo || "-"}</td>
                        <td className="px-3 py-2">
                          <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ${statusBadgeClass(r.status)}`}>
                            {r.status}
                          </span>
                        </td>
                        <td className="px-3 py-2">
                          <div className="flex flex-wrap gap-1">
                            <button
                              type="button"
                              className={`rounded-lg border px-2 py-1 text-xs ${
                                r.linkedSalesInvoiceId || String(r.status || "").toUpperCase() === "CANCELLED"
                                  ? "opacity-40"
                                  : ""
                              }`}
                              disabled={!!r.linkedSalesInvoiceId || String(r.status || "").toUpperCase() === "CANCELLED"}
                              title={
                                r.linkedSalesInvoiceId
                                  ? "Cancel the sales invoice first"
                                  : String(r.status || "").toUpperCase() === "CANCELLED"
                                  ? "Already cancelled"
                                  : "Release reservation (cancel allocation)"
                              }
                              onClick={async () => {
                                setErr("");
                                try {
                                  const preview = await salesCancelMutation.mutateAsync({
                                    kind: "ALC",
                                    id: r._id,
                                    reason: "-",
                                    dryRun: true,
                                  });
                                  setSalesCancelModal({
                                    open: true,
                                    kind: "ALC",
                                    id: r._id,
                                    reason: "",
                                    preview,
                                  });
                                } catch (e) {
                                  setErr(e.message);
                                }
                              }}
                            >
                              Cancel allocation
                            </button>
                            <button
                              type="button"
                              className="rounded-lg border px-2 py-1 text-xs"
                              title="Order allocation document"
                              onClick={() =>
                                apiGet(`/sales/order-allocations/${r._id}`)
                                  .then((doc) => renderOrderAllocationPrintWindow(doc, activeCompany))
                                  .catch((e) => setErr(e.message))
                              }
                            >
                              Print
                            </button>
                            <button
                              type="button"
                              className="rounded-lg border px-2 py-1 text-xs"
                              title="Order allocation PDF (print to PDF)"
                              onClick={() =>
                                apiGet(`/sales/order-allocations/${r._id}`)
                                  .then((doc) => renderOrderAllocationPrintWindow(doc, activeCompany, true))
                                  .catch((e) => setErr(e.message))
                              }
                            >
                              Export PDF
                            </button>
                            <button
                              type="button"
                              className="rounded-lg border px-2 py-1 text-xs"
                              title="Order allocation CSV"
                              onClick={() =>
                                apiGet(`/sales/order-allocations/${r._id}`)
                                  .then((doc) => {
                                    const headers = orderAllocationCsvHeaders();
                                    const rowArrays = orderAllocationCsvRows(doc);
                                    const rows = rowArrays.map((arr) =>
                                      Object.fromEntries(headers.map((key, i) => [key, arr[i]]))
                                    );
                                    exportListCsv(
                                      `order-allocation-${doc.allocationNo || "export"}`,
                                      rows,
                                      headers.map((label) => ({ label, value: (row) => row[label] ?? "" }))
                                    );
                                  })
                                  .catch((e) => setErr(e.message))
                              }
                            >
                              Export CSV
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
                Page {page}/{allocationTotalPages} · {allocationData?.total ?? 0} allocations
              </span>
              <div className="flex gap-2">
                <button type="button" className="rounded-lg border px-2 py-1 disabled:opacity-40" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                  Prev
                </button>
                <button
                  type="button"
                  className="rounded-lg border px-2 py-1 disabled:opacity-40"
                  disabled={page >= allocationTotalPages}
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
                    <th className="px-3 py-2">Payment</th>
                    <th className="px-3 py-2 text-right">Grand Total</th>
                    <th className="px-3 py-2 text-right">Received</th>
                    <th className="px-3 py-2 text-right">Balance</th>
                    <th className="px-3 py-2">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {salesInvoiceLoading ? (
                    <tr>
                      <td colSpan={9} className="px-3 py-8 text-center text-gray-500">
                        Loading...
                      </td>
                    </tr>
                  ) : salesInvoiceRows.length === 0 ? (
                    <tr>
                      <td colSpan={9} className="px-3 py-8 text-center text-gray-500">
                        No Sales Invoice found.
                      </td>
                    </tr>
                  ) : (
                    salesInvoiceRows.map((r) => (
                      <tr key={r._id} className="border-b border-gray-100 hover:bg-gray-50/80">
                        <td className="px-3 py-2 font-mono text-xs">{r.invoiceNo}</td>
                        <td className="px-3 py-2">{r.customerName}</td>
                        <td className="px-3 py-2 font-mono text-xs">{r.linkedStorePackingNo || "—"}</td>
                        <td className="px-3 py-2">{r.invoiceDate ? new Date(r.invoiceDate).toLocaleDateString() : "—"}</td>
                        <td className="px-3 py-2">
                          <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ${statusBadgeClass(r.status)}`}>
                            {r.status}
                          </span>
                        </td>
                        <td className="px-3 py-2">
                          <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ${statusBadgeClass(r.paymentStatus || "UNPAID")}`}>
                            {r.paymentStatus || "UNPAID"}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-right">
                          {r.currency} {money(r.grandTotal)}
                        </td>
                        <td className="px-3 py-2 text-right">
                          {r.currency} {money(r.totalReceivedAmount || 0)}
                        </td>
                        <td className="px-3 py-2 text-right">
                          {r.currency} {money(r.balanceAmount ?? r.grandTotal ?? 0)}
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
                              disabled={String(r.status || "").toUpperCase() !== "DISPATCHED"}
                              onClick={() => convertToSalesDispatchFromSalesInvoiceMutation.mutate(r._id)}
                            >
                              Convert to Sales Dispatch
                            </button>
                            <button
                              type="button"
                              className={`rounded-lg border px-2 py-1 text-xs ${["PAID", "CANCELLED"].includes(String(r.status || "").toUpperCase()) || String(r.paymentStatus || "").toUpperCase() === "PAID" ? "opacity-40" : ""}`}
                              disabled={["PAID", "CANCELLED"].includes(String(r.status || "").toUpperCase()) || String(r.paymentStatus || "").toUpperCase() === "PAID"}
                              onClick={() => {
                                const balance = Number(r.balanceAmount ?? r.grandTotal ?? 0);
                                setReceiveInvoicePaymentModal({ open: true, invoice: r });
                                setReceivePaymentForm((f) => ({
                                  ...f,
                                  receiptDate: new Date().toISOString().slice(0, 10),
                                  amountReceived: balance > 0 ? balance : Number(r.grandTotal ?? 0),
                                  currency: r.currency || "USD",
                                  paymentMode: "BANK_TRANSFER",
                                  bankCashAccountName: "",
                                  bankAccountId: "",
                                  cashAccountId: "",
                                  paymentReference: "",
                                  remarks: "",
                                  adminOverride: false,
                                  allowOverpayment: false,
                                  attachmentFile: null,
                                }));
                              }}
                            >
                              Receive Payment
                            </button>
                            <button
                              type="button"
                              className={`rounded-lg border px-2 py-1 text-xs ${
                                String(r.status || "").toUpperCase() === "CANCELLED" ? "opacity-40" : ""
                              }`}
                              disabled={String(r.status || "").toUpperCase() === "CANCELLED"}
                              title="Cancel invoice before dispatch"
                              onClick={async () => {
                                setErr("");
                                try {
                                  const preview = await salesCancelMutation.mutateAsync({
                                    kind: "SI",
                                    id: r._id,
                                    reason: "-",
                                    dryRun: true,
                                  });
                                  setSalesCancelModal({
                                    open: true,
                                    kind: "SI",
                                    id: r._id,
                                    reason: "",
                                    preview,
                                  });
                                } catch (e) {
                                  setErr(e.message);
                                }
                              }}
                            >
                              Cancel invoice
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
      ) : tabContent === "dispatch-status" ? (
        <>
          <p className="mb-3 text-sm text-gray-600">
            Read-only fulfilment pipeline (Store handles packing and physical dispatch). Use Store module to pack and dispatch
            stock.
          </p>
          <div className="mb-3 flex flex-wrap items-end gap-2 rounded-2xl border bg-white p-3 shadow-sm">
            <TextInput
              placeholder="Filter by customer"
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
                exportListCsv("dispatch-status", salesDispatchRows, [
                  { label: "Customer", value: (r) => r.customerName },
                  { label: "OA No", value: (r) => r.oaNo || "" },
                  { label: "PI No", value: (r) => r.piNo || "" },
                  { label: "Allocation No", value: (r) => r.allocationNo || "" },
                  { label: "Packing No", value: (r) => r.packingNo || "" },
                  { label: "Dispatch No", value: (r) => r.dispatchNo || "" },
                  { label: "Invoice No", value: (r) => r.invoiceNo || "" },
                  { label: "Packed Qty", value: (r) => r.packedQty },
                  { label: "Dispatched Qty", value: (r) => r.dispatchedQty },
                  { label: "Balance Qty", value: (r) => r.balanceQty },
                  { label: "Dispatch status", value: (r) => r.dispatchStatus },
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
                    <th className="px-3 py-2">Customer</th>
                    <th className="px-3 py-2">OA</th>
                    <th className="px-3 py-2">PI</th>
                    <th className="px-3 py-2">Allocation</th>
                    <th className="px-3 py-2">Packing</th>
                    <th className="px-3 py-2">Dispatch</th>
                    <th className="px-3 py-2">Invoice</th>
                    <th className="px-3 py-2 text-right">Packed</th>
                    <th className="px-3 py-2 text-right">Dispatched</th>
                    <th className="px-3 py-2 text-right">Balance</th>
                    <th className="px-3 py-2">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {salesDispatchLoading ? (
                    <tr>
                      <td colSpan={11} className="px-3 py-8 text-center text-gray-500">
                        Loading...
                      </td>
                    </tr>
                  ) : salesDispatchRows.length === 0 ? (
                    <tr>
                      <td colSpan={11} className="px-3 py-8 text-center text-gray-500">
                        No fulfilment rows for this company.
                      </td>
                    </tr>
                  ) : (
                    salesDispatchRows.map((r, idx) => (
                      <tr key={`${r.allocationNo}-${idx}`} className="border-b border-gray-100 hover:bg-gray-50/80">
                        <td className="px-3 py-2">{r.customerName}</td>
                        <td className="px-3 py-2 font-mono text-xs">{r.oaNo || "—"}</td>
                        <td className="px-3 py-2 font-mono text-xs">{r.piNo || "—"}</td>
                        <td className="px-3 py-2 font-mono text-xs">{r.allocationNo}</td>
                        <td className="px-3 py-2 text-xs">{r.packingNo || "—"}</td>
                        <td className="px-3 py-2 text-xs">{r.dispatchNo || "—"}</td>
                        <td className="px-3 py-2 text-xs">{r.invoiceNo || "—"}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{r.packedQty}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{r.dispatchedQty}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{r.balanceQty}</td>
                        <td className="px-3 py-2">
                          <span className="inline-flex rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-800 ring-1 ring-slate-200">
                            {r.dispatchStatus}
                          </span>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
            <div className="flex items-center justify-between border-t px-3 py-2 text-sm text-gray-600">
              <span>
                {dispatchStatusData?.total ?? salesDispatchRows.length} allocation(s) · fulfilment from Store (Packing /
                Dispatch)
              </span>
            </div>
          </div>
        </>
      ) : tabContent === "sales-return" ? (
        <>
          <p className="mb-3 text-sm text-gray-600">
            Record customer returns against a dispatch or invoice. <strong>Post</strong> adds stock back via inventory{" "}
            <code className="rounded bg-gray-100 px-1">IN_RETURN</code>.
          </p>
          <div className="mb-3 flex flex-wrap items-end gap-2 rounded-2xl border bg-white p-3 shadow-sm">
            <TextInput
              placeholder="Search return no / customer / dispatch"
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
                    <th className="px-3 py-2">Return No</th>
                    <th className="px-3 py-2">Customer</th>
                    <th className="px-3 py-2">Dispatch</th>
                    <th className="px-3 py-2">Date</th>
                    <th className="px-3 py-2">Status</th>
                    <th className="px-3 py-2 text-right">Total</th>
                    <th className="px-3 py-2">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {salesReturnLoading ? (
                    <tr>
                      <td colSpan={7} className="px-3 py-8 text-center text-gray-500">
                        Loading...
                      </td>
                    </tr>
                  ) : salesReturnRows.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="px-3 py-8 text-center text-gray-500">
                        No sales returns yet.
                      </td>
                    </tr>
                  ) : (
                    salesReturnRows.map((r) => (
                      <tr key={r._id} className="border-b border-gray-100 hover:bg-gray-50/80">
                        <td className="px-3 py-2 font-mono text-xs">{r.returnNo}</td>
                        <td className="px-3 py-2">{r.customerName}</td>
                        <td className="px-3 py-2 font-mono text-xs">{r.linkedSalesDispatchNo || "—"}</td>
                        <td className="px-3 py-2">{r.returnDate ? new Date(r.returnDate).toLocaleDateString() : "—"}</td>
                        <td className="px-3 py-2">
                          <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ${statusBadgeClass(r.status)}`}>
                            {r.status}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-right">
                          {r.currency} {money(r.grandTotal)}
                        </td>
                        <td className="px-3 py-2">
                          {r.status === "DRAFT" ? (
                            <button
                              type="button"
                              className="rounded-lg border px-2 py-1 text-xs disabled:opacity-50"
                              disabled={postSalesReturnMutation.isPending}
                              onClick={() => postSalesReturnMutation.mutate(r._id)}
                            >
                              Post to stock
                            </button>
                          ) : (
                            <span className="text-xs text-gray-500">—</span>
                          )}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
            <div className="flex items-center justify-between border-t px-3 py-2 text-sm text-gray-600">
              <span>
                Page {page}/{salesReturnTotalPages} · {salesReturnData?.total ?? 0} returns
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
                  disabled={page >= salesReturnTotalPages}
                  onClick={() => setPage((p) => p + 1)}
                >
                  Next
                </button>
              </div>
            </div>
          </div>
        </>
      ) : null}

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
                  : "Document view"
        }
        subtitle={
          tabContent === "proforma"
            ? "Full-screen style PI view: draft opens editable form; approved/converted opens read-only document view."
            : undefined
        }
        xlarge
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
              <FormField label="Vertical">
                <TextInput value={detailQuotationDraftForm.vertical || ""} onChange={(e) => setDetailQuotationDraftForm((f) => ({ ...f, vertical: e.target.value }))} />
              </FormField>
              <FormField label="Brand">
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
              <FormField label="Packing Cost">
                <TextInput
                  type="number"
                  min="0"
                  step="0.01"
                  value={detailQuotationDraftForm.packingCost ?? 0}
                  onChange={(e) => setDetailQuotationDraftForm((f) => ({ ...f, packingCost: Number(e.target.value) || 0 }))}
                />
              </FormField>
              <FormField label="Discount Type">
                <select
                  className="w-full rounded-xl border px-3 py-2 text-sm"
                  value={detailQuotationDraftForm.discountType || "NONE"}
                  onChange={(e) => setDetailQuotationDraftForm((f) => ({ ...f, discountType: e.target.value }))}
                >
                  <option value="NONE">None</option>
                  <option value="PERCENT">Percentage (%)</option>
                  <option value="FLAT">Flat amount</option>
                </select>
              </FormField>
              <FormField label={detailQuotationDraftForm.discountType === "PERCENT" ? "Discount %" : "Discount Amount"}>
                <TextInput
                  type="number"
                  min="0"
                  step="0.01"
                  value={detailQuotationDraftForm.discountValue ?? 0}
                  onChange={(e) => setDetailQuotationDraftForm((f) => ({ ...f, discountValue: Number(e.target.value) || 0 }))}
                />
              </FormField>
              <FormField label="Clearance Cost">
                <TextInput
                  type="number"
                  min="0"
                  step="0.01"
                  value={detailQuotationDraftForm.clearanceCost ?? 0}
                  onChange={(e) => setDetailQuotationDraftForm((f) => ({ ...f, clearanceCost: Number(e.target.value) || 0 }))}
                />
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

            {(() => {
              const t = calcQuotationTotalsView(detailQuotationDraftForm);
              return (
                <div className="ml-auto w-full max-w-sm rounded-xl border bg-white p-3">
                  <div className="flex justify-between py-1">
                    <span>Subtotal</span>
                    <span>{money(t.subTotal)}</span>
                  </div>
                  <div className="flex justify-between py-1"><span>Packing Cost</span><span>{money(t.packingCost)}</span></div>
                  <div className="flex justify-between py-1"><span>Clearance Cost</span><span>{money(t.clearanceCost)}</span></div>
                  <div className="flex justify-between py-1"><span>Discount</span><span>{money(t.discountTotal)}</span></div>
                  <div className="flex justify-between py-1"><span>Tax</span><span>{money(t.taxTotal)}</span></div>
                  <div className="flex justify-between py-1 text-base font-semibold">
                    <span>Grand Total</span>
                    <span>
                      {money(t.grandTotal)} {detailQuotationDraftForm.currency || ""}
                    </span>
                  </div>
                </div>
              );
            })()}

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                className="rounded-xl bg-gray-900 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
                disabled={updateQuotationDetailMutation.isPending || !detailId}
                onClick={() => updateQuotationDetailMutation.mutate()}
              >
                {updateQuotationDetailMutation.isPending ? "Saving…" : "Save changes"}
              </button>
              {canDeleteQuotations ? (
                <button
                  type="button"
                  className="rounded-xl border border-rose-300 px-3 py-1.5 text-xs font-semibold text-rose-700 disabled:opacity-50"
                  disabled={
                    deleteQuotationMutation.isPending ||
                    !detail?._id ||
                    !quotationListCanDelete(detail, canDeleteQuotations)
                  }
                  title={quotationListDeleteTitle(detail, canDeleteQuotations)}
                  onClick={() => {
                    if (!detail?._id || !quotationListCanDelete(detail, canDeleteQuotations)) return;
                    if (!window.confirm("Delete this quotation? This action cannot be undone.")) return;
                    deleteQuotationMutation.mutate(detail._id);
                  }}
                >
                  {deleteQuotationMutation.isPending ? "Deleting…" : "Delete quotation"}
                </button>
              ) : null}
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
              {canDeleteQuotations ? (
                <button
                  type="button"
                  className="rounded-xl border border-rose-300 px-2 py-1 text-xs text-rose-700 disabled:opacity-50"
                  disabled={
                    deleteQuotationMutation.isPending ||
                    !detail?._id ||
                    !quotationListCanDelete(detail, canDeleteQuotations)
                  }
                  title={quotationListDeleteTitle(detail, canDeleteQuotations)}
                  onClick={() => {
                    if (!detail?._id || !quotationListCanDelete(detail, canDeleteQuotations)) return;
                    if (!window.confirm("Delete this quotation? This action cannot be undone.")) return;
                    deleteQuotationMutation.mutate(detail._id);
                  }}
                >
                  {deleteQuotationMutation.isPending ? "Deleting…" : "Delete quotation"}
                </button>
              ) : null}
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

            {quotationLockedStatus(detail.status) && (
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
                <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">Machine Details</div>
                <div><span className="font-medium">Vertical:</span> {detail.vertical || "-"}</div>
                <div><span className="font-medium">Brand:</span> {detail.engine || "-"}</div>
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
              <div className="flex justify-between py-1"><span>Packing Cost</span><span>{money(detail.packingCost)}</span></div>
              <div className="flex justify-between py-1"><span>Clearance Cost</span><span>{money(detail.clearanceCost)}</span></div>
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
                    quotationLockedStatus(detail.status)
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
              {canDeleteQuotations ? (
                <button
                  type="button"
                  className="rounded-xl border border-rose-300 px-2 py-1 text-xs text-rose-700 disabled:opacity-50"
                  disabled={
                    deleteQuotationMutation.isPending ||
                    !detail?._id ||
                    !quotationListCanDelete(detail, canDeleteQuotations)
                  }
                  title={quotationListDeleteTitle(detail, canDeleteQuotations)}
                  onClick={() => {
                    if (!detail?._id || !quotationListCanDelete(detail, canDeleteQuotations)) return;
                    if (!window.confirm("Delete this quotation? This action cannot be undone.")) return;
                    deleteQuotationMutation.mutate(detail._id);
                  }}
                >
                  {deleteQuotationMutation.isPending ? "Deleting…" : "Delete quotation"}
                </button>
              ) : null}
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
                <FormField label="Vertical">
                  <TextInput
                    value={detailOADraftForm.vertical || ""}
                    onChange={(e) => setDetailOADraftForm((f) => ({ ...f, vertical: e.target.value }))}
                  />
                </FormField>
                <FormField label="Brand">
                  <TextInput
                    value={detailOADraftForm.engine || ""}
                    onChange={(e) => setDetailOADraftForm((f) => ({ ...f, engine: e.target.value }))}
                  />
                </FormField>
                <FormField label="Model">
                  <TextInput
                    value={detailOADraftForm.model || ""}
                    onChange={(e) => setDetailOADraftForm((f) => ({ ...f, model: e.target.value }))}
                  />
                </FormField>
                <FormField label="Config">
                  <TextInput
                    value={detailOADraftForm.config || ""}
                    onChange={(e) => setDetailOADraftForm((f) => ({ ...f, config: e.target.value }))}
                  />
                </FormField>
                <FormField label="ESN">
                  <TextInput
                    value={detailOADraftForm.esn || ""}
                    onChange={(e) => setDetailOADraftForm((f) => ({ ...f, esn: e.target.value }))}
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
                  const hasPI = orderAcknowledgementHasActiveProforma(oaDetail);
                  const isCancelled = String(oaDetail.status || "").toUpperCase() === "CANCELLED";
                  const canCancelOa = orderAcknowledgementCanCancel(oaDetail);
                  return (
                    <>
                      <button
                        type="button"
                        className={`rounded-xl border px-2 py-1 text-xs ${hasPI || isCancelled ? "opacity-40" : ""}`}
                        disabled={hasPI || isCancelled || convertToProformaFromOAMutation.isPending}
                        title={isCancelled ? "Cancelled OA cannot be converted" : hasPI ? "Active proforma exists for this OA" : ""}
                        onClick={() => convertToProformaFromOAMutation.mutate(oaDetail._id)}
                      >
                        Convert to PI
                      </button>
                      <button
                        type="button"
                        className={`rounded-xl border border-amber-300 px-2 py-1 text-xs text-amber-900 ${!canCancelOa ? "opacity-40" : "hover:bg-amber-50"}`}
                        disabled={!canCancelOa}
                        title={orderAcknowledgementCancelBlockReason(oaDetail)}
                        onClick={() => openOACancelModal(oaDetail._id)}
                      >
                        Cancel OA
                      </button>
                    </>
                  );
                })()}
                <button
                  type="button"
                  className={`rounded-xl border px-2 py-1 text-xs ${String(oaDetail.status || "").toUpperCase() === "CANCELLED" ? "opacity-40" : ""}`}
                  disabled={String(oaDetail.status || "").toUpperCase() === "CANCELLED"}
                  title={String(oaDetail.status || "").toUpperCase() === "CANCELLED" ? "Cancelled OA cannot be converted" : ""}
                  onClick={() => convertToCiplFromOAMutation.mutate(oaDetail._id)}
                >
                  Convert to CIPL
                </button>
                <button
                  type="button"
                  className={`rounded-xl border px-2 py-1 text-xs ${String(oaDetail.status || "").toUpperCase() === "CANCELLED" ? "opacity-40" : ""}`}
                  disabled={String(oaDetail.status || "").toUpperCase() === "CANCELLED"}
                  title={String(oaDetail.status || "").toUpperCase() === "CANCELLED" ? "Cancelled OA cannot be converted" : ""}
                  onClick={() => convertToOrderAllocationFromOAMutation.mutate({ id: oaDetail._id })}
                >
                  Convert to Order Allocation
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
              const dupPIOpen = orderAcknowledgementHasActiveProforma(oaDetail);
              const dupSIOpen = oc.includes("SALES_INVOICE");
              const canCancelOa = orderAcknowledgementCanCancel(oaDetail);
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
              {(oaDetail.vertical || oaDetail.engine || oaDetail.model || oaDetail.config || oaDetail.esn) && (
                <div className="rounded-xl border bg-gray-50 p-3 text-xs">
                  <span className="font-semibold text-gray-500">Machine:</span>
                  {" "}Vertical: {oaDetail.vertical || "-"} | Brand: {oaDetail.engine || "-"} | Model: {oaDetail.model || "-"} | Config: {oaDetail.config || "-"} | ESN: {oaDetail.esn || "-"}
                </div>
              )}
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
                <div className="flex justify-between py-1"><span>Packing Cost</span><span>{money(oaDetail.packingCost)}</span></div>
                <div className="flex justify-between py-1"><span>Clearance Cost</span><span>{money(oaDetail.clearanceCost)}</span></div>
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
                  className={`rounded-xl border px-2 py-1 text-xs ${dupPIOpen || String(oaDetail.status || "").toUpperCase() === "CANCELLED" ? "opacity-40" : ""}`}
                  disabled={dupPIOpen || String(oaDetail.status || "").toUpperCase() === "CANCELLED"}
                  onClick={() => convertToProformaFromOAMutation.mutate(oaDetail._id)}
                >
                  Convert to PI
                </button>
                <button
                  type="button"
                  className={`rounded-xl border px-2 py-1 text-xs ${String(oaDetail.status || "").toUpperCase() === "CANCELLED" ? "opacity-40" : ""}`}
                  disabled={String(oaDetail.status || "").toUpperCase() === "CANCELLED"}
                  onClick={() => convertToCiplFromOAMutation.mutate(oaDetail._id)}
                >
                  Convert to CIPL
                </button>
                <button
                  type="button"
                  className={`rounded-xl border px-2 py-1 text-xs ${String(oaDetail.status || "").toUpperCase() === "CANCELLED" ? "opacity-40" : ""}`}
                  disabled={String(oaDetail.status || "").toUpperCase() === "CANCELLED"}
                  onClick={() => convertToOrderAllocationFromOAMutation.mutate({ id: oaDetail._id })}
                >
                  Convert to Order Allocation
                </button>
                <button
                  type="button"
                  className={`rounded-xl border border-amber-300 px-2 py-1 text-xs text-amber-900 ${!canCancelOa ? "opacity-40" : "hover:bg-amber-50"}`}
                  disabled={!canCancelOa}
                  title={orderAcknowledgementCancelBlockReason(oaDetail)}
                  onClick={() => openOACancelModal(oaDetail._id)}
                >
                  Cancel OA
                </button>
              </div>
            </div>
              );
            })()
          )
        ) : tabContent === "proforma" ? (
          !proformaDetail ? (
            <p className="text-sm text-gray-500">Loading...</p>
          ) : proformaIsDraft(proformaDetail) && !detailProformaDraftForm ? (
            <p className="text-sm text-gray-500">Loading...</p>
          ) : proformaIsDraft(proformaDetail) && detailProformaDraftForm ? (
            <div className="space-y-4 text-sm">
              <div className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900 ring-1 ring-amber-200">
                Draft proforma — edit below and save. After conversion to Sales Invoice or CIPL the status becomes <b>Approved</b> and editing is disabled.
              </div>
              <div className="grid gap-3 sm:grid-cols-4">
                <FormField label="PI No">
                  <TextInput value={proformaDetail.proformaNo || ""} disabled className="bg-gray-50" />
                </FormField>
                <FormField label="PI Date">
                  <TextInput
                    type="date"
                    value={detailProformaDraftForm.proformaDate}
                    onChange={(e) => setDetailProformaDraftForm((f) => ({ ...f, proformaDate: e.target.value }))}
                  />
                </FormField>
                <FormField label="Currency">
                  <TextInput
                    value={detailProformaDraftForm.currency}
                    onChange={(e) => setDetailProformaDraftForm((f) => ({ ...f, currency: e.target.value.toUpperCase() }))}
                  />
                </FormField>
                <FormField label="Status">
                  <TextInput value={detailProformaDraftForm.status || ""} disabled className="bg-gray-50" />
                </FormField>
                <FormField label="Customer *">
                  <TextInput
                    value={detailProformaDraftForm.customerName}
                    onChange={(e) => setDetailProformaDraftForm((f) => ({ ...f, customerName: e.target.value }))}
                  />
                </FormField>
                <FormField label="Payment terms">
                  <TextInput
                    value={detailProformaDraftForm.paymentTerms || ""}
                    onChange={(e) => setDetailProformaDraftForm((f) => ({ ...f, paymentTerms: e.target.value }))}
                  />
                </FormField>
                <FormField label="Validity">
                  <TextInput
                    value={detailProformaDraftForm.validity || ""}
                    onChange={(e) => setDetailProformaDraftForm((f) => ({ ...f, validity: e.target.value }))}
                  />
                </FormField>
                <FormField label="Shipment terms">
                  <TextInput
                    value={detailProformaDraftForm.shipmentTerms || ""}
                    onChange={(e) => setDetailProformaDraftForm((f) => ({ ...f, shipmentTerms: e.target.value }))}
                  />
                </FormField>
                <FormField label="Vertical">
                  <TextInput
                    value={detailProformaDraftForm.vertical || ""}
                    onChange={(e) => setDetailProformaDraftForm((f) => ({ ...f, vertical: e.target.value }))}
                  />
                </FormField>
                <FormField label="Brand">
                  <TextInput
                    value={detailProformaDraftForm.engine || ""}
                    onChange={(e) => setDetailProformaDraftForm((f) => ({ ...f, engine: e.target.value }))}
                  />
                </FormField>
                <FormField label="Model">
                  <TextInput
                    value={detailProformaDraftForm.model || ""}
                    onChange={(e) => setDetailProformaDraftForm((f) => ({ ...f, model: e.target.value }))}
                  />
                </FormField>
                <FormField label="Config">
                  <TextInput
                    value={detailProformaDraftForm.config || ""}
                    onChange={(e) => setDetailProformaDraftForm((f) => ({ ...f, config: e.target.value }))}
                  />
                </FormField>
                <FormField label="ESN">
                  <TextInput
                    value={detailProformaDraftForm.esn || ""}
                    onChange={(e) => setDetailProformaDraftForm((f) => ({ ...f, esn: e.target.value }))}
                  />
                </FormField>
              </div>
              <FormField label="Bank details">
                <textarea
                  className="w-full rounded-xl border px-3 py-2 text-sm"
                  rows={2}
                  value={detailProformaDraftForm.bankDetails || ""}
                  onChange={(e) => setDetailProformaDraftForm((f) => ({ ...f, bankDetails: e.target.value }))}
                />
              </FormField>
              <FormField label="Remarks">
                <textarea
                  className="w-full rounded-xl border px-3 py-2 text-sm"
                  rows={3}
                  value={detailProformaDraftForm.remarks || ""}
                  onChange={(e) => setDetailProformaDraftForm((f) => ({ ...f, remarks: e.target.value }))}
                />
              </FormField>
              <div className="text-xs text-gray-600">
                Linked Quotation: {proformaDetail.linkedQuotationNo || "-"} | Linked OA: {proformaDetail.linkedOANo || "-"}
              </div>
              <div className="mt-1">
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-sm font-medium">Lines</span>
                  <button
                    type="button"
                    className="text-sm underline"
                    onClick={() => setDetailProformaDraftForm((f) => ({ ...f, lines: [...f.lines, emptyLine()] }))}
                  >
                    + Add line
                  </button>
                </div>
                <div className="w-full overflow-x-auto rounded-xl border">
                  <table className="min-w-[1100px] w-full text-xs">
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
                        <th className="px-2 py-2 text-left">Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detailProformaDraftForm.lines.map((line, idx) => {
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
                                  const lines = [...detailProformaDraftForm.lines];
                                  lines[idx] = { ...line, article: e.target.value.toUpperCase(), serialNo: idx + 1, totalPrice };
                                  setDetailProformaDraftForm((f) => ({ ...f, lines }));
                                }}
                              />
                            </td>
                            <td className="px-2 py-1">
                              <TextInput
                                value={line.partNumber || ""}
                                onChange={(e) => {
                                  const lines = [...detailProformaDraftForm.lines];
                                  lines[idx] = { ...line, partNumber: e.target.value, serialNo: idx + 1, totalPrice };
                                  setDetailProformaDraftForm((f) => ({ ...f, lines }));
                                }}
                              />
                            </td>
                            <td className="px-2 py-1">
                              <TextInput
                                value={line.description || ""}
                                onChange={(e) => {
                                  const lines = [...detailProformaDraftForm.lines];
                                  lines[idx] = { ...line, description: e.target.value, serialNo: idx + 1, totalPrice };
                                  setDetailProformaDraftForm((f) => ({ ...f, lines }));
                                }}
                              />
                            </td>
                            <td className="px-2 py-1">
                              <TextInput
                                value={line.uom || ""}
                                onChange={(e) => {
                                  const lines = [...detailProformaDraftForm.lines];
                                  lines[idx] = { ...line, uom: e.target.value, serialNo: idx + 1, totalPrice };
                                  setDetailProformaDraftForm((f) => ({ ...f, lines }));
                                }}
                              />
                            </td>
                            <td className="px-2 py-1">
                              <TextInput
                                type="number"
                                value={line.qty}
                                onChange={(e) => {
                                  const nextQty = Number(e.target.value);
                                  const lines = [...detailProformaDraftForm.lines];
                                  lines[idx] = { ...line, qty: nextQty, serialNo: idx + 1, totalPrice: nextQty * price };
                                  setDetailProformaDraftForm((f) => ({ ...f, lines }));
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
                                  const lines = [...detailProformaDraftForm.lines];
                                  lines[idx] = { ...line, price: nextPrice, serialNo: idx + 1, totalPrice: qty * nextPrice };
                                  setDetailProformaDraftForm((f) => ({ ...f, lines }));
                                }}
                              />
                            </td>
                            <td className="px-2 py-1 text-right">{money(totalPrice)}</td>
                            <td className="px-2 py-1">
                              <TextInput
                                value={line.remarks || ""}
                                onChange={(e) => {
                                  const lines = [...detailProformaDraftForm.lines];
                                  lines[idx] = { ...line, remarks: e.target.value, serialNo: idx + 1, totalPrice };
                                  setDetailProformaDraftForm((f) => ({ ...f, lines }));
                                }}
                              />
                            </td>
                            <td className="px-2 py-1">
                              <button
                                type="button"
                                className="rounded-xl border px-2 py-1 text-xs"
                                onClick={() => {
                                  const lines = detailProformaDraftForm.lines.filter((_, i) => i !== idx).map((l, i2) => ({ ...l, serialNo: i2 + 1 }));
                                  setDetailProformaDraftForm((f) => ({ ...f, lines: lines.length ? lines : [emptyLine()] }));
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
                    {money(detailProformaDraftForm.lines.reduce((acc, l) => acc + Number(l.qty || 0) * Number(l.price || 0), 0))}
                  </span>
                </div>
                <div className="flex justify-between py-1 text-base font-semibold">
                  <span>Grand Total</span>
                  <span>
                    {money(detailProformaDraftForm.lines.reduce((acc, l) => acc + Number(l.qty || 0) * Number(l.price || 0), 0))}{" "}
                    {detailProformaDraftForm.currency || ""}
                  </span>
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  className="rounded-xl bg-gray-900 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
                  disabled={putProformaMutation.isPending || !detailId}
                  onClick={() => putProformaMutation.mutate({ body: detailProformaDraftForm })}
                >
                  {putProformaMutation.isPending ? "Saving…" : "Save changes"}
                </button>
                <button type="button" className="rounded-xl border px-2 py-1 text-xs" onClick={() => openFlowDocumentPrint("proforma", proformaDetail._id)}>
                  Print
                </button>
                <button type="button" className="rounded-xl border px-2 py-1 text-xs" onClick={() => openFlowDocumentPrint("proforma", proformaDetail._id, true)}>
                  Export PDF
                </button>
                <button
                  type="button"
                  className={`rounded-xl border px-2 py-1 text-xs ${String(proformaDetail.status || "").toUpperCase() === "CANCELLED" ? "opacity-40" : ""}`}
                  disabled={String(proformaDetail.status || "").toUpperCase() === "CANCELLED"}
                  title={String(proformaDetail.status || "").toUpperCase() === "CANCELLED" ? "Cancelled proforma cannot be converted" : ""}
                  onClick={() => convertProformaToCiplMutation.mutate(proformaDetail._id)}
                >
                  Convert to CIPL
                </button>
                <button
                  type="button"
                  className={`rounded-xl border px-2 py-1 text-xs ${String(detailProformaDraftForm.status || "").toUpperCase() !== "APPROVED" || String(proformaDetail.status || "").toUpperCase() === "CANCELLED" ? "opacity-40" : ""}`}
                  disabled={String(detailProformaDraftForm.status || "").toUpperCase() !== "APPROVED" || String(proformaDetail.status || "").toUpperCase() === "CANCELLED"}
                  title={String(proformaDetail.status || "").toUpperCase() === "CANCELLED" ? "Cancelled proforma cannot be converted" : String(detailProformaDraftForm.status || "").toUpperCase() !== "APPROVED" ? "Set PI status to APPROVED first" : ""}
                  onClick={() => convertToOrderAllocationFromProformaMutation.mutate({ id: proformaDetail._id })}
                >
                  Convert to Order Allocation
                </button>
              </div>
              <div className="flex flex-wrap gap-2">
                {proformaManualStatusOptions.map((s) => (
                  <button
                    key={s}
                    type="button"
                    disabled={s === detailProformaDraftForm.status || putProformaMutation.isPending}
                    className="rounded-xl border px-2 py-1 text-xs disabled:opacity-40"
                    onClick={() => putProformaMutation.mutate({ body: { ...detailProformaDraftForm, status: s } })}
                  >
                    Set {s}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="space-y-3 text-sm">
              <p className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-700 ring-1 ring-slate-200">
                {["APPROVED", "CONVERTED"].includes(String(proformaDetail.status || "").toUpperCase())
                  ? "This proforma is approved (linked to Sales Invoice or CIPL) — editing is disabled. Print or export PDF to share."
                  : "This proforma is not in draft — view only. Print or export PDF when needed."}
              </p>
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
                    <span
                      className={`inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ${statusBadgeClass(proformaDisplayStatus(proformaDetail))}`}
                    >
                      {proformaDisplayStatus(proformaDetail)}
                    </span>
                  </div>
                </div>
              </div>
              <div className="text-xs text-gray-600">
                Linked Quotation: {proformaDetail.linkedQuotationNo || "-"} | Linked OA: {proformaDetail.linkedOANo || "-"}
              </div>
              {(proformaDetail.bankDetails || proformaDetail.shipmentTerms || proformaDetail.remarks) ? (
                <div className="rounded-xl border bg-gray-50 p-3 text-xs space-y-2">
                  {proformaDetail.bankDetails ? (
                    <div className="whitespace-pre-wrap">
                      <span className="font-semibold text-gray-500">Bank: </span>
                      {proformaDetail.bankDetails}
                    </div>
                  ) : null}
                  {proformaDetail.shipmentTerms ? (
                    <div>
                      <span className="font-semibold text-gray-500">Shipment: </span>
                      {proformaDetail.shipmentTerms}
                    </div>
                  ) : null}
                  {proformaDetail.remarks ? (
                    <div className="whitespace-pre-wrap">
                      <span className="font-semibold text-gray-500">Remarks: </span>
                      {proformaDetail.remarks}
                    </div>
                  ) : null}
                </div>
              ) : null}
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
                    {proformaDetail.lines?.map((line) => (
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
                <div className="flex justify-between py-1"><span>Subtotal</span><span>{money(proformaDetail.subTotal)}</span></div>
                <div className="flex justify-between py-1"><span>Packing Cost</span><span>{money(proformaDetail.packingCost)}</span></div>
                <div className="flex justify-between py-1"><span>Clearance Cost</span><span>{money(proformaDetail.clearanceCost)}</span></div>
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
              <div className="flex flex-wrap gap-2 opacity-80">
                <button
                  type="button"
                  className={`rounded-xl border px-2 py-1 text-xs ${["APPROVED", "CONVERTED", "CANCELLED"].includes(String(proformaDetail.status || "").toUpperCase()) ? "opacity-40" : ""}`}
                  disabled={["APPROVED", "CONVERTED", "CANCELLED"].includes(String(proformaDetail.status || "").toUpperCase())}
                  onClick={() => convertProformaToCiplMutation.mutate(proformaDetail._id)}
                >
                  Convert to CIPL
                </button>
                <button
                  type="button"
                  className={`rounded-xl border px-2 py-1 text-xs ${String(proformaDetail.status || "").toUpperCase() !== "APPROVED" || String(proformaDetail.status || "").toUpperCase() === "CANCELLED" ? "opacity-40" : ""}`}
                  disabled={String(proformaDetail.status || "").toUpperCase() !== "APPROVED" || String(proformaDetail.status || "").toUpperCase() === "CANCELLED"}
                  onClick={() => convertToOrderAllocationFromProformaMutation.mutate({ id: proformaDetail._id })}
                >
                  Convert to Order Allocation
                </button>
              </div>
            </div>
          )
        ) : tabContent === "sales-invoice" ? (
          !salesInvoiceDetail ? (
            <p className="text-sm text-gray-500">Loading...</p>
          ) : salesInvoiceIsDraft(salesInvoiceDetail) && !detailSalesInvoiceDraftForm ? (
            <p className="text-sm text-gray-500">Loading...</p>
          ) : salesInvoiceIsDraft(salesInvoiceDetail) && detailSalesInvoiceDraftForm ? (
            <div className="space-y-4 text-sm">
              <div className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900 ring-1 ring-amber-200">
                Draft sales invoice - edit details and save. Set status to <b>DISPATCHED</b> to convert into Sales Dispatch.
              </div>
              <div className="grid gap-3 sm:grid-cols-4">
                <FormField label="Invoice Date">
                  <TextInput type="date" value={detailSalesInvoiceDraftForm.invoiceDate} onChange={(e) => setDetailSalesInvoiceDraftForm((f) => ({ ...f, invoiceDate: e.target.value }))} />
                </FormField>
                <FormField label="Customer">
                  <TextInput value={detailSalesInvoiceDraftForm.customerName} onChange={(e) => setDetailSalesInvoiceDraftForm((f) => ({ ...f, customerName: e.target.value }))} />
                </FormField>
                <FormField label="Payment Terms">
                  <TextInput value={detailSalesInvoiceDraftForm.paymentTerms || ""} onChange={(e) => setDetailSalesInvoiceDraftForm((f) => ({ ...f, paymentTerms: e.target.value }))} />
                </FormField>
                <FormField label="Currency">
                  <TextInput value={detailSalesInvoiceDraftForm.currency || "USD"} onChange={(e) => setDetailSalesInvoiceDraftForm((f) => ({ ...f, currency: e.target.value.toUpperCase() }))} />
                </FormField>
              </div>
              <div className="grid gap-3 sm:grid-cols-3">
                <FormField label="Cust ref (Tax invoice)">
                  <TextInput
                    value={detailSalesInvoiceDraftForm.customerReference || ""}
                    onChange={(e) => setDetailSalesInvoiceDraftForm((f) => ({ ...f, customerReference: e.target.value }))}
                    placeholder="Or leave blank to use linked OA / PI ref."
                  />
                </FormField>
                <FormField label="Loading port">
                  <TextInput
                    value={detailSalesInvoiceDraftForm.loadingPort || ""}
                    onChange={(e) => setDetailSalesInvoiceDraftForm((f) => ({ ...f, loadingPort: e.target.value }))}
                  />
                </FormField>
                <FormField label="Discharge port">
                  <TextInput
                    value={detailSalesInvoiceDraftForm.dischargePort || ""}
                    onChange={(e) => setDetailSalesInvoiceDraftForm((f) => ({ ...f, dischargePort: e.target.value }))}
                  />
                </FormField>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <FormField label="Billing address">
                  <textarea
                    value={detailSalesInvoiceDraftForm.billingAddress || ""}
                    onChange={(e) => setDetailSalesInvoiceDraftForm((f) => ({ ...f, billingAddress: e.target.value }))}
                    rows={3}
                    className="w-full rounded-xl border border-gray-200 px-3 py-2 text-sm focus:border-gray-900 focus:outline-none focus:ring-1 focus:ring-gray-900"
                  />
                </FormField>
                <FormField label="Shipping address">
                  <textarea
                    value={detailSalesInvoiceDraftForm.shippingAddress || ""}
                    onChange={(e) => setDetailSalesInvoiceDraftForm((f) => ({ ...f, shippingAddress: e.target.value }))}
                    rows={3}
                    className="w-full rounded-xl border border-gray-200 px-3 py-2 text-sm focus:border-gray-900 focus:outline-none focus:ring-1 focus:ring-gray-900"
                  />
                </FormField>
              </div>
              <FormField label="Consignee (Tax invoice print)" className="max-w-4xl">
                <textarea
                  value={detailSalesInvoiceDraftForm.consignee || ""}
                  onChange={(e) => setDetailSalesInvoiceDraftForm((f) => ({ ...f, consignee: e.target.value }))}
                  rows={4}
                  placeholder="Full consignee block as it should appear on the invoice"
                  className="w-full rounded-xl border border-gray-200 px-3 py-2 text-sm focus:border-gray-900 focus:outline-none focus:ring-1 focus:ring-gray-900"
                />
              </FormField>
              <div className="grid gap-3 sm:grid-cols-2">
                <FormField label="Customer VAT no.">
                  <TextInput
                    value={detailSalesInvoiceDraftForm.customerVatNo || ""}
                    onChange={(e) => setDetailSalesInvoiceDraftForm((f) => ({ ...f, customerVatNo: e.target.value }))}
                  />
                </FormField>
                <FormField label="Dispatch details">
                  <TextInput
                    value={detailSalesInvoiceDraftForm.dispatchDetails || ""}
                    onChange={(e) => setDetailSalesInvoiceDraftForm((f) => ({ ...f, dispatchDetails: e.target.value }))}
                  />
                </FormField>
              </div>
              <div className="grid gap-3 sm:grid-cols-3 md:grid-cols-5">
                <FormField label="Vertical">
                  <TextInput
                    value={detailSalesInvoiceDraftForm.vertical || ""}
                    onChange={(e) => setDetailSalesInvoiceDraftForm((f) => ({ ...f, vertical: e.target.value }))}
                  />
                </FormField>
                <FormField label="Brand">
                  <TextInput
                    value={detailSalesInvoiceDraftForm.engine || ""}
                    onChange={(e) => setDetailSalesInvoiceDraftForm((f) => ({ ...f, engine: e.target.value }))}
                  />
                </FormField>
                <FormField label="Model">
                  <TextInput
                    value={detailSalesInvoiceDraftForm.model || ""}
                    onChange={(e) => setDetailSalesInvoiceDraftForm((f) => ({ ...f, model: e.target.value }))}
                  />
                </FormField>
                <FormField label="Config">
                  <TextInput
                    value={detailSalesInvoiceDraftForm.config || ""}
                    onChange={(e) => setDetailSalesInvoiceDraftForm((f) => ({ ...f, config: e.target.value }))}
                  />
                </FormField>
                <FormField label="ESN">
                  <TextInput
                    value={detailSalesInvoiceDraftForm.esn || ""}
                    onChange={(e) => setDetailSalesInvoiceDraftForm((f) => ({ ...f, esn: e.target.value }))}
                  />
                </FormField>
              </div>
              <FormField label="Remarks" className="max-w-2xl">
                <TextInput
                  value={detailSalesInvoiceDraftForm.remarks || ""}
                  onChange={(e) => setDetailSalesInvoiceDraftForm((f) => ({ ...f, remarks: e.target.value }))}
                />
              </FormField>
              <div className="overflow-x-auto rounded-xl border">
                <table className="min-w-[980px] w-full text-xs">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="px-2 py-2 text-left">S/N</th>
                      <th className="px-2 py-2 text-left">Article</th>
                      <th className="px-2 py-2 text-left">Part no</th>
                      <th className="px-2 py-2 text-left">Description</th>
                      <th className="px-2 py-2 text-right">Qty</th>
                      <th className="px-2 py-2 text-right">Price</th>
                      <th className="px-2 py-2 text-right">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detailSalesInvoiceDraftForm.lines.map((line, idx) => (
                      <tr key={idx} className="border-t">
                        <td className="px-2 py-1">{idx + 1}</td>
                        <td className="px-2 py-1">{line.article}</td>
                        <td className="px-2 py-1"><TextInput value={line.partNumber || ""} onChange={(e) => setDetailSalesInvoiceDraftForm((f) => { const lines = [...f.lines]; lines[idx] = { ...line, partNumber: e.target.value }; return { ...f, lines }; })} /></td>
                        <td className="px-2 py-1"><TextInput value={line.description || ""} onChange={(e) => setDetailSalesInvoiceDraftForm((f) => { const lines = [...f.lines]; lines[idx] = { ...line, description: e.target.value }; return { ...f, lines }; })} /></td>
                        <td className="px-2 py-1"><TextInput type="number" value={line.qty || 0} onChange={(e) => setDetailSalesInvoiceDraftForm((f) => { const qty = Number(e.target.value || 0); const lines = [...f.lines]; lines[idx] = { ...line, qty, totalPrice: qty * Number(line.price || 0) }; return { ...f, lines }; })} /></td>
                        <td className="px-2 py-1"><TextInput type="number" value={line.price || 0} onChange={(e) => setDetailSalesInvoiceDraftForm((f) => { const price = Number(e.target.value || 0); const lines = [...f.lines]; lines[idx] = { ...line, price, totalPrice: Number(line.qty || 0) * price }; return { ...f, lines }; })} /></td>
                        <td className="px-2 py-1 text-right">{money(line.totalPrice || 0)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="flex flex-wrap gap-2">
                <button type="button" className="rounded-xl border px-2 py-1 text-xs" disabled={putSalesInvoiceMutation.isPending} onClick={() => putSalesInvoiceMutation.mutate({ body: detailSalesInvoiceDraftForm })}>
                  {putSalesInvoiceMutation.isPending ? "Saving..." : "Save changes"}
                </button>
                {salesInvoiceStatusOptions.map((s) => (
                  <button key={s} type="button" className={`rounded-xl border px-2 py-1 text-xs ${s === detailSalesInvoiceDraftForm.status ? "bg-gray-100" : ""}`} onClick={() => putSalesInvoiceMutation.mutate({ body: { ...detailSalesInvoiceDraftForm, status: s } })}>
                    {s}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="space-y-3 text-sm">
              <div className="grid gap-2 sm:grid-cols-3">
                <div><div className="text-gray-500">Invoice No</div><div className="font-mono">{salesInvoiceDetail.invoiceNo}</div></div>
                <div><div className="text-gray-500">Customer</div><div>{salesInvoiceDetail.customerName}</div></div>
                <div><div className="text-gray-500">Status</div><div><span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ${statusBadgeClass(salesInvoiceDetail.status)}`}>{salesInvoiceDetail.status}</span></div></div>
              </div>
              <div className="grid gap-2 sm:grid-cols-4">
                <div className="rounded-xl border bg-white p-3">
                  <div className="text-xs text-gray-500">Invoice Amount</div>
                  <div className="font-semibold tabular-nums">{salesInvoiceDetail.currency || "USD"} {money(salesInvoiceDetail.grandTotal)}</div>
                </div>
                <div className="rounded-xl border bg-white p-3">
                  <div className="text-xs text-gray-500">Received</div>
                  <div className="font-semibold tabular-nums">{salesInvoiceDetail.currency || "USD"} {money(salesInvoiceDetail.totalReceivedAmount || 0)}</div>
                </div>
                <div className="rounded-xl border bg-white p-3">
                  <div className="text-xs text-gray-500">Outstanding</div>
                  <div className="font-semibold tabular-nums">{salesInvoiceDetail.currency || "USD"} {money(salesInvoiceDetail.balanceAmount ?? salesInvoiceDetail.grandTotal ?? 0)}</div>
                </div>
                <div className="rounded-xl border bg-white p-3">
                  <div className="text-xs text-gray-500">Payment / Ageing</div>
                  <div className="flex flex-wrap gap-1">
                    <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ${statusBadgeClass(salesInvoiceDetail.paymentStatus || "UNPAID")}`}>
                      {salesInvoiceDetail.paymentStatus || "UNPAID"}
                    </span>
                    <span className="inline-flex rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-700 ring-1 ring-slate-200">
                      {(() => {
                        const d = new Date(salesInvoiceDetail.invoiceDate || salesInvoiceDetail.createdAt || Date.now());
                        const days = Math.max(0, Math.floor((Date.now() - d.getTime()) / (1000 * 60 * 60 * 24)));
                        if (days <= 30) return "0-30";
                        if (days <= 60) return "31-60";
                        if (days <= 90) return "61-90";
                        return "90+";
                      })()}
                    </span>
                  </div>
                </div>
              </div>
              <div className="text-xs text-gray-600">Linked PI: {salesInvoiceDetail.linkedProformaNo || "-"} | Linked OA: {salesInvoiceDetail.linkedOANo || "-"}</div>
              <div className="overflow-x-auto rounded-xl border">
                <table className="min-w-full text-sm">
                  <thead className="bg-gray-100 text-xs uppercase tracking-wide text-gray-600">
                    <tr><th className="px-3 py-2 text-left">Payment No</th><th className="px-3 py-2 text-left">Date</th><th className="px-3 py-2 text-right">Amount</th><th className="px-3 py-2 text-left">Mode</th><th className="px-3 py-2 text-left">Reference</th><th className="px-3 py-2 text-left">Status</th><th className="px-3 py-2 text-left">Slip</th></tr>
                  </thead>
                  <tbody>
                    {(salesInvoicePaymentsData?.items || []).length === 0 ? (
                      <tr><td colSpan={7} className="px-3 py-4 text-center text-gray-500">No payment history.</td></tr>
                    ) : (salesInvoicePaymentsData?.items || []).map((p) => (
                      <tr key={p._id} className="border-t">
                        <td className="px-3 py-2 font-mono text-xs">{p.receiptNo || "—"}</td>
                        <td className="px-3 py-2 text-xs">{p.receiptDate ? new Date(p.receiptDate).toLocaleDateString() : "—"}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{p.currency || "USD"} {money(p.amountReceived || 0)}</td>
                        <td className="px-3 py-2 text-xs">{String(p.paymentMode || "").replaceAll("_", " ")}</td>
                        <td className="px-3 py-2 text-xs">{p.paymentReference || "—"}</td>
                        <td className="px-3 py-2 text-xs">{p.status || "—"}</td>
                        <td className="px-3 py-2">
                          <button type="button" className="rounded border px-2 py-1 text-xs" disabled={!p.attachmentKey} onClick={() => openPaymentReceiptAttachment(p._id, true)}>
                            Preview
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="flex flex-wrap gap-2">
                <button type="button" className="rounded-xl border px-2 py-1 text-xs" onClick={() => openFlowDocumentPrint("sales-invoice", salesInvoiceDetail._id)}>Print</button>
                <button type="button" className="rounded-xl border px-2 py-1 text-xs" onClick={() => openFlowDocumentPrint("sales-invoice", salesInvoiceDetail._id, true)}>Export PDF</button>
                <button
                  type="button"
                  className={`rounded-xl border px-2 py-1 text-xs ${String(salesInvoiceDetail.status || "").toUpperCase() !== "DISPATCHED" ? "opacity-40" : ""}`}
                  disabled={String(salesInvoiceDetail.status || "").toUpperCase() !== "DISPATCHED"}
                  onClick={() => convertToSalesDispatchFromSalesInvoiceMutation.mutate(salesInvoiceDetail._id)}
                >
                  Convert to Sales Dispatch
                </button>
              </div>
            </div>
          )
        ) : !salesDispatchDetail ? (
          <p className="text-sm text-gray-500">Loading...</p>
        ) : (
          <div className="space-y-3 text-sm">
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
              <div><div className="text-gray-500">Dispatch No</div><div className="font-mono">{salesDispatchDetail.dispatchNo}</div></div>
              <div><div className="text-gray-500">Customer</div><div>{salesDispatchDetail.customerName}</div></div>
              <div><div className="text-gray-500">Dispatch status</div><div><span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ${statusBadgeClass(salesDispatchDetail.status)}`}>{salesDispatchDetail.status}</span></div></div>
              <div><div className="text-gray-500">Invoice status</div><div>{salesDispatchDetail.linkedInvoiceStatus || "—"}</div></div>
            </div>
            <div className="text-xs text-gray-600">Linked Invoice: {salesDispatchDetail.linkedSalesInvoiceNo || "-"}</div>
            <div className="overflow-x-auto rounded-xl border">
              <table className="min-w-full text-sm">
                <thead className="bg-gray-100">
                  <tr><th className="px-3 py-2 text-left">S/N</th><th className="px-3 py-2 text-left">Part no</th><th className="px-3 py-2 text-left">Description</th><th className="px-3 py-2 text-left">UOM</th><th className="px-3 py-2 text-right">Qty</th><th className="px-3 py-2 text-right">Price</th><th className="px-3 py-2 text-right">Total</th></tr>
                </thead>
                <tbody>
                  {salesDispatchDetail.lines?.map((line) => (
                    <tr key={line._id} className="border-t">
                      <td className="px-3 py-2">{line.serialNo}</td><td className="px-3 py-2">{line.partNumber}</td><td className="px-3 py-2">{line.description}</td><td className="px-3 py-2">{line.uom}</td><td className="px-3 py-2 text-right">{line.qty}</td><td className="px-3 py-2 text-right">{money(line.price)}</td><td className="px-3 py-2 text-right">{money(line.totalPrice)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex flex-wrap gap-2">
              <button type="button" className="rounded-xl border px-2 py-1 text-xs" onClick={() => openFlowDocumentPrint("sales-dispatch", salesDispatchDetail._id)}>Print</button>
              <button type="button" className="rounded-xl border px-2 py-1 text-xs" onClick={() => openFlowDocumentPrint("sales-dispatch", salesDispatchDetail._id, true)}>Export PDF</button>
              {String(salesDispatchDetail.status || "").toUpperCase() === "DRAFT" ? (
                <button
                  type="button"
                  className="rounded-xl border px-2 py-1 text-xs"
                  disabled={patchSalesDispatchMutation.isPending}
                  onClick={() =>
                    patchSalesDispatchMutation.mutate({ id: salesDispatchDetail._id, body: { status: "DISPATCHED" } })
                  }
                >
                  Mark shipped
                </button>
              ) : null}
              {String(salesDispatchDetail.status || "").toUpperCase() === "DISPATCHED" &&
              String(salesDispatchDetail.linkedInvoiceStatus || "").toUpperCase() === "PAID" ? (
                <button
                  type="button"
                  className="rounded-xl border px-2 py-1 text-xs"
                  disabled={patchSalesDispatchMutation.isPending}
                  onClick={() => {
                    if (!window.confirm("Close dispatch?")) return;
                    const postCredit = window.confirm(
                      "Post customer ledger CREDIT for dispatch total? OK = yes, Cancel = no"
                    );
                    patchSalesDispatchMutation.mutate({
                      id: salesDispatchDetail._id,
                      body: { status: "CLOSED", postCustomerLedgerCredit: postCredit },
                    });
                  }}
                >
                  Close (paid)
                </button>
              ) : null}
              <button
                type="button"
                className="rounded-xl border px-2 py-1 text-xs"
                onClick={() => {
                  setErr("");
                  setShippingDocForm({ documentType: "Shipping Document", remarks: "" });
                  if (shippingFileRef.current) shippingFileRef.current.value = "";
                  setShippingDocsAfterDispatch({
                    dispatchId: salesDispatchDetail._id,
                    dispatchNo: salesDispatchDetail.dispatchNo || "",
                    customerName: salesDispatchDetail.customerName || "",
                    linkedInvoiceNo: salesDispatchDetail.linkedSalesInvoiceNo || "",
                  });
                }}
              >
                Shipping docs (S3)
              </button>
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
        open={customerEditOpen}
        onClose={() => {
          setCustomerEditOpen(false);
          setCustomerEditId(null);
        }}
        title="Edit Customer"
        wide
      >
        <div className="grid gap-3 sm:grid-cols-3">
          <FormField label="Customer Name *">
            <TextInput
              value={customerEditForm.name}
              onChange={(e) => setCustomerEditForm((f) => ({ ...f, name: e.target.value }))}
            />
          </FormField>
          <FormField label="Contact Name">
            <TextInput
              value={customerEditForm.contactName}
              onChange={(e) => setCustomerEditForm((f) => ({ ...f, contactName: e.target.value }))}
            />
          </FormField>
          <FormField label="Phone">
            <TextInput
              value={customerEditForm.phone}
              onChange={(e) => setCustomerEditForm((f) => ({ ...f, phone: e.target.value }))}
            />
          </FormField>
          <FormField label="Email">
            <TextInput
              value={customerEditForm.email}
              onChange={(e) => setCustomerEditForm((f) => ({ ...f, email: e.target.value }))}
            />
          </FormField>
          <FormField label="Payment Terms">
            <select
              className="w-full rounded-xl border px-3 py-2 text-sm"
              value={customerEditForm.paymentTerms}
              onChange={(e) => setCustomerEditForm((f) => ({ ...f, paymentTerms: e.target.value }))}
            >
              <option value="CREDIT">CREDIT</option>
              <option value="ADVANCE">ADVANCE</option>
            </select>
          </FormField>
          <FormField label="Address">
            <TextInput
              value={customerEditForm.address}
              onChange={(e) => setCustomerEditForm((f) => ({ ...f, address: e.target.value }))}
            />
          </FormField>
          <FormField label="Notes" className="sm:col-span-3">
            <TextInput
              value={customerEditForm.notes}
              onChange={(e) => setCustomerEditForm((f) => ({ ...f, notes: e.target.value }))}
            />
          </FormField>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            className="rounded-xl border px-4 py-2 text-sm"
            onClick={() => {
              setCustomerEditOpen(false);
              setCustomerEditId(null);
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            className="rounded-xl bg-gray-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
            disabled={updateCustomerMutation.isPending || !customerEditId || !String(customerEditForm.name || "").trim()}
            onClick={() => updateCustomerMutation.mutate()}
          >
            {updateCustomerMutation.isPending ? "Saving..." : "Save changes"}
          </button>
        </div>
      </Modal>

      <Modal
        open={!!shippingDocsAfterDispatch}
        onClose={() => {
          setShippingDocsAfterDispatch(null);
          setShippingDownloadBusyId(null);
        }}
        title="Shipping documents"
        subtitle={
          shippingDocsAfterDispatch
            ? `${shippingDocsAfterDispatch.dispatchNo} · ${shippingDocsAfterDispatch.customerName}${
                shippingDocsAfterDispatch.linkedInvoiceNo
                  ? ` · Invoice ${shippingDocsAfterDispatch.linkedInvoiceNo}`
                  : ""
              }`
            : ""
        }
        wide
      >
        <p className="text-sm text-gray-600">
          Upload bills of lading, airway bills, packing lists, or other shipping paperwork. Files are stored in{" "}
          <strong>AWS S3</strong> (same pipeline as <span className="font-medium">Documents</span>).
        </p>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <FormField label="Document type">
            <select
              className="w-full rounded-xl border px-3 py-2 text-sm"
              value={shippingDocForm.documentType}
              onChange={(e) => setShippingDocForm((f) => ({ ...f, documentType: e.target.value }))}
            >
              {SHIPPING_DOC_TYPE_OPTIONS.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </FormField>
          <FormField label="Remarks (optional)">
            <TextInput
              value={shippingDocForm.remarks}
              onChange={(e) => setShippingDocForm((f) => ({ ...f, remarks: e.target.value }))}
              placeholder="e.g. DHL AWB, vessel name"
            />
          </FormField>
        </div>
        <div className="mt-3 flex flex-wrap items-end gap-3">
          <FormField label="File (max 10 MB)" className="min-w-[220px] flex-1">
            <input
              ref={shippingFileRef}
              type="file"
              accept=".pdf,.jpg,.jpeg,.png,.xls,.xlsx,.doc,.docx"
              className="block w-full text-sm text-gray-700 file:mr-3 file:rounded-lg file:border file:bg-gray-50 file:px-3 file:py-2"
            />
          </FormField>
          <button
            type="button"
            className="rounded-xl bg-gray-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
            disabled={uploadShippingDispatchDocMutation.isPending}
            onClick={() => uploadShippingDispatchDocMutation.mutate()}
          >
            {uploadShippingDispatchDocMutation.isPending ? "Uploading…" : "Upload to S3"}
          </button>
        </div>
        <div className="mt-6">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500">Uploaded for this dispatch</h3>
          <div className="mt-2 overflow-hidden rounded-xl border">
            <table className="min-w-full text-left text-sm">
              <thead className="border-b bg-gray-50 text-xs font-semibold uppercase text-gray-600">
                <tr>
                  <th className="px-3 py-2">Type</th>
                  <th className="px-3 py-2">File</th>
                  <th className="px-3 py-2">Size</th>
                  <th className="px-3 py-2 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {shippingDocsListLoading ? (
                  <tr>
                    <td colSpan={4} className="px-3 py-6 text-center text-gray-500">
                      Loading…
                    </td>
                  </tr>
                ) : (shippingDocsForDispatchData?.rows ?? []).length === 0 ? (
                  <tr>
                    <td colSpan={4} className="px-3 py-6 text-center text-gray-500">
                      No files yet. Upload a document above.
                    </td>
                  </tr>
                ) : (
                  (shippingDocsForDispatchData?.rows ?? []).map((doc) => (
                    <tr key={doc._id} className="border-t border-gray-100">
                      <td className="px-3 py-2">{doc.documentType}</td>
                      <td className="max-w-[200px] truncate px-3 py-2" title={doc.originalFileName}>
                        {doc.originalFileName}
                      </td>
                      <td className="px-3 py-2">{formatFileBytes(doc.size)}</td>
                      <td className="px-3 py-2 text-right">
                        <button
                          type="button"
                          className="rounded-lg border px-2 py-1 text-xs disabled:opacity-50"
                          disabled={shippingDownloadBusyId === doc._id}
                          onClick={() => openShippingDispatchDocument(doc._id, true)}
                        >
                          {shippingDownloadBusyId === doc._id ? "…" : "View"}
                        </button>
                        <button
                          type="button"
                          className="ml-1 rounded-lg border px-2 py-1 text-xs disabled:opacity-50"
                          disabled={shippingDownloadBusyId === doc._id}
                          onClick={() => openShippingDispatchDocument(doc._id, false)}
                        >
                          Download
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
        <div className="mt-6 flex justify-end">
          <button
            type="button"
            className="rounded-xl border px-4 py-2 text-sm font-medium text-gray-800"
            onClick={() => {
              setShippingDocsAfterDispatch(null);
              setShippingDownloadBusyId(null);
            }}
          >
            Done
          </button>
        </div>
      </Modal>

      <Modal
        open={srCreateOpen}
        onClose={() => setSrCreateOpen(false)}
        title="New sales return"
        subtitle="Link an optional dispatch to copy lines. Posting adds stock back (IN_RETURN)."
        wide
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label="Customer name *">
            <TextInput
              value={srForm.customerName}
              onChange={(e) => setSrForm((f) => ({ ...f, customerName: e.target.value }))}
            />
          </FormField>
          <FormField label="Warehouse">
            <TextInput
              value={srForm.warehouse}
              onChange={(e) => setSrForm((f) => ({ ...f, warehouse: e.target.value.toUpperCase() }))}
            />
          </FormField>
          <FormField label="Currency">
            <TextInput
              value={srForm.currency}
              onChange={(e) => setSrForm((f) => ({ ...f, currency: e.target.value.toUpperCase() }))}
            />
          </FormField>
          <FormField label="Prefill from dispatch (optional)">
            <div className="flex flex-wrap gap-2">
              <select
                className="min-w-[180px] flex-1 rounded-xl border px-3 py-2 text-sm"
                value={srForm.linkedSalesDispatchId || ""}
                onChange={(e) => {
                  const id = e.target.value;
                  const row = (salesDispatchData?.items ?? []).find((d) => String(d._id) === id);
                  setSrForm((f) => ({
                    ...f,
                    linkedSalesDispatchId: id,
                    linkedSalesDispatchNo: row?.dispatchNo || "",
                  }));
                }}
              >
                <option value="">— None —</option>
                {(salesDispatchData?.items ?? []).map((d) => (
                  <option key={d._id} value={d._id}>
                    {d.dispatchNo} · {d.customerName}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="rounded-xl border px-3 py-2 text-sm"
                disabled={!srForm.linkedSalesDispatchId}
                onClick={async () => {
                  try {
                    const data = await apiGet(`/sales/sales-returns/prefill-from-dispatch/${srForm.linkedSalesDispatchId}`);
                    setSrForm((f) => ({
                      ...f,
                      customerName: data.customerName || f.customerName,
                      linkedSalesDispatchId: String(data.linkedSalesDispatchId || f.linkedSalesDispatchId),
                      linkedSalesDispatchNo: data.linkedSalesDispatchNo || "",
                      linkedSalesInvoiceId: data.linkedSalesInvoiceId ? String(data.linkedSalesInvoiceId) : "",
                      linkedSalesInvoiceNo: data.linkedSalesInvoiceNo || "",
                      currency: data.currency || f.currency,
                      lines:
                        data.lines?.length > 0
                          ? data.lines.map((l) => ({
                              article: l.article || "",
                              partNumber: l.partNumber || "",
                              description: l.description || "",
                              qty: l.qty ?? 1,
                              uom: l.uom || "PCS",
                              unitPrice: l.unitPrice ?? 0,
                              reason: l.reason || "",
                            }))
                          : f.lines,
                    }));
                  } catch (e) {
                    setErr(e.message || "Could not load dispatch lines");
                  }
                }}
              >
                Load lines
              </button>
            </div>
          </FormField>
        </div>
        <FormField label="Remarks" className="mt-3">
          <TextInput value={srForm.remarks} onChange={(e) => setSrForm((f) => ({ ...f, remarks: e.target.value }))} />
        </FormField>
        <div className="mt-4 overflow-x-auto rounded-xl border">
          <table className="min-w-full text-sm">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-2 py-2 text-left">Article *</th>
                <th className="px-2 py-2 text-left">Part no</th>
                <th className="px-2 py-2 text-left">Description</th>
                <th className="px-2 py-2 text-left">UOM</th>
                <th className="px-2 py-2 text-right">Qty</th>
                <th className="px-2 py-2 text-right">Unit price</th>
                <th className="px-2 py-2 text-left">Reason</th>
                <th className="px-2 py-2 w-10" />
              </tr>
            </thead>
            <tbody>
              {srForm.lines.map((line, idx) => (
                <tr key={idx} className="border-t">
                  <td className="px-2 py-1">
                    <TextInput
                      value={line.article}
                      onChange={(e) =>
                        setSrForm((f) => {
                          const lines = [...f.lines];
                          lines[idx] = { ...line, article: e.target.value };
                          return { ...f, lines };
                        })
                      }
                    />
                  </td>
                  <td className="px-2 py-1">
                    <TextInput
                      value={line.partNumber}
                      onChange={(e) =>
                        setSrForm((f) => {
                          const lines = [...f.lines];
                          lines[idx] = { ...line, partNumber: e.target.value };
                          return { ...f, lines };
                        })
                      }
                    />
                  </td>
                  <td className="px-2 py-1">
                    <TextInput
                      value={line.description}
                      onChange={(e) =>
                        setSrForm((f) => {
                          const lines = [...f.lines];
                          lines[idx] = { ...line, description: e.target.value };
                          return { ...f, lines };
                        })
                      }
                    />
                  </td>
                  <td className="px-2 py-1">
                    <TextInput
                      value={line.uom}
                      onChange={(e) =>
                        setSrForm((f) => {
                          const lines = [...f.lines];
                          lines[idx] = { ...line, uom: e.target.value };
                          return { ...f, lines };
                        })
                      }
                    />
                  </td>
                  <td className="px-2 py-1">
                    <TextInput
                      type="number"
                      value={line.qty}
                      onChange={(e) =>
                        setSrForm((f) => {
                          const lines = [...f.lines];
                          lines[idx] = { ...line, qty: Number(e.target.value || 0) };
                          return { ...f, lines };
                        })
                      }
                    />
                  </td>
                  <td className="px-2 py-1">
                    <TextInput
                      type="number"
                      value={line.unitPrice}
                      onChange={(e) =>
                        setSrForm((f) => {
                          const lines = [...f.lines];
                          lines[idx] = { ...line, unitPrice: Number(e.target.value || 0) };
                          return { ...f, lines };
                        })
                      }
                    />
                  </td>
                  <td className="px-2 py-1">
                    <TextInput
                      value={line.reason}
                      onChange={(e) =>
                        setSrForm((f) => {
                          const lines = [...f.lines];
                          lines[idx] = { ...line, reason: e.target.value };
                          return { ...f, lines };
                        })
                      }
                    />
                  </td>
                  <td className="px-2 py-1">
                    <button
                      type="button"
                      className="text-xs text-red-600"
                      onClick={() =>
                        setSrForm((f) => ({
                          ...f,
                          lines: f.lines.length > 1 ? f.lines.filter((_, i) => i !== idx) : f.lines,
                        }))
                      }
                    >
                      ×
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <button
          type="button"
          className="mt-2 text-sm text-gray-700 underline"
          onClick={() =>
            setSrForm((f) => ({
              ...f,
              lines: [...f.lines, { article: "", partNumber: "", description: "", qty: 1, uom: "PCS", unitPrice: 0, reason: "" }],
            }))
          }
        >
          + Add line
        </button>
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" className="rounded-xl border px-4 py-2 text-sm" onClick={() => setSrCreateOpen(false)}>
            Cancel
          </button>
          <button
            type="button"
            className="rounded-xl bg-gray-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
            disabled={createSalesReturnMutation.isPending}
            onClick={() => createSalesReturnMutation.mutate()}
          >
            {createSalesReturnMutation.isPending ? "Saving…" : "Save draft"}
          </button>
        </div>
      </Modal>

      <ReceivePaymentModal
        open={receivePaymentModal.open}
        onClose={() => setReceivePaymentModal({ open: false, proforma: null })}
        title="Receive Payment - Proforma"
        sourceType="PROFORMA_INVOICE"
        document={receivePaymentModal.proforma}
        bankDetails={bankDetailsData?.items || []}
        form={receivePaymentForm}
        setForm={setReceivePaymentForm}
        onSubmit={({ sourceType, document, form }) => createPaymentReceiptMutation.mutate({ sourceType, doc: document, form })}
        isSubmitting={createPaymentReceiptMutation.isPending}
      />

      <Modal
        open={negativeAllocConfirm.open}
        onClose={() => {
          setNegativeAllocConfirm({ open: false, source: "", id: "", error: null });
          setNegativeAllocReason("");
        }}
        title="Available stock is insufficient"
        subtitle="Continuing will create a negative allocation (backorder). Stock will move below zero on the affected article(s) until a future GRN replenishes it."
      >
        <div className="space-y-3 text-sm text-slate-700">
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-amber-900">
            {negativeAllocConfirm.error?.message ||
              "There is not enough free stock to fully cover this allocation."}
            {negativeAllocConfirm.error?.details ? (
              <div className="mt-2 grid grid-cols-3 gap-2 text-xs">
                <div>
                  <div className="text-amber-700">Article</div>
                  <div className="font-mono">{negativeAllocConfirm.error.details.article}</div>
                </div>
                <div>
                  <div className="text-amber-700">Needed</div>
                  <div className="font-mono">{negativeAllocConfirm.error.details.needed}</div>
                </div>
                <div>
                  <div className="text-amber-700">Available</div>
                  <div className="font-mono">{negativeAllocConfirm.error.details.available}</div>
                </div>
              </div>
            ) : null}
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600">
              Reason / approval note (optional, recorded on the allocation)
            </label>
            <textarea
              className="mt-1 w-full rounded-lg border border-slate-200 bg-white p-2 text-sm focus:border-indigo-300 focus:outline-none"
              rows={3}
              value={negativeAllocReason}
              onChange={(e) => setNegativeAllocReason(e.target.value)}
              placeholder="e.g. Customer urgent — stock arriving Monday"
            />
          </div>
          <div className="flex items-center justify-end gap-2 pt-2">
            <button
              type="button"
              className="rounded-lg border px-3 py-1.5 text-sm hover:bg-slate-50"
              onClick={() => {
                setNegativeAllocConfirm({ open: false, source: "", id: "", error: null });
                setNegativeAllocReason("");
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              className="rounded-lg bg-amber-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-amber-700 disabled:opacity-50"
              disabled={
                convertToOrderAllocationFromOAMutation.isPending ||
                convertToOrderAllocationFromProformaMutation.isPending
              }
              onClick={() => {
                const id = negativeAllocConfirm.id;
                const source = negativeAllocConfirm.source;
                const reason = negativeAllocReason;
                setNegativeAllocConfirm({ open: false, source: "", id: "", error: null });
                setNegativeAllocReason("");
                if (!id) return;
                if (source === "oa") {
                  convertToOrderAllocationFromOAMutation.mutate({
                    id,
                    allowNegative: true,
                    reason,
                  });
                } else if (source === "proforma") {
                  convertToOrderAllocationFromProformaMutation.mutate({
                    id,
                    allowNegative: true,
                    reason,
                  });
                }
              }}
            >
              Continue with negative allocation
            </button>
          </div>
        </div>
      </Modal>
      <ReceivePaymentModal
        open={receiveInvoicePaymentModal.open}
        onClose={() => setReceiveInvoicePaymentModal({ open: false, invoice: null })}
        title="Receive Payment - Sales Invoice"
        sourceType="SALES_INVOICE"
        document={receiveInvoicePaymentModal.invoice}
        bankDetails={bankDetailsData?.items || []}
        form={receivePaymentForm}
        setForm={setReceivePaymentForm}
        onSubmit={({ sourceType, document, form }) => createPaymentReceiptMutation.mutate({ sourceType, doc: document, form })}
        isSubmitting={createPaymentReceiptMutation.isPending}
      />

      <Modal
        open={viewPaymentsModal.open}
        onClose={() => setViewPaymentsModal({ open: false, proforma: null })}
        title={`Payment Receipts${viewPaymentsModal.proforma?.proformaNo ? ` - ${viewPaymentsModal.proforma.proformaNo}` : ""}`}
        wide
      >
        <div className="max-h-[60vh] overflow-auto rounded-xl border">
          <table className="min-w-full text-left text-xs">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-2 py-2">Receipt No</th>
                <th className="px-2 py-2">Date</th>
                <th className="px-2 py-2">Amount</th>
                <th className="px-2 py-2">Mode</th>
                <th className="px-2 py-2">Account</th>
                <th className="px-2 py-2">Reference</th>
                <th className="px-2 py-2">Status</th>
                <th className="px-2 py-2">Actions</th>
              </tr>
            </thead>
            <tbody>
              {(proformaPaymentsData?.items || []).map((r) => (
                <tr key={r._id} className="border-t">
                  <td className="px-2 py-1 font-mono">{r.receiptNo}</td>
                  <td className="px-2 py-1">{r.receivedDate ? new Date(r.receivedDate).toLocaleDateString() : "-"}</td>
                  <td className="px-2 py-1">{r.currency} {money(r.amountReceived)}</td>
                  <td className="px-2 py-1">{String(r.paymentMode || "").replaceAll("_", " ")}</td>
                  <td className="px-2 py-1">{r.accountName || "-"}</td>
                  <td className="px-2 py-1">{r.paymentReference || "-"}</td>
                  <td className="px-2 py-1">
                    <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ${statusBadgeClass(r.status)}`}>
                      {r.status}
                    </span>
                  </td>
                  <td className="px-2 py-1">
                    <div className="flex gap-1">
                      <button
                        type="button"
                        className="rounded-lg border px-2 py-1"
                        disabled={!r.attachmentKey}
                        onClick={() => openPaymentReceiptAttachment(r._id, true)}
                      >
                        View Slip
                      </button>
                      <button
                        type="button"
                        className={`rounded-lg border px-2 py-1 ${String(r.status || "").toUpperCase() === "CANCELLED" ? "opacity-40" : ""}`}
                        disabled={String(r.status || "").toUpperCase() === "CANCELLED" || cancelPaymentReceiptMutation.isPending}
                        onClick={() => cancelPaymentReceiptMutation.mutate({ id: r._id, reason: "Cancelled by user" })}
                      >
                        Cancel
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {!(proformaPaymentsData?.items || []).length ? (
                <tr>
                  <td className="px-3 py-6 text-center text-gray-500" colSpan={8}>
                    No payment receipts found.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </Modal>

      <Modal
        open={createOpen}
        onClose={() => {
          setIsQuotationNoEdited(false);
          setCreateOpen(false);
          setQuotationCsvDupModal(null);
        }}
        title="New Quotation"
        subtitle="Enter header details, add lines manually or import from CSV. Required per line: Article, Description, quantity. CSV import matches Article + Part number (in-file duplicates use the last row; grid conflicts prompt to replace or skip)."
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
          <FormField label="Vertical">
            <TextInput value={form.vertical || ""} onChange={(e) => setForm((f) => ({ ...f, vertical: e.target.value }))} />
          </FormField>
          <FormField label="Brand">
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
          <FormField label="Packing Cost">
            <TextInput
              type="number"
              min="0"
              step="0.01"
              value={form.packingCost ?? 0}
              onChange={(e) => setForm((f) => ({ ...f, packingCost: Number(e.target.value) || 0 }))}
            />
          </FormField>
          <FormField label="Discount Type">
            <select
              className="w-full rounded-xl border px-3 py-2 text-sm"
              value={form.discountType || "NONE"}
              onChange={(e) => setForm((f) => ({ ...f, discountType: e.target.value }))}
            >
              <option value="NONE">None</option>
              <option value="PERCENT">Percentage (%)</option>
              <option value="FLAT">Flat amount</option>
            </select>
          </FormField>
          <FormField label={form.discountType === "PERCENT" ? "Discount %" : "Discount Amount"}>
            <TextInput
              type="number"
              min="0"
              step="0.01"
              value={form.discountValue ?? 0}
              onChange={(e) => setForm((f) => ({ ...f, discountValue: Number(e.target.value) || 0 }))}
            />
          </FormField>
          <FormField label="Clearance Cost">
            <TextInput
              type="number"
              min="0"
              step="0.01"
              value={form.clearanceCost ?? 0}
              onChange={(e) => setForm((f) => ({ ...f, clearanceCost: Number(e.target.value) || 0 }))}
            />
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
              <tfoot className="bg-slate-50">
                <tr className="border-t">
                  <td colSpan={12} className="px-3 py-2">
                    <div className="flex flex-wrap items-center justify-end gap-4 text-xs sm:gap-6">
                      <span>Subtotal: {money(createQuotationTotals.subTotal)}</span>
                      <span>Discount: {money(createQuotationTotals.discountTotal)}</span>
                      <span>Packing: {money(createQuotationTotals.packingCost)}</span>
                      <span>Clearance: {money(createQuotationTotals.clearanceCost)}</span>
                      <span className="text-sm font-semibold">
                        Grand Total: {money(createQuotationTotals.grandTotal)} {form.currency || ""}
                      </span>
                    </div>
                  </td>
                </tr>
              </tfoot>
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

      <Modal
        open={!!quotationCsvDupModal}
        onClose={() => setQuotationCsvDupModal(null)}
        title="Duplicate lines in CSV import"
        subtitle="Rows match on Article and Part number (case-insensitive). The same pair cannot be added twice unless you replace the existing row."
        wide
      >
        {quotationCsvDupModal ? (
          <div className="space-y-4 text-sm text-slate-800">
            {quotationCsvDupModal.internalDupRemoved > 0 ? (
              <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-amber-900">
                Your file had {quotationCsvDupModal.internalDupRemoved} extra row
                {quotationCsvDupModal.internalDupRemoved === 1 ? "" : "s"} with the same Article and Part number as another row in
                the file. Only the <strong>last</strong> occurrence of each pair was kept.
              </p>
            ) : null}
            <p>
              {quotationCsvDupModal.conflicts.length === 1
                ? "One imported line conflicts"
                : `${quotationCsvDupModal.conflicts.length} imported lines conflict`}{" "}
              with the quotation grid (same Article and Part number).
            </p>
            <div className="max-h-56 overflow-auto rounded-lg border border-slate-200">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-slate-100 text-left text-slate-600">
                  <tr>
                    <th className="px-2 py-2">Article</th>
                    <th className="px-2 py-2">Part number</th>
                    <th className="px-2 py-2">Description (import)</th>
                    <th className="px-2 py-2 text-right">Grid row</th>
                  </tr>
                </thead>
                <tbody>
                  {quotationCsvDupModal.conflicts.slice(0, 40).map((c, i) => (
                    <tr key={`${c.key}-${i}`} className="border-t border-slate-100">
                      <td className="px-2 py-1.5 font-mono">{c.importedRow.article}</td>
                      <td className="px-2 py-1.5 font-mono">{c.importedRow.partNumber || "—"}</td>
                      <td className="px-2 py-1.5">{c.importedRow.description}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{c.existingIndex + 1}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {quotationCsvDupModal.conflicts.length > 40 ? (
              <p className="text-xs text-slate-500">Showing first 40 conflicts.</p>
            ) : null}
            <div className="flex flex-wrap justify-end gap-2 border-t border-slate-100 pt-3">
              <button
                type="button"
                className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-800 shadow-sm hover:bg-slate-50"
                onClick={() => setQuotationCsvDupModal(null)}
              >
                Cancel import
              </button>
              <button
                type="button"
                className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-800 shadow-sm hover:bg-slate-50"
                onClick={() => {
                  const { base, dedupedImported } = quotationCsvDupModal;
                  setQuotationCsvDupModal(null);
                  setForm((f) => ({
                    ...f,
                    lines: mergeQuotationCsvLinesIntoBase(base, dedupedImported, "skip"),
                  }));
                }}
              >
                Skip duplicates
              </button>
              <button
                type="button"
                className="rounded-xl bg-slate-900 px-3 py-2 text-sm font-semibold text-white shadow-sm hover:bg-slate-800"
                onClick={() => {
                  const { base, dedupedImported } = quotationCsvDupModal;
                  setQuotationCsvDupModal(null);
                  setForm((f) => ({
                    ...f,
                    lines: mergeQuotationCsvLinesIntoBase(base, dedupedImported, "override"),
                  }));
                }}
              >
                Replace matching rows
              </button>
            </div>
          </div>
        ) : null}
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
        <div className="mt-3 grid gap-3 sm:grid-cols-3 md:grid-cols-5">
          <FormField label="Vertical">
            <TextInput value={oaForm.vertical || ""} onChange={(e) => setOaForm((f) => ({ ...f, vertical: e.target.value }))} />
          </FormField>
          <FormField label="Brand">
            <TextInput value={oaForm.engine || ""} onChange={(e) => setOaForm((f) => ({ ...f, engine: e.target.value }))} />
          </FormField>
          <FormField label="Model">
            <TextInput value={oaForm.model || ""} onChange={(e) => setOaForm((f) => ({ ...f, model: e.target.value }))} />
          </FormField>
          <FormField label="Config">
            <TextInput value={oaForm.config || ""} onChange={(e) => setOaForm((f) => ({ ...f, config: e.target.value }))} />
          </FormField>
          <FormField label="ESN">
            <TextInput value={oaForm.esn || ""} onChange={(e) => setOaForm((f) => ({ ...f, esn: e.target.value }))} />
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
        <div className="mt-3 grid gap-3 sm:grid-cols-3 md:grid-cols-5">
          <FormField label="Vertical">
            <TextInput value={proformaForm.vertical || ""} onChange={(e) => setProformaForm((f) => ({ ...f, vertical: e.target.value }))} />
          </FormField>
          <FormField label="Brand">
            <TextInput value={proformaForm.engine || ""} onChange={(e) => setProformaForm((f) => ({ ...f, engine: e.target.value }))} />
          </FormField>
          <FormField label="Model">
            <TextInput value={proformaForm.model || ""} onChange={(e) => setProformaForm((f) => ({ ...f, model: e.target.value }))} />
          </FormField>
          <FormField label="Config">
            <TextInput value={proformaForm.config || ""} onChange={(e) => setProformaForm((f) => ({ ...f, config: e.target.value }))} />
          </FormField>
          <FormField label="ESN">
            <TextInput value={proformaForm.esn || ""} onChange={(e) => setProformaForm((f) => ({ ...f, esn: e.target.value }))} />
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
        <div className="mt-3 grid gap-3 sm:grid-cols-3 md:grid-cols-5">
          <FormField label="Vertical">
            <TextInput
              value={salesInvoiceForm.vertical || ""}
              onChange={(e) => setSalesInvoiceForm((f) => ({ ...f, vertical: e.target.value }))}
            />
          </FormField>
          <FormField label="Brand">
            <TextInput
              value={salesInvoiceForm.engine || ""}
              onChange={(e) => setSalesInvoiceForm((f) => ({ ...f, engine: e.target.value }))}
            />
          </FormField>
          <FormField label="Model">
            <TextInput
              value={salesInvoiceForm.model || ""}
              onChange={(e) => setSalesInvoiceForm((f) => ({ ...f, model: e.target.value }))}
            />
          </FormField>
          <FormField label="Config">
            <TextInput
              value={salesInvoiceForm.config || ""}
              onChange={(e) => setSalesInvoiceForm((f) => ({ ...f, config: e.target.value }))}
            />
          </FormField>
          <FormField label="ESN">
            <TextInput
              value={salesInvoiceForm.esn || ""}
              onChange={(e) => setSalesInvoiceForm((f) => ({ ...f, esn: e.target.value }))}
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
