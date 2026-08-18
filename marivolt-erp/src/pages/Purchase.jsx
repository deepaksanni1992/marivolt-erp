import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Papa from "papaparse";
import Modal from "../components/erp/Modal.jsx";
import PoAccountsPanel from "../components/purchase/PoAccountsPanel.jsx";
import PoAdjustmentsEditor, { newPoAdjustmentRow } from "../components/purchase/PoAdjustmentsEditor.jsx";
import PoSupplierDocUploadModal from "../components/purchase/PoSupplierDocUploadModal.jsx";
import { FormField, TextInput } from "../components/erp/FormField.jsx";
import { downloadCsv, downloadPdfTable } from "../lib/purchaseExport.js";
import {
  exportPurchaseOrderDocumentPdf,
  openPurchaseOrderDocumentWindow,
  supplierPartNumberForPrint,
  materialCodeForPrint,
} from "../lib/purchaseOrderDocumentPrint.js";
import {
  calcPoTotalsFromDoc,
  calcPoTotalsPreview,
  legacyCostsFromAdjustments,
  listVisiblePoTotalRows,
  poHeaderCost,
  preparePoAdjustmentsForSave,
  resolvePoAdjustments,
  supplierPartNumberDisplay,
  validatePoAdjustments,
} from "../lib/poTotals.js";
import {
  clearPoFromAllocationSession,
  readPoFromAllocationSession,
} from "../lib/allocationPoSession.js";
import {
  COMMERCIAL_DEFAULTS,
  DEFAULT_CLOSING_NOTE,
  DEFAULT_PURCHASE_TERMS,
  DEFAULT_SPECIAL_REMARKS,
  resolvePoPaymentTerms,
} from "../constants/purchaseOrderDefaults.js";
import { buyerDefaultsFromCompany } from "../lib/companyBuyer.js";
import { getReportBranding } from "../lib/reportBranding.js";
import {
  apiDelete,
  apiGet,
  apiGetWithQuery,
  apiPatch,
  apiPost,
  apiPut,
} from "../lib/api.js";
import { useAuth } from "../context/AuthContext.jsx";
import { notify, confirmDialog } from "../lib/notifications.js";
import { AsnStatusBadge } from "../lib/asnUi.js";

const TABS = [
  { id: "orders", label: "Purchase order" },
  { id: "suppliers", label: "Supplier master" },
  { id: "summary", label: "PO summary" },
  { id: "returns", label: "Purchase return" },
  { id: "pending", label: "Pending PO report" },
];

const defaultLine = () => ({
  articleNo: "",
  itemCode: "",
  partNo: "",
  partNumber: "",
  supplierPartNumber: "",
  materialCode: "",
  description: "",
  qty: 1,
  uom: "PCS",
  unitPrice: 0,
  remarks: "",
  leadTime: "",
});

function todayDateInput() {
  return new Date().toISOString().slice(0, 10);
}

function initialPoForm(company) {
  const buyer = buyerDefaultsFromCompany(company);
  const cur = String(company?.currency || "USD").trim().toUpperCase() || "USD";
  return {
    ...buyer,
    ...COMMERCIAL_DEFAULTS,
    supplierName: "",
    supplierAddress: "",
    supplierPhone: "",
    supplierEmail: "",
    ref: "",
    intRef: "",
    contactPerson: "",
    supplierReference: "",
    offerDate: "",
    vertical: "",
    brand: "",
    engine: "",
    model: "",
    config: "",
    esn: "",
    currency: cur,
    orderDate: todayDateInput(),
    remarks: "",
    specialRemarks: DEFAULT_SPECIAL_REMARKS,
    termsAndConditions: DEFAULT_PURCHASE_TERMS,
    closingNote: DEFAULT_CLOSING_NOTE,
    packingCost: 0,
    handlingCost: 0,
    miscellaneousCost: 0,
    discountType: "NONE",
    discountValue: 0,
    adjustments: [],
    showMaterialCodeOnPrint: false,
    showMachineDetailsOnPrint: false,
    sourceType: "",
    sourceOrderAllocationId: "",
    sourceOrderAllocationNumber: "",
    sourceQuotationNumber: "",
    sourceOANumber: "",
    sourceCustomerName: "",
    lines: [defaultLine()],
  };
}

function buildPoFormFromAllocationPrefill(company, payload) {
  const base = initialPoForm(company);
  if (!payload) return base;
  const lines =
    Array.isArray(payload.lines) && payload.lines.length
      ? payload.lines.map((l) => ({
          ...defaultLine(),
          article: l.article || "",
          articleNo: l.article || "",
          itemCode: l.article || "",
          partNo: l.partNumber || "",
          partNumber: l.partNumber || "",
          spn: l.partNumber || "",
          materialCode: l.materialCode || l.article || "",
          description: l.description || "",
          qty: poLineQty(l),
          orderedQty: poLineQty(l),
          uom: l.uom || "PCS",
          unitPrice: Number(l.unitPrice) || 0,
          leadTime: l.leadTime || "",
          supplierPartNumber: l.supplierPartNumber || "",
          remarks: l.remarks || "",
          suggestedSupplier: l.suggestedSupplier || "",
          sourceOrderAllocationLineId: l.sourceOrderAllocationLineId || "",
          sourceArticle: l.article || "",
          sourceRequestedQty: Number(l.sourceRequestedQty ?? l.qty) || 0,
        }))
      : [defaultLine()];

  const suggestedSupplier =
    payload.suggestedSupplier ||
    lines.map((l) => l.suggestedSupplier).find(Boolean) ||
    "";

  return {
    ...base,
    sourceType: payload.sourceType || "ORDER_ALLOCATION",
    sourceOrderAllocationId: payload.sourceOrderAllocationId || payload.allocationId || "",
    sourceOrderAllocationNumber: payload.sourceOrderAllocationNumber || payload.allocationNo || "",
    sourceQuotationNumber: payload.sourceQuotationNumber || "",
    sourceOANumber: payload.sourceOANumber || "",
    sourceCustomerName: payload.sourceCustomerName || "",
    vertical: payload.vertical || base.vertical,
    engine: payload.engine || payload.brand || base.engine,
    brand: payload.brand || payload.engine || base.brand,
    model: payload.model || base.model,
    config: payload.config || base.config,
    esn: payload.esn || base.esn,
    currency: payload.currency || base.currency,
    intRef: payload.intRef || payload.allocationNo || base.intRef,
    supplierName: suggestedSupplier || base.supplierName,
    lines,
  };
}

/** Ordered quantity of a PO line: the editable `qty` wins over the stored `orderedQty`. */
function poLineQty(line = {}) {
  const qty = Number(line?.qty);
  if (Number.isFinite(qty) && qty > 0) return qty;
  const ordered = Number(line?.orderedQty);
  if (Number.isFinite(ordered) && ordered > 0) return ordered;
  return 0;
}

function buildPoPayload(form, { includeIncompleteLines = false } = {}) {
  const cur = form.currency || "USD";
  const lines = form.lines
    .map((l) => {
      const articleNo = String(l.articleNo || "").trim();
      const partNo = String(l.partNo || "").trim();
      const article = String(l.article || articleNo || l.itemCode || "").trim().toUpperCase();
      const itemCode = String(l.itemCode || article || articleNo || l.materialCode || l.partNumber || partNo)
        .trim()
        .toUpperCase();
      const qty = poLineQty(l);
      return {
        _id: l._id,
        article,
        articleNo: articleNo || itemCode,
        itemCode,
        partNo,
        partNumber: String(l.partNumber || partNo).trim().toUpperCase(),
        supplierPartNumber: String(l.supplierPartNumber || "").trim(),
        materialCode: String(l.materialCode || itemCode).trim().toUpperCase(),
        spn: String(l.spn || l.partNumber || partNo).trim().toUpperCase(),
        drawingNo: String(l.drawingNo || "").trim(),
        vertical: String(l.vertical || form.vertical || "").trim(),
        brand: String(l.brand || l.engine || form.brand || form.engine || "").trim(),
        engine: String(l.engine || l.brand || form.engine || form.brand || "").trim(),
        model: String(l.model || form.model || "").trim(),
        config: String(l.config || form.config || "").trim(),
        esn: String(l.esn || form.esn || "").trim(),
        description: String(l.description || "").trim(),
        qty,
        orderedQty: qty,
        receivedQty: Number(l.receivedQty) || 0,
        cancelledQty: Number(l.cancelledQty) || 0,
        uom: String(l.uom || "PCS").trim(),
        unitPrice: Number(l.unitPrice) || 0,
        remarks: String(l.remarks || "").trim(),
        leadTime: String(l.leadTime || "").trim(),
        currency: cur,
        sourceOrderAllocationLineId: l.sourceOrderAllocationLineId || null,
        sourceArticle: String(l.sourceArticle || "").trim().toUpperCase(),
        sourceRequestedQty: Math.max(0, Number(l.sourceRequestedQty) || 0),
        sourceConvertedQty: l.sourceOrderAllocationLineId
          ? qty
          : Math.max(0, Number(l.sourceConvertedQty ?? qty) || 0),
      };
    })
    .filter((l) => includeIncompleteLines || (l.itemCode && l.qty > 0));

  const preparedAdjustments = preparePoAdjustmentsForSave(form.adjustments);
  const lineSubTotal = lines.reduce((s, l) => s + (Number(l.qty) || 0) * (Number(l.unitPrice) || 0), 0);
  const syncedCosts = legacyCostsFromAdjustments(preparedAdjustments, lineSubTotal);

  const orderDate =
    form.orderDate && String(form.orderDate).trim()
      ? new Date(`${form.orderDate}T12:00:00`).toISOString()
      : undefined;

  return {
    buyerLegalName: form.buyerLegalName,
    buyerAddressLine: form.buyerAddressLine,
    buyerPhone: form.buyerPhone,
    buyerEmail: form.buyerEmail,
    buyerWeb: form.buyerWeb,
    buyerTrnNo: form.buyerTrnNo ?? "",
    supplierName: String(form.supplierName || "").trim(),
    supplierAddress: form.supplierAddress ?? "",
    supplierPhone: form.supplierPhone ?? "",
    supplierEmail: form.supplierEmail ?? "",
    ref: form.ref ?? "",
    intRef: form.intRef ?? "",
    contactPerson: form.contactPerson ?? "",
    supplierReference: form.supplierReference ?? "",
    offerDate: form.offerDate ?? "",
    vertical: form.vertical ?? "",
    brand: form.brand ?? "",
    engine: form.engine || form.brand || "",
    model: form.model ?? "",
    config: form.config ?? "",
    esn: form.esn ?? "",
    currency: cur,
    orderDate,
    remarks: form.remarks ?? "",
    delivery: form.delivery,
    insurance: form.insurance,
    packing: form.packing,
    freight: form.freight,
    taxes: form.taxes,
    payment: form.payment,
    paymentTerms: form.payment,
    specialRemarks: form.specialRemarks ?? "",
    termsAndConditions: form.termsAndConditions ?? "",
    closingNote: form.closingNote ?? "",
    packingCost: syncedCosts.packingCost,
    handlingCost: syncedCosts.handlingCost,
    miscellaneousCost: syncedCosts.miscellaneousCost,
    discountType: syncedCosts.discountType,
    discountValue: syncedCosts.discountValue,
    adjustments: preparedAdjustments,
    showMaterialCodeOnPrint: !!form.showMaterialCodeOnPrint,
    showMachineDetailsOnPrint: !!form.showMachineDetailsOnPrint,
    sourceType: form.sourceOrderAllocationId ? form.sourceType || "ORDER_ALLOCATION" : "",
    sourceOrderAllocationId: form.sourceOrderAllocationId || null,
    sourceOrderAllocationNumber: form.sourceOrderAllocationNumber || "",
    sourceQuotationId: form.sourceQuotationId || null,
    sourceQuotationNumber: form.sourceQuotationNumber || "",
    sourceOAId: form.sourceOAId || null,
    sourceOANumber: form.sourceOANumber || "",
    sourceCustomerName: form.sourceCustomerName || "",
    lines,
  };
}

function canDeletePurchaseOrderRole(role) {
  const r = String(role || "").toLowerCase().trim();
  return ["super_admin", "company_admin", "admin"].includes(r);
}

function canModifyPoStatus(status) {
  return status === "DRAFT" || status === "SAVED";
}

function purchaseOrderApiToForm(po) {
  const orderDate =
    po.orderDate != null ? new Date(po.orderDate).toISOString().slice(0, 10) : todayDateInput();
  const lines =
    Array.isArray(po.lines) && po.lines.length > 0
      ? po.lines.map((l) => ({
          _id: l._id,
          article: l.article || "",
          articleNo: l.articleNo || l.article || l.itemCode || "",
          itemCode: l.itemCode || l.article || "",
          partNo: l.partNo || l.partNumber || "",
          partNumber: l.partNumber || l.partNo || "",
          supplierPartNumber: l.supplierPartNumber || "",
          materialCode: l.materialCode || l.itemCode || "",
          spn: l.spn || "",
          drawingNo: l.drawingNo || "",
          vertical: l.vertical || "",
          brand: l.brand || l.engine || "",
          engine: l.engine || l.brand || "",
          model: l.model || "",
          config: l.config || "",
          esn: l.esn || "",
          description: l.description || "",
          qty: poLineQty(l) || 1,
          orderedQty: poLineQty(l) || 1,
          receivedQty: Number(l.receivedQty) || 0,
          cancelledQty: Number(l.cancelledQty) || 0,
          uom: l.uom || "PCS",
          unitPrice: Number(l.unitPrice) || 0,
          remarks: l.remarks || "",
          leadTime: l.leadTime || "",
          sourceOrderAllocationLineId: l.sourceOrderAllocationLineId || "",
          sourceArticle: l.sourceArticle || "",
          sourceRequestedQty: Number(l.sourceRequestedQty) || 0,
          sourceConvertedQty: Number(l.sourceConvertedQty ?? l.qty) || 0,
        }))
      : [defaultLine()];
  return {
    ...buyerDefaultsFromCompany(null),
    ...COMMERCIAL_DEFAULTS,
    buyerLegalName: po.buyerLegalName ?? "",
    buyerAddressLine: po.buyerAddressLine ?? "",
    buyerPhone: po.buyerPhone ?? "",
    buyerEmail: po.buyerEmail ?? "",
    buyerWeb: po.buyerWeb ?? "",
    buyerTrnNo: po.buyerTrnNo ?? "",
    supplierName: po.supplierName || "",
    supplierAddress: po.supplierAddress || "",
    supplierPhone: po.supplierPhone || "",
    supplierEmail: po.supplierEmail || "",
    ref: po.ref || "",
    intRef: po.intRef || "",
    contactPerson: po.contactPerson || "",
    supplierReference: po.supplierReference || "",
    offerDate: po.offerDate || "",
    vertical: po.vertical || "",
    brand: po.brand || po.engine || "",
    engine: po.engine || po.brand || "",
    model: po.model || "",
    config: po.config || "",
    esn: po.esn || "",
    currency: po.currency || "USD",
    orderDate,
    remarks: po.remarks || "",
    delivery: po.delivery ?? COMMERCIAL_DEFAULTS.delivery,
    insurance: po.insurance ?? COMMERCIAL_DEFAULTS.insurance,
    packing: po.packing ?? COMMERCIAL_DEFAULTS.packing,
    freight: po.freight ?? COMMERCIAL_DEFAULTS.freight,
    taxes: po.taxes ?? COMMERCIAL_DEFAULTS.taxes,
    payment: resolvePoPaymentTerms(po) || COMMERCIAL_DEFAULTS.payment,
    specialRemarks:
      po.specialRemarks != null && po.specialRemarks !== "" ? po.specialRemarks : DEFAULT_SPECIAL_REMARKS,
    termsAndConditions:
      po.termsAndConditions != null && po.termsAndConditions !== ""
        ? po.termsAndConditions
        : DEFAULT_PURCHASE_TERMS,
    closingNote:
      po.closingNote != null && po.closingNote !== "" ? po.closingNote : DEFAULT_CLOSING_NOTE,
    packingCost: poHeaderCost(po.packingCost),
    handlingCost: poHeaderCost(po.handlingCost),
    miscellaneousCost: poHeaderCost(po.miscellaneousCost),
    discountType: po.discountType || "NONE",
    discountValue: Math.max(0, Number(po.discountValue) || 0),
    adjustments: resolvePoAdjustments(po).map((row, i) => ({
      ...newPoAdjustmentRow(row.type),
      key: `loaded-${i}-${row.type}`,
      type: row.type,
      label: row.label || "",
      amount: row.amount != null && row.amount !== "" ? String(row.amount) : "",
      discountMode: row.type === "DISCOUNT" ? row.discountMode || "FLAT" : undefined,
      discountValue:
        row.type === "DISCOUNT" && row.discountValue != null && row.discountValue !== ""
          ? String(row.discountValue)
          : row.type === "DISCOUNT" && row.amount != null && row.amount !== ""
            ? String(row.amount)
            : row.type === "DISCOUNT"
              ? ""
              : undefined,
    })),
    showMaterialCodeOnPrint: !!po.showMaterialCodeOnPrint,
    showMachineDetailsOnPrint: !!po.showMachineDetailsOnPrint,
    sourceType: po.sourceType || "",
    sourceOrderAllocationId: po.sourceOrderAllocationId || "",
    sourceOrderAllocationNumber: po.sourceOrderAllocationNumber || "",
    sourceQuotationId: po.sourceQuotationId || "",
    sourceQuotationNumber: po.sourceQuotationNumber || "",
    sourceOAId: po.sourceOAId || "",
    sourceOANumber: po.sourceOANumber || "",
    sourceCustomerName: po.sourceCustomerName || "",
    lines,
  };
}

function formatPoDate(val) {
  if (!val) return "—";
  const d = typeof val === "string" || typeof val === "number" ? new Date(val) : val;
  if (Number.isNaN(d.getTime())) return String(val);
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/** Lowercase keys with single spaces for flexible CSV header matching. */
function rowKeysNormMap(row) {
  const m = Object.create(null);
  for (const [k, v] of Object.entries(row || {})) {
    if (k == null || String(k).trim() === "") continue;
    const nk = String(k)
      .replace(/^\uFEFF/, "")
      .trim()
      .toLowerCase()
      .replace(/_+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    m[nk] = v;
    const compact = nk.replace(/\s+/g, "");
    if (!m[compact]) m[compact] = v;
  }
  return m;
}

function pickCsvCell(m, labels) {
  for (const lab of labels) {
    const a = lab.toLowerCase().replace(/_+/g, " ").replace(/\s+/g, " ").trim();
    const b = a.replace(/\s+/g, "");
    const v = m[a] ?? m[b];
    if (v !== undefined && v !== null && String(v).trim() !== "") return v;
  }
  return "";
}

function mapCsvRowToPurchaseOrderLine(raw) {
  const m = rowKeysNormMap(raw);
  const articleNo = String(
    pickCsvCell(m, ["article nr.", "article nr", "article no", "article", "articlenr", "item code", "itemcode"])
  ).trim();
  const partNo = String(
    pickCsvCell(m, ["part nr.", "part nr", "part no", "part", "partnumber", "partnr", "spn"])
  ).trim();
  const supplierPartNumber = String(
    pickCsvCell(m, [
      "supplier part number",
      "supplier part no",
      "supplier part nr",
      "supplier part",
      "supplierpartnumber",
      "vendor part number",
    ])
  ).trim();
  const description = String(pickCsvCell(m, ["description", "desc"])).trim();
  const qty = Number(pickCsvCell(m, ["qty", "quantity"])) || 0;
  const uom = String(pickCsvCell(m, ["uom", "unit", "unit of measure"]) || "PCS").trim();
  const unitPrice =
    Number(pickCsvCell(m, ["unit rate", "unitrate", "unit price", "unitprice", "rate", "price"])) || 0;
  const remarks = String(pickCsvCell(m, ["remarks", "remark", "note", "notes"])).trim();
  const leadTime = String(pickCsvCell(m, ["lead time", "leadtime", "lead-time", "delivery time"])).trim();
  const materialCode = String(
    pickCsvCell(m, ["material code", "materialcode", "material", "mat code", "matcode"])
  ).trim();
  return {
    articleNo,
    itemCode: "",
    partNo,
    partNumber: partNo.toUpperCase(),
    supplierPartNumber,
    materialCode: materialCode.toUpperCase(),
    description,
    qty: qty > 0 ? qty : 1,
    uom: uom || "PCS",
    unitPrice,
    remarks,
    leadTime,
  };
}

function lineIsImportable(l) {
  const code = String(l.articleNo || l.partNo || "").trim();
  const qty = Number(l.qty) || 0;
  return !!code && qty > 0;
}

function poDocLineExportRows(lines) {
  return (lines || []).map((l, i) => {
    const qty = Number(l.qty) || 0;
    const rate = Number(l.unitPrice) || 0;
    return {
      pos: i + 1,
      articleNo: l.articleNo || l.itemCode || "",
      description: l.description || "",
      partNo: l.partNo || l.partNumber || "",
      supplierPartNumber: l.supplierPartNumber || "",
      materialCode: l.materialCode || l.itemCode || "",
      qty,
      uom: l.uom || "PCS",
      unitRate: rate.toFixed(2),
      total: (qty * rate).toFixed(2),
      remarks: l.remarks || "",
      leadTime: l.leadTime || "",
    };
  });
}

const PO_LINE_EXPORT_COLS_BASE = [
  { key: "pos", header: "Pos" },
  { key: "articleNo", header: "Article Nr." },
  { key: "description", header: "Description" },
  { key: "partNo", header: "Part Nr." },
  { key: "supplierPartNumber", header: "Supplier Part Number" },
];

const PO_LINE_EXPORT_COLS_TAIL = [
  { key: "qty", header: "Qty" },
  { key: "uom", header: "UOM" },
  { key: "unitRate", header: "Unit rate" },
  { key: "total", header: "Total" },
  { key: "remarks", header: "Remarks" },
  { key: "leadTime", header: "Lead time" },
];

function poLineExportCols(showMaterialCode = false) {
  const cols = [...PO_LINE_EXPORT_COLS_BASE];
  if (showMaterialCode) cols.push({ key: "materialCode", header: "Material Code" });
  return [...cols, ...PO_LINE_EXPORT_COLS_TAIL];
}

function exportPurchaseOrderLinesCsv(docLike, fileBase) {
  const rows = poDocLineExportRows(docLike.lines);
  const cols = poLineExportCols(!!docLike.showMaterialCodeOnPrint);
  downloadCsv(`${fileBase}-${Date.now()}.csv`, cols, rows);
}

function exportPurchaseOrderLinesPdf(docLike, fileBase) {
  const poNo = docLike.poNumber || docLike.poNo || "draft-po";
  const sub = [
    docLike.supplierName && `Supplier: ${docLike.supplierName}`,
    `Currency: ${docLike.currency || "USD"}`,
    docLike.orderDate && `Date: ${formatPoDate(docLike.orderDate)}`,
  ]
    .filter(Boolean)
    .join(" | ");
  const rows = poDocLineExportRows(docLike.lines).map((r) => ({
    ...r,
    qty: String(r.qty),
  }));
  const cols = poLineExportCols(!!docLike.showMaterialCodeOnPrint);
  downloadPdfTable(`Purchase order ${poNo}`, sub, cols, rows, fileBase);
}

const defaultPrLine = () => ({
  itemCode: "",
  description: "",
  qty: 1,
  unitPrice: 0,
  reason: "",
});

/** Supplier Master rows use supplierName; legacy rows may use name only. */
function supplierMasterDisplayName(s) {
  return String(s?.supplierName || s?.name || "").trim();
}

function StatusBadge({ status }) {
  const map = {
    DRAFT: "bg-slate-100 text-slate-800 ring-slate-200",
    SAVED: "bg-zinc-100 text-zinc-800 ring-zinc-200",
    SENT: "bg-sky-50 text-sky-900 ring-sky-200",
    PARTIAL_RECEIVED: "bg-amber-50 text-amber-900 ring-amber-200",
    RECEIVED: "bg-emerald-50 text-emerald-900 ring-emerald-200",
    CANCELLED: "bg-red-50 text-red-800 ring-red-200",
    APPROVED: "bg-indigo-50 text-indigo-900 ring-indigo-200",
    POSTED: "bg-emerald-50 text-emerald-900 ring-emerald-200",
  };
  const cls = map[status] || "bg-gray-100 text-gray-800 ring-gray-200";
  return (
    <span
      className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ring-inset ${cls}`}
    >
      {status}
    </span>
  );
}

function PurchaseOrderPreviewPanel({ doc, unsaved, supplierFacing = true }) {
  const { auth } = useAuth();
  if (!doc) return null;
  const lines = doc.lines || [];
  const showMaterialCode = supplierFacing ? !!doc.showMaterialCodeOnPrint : true;
  const showMachineDetails = supplierFacing ? !!doc.showMachineDetailsOnPrint : true;
  const { subTotal, grandTotal: grand, rows: totalRows } = listVisiblePoTotalRows(doc);
  const cur = doc.currency || "USD";
  const buyer = {
    name: doc.buyerLegalName || "—",
    address: doc.buyerAddressLine || "—",
    phone: doc.buyerPhone || "—",
    email: doc.buyerEmail || "—",
    web: doc.buyerWeb || "",
    trn: doc.buyerTrnNo || "",
  };
  const machine = {
    vertical: doc.vertical || "—",
    brand: doc.brand || doc.engine || "—",
    model: doc.model || "—",
    config: doc.config || "—",
    esn: doc.esn || "—",
    currency: cur,
  };
  const poNo = unsaved ? "Auto generated on save" : doc.poNumber || doc.poNo || "—";

  const brandingName = String(doc.buyerLegalName || auth?.company?.name || "").trim();
  const b = getReportBranding(brandingName);
  const companyLogo = String(auth?.company?.logoUrl || auth?.company?.logo || "").trim();
  const logoSrc = b.useBrandedLayout ? b.printLogo : companyLogo;
  const docSubtitle = b.useBrandedLayout
    ? b.companySubtitle || "Buyer reference document — quotation-style layout"
    : "Buyer reference document — quotation-style layout";

  /** Okeanos purchase preview matches sales quotation print header (logo | title + meta | company block). */
  const isOkeanosQuotationStyle = b.isOkeanos;
  const poDateLocale =
    doc.orderDate != null && String(doc.orderDate).trim() !== ""
      ? new Date(doc.orderDate).toLocaleDateString()
      : "—";
  const rightAddress = buyer.address !== "—" ? buyer.address : b.reportAddress;
  const rightEmail = buyer.email !== "—" ? buyer.email : b.reportEmail;
  const rightPhone = buyer.phone !== "—" ? buyer.phone : b.reportPhone;

  const thCellNavy =
    "border border-[#1f3a5f] px-2 py-2.5 text-left text-[11px] font-bold uppercase tracking-wide text-white";
  const thCellQuotationGrey =
    "border border-[#ddd] bg-[#f5f5f5] px-2 py-2 text-left text-[11px] font-bold uppercase tracking-wide text-[#374151]";
  const thCell = isOkeanosQuotationStyle ? thCellQuotationGrey : thCellNavy;
  const tdCell = "border border-[#e5e7eb] px-2 py-2 text-[12px] text-[#111827]";

  return (
    <div className="max-h-[75vh] overflow-y-auto bg-[#f3f4f6] p-3 sm:p-4">
      <div className="mx-auto max-w-5xl rounded-lg border border-[#e5e7eb] bg-white p-5 shadow-sm">
        {isOkeanosQuotationStyle ? (
          <header className="grid grid-cols-1 items-center gap-6 border-b-2 border-[#e5e7eb] pb-5 pt-1 sm:grid-cols-3 sm:gap-4">
            <div className="flex min-h-[118px] items-center justify-start">
              {logoSrc ? (
                <img
                  src={logoSrc}
                  alt={b.companyDisplayName || "Okeanos"}
                  className="max-h-[118px] w-full max-w-[208px] object-contain"
                />
              ) : (
                <div className="text-2xl font-extrabold tracking-tight text-[#1f3a5f]">OKE</div>
              )}
            </div>
            <div className="min-w-0 text-center">
              <h1 className="text-[22px] font-bold text-[#111]">Purchase order</h1>
              <div className="mt-2 space-y-1 text-[13px] leading-relaxed text-[#555]">
                <div>
                  <b>No:</b> {poNo}
                </div>
                <div>
                  <b>Date:</b> {poDateLocale}
                </div>
                <div>
                  <b>Currency:</b> {cur}
                </div>
                {doc.ref ? (
                  <div>
                    <b>Ref:</b> {doc.ref}
                  </div>
                ) : null}
              </div>
              <div className="mt-3 flex justify-center">
                {unsaved ? (
                  <span className="rounded-full bg-gray-100 px-3 py-1 text-xs font-semibold text-gray-800 ring-1 ring-gray-200">
                    Unsaved draft
                  </span>
                ) : doc.status ? (
                  <span className="rounded-full bg-gray-100 px-3 py-1 text-xs font-semibold uppercase text-gray-800 ring-1 ring-gray-200">
                    {doc.status}
                  </span>
                ) : null}
              </div>
            </div>
            <div className="min-w-0 text-right text-[12px] leading-relaxed text-[#4a5568]">
              <p className="text-[32px] font-extrabold leading-none tracking-tight text-[#1f3a5f]">{b.companyDisplayName}</p>
              {b.companySubtitle ? (
                <p className="mt-1 text-[14px] font-semibold text-[#2c5282]">{b.companySubtitle}</p>
              ) : null}
              <div className="mt-3 space-y-1">
                {rightAddress ? <p>{rightAddress}</p> : null}
                {rightEmail ? <p>{rightEmail}</p> : null}
                {rightPhone ? <p>{rightPhone}</p> : null}
              </div>
            </div>
          </header>
        ) : (
          <header className="grid grid-cols-1 gap-5 border-b-2 border-[#e5e7eb] pb-5 sm:grid-cols-3 sm:items-center">
            <div className="flex min-w-0 items-start gap-3">
              <div className="flex h-[100px] w-[120px] shrink-0 items-center justify-center">
                {logoSrc ? (
                  <img
                    src={logoSrc}
                    alt={b.companyDisplayName || auth?.company?.name || "Company"}
                    className="max-h-[100px] w-full max-w-[208px] object-contain"
                  />
                ) : (
                  <div className="text-2xl font-extrabold tracking-tight text-[#1f5a96]">
                    {String(auth?.company?.code || "MV").slice(0, 4)}
                  </div>
                )}
              </div>
              <div className="min-w-0 pt-0.5">
                <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-[#6b7280]">Purchase order</p>
                <p className="mt-1 font-mono text-lg font-bold tracking-tight text-[#111827]">{poNo}</p>
                <div className="mt-2 space-y-0.5 text-[13px] text-[#555]">
                  <div>
                    <span className="font-semibold text-[#6b7280]">Date: </span>
                    {formatPoDate(doc.orderDate)}
                  </div>
                  <div>
                    <span className="font-semibold text-[#6b7280]">Currency: </span>
                    {cur}
                  </div>
                  {doc.ref ? (
                    <div>
                      <span className="font-semibold text-[#6b7280]">Ref: </span>
                      {doc.ref}
                    </div>
                  ) : null}
                </div>
              </div>
            </div>
            <div className="flex flex-col items-center justify-center text-center">
              <h1 className="text-[26px] font-bold tracking-tight text-[#1f3a5f]">PURCHASE ORDER</h1>
              <p className="mt-1 text-[13px] font-semibold text-[#2c5282]">{docSubtitle}</p>
              <div className="mt-3">
                {unsaved ? (
                  <span className="rounded-full bg-gray-100 px-3 py-1 text-xs font-semibold text-gray-800 ring-1 ring-gray-200">
                    Unsaved draft
                  </span>
                ) : doc.status ? (
                  <span className="rounded-full bg-gray-100 px-3 py-1 text-xs font-semibold uppercase text-gray-800 ring-1 ring-gray-200">
                    {doc.status}
                  </span>
                ) : null}
              </div>
            </div>
            <div className="text-right sm:min-w-0 sm:pl-2">
              <p className="text-[28px] font-extrabold leading-tight tracking-tight text-[#1f3a5f]">
                {buyer.name !== "—" ? buyer.name : b.companyDisplayName || auth?.company?.name || "—"}
              </p>
            </div>
          </header>
        )}

        <div className={`mt-5 grid gap-3 ${showMachineDetails ? "lg:grid-cols-3" : "lg:grid-cols-2"}`}>
          <div className="min-h-[140px] rounded-[10px] border border-[#e5e7eb] bg-[#fafafa] p-3">
            <p className="text-[11px] font-bold uppercase tracking-[0.3px] text-[#6b7280]">Buyer</p>
            <p className="mt-1 text-sm font-semibold text-[#111827]">{buyer.name}</p>
            <p className="mt-1 whitespace-pre-line text-xs leading-relaxed text-[#4a5568]">{buyer.address}</p>
            <p className="mt-2 text-xs text-[#4a5568]">Tel: {buyer.phone}</p>
            <p className="text-xs">{buyer.email}</p>
            {buyer.trn ? <p className="mt-1 text-xs text-[#4a5568]">TRN: {buyer.trn}</p> : null}
          </div>
          <div className="min-h-[140px] rounded-[10px] border border-[#e5e7eb] bg-[#fafafa] p-3">
            <p className="text-[11px] font-bold uppercase tracking-[0.3px] text-[#6b7280]">Supplier</p>
            <p className="mt-1 text-sm font-semibold text-[#111827]">{doc.supplierName || "—"}</p>
            {doc.supplierAddress ? (
              <p className="mt-1 whitespace-pre-line text-xs leading-relaxed text-[#4a5568]">{doc.supplierAddress}</p>
            ) : null}
            <div className="mt-2 space-y-0.5 text-xs text-[#4a5568]">
              {doc.supplierPhone ? <p>Tel: {doc.supplierPhone}</p> : null}
              {doc.supplierEmail ? <p>{doc.supplierEmail}</p> : null}
            </div>
          </div>
          {showMachineDetails ? (
            <div className="min-h-[140px] rounded-[10px] border border-[#e5e7eb] bg-[#fafafa] p-3 text-xs leading-relaxed text-[#555]">
              <p className="mb-2 text-[11px] font-bold uppercase tracking-[0.3px] text-[#6b7280]">Machine Details</p>
              <p><b>Vertical:</b> {machine.vertical}</p>
              <p><b>Brand:</b> {machine.brand}</p>
              <p><b>Model:</b> {machine.model}</p>
              <p><b>Config:</b> {machine.config}</p>
              <p><b>ESN:</b> {machine.esn}</p>
              <p><b>Currency:</b> {machine.currency}</p>
            </div>
          ) : null}
        </div>

        {(doc.delivery || doc.payment || doc.paymentTerms || doc.contactPerson) && (
          <div className="mt-4 grid gap-2 border-t border-[#e5e7eb] pt-4 text-[12px] text-[#555] sm:grid-cols-3">
            {doc.contactPerson ? (
              <div>
                <span className="font-semibold text-[#6b7280]">Contact: </span>
                {doc.contactPerson}
              </div>
            ) : null}
            {doc.delivery ? (
              <div className="text-center sm:text-center">
                <span className="font-semibold text-[#6b7280]">Delivery: </span>
                {doc.delivery}
              </div>
            ) : null}
            {doc.payment || doc.paymentTerms ? (
              <div className="text-right sm:text-right">
                <span className="font-semibold text-[#6b7280]">Payment Terms: </span>
                {resolvePoPaymentTerms(doc)}
              </div>
            ) : null}
          </div>
        )}

        {doc.remarks ? (
          <div className="mt-3 rounded-md border border-dashed border-[#e5e7eb] bg-white px-3 py-2 text-xs text-[#374151]">
            <span className="font-semibold text-[#6b7280]">Header remarks: </span>
            {doc.remarks}
          </div>
        ) : null}

        <div className="mt-4 overflow-x-auto rounded-lg border border-[#e5e7eb]">
          <table className="min-w-[900px] w-full border-collapse text-xs">
            <thead>
              <tr className="bg-[#1f3a5f]">
                <th className={thCell}>S/N</th>
                {!supplierFacing ? <th className={thCell}>Article</th> : null}
                {supplierFacing ? (
                  <>
                    <th className={thCell}>Description</th>
                    <th className={thCell}>Supplier Part Number</th>
                    {showMaterialCode ? <th className={thCell}>Material Code</th> : null}
                  </>
                ) : (
                  <>
                    <th className={thCell}>Part Nr.</th>
                    <th className={thCell}>Supplier Part No.</th>
                    <th className={thCell}>Material Code</th>
                    <th className={thCell}>Description</th>
                  </>
                )}
                <th className={thCell}>UOM</th>
                <th className={`${thCell} text-right`}>QTY</th>
                <th className={`${thCell} text-right`}>Unit rate</th>
                <th className={`${thCell} text-right`}>Total</th>
                <th className={thCell}>Lead time</th>
                <th className={thCell}>Remarks</th>
              </tr>
            </thead>
            <tbody>
              {lines.length === 0 ? (
                <tr>
                  <td colSpan={supplierFacing ? (showMaterialCode ? 10 : 9) : 12} className={`${tdCell} py-8 text-center text-[#6b7280]`}>
                    No line items.
                  </td>
                </tr>
              ) : (
                lines.map((l, i) => {
                  const tot = (Number(l.qty) || 0) * (Number(l.unitPrice) || 0);
                  const stripe = i % 2 === 0 ? "bg-white" : "bg-[#f9fafb]";
                  return (
                      <tr key={l._id || i} className={stripe}>
                        <td className={`${tdCell} text-[#6b7280]`}>{i + 1}</td>
                        {!supplierFacing ? (
                          <td className={`${tdCell} font-mono text-[11px]`}>
                            {l.article || l.articleNo || l.itemCode || "—"}
                          </td>
                        ) : null}
                        {supplierFacing ? (
                          <>
                            <td className={tdCell}>{l.description || "—"}</td>
                            <td className={`${tdCell} font-mono text-[11px]`}>
                              {supplierPartNumberForPrint(l)}
                            </td>
                            {showMaterialCode ? (
                              <td className={`${tdCell} font-mono text-[11px]`}>{materialCodeForPrint(l)}</td>
                            ) : null}
                          </>
                        ) : (
                          <>
                            <td className={`${tdCell} font-mono text-[11px]`}>{l.partNumber || l.partNo || "—"}</td>
                            <td className={`${tdCell} font-mono text-[11px]`}>
                              {supplierPartNumberDisplay(l)}
                            </td>
                            <td className={`${tdCell} font-mono text-[11px]`}>
                              {l.materialCode || l.itemCode || "—"}
                            </td>
                            <td className={tdCell}>{l.description || "—"}</td>
                          </>
                        )}
                      <td className={tdCell}>{l.uom || "PCS"}</td>
                      <td className={`${tdCell} text-right tabular-nums`}>{l.qty}</td>
                      <td className={`${tdCell} text-right tabular-nums`}>{Number(l.unitPrice || 0).toFixed(2)}</td>
                      <td className={`${tdCell} text-right tabular-nums font-semibold text-[#111827]`}>{tot.toFixed(2)}</td>
                      <td className={tdCell}>{l.leadTime || "—"}</td>
                      <td className={`${tdCell} text-[#4b5563]`}>{l.remarks || "—"}</td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        <div className="mt-4 flex justify-end border-t border-[#e5e7eb] pt-4">
          <div className="w-full max-w-xs space-y-1.5 text-sm tabular-nums">
            <div className="flex justify-between text-[#4b5563]">
              <span>Line items subtotal</span>
              <span className="font-semibold text-[#111827]">
                {cur} {subTotal.toFixed(2)}
              </span>
            </div>
            {totalRows.map((row, idx) => (
              <div key={`${row.type}-${row.label}-${idx}`} className="flex justify-between text-[#4b5563]">
                <span>{row.label}</span>
                <span className="font-semibold text-[#111827]">
                  {cur} {row.amount.toFixed(2)}
                </span>
              </div>
            ))}
            <div className="flex justify-between border-t border-[#e5e7eb] pt-1 text-base font-bold text-[#1f3a5f]">
              <span>Grand total</span>
              <span>
                {cur} {grand.toFixed(2)}
              </span>
            </div>
          </div>
        </div>

        <div className="mt-6 border-t border-dashed border-[#cfd8e3] pt-3 text-center text-[11px] text-[#4b5563]">
          {b.useBrandedLayout ? (
            <span>
              {b.reportFooterName}
              {b.reportWebsite ? ` · ${b.reportWebsite}` : ""}
            </span>
          ) : (
            <span>Purchase order — {buyer.name}</span>
          )}
        </div>
      </div>
    </div>
  );
}

function KpiCard({ label, value, hint }) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
      <div className="text-xs font-semibold uppercase tracking-wide text-gray-500">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums text-gray-900">{value}</div>
      {hint ? <div className="mt-1 text-xs text-gray-500">{hint}</div> : null}
    </div>
  );
}

/** Group CSV rows by poNumber, or merge lines for the same supplier when poNumber is blank. */
function csvRowsToPurchaseOrders(rows) {
  const byKey = new Map();
  for (const r of rows) {
    const supplierName = String(r.supplierName || r.Supplier || "").trim();
    const articleNo = String(r.articleNo || r.ArticleNr || r.ArticleNo || "").trim();
    const partNo = String(r.partNo || r.PartNr || r.PartNo || "").trim();
    const itemCode = String(r.itemCode || r.ItemCode || articleNo || partNo || "").trim();
    if (!supplierName || !itemCode) continue;

    const poNumber = String(r.poNumber || r.PONumber || "").trim();
    const key = poNumber || `__SUP__${supplierName.toUpperCase()}`;

    if (!byKey.has(key)) {
      byKey.set(key, {
        poNumber: poNumber || undefined,
        supplierName,
        currency: String(r.currency || r.Currency || "USD").trim() || "USD",
        remarks: String(r.remarks || r.Remarks || "").trim(),
        lines: [],
      });
    }
    const po = byKey.get(key);
    po.lines.push({
      itemCode,
      articleNo: articleNo || itemCode,
      partNo,
      uom: String(r.uom || r.UOM || "PCS").trim() || "PCS",
      description: String(r.description || r.Description || "").trim(),
      qty: Number(r.qty || r.Qty) || 0,
      unitPrice: Number(r.unitPrice || r.UnitPrice || r.Rate) || 0,
      remarks: String(
        r.lineRemarks || r.lineRemark || r.LineRemarks || r["Line remarks"] || r["Line remark"] || ""
      ).trim(),
      leadTime: String(r.leadTime || r.LeadTime || r["Lead time"] || "").trim(),
    });
  }
  return [...byKey.values()].filter((p) => p.lines.length > 0);
}

export default function Purchase({ procurementEmbed = false } = {}) {
  const { auth, can } = useAuth();
  const nav = useNavigate();
  const qc = useQueryClient();
  const [tab, setTab] = useState("orders");
  const [page, setPage] = useState(1);
  const [supPage, setSupPage] = useState(1);
  const [retPage, setRetPage] = useState(1);
  const [pendPage, setPendPage] = useState(1);
  const limit = 20;

  const [poFilterSupplier, setPoFilterSupplier] = useState("");
  const [poFilterStatus, setPoFilterStatus] = useState("");
  const [supSearch, setSupSearch] = useState("");

  const [createOpen, setCreateOpen] = useState(false);
  const [editPoId, setEditPoId] = useState(null);
  const [detailId, setDetailId] = useState(null);
  const [searchParams] = useSearchParams();

  useEffect(() => {
    const id = searchParams.get("id");
    if (id) setDetailId(id);
  }, [searchParams]);

  useEffect(() => {
    if (searchParams.get("fromAllocation") !== "1") return;
    const payload = readPoFromAllocationSession();
    if (!payload) return;
    setForm(buildPoFormFromAllocationPrefill(auth?.company, payload));
    setEditPoId(null);
    setCreateOpen(true);
    clearPoFromAllocationSession();
  }, [searchParams, auth?.company]);

  const [receiveOpen, setReceiveOpen] = useState(false);
  const [form, setForm] = useState(() => initialPoForm(null));
  const [receiveWarehouse, setReceiveWarehouse] = useState("MAIN");
  const [receiveLines, setReceiveLines] = useState([]);
  const [err, setErr] = useState("");
  const [notice, setNotice] = useState("");

  const poImportRef = useRef(null);
  const poLineCsvImportRef = useRef(null);
  const supImportRef = useRef(null);
  const [poPreview, setPoPreview] = useState(null);
  const [poCopyBusyId, setPoCopyBusyId] = useState(null);
  /** { _id, poNumber, supplierName, currency } when register-row upload modal is open */
  const [supplierDocUploadPo, setSupplierDocUploadPo] = useState(null);

  function loadPurchaseOrderCopy(poId, mode) {
    setErr("");
    if (mode === "view") {
      setPoCopyBusyId(poId);
      void (async () => {
        try {
          const full = await apiGet(`/purchase-orders/${poId}`);
          setPoPreview({ unsaved: false, doc: full });
        } catch (e) {
          setErr(e.message || "Could not load purchase order");
        } finally {
          setPoCopyBusyId(null);
        }
      })();
      return;
    }
    setPoCopyBusyId(poId);
    void (async () => {
      try {
        const full = await apiGet(`/purchase-orders/${poId}`);
        await exportPurchaseOrderDocumentPdf(full, auth?.company);
      } catch (e) {
        setErr(e.message || "Could not export purchase order PDF");
      } finally {
        setPoCopyBusyId(null);
      }
    })();
  }

  const { data, isLoading, error } = useQuery({
    queryKey: ["purchaseOrders", page, poFilterSupplier, poFilterStatus, auth?.company?.id],
    queryFn: () =>
      apiGetWithQuery("/purchase-orders", {
        page,
        limit,
        supplierName: poFilterSupplier.trim() || undefined,
        status: poFilterStatus || undefined,
      }),
  });

  const { data: summary } = useQuery({
    queryKey: ["purchaseSummary", auth?.company?.id],
    queryFn: () => apiGet("/purchase-orders/reports/summary"),
    staleTime: 20_000,
  });

  const { data: suppliersAll } = useQuery({
    queryKey: ["suppliersAll", auth?.company?.id],
    queryFn: () => apiGet("/suppliers/all"),
    staleTime: 60_000,
  });

  const supplierPaymentDefaultsAppliedRef = useRef("");

  // When supplier is already set (e.g. from allocation prefill) and Supplier Master loads, apply payment terms once.
  useEffect(() => {
    if (!createOpen || editPoId) return;
    const name = String(form.supplierName || "").trim();
    if (!name || !(suppliersAll?.items?.length)) return;
    const key = name.toLowerCase();
    if (supplierPaymentDefaultsAppliedRef.current === key) return;
    const s = (suppliersAll.items ?? []).find((x) => supplierMasterDisplayName(x).toLowerCase() === key);
    if (!s) return;
    const supplierPaymentTerms = String(s.paymentTerms || "").trim();
    supplierPaymentDefaultsAppliedRef.current = key;
    if (!supplierPaymentTerms) return;
    setForm((f) => {
      const current = String(f.payment || "").trim();
      // Do not overwrite a user override that differs from both default and supplier terms.
      if (
        current &&
        current !== COMMERCIAL_DEFAULTS.payment &&
        current !== supplierPaymentTerms
      ) {
        return f;
      }
      if (current === supplierPaymentTerms) return f;
      return { ...f, payment: supplierPaymentTerms };
    });
  }, [createOpen, editPoId, form.supplierName, suppliersAll?.items]);

  const { data: supList, isLoading: supLoading } = useQuery({
    queryKey: ["suppliers", supPage, supSearch],
    queryFn: () =>
      apiGetWithQuery("/suppliers", {
        page: supPage,
        limit: 25,
        search: supSearch.trim() || undefined,
      }),
    enabled: tab === "suppliers",
  });

  const { data: pendingData, isLoading: pendLoading } = useQuery({
    queryKey: ["pendingPoReport", pendPage, auth?.company?.id],
    queryFn: () =>
      apiGetWithQuery("/purchase-orders/reports/pending", { page: pendPage, limit: 25 }),
    enabled: tab === "pending",
  });

  const { data: returnsData, isLoading: retLoading } = useQuery({
    queryKey: ["purchaseReturns", retPage],
    queryFn: () => apiGetWithQuery("/purchase-returns", { page: retPage, limit: 25 }),
    enabled: tab === "returns",
  });

  const { data: detail } = useQuery({
    queryKey: ["purchaseOrder", detailId],
    queryFn: () => apiGet(`/purchase-orders/${detailId}`),
    enabled: !!detailId,
  });

  const [retDetailId, setRetDetailId] = useState(null);
  const { data: retDetail } = useQuery({
    queryKey: ["purchaseReturn", retDetailId],
    queryFn: () => apiGet(`/purchase-returns/${retDetailId}`),
    enabled: !!retDetailId,
  });

  useEffect(() => {
    if (!createOpen || editPoId) return;
    const b = buyerDefaultsFromCompany(auth?.company);
    setForm((prev) => ({
      ...prev,
      ...b,
      currency: String(auth?.company?.currency || prev.currency || "USD")
        .trim()
        .toUpperCase(),
    }));
  }, [auth?.company?.id, createOpen, editPoId]);

  const createMutation = useMutation({
    mutationFn: (body) => apiPost("/purchase-orders", body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["purchaseOrders"] });
      qc.invalidateQueries({ queryKey: ["purchaseSummary"] });
      qc.invalidateQueries({ queryKey: ["pendingPoReport"] });
      qc.invalidateQueries({ queryKey: ["order-allocation-po-eligibility"] });
      qc.invalidateQueries({ queryKey: ["order-allocation-linked-pos"] });
      qc.invalidateQueries({ queryKey: ["sales-order-allocations"] });
      setErr("");
      setNotice("Purchase order created successfully.");
      notify.success("Purchase order created successfully.");
      setCreateOpen(false);
      setEditPoId(null);
      setForm(initialPoForm(auth?.company));
    },
    onError: (e) => setErr(e.message || "Could not create purchase order"),
  });

  const updatePoMutation = useMutation({
    mutationFn: ({ id, body }) => apiPut(`/purchase-orders/${id}`, body),
    onSuccess: (_, { id }) => {
      qc.invalidateQueries({ queryKey: ["purchaseOrders"] });
      qc.invalidateQueries({ queryKey: ["purchaseSummary"] });
      qc.invalidateQueries({ queryKey: ["pendingPoReport"] });
      qc.invalidateQueries({ queryKey: ["purchaseOrder", id] });
      qc.invalidateQueries({ queryKey: ["order-allocation-po-eligibility"] });
      qc.invalidateQueries({ queryKey: ["order-allocation-linked-pos"] });
      qc.invalidateQueries({ queryKey: ["sales-order-allocations"] });
      setErr("");
      setNotice("Purchase order updated successfully.");
      notify.success("Purchase order updated successfully.");
      setCreateOpen(false);
      setEditPoId(null);
      setDetailId(id);
      setForm(initialPoForm(auth?.company));
    },
    onError: (e) => setErr(e.message || "Could not update purchase order"),
  });

  const deletePoMutation = useMutation({
    mutationFn: (id) => apiDelete(`/purchase-orders/${id}`),
    onSuccess: (_, id) => {
      qc.invalidateQueries({ queryKey: ["purchaseOrders"] });
      qc.invalidateQueries({ queryKey: ["purchaseSummary"] });
      qc.invalidateQueries({ queryKey: ["pendingPoReport"] });
      setErr("");
      if (detailId === id) setDetailId(null);
    },
    onError: (e) => setErr(e.message || "Could not delete purchase order"),
  });

  const duplicatePoMutation = useMutation({
    mutationFn: (id) => apiPost(`/purchase-orders/${id}/duplicate`, {}),
    onSuccess: (doc) => {
      qc.invalidateQueries({ queryKey: ["purchaseOrders"] });
      qc.invalidateQueries({ queryKey: ["purchaseSummary"] });
      qc.invalidateQueries({ queryKey: ["pendingPoReport"] });
      const no = doc?.poNumber || doc?.poNo || "";
      setErr("");
      setNotice(no ? `Purchase order duplicated as ${no}.` : "Purchase order duplicated.");
      notify.success(no ? `PO duplicated as ${no}` : "PO duplicated");
      if (doc?._id) setDetailId(doc._id);
    },
    onError: (e) => setErr(e.message || "Could not duplicate purchase order"),
  });

  function openPoForModify(id) {
    setErr("");
    apiGet(`/purchase-orders/${id}`)
      .then((po) => {
        if (!canModifyPoStatus(po.status)) {
          setErr("Only draft or saved orders can be modified.");
          return;
        }
        setForm(purchaseOrderApiToForm(po));
        setEditPoId(id);
        setCreateOpen(true);
      })
      .catch((e) => setErr(e.message));
  }

  async function confirmDeletePoRow(row) {
    if (!canDeletePurchaseOrderRole(auth?.user?.role)) return;
    if (!canModifyPoStatus(row.status)) {
      notify.warning("Only draft or saved orders can be deleted.");
      return;
    }
    if (!await confirmDialog(`Delete purchase order ${row.poNumber}? This cannot be undone.`)) return;
    deletePoMutation.mutate(row._id);
  }

  function openModifyFromDetail() {
    if (!detail || !canModifyPoStatus(detail.status)) return;
    setErr("");
    setForm(purchaseOrderApiToForm(detail));
    setEditPoId(detail._id);
    setDetailId(null);
    setCreateOpen(true);
  }

  async function confirmDeleteDetail() {
    if (!detail || !canDeletePurchaseOrderRole(auth?.user?.role)) return;
    if (!canModifyPoStatus(detail.status)) {
      notify.warning("Only draft or saved orders can be deleted.");
      return;
    }
    if (!await confirmDialog(`Delete purchase order ${detail.poNumber}? This cannot be undone.`)) return;
    deletePoMutation.mutate(detail._id);
  }

  const poPreviewTotals = useMemo(() => calcPoTotalsPreview(form), [
    form.lines,
    form.adjustments,
    form.packingCost,
    form.handlingCost,
    form.miscellaneousCost,
    form.discountType,
    form.discountValue,
  ]);

  function applySupplierMasterDefaults(name) {
    const n = name.trim().toLowerCase();
    if (!n) return;
    const s = (suppliersAll?.items ?? []).find((x) => supplierMasterDisplayName(x).toLowerCase() === n);
    if (!s) return;
    const cur = String(s.currency || "").trim().toUpperCase();
    const supplierPaymentTerms = String(s.paymentTerms || "").trim();
    supplierPaymentDefaultsAppliedRef.current = n;
    setForm((f) => ({
      ...f,
      supplierName: supplierMasterDisplayName(s) || f.supplierName,
      supplierAddress: f.supplierAddress || s.address || "",
      supplierPhone: f.supplierPhone || s.phone || "",
      supplierEmail: f.supplierEmail || s.email || "",
      contactPerson: f.contactPerson || s.contactPerson || s.contactName || "",
      currency: cur || f.currency,
      // Auto-fill Payment Terms from Supplier Master; user may still override in the form.
      ...(supplierPaymentTerms ? { payment: supplierPaymentTerms } : {}),
    }));
  }

  const poImportMutation = useMutation({
    mutationFn: (orders) => apiPost("/purchase-orders/import", { orders }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["purchaseOrders"] });
      qc.invalidateQueries({ queryKey: ["purchaseSummary"] });
      qc.invalidateQueries({ queryKey: ["pendingPoReport"] });
    },
    onError: (e) => setErr(e.message),
  });

  const receiveMutation = useMutation({
    mutationFn: (body) => apiPost(`/purchase-orders/${detailId}/receive`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["purchaseOrders"] });
      qc.invalidateQueries({ queryKey: ["purchaseOrder", detailId] });
      qc.invalidateQueries({ queryKey: ["purchaseSummary"] });
      qc.invalidateQueries({ queryKey: ["stockBalances"] });
      qc.invalidateQueries({ queryKey: ["inventoryLedger"] });
      qc.invalidateQueries({ queryKey: ["pendingPoReport"] });
      setReceiveOpen(false);
    },
    onError: (e) => setErr(e.message),
  });

  const [supModal, setSupModal] = useState(false);
  const [supEditing, setSupEditing] = useState(null);
  const [supForm, setSupForm] = useState({
    supplierCode: "",
    name: "",
    contactName: "",
    phone: "",
    email: "",
    address: "",
    vatNo: "",
    tradeLicenseNo: "",
    notes: "",
  });

  const saveSupMutation = useMutation({
    mutationFn: () =>
      supEditing
        ? apiPut(`/suppliers/${supEditing}`, supForm)
        : apiPost("/suppliers", supForm),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["suppliers"] });
      qc.invalidateQueries({ queryKey: ["suppliersAll"] });
      setSupModal(false);
      setSupEditing(null);
    },
    onError: (e) => setErr(e.message),
  });

  const delSupMutation = useMutation({
    mutationFn: (id) => apiDelete(`/suppliers/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["suppliers"] });
      qc.invalidateQueries({ queryKey: ["suppliersAll"] });
    },
  });

  const supImportMutation = useMutation({
    mutationFn: (suppliers) => apiPost("/suppliers/import", { suppliers }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["suppliers"] });
      qc.invalidateQueries({ queryKey: ["suppliersAll"] });
    },
    onError: (e) => setErr(e.message),
  });

  const [retOpen, setRetOpen] = useState(false);
  const [retForm, setRetForm] = useState({
    supplierName: "",
    linkedPoNumber: "",
    warehouse: "MAIN",
    currency: "USD",
    remarks: "",
    lines: [defaultPrLine()],
  });

  const createRetMutation = useMutation({
    mutationFn: () => apiPost("/purchase-returns", retForm),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["purchaseReturns"] });
      setRetOpen(false);
      setRetForm({
        supplierName: "",
        linkedPoNumber: "",
        warehouse: "MAIN",
        currency: "USD",
        remarks: "",
        lines: [defaultPrLine()],
      });
    },
    onError: (e) => setErr(e.message),
  });

  const postRetMutation = useMutation({
    mutationFn: (id) => apiPost(`/purchase-returns/${id}/post`, {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["purchaseReturns"] });
      qc.invalidateQueries({ queryKey: ["purchaseReturn", retDetailId] });
      qc.invalidateQueries({ queryKey: ["stockBalances"] });
      qc.invalidateQueries({ queryKey: ["inventoryLedger"] });
    },
    onError: (e) => setErr(e.message),
  });

  function openReceive() {
    if (!detail?.lines?.length) return;
    setErr("");
    setReceiveWarehouse("MAIN");
    setReceiveLines(
      detail.lines.map((l) => ({
        lineId: l._id,
        itemCode: l.itemCode,
        max: Math.max(0, (l.qty || 0) - (l.receivedQty || 0)),
        qty: Math.max(0, (l.qty || 0) - (l.receivedQty || 0)),
      }))
    );
    setReceiveOpen(true);
  }

  const rows = data?.items ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / limit));

  const supplierCount = suppliersAll?.items?.length ?? "—";
  const showOrdersSection = procurementEmbed || tab === "orders";

  function exportPoCsv() {
    const cols = [
      { key: "poNumber", header: "PO #" },
      { key: "supplierName", header: "Supplier" },
      { key: "orderDate", header: "Date" },
      { key: "status", header: "Status" },
      { key: "currency", header: "CCY" },
      { key: "grandTotal", header: "Total" },
    ];
    const out = rows.map((r) => ({
      ...r,
      orderDate: r.orderDate ? new Date(r.orderDate).toLocaleDateString() : "",
      grandTotal: Number(r.grandTotal || 0).toFixed(2),
    }));
    downloadCsv(`purchase-orders-${Date.now()}.csv`, cols, out);
  }

  function exportPoPdf() {
    const cols = [
      { key: "poNumber", header: "PO #" },
      { key: "supplierName", header: "Supplier" },
      { key: "orderDate", header: "Date" },
      { key: "status", header: "Status" },
      { key: "grandTotal", header: "Total" },
    ];
    const out = rows.map((r) => ({
      ...r,
      orderDate: r.orderDate ? new Date(r.orderDate).toLocaleDateString() : "",
      grandTotal: `${r.currency || ""} ${Number(r.grandTotal || 0).toFixed(2)}`,
    }));
    downloadPdfTable(
      "Purchase orders",
      "Marivoltz ERP — procurement register",
      cols,
      out,
      "purchase-orders"
    );
  }

  function onPoCsvFile(e) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: (res) => {
        try {
          const orders = csvRowsToPurchaseOrders(res.data);
          if (!orders.length) {
            setErr("No valid rows: need supplierName and itemCode at minimum.");
            return;
          }
          setErr("");
          poImportMutation.mutate(orders);
        } catch (ex) {
          setErr(ex.message || "CSV parse failed");
        }
      },
      error: (ex) => setErr(ex.message),
    });
  }

  function draftDocSnapshotForExport() {
    const isNewDraft = !editPoId;
    return {
      ...form,
      orderDate: form.orderDate,
      lines: form.lines,
      subTotal: poPreviewTotals.subTotal,
      discountType: poPreviewTotals.discountType || form.discountType || "NONE",
      discountValue: poPreviewTotals.discountValue ?? form.discountValue ?? 0,
      discountTotal: poPreviewTotals.discountTotal,
      packingCost: poPreviewTotals.packingCost,
      handlingCost: poPreviewTotals.handlingCost,
      miscellaneousCost: poPreviewTotals.miscellaneousCost,
      adjustments: Array.isArray(form.adjustments) ? form.adjustments : [],
      grandTotal: poPreviewTotals.grandTotal,
      status: form.status || "DRAFT",
      __unsavedDraft: isNewDraft,
    };
  }

  function onPoLinesCsvFile(e) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: (res) => {
        const imported = (res.data || []).map(mapCsvRowToPurchaseOrderLine).filter(lineIsImportable);
        if (!imported.length) {
          setErr(
            "No valid lines in CSV. Use headers: Article Nr., Description, Part Nr., Supplier Part Number, Material Code, Qty, UOM, Unit rate, Remarks, Lead time (Article or Part Nr. and Qty required per row)."
          );
          return;
        }
        setErr("");
        setForm((f) => {
          const onlyEmptyFirst =
            f.lines.length === 1 &&
            !String(f.lines[0].articleNo || "").trim() &&
            !String(f.lines[0].partNo || "").trim() &&
            !String(f.lines[0].description || "").trim() &&
            Number(f.lines[0].qty) === 1 &&
            Number(f.lines[0].unitPrice) === 0;
          const base = onlyEmptyFirst ? [] : f.lines;
          return { ...f, lines: [...base, ...imported] };
        });
      },
      error: (ex) => setErr(ex.message),
    });
  }

  function exportSuppliersCsv() {
    const items = supList?.items ?? [];
    const cols = [
      { key: "supplierCode", header: "Code" },
      { key: "name", header: "Name" },
      { key: "contactName", header: "Contact" },
      { key: "phone", header: "Phone" },
      { key: "email", header: "Email" },
      { key: "vatNo", header: "VAT" },
      { key: "tradeLicenseNo", header: "Trade License / Registration No" },
    ];
    downloadCsv(`suppliers-${Date.now()}.csv`, cols, items);
  }

  function exportSuppliersPdf() {
    const items = supList?.items ?? [];
    const cols = [
      { key: "supplierCode", header: "Code" },
      { key: "name", header: "Name" },
      { key: "phone", header: "Phone" },
      { key: "email", header: "Email" },
    ];
    downloadPdfTable(
      "Supplier master",
      "Registered vendors",
      cols,
      items,
      "suppliers"
    );
  }

  function onSupCsvFile(e) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: (res) => {
        const suppliers = res.data
          .map((r) => ({
            name: String(r.name || r.Name || "").trim(),
            supplierCode: String(r.supplierCode || r.Code || "").trim(),
            contactName: r.contactName || "",
            phone: r.phone || "",
            email: r.email || "",
            address: r.address || "",
            vatNo: r.vatNo || r.VAT || r.gstNo || "",
            tradeLicenseNo: r.tradeLicenseNo || r["Trade License Number"] || r["Registration Number"] || r.panNo || "",
            notes: r.notes || "",
          }))
          .filter((r) => r.name);
        if (!suppliers.length) {
          setErr("No rows with a name column.");
          return;
        }
        setErr("");
        supImportMutation.mutate(suppliers);
      },
    });
  }

  function exportPendingPdf() {
    const items = pendingData?.items ?? [];
    const cols = [
      { key: "poNumber", header: "PO #" },
      { key: "supplierName", header: "Supplier" },
      { key: "status", header: "Status" },
      { key: "pct", header: "Receipt %" },
      { key: "pendingQty", header: "Pending qty" },
    ];
    const out = items.map((r) => ({
      poNumber: r.poNumber,
      supplierName: r.supplierName,
      status: r.status,
      pct: `${r._report?.receiptPercent ?? 0}%`,
      pendingQty: r._report?.pendingQty ?? "",
    }));
    downloadPdfTable(
      "Pending purchase orders",
      "Open and partially received POs",
      cols,
      out,
      "pending-po"
    );
  }

  return (
    <div className={procurementEmbed ? "space-y-3" : "space-y-6"}>
      {!procurementEmbed ? (
        <div className="rounded-2xl border border-gray-200 bg-gradient-to-br from-slate-50 to-white px-6 py-5 shadow-sm">
          <div className="flex flex-col gap-2 border-b border-gray-200/80 pb-4 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-widest text-slate-500">
                Procurement
              </p>
              <h1 className="text-2xl font-bold tracking-tight text-gray-900">Purchase</h1>
              <p className="mt-1 max-w-2xl text-sm text-gray-600">
                Supplier master, purchase orders, goods receipt, returns, and operational reports.
                Data below refreshes from your authorised API.
              </p>
            </div>
            <div className="text-right text-xs text-gray-500">
              <div className="font-medium text-gray-700">Marivoltz ERP</div>
              <div>Module version · live register</div>
            </div>
          </div>

          <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <KpiCard
              label="Total POs"
              value={summary?.totalPurchaseOrders ?? "—"}
              hint="All recorded orders"
            />
            <KpiCard
              label="Pending orders"
              value={summary?.pendingOrderCount ?? "—"}
              hint="Not received / cancelled"
            />
            <KpiCard
              label="Order value (sum)"
              value={
                summary?.totalOrderValue != null
                  ? `USD ${Number(summary.totalOrderValue).toLocaleString(undefined, {
                      minimumFractionDigits: 2,
                      maximumFractionDigits: 2,
                    })}`
                  : "—"
              }
              hint="Grand total, all POs"
            />
            <KpiCard
              label="Suppliers on file"
              value={supplierCount}
              hint="Master records"
            />
          </div>
        </div>
      ) : null}

      {(error || err) && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {error?.message || err}
        </div>
      )}
      {notice && !err && !error ? (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">
          {notice}
        </div>
      ) : null}

      {!procurementEmbed ? (
        <div className="flex flex-wrap gap-2 rounded-xl border border-gray-200 bg-white p-2 shadow-sm">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={async () => {
                setTab(t.id);
                setErr("");
              }}
              className={[
                "rounded-lg px-4 py-2.5 text-sm font-semibold transition-colors",
                tab === t.id
                  ? "bg-gray-900 text-white shadow"
                  : "text-gray-700 hover:bg-gray-100",
              ].join(" ")}
            >
              {t.label}
            </button>
          ))}
        </div>
      ) : null}

      {showOrdersSection && (
        <section className="rounded-2xl border border-gray-200 bg-white shadow-sm">
          <div className="flex flex-col gap-3 border-b border-gray-100 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="text-sm font-semibold text-gray-900">Purchase order register</h2>
              <p className="text-xs text-gray-500">Filter, export, and open lines for receipt.</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <input ref={poImportRef} type="file" accept=".csv" className="hidden" onChange={onPoCsvFile} />
              <button
                type="button"
                className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-xs font-semibold text-gray-800 hover:bg-gray-50"
                onClick={() => poImportRef.current?.click()}
                disabled={poImportMutation.isPending}
              >
                {poImportMutation.isPending ? "Importing…" : "Import CSV"}
              </button>
              <button
                type="button"
                className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-xs font-semibold text-gray-800 hover:bg-gray-50"
                onClick={exportPoCsv}
                disabled={!rows.length}
              >
                Export CSV
              </button>
              <button
                type="button"
                className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-xs font-semibold text-gray-800 hover:bg-gray-50"
                onClick={exportPoPdf}
                disabled={!rows.length}
              >
                Export PDF
              </button>
              <button
                type="button"
                className="rounded-lg bg-gray-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-gray-800"
                onClick={async () => {
                  setErr("");
                  createMutation.reset();
                  updatePoMutation.reset();
                  setEditPoId(null);
                  supplierPaymentDefaultsAppliedRef.current = "";
                  setForm(initialPoForm(auth?.company));
                  setCreateOpen(true);
                }}
              >
                New PO
              </button>
            </div>
          </div>

          <div className="grid gap-3 border-b border-gray-100 px-4 py-3 sm:grid-cols-3">
            <FormField label="Filter supplier">
              <TextInput
                value={poFilterSupplier}
                onChange={(e) => setPoFilterSupplier(e.target.value)}
                placeholder="Name contains…"
              />
            </FormField>
            <FormField label="Status">
              <select
                className="w-full rounded-xl border border-gray-200 px-3 py-2 text-sm"
                value={poFilterStatus}
                onChange={(e) => setPoFilterStatus(e.target.value)}
              >
                <option value="">All</option>
                <option value="DRAFT">DRAFT</option>
                <option value="SAVED">SAVED</option>
                <option value="SENT">SENT</option>
                <option value="PARTIAL_RECEIVED">PARTIAL_RECEIVED</option>
                <option value="RECEIVED">RECEIVED</option>
                <option value="CANCELLED">CANCELLED</option>
              </select>
            </FormField>
            <div className="flex items-end">
              <button
                type="button"
                className="w-full rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm font-medium"
                onClick={async () => {
                  setPage(1);
                  qc.invalidateQueries({ queryKey: ["purchaseOrders"] });
                }}
              >
                Apply filters
              </button>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="min-w-full text-left text-sm">
              <thead className="border-b border-gray-200 bg-gray-50/90 text-xs font-bold uppercase tracking-wide text-gray-600">
                <tr>
                  <th className="px-4 py-3">PO #</th>
                  <th className="px-4 py-3">Supplier</th>
                  <th className="px-4 py-3">Date</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3 text-right">Total</th>
                  <th className="px-4 py-3 min-w-[280px] text-left">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {isLoading ? (
                  <tr>
                    <td colSpan={6} className="px-4 py-10 text-center text-gray-500">
                      Loading…
                    </td>
                  </tr>
                ) : rows.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-4 py-10 text-center text-gray-500">
                      No purchase orders.
                    </td>
                  </tr>
                ) : (
                  rows.map((r) => (
                    <tr key={r._id} className="hover:bg-slate-50/80">
                      <td className="px-4 py-2.5 font-mono text-xs font-semibold text-gray-900">
                        {r.poNumber}
                      </td>
                      <td className="px-4 py-2.5 text-gray-800">{r.supplierName}</td>
                      <td className="px-4 py-2.5 text-gray-600">
                        {r.orderDate ? new Date(r.orderDate).toLocaleDateString() : "—"}
                      </td>
                      <td className="px-4 py-2.5">
                        <StatusBadge status={r.status} />
                      </td>
                      <td className="px-4 py-2.5 text-right font-medium tabular-nums text-gray-900">
                        {r.currency} {Number(r.grandTotal || 0).toFixed(2)}
                      </td>
                      <td className="px-4 py-2.5">
                        <div className="flex flex-wrap gap-1.5">
                          <button
                            type="button"
                            className="rounded-md border border-gray-300 bg-white px-2.5 py-1 text-xs font-semibold text-gray-800 hover:bg-gray-50"
                            onClick={async () => {
                              setDetailId(r._id);
                              setErr("");
                            }}
                          >
                            Open
                          </button>
                          <button
                            type="button"
                            title="Formatted PO — same as preview"
                            className="rounded-md border border-gray-300 bg-white px-2.5 py-1 text-xs font-semibold text-gray-800 hover:bg-gray-50 disabled:opacity-50"
                            disabled={poCopyBusyId === r._id}
                            onClick={() => loadPurchaseOrderCopy(r._id, "view")}
                          >
                            {poCopyBusyId === r._id ? "…" : "View PO"}
                          </button>
                          {String(r.status || "").toUpperCase() !== "CANCELLED" ? (
                            <button
                              type="button"
                              title="Create a new draft PO copied from this order"
                              className="rounded-md border border-gray-300 bg-white px-2.5 py-1 text-xs font-semibold text-gray-800 hover:bg-gray-50 disabled:opacity-50"
                              disabled={duplicatePoMutation.isPending}
                              onClick={() => duplicatePoMutation.mutate(r._id)}
                            >
                              {duplicatePoMutation.isPending ? "…" : "Duplicate"}
                            </button>
                          ) : null}
                          <button
                            type="button"
                            title="Opens print dialog — choose Save as PDF"
                            className="rounded-md border border-gray-300 bg-white px-2.5 py-1 text-xs font-semibold text-gray-800 hover:bg-gray-50 disabled:opacity-50"
                            disabled={poCopyBusyId === r._id}
                            onClick={() => loadPurchaseOrderCopy(r._id, "print")}
                          >
                            Save PDF
                          </button>
                          <button
                            type="button"
                            title="Upload supplier proforma or tax invoice and link to this PO"
                            className="rounded-md border border-indigo-200 bg-indigo-50 px-2.5 py-1 text-xs font-semibold text-indigo-900 hover:bg-indigo-100"
                            onClick={async () => {
                              setErr("");
                              setSupplierDocUploadPo({
                                _id: r._id,
                                poNumber: r.poNumber || r.poNo || "",
                                supplierName: r.supplierName || "",
                                currency: r.currency || "USD",
                              });
                            }}
                          >
                            Upload invoice / PI
                          </button>
                          {canModifyPoStatus(r.status) ? (
                            <button
                              type="button"
                              className="rounded-md border border-gray-300 bg-white px-2.5 py-1 text-xs font-semibold text-gray-800 hover:bg-gray-50"
                              onClick={() => openPoForModify(r._id)}
                            >
                              Modify
                            </button>
                          ) : null}
                          {canModifyPoStatus(r.status) && canDeletePurchaseOrderRole(auth?.user?.role) ? (
                            <button
                              type="button"
                              className="rounded-md border border-red-200 bg-white px-2.5 py-1 text-xs font-semibold text-red-700 hover:bg-red-50 disabled:opacity-50"
                              disabled={deletePoMutation.isPending}
                              onClick={() => confirmDeletePoRow(r)}
                            >
                              Delete
                            </button>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          <div className="flex items-center justify-between border-t border-gray-100 px-4 py-2 text-xs text-gray-600">
            <span>
              Page {page}/{totalPages} · {total} POs
            </span>
            <div className="flex gap-2">
              <button
                type="button"
                className="rounded-md border px-2 py-1 disabled:opacity-40"
                disabled={page <= 1}
                onClick={() => setPage((p) => p - 1)}
              >
                Prev
              </button>
              <button
                type="button"
                className="rounded-md border px-2 py-1 disabled:opacity-40"
                disabled={page >= totalPages}
                onClick={() => setPage((p) => p + 1)}
              >
                Next
              </button>
            </div>
          </div>
        </section>
      )}

      {tab === "suppliers" && (
        <section className="rounded-2xl border border-gray-200 bg-white shadow-sm">
          <div className="flex flex-col gap-3 border-b border-gray-100 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="text-sm font-semibold text-gray-900">Supplier master</h2>
              <p className="text-xs text-gray-500">Legal and contact details for approved vendors.</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <input ref={supImportRef} type="file" accept=".csv" className="hidden" onChange={onSupCsvFile} />
              <button
                type="button"
                className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-xs font-semibold"
                onClick={() => supImportRef.current?.click()}
                disabled={supImportMutation.isPending}
              >
                {supImportMutation.isPending ? "Importing…" : "Import CSV"}
              </button>
              <button type="button" className="rounded-lg border px-3 py-1.5 text-xs font-semibold" onClick={exportSuppliersCsv}>
                Export CSV
              </button>
              <button type="button" className="rounded-lg border px-3 py-1.5 text-xs font-semibold" onClick={exportSuppliersPdf}>
                Export PDF
              </button>
              <button
                type="button"
                className="rounded-lg bg-gray-900 px-3 py-1.5 text-xs font-semibold text-white"
                onClick={async () => {
                  setSupEditing(null);
                  setSupForm({
                    supplierCode: "",
                    name: "",
                    contactName: "",
                    phone: "",
                    email: "",
                    address: "",
                    vatNo: "",
                    tradeLicenseNo: "",
                    notes: "",
                  });
                  setErr("");
                  setSupModal(true);
                }}
              >
                New supplier
              </button>
            </div>
          </div>
          <div className="border-b border-gray-100 px-4 py-3 sm:max-w-md">
            <FormField label="Search">
              <TextInput
                value={supSearch}
                onChange={(e) => setSupSearch(e.target.value)}
                placeholder="Name, code, email…"
              />
            </FormField>
            <button
              type="button"
              className="mt-2 rounded-lg bg-gray-100 px-3 py-1.5 text-xs font-semibold"
              onClick={() => setSupPage(1)}
            >
              Search
            </button>
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="border-b border-gray-200 bg-gray-50/90 text-xs font-bold uppercase text-gray-600">
                <tr>
                  <th className="px-4 py-3">Code</th>
                  <th className="px-4 py-3">Name</th>
                  <th className="px-4 py-3">Contact</th>
                  <th className="px-4 py-3">Phone</th>
                  <th className="px-4 py-3">Email</th>
                  <th className="px-4 py-3 w-32" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {supLoading ? (
                  <tr>
                    <td colSpan={6} className="px-4 py-10 text-center text-gray-500">
                      Loading…
                    </td>
                  </tr>
                ) : (supList?.items ?? []).length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-4 py-10 text-center text-gray-500">
                      No suppliers.
                    </td>
                  </tr>
                ) : (
                  (supList?.items ?? []).map((s) => (
                    <tr key={s._id} className="hover:bg-slate-50/80">
                      <td className="px-4 py-2 font-mono text-xs">{s.supplierCode}</td>
                      <td className="px-4 py-2 font-medium">{s.name}</td>
                      <td className="px-4 py-2 text-gray-600">{s.contactName}</td>
                      <td className="px-4 py-2">{s.phone}</td>
                      <td className="px-4 py-2 text-xs text-gray-600">{s.email}</td>
                      <td className="px-4 py-2">
                        <button
                          type="button"
                          className="mr-1 rounded border px-2 py-0.5 text-xs"
                          onClick={async () => {
                            setSupEditing(s._id);
                            setSupForm({
                              supplierCode: s.supplierCode || "",
                              name: s.name || "",
                              contactName: s.contactName || "",
                              phone: s.phone || "",
                              email: s.email || "",
                              address: s.address || "",
                              vatNo: s.vatNo || s.gstNo || "",
                              tradeLicenseNo: s.tradeLicenseNo || s.panNo || "",
                              notes: s.notes || "",
                            });
                            setSupModal(true);
                          }}
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          className="rounded border border-red-200 px-2 py-0.5 text-xs text-red-700"
                          onClick={async () => {
                            if (await confirmDialog("Delete this supplier?")) delSupMutation.mutate(s._id);
                          }}
                        >
                          Del
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          <div className="flex justify-between border-t px-4 py-2 text-xs text-gray-600">
            <span>
              Page {supPage} / {Math.max(1, Math.ceil((supList?.total || 0) / 25))} · {supList?.total ?? 0}{" "}
              suppliers
            </span>
            <div className="flex gap-2">
              <button
                type="button"
                className="rounded border px-2 py-0.5 disabled:opacity-40"
                disabled={supPage <= 1}
                onClick={() => setSupPage((p) => p - 1)}
              >
                Prev
              </button>
              <button
                type="button"
                className="rounded border px-2 py-0.5 disabled:opacity-40"
                disabled={supPage >= Math.max(1, Math.ceil((supList?.total || 0) / 25))}
                onClick={() => setSupPage((p) => p + 1)}
              >
                Next
              </button>
            </div>
          </div>
        </section>
      )}

      {tab === "summary" && summary && (
        <section className="grid gap-4 lg:grid-cols-2">
          <div className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
            <h3 className="text-sm font-semibold text-gray-900">Orders by status</h3>
            <div className="mt-3 overflow-hidden rounded-lg border border-gray-100">
              <table className="min-w-full text-sm">
                <thead className="bg-gray-50 text-xs font-bold uppercase text-gray-600">
                  <tr>
                    <th className="px-3 py-2 text-left">Status</th>
                    <th className="px-3 py-2 text-right">Count</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {Object.entries(summary.byStatus || {}).map(([k, v]) => (
                    <tr key={k}>
                      <td className="px-3 py-2">
                        <StatusBadge status={k} />
                      </td>
                      <td className="px-3 py-2 text-right font-semibold tabular-nums">{v}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          <div className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
            <h3 className="text-sm font-semibold text-gray-900">Top suppliers by order value</h3>
            <div className="mt-3 overflow-hidden rounded-lg border border-gray-100">
              <table className="min-w-full text-sm">
                <thead className="bg-gray-50 text-xs font-bold uppercase text-gray-600">
                  <tr>
                    <th className="px-3 py-2 text-left">Supplier</th>
                    <th className="px-3 py-2 text-right">Value (sum)</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {(summary.topSuppliersByValue || []).map((r) => (
                    <tr key={r.supplierName}>
                      <td className="px-3 py-2">{r.supplierName}</td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {Number(r.value).toLocaleString(undefined, { maximumFractionDigits: 2 })}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="mt-3 flex gap-2">
              <button
                type="button"
                className="rounded-lg border px-3 py-1.5 text-xs font-semibold"
                onClick={async () => {
                  const cols = [
                    { key: "supplierName", header: "Supplier" },
                    { key: "value", header: "Value" },
                  ];
                  downloadCsv(`po-summary-suppliers-${Date.now()}.csv`, cols, summary.topSuppliersByValue || []);
                }}
              >
                Export summary CSV
              </button>
              <button
                type="button"
                className="rounded-lg border px-3 py-1.5 text-xs font-semibold"
                onClick={() =>
                  downloadPdfTable(
                    "PO summary — suppliers",
                    "By total order value",
                    [
                      { key: "supplierName", header: "Supplier" },
                      { key: "value", header: "Value" },
                    ],
                    (summary.topSuppliersByValue || []).map((r) => ({
                      ...r,
                      value: Number(r.value).toFixed(2),
                    })),
                    "po-summary"
                  )
                }
              >
                Export PDF
              </button>
            </div>
          </div>
        </section>
      )}

      {tab === "returns" && (
        <section className="rounded-2xl border border-gray-200 bg-white shadow-sm">
          <div className="flex flex-col gap-3 border-b border-gray-100 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="text-sm font-semibold text-gray-900">Purchase returns</h2>
              <p className="text-xs text-gray-500">
                Draft a return, then post to remove stock (supplier return).
              </p>
            </div>
            <button
              type="button"
              className="rounded-lg bg-gray-900 px-3 py-1.5 text-xs font-semibold text-white"
              onClick={async () => {
                setErr("");
                setRetOpen(true);
              }}
            >
              New return
            </button>
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="border-b border-gray-200 bg-gray-50 text-xs font-bold uppercase text-gray-600">
                <tr>
                  <th className="px-4 py-3">Return #</th>
                  <th className="px-4 py-3">Supplier</th>
                  <th className="px-4 py-3">Date</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3 text-right">Total</th>
                  <th className="px-4 py-3 w-24" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {retLoading ? (
                  <tr>
                    <td colSpan={6} className="px-4 py-10 text-center">
                      Loading…
                    </td>
                  </tr>
                ) : (returnsData?.items ?? []).length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-4 py-10 text-center text-gray-500">
                      No returns.
                    </td>
                  </tr>
                ) : (
                  (returnsData?.items ?? []).map((r) => (
                    <tr key={r._id} className="hover:bg-slate-50/80">
                      <td className="px-4 py-2 font-mono text-xs">{r.returnNumber}</td>
                      <td className="px-4 py-2">{r.supplierName}</td>
                      <td className="px-4 py-2 text-gray-600">
                        {r.returnDate ? new Date(r.returnDate).toLocaleDateString() : "—"}
                      </td>
                      <td className="px-4 py-2">
                        <StatusBadge status={r.status} />
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums">
                        {r.currency} {Number(r.grandTotal || 0).toFixed(2)}
                      </td>
                      <td className="px-4 py-2">
                        <button
                          type="button"
                          className="rounded border px-2 py-0.5 text-xs"
                          onClick={async () => {
                            setRetDetailId(r._id);
                            setErr("");
                          }}
                        >
                          Open
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          <div className="flex justify-between border-t px-4 py-2 text-xs text-gray-600">
            <span>
              Page {retPage} / {Math.max(1, Math.ceil((returnsData?.total || 0) / 25))}
            </span>
            <div className="flex gap-2">
              <button
                type="button"
                className="rounded border px-2 py-0.5 disabled:opacity-40"
                disabled={retPage <= 1}
                onClick={() => setRetPage((p) => p - 1)}
              >
                Prev
              </button>
              <button
                type="button"
                className="rounded border px-2 py-0.5 disabled:opacity-40"
                disabled={retPage >= Math.max(1, Math.ceil((returnsData?.total || 0) / 25))}
                onClick={() => setRetPage((p) => p + 1)}
              >
                Next
              </button>
            </div>
          </div>
        </section>
      )}

      {tab === "pending" && (
        <section className="rounded-2xl border border-gray-200 bg-white shadow-sm">
          <div className="flex flex-col gap-3 border-b border-gray-100 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="text-sm font-semibold text-gray-900">Pending purchase orders</h2>
              <p className="text-xs text-gray-500">
                Open and partially received — receipt progress per order.
              </p>
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                className="rounded-lg border px-3 py-1.5 text-xs font-semibold"
                onClick={async () => {
                  const items = pendingData?.items ?? [];
                  const cols = [
                    { key: "poNumber", header: "PO #" },
                    { key: "supplierName", header: "Supplier" },
                    { key: "status", header: "Status" },
                    { key: "receiptPercent", header: "Receipt %" },
                    { key: "pendingQty", header: "Pending qty" },
                  ];
                  const out = items.map((r) => ({
                    poNumber: r.poNumber,
                    supplierName: r.supplierName,
                    status: r.status,
                    receiptPercent: r._report?.receiptPercent,
                    pendingQty: r._report?.pendingQty,
                  }));
                  downloadCsv(`pending-po-${Date.now()}.csv`, cols, out);
                }}
                disabled={!(pendingData?.items?.length > 0)}
              >
                Export CSV
              </button>
              <button
                type="button"
                className="rounded-lg border px-3 py-1.5 text-xs font-semibold"
                onClick={exportPendingPdf}
                disabled={!(pendingData?.items?.length > 0)}
              >
                Export PDF
              </button>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="border-b border-gray-200 bg-gray-50 text-xs font-bold uppercase text-gray-600">
                <tr>
                  <th className="px-4 py-3">PO #</th>
                  <th className="px-4 py-3">Supplier</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3 text-right">Receipt %</th>
                  <th className="px-4 py-3 text-right">Pending qty</th>
                  <th className="px-4 py-3 w-24" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {pendLoading ? (
                  <tr>
                    <td colSpan={6} className="px-4 py-10 text-center">
                      Loading…
                    </td>
                  </tr>
                ) : (pendingData?.items ?? []).length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-4 py-10 text-center text-gray-500">
                      No pending purchase orders.
                    </td>
                  </tr>
                ) : (
                  (pendingData?.items ?? []).map((r) => (
                    <tr key={r._id} className="hover:bg-slate-50/80">
                      <td className="px-4 py-2 font-mono text-xs font-semibold">{r.poNumber}</td>
                      <td className="px-4 py-2">{r.supplierName}</td>
                      <td className="px-4 py-2">
                        <StatusBadge status={r.status} />
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums">
                        {r._report?.receiptPercent ?? 0}%
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums text-amber-800">
                        {r._report?.pendingQty ?? 0}
                      </td>
                      <td className="px-4 py-2">
                        <button
                          type="button"
                          className="rounded border px-2 py-0.5 text-xs"
                          onClick={async () => {
                            setDetailId(r._id);
                            setTab("orders");
                          }}
                        >
                          Open PO
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          <div className="flex justify-between border-t px-4 py-2 text-xs text-gray-600">
            <span>
              Page {pendPage} / {Math.max(1, Math.ceil((pendingData?.total || 0) / 25))} ·{" "}
              {pendingData?.total ?? 0} rows
            </span>
            <div className="flex gap-2">
              <button
                type="button"
                className="rounded border px-2 py-0.5 disabled:opacity-40"
                disabled={pendPage <= 1}
                onClick={() => setPendPage((p) => p - 1)}
              >
                Prev
              </button>
              <button
                type="button"
                className="rounded border px-2 py-0.5 disabled:opacity-40"
                disabled={pendPage >= Math.max(1, Math.ceil((pendingData?.total || 0) / 25))}
                onClick={() => setPendPage((p) => p + 1)}
              >
                Next
              </button>
            </div>
          </div>
        </section>
      )}

      <Modal
        open={!!detailId}
        onClose={() => setDetailId(null)}
        title={detail?.poNumber ? `Purchase order ${detail.poNumber}` : "Purchase order"}
        document
      >
        {!detail ? (
          <p className="text-sm text-gray-500">Loading…</p>
        ) : (
          <div className="space-y-5 text-sm text-gray-800">
            {detail.sourceOrderAllocationId ? (
              <div className="rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-xs text-sky-950">
                <div className="font-semibold">
                  Source: Order Allocation {detail.sourceOrderAllocationNumber || "—"}
                </div>
                <div>Customer: {detail.sourceCustomerName || "—"}</div>
                <div>OA: {detail.sourceOANumber || "—"} · Quotation: {detail.sourceQuotationNumber || "—"}</div>
              </div>
            ) : null}
            <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm sm:p-5">
              <div className="flex flex-wrap items-start justify-between gap-4 border-b border-gray-100 pb-4">
                <div>
                  <div className="text-[10px] font-bold uppercase tracking-wider text-gray-500">
                    Purchase order
                  </div>
                  <div className="mt-1 font-mono text-xl font-bold text-gray-900">{detail.poNumber}</div>
                  <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                    <StatusBadge status={detail.status} />
                    <span className="text-gray-400">·</span>
                    <span className="text-gray-600">{formatPoDate(detail.orderDate)}</span>
                    <span className="text-gray-400">·</span>
                    <span className="font-semibold tabular-nums text-gray-900">
                      {detail.currency} {Number(detail.grandTotal || 0).toFixed(2)}
                    </span>
                  </div>
                </div>
              </div>

              <div className="mt-4 grid gap-6 md:grid-cols-2">
                <div className="rounded-lg border border-gray-100 bg-gray-50/80 p-3">
                  <div className="text-[10px] font-bold uppercase text-gray-500">Buyer</div>
                  <div className="mt-1 font-semibold text-gray-900">{detail.buyerLegalName || "—"}</div>
                  <div className="mt-1 whitespace-pre-line text-xs leading-relaxed text-gray-600">
                    {detail.buyerAddressLine || "—"}
                  </div>
                  <div className="mt-2 space-y-0.5 text-xs text-gray-600">
                    <div>Tel: {detail.buyerPhone || "—"}</div>
                    <div>{detail.buyerEmail || "—"}</div>
                    <div>{detail.buyerWeb || ""}</div>
                    {detail.buyerTrnNo ? <div>TRN: {detail.buyerTrnNo}</div> : null}
                  </div>
                </div>
                <div className="rounded-lg border border-gray-100 bg-gray-50/80 p-3">
                  <div className="text-[10px] font-bold uppercase text-gray-500">Supplier</div>
                  <div className="mt-1 font-semibold text-gray-900">{detail.supplierName}</div>
                  {detail.supplierAddress ? (
                    <div className="mt-1 whitespace-pre-line text-xs leading-relaxed text-gray-600">
                      {detail.supplierAddress}
                    </div>
                  ) : null}
                  <div className="mt-2 space-y-0.5 text-xs text-gray-600">
                    {detail.supplierPhone ? <div>Tel: {detail.supplierPhone}</div> : null}
                    {detail.supplierEmail ? <div>{detail.supplierEmail}</div> : null}
                  </div>
                </div>
              </div>

              <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {[
                  ["Ref", detail.ref],
                  ["Int. ref", detail.intRef],
                  ["Contact person", detail.contactPerson],
                  ["Supplier reference", detail.supplierReference],
                  ["Offer date", detail.offerDate],
                  ["Currency", detail.currency],
                ].map(([lab, val]) => (
                  <div key={lab} className="text-xs">
                    <div className="font-semibold uppercase tracking-wide text-gray-500">{lab}</div>
                    <div className="mt-0.5 text-gray-900">{val ? String(val) : "—"}</div>
                  </div>
                ))}
              </div>

              {detail.remarks ? (
                <div className="mt-4 rounded-lg border border-dashed border-gray-200 bg-white p-3 text-xs">
                  <span className="font-semibold text-gray-500">Remarks: </span>
                  {detail.remarks}
                </div>
              ) : null}
            </div>

            <div className="overflow-x-auto rounded-xl border border-gray-200">
              <table className="min-w-[1000px] w-full border-collapse text-xs">
                <thead>
                  <tr className="border-b border-gray-200 bg-gray-100 text-left">
                    <th className="px-2 py-2 font-bold text-gray-700">Pos</th>
                    <th className="px-2 py-2 font-bold text-gray-700">Article Nr.</th>
                    <th className="px-2 py-2 font-bold text-gray-700">Description</th>
                    <th className="px-2 py-2 font-bold text-gray-700">Part Nr.</th>
                    <th className="px-2 py-2 font-bold text-gray-700">Supplier Part No.</th>
                    <th className="px-2 py-2 font-bold text-gray-700">Material Code</th>
                    <th className="px-2 py-2 text-right font-bold text-gray-700">Qty</th>
                    <th className="px-2 py-2 font-bold text-gray-700">UOM</th>
                    <th className="px-2 py-2 text-right font-bold text-gray-700">Unit rate</th>
                    <th className="px-2 py-2 text-right font-bold text-gray-700">Total</th>
                    <th className="px-2 py-2 text-right font-bold text-gray-700">Rcvd</th>
                    <th className="px-2 py-2 font-bold text-gray-700">Lead time</th>
                    <th className="px-2 py-2 font-bold text-gray-700">Remark</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.lines?.map((l, i) => (
                    <tr key={l._id} className="border-b border-gray-100">
                      <td className="px-2 py-2 text-gray-500">{i + 1}</td>
                      <td className="px-2 py-2 font-mono text-[11px]">{l.articleNo || l.itemCode}</td>
                      <td className="px-2 py-2">{l.description || "—"}</td>
                      <td className="px-2 py-2 font-mono text-[11px]">{l.partNo || l.partNumber || "—"}</td>
                      <td className="px-2 py-2 font-mono text-[11px]">{l.supplierPartNumber || "—"}</td>
                      <td className="px-2 py-2 font-mono text-[11px]">{l.materialCode || l.itemCode || "—"}</td>
                      <td className="px-2 py-2 text-right tabular-nums">{l.qty}</td>
                      <td className="px-2 py-2">{l.uom || "PCS"}</td>
                      <td className="px-2 py-2 text-right tabular-nums">
                        {Number(l.unitPrice || 0).toFixed(2)}
                      </td>
                      <td className="px-2 py-2 text-right tabular-nums font-medium">
                        {Number(l.lineTotal || 0).toFixed(2)}
                      </td>
                      <td className="px-2 py-2 text-right tabular-nums text-gray-600">
                        {l.receivedQty ?? 0}
                      </td>
                      <td className="px-2 py-2 text-gray-700">{l.leadTime || "—"}</td>
                      <td className="px-2 py-2 text-gray-600">{l.remarks || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {[
                ["Delivery", detail.delivery],
                ["Insurance", detail.insurance],
                ["Packing", detail.packing],
                ["Freight", detail.freight],
                ["Taxes", detail.taxes],
                ["Payment Terms", resolvePoPaymentTerms(detail)],
              ].map(([k, v]) => (
                <div key={k} className="rounded-lg border border-gray-100 p-3 text-xs">
                  <div className="font-bold uppercase text-gray-500">{k}</div>
                  <div className="mt-1 text-gray-800">{v || "—"}</div>
                </div>
              ))}
            </div>

            <div className="flex flex-col items-end gap-1 border-t border-gray-100 pt-4 text-sm">
              {(() => {
                const t = calcPoTotalsFromDoc(detail);
                return (
                  <>
                    <div className="flex w-full max-w-xs justify-between tabular-nums">
                      <span className="text-gray-500">Line items subtotal</span>
                      <span className="font-medium">{detail.currency} {t.subTotal.toFixed(2)}</span>
                    </div>
                    {listVisiblePoTotalRows(detail).rows.map((row, idx) => (
                      <div
                        key={`${row.type}-${row.label}-${idx}`}
                        className="flex w-full max-w-xs justify-between tabular-nums text-gray-600"
                      >
                        <span>{row.label}</span>
                        <span>
                          {detail.currency} {row.amount.toFixed(2)}
                        </span>
                      </div>
                    ))}
                    <div className="flex w-full max-w-xs justify-between border-t border-gray-200 pt-1 text-base font-bold tabular-nums">
                      <span>Grand total</span>
                      <span>{detail.currency} {t.grandTotal.toFixed(2)}</span>
                    </div>
                  </>
                );
              })()}
            </div>

                        <div className="rounded-lg border border-gray-100 bg-amber-50/30 p-3 text-xs">
              <div className="font-bold uppercase text-gray-600">Special remarks</div>
              <div className="mt-1 whitespace-pre-wrap text-gray-800">
                {detail.specialRemarks != null && detail.specialRemarks !== ""
                  ? detail.specialRemarks
                  : "—"}
              </div>
            </div>

            <div>
              <div className="text-[10px] font-bold uppercase text-gray-500">Terms &amp; conditions</div>
              <div className="mt-2 max-h-48 overflow-y-auto rounded-lg border border-gray-100 bg-gray-50 p-3 text-xs leading-relaxed text-gray-700 whitespace-pre-wrap">
                {detail.termsAndConditions?.trim()
                  ? detail.termsAndConditions
                  : "No terms text stored on this PO (older records may predate this field)."}
              </div>
            </div>

            <div className="rounded-lg border border-gray-200 bg-white p-3 text-xs italic text-gray-600">
              {detail.closingNote || DEFAULT_CLOSING_NOTE}
            </div>

            <PoAccountsPanel detail={detail} detailId={detailId} qc={qc} setErr={setErr} />

            <div className="rounded-xl border border-gray-200 bg-white p-4">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <div>
                  <div className="text-[10px] font-bold uppercase tracking-wider text-gray-500">
                    Advance Shipment Notifications
                  </div>
                  <div className="text-xs text-gray-500">Logistics documents only — ASN does not post stock.</div>
                </div>
                {can("ASN", "create") && !["CANCELLED", "REJECTED"].includes(String(detail.status || "").toUpperCase()) ? (
                  <button
                    type="button"
                    className="rounded-lg bg-gray-900 px-4 py-2 text-sm font-semibold text-white"
                    onClick={() => nav(`/asn/new?poId=${detail._id}`)}
                  >
                    Create ASN
                  </button>
                ) : null}
              </div>
              {(detail._asns || []).length ? (
                <ul className="space-y-2 text-sm">
                  {(detail._asns || []).map((asn) => (
                    <li key={asn._id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-gray-100 px-3 py-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <button type="button" className="font-mono font-semibold text-sky-800" onClick={() => nav(`/asn/${asn._id}`)}>
                          {asn.asnNo}
                        </button>
                        <AsnStatusBadge status={asn.status} />
                        <span className="tabular-nums">{asn.qty} {asn.uom || "PCS"}</span>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-xs text-gray-500">No ASNs for this purchase order yet.</p>
              )}
              {detail.lines?.length ? (
                <div className="mt-3 overflow-x-auto">
                  <table className="min-w-[520px] w-full text-xs">
                    <thead className="bg-gray-50 text-left text-gray-500">
                      <tr>
                        <th className="px-2 py-1">Article</th>
                        <th className="px-2 py-1">PO qty</th>
                        <th className="px-2 py-1">ASN active qty</th>
                        <th className="px-2 py-1">Remaining to ASN</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detail.lines.map((line) => {
                        const poQty = Number(line.qty || line.orderedQty || 0);
                        const active = (detail._asns || [])
                          .filter((a) => String(a.status || "").toUpperCase() !== "CANCELLED")
                          .reduce(
                            (sum, a) =>
                              sum +
                              (a.lines || [])
                                .filter((l) => String(l.poLineId) === String(line._id))
                                .reduce((s, l) => s + (Number(l.asnQty) || 0), 0),
                            0
                          );
                        return (
                          <tr key={String(line._id)} className="border-t border-gray-100">
                            <td className="px-2 py-1 font-mono">{line.article || line.itemCode}</td>
                            <td className="px-2 py-1 tabular-nums">{poQty}</td>
                            <td className="px-2 py-1 tabular-nums">{active}</td>
                            <td className="px-2 py-1 tabular-nums">{Math.max(0, poQty - active)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              ) : null}
            </div>

            <div className="flex flex-wrap gap-2 border-t border-gray-100 pt-4">
              {detail && canModifyPoStatus(detail.status) ? (
                <button
                  type="button"
                  className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-semibold text-gray-800 hover:bg-gray-50"
                  onClick={openModifyFromDetail}
                >
                  Modify
                </button>
              ) : null}
              {detail && String(detail.status || "").toUpperCase() !== "CANCELLED" ? (
                <button
                  type="button"
                  title="Create a new draft PO copied from this order"
                  className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-semibold text-gray-800 hover:bg-gray-50 disabled:opacity-50"
                  disabled={duplicatePoMutation.isPending}
                  onClick={() => duplicatePoMutation.mutate(detail._id)}
                >
                  {duplicatePoMutation.isPending ? "Duplicating…" : "Duplicate"}
                </button>
              ) : null}
              {detail && canModifyPoStatus(detail.status) && canDeletePurchaseOrderRole(auth?.user?.role) ? (
                <button
                  type="button"
                  className="rounded-lg border border-red-200 bg-white px-4 py-2 text-sm font-semibold text-red-700 hover:bg-red-50 disabled:opacity-50"
                  disabled={deletePoMutation.isPending}
                  onClick={confirmDeleteDetail}
                >
                  Delete
                </button>
              ) : null}
              <button
                type="button"
                className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-semibold text-gray-800 hover:bg-gray-50"
                onClick={() => setPoPreview({ unsaved: false, doc: detail })}
              >
                View PO copy
              </button>
              <button
                type="button"
                title="Opens print dialog — choose Save as PDF"
                className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-semibold text-gray-800 hover:bg-gray-50"
                onClick={() => openPurchaseOrderDocumentWindow(detail, auth?.company, { exportPdf: true })}
              >
                Download PO (PDF)
              </button>
              <button
                type="button"
                className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-semibold text-gray-800 hover:bg-gray-50"
                onClick={() => exportPurchaseOrderLinesCsv(detail, `po-${detail.poNumber || detail._id}-lines`)}
              >
                Export lines CSV
              </button>
              <button
                type="button"
                className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-semibold text-gray-800 hover:bg-gray-50"
                onClick={() =>
                  exportPurchaseOrderLinesPdf(detail, `po-${detail.poNumber || detail._id}-lines`)
                }
              >
                Export lines PDF
              </button>
              <button
                type="button"
                className="rounded-lg bg-gray-900 px-4 py-2 text-sm font-semibold text-white"
                onClick={openReceive}
              >
                Receive stock
              </button>
              {detail.status === "DRAFT" && (
                <>
                  <button
                    type="button"
                    className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-semibold"
                    onClick={async () => {
                      setErr("");
                      apiPatch(`/purchase-orders/${detail._id}/status`, { status: "SAVED" })
                        .then(() => {
                          qc.invalidateQueries({ queryKey: ["purchaseOrder", detailId] });
                          qc.invalidateQueries({ queryKey: ["purchaseOrders"] });
                          qc.invalidateQueries({ queryKey: ["purchaseSummary"] });
                        })
                        .catch((e) => setErr(e.message));
                    }}
                  >
                    Mark saved
                  </button>
                  <button
                    type="button"
                    className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-semibold"
                    onClick={async () => {
                      setErr("");
                      apiPatch(`/purchase-orders/${detail._id}/status`, { status: "SENT" })
                        .then(() => {
                          qc.invalidateQueries({ queryKey: ["purchaseOrder", detailId] });
                          qc.invalidateQueries({ queryKey: ["purchaseOrders"] });
                          qc.invalidateQueries({ queryKey: ["purchaseSummary"] });
                        })
                        .catch((e) => setErr(e.message));
                    }}
                  >
                    Mark sent
                  </button>
                </>
              )}
            </div>
          </div>
        )}
      </Modal>

      <Modal open={receiveOpen} onClose={() => setReceiveOpen(false)} title="Goods receipt" wide>
        <FormField label="Warehouse">
          <TextInput
            value={receiveWarehouse}
            onChange={(e) => setReceiveWarehouse(e.target.value)}
          />
        </FormField>
        <div className="mt-3 max-h-64 space-y-2 overflow-y-auto">
          {receiveLines.map((rl, i) => (
            <div key={rl.lineId} className="flex flex-wrap items-center gap-2 text-sm">
              <span className="w-28 font-mono text-xs">{rl.itemCode}</span>
              <span className="text-gray-500">max {rl.max}</span>
              <TextInput
                className="w-24"
                type="number"
                value={rl.qty}
                onChange={(e) => {
                  const next = [...receiveLines];
                  next[i] = { ...next[i], qty: Number(e.target.value) };
                  setReceiveLines(next);
                }}
              />
            </div>
          ))}
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            className="rounded-xl border px-4 py-2 text-sm"
            onClick={() => setReceiveOpen(false)}
          >
            Cancel
          </button>
          <button
            type="button"
            className="rounded-xl bg-gray-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
            disabled={receiveMutation.isPending}
            onClick={async () => {
              setErr("");
              receiveMutation.mutate({
                warehouse: receiveWarehouse,
                lines: receiveLines
                  .filter((l) => l.qty > 0)
                  .map((l) => ({ lineId: l.lineId, qty: l.qty })),
              });
            }}
          >
            {receiveMutation.isPending ? "Posting…" : "Post receipt"}
          </button>
        </div>
      </Modal>

      <Modal
        open={createOpen}
        onClose={() => {
          setCreateOpen(false);
          setEditPoId(null);
          setErr("");
          createMutation.reset();
          updatePoMutation.reset();
        }}
        title={editPoId ? "Modify purchase order" : "New purchase order"}
        document
      >
        {err ? <div className="mb-3 text-sm text-red-600">{err}</div> : null}
        {form.sourceOrderAllocationId ? (
          <div className="mb-3 rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-xs text-sky-950">
            <div className="font-semibold">Source: Order Allocation {form.sourceOrderAllocationNumber || "—"}</div>
            <div>Customer: {form.sourceCustomerName || "—"}</div>
            <div>OA: {form.sourceOANumber || "—"} · Quotation: {form.sourceQuotationNumber || "—"}</div>
            <div className="mt-1 text-sky-800">
              Preloaded lines are suggestions only. Remove or edit before saving. Only saved linked quantities count
              toward the allocation balance.
            </div>
          </div>
        ) : null}
        <div className="rounded-xl border border-gray-200 bg-white p-3 shadow-sm sm:p-5">
          <p className="text-[10px] font-bold uppercase tracking-wider text-gray-500">
            {editPoId
              ? "Editing draft or saved PO — click Save changes when done."
              : "Document preview — saved as draft PO"}
          </p>

          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <div className="rounded-lg border border-gray-100 bg-gray-50/90 p-3">
              <div className="text-[10px] font-bold uppercase text-gray-500">Buyer</div>
              {!String(form.buyerLegalName || "").trim() ? (
                <p className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-2 py-1.5 text-xs text-amber-900">
                  Buyer company details are not configured for the selected company. Update Company master or fill in
                  manually.
                </p>
              ) : null}
              <FormField label="Legal name">
                <TextInput
                  value={form.buyerLegalName}
                  onChange={(e) => setForm((f) => ({ ...f, buyerLegalName: e.target.value }))}
                />
              </FormField>
              <FormField label="Address" className="mt-2">
                <textarea
                  rows={2}
                  className="w-full rounded-xl border border-gray-200 px-3 py-2 text-sm focus:border-gray-900 focus:outline-none focus:ring-1 focus:ring-gray-900"
                  value={form.buyerAddressLine}
                  onChange={(e) => setForm((f) => ({ ...f, buyerAddressLine: e.target.value }))}
                />
              </FormField>
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                <FormField label="Phone">
                  <TextInput
                    value={form.buyerPhone}
                    onChange={(e) => setForm((f) => ({ ...f, buyerPhone: e.target.value }))}
                  />
                </FormField>
                <FormField label="Email">
                  <TextInput
                    value={form.buyerEmail}
                    onChange={(e) => setForm((f) => ({ ...f, buyerEmail: e.target.value }))}
                  />
                </FormField>
                <FormField label="Web" className="sm:col-span-2">
                  <TextInput
                    value={form.buyerWeb}
                    onChange={(e) => setForm((f) => ({ ...f, buyerWeb: e.target.value }))}
                  />
                </FormField>
                <FormField label="TRN / VAT (buyer)" className="sm:col-span-2">
                  <TextInput
                    value={form.buyerTrnNo || ""}
                    onChange={(e) => setForm((f) => ({ ...f, buyerTrnNo: e.target.value }))}
                  />
                </FormField>
              </div>
            </div>
            <div className="rounded-lg border border-gray-100 bg-gray-50/90 p-3">
              <div className="text-[10px] font-bold uppercase text-gray-500">Supplier</div>
              <FormField label="Supplier name *">
                <TextInput
                  list="supplier-pick-po"
                  autoComplete="off"
                  value={form.supplierName}
                  onChange={(e) => setForm((f) => ({ ...f, supplierName: e.target.value }))}
                  onBlur={(e) => applySupplierMasterDefaults(e.target.value)}
                  placeholder="Type or pick from Supplier Master"
                />
                <datalist id="supplier-pick-po">
                  {(suppliersAll?.items ?? [])
                    .filter((s) => s.activeStatus !== false && supplierMasterDisplayName(s))
                    .map((s) => (
                      <option key={s._id} value={supplierMasterDisplayName(s)} />
                    ))}
                </datalist>
                <p className="mt-1 text-xs text-gray-500">
                  List is loaded from Supplier Master for your active company (Marivolt / Okeanos).
                </p>
              </FormField>
              <FormField label="Address" className="mt-2">
                <textarea
                  rows={2}
                  className="w-full rounded-xl border border-gray-200 px-3 py-2 text-sm focus:border-gray-900 focus:outline-none focus:ring-1 focus:ring-gray-900"
                  value={form.supplierAddress}
                  onChange={(e) => setForm((f) => ({ ...f, supplierAddress: e.target.value }))}
                />
              </FormField>
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                <FormField label="Phone">
                  <TextInput
                    value={form.supplierPhone}
                    onChange={(e) => setForm((f) => ({ ...f, supplierPhone: e.target.value }))}
                  />
                </FormField>
                <FormField label="Email">
                  <TextInput
                    value={form.supplierEmail}
                    onChange={(e) => setForm((f) => ({ ...f, supplierEmail: e.target.value }))}
                  />
                </FormField>
              </div>
            </div>
          </div>

          <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <FormField label="Ref">
              <TextInput value={form.ref} onChange={(e) => setForm((f) => ({ ...f, ref: e.target.value }))} />
            </FormField>
            <FormField label="Int. ref">
              <TextInput
                value={form.intRef}
                onChange={(e) => setForm((f) => ({ ...f, intRef: e.target.value }))}
              />
            </FormField>
            <FormField label="Contact person">
              <TextInput
                value={form.contactPerson}
                onChange={(e) => setForm((f) => ({ ...f, contactPerson: e.target.value }))}
              />
            </FormField>
            <FormField label="Supplier reference">
              <TextInput
                value={form.supplierReference}
                onChange={(e) => setForm((f) => ({ ...f, supplierReference: e.target.value }))}
              />
            </FormField>
            <FormField label="Offer date">
              <TextInput
                value={form.offerDate}
                onChange={(e) => setForm((f) => ({ ...f, offerDate: e.target.value }))}
                placeholder="e.g. 12-Feb-26"
              />
            </FormField>
            <FormField label="PO date">
              <TextInput
                type="date"
                value={form.orderDate}
                onChange={(e) => setForm((f) => ({ ...f, orderDate: e.target.value }))}
              />
            </FormField>
            <FormField label="Currency">
              <TextInput
                value={form.currency}
                onChange={(e) => setForm((f) => ({ ...f, currency: e.target.value }))}
              />
            </FormField>
            <FormField label="Header remarks">
              <TextInput
                value={form.remarks}
                onChange={(e) => setForm((f) => ({ ...f, remarks: e.target.value }))}
                placeholder="Optional notes on the PO"
              />
            </FormField>
          </div>

          <div className="mt-4 rounded-lg border border-gray-100 bg-gray-50/90 p-3">
            <div className="mb-2 flex flex-wrap items-center gap-3">
              <span className="text-[10px] font-bold uppercase text-gray-500">Machine Details</span>
              <label className="flex cursor-pointer items-center gap-2 text-xs text-gray-700">
                <input
                  type="checkbox"
                  className="rounded border-gray-300"
                  checked={!!form.showMachineDetailsOnPrint}
                  onChange={(e) => setForm((f) => ({ ...f, showMachineDetailsOnPrint: e.target.checked }))}
                />
                Show machine details on PO print / PDF
              </label>
            </div>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
              <FormField label="Vertical">
                <TextInput value={form.vertical} onChange={(e) => setForm((f) => ({ ...f, vertical: e.target.value }))} />
              </FormField>
              <FormField label="Brand">
                <TextInput
                  value={form.brand}
                  onChange={(e) => setForm((f) => ({ ...f, brand: e.target.value, engine: e.target.value }))}
                />
              </FormField>
              <FormField label="Model">
                <TextInput value={form.model} onChange={(e) => setForm((f) => ({ ...f, model: e.target.value }))} />
              </FormField>
              <FormField label="Config">
                <TextInput value={form.config} onChange={(e) => setForm((f) => ({ ...f, config: e.target.value }))} />
              </FormField>
              <FormField label="ESN">
                <TextInput value={form.esn} onChange={(e) => setForm((f) => ({ ...f, esn: e.target.value }))} />
              </FormField>
              <FormField label="Currency">
                <TextInput value={form.currency} onChange={(e) => setForm((f) => ({ ...f, currency: e.target.value }))} />
              </FormField>
            </div>
          </div>

          <div className="mt-5">
            <input
              ref={poLineCsvImportRef}
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              onChange={onPoLinesCsvFile}
            />
            <div className="mb-2 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex flex-wrap items-center gap-3">
                <span className="text-xs font-bold uppercase tracking-wide text-gray-600">Line items</span>
                <label className="flex cursor-pointer items-center gap-2 text-xs text-gray-700">
                  <input
                    type="checkbox"
                    className="rounded border-gray-300"
                    checked={!!form.showMaterialCodeOnPrint}
                    onChange={(e) => setForm((f) => ({ ...f, showMaterialCodeOnPrint: e.target.checked }))}
                  />
                  Show material code on PO print / PDF
                </label>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  className="rounded-lg border border-gray-300 bg-white px-2.5 py-1.5 text-xs font-semibold text-gray-800 hover:bg-gray-50"
                  onClick={() => poLineCsvImportRef.current?.click()}
                >
                  Import lines (CSV)
                </button>
                <button
                  type="button"
                  className="rounded-lg border border-gray-300 bg-white px-2.5 py-1.5 text-xs font-semibold text-gray-800 hover:bg-gray-50"
                  onClick={async () => {
                    setPoPreview({ unsaved: !editPoId, doc: draftDocSnapshotForExport() });
                  }}
                >
                  View PO copy
                </button>
                <button
                  type="button"
                  title="Opens print dialog — choose Save as PDF"
                  className="rounded-lg border border-gray-300 bg-white px-2.5 py-1.5 text-xs font-semibold text-gray-800 hover:bg-gray-50"
                  onClick={() =>
                    openPurchaseOrderDocumentWindow(draftDocSnapshotForExport(), auth?.company, { exportPdf: true })
                  }
                >
                  Download PO (PDF)
                </button>
                <button
                  type="button"
                  className="rounded-lg border border-gray-300 bg-white px-2.5 py-1.5 text-xs font-semibold text-gray-800 hover:bg-gray-50"
                  onClick={() => exportPurchaseOrderLinesCsv(draftDocSnapshotForExport(), "po-draft-lines")}
                >
                  Export lines CSV
                </button>
                <button
                  type="button"
                  className="rounded-lg border border-gray-300 bg-white px-2.5 py-1.5 text-xs font-semibold text-gray-800 hover:bg-gray-50"
                  onClick={() =>
                    exportPurchaseOrderLinesPdf(draftDocSnapshotForExport(), "po-draft-lines")
                  }
                >
                  Export lines PDF
                </button>
                <button
                  type="button"
                  className="text-xs font-semibold text-gray-800 underline"
                  onClick={() => setForm((f) => ({ ...f, lines: [...f.lines, defaultLine()] }))}
                >
                  + Add line
                </button>
              </div>
            </div>
            <p className="mb-2 text-[10px] text-gray-500">
              CSV columns (first row headers): Article Nr., Description, Part Nr., Supplier Part Number, Material Code,
              Qty, UOM, Unit rate, Remarks, Lead time. Rows append to the grid; a blank first line is replaced when importing.
            </p>
            <div className="overflow-x-auto rounded-lg border border-gray-200">
              <table className="min-w-[1280px] w-full border-collapse text-xs">
                <thead>
                  <tr className="border-b border-gray-200 bg-gray-100 text-left">
                    <th className="px-1.5 py-2 font-bold text-gray-700">Pos</th>
                    <th className="px-1.5 py-2 font-bold text-gray-700">Article Nr.</th>
                    <th className="min-w-[120px] px-1.5 py-2 font-bold text-gray-700">Description</th>
                    <th className="px-1.5 py-2 font-bold text-gray-700">Part Nr.</th>
                    <th className="px-1.5 py-2 font-bold text-gray-700">Supplier Part No.</th>
                    <th className="px-1.5 py-2 font-bold text-gray-700">Material Code</th>
                    <th className="px-1.5 py-2 font-bold text-gray-700">Qty</th>
                    <th className="px-1.5 py-2 font-bold text-gray-700">UOM</th>
                    <th className="px-1.5 py-2 font-bold text-gray-700">Unit rate</th>
                    <th className="px-1.5 py-2 text-right font-bold text-gray-700">Total</th>
                    <th className="min-w-[72px] px-1.5 py-2 font-bold text-gray-700">Lead time</th>
                    <th className="min-w-[72px] px-1.5 py-2 font-bold text-gray-700">Remark</th>
                    <th className="w-8 px-1 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {form.lines.map((line, idx) => {
                    const lineTot = (Number(line.qty) || 0) * (Number(line.unitPrice) || 0);
                    const setLine = (patch) => {
                      const lines = [...form.lines];
                      lines[idx] = { ...lines[idx], ...patch };
                      setForm((f) => ({ ...f, lines }));
                    };
                    return (
                      <tr key={idx} className="border-b border-gray-100 align-top">
                        <td className="px-1.5 py-1.5 text-gray-500">{idx + 1}</td>
                        <td className="px-1.5 py-1.5">
                          <TextInput
                            className="py-1.5 text-[11px]"
                            placeholder="Article"
                            value={line.articleNo}
                            onChange={(e) => setLine({ articleNo: e.target.value })}
                          />
                        </td>
                        <td className="px-1.5 py-1.5">
                          <TextInput
                            className="py-1.5 text-[11px]"
                            placeholder="Description"
                            value={line.description}
                            onChange={(e) => setLine({ description: e.target.value })}
                          />
                        </td>
                        <td className="px-1.5 py-1.5">
                          <TextInput
                            className="py-1.5 text-[11px]"
                            placeholder="Internal part / SPN"
                            value={line.partNo}
                            onChange={(e) =>
                              setLine({ partNo: e.target.value, partNumber: e.target.value.toUpperCase() })
                            }
                          />
                        </td>
                        <td className="px-1.5 py-1.5">
                          <TextInput
                            className="py-1.5 text-[11px]"
                            placeholder="Supplier part"
                            value={line.supplierPartNumber ?? ""}
                            onChange={(e) => setLine({ supplierPartNumber: e.target.value })}
                          />
                        </td>
                        <td className="px-1.5 py-1.5">
                          <TextInput
                            className="py-1.5 text-[11px] font-mono"
                            placeholder="Material code"
                            value={line.materialCode ?? ""}
                            onChange={(e) => setLine({ materialCode: e.target.value.toUpperCase() })}
                          />
                        </td>
                        <td className="px-1.5 py-1.5">
                          <TextInput
                            className="py-1.5 text-[11px]"
                            type="number"
                            min={0}
                            value={line.qty}
                            onChange={(e) => {
                              const next = Number(e.target.value);
                              const qty = Number.isFinite(next) && next > 0 ? next : 0;
                              setLine({ qty, orderedQty: qty });
                            }}
                          />
                        </td>
                        <td className="px-1.5 py-1.5">
                          <TextInput
                            className="py-1.5 text-[11px]"
                            value={line.uom}
                            onChange={(e) => setLine({ uom: e.target.value })}
                          />
                        </td>
                        <td className="px-1.5 py-1.5">
                          <TextInput
                            className="py-1.5 text-[11px]"
                            type="number"
                            step="0.01"
                            min={0}
                            value={line.unitPrice}
                            onChange={(e) => setLine({ unitPrice: Number(e.target.value) })}
                          />
                        </td>
                        <td className="px-1.5 py-1.5 text-right tabular-nums font-medium text-gray-800">
                          {lineTot.toFixed(2)}
                        </td>
                        <td className="px-1.5 py-1.5">
                          <TextInput
                            className="py-1.5 text-[11px]"
                            placeholder="e.g. 2 wks"
                            value={line.leadTime ?? ""}
                            onChange={(e) => setLine({ leadTime: e.target.value })}
                          />
                        </td>
                        <td className="px-1.5 py-1.5">
                          <TextInput
                            className="py-1.5 text-[11px]"
                            value={line.remarks}
                            onChange={(e) => setLine({ remarks: e.target.value })}
                          />
                        </td>
                        <td className="px-0.5 py-1.5">
                          <button
                            type="button"
                            className="rounded border border-gray-200 px-1.5 py-0.5 text-gray-500 hover:bg-gray-50 disabled:opacity-30"
                            disabled={form.lines.length <= 1}
                            title="Remove line"
                            onClick={() =>
                              setForm((f) => ({
                                ...f,
                                lines: f.lines.filter((_, i) => i !== idx),
                              }))
                            }
                          >
                            ×
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="mt-1 text-[10px] text-gray-500">
              Inventory uses Article Nr., internal code, or Part Nr. (at least one required per line).
            </p>
          </div>

          <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <FormField label="Delivery">
              <TextInput
                value={form.delivery}
                onChange={(e) => setForm((f) => ({ ...f, delivery: e.target.value }))}
              />
            </FormField>
            <FormField label="Insurance">
              <TextInput
                value={form.insurance}
                onChange={(e) => setForm((f) => ({ ...f, insurance: e.target.value }))}
              />
            </FormField>
            <FormField label="Packing">
              <TextInput
                value={form.packing}
                onChange={(e) => setForm((f) => ({ ...f, packing: e.target.value }))}
              />
            </FormField>
            <FormField label="Freight">
              <TextInput
                value={form.freight}
                onChange={(e) => setForm((f) => ({ ...f, freight: e.target.value }))}
              />
            </FormField>
            <FormField label="Taxes">
              <TextInput
                value={form.taxes}
                onChange={(e) => setForm((f) => ({ ...f, taxes: e.target.value }))}
              />
            </FormField>
            <FormField label="Payment Terms">
              <TextInput
                value={form.payment}
                onChange={(e) => setForm((f) => ({ ...f, payment: e.target.value }))}
                placeholder="Auto-filled from Supplier Master; editable override"
              />
            </FormField>
          </div>

          <div className="mt-4 flex flex-col items-end gap-1 border-t border-gray-100 pt-4 text-sm">
            <div className="flex w-full max-w-xs justify-between tabular-nums">
              <span className="text-gray-500">Line items subtotal</span>
              <span className="font-medium">
                {form.currency} {poPreviewTotals.subTotal.toFixed(2)}
              </span>
            </div>
            <PoAdjustmentsEditor
              adjustments={form.adjustments || []}
              currency={form.currency}
              subTotal={poPreviewTotals.subTotal}
              onChange={(adjustments) => setForm((f) => ({ ...f, adjustments }))}
            />
            <div className="flex w-full max-w-xs justify-between border-t border-gray-200 pt-1 text-base font-bold tabular-nums">
              <span>Grand total</span>
              <span>{form.currency} {poPreviewTotals.grandTotal.toFixed(2)}</span>
            </div>
          </div>

                    <FormField label="Special remarks" className="mt-4">
            <TextInput
              value={form.specialRemarks}
              onChange={(e) => setForm((f) => ({ ...f, specialRemarks: e.target.value }))}
            />
          </FormField>

          <FormField label="Terms & conditions" className="mt-3">
            <textarea
              rows={8}
              className="w-full rounded-xl border border-gray-200 px-3 py-2 text-xs leading-relaxed focus:border-gray-900 focus:outline-none focus:ring-1 focus:ring-gray-900"
              value={form.termsAndConditions}
              onChange={(e) => setForm((f) => ({ ...f, termsAndConditions: e.target.value }))}
            />
          </FormField>

          <FormField label="Closing note" className="mt-3">
            <textarea
              rows={2}
              className="w-full rounded-xl border border-gray-200 px-3 py-2 text-sm italic focus:border-gray-900 focus:outline-none focus:ring-1 focus:ring-gray-900"
              value={form.closingNote}
              onChange={(e) => setForm((f) => ({ ...f, closingNote: e.target.value }))}
            />
          </FormField>
        </div>

        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            className="rounded-xl border px-4 py-2 text-sm"
            onClick={() => setCreateOpen(false)}
          >
            Cancel
          </button>
          <button
            type="button"
            className="rounded-xl bg-gray-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
            disabled={createMutation.isPending || updatePoMutation.isPending}
            onClick={async () => {
              setErr("");
              setNotice("");
              const adjustmentErrors = validatePoAdjustments(form.adjustments || []);
              if (adjustmentErrors.length) {
                setErr(adjustmentErrors[0]);
                return;
              }
              const body = buildPoPayload(form, { includeIncompleteLines: Boolean(editPoId) });
              if (!body.supplierName) {
                setErr("Supplier name is required.");
                return;
              }
              const validFinalLines = body.lines.filter((line) => line.itemCode && Number(line.qty) > 0);
              if (!validFinalLines.length) {
                setErr("Add at least one line with Article Nr., code, or Part Nr. and quantity.");
                return;
              }
              if (editPoId) {
                updatePoMutation.mutate({ id: editPoId, body });
              } else {
                createMutation.mutate(body);
              }
            }}
          >
            {editPoId
              ? updatePoMutation.isPending
                ? "Saving…"
                : "Save changes"
              : createMutation.isPending
                ? "Saving…"
                : "Create"}
          </button>
        </div>
      </Modal>

      <Modal open={!!poPreview} onClose={() => setPoPreview(null)} title="Purchase order preview" document>
        {poPreview ? <PurchaseOrderPreviewPanel doc={poPreview.doc} unsaved={poPreview.unsaved} /> : null}
      </Modal>

      <Modal open={supModal} onClose={() => setSupModal(false)} title={supEditing ? "Edit supplier" : "New supplier"} wide>
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label="Supplier code (optional)">
            <TextInput
              value={supForm.supplierCode}
              onChange={(e) => setSupForm((f) => ({ ...f, supplierCode: e.target.value }))}
            />
          </FormField>
          <FormField label="Name *">
            <TextInput
              value={supForm.name}
              onChange={(e) => setSupForm((f) => ({ ...f, name: e.target.value }))}
            />
          </FormField>
          <FormField label="Contact">
            <TextInput
              value={supForm.contactName}
              onChange={(e) => setSupForm((f) => ({ ...f, contactName: e.target.value }))}
            />
          </FormField>
          <FormField label="Phone">
            <TextInput
              value={supForm.phone}
              onChange={(e) => setSupForm((f) => ({ ...f, phone: e.target.value }))}
            />
          </FormField>
          <FormField label="Email" className="sm:col-span-2">
            <TextInput
              value={supForm.email}
              onChange={(e) => setSupForm((f) => ({ ...f, email: e.target.value }))}
            />
          </FormField>
          <FormField label="Address" className="sm:col-span-2">
            <TextInput
              value={supForm.address}
              onChange={(e) => setSupForm((f) => ({ ...f, address: e.target.value }))}
            />
          </FormField>
          <FormField label="VAT #">
            <TextInput
              value={supForm.vatNo}
              onChange={(e) => setSupForm((f) => ({ ...f, vatNo: e.target.value }))}
            />
          </FormField>
          <FormField label="Trade License / Registration No">
            <TextInput
              value={supForm.tradeLicenseNo}
              onChange={(e) => setSupForm((f) => ({ ...f, tradeLicenseNo: e.target.value }))}
            />
          </FormField>
          <FormField label="Notes" className="sm:col-span-2">
            <TextInput
              value={supForm.notes}
              onChange={(e) => setSupForm((f) => ({ ...f, notes: e.target.value }))}
            />
          </FormField>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" className="rounded-xl border px-4 py-2 text-sm" onClick={() => setSupModal(false)}>
            Cancel
          </button>
          <button
            type="button"
            className="rounded-xl bg-gray-900 px-4 py-2 text-sm font-semibold text-white"
            disabled={saveSupMutation.isPending}
            onClick={() => saveSupMutation.mutate()}
          >
            Save
          </button>
        </div>
      </Modal>

      <Modal open={retOpen} onClose={() => setRetOpen(false)} title="New purchase return" wide>
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label="Supplier *">
            <TextInput
              list="supplier-pick-ret"
              value={retForm.supplierName}
              onChange={(e) => setRetForm((f) => ({ ...f, supplierName: e.target.value }))}
            />
            <datalist id="supplier-pick-ret">
              {(suppliersAll?.items ?? [])
                .filter((s) => s.activeStatus !== false && supplierMasterDisplayName(s))
                .map((s) => (
                  <option key={s._id} value={supplierMasterDisplayName(s)} />
                ))}
            </datalist>
          </FormField>
          <FormField label="Linked PO #">
            <TextInput
              value={retForm.linkedPoNumber}
              onChange={(e) => setRetForm((f) => ({ ...f, linkedPoNumber: e.target.value }))}
            />
          </FormField>
          <FormField label="Warehouse">
            <TextInput
              value={retForm.warehouse}
              onChange={(e) => setRetForm((f) => ({ ...f, warehouse: e.target.value }))}
            />
          </FormField>
          <FormField label="Currency">
            <TextInput
              value={retForm.currency}
              onChange={(e) => setRetForm((f) => ({ ...f, currency: e.target.value }))}
            />
          </FormField>
          <FormField label="Remarks" className="sm:col-span-2">
            <TextInput
              value={retForm.remarks}
              onChange={(e) => setRetForm((f) => ({ ...f, remarks: e.target.value }))}
            />
          </FormField>
        </div>
        <div className="mt-3 space-y-2">
          <div className="flex justify-between">
            <span className="text-sm font-semibold">Lines</span>
            <button
              type="button"
              className="text-sm underline"
              onClick={() =>
                setRetForm((f) => ({ ...f, lines: [...f.lines, defaultPrLine()] }))
              }
            >
              + Line
            </button>
          </div>
          {retForm.lines.map((line, idx) => (
            <div key={idx} className="grid grid-cols-2 gap-2 rounded-lg border p-2 sm:grid-cols-5">
              <TextInput
                placeholder="Item"
                value={line.itemCode}
                onChange={(e) => {
                  const lines = [...retForm.lines];
                  lines[idx] = { ...lines[idx], itemCode: e.target.value };
                  setRetForm((f) => ({ ...f, lines }));
                }}
              />
              <TextInput
                type="number"
                placeholder="Qty"
                value={line.qty}
                onChange={(e) => {
                  const lines = [...retForm.lines];
                  lines[idx] = { ...lines[idx], qty: Number(e.target.value) };
                  setRetForm((f) => ({ ...f, lines }));
                }}
              />
              <TextInput
                type="number"
                step="0.01"
                placeholder="Rate"
                value={line.unitPrice}
                onChange={(e) => {
                  const lines = [...retForm.lines];
                  lines[idx] = { ...lines[idx], unitPrice: Number(e.target.value) };
                  setRetForm((f) => ({ ...f, lines }));
                }}
              />
              <TextInput
                placeholder="Reason"
                className="sm:col-span-2"
                value={line.reason}
                onChange={(e) => {
                  const lines = [...retForm.lines];
                  lines[idx] = { ...lines[idx], reason: e.target.value };
                  setRetForm((f) => ({ ...f, lines }));
                }}
              />
            </div>
          ))}
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" className="rounded-xl border px-4 py-2 text-sm" onClick={() => setRetOpen(false)}>
            Cancel
          </button>
          <button
            type="button"
            className="rounded-xl bg-gray-900 px-4 py-2 text-sm font-semibold text-white"
            disabled={createRetMutation.isPending}
            onClick={async () => {
              setErr("");
              createRetMutation.mutate();
            }}
          >
            Create draft
          </button>
        </div>
      </Modal>

      <Modal open={!!retDetailId} onClose={() => setRetDetailId(null)} title="Purchase return" wide>
        {!retDetail ? (
          <p className="text-sm text-gray-500">Loading…</p>
        ) : (
          <div className="space-y-3 text-sm">
            <div className="flex flex-wrap gap-4 rounded-lg border bg-slate-50 p-3">
              <div>
                <span className="text-xs font-semibold text-gray-500">Return</span>
                <div className="font-mono font-bold">{retDetail.returnNumber}</div>
              </div>
              <div>
                <span className="text-xs font-semibold text-gray-500">Supplier</span>
                <div>{retDetail.supplierName}</div>
              </div>
              <div>
                <StatusBadge status={retDetail.status} />
              </div>
            </div>
            <div className="overflow-x-auto rounded border">
              <table className="min-w-full text-xs">
                <thead className="bg-gray-100">
                  <tr>
                    <th className="px-2 py-1 text-left">Item</th>
                    <th className="px-2 py-1 text-right">Qty</th>
                    <th className="px-2 py-1 text-right">Rate</th>
                  </tr>
                </thead>
                <tbody>
                  {retDetail.lines?.map((l) => (
                    <tr key={l._id} className="border-t">
                      <td className="px-2 py-1 font-mono">{l.itemCode}</td>
                      <td className="px-2 py-1 text-right">{l.qty}</td>
                      <td className="px-2 py-1 text-right">{l.unitPrice}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {retDetail.status === "DRAFT" && (
              <button
                type="button"
                className="rounded-lg bg-gray-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
                disabled={postRetMutation.isPending}
                onClick={async () => {
                  if (await confirmDialog("Post return and deduct stock?")) postRetMutation.mutate(retDetail._id);
                }}
              >
                Post to inventory
              </button>
            )}
          </div>
        )}
      </Modal>

      <PoSupplierDocUploadModal
        open={Boolean(supplierDocUploadPo)}
        onClose={() => setSupplierDocUploadPo(null)}
        poId={supplierDocUploadPo?._id}
        poNumber={supplierDocUploadPo?.poNumber}
        supplierName={supplierDocUploadPo?.supplierName}
        currency={supplierDocUploadPo?.currency}
        qc={qc}
        setErr={setErr}
      />
    </div>
  );
}
