/**
 * Global ERP search — read-only cross-module document lookup.
 * Does not modify business documents or workflows.
 */
import Quotation from "../models/Quotation.js";
import OrderAcknowledgement from "../models/OrderAcknowledgement.js";
import ProformaInvoice from "../models/ProformaInvoice.js";
import SalesInvoice from "../models/SalesInvoice.js";
import OrderAllocation from "../models/OrderAllocation.js";
import SalesDispatch from "../models/SalesDispatch.js";
import Customer from "../models/Customer.js";
import PurchaseOrder from "../models/PurchaseOrder.js";
import Supplier from "../models/Supplier.js";
import GRN from "../models/GRN.js";
import StorePacking from "../models/StorePacking.js";
import StoreDispatch from "../models/StoreDispatch.js";
import CustomsInvoice from "../models/CustomsInvoice.js";
import CustomsLot from "../models/CustomsLot.js";
import CustomsLotItem from "../models/CustomsLotItem.js";
import CustomsMovement from "../models/CustomsMovement.js";
import ItemMaster from "../models/itemMasterModel.js";
import PurchaseInvoice from "../models/PurchaseInvoice.js";
import Document from "../models/Document.js";
import { isCustomsEnabled } from "../config/customsConfig.js";
import { hasPermission } from "./roleService.js";

const PER_SOURCE_LIMIT = 25;
const MERGE_CAP = 500;

export const SEARCH_GROUPS = {
  ITEM_MASTER: "Item Master",
  PURCHASE_ORDERS: "Purchase Orders",
  GRNS: "GRNs",
  CUSTOMS_STOCK: "Customs Stock",
  CUSTOMS_LEDGER: "Customs Ledger",
  CUSTOMS_INVOICES: "Customs Invoices",
  SALES_INVOICES: "Sales Invoices",
  DISPATCHES: "Dispatches",
  OTHER: "Other",
};

const GROUP_DISPLAY_ORDER = [
  SEARCH_GROUPS.SALES_INVOICES,
  SEARCH_GROUPS.CUSTOMS_INVOICES,
  SEARCH_GROUPS.GRNS,
  SEARCH_GROUPS.PURCHASE_ORDERS,
  SEARCH_GROUPS.CUSTOMS_STOCK,
  SEARCH_GROUPS.CUSTOMS_LEDGER,
  SEARCH_GROUPS.ITEM_MASTER,
  SEARCH_GROUPS.DISPATCHES,
  SEARCH_GROUPS.OTHER,
];

export function groupForType(type) {
  const key = String(type || "");
  if (key === "Article") return SEARCH_GROUPS.ITEM_MASTER;
  if (key === "Purchase Order") return SEARCH_GROUPS.PURCHASE_ORDERS;
  if (key === "GRN") return SEARCH_GROUPS.GRNS;
  if (key === "Customs Stock") return SEARCH_GROUPS.CUSTOMS_STOCK;
  if (key === "Customs Ledger") return SEARCH_GROUPS.CUSTOMS_LEDGER;
  if (key === "Customs Invoice") return SEARCH_GROUPS.CUSTOMS_INVOICES;
  if (key === "Sales Invoice") return SEARCH_GROUPS.SALES_INVOICES;
  if (key === "Dispatch" || key === "Sales Dispatch") return SEARCH_GROUPS.DISPATCHES;
  return SEARCH_GROUPS.OTHER;
}

const ARTICLE_PRIORITY_GROUPS = new Set([
  SEARCH_GROUPS.PURCHASE_ORDERS,
  SEARCH_GROUPS.GRNS,
  SEARCH_GROUPS.CUSTOMS_STOCK,
  SEARCH_GROUPS.CUSTOMS_INVOICES,
  SEARCH_GROUPS.SALES_INVOICES,
  SEARCH_GROUPS.ITEM_MASTER,
]);

const CATEGORIES = {
  ALL: "All",
  SALES: "Sales",
  PURCHASE: "Purchase",
  INVENTORY: "Inventory",
  ACCOUNTS: "Accounts",
  CUSTOMS: "Customs",
  DOCUMENTS: "Documents",
};

function t(v) {
  return String(v ?? "").trim();
}

function escapeRegex(s) {
  return t(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildRegex(q) {
  const raw = t(q);
  if (!raw) return null;
  return new RegExp(escapeRegex(raw), "i");
}

function withCompany(companyId, filter = {}) {
  return { ...filter, companyId };
}

function parseFilters(raw = {}) {
  const dateFrom = raw.dateFrom ? new Date(raw.dateFrom) : null;
  const dateTo = raw.dateTo ? new Date(raw.dateTo) : null;
  if (dateTo) dateTo.setHours(23, 59, 59, 999);
  return {
    q: t(raw.q || raw.search),
    category: t(raw.type || raw.category) || CATEGORIES.ALL,
    status: t(raw.status).toUpperCase(),
    dateFrom: dateFrom && !Number.isNaN(dateFrom.getTime()) ? dateFrom : null,
    dateTo: dateTo && !Number.isNaN(dateTo.getTime()) ? dateTo : null,
  };
}

function applyDateStatus(filter, { dateField, statusField, filters }) {
  if (filters.status && statusField) filter[statusField] = filters.status;
  if ((filters.dateFrom || filters.dateTo) && dateField) {
    filter[dateField] = {};
    if (filters.dateFrom) filter[dateField].$gte = filters.dateFrom;
    if (filters.dateTo) filter[dateField].$lte = filters.dateTo;
  }
  return filter;
}

function firstLineArticle(lines = []) {
  const ln = (lines || []).find((l) => t(l?.article || l?.articleNumber || l?.itemCode));
  if (!ln) return { article: "", partNumber: "", description: "" };
  return {
    article: t(ln.article || ln.articleNumber || ln.itemCode).toUpperCase(),
    partNumber: t(ln.partNumber || ln.partNo || ln.spn).toUpperCase(),
    description: t(ln.description || ln.partName || ln.itemName),
  };
}

function lineInfoFromDoc(lines = [], q = "") {
  const ql = t(q).toUpperCase();
  if (ql) {
    for (const ln of lines || []) {
      const art = t(ln.article || ln.articleNumber || ln.itemCode || ln.articleNo).toUpperCase();
      const part = t(ln.partNumber || ln.partNo || ln.spn).toUpperCase();
      if (art === ql || part === ql || (art && art.includes(ql)) || (part && part.includes(ql))) {
        return {
          article: art,
          partNumber: part,
          description: t(ln.description || ln.partName || ln.itemName),
        };
      }
    }
  }
  return firstLineArticle(lines);
}

function lineInfoFromCustomsItems(items = [], q = "") {
  const ql = t(q).toUpperCase();
  for (const it of items || []) {
    const art = t(it.articleNumber).toUpperCase();
    const part = t(it.partNumber).toUpperCase();
    if (!ql || art === ql || part === ql || art.includes(ql) || part.includes(ql)) {
      return {
        article: art,
        partNumber: part,
        description: t(it.partName || it.description),
      };
    }
  }
  const first = (items || [])[0];
  if (!first) return { article: "", partNumber: "", description: "" };
  return {
    article: t(first.articleNumber).toUpperCase(),
    partNumber: t(first.partNumber).toUpperCase(),
    description: t(first.partName || first.description),
  };
}

function lineArticleOrs(re) {
  return [
    { "lines.article": re },
    { "lines.partNumber": re },
    { "lines.itemCode": re },
    { "lines.articleNo": re },
    { "lines.partNo": re },
    { "items.article": re },
    { "items.partNumber": re },
    { "items.itemCode": re },
  ];
}

function scoreHit(hit, q) {
  const ql = t(q).toLowerCase();
  if (!ql) return 0;
  const parts = [
    hit.documentNumber,
    hit.article,
    hit.partNumber,
    hit.party,
    hit.description,
    hit.type,
  ]
    .map((x) => t(x).toLowerCase())
    .filter(Boolean);
  let score = 10;
  for (const p of parts) {
    if (p === ql) score = Math.max(score, 1000);
    else if (p.startsWith(ql)) score = Math.max(score, 800);
    else if (p.includes(ql)) score = Math.max(score, 500);
  }
  const art = t(hit.article).toLowerCase();
  const part = t(hit.partNumber).toLowerCase();
  if (art && (art === ql || art.includes(ql))) score = Math.max(score, 920);
  if (part && (part === ql || part.includes(ql))) score = Math.max(score, 900);
  if (ARTICLE_PRIORITY_GROUPS.has(hit.group) && (art === ql || part === ql)) {
    score = Math.max(score, 960);
  }
  return score;
}

function buildGroupSummary(items) {
  const counts = new Map();
  for (const item of items) {
    const g = item.group || groupForType(item.type);
    counts.set(g, (counts.get(g) || 0) + 1);
  }
  const groups = GROUP_DISPLAY_ORDER.filter((label) => counts.get(label)).map((label) => ({
    label,
    count: counts.get(label),
  }));
  for (const [label, count] of counts) {
    if (!GROUP_DISPLAY_ORDER.includes(label)) {
      groups.push({ label, count });
    }
  }
  const groupCounts = Object.fromEntries(counts);
  return { groups, groupCounts };
}

function baseHit({
  type,
  category,
  module,
  documentNumber,
  companyCode,
  date,
  party,
  article,
  partNumber,
  description,
  status,
  amount,
  qty,
  entityId,
  openPath,
  group,
}) {
  const resolvedGroup = group || groupForType(type);
  return {
    type,
    group: resolvedGroup,
    category,
    module,
    documentNumber: t(documentNumber),
    company: companyCode || "",
    date: date || null,
    party: t(party),
    article: t(article).toUpperCase(),
    partNumber: t(partNumber).toUpperCase(),
    description: t(description),
    status: t(status),
    amount: amount != null ? Number(amount) : null,
    qty: qty != null ? Number(qty) : null,
    entityId: entityId ? String(entityId) : "",
    openPath: openPath || "",
  };
}

function salesOpenPath(tab, id) {
  return `/sales?tab=${encodeURIComponent(tab)}&id=${encodeURIComponent(id)}`;
}

async function searchQuotations(companyId, companyCode, re, filters) {
  const filter = applyDateStatus(withCompany(companyId, { $or: [{ quotationNo: re }, { quotationNumber: re }, { customerName: re }, { "lines.article": re }, { "lines.partNumber": re }] }), {
    dateField: "quotationDate",
    statusField: "status",
    filters,
  });
  const rows = await Quotation.find(filter).sort({ quotationDate: -1 }).limit(PER_SOURCE_LIMIT).lean();
  return rows.map((r) => {
    const line = lineInfoFromDoc(r.lines, filters.q);
    return baseHit({
      type: "Quotation",
      category: CATEGORIES.SALES,
      module: "SALES",
      documentNumber: r.quotationNo || r.quotationNumber,
      companyCode,
      date: r.quotationDate,
      party: r.customerName,
      article: line.article,
      partNumber: line.partNumber,
      description: line.description || r.customerReference,
      status: r.status,
      amount: r.grandTotal,
      entityId: r._id,
      openPath: salesOpenPath("Quotation", r._id),
    });
  });
}

async function searchOa(companyId, companyCode, re, filters) {
  const filter = applyDateStatus(withCompany(companyId, { $or: [{ oaNo: re }, { customerName: re }, { "lines.article": re }, { "lines.partNumber": re }] }), {
    dateField: "oaDate",
    statusField: "status",
    filters,
  });
  const rows = await OrderAcknowledgement.find(filter).sort({ oaDate: -1 }).limit(PER_SOURCE_LIMIT).lean();
  return rows.map((r) => {
    const line = lineInfoFromDoc(r.lines, filters.q);
    return baseHit({
      type: "Order Acknowledgement",
      category: CATEGORIES.SALES,
      module: "SALES",
      documentNumber: r.oaNo,
      companyCode,
      date: r.oaDate,
      party: r.customerName,
      article: line.article,
      partNumber: line.partNumber,
      description: line.description,
      status: r.status,
      amount: r.grandTotal,
      entityId: r._id,
      openPath: salesOpenPath("Order Acknowledgement", r._id),
    });
  });
}

async function searchProforma(companyId, companyCode, re, filters) {
  const filter = applyDateStatus(withCompany(companyId, { $or: [{ proformaNo: re }, { customerName: re }, { "lines.article": re }, { "lines.partNumber": re }] }), {
    dateField: "proformaDate",
    statusField: "status",
    filters,
  });
  const rows = await ProformaInvoice.find(filter).sort({ proformaDate: -1 }).limit(PER_SOURCE_LIMIT).lean();
  return rows.map((r) => {
    const line = lineInfoFromDoc(r.lines, filters.q);
    return baseHit({
      type: "Proforma Invoice",
      category: CATEGORIES.SALES,
      module: "SALES",
      documentNumber: r.proformaNo,
      companyCode,
      date: r.proformaDate,
      party: r.customerName,
      article: line.article,
      partNumber: line.partNumber,
      description: line.description,
      status: r.status,
      amount: r.grandTotal,
      entityId: r._id,
      openPath: salesOpenPath("Proforma Invoice", r._id),
    });
  });
}

async function searchSalesInvoices(companyId, companyCode, re, filters) {
  const filter = applyDateStatus(
    withCompany(companyId, {
      $or: [{ invoiceNo: re }, { invoiceNumber: re }, { customerName: re }, ...lineArticleOrs(re)],
    }),
    {
    dateField: "invoiceDate",
    statusField: "status",
    filters,
  });
  const rows = await SalesInvoice.find(filter).sort({ invoiceDate: -1 }).limit(PER_SOURCE_LIMIT).lean();
  return rows.map((r) => {
    const line = lineInfoFromDoc(r.lines, filters.q);
    const documentStatus =
      r.documentStatus ||
      (["DRAFT", "CANCELLED"].includes(String(r.status || "").toUpperCase()) ? r.status : "ISSUED");
    const paymentStatus = r.paymentStatus || "UNPAID";
    const dispatchStatus = r.dispatchStatus || "NOT_DISPATCHED";
    return baseHit({
      type: "Sales Invoice",
      category: CATEGORIES.SALES,
      module: "SALES",
      documentNumber: r.invoiceNo || r.invoiceNumber,
      companyCode,
      date: r.invoiceDate,
      party: r.customerName,
      article: line.article,
      partNumber: line.partNumber,
      description: line.description
        ? `${line.description} · Doc ${documentStatus} · Pay ${paymentStatus} · Disp ${dispatchStatus}`
        : `Doc ${documentStatus} · Pay ${paymentStatus} · Disp ${dispatchStatus}`,
      status: documentStatus,
      amount: r.grandTotal,
      entityId: r._id,
      openPath: salesOpenPath("Sales Invoice", r._id),
    });
  });
}

async function searchAllocations(companyId, companyCode, re, filters) {
  const filter = applyDateStatus(withCompany(companyId, { $or: [{ allocationNo: re }, { customerName: re }, { "lines.article": re }, { "lines.partNumber": re }] }), {
    dateField: "allocationDate",
    statusField: "status",
    filters,
  });
  const rows = await OrderAllocation.find(filter).sort({ allocationDate: -1 }).limit(PER_SOURCE_LIMIT).lean();
  return rows.map((r) => {
    const line = lineInfoFromDoc(r.lines, filters.q);
    return baseHit({
      type: "Order Allocation",
      category: CATEGORIES.SALES,
      module: "SALES",
      documentNumber: r.allocationNo,
      companyCode,
      date: r.allocationDate,
      party: r.customerName,
      article: line.article,
      partNumber: line.partNumber,
      description: line.description,
      status: r.status,
      amount: r.grandTotal,
      entityId: r._id,
      openPath: salesOpenPath("Order Allocation", r._id),
    });
  });
}

async function searchSalesDispatch(companyId, companyCode, re, filters) {
  const filter = applyDateStatus(withCompany(companyId, { $or: [{ dispatchNo: re }, { customerName: re }, { linkedSalesInvoiceNo: re }] }), {
    dateField: "dispatchDate",
    statusField: "status",
    filters,
  });
  const rows = await SalesDispatch.find(filter).sort({ dispatchDate: -1 }).limit(PER_SOURCE_LIMIT).lean();
  return rows.map((r) =>
    baseHit({
      type: "Sales Dispatch",
      category: CATEGORIES.SALES,
      module: "SALES",
      documentNumber: r.dispatchNo,
      companyCode,
      date: r.dispatchDate,
      party: r.customerName,
      article: "",
      partNumber: "",
      description: r.linkedSalesInvoiceNo ? `SI ${r.linkedSalesInvoiceNo}` : "",
      status: r.status,
      entityId: r._id,
      openPath: salesOpenPath("Dispatch Status", r._id),
    }),
  );
}

async function searchCustomers(companyId, companyCode, re) {
  const rows = await Customer.find(withCompany(companyId, { $or: [{ name: re }, { contactName: re }, { email: re }] }))
    .sort({ name: 1 })
    .limit(PER_SOURCE_LIMIT)
    .lean();
  return rows.map((r) =>
    baseHit({
      type: "Customer",
      category: CATEGORIES.SALES,
      module: "SALES",
      documentNumber: r.name,
      companyCode,
      date: r.updatedAt,
      party: r.name,
      description: r.contactName || r.email,
      status: r.status || "ACTIVE",
      entityId: r._id,
      openPath: `/sales?tab=${encodeURIComponent("Customer Master")}&q=${encodeURIComponent(r.name)}`,
    }),
  );
}

async function searchPurchaseOrders(companyId, companyCode, re, filters) {
  const filter = applyDateStatus(
    withCompany(companyId, {
      $or: [{ poNo: re }, { poNumber: re }, { supplierName: re }, ...lineArticleOrs(re)],
    }),
    {
    dateField: "poDate",
    statusField: "status",
    filters,
  });
  const rows = await PurchaseOrder.find(filter).sort({ poDate: -1 }).limit(PER_SOURCE_LIMIT).lean();
  return rows.map((r) => {
    const line = lineInfoFromDoc(r.lines, filters.q);
    return baseHit({
      type: "Purchase Order",
      category: CATEGORIES.PURCHASE,
      module: "PURCHASE",
      documentNumber: r.poNo || r.poNumber,
      companyCode,
      date: r.poDate,
      party: r.supplierName,
      article: line.article,
      partNumber: line.partNumber,
      description: line.description,
      status: r.status,
      amount: r.grandTotal || r.totalAmount,
      entityId: r._id,
      openPath: `/purchase?tab=orders&id=${encodeURIComponent(r._id)}`,
    });
  });
}

async function searchSuppliers(companyId, companyCode, re) {
  const rows = await Supplier.find(withCompany(companyId, { $or: [{ supplierName: re }, { name: re }, { supplierCode: re }, { email: re }] }))
    .sort({ supplierName: 1 })
    .limit(PER_SOURCE_LIMIT)
    .lean();
  return rows.map((r) =>
    baseHit({
      type: "Supplier",
      category: CATEGORIES.PURCHASE,
      module: "PURCHASE",
      documentNumber: r.supplierCode || r.supplierName || r.name,
      companyCode,
      date: r.updatedAt,
      party: r.supplierName || r.name,
      description: r.email,
      status: r.status || "ACTIVE",
      entityId: r._id,
      openPath: `/purchase?tab=suppliers&q=${encodeURIComponent(r.supplierName || r.name || "")}`,
    }),
  );
}

async function searchGrn(companyId, companyCode, re, filters) {
  const filter = applyDateStatus(
    withCompany(companyId, {
      $or: [
        { grnNo: re },
        { supplierName: re },
        { supplierInvoiceNo: re },
        { poNo: re },
        { blAwbNo: re },
        ...lineArticleOrs(re),
      ],
    }),
    { dateField: "grnDate", statusField: "status", filters },
  );
  const rows = await GRN.find(filter).sort({ grnDate: -1 }).limit(PER_SOURCE_LIMIT).lean();
  return rows.map((r) => {
    const line = lineInfoFromDoc(r.items || r.lines, filters.q);
    return baseHit({
      type: "GRN",
      category: CATEGORIES.INVENTORY,
      module: "STORE",
      documentNumber: r.grnNo,
      companyCode,
      date: r.grnDate,
      party: r.supplierName,
      article: line.article,
      partNumber: line.partNumber,
      description: line.description || r.poNo,
      status: r.status,
      qty: (r.items || []).reduce((s, it) => s + (Number(it.qty) || Number(it.acceptedQty) || 0), 0),
      entityId: r._id,
      openPath: `/store?tab=GRN&grnNo=${encodeURIComponent(r.grnNo)}`,
    });
  });
}

async function searchPacking(companyId, companyCode, re, filters) {
  const filter = applyDateStatus(withCompany(companyId, { $or: [{ packingNo: re }, { customerName: re }, { allocationNo: re }, { "lines.article": re }, { "lines.partNumber": re }] }), {
    dateField: "packingDate",
    statusField: "status",
    filters,
  });
  const rows = await StorePacking.find(filter).sort({ packingDate: -1 }).limit(PER_SOURCE_LIMIT).lean();
  return rows.map((r) => {
    const line = lineInfoFromDoc(r.lines, filters.q);
    return baseHit({
      type: "Packing List",
      category: CATEGORIES.INVENTORY,
      module: "STORE",
      documentNumber: r.packingNo,
      companyCode,
      date: r.packingDate,
      party: r.customerName,
      article: line.article,
      partNumber: line.partNumber,
      description: r.allocationNo,
      status: r.status,
      entityId: r._id,
      openPath: `/store?tab=Packing&packingNo=${encodeURIComponent(r.packingNo)}`,
    });
  });
}

async function searchStoreDispatch(companyId, companyCode, re, filters) {
  const filter = applyDateStatus(
    withCompany(companyId, { $or: [{ dispatchNo: re }, { customerName: re }, { packingNo: re }, { blNo: re }, { awbNo: re }] }),
    { dateField: "dispatchDate", statusField: "status", filters },
  );
  const rows = await StoreDispatch.find(filter).sort({ dispatchDate: -1 }).limit(PER_SOURCE_LIMIT).lean();
  return rows.map((r) =>
    baseHit({
      type: "Dispatch",
      category: CATEGORIES.INVENTORY,
      module: "STORE",
      documentNumber: r.dispatchNo,
      companyCode,
      date: r.dispatchDate,
      party: r.customerName,
      description: r.packingNo ? `Packing ${r.packingNo}` : "",
      status: r.status,
      entityId: r._id,
      openPath: `/store?tab=Dispatch&dispatchNo=${encodeURIComponent(r.dispatchNo)}`,
    }),
  );
}

async function searchItems(companyId, companyCode, re) {
  const rows = await ItemMaster.find(
    withCompany(companyId, {
      $or: [{ article: re }, { partNumber: re }, { itemName: re }, { description: re }, { materialCode: re }, { spn: re }],
    }),
  )
    .sort({ article: 1 })
    .limit(PER_SOURCE_LIMIT)
    .lean();
  return rows.map((r) =>
    baseHit({
      type: "Article",
      category: CATEGORIES.INVENTORY,
      module: "ITEM_MASTER",
      documentNumber: r.article,
      companyCode,
      date: r.updatedAt,
      party: "",
      article: r.article,
      partNumber: r.partNumber,
      description: r.itemName || r.description,
      status: r.status,
      entityId: r._id,
      openPath: `/items?q=${encodeURIComponent(r.article)}`,
    }),
  );
}

async function searchPurchaseInvoices(companyId, companyCode, re, filters) {
  const filter = applyDateStatus(
    withCompany(companyId, {
      $or: [{ invoiceNumber: re }, { supplierInvoiceNo: re }, { supplierName: re }, { grnNo: re }, { linkedPoNumber: re }],
    }),
    { dateField: "invoiceDate", statusField: "status", filters },
  );
  const rows = await PurchaseInvoice.find(filter).sort({ invoiceDate: -1 }).limit(PER_SOURCE_LIMIT).lean();
  return rows.map((r) =>
    baseHit({
      type: "Purchase Invoice",
      category: CATEGORIES.ACCOUNTS,
      module: "ACCOUNTS",
      documentNumber: r.invoiceNumber,
      companyCode,
      date: r.invoiceDate,
      party: r.supplierName,
      description: r.linkedPoNumber ? `PO ${r.linkedPoNumber}` : r.grnNo,
      status: r.status,
      amount: r.totalAmount,
      entityId: r._id,
      openPath: `/accounts?q=${encodeURIComponent(r.invoiceNumber)}`,
    }),
  );
}

async function searchCustomsInvoices(companyId, companyCode, re, filters) {
  const filter = applyDateStatus(
    withCompany(companyId, {
      $or: [
        { customsInvoiceNumber: re },
        { salesInvoiceNumber: re },
        { customerName: re },
        { "items.articleNumber": re },
        { "items.partNumber": re },
        { "items.allocations.blNumber": re },
        { "items.allocations.boeNumber": re },
        { "items.allocations.awbNumber": re },
        { "items.allocations.supplierInvoiceNumber": re },
      ],
    }),
    { dateField: "invoiceDate", statusField: "status", filters },
  );
  const rows = await CustomsInvoice.find(filter).sort({ invoiceDate: -1 }).limit(PER_SOURCE_LIMIT).lean();
  return rows.map((r) => {
    const line = lineInfoFromCustomsItems(r.items, filters.q);
    return baseHit({
      type: "Customs Invoice",
      category: CATEGORIES.CUSTOMS,
      module: "CUSTOMS",
      documentNumber: r.customsInvoiceNumber,
      companyCode,
      date: r.invoiceDate,
      party: r.customerName,
      article: line.article,
      partNumber: line.partNumber,
      description: line.description || (r.salesInvoiceNumber ? `SI ${r.salesInvoiceNumber}` : ""),
      status: r.status,
      amount: r.grandTotal,
      entityId: r._id,
      openPath: `/customs/invoices/${r._id}`,
    });
  });
}

async function searchCustomsLots(companyId, companyCode, re, filters) {
  const filter = applyDateStatus(
    withCompany(companyId, {
      $or: [{ customsLotRef: re }, { grnNo: re }, { boeNumber: re }, { blNumber: re }, { awbNumber: re }, { supplierInvoiceNumber: re }, { supplierName: re }],
    }),
    { dateField: "createdAt", statusField: "status", filters },
  );
  const rows = await CustomsLot.find(filter).sort({ createdAt: -1 }).limit(PER_SOURCE_LIMIT).lean();
  return rows.map((r) =>
    baseHit({
      type: "Customs Lot",
      category: CATEGORIES.CUSTOMS,
      module: "CUSTOMS",
      documentNumber: r.customsLotRef,
      companyCode,
      date: r.supplierInvoiceDate || r.createdAt,
      party: r.supplierName,
      description: `GRN ${r.grnNo}`,
      status: r.status,
      entityId: r._id,
      openPath: `/customs/stock?search=${encodeURIComponent(r.customsLotRef || r.grnNo)}`,
    }),
  );
}

async function searchCustomsStock(companyId, companyCode, re, filters) {
  const filter = applyDateStatus(
    withCompany(companyId, {
      status: { $ne: "CANCELLED" },
      $or: [
        { articleNumber: re },
        { partNumber: re },
        { partName: re },
        { boeNumber: re },
        { blNumber: re },
        { awbNumber: re },
        { supplierInvoiceNumber: re },
        { grnNo: re },
      ],
    }),
    { dateField: "supplierInvoiceDate", statusField: "status", filters },
  );
  const rows = await CustomsLotItem.find(filter).sort({ supplierInvoiceDate: -1 }).limit(PER_SOURCE_LIMIT).lean();
  const qEnc = encodeURIComponent(filters.q || "");
  return rows.map((r) =>
    baseHit({
      type: "Customs Stock",
      category: CATEGORIES.CUSTOMS,
      module: "CUSTOMS",
      documentNumber: r.grnNo || r.customsLotRef,
      companyCode,
      date: r.supplierInvoiceDate,
      party: "",
      article: r.articleNumber,
      partNumber: r.partNumber,
      description: r.partName,
      status: r.status,
      qty: r.qtyAvailable,
      entityId: r._id,
      openPath: `/customs/stock?articleNumber=${encodeURIComponent(r.articleNumber)}&search=${qEnc}`,
    }),
  );
}

async function searchCustomsLedger(companyId, companyCode, re, filters) {
  const filter = applyDateStatus(
    withCompany(companyId, {
      $or: [
        { articleNumber: re },
        { partNumber: re },
        { referenceNumber: re },
        { referenceType: re },
        { movementType: re },
      ],
    }),
    { dateField: "movementDate", statusField: null, filters },
  );
  if (filters.status) filter.movementType = filters.status;
  const rows = await CustomsMovement.find(filter).sort({ movementDate: -1 }).limit(PER_SOURCE_LIMIT).lean();
  const qEnc = encodeURIComponent(filters.q || "");
  return rows.map((r) =>
    baseHit({
      type: "Customs Ledger",
      group: SEARCH_GROUPS.CUSTOMS_LEDGER,
      category: CATEGORIES.CUSTOMS,
      module: "CUSTOMS",
      documentNumber: r.referenceNumber || r.movementType,
      companyCode,
      date: r.movementDate || r.createdAt,
      party: "",
      article: r.articleNumber,
      partNumber: r.partNumber,
      description: `${r.movementType} · ${r.referenceType}`,
      status: r.movementType,
      qty: r.qty,
      entityId: r._id,
      openPath: `/customs/ledger?article=${encodeURIComponent(r.articleNumber || "")}&search=${qEnc}`,
    }),
  );
}

async function searchDocuments(companyId, companyCode, re) {
  const rows = await Document.find(
    withCompany(companyId, {
      $or: [{ fileName: re }, { documentType: re }, { referenceNumber: re }, { referenceType: re }],
    }),
  )
    .sort({ createdAt: -1 })
    .limit(PER_SOURCE_LIMIT)
    .lean();
  return rows.map((r) =>
    baseHit({
      type: "Document",
      category: CATEGORIES.DOCUMENTS,
      module: "DOCUMENTS",
      documentNumber: r.fileName || r.referenceNumber,
      companyCode,
      date: r.createdAt,
      party: "",
      description: r.documentType,
      status: r.status || "UPLOADED",
      entityId: r._id,
      openPath: `/documents?q=${encodeURIComponent(r.fileName || r.referenceNumber || "")}`,
    }),
  );
}

function categoryEnabled(category, filters) {
  const c = filters.category;
  if (!c || c === CATEGORIES.ALL) return true;
  return c === category;
}

export async function globalSearch(req, rawPaging = {}) {
  const filters = parseFilters(req.query || {});
  const page = Math.max(1, Number(rawPaging.page || req.query?.page || 1));
  const limit = Math.min(100, Math.max(1, Number(rawPaging.limit || req.query?.limit || 50)));
  const companyId = req.companyId;
  const companyCode = req.companyCode || "";

  if (!filters.q || filters.q.length < 1) {
    return { items: [], total: 0, page, limit, query: "", categories: Object.values(CATEGORIES), groups: [], groupCounts: {} };
  }

  const re = buildRegex(filters.q);
  if (!re) return { items: [], total: 0, page, limit, query: filters.q, groups: [], groupCounts: {} };

  const tasks = [];
  const salesOk = await hasPermission(req, "SALES", "view");
  const purchaseOk = await hasPermission(req, "PURCHASE", "view");
  const storeOk = await hasPermission(req, "STORE", "view");
  const customsOk = isCustomsEnabled() && (await hasPermission(req, "CUSTOMS", "view"));
  const itemsOk = await hasPermission(req, "ITEM_MASTER", "view");
  const accountsOk = await hasPermission(req, "ACCOUNTS", "view");

  if (salesOk && categoryEnabled(CATEGORIES.SALES, filters)) {
    tasks.push(searchQuotations, searchOa, searchProforma, searchSalesInvoices, searchAllocations, searchSalesDispatch, searchCustomers);
  }
  if (purchaseOk && categoryEnabled(CATEGORIES.PURCHASE, filters)) {
    tasks.push(searchPurchaseOrders, searchSuppliers);
  }
  if (storeOk && categoryEnabled(CATEGORIES.INVENTORY, filters)) {
    tasks.push(searchGrn, searchPacking, searchStoreDispatch);
  }
  if (itemsOk && categoryEnabled(CATEGORIES.INVENTORY, filters)) {
    tasks.push(searchItems);
  }
  if (accountsOk && categoryEnabled(CATEGORIES.ACCOUNTS, filters)) {
    tasks.push(searchPurchaseInvoices);
  }
  if (customsOk && categoryEnabled(CATEGORIES.CUSTOMS, filters)) {
    tasks.push(searchCustomsInvoices, searchCustomsLots, searchCustomsStock, searchCustomsLedger);
  }
  if (categoryEnabled(CATEGORIES.DOCUMENTS, filters)) {
    tasks.push(searchDocuments);
  }

  const batches = await Promise.all(
    tasks.map((fn) => fn(companyId, companyCode, re, filters).catch(() => [])),
  );
  let items = batches.flat();
  items = items
    .map((hit) => ({
      ...hit,
      group: hit.group || groupForType(hit.type),
      _score: scoreHit({ ...hit, group: hit.group || groupForType(hit.type) }, filters.q),
    }))
    .sort((a, b) => {
      if (b._score !== a._score) return b._score - a._score;
      const db = new Date(b.date || 0).getTime();
      const da = new Date(a.date || 0).getTime();
      return db - da;
    })
    .slice(0, MERGE_CAP)
    .map(({ _score, ...hit }) => hit);

  const { groups, groupCounts } = buildGroupSummary(items);
  const total = items.length;
  const skip = (page - 1) * limit;
  const pageItems = items.slice(skip, skip + limit);

  return {
    items: pageItems,
    total,
    page,
    limit,
    query: filters.q,
    category: filters.category,
    categories: Object.values(CATEGORIES),
    groups,
    groupCounts,
  };
}
