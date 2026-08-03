/**
 * Article / document traceability — read-only lifecycle view.
 * Uses existing collections only; does not mutate documents.
 */
import PurchaseOrder from "../models/PurchaseOrder.js";
import GRN from "../models/GRN.js";
import CustomsLot from "../models/CustomsLot.js";
import CustomsLotItem from "../models/CustomsLotItem.js";
import CustomsMovement from "../models/CustomsMovement.js";
import CustomsInvoice from "../models/CustomsInvoice.js";
import SalesInvoice from "../models/SalesInvoice.js";
import StoreDispatch from "../models/StoreDispatch.js";
import ItemMaster from "../models/itemMasterModel.js";
import StockBalance from "../models/StockBalance.js";
import ArticleStockConversion from "../models/ArticleStockConversion.js";
import { isCustomsEnabled } from "../config/customsConfig.js";
import { hasPermission } from "./roleService.js";

const FLOW_STAGES = [
  { key: "po", label: "Purchase Order", docType: "PO" },
  { key: "grn", label: "GRN", docType: "GRN" },
  { key: "customsRefs", label: "BOE / BL / AWB", docType: "Customs Refs" },
  { key: "supplierInvoice", label: "Supplier Invoice", docType: "Supplier Invoice" },
  { key: "customsStock", label: "Customs Stock", docType: "Customs Stock" },
  { key: "customsLedger", label: "Customs Ledger", docType: "Customs Ledger" },
  { key: "articleConversion", label: "Article Conversion", docType: "ARTICLE_CONVERSION" },
  { key: "salesInvoice", label: "Sales Invoice", docType: "Sales Invoice" },
  { key: "customsInvoice", label: "Customs Invoice", docType: "Customs Invoice" },
  { key: "dispatch", label: "Dispatch", docType: "Dispatch" },
];

function t(v) {
  return String(v ?? "").trim();
}

function upper(v) {
  return t(v).toUpperCase();
}

function withCompany(companyId, filter = {}) {
  return { ...filter, companyId };
}

function escapeRegex(s) {
  return t(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildRegex(q) {
  const raw = t(q);
  if (!raw) return null;
  return new RegExp(escapeRegex(raw), "i");
}

function parseFilters(raw = {}) {
  const dateFrom = raw.dateFrom ? new Date(raw.dateFrom) : null;
  const dateTo = raw.dateTo ? new Date(raw.dateTo) : null;
  if (dateTo) dateTo.setHours(23, 59, 59, 999);
  return {
    q: t(raw.q),
    articleNumber: upper(raw.articleNumber || raw.article),
    partNumber: upper(raw.partNumber),
    customer: t(raw.customer),
    supplier: t(raw.supplier),
    documentType: t(raw.documentType),
    status: upper(raw.status),
    dateFrom: dateFrom && !Number.isNaN(dateFrom.getTime()) ? dateFrom : null,
    dateTo: dateTo && !Number.isNaN(dateTo.getTime()) ? dateTo : null,
  };
}

function inDateRange(date, from, to) {
  if (!from && !to) return true;
  if (!date) return false;
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return false;
  if (from && d < from) return false;
  if (to && d > to) return false;
  return true;
}

function lineMatchesArticle(line, article, partNumber) {
  const art = upper(line?.article || line?.articleNumber || line?.itemCode);
  if (article && art !== article) return false;
  if (partNumber) {
    const part = upper(line?.partNumber || line?.partNo || line?.spn);
    if (part && part !== partNumber) return false;
  }
  return !!art;
}

function qtyFromLine(line) {
  return (
    Number(line?.qty) ||
    Number(line?.acceptedQty) ||
    Number(line?.receivedQty) ||
    Number(line?.packQty) ||
    Number(line?.dispatchQty) ||
    Number(line?.qtyExported) ||
    0
  );
}

function openPath(type, doc) {
  const id = doc?._id || doc?.id;
  switch (type) {
    case "PO":
      return id ? `/purchase?tab=orders&id=${id}` : "";
    case "GRN":
      return doc?.grnNo ? `/store?tab=GRN&grnNo=${encodeURIComponent(doc.grnNo)}` : "";
    case "Sales Invoice":
      return id ? `/sales?tab=${encodeURIComponent("Sales Invoice")}&id=${id}` : "";
    case "Customs Invoice":
      return id ? `/customs/invoices/${id}` : "";
    case "Dispatch":
      return doc?.dispatchNo ? `/store?tab=Dispatch&dispatchNo=${encodeURIComponent(doc.dispatchNo)}` : "";
    case "Customs Stock":
      return doc?.articleNumber
        ? `/customs/stock?articleNumber=${encodeURIComponent(doc.articleNumber)}`
        : "/customs/stock";
    case "Customs Ledger":
      return doc?.articleNumber
        ? `/customs/ledger?article=${encodeURIComponent(doc.articleNumber)}`
        : "/customs/ledger";
    case "Customs Lot":
      return doc?.customsLotRef
        ? `/customs/stock?search=${encodeURIComponent(doc.customsLotRef)}`
        : "/customs/stock";
    default:
      return "";
  }
}

function flowStatus(linked, pending = false) {
  if (linked) return pending ? "pending" : "linked";
  return "missing";
}

async function resolveAnchor(companyId, filters) {
  if (filters.articleNumber) {
    return { article: filters.articleNumber, partNumber: filters.partNumber || "" };
  }
  const q = filters.q;
  if (!q) return null;
  const re = buildRegex(q);
  if (!re) return null;

  const item = await ItemMaster.findOne(
    withCompany(companyId, {
      $or: [
        { article: re },
        { partNumber: re },
        { materialCode: re },
        { supplierPartNumber: re },
        { itemName: re },
        { description: re },
      ],
    }),
  ).lean();
  if (item) return { article: upper(item.article), partNumber: upper(item.partNumber) };

  const grn = await GRN.findOne(
    withCompany(companyId, {
      $or: [{ grnNo: re }, { supplierInvoiceNo: re }, { blAwbNo: re }, { poNo: re }, { "items.article": re }],
    }),
  ).lean();
  if (grn) {
    const ln = (grn.items || []).find((x) => re.test(x.article) || re.test(grn.grnNo)) || grn.items?.[0];
    if (ln?.article) return { article: upper(ln.article), partNumber: upper(ln.partNumber) };
  }

  const po = await PurchaseOrder.findOne(
    withCompany(companyId, {
      $or: [{ poNo: re }, { poNumber: re }, { supplierName: re }, { "lines.article": re }, { "lines.partNumber": re }],
    }),
  ).lean();
  if (po) {
    const ln = (po.lines || []).find((x) => re.test(x.article) || re.test(po.poNo)) || po.lines?.[0];
    if (ln?.article || ln?.itemCode) return { article: upper(ln.article || ln.itemCode), partNumber: upper(ln.partNumber) };
  }

  const si = await SalesInvoice.findOne(
    withCompany(companyId, {
      $or: [{ invoiceNo: re }, { invoiceNumber: re }, { customerName: re }, { "lines.article": re }],
    }),
  ).lean();
  if (si) {
    const ln = (si.lines || []).find((x) => re.test(x.article) || re.test(si.invoiceNo)) || si.lines?.[0];
    if (ln?.article) return { article: upper(ln.article), partNumber: upper(ln.partNumber) };
  }

  if (isCustomsEnabled()) {
    const ci = await CustomsInvoice.findOne(
      withCompany(companyId, {
        $or: [
          { customsInvoiceNumber: re },
          { salesInvoiceNumber: re },
          { "items.articleNumber": re },
          { "items.allocations.blNumber": re },
          { "items.allocations.boeNumber": re },
        ],
      }),
    ).lean();
    if (ci) {
      const it = (ci.items || []).find((x) => re.test(x.articleNumber)) || ci.items?.[0];
      if (it?.articleNumber) return { article: upper(it.articleNumber), partNumber: upper(it.partNumber) };
    }

    const lotItem = await CustomsLotItem.findOne(
      withCompany(companyId, {
        $or: [
          { articleNumber: re },
          { blNumber: re },
          { boeNumber: re },
          { awbNumber: re },
          { supplierInvoiceNumber: re },
          { grnNo: re },
        ],
      }),
    ).lean();
    if (lotItem?.articleNumber) {
      return { article: upper(lotItem.articleNumber), partNumber: upper(lotItem.partNumber) };
    }

    const lot = await CustomsLot.findOne(
      withCompany(companyId, {
        $or: [{ blNumber: re }, { boeNumber: re }, { awbNumber: re }, { supplierInvoiceNumber: re }, { customsLotRef: re }],
      }),
    ).lean();
    if (lot) {
      const firstItem = await CustomsLotItem.findOne(withCompany(companyId, { customsLotId: lot._id })).lean();
      if (firstItem?.articleNumber) {
        return { article: upper(firstItem.articleNumber), partNumber: upper(firstItem.partNumber) };
      }
    }
  }

  return null;
}

async function computeErpStockQty(companyId, article) {
  const rows = await StockBalance.find(withCompany(companyId, { article })).lean();
  let total = 0;
  for (const row of rows) {
    const onHand = Number(row.onHandQty ?? row.quantity) || 0;
    const allocated = Math.max(Number(row.allocatedQty) || 0, Number(row.reservedQty) || 0);
    const packed = Number(row.packedQty) || 0;
    total += onHand - allocated - packed;
  }
  return total;
}

function buildTimeline(events) {
  return events
    .filter((e) => e.date)
    .sort((a, b) => new Date(a.date) - new Date(b.date))
    .map((e, idx) => ({ ...e, srNo: idx + 1 }));
}

export async function buildArticleTraceability(req, rawFilters = {}) {
  const filters = parseFilters(rawFilters);
  const companyId = req.companyId;
  const companyCode = req.companyCode || "";
  const customsOk = isCustomsEnabled() && (await hasPermission(req, "CUSTOMS", "view"));
  const purchaseOk = await hasPermission(req, "PURCHASE", "view");
  const storeOk = await hasPermission(req, "STORE", "view");
  const salesOk = await hasPermission(req, "SALES", "view");

  const anchor = await resolveAnchor(companyId, filters);
  if (!anchor?.article) {
    return {
      found: false,
      query: filters,
      message: filters.q || filters.articleNumber ? "No matching article trace found" : "Enter article or search term",
      summary: null,
      flow: FLOW_STAGES.map((s) => ({
        stage: s.key,
        label: s.label,
        status: "missing",
        documentNumber: "Not Linked",
        openPath: "",
      })),
      timeline: [],
      purchase: [],
      customs: [],
      sales: [],
    };
  }

  const article = anchor.article;
  const partNumber = filters.partNumber || anchor.partNumber || "";

  const item = await ItemMaster.findOne(withCompany(companyId, { article })).lean();

  const poFilter = withCompany(companyId, { "lines.article": article });
  if (filters.supplier) poFilter.supplierName = new RegExp(escapeRegex(filters.supplier), "i");
  const pos = purchaseOk ? await PurchaseOrder.find(poFilter).sort({ orderDate: -1, createdAt: -1 }).limit(100).lean() : [];

  const grnFilter = withCompany(companyId, { "items.article": article });
  if (filters.supplier) grnFilter.supplierName = new RegExp(escapeRegex(filters.supplier), "i");
  const grns = storeOk ? await GRN.find(grnFilter).sort({ grnDate: -1 }).limit(100).lean() : [];

  let customsItems = [];
  let customsLots = [];
  let customsMovements = [];
  let customsInvoices = [];
  if (customsOk) {
    const ciFilter = withCompany(companyId, {
      status: { $ne: "CANCELLED" },
      $or: [{ articleNumber: article }, { originalReceivedArticle: article }],
    });
    if (partNumber) ciFilter.partNumber = partNumber;
    customsItems = await CustomsLotItem.find(ciFilter).sort({ supplierInvoiceDate: -1 }).limit(200).lean();
    const lotIds = [...new Set(customsItems.map((x) => String(x.customsLotId)).filter(Boolean))];
    if (lotIds.length) {
      customsLots = await CustomsLot.find(withCompany(companyId, { _id: { $in: lotIds } })).lean();
    }
    customsMovements = await CustomsMovement.find(
      withCompany(companyId, {
        $or: [{ articleNumber: article }, { referenceType: "ARTICLE_STOCK_CONVERSION" }],
      })
    )
      .sort({ movementDate: 1 })
      .limit(500)
      .lean();
    // Keep movements that touch this article or its conversion refs
    customsMovements = customsMovements.filter(
      (mv) =>
        upper(mv.articleNumber) === article ||
        (String(mv.referenceType) === "ARTICLE_STOCK_CONVERSION" &&
          customsItems.some((ci) => String(ci._id) === String(mv.customsLotItemId)))
    );
    customsInvoices = await CustomsInvoice.find(
      withCompany(companyId, {
        "items.articleNumber": article,
        status: { $ne: "CANCELLED" },
      }),
    )
      .sort({ invoiceDate: -1 })
      .limit(100)
      .lean();
  }

  const siFilter = withCompany(companyId, { "lines.article": article });
  if (filters.customer) siFilter.customerName = new RegExp(escapeRegex(filters.customer), "i");
  const salesInvoices = salesOk
    ? await SalesInvoice.find(siFilter).sort({ invoiceDate: -1 }).limit(100).lean()
    : [];

  const conversions =
    storeOk || (await hasPermission(req, "ARTICLE_CONVERSION", "view"))
      ? await ArticleStockConversion.find(
          withCompany(companyId, {
            status: { $in: ["POSTED", "REVERSED"] },
            $or: [{ sourceArticle: article }, { targetArticle: article }],
          })
        )
          .sort({ conversionDate: -1 })
          .limit(100)
          .lean()
      : [];

  const dispatches = storeOk
    ? await StoreDispatch.find(withCompany(companyId, { "lines.article": article }))
        .sort({ dispatchDate: -1 })
        .limit(100)
        .lean()
    : [];

  const purchaseRows = [];
  let totalPoQty = 0;
  let totalGrnQty = 0;
  const poById = new Map(pos.map((p) => [String(p._id), p]));

  for (const po of pos) {
    for (const ln of po.lines || []) {
      if (!lineMatchesArticle(ln, article, partNumber)) continue;
      const qty = Number(ln.qty) || 0;
      totalPoQty += qty;
      const linkedGrns = grns.filter((g) => String(g.poId) === String(po._id) || g.poNo === po.poNo);
      const grn = linkedGrns[0];
      let grnQty = 0;
      if (grn) {
        grnQty = (grn.items || [])
          .filter((it) => lineMatchesArticle(it, article, partNumber))
          .reduce((s, it) => s + (Number(it.acceptedQty) || Number(it.receivedQty) || 0), 0);
      }
      purchaseRows.push({
        poNumber: po.poNo || po.poNumber,
        supplier: po.supplierName,
        poDate: po.orderDate || po.createdAt,
        article,
        partNumber: upper(ln.partNumber),
        qtyOrdered: qty,
        grnNumber: grn?.grnNo || "Not Linked",
        qtyReceived: grnQty || null,
        supplierInvoiceNumber: grn?.supplierInvoiceNo || customsItems[0]?.supplierInvoiceNumber || "Not Linked",
        openPo: openPath("PO", po),
        openGrn: grn ? openPath("GRN", grn) : "",
        status: po.status,
      });
    }
  }

  for (const grn of grns) {
    for (const ln of grn.items || []) {
      if (!lineMatchesArticle(ln, article, partNumber)) continue;
      totalGrnQty += Number(ln.acceptedQty) || Number(ln.receivedQty) || 0;
      if (purchaseRows.some((r) => r.grnNumber === grn.grnNo)) continue;
      purchaseRows.push({
        poNumber: grn.poNo || poById.get(String(grn.poId))?.poNo || "Not Linked",
        supplier: grn.supplierName,
        poDate: poById.get(String(grn.poId))?.orderDate || null,
        article,
        partNumber: upper(ln.partNumber),
        qtyOrdered: Number(ln.orderedQty) || null,
        grnNumber: grn.grnNo,
        qtyReceived: Number(ln.acceptedQty) || Number(ln.receivedQty) || 0,
        supplierInvoiceNumber: grn.supplierInvoiceNo || "Not Linked",
        openPo: grn.poId ? openPath("PO", { _id: grn.poId }) : "",
        openGrn: openPath("GRN", grn),
        status: grn.status,
      });
    }
  }

  const customsRows = customsItems.map((it) => {
    const lot = customsLots.find((l) => String(l._id) === String(it.customsLotId));
    return {
      boeNumber: it.boeNumber || lot?.boeNumber || "—",
      blNumber: it.blNumber || lot?.blNumber || "—",
      awbNumber: it.awbNumber || lot?.awbNumber || "—",
      supplierInvoiceNumber: it.supplierInvoiceNumber || lot?.supplierInvoiceNumber || "Not Linked",
      supplier: lot?.supplierName || "—",
      countryOfOrigin: it.countryOfOrigin || lot?.countryOfOrigin || "—",
      qtyImported: Number(it.qtyImported) || 0,
      qtyConsumed: Number(it.qtyConsumed) || 0,
      qtyAvailable: Number(it.qtyAvailable) || 0,
      status: it.status || "—",
      grnNumber: it.grnNo || lot?.grnNo || "Not Linked",
      blDocumentId: lot?.documents?.blDocumentId || null,
      supplierInvoiceDocumentId: lot?.documents?.supplierInvoiceDocumentId || null,
      openCustomsStock: openPath("Customs Stock", it),
      openCustomsLedger: openPath("Customs Ledger", it),
      openGrn: it.grnNo ? `/store?tab=GRN&grnNo=${encodeURIComponent(it.grnNo)}` : "",
    };
  });

  let totalSoldQty = 0;
  let pendingDispatchQty = 0;
  const salesRows = [];

  for (const si of salesInvoices) {
    const lines = (si.lines || []).filter((ln) => lineMatchesArticle(ln, article, partNumber));
    const qtySold = lines.reduce((s, ln) => s + qtyFromLine(ln), 0);
    totalSoldQty += qtySold;
    const linkedCi = customsInvoices.find((c) => String(c.salesInvoiceId) === String(si._id));
    const linkedDisp = dispatches.find((d) => String(d.salesInvoiceId) === String(si._id));
    const dispatchedQty = linkedDisp
      ? (linkedDisp.lines || [])
          .filter((ln) => lineMatchesArticle(ln, article, partNumber))
          .reduce((s, ln) => s + (Number(ln.dispatchQty) || 0), 0)
      : 0;
    pendingDispatchQty += Math.max(0, qtySold - dispatchedQty);
    salesRows.push({
      salesInvoiceNumber: si.invoiceNo || si.invoiceNumber,
      customer: si.customerName,
      invoiceDate: si.invoiceDate,
      article,
      partNumber: upper(lines[0]?.partNumber),
      qtySold,
      customsInvoiceNumber: linkedCi?.customsInvoiceNumber || "Not Linked",
      dispatchStatus: linkedDisp ? linkedDisp.status : "Not Linked",
      dispatchNumber: linkedDisp?.dispatchNo || "Not Linked",
      openSalesInvoice: openPath("Sales Invoice", si),
      openCustomsInvoice: linkedCi ? openPath("Customs Invoice", linkedCi) : "",
      openDispatch: linkedDisp ? openPath("Dispatch", linkedDisp) : "",
      status: si.status,
    });
  }

  const customsStockQty = customsItems.reduce((s, it) => s + (Number(it.qtyAvailable) || 0), 0);
  const erpStockQty = await computeErpStockQty(companyId, article);

  const primaryPo = pos[0];
  const primaryGrn = grns[0];
  const primaryLot = customsLots[0];
  const primaryCustomsItem = customsItems[0];
  const primarySi = salesInvoices[0];
  const primaryCi = customsInvoices[0];
  const primaryDispatch = dispatches[0];

  const flow = [
    {
      stage: "po",
      label: "Purchase Order",
      status: flowStatus(!!primaryPo),
      documentNumber: primaryPo?.poNo || primaryPo?.poNumber || "Not Linked",
      openPath: primaryPo ? openPath("PO", primaryPo) : "",
    },
    {
      stage: "grn",
      label: "GRN",
      status: flowStatus(!!primaryGrn),
      documentNumber: primaryGrn?.grnNo || "Not Linked",
      openPath: primaryGrn ? openPath("GRN", primaryGrn) : "",
    },
    {
      stage: "customsRefs",
      label: "BOE / BL / AWB",
      status: flowStatus(!!(primaryLot?.boeNumber || primaryLot?.blNumber || primaryCustomsItem?.blNumber)),
      documentNumber:
        [primaryLot?.boeNumber || primaryCustomsItem?.boeNumber, primaryLot?.blNumber || primaryCustomsItem?.blNumber, primaryLot?.awbNumber || primaryCustomsItem?.awbNumber]
          .filter(Boolean)
          .join(" / ") || "Not Linked",
      openPath: primaryLot ? openPath("Customs Lot", primaryLot) : "",
    },
    {
      stage: "supplierInvoice",
      label: "Supplier Invoice",
      status: flowStatus(!!(primaryGrn?.supplierInvoiceNo || primaryCustomsItem?.supplierInvoiceNumber)),
      documentNumber:
        primaryGrn?.supplierInvoiceNo || primaryCustomsItem?.supplierInvoiceNumber || primaryLot?.supplierInvoiceNumber || "Not Linked",
      openPath: primaryGrn ? openPath("GRN", primaryGrn) : "",
    },
    {
      stage: "customsStock",
      label: "Customs Stock",
      status: flowStatus(customsItems.length > 0, customsStockQty <= 0 && customsItems.length > 0),
      documentNumber: primaryCustomsItem?.grnNo || primaryCustomsItem?.customsLotRef || "Not Linked",
      openPath: primaryCustomsItem ? openPath("Customs Stock", primaryCustomsItem) : "",
    },
    {
      stage: "customsLedger",
      label: "Customs Ledger",
      status: flowStatus(customsMovements.length > 0),
      documentNumber: customsMovements.length ? `${customsMovements.length} movement(s)` : "Not Linked",
      openPath: openPath("Customs Ledger", { articleNumber: article }),
    },
    {
      stage: "articleConversion",
      label: "Article Conversion",
      status: flowStatus(conversions.length > 0),
      documentNumber: conversions[0]?.conversionNo || "Not Linked",
      openPath: conversions[0]
        ? `/store?tab=${encodeURIComponent("Article Stock Conversion")}&conversionNo=${encodeURIComponent(conversions[0].conversionNo)}`
        : "",
    },
    {
      stage: "salesInvoice",
      label: "Sales Invoice",
      status: flowStatus(!!primarySi),
      documentNumber: primarySi?.invoiceNo || primarySi?.invoiceNumber || "Not Linked",
      openPath: primarySi ? openPath("Sales Invoice", primarySi) : "",
    },
    {
      stage: "customsInvoice",
      label: "Customs Invoice",
      status: flowStatus(!!primaryCi),
      documentNumber: primaryCi?.customsInvoiceNumber || "Not Linked",
      openPath: primaryCi ? openPath("Customs Invoice", primaryCi) : "",
    },
    {
      stage: "dispatch",
      label: "Dispatch",
      status: flowStatus(!!primaryDispatch, pendingDispatchQty > 0),
      documentNumber: primaryDispatch?.dispatchNo || "Not Linked",
      openPath: primaryDispatch ? openPath("Dispatch", primaryDispatch) : "",
    },
  ];

  const timelineEvents = [];

  for (const po of pos) {
    timelineEvents.push({
      date: po.orderDate || po.createdAt,
      stage: "Purchase",
      documentType: "PO",
      documentNumber: po.poNo || po.poNumber,
      party: po.supplierName,
      qtyIn: (po.lines || []).filter((ln) => lineMatchesArticle(ln, article, partNumber)).reduce((s, ln) => s + (Number(ln.qty) || 0), 0),
      qtyOut: 0,
      balance: null,
      status: po.status,
      linkedDocument: grns.find((g) => String(g.poId) === String(po._id))?.grnNo || "Not Linked",
      openPath: openPath("PO", po),
    });
  }
  for (const grn of grns) {
    const qtyIn = (grn.items || [])
      .filter((ln) => lineMatchesArticle(ln, article, partNumber))
      .reduce((s, ln) => s + (Number(ln.acceptedQty) || Number(ln.receivedQty) || 0), 0);
    timelineEvents.push({
      date: grn.grnDate,
      stage: "Inbound",
      documentType: "GRN",
      documentNumber: grn.grnNo,
      party: grn.supplierName,
      qtyIn,
      qtyOut: 0,
      balance: null,
      status: grn.status,
      linkedDocument: grn.poNo || "Not Linked",
      openPath: openPath("GRN", grn),
    });
  }
  for (const lot of customsLots) {
    timelineEvents.push({
      date: lot.supplierInvoiceDate || lot.createdAt,
      stage: "Customs",
      documentType: "Customs Lot",
      documentNumber: lot.customsLotRef,
      party: lot.supplierName,
      qtyIn: null,
      qtyOut: 0,
      balance: null,
      status: lot.status,
      linkedDocument: lot.grnNo || "Not Linked",
      openPath: openPath("Customs Lot", lot),
    });
  }
  let customsBalance = 0;
  for (const mv of customsMovements) {
    const qty = Number(mv.qty) || 0;
    const isIn = ["INBOUND", "REVERSAL"].includes(String(mv.movementType).toUpperCase());
    if (isIn) customsBalance += qty;
    else customsBalance -= qty;
    timelineEvents.push({
      date: mv.movementDate || mv.createdAt,
      stage: "Customs Ledger",
      documentType: mv.movementType,
      documentNumber: mv.referenceNumber || mv.referenceType,
      party: "",
      qtyIn: isIn ? qty : 0,
      qtyOut: isIn ? 0 : qty,
      balance: customsBalance,
      status: mv.movementType,
      linkedDocument: mv.referenceType || "Not Linked",
      openPath: openPath("Customs Ledger", { articleNumber: article }),
    });
  }
  for (const cv of conversions) {
    const isSource = upper(cv.sourceArticle) === article;
    const isReversed = String(cv.status).toUpperCase() === "REVERSED";
    timelineEvents.push({
      date: cv.postedAt || cv.conversionDate || cv.createdAt,
      stage: "Article Conversion",
      documentType: "ARTICLE_CONVERSION",
      documentNumber: cv.conversionNo,
      party: "",
      qtyIn: isSource ? 0 : Number(cv.targetQty) || 0,
      qtyOut: isSource ? Number(cv.sourceQty) || 0 : 0,
      balance: null,
      status: cv.status,
      linkedDocument: isSource
        ? `→ ${cv.targetArticle}`
        : `Origin ${cv.sourceArticle}${cv.lotLayers?.[0]?.grnNo ? ` / GRN ${cv.lotLayers[0].grnNo}` : ""}`,
      openPath: `/store?tab=${encodeURIComponent("Article Stock Conversion")}&conversionNo=${encodeURIComponent(cv.conversionNo)}`,
      meta: {
        sourceArticle: cv.sourceArticle,
        targetArticle: cv.targetArticle,
        sourceQty: cv.sourceQty,
        targetQty: cv.targetQty,
        conversionRatio: cv.conversionRatio,
        reason: cv.reasonCode,
        warehouse: cv.warehouse,
        reversalStatus: isReversed ? "REVERSED" : "ACTIVE",
        originalGrn: cv.lotLayers?.[0]?.grnNo || "",
        originalPo: cv.lotLayers?.[0]?.poNo || "",
        boe: cv.lotLayers?.[0]?.boeNumber || "",
        bl: cv.lotLayers?.[0]?.blNumber || "",
        user: cv.postedBy || cv.createdBy || "",
      },
    });
  }
  for (const si of salesInvoices) {
    const qty = (si.lines || []).filter((ln) => lineMatchesArticle(ln, article, partNumber)).reduce((s, ln) => s + qtyFromLine(ln), 0);
    timelineEvents.push({
      date: si.invoiceDate,
      stage: "Sales",
      documentType: "Sales Invoice",
      documentNumber: si.invoiceNo || si.invoiceNumber,
      party: si.customerName,
      qtyIn: 0,
      qtyOut: qty,
      balance: null,
      status: si.status,
      linkedDocument: customsInvoices.find((c) => String(c.salesInvoiceId) === String(si._id))?.customsInvoiceNumber || "Not Linked",
      openPath: openPath("Sales Invoice", si),
    });
  }
  for (const ci of customsInvoices) {
    const qty = (ci.items || [])
      .filter((it) => upper(it.articleNumber) === article)
      .reduce((s, it) => s + (Number(it.qtyExported) || 0), 0);
    timelineEvents.push({
      date: ci.invoiceDate,
      stage: "Customs",
      documentType: "Customs Invoice",
      documentNumber: ci.customsInvoiceNumber,
      party: ci.customerName,
      qtyIn: 0,
      qtyOut: qty,
      balance: null,
      status: ci.status,
      linkedDocument: ci.salesInvoiceNumber || "Not Linked",
      openPath: openPath("Customs Invoice", ci),
    });
  }
  for (const d of dispatches) {
    const qty = (d.lines || []).filter((ln) => lineMatchesArticle(ln, article, partNumber)).reduce((s, ln) => s + (Number(ln.dispatchQty) || 0), 0);
    timelineEvents.push({
      date: d.dispatchDate,
      stage: "Dispatch",
      documentType: "Dispatch",
      documentNumber: d.dispatchNo,
      party: d.customerName,
      qtyIn: 0,
      qtyOut: qty,
      balance: null,
      status: d.status,
      linkedDocument: d.salesInvoiceNo || d.packingNo || "Not Linked",
      openPath: openPath("Dispatch", d),
    });
  }

  let timeline = buildTimeline(timelineEvents);
  if (filters.dateFrom || filters.dateTo) {
    timeline = timeline.filter((e) => inDateRange(e.date, filters.dateFrom, filters.dateTo));
  }
  if (filters.documentType) {
    const dt = filters.documentType.toLowerCase();
    timeline = timeline.filter((e) => String(e.documentType).toLowerCase().includes(dt));
  }
  if (filters.status) {
    timeline = timeline.filter((e) => upper(e.status).includes(filters.status));
  }

  return {
    found: true,
    query: { ...filters, resolvedArticle: article, resolvedPartNumber: partNumber },
    companyCode,
    summary: {
      company: companyCode,
      articleNumber: article,
      partNumber: partNumber || upper(item?.partNumber) || "—",
      description: item?.itemName || item?.description || "—",
      brand: item?.brand || "—",
      model: item?.model || "—",
      config: item?.config || "—",
      totalPoQty,
      totalGrnQty,
      erpStockQty,
      customsStockQty,
      totalSoldQty,
      pendingDispatchQty,
    },
    flow,
    timeline,
    purchase: purchaseRows,
    customs: customsRows,
    sales: salesRows,
  };
}
