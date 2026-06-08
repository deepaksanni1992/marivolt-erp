/**
 * ERP Data Health — read-only validation engine (no mutations).
 */
import mongoose from "mongoose";
import OrderAcknowledgement from "../models/OrderAcknowledgement.js";
import OrderAllocation from "../models/OrderAllocation.js";
import StorePacking from "../models/StorePacking.js";
import SalesInvoice from "../models/SalesInvoice.js";
import StoreDispatch from "../models/StoreDispatch.js";
import PurchaseOrder from "../models/PurchaseOrder.js";
import GRN from "../models/GRN.js";
import StockBalance from "../models/StockBalance.js";
import CustomsLotItem from "../models/CustomsLotItem.js";
import CustomsInvoice from "../models/CustomsInvoice.js";
import ItemMaster from "../models/itemMasterModel.js";
import Customer from "../models/Customer.js";
import Supplier from "../models/Supplier.js";
import PaymentReceipt from "../models/PaymentReceipt.js";
import PurchaseInvoice from "../models/PurchaseInvoice.js";
import SupplierPayment from "../models/SupplierPayment.js";
import { isCustomsEnabled } from "../config/customsConfig.js";
import { listCustomsReconciliationPage } from "./customsReconciliationService.js";

const EPS = 0.0001;
const ISSUE_CAP_PER_CHECK = 40;

function t(v) {
  return String(v ?? "").trim();
}

function upper(v) {
  return t(v).toUpperCase();
}

function parseNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function withCompany(companyId, filter = {}) {
  const cid = companyId;
  if (cid == null || cid === "") return { ...filter };
  const s = String(cid).trim();
  if (mongoose.Types.ObjectId.isValid(s)) {
    const oid = new mongoose.Types.ObjectId(s);
    if (!Object.keys(filter).length) return { $or: [{ companyId: oid }, { companyId: s }] };
    return { $and: [{ ...filter }, { $or: [{ companyId: oid }, { companyId: s }] }] };
  }
  return { ...filter, companyId: cid };
}

function mkIssue({
  checkId,
  severity,
  module,
  issueType,
  documentNumber,
  reference = "",
  description,
  suggestedAction,
  openPath = "",
  date = null,
  article = "",
  customer = "",
  supplier = "",
}) {
  return {
    checkId,
    severity,
    module,
    issueType,
    documentNumber: t(documentNumber) || "—",
    reference: t(reference) || "—",
    description,
    suggestedAction,
    openPath,
    date,
    article: upper(article),
    customer: t(customer),
    supplier: t(supplier),
  };
}

function capIssues(issues) {
  return issues.slice(0, ISSUE_CAP_PER_CHECK);
}

function parseFilters(raw = {}) {
  const dateFrom = raw.dateFrom ? new Date(raw.dateFrom) : null;
  const dateTo = raw.dateTo ? new Date(raw.dateTo) : null;
  if (dateTo) dateTo.setHours(23, 59, 59, 999);
  return {
    module: t(raw.module),
    severity: t(raw.severity),
    documentNumber: t(raw.documentNumber || raw.q),
    article: upper(raw.article || raw.articleNumber),
    customer: t(raw.customer),
    supplier: t(raw.supplier),
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

function applyFilters(issues, filters) {
  return issues.filter((row) => {
    if (filters.module && !String(row.module).toLowerCase().includes(filters.module.toLowerCase())) return false;
    if (filters.severity && upper(row.severity) !== upper(filters.severity)) return false;
    if (filters.documentNumber) {
      const re = new RegExp(filters.documentNumber.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      if (!re.test(row.documentNumber) && !re.test(row.reference)) return false;
    }
    if (filters.article && row.article !== filters.article) return false;
    if (filters.customer && !String(row.customer).toLowerCase().includes(filters.customer.toLowerCase())) return false;
    if (filters.supplier && !String(row.supplier).toLowerCase().includes(filters.supplier.toLowerCase())) return false;
    if (!inDateRange(row.date, filters.dateFrom, filters.dateTo)) return false;
    return true;
  });
}

function computeHealthScore(issues) {
  let score = 100;
  for (const row of issues) {
    if (row.severity === "Critical") score -= 10;
    else if (row.severity === "Major") score -= 5;
    else score -= 1;
  }
  return Math.max(0, score);
}

function healthRating(score) {
  if (score >= 98) return "Excellent";
  if (score >= 90) return "Good";
  if (score >= 75) return "Warning";
  return "Critical";
}

function buildCharts(issues) {
  const byModule = new Map();
  const bySeverity = new Map();
  const byMonth = new Map();
  const byType = new Map();

  for (const row of issues) {
    byModule.set(row.module, (byModule.get(row.module) || 0) + 1);
    bySeverity.set(row.severity, (bySeverity.get(row.severity) || 0) + 1);
    byType.set(row.issueType, (byType.get(row.issueType) || 0) + 1);
    if (row.date) {
      const d = new Date(row.date);
      if (!Number.isNaN(d.getTime())) {
        const m = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
        byMonth.set(m, (byMonth.get(m) || 0) + 1);
      }
    }
  }

  return {
    byModule: [...byModule.entries()].map(([module, count]) => ({ module, count })),
    bySeverity: [...bySeverity.entries()].map(([severity, count]) => ({ severity, count })),
    byMonth: [...byMonth.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([month, count]) => ({ month, count })),
    topProblemAreas: [...byType.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([issueType, count]) => ({ issueType, count })),
  };
}

async function entityCounts(companyId) {
  const base = (Model, extra = {}) => Model.countDocuments(withCompany(companyId, extra));
  const [
    salesCount,
    purchaseCount,
    grnCount,
    inventoryCount,
    customsCount,
    customerCount,
    supplierCount,
    articleCount,
  ] = await Promise.all([
    SalesInvoice.countDocuments(withCompany(companyId, { status: { $ne: "CANCELLED" } })),
    PurchaseOrder.countDocuments(withCompany(companyId, { status: { $ne: "CANCELLED" } })),
    GRN.countDocuments(withCompany(companyId, { status: { $ne: "CANCELLED" } })),
    StockBalance.countDocuments(withCompany(companyId, {})),
    CustomsLotItem.countDocuments(withCompany(companyId, { status: { $ne: "CANCELLED" } })),
    Customer.countDocuments(withCompany(companyId, {})),
    Supplier.countDocuments(withCompany(companyId, {})),
    ItemMaster.countDocuments(withCompany(companyId, { status: "Active" })),
  ]);
  return { salesCount, purchaseCount, grnCount, inventoryCount, customsCount, customerCount, supplierCount, articleCount };
}

async function runSalesChecks(companyId) {
  const issues = [];
  const active = { status: { $nin: ["CANCELLED", "DRAFT"] } };

  const [oas, allocations, packings, invoices, dispatches] = await Promise.all([
    OrderAcknowledgement.find(withCompany(companyId, active)).select("oaNo oaDate status").lean(),
    OrderAllocation.find(withCompany(companyId, active)).select("allocationNo linkedOAId allocationDate").lean(),
    StorePacking.find(withCompany(companyId, { status: { $ne: "CANCELLED" } }))
      .select("packingNo allocationId invoiceStatus linkedSalesInvoiceNos packingDate status")
      .lean(),
    SalesInvoice.find(withCompany(companyId, { status: { $nin: ["CANCELLED", "DRAFT"] } }))
      .select("invoiceNo invoiceDate linkedStorePackingId linkedOrderAllocationId")
      .lean(),
    StoreDispatch.find(withCompany(companyId, { status: { $ne: "CANCELLED" } }))
      .select("dispatchNo salesInvoiceId salesInvoiceNo dispatchDate status")
      .lean(),
  ]);

  const allocByOa = new Set(allocations.map((a) => String(a.linkedOAId)).filter(Boolean));
  const packingByAlloc = new Set(packings.map((p) => String(p.allocationId)).filter(Boolean));
  const siByPacking = new Set(invoices.map((i) => String(i.linkedStorePackingId)).filter(Boolean));
  const dispatchBySi = new Set(dispatches.map((d) => String(d.salesInvoiceId)).filter(Boolean));
  const siIds = new Set(invoices.map((i) => String(i._id)));

  for (const oa of oas) {
    if (!allocByOa.has(String(oa._id))) {
      issues.push(
        mkIssue({
          checkId: 1,
          severity: "Major",
          module: "Sales",
          issueType: "OA_WITHOUT_ALLOCATION",
          documentNumber: oa.oaNo,
          description: "Order Acknowledgement exists without a linked allocation",
          suggestedAction: "Create allocation from OA or cancel obsolete OA",
          openPath: `/sales?tab=${encodeURIComponent("Order Acknowledgement")}`,
          date: oa.oaDate,
        }),
      );
    }
  }

  for (const alloc of allocations) {
    if (!packingByAlloc.has(String(alloc._id))) {
      issues.push(
        mkIssue({
          checkId: 2,
          severity: "Major",
          module: "Sales",
          issueType: "ALLOCATION_WITHOUT_PACKING",
          documentNumber: alloc.allocationNo,
          reference: alloc.linkedOANo || "",
          description: "Allocation exists without store packing",
          suggestedAction: "Create packing from allocation",
          openPath: "/store?tab=Packing",
          date: alloc.allocationDate,
        }),
      );
    }
  }

  for (const pk of packings) {
    const hasSi =
      (pk.linkedSalesInvoiceNos || []).length > 0 ||
      siByPacking.has(String(pk._id)) ||
      String(pk.invoiceStatus || "").toUpperCase().includes("FULL");
    if (!hasSi && String(pk.status || "").toUpperCase() !== "DRAFT") {
      issues.push(
        mkIssue({
          checkId: 3,
          severity: "Critical",
          module: "Sales",
          issueType: "PACKING_WITHOUT_INVOICE",
          documentNumber: pk.packingNo,
          description: "Packing exists without sales invoice",
          suggestedAction: "Create sales invoice from packing",
          openPath: `/store?tab=Packing&packingNo=${encodeURIComponent(pk.packingNo)}`,
          date: pk.packingDate,
        }),
      );
    }
  }

  for (const si of invoices) {
    if (!dispatchBySi.has(String(si._id))) {
      issues.push(
        mkIssue({
          checkId: 4,
          severity: "Major",
          module: "Sales",
          issueType: "INVOICE_WITHOUT_DISPATCH",
          documentNumber: si.invoiceNo,
          description: "Sales invoice exists without dispatch record",
          suggestedAction: "Create dispatch from packing/invoice",
          openPath: `/sales?tab=${encodeURIComponent("Sales Invoice")}&id=${si._id}`,
          date: si.invoiceDate,
        }),
      );
    }
  }

  for (const d of dispatches) {
    if (!d.salesInvoiceId || !siIds.has(String(d.salesInvoiceId))) {
      issues.push(
        mkIssue({
          checkId: 5,
          severity: "Critical",
          module: "Sales",
          issueType: "DISPATCH_WITHOUT_INVOICE",
          documentNumber: d.dispatchNo,
          reference: d.salesInvoiceNo || "",
          description: "Dispatch exists without valid sales invoice link",
          suggestedAction: "Link dispatch to sales invoice or cancel dispatch",
          openPath: `/store?tab=Dispatch&dispatchNo=${encodeURIComponent(d.dispatchNo)}`,
          date: d.dispatchDate,
        }),
      );
    }
  }

  return capIssues(issues);
}

async function runPurchaseChecks(companyId) {
  const issues = [];
  const [grns, pos] = await Promise.all([
    GRN.find(withCompany(companyId, { status: { $ne: "CANCELLED" } }))
      .select("grnNo poId poNo grnDate items status")
      .lean(),
    PurchaseOrder.find(withCompany(companyId, { status: { $ne: "CANCELLED" } }))
      .select("poNo poNumber status lines orderDate")
      .lean(),
  ]);

  const poMap = new Map(pos.map((p) => [String(p._id), p]));

  for (const grn of grns) {
    if (!grn.poId && !grn.poNo) {
      issues.push(
        mkIssue({
          checkId: 6,
          severity: "Critical",
          module: "Purchase",
          issueType: "GRN_WITHOUT_PO",
          documentNumber: grn.grnNo,
          description: "GRN posted without purchase order reference",
          suggestedAction: "Link GRN to PO or review inbound source",
          openPath: `/store?tab=GRN&grnNo=${encodeURIComponent(grn.grnNo)}`,
          date: grn.grnDate,
          supplier: grn.supplierName,
        }),
      );
    }

    const po = poMap.get(String(grn.poId));
    if (po) {
      for (const item of grn.items || []) {
        const poLine = (po.lines || []).find(
          (ln) => String(ln._id) === String(item.poLineId) || upper(ln.article || ln.itemCode) === upper(item.article),
        );
        const ordered = parseNum(poLine?.qty);
        const received = parseNum(item.acceptedQty || item.receivedQty);
        if (ordered > EPS && received > ordered + EPS) {
          issues.push(
            mkIssue({
              checkId: 8,
              severity: "Critical",
              module: "Purchase",
              issueType: "GRN_EXCEEDS_PO",
              documentNumber: grn.grnNo,
              reference: po.poNo || po.poNumber,
              description: `GRN qty ${received} exceeds PO ordered qty ${ordered} for ${item.article}`,
              suggestedAction: "Review GRN line quantities against PO",
              openPath: `/store?tab=GRN&grnNo=${encodeURIComponent(grn.grnNo)}`,
              date: grn.grnDate,
              article: item.article,
            }),
          );
        }
      }
    }
  }

  for (const po of pos) {
    const lines = po.lines || [];
    const allReceived = lines.length > 0 && lines.every((ln) => parseNum(ln.receivedQty) >= parseNum(ln.qty) - EPS);
    const status = upper(po.status);
    if (allReceived && !["RECEIVED", "CLOSED", "COMPLETED", "FULLY_RECEIVED"].includes(status)) {
      issues.push(
        mkIssue({
          checkId: 7,
          severity: "Minor",
          module: "Purchase",
          issueType: "PO_STATUS_NOT_UPDATED",
          documentNumber: po.poNo || po.poNumber,
          description: "PO fully received but status not updated",
          suggestedAction: "Update PO status to received/closed",
          openPath: `/purchase?tab=orders&id=${po._id}`,
          date: po.orderDate,
        }),
      );
    }
  }

  return capIssues(issues);
}

async function runInventoryChecks(companyId) {
  const issues = [];
  const rows = await StockBalance.find(withCompany(companyId, {}))
    .select("article warehouse location onHandQty allocatedQty reservedQty rtsQty packedQty dispatchedQty availableQty")
    .lean();

  for (const row of rows) {
    const onHand = parseNum(row.onHandQty ?? row.quantity);
    const allocated = Math.max(parseNum(row.allocatedQty), parseNum(row.reservedQty));
    const rts = parseNum(row.rtsQty);
    const packed = parseNum(row.packedQty);
    const dispatched = parseNum(row.dispatchedQty);
    const available = parseNum(row.availableQty ?? onHand - allocated - rts - packed);

    if (available < -EPS || onHand < -EPS) {
      issues.push(
        mkIssue({
          checkId: 9,
          severity: "Critical",
          module: "Inventory",
          issueType: "NEGATIVE_INVENTORY",
          documentNumber: row.article,
          reference: row.warehouse || row.location,
          description: `Negative stock: available=${available}, onHand=${onHand}`,
          suggestedAction: "Run stock reconciliation and correct ledger",
          openPath: `/store?tab=Stock`,
          article: row.article,
        }),
      );
    }
    if (allocated > onHand + EPS) {
      issues.push(
        mkIssue({
          checkId: 10,
          severity: "Critical",
          module: "Inventory",
          issueType: "ALLOCATED_EXCEEDS_AVAILABLE",
          documentNumber: row.article,
          reference: row.warehouse || row.location,
          description: `Allocated ${allocated} exceeds on-hand ${onHand}`,
          suggestedAction: "Review allocations and stock reservations",
          openPath: `/store?tab=Stock`,
          article: row.article,
        }),
      );
    }
    if (packed > allocated + EPS) {
      issues.push(
        mkIssue({
          checkId: 11,
          severity: "Critical",
          module: "Inventory",
          issueType: "PACKED_EXCEEDS_ALLOCATED",
          documentNumber: row.article,
          reference: row.warehouse || row.location,
          description: `Packed ${packed} exceeds allocated ${allocated}`,
          suggestedAction: "Review packing vs allocation quantities",
          openPath: `/store?tab=Packing`,
          article: row.article,
        }),
      );
    }
    if (dispatched > packed + onHand + EPS) {
      issues.push(
        mkIssue({
          checkId: 12,
          severity: "Critical",
          module: "Inventory",
          issueType: "DISPATCHED_EXCEEDS_INVOICED",
          documentNumber: row.article,
          reference: row.warehouse || row.location,
          description: `Dispatched qty ${dispatched} may exceed invoiced/packed levels`,
          suggestedAction: "Verify dispatch quantities against invoice lines",
          openPath: `/store?tab=Dispatch`,
          article: row.article,
        }),
      );
    }
    if (!t(row.warehouse) && !t(row.location)) {
      issues.push(
        mkIssue({
          checkId: 13,
          severity: "Major",
          module: "Inventory",
          issueType: "MISSING_WAREHOUSE",
          documentNumber: row.article,
          description: "Inventory balance missing warehouse/location",
          suggestedAction: "Assign warehouse to stock balance record",
          openPath: `/store?tab=Stock`,
          article: row.article,
        }),
      );
    }
  }

  return capIssues(issues);
}

async function runCustomsChecks(companyId, companyCode) {
  if (!isCustomsEnabled()) return [];

  const issues = [];
  const recon = await listCustomsReconciliationPage(companyId, companyCode, {}, { page: 1, limit: 500, exportAll: true });
  for (const row of recon.items || []) {
    if (row.status !== "MATCH") {
      issues.push(
        mkIssue({
          checkId: 14,
          severity: "Critical",
          module: "Customs",
          issueType: "ERP_CUSTOMS_STOCK_MISMATCH",
          documentNumber: row.article,
          reference: row.partNumber,
          description: `ERP ${row.erpStock} vs Customs ${row.customsStock} (${row.status})`,
          suggestedAction: row.actionRequired || "Review customs reconciliation",
          openPath: `/customs/reconciliation?article=${encodeURIComponent(row.article)}`,
          article: row.article,
        }),
      );
    }
  }

  const [sis, cis, lotItems] = await Promise.all([
    SalesInvoice.find(withCompany(companyId, { status: { $nin: ["CANCELLED", "DRAFT"] } }))
      .select("invoiceNo invoiceDate")
      .lean(),
    CustomsInvoice.find(withCompany(companyId, { status: { $ne: "CANCELLED" } }))
      .select("customsInvoiceNumber salesInvoiceId salesInvoiceNumber invoiceDate")
      .lean(),
    CustomsLotItem.find(withCompany(companyId, { status: { $ne: "CANCELLED" } }))
      .select("articleNumber blNumber boeNumber qtyImported qtyConsumed qtyAvailable supplierInvoiceDate")
      .lean(),
  ]);

  const ciBySi = new Set(cis.map((c) => String(c.salesInvoiceId)).filter(Boolean));
  const siById = new Map(sis.map((s) => [String(s._id), s]));

  for (const si of sis) {
    if (!ciBySi.has(String(si._id))) {
      issues.push(
        mkIssue({
          checkId: 15,
          severity: "Major",
          module: "Customs",
          issueType: "SI_WITHOUT_CUSTOMS_INVOICE",
          documentNumber: si.invoiceNo,
          description: "Sales invoice without customs invoice",
          suggestedAction: "Create customs invoice from sales invoice",
          openPath: `/sales?tab=${encodeURIComponent("Sales Invoice")}&id=${si._id}`,
          date: si.invoiceDate,
        }),
      );
    }
  }

  for (const ci of cis) {
    if (!ci.salesInvoiceId || !siById.has(String(ci.salesInvoiceId))) {
      issues.push(
        mkIssue({
          checkId: 16,
          severity: "Critical",
          module: "Customs",
          issueType: "CUSTOMS_INVOICE_WITHOUT_SI",
          documentNumber: ci.customsInvoiceNumber,
          reference: ci.salesInvoiceNumber,
          description: "Customs invoice without valid sales invoice link",
          suggestedAction: "Link or cancel orphaned customs invoice",
          openPath: `/customs/invoices/${ci._id}`,
          date: ci.invoiceDate,
        }),
      );
    }
  }

  for (const it of lotItems) {
    if (parseNum(it.qtyAvailable) > EPS && !t(it.blNumber)) {
      issues.push(
        mkIssue({
          checkId: 17,
          severity: "Major",
          module: "Customs",
          issueType: "MISSING_BL_NUMBER",
          documentNumber: it.articleNumber,
          description: "Customs stock item missing BL number",
          suggestedAction: "Update BL on customs lot/GRN",
          openPath: `/customs/stock?articleNumber=${encodeURIComponent(it.articleNumber)}`,
          article: it.articleNumber,
          date: it.supplierInvoiceDate,
        }),
      );
    }
    if (parseNum(it.qtyAvailable) > EPS && !t(it.boeNumber)) {
      issues.push(
        mkIssue({
          checkId: 18,
          severity: "Major",
          module: "Customs",
          issueType: "MISSING_BOE_NUMBER",
          documentNumber: it.articleNumber,
          description: "Customs stock item missing BOE number",
          suggestedAction: "Update BOE on customs lot",
          openPath: `/customs/stock?articleNumber=${encodeURIComponent(it.articleNumber)}`,
          article: it.articleNumber,
          date: it.supplierInvoiceDate,
        }),
      );
    }
    if (parseNum(it.qtyConsumed) > parseNum(it.qtyImported) + EPS) {
      issues.push(
        mkIssue({
          checkId: 19,
          severity: "Critical",
          module: "Customs",
          issueType: "CONSUMED_EXCEEDS_IMPORTED",
          documentNumber: it.articleNumber,
          description: `Consumed ${it.qtyConsumed} exceeds imported ${it.qtyImported}`,
          suggestedAction: "Review customs consumption movements",
          openPath: `/customs/ledger?article=${encodeURIComponent(it.articleNumber)}`,
          article: it.articleNumber,
        }),
      );
    }
  }

  return capIssues(issues);
}

async function runMasterDataChecks(companyId) {
  const issues = [];
  const items = await ItemMaster.find(withCompany(companyId, { status: "Active" }))
    .select("article partNumber supplierPartNumber supplier vertical brand model")
    .lean();

  const articleSeen = new Map();
  const spnSeen = new Map();

  for (const it of items) {
    const art = upper(it.article);
    if (articleSeen.has(art)) {
      issues.push(
        mkIssue({
          checkId: 20,
          severity: "Critical",
          module: "Master Data",
          issueType: "DUPLICATE_ARTICLE",
          documentNumber: art,
          reference: articleSeen.get(art),
          description: "Duplicate article number in item master",
          suggestedAction: "Merge or deactivate duplicate item",
          openPath: `/items?article=${encodeURIComponent(art)}`,
          article: art,
        }),
      );
    } else articleSeen.set(art, art);

    const spn = upper(it.supplierPartNumber || it.spn);
    if (spn) {
      const key = spn;
      if (spnSeen.has(key)) {
        issues.push(
          mkIssue({
            checkId: 21,
            severity: "Major",
            module: "Master Data",
            issueType: "DUPLICATE_SUPPLIER_PART",
            documentNumber: art,
            reference: spnSeen.get(key),
            description: `Duplicate supplier part number ${spn}`,
            suggestedAction: "Review supplier part mapping",
            openPath: `/items?article=${encodeURIComponent(art)}`,
            article: art,
          }),
        );
      } else spnSeen.set(key, art);
    }

    if (!t(it.supplier)) {
      issues.push(
        mkIssue({
          checkId: 22,
          severity: "Major",
          module: "Master Data",
          issueType: "ITEM_WITHOUT_SUPPLIER",
          documentNumber: art,
          description: "Item master record missing supplier",
          suggestedAction: "Assign supplier on item master",
          openPath: `/items?article=${encodeURIComponent(art)}`,
          article: art,
        }),
      );
    }
    if (!t(it.vertical)) {
      issues.push(
        mkIssue({
          checkId: 23,
          severity: "Minor",
          module: "Master Data",
          issueType: "ITEM_WITHOUT_VERTICAL",
          documentNumber: art,
          description: "Item missing vertical classification",
          suggestedAction: "Complete item master vertical field",
          openPath: `/items?article=${encodeURIComponent(art)}`,
          article: art,
        }),
      );
    }
    if (!t(it.brand)) {
      issues.push(
        mkIssue({
          checkId: 24,
          severity: "Minor",
          module: "Master Data",
          issueType: "ITEM_WITHOUT_BRAND",
          documentNumber: art,
          description: "Item missing brand",
          suggestedAction: "Complete item master brand field",
          openPath: `/items?article=${encodeURIComponent(art)}`,
          article: art,
        }),
      );
    }
    if (!t(it.model)) {
      issues.push(
        mkIssue({
          checkId: 25,
          severity: "Minor",
          module: "Master Data",
          issueType: "ITEM_WITHOUT_MODEL",
          documentNumber: art,
          description: "Item missing model",
          suggestedAction: "Complete item master model field",
          openPath: `/items?article=${encodeURIComponent(art)}`,
          article: art,
        }),
      );
    }
  }

  return capIssues(issues);
}

async function runAccountsChecks(companyId) {
  const issues = [];
  const [sis, receipts, pis, payments] = await Promise.all([
    SalesInvoice.find(withCompany(companyId, { status: { $nin: ["CANCELLED", "DRAFT"] } }))
      .select("invoiceNo grandTotal totalReceivedAmount balanceAmount paymentStatus customerName invoiceDate")
      .lean(),
    PaymentReceipt.find(withCompany(companyId, { status: { $ne: "CANCELLED" } }))
      .select("receiptNo amountReceived allocatedAmount unallocatedAmount paymentReference customerName receiptDate allocations")
      .lean(),
    PurchaseInvoice.find(withCompany(companyId, { status: { $ne: "CANCELLED" } }))
      .select("invoiceNumber totalAmount totalPaidAmount balanceAmount supplierName invoiceDate")
      .lean(),
    SupplierPayment.find(withCompany(companyId, { status: { $ne: "CANCELLED" } }))
      .select("paymentNo amountPaid supplierName paymentDate")
      .lean(),
  ]);

  for (const si of sis) {
    const total = parseNum(si.grandTotal);
    const paid = parseNum(si.totalReceivedAmount);
    const balance = parseNum(si.balanceAmount);
    const expected = Math.max(0, total - paid);
    if (Math.abs(expected - balance) > 0.02) {
      issues.push(
        mkIssue({
          checkId: 26,
          severity: "Critical",
          module: "Accounts",
          issueType: "CUSTOMER_OUTSTANDING_MISMATCH",
          documentNumber: si.invoiceNo,
          description: `Balance ${balance} does not match total-paid (${expected})`,
          suggestedAction: "Recalculate customer outstanding from receipts",
          openPath: `/accounts?tab=receivables`,
          date: si.invoiceDate,
          customer: si.customerName,
        }),
      );
    }
    if (paid > total + 0.02) {
      issues.push(
        mkIssue({
          checkId: 28,
          severity: "Critical",
          module: "Accounts",
          issueType: "PAID_EXCEEDS_INVOICE",
          documentNumber: si.invoiceNo,
          description: `Paid ${paid} exceeds invoice value ${total}`,
          suggestedAction: "Review payment allocations",
          openPath: `/accounts?tab=receivables`,
          date: si.invoiceDate,
          customer: si.customerName,
        }),
      );
    }
  }

  for (const pi of pis) {
    const total = parseNum(pi.totalAmount);
    const paid = parseNum(pi.totalPaidAmount);
    const balance = parseNum(pi.balanceAmount);
    const expected = Math.max(0, total - paid);
    if (Math.abs(expected - balance) > 0.02) {
      issues.push(
        mkIssue({
          checkId: 27,
          severity: "Critical",
          module: "Accounts",
          issueType: "SUPPLIER_OUTSTANDING_MISMATCH",
          documentNumber: pi.invoiceNumber,
          description: `AP balance ${balance} does not match total-paid (${expected})`,
          suggestedAction: "Recalculate supplier outstanding",
          openPath: `/accounts?tab=payables`,
          date: pi.invoiceDate,
          supplier: pi.supplierName,
        }),
      );
    }
    if (paid > total + 0.02) {
      issues.push(
        mkIssue({
          checkId: 28,
          severity: "Critical",
          module: "Accounts",
          issueType: "PAID_EXCEEDS_INVOICE",
          documentNumber: pi.invoiceNumber,
          description: `Supplier paid ${paid} exceeds invoice ${total}`,
          suggestedAction: "Review supplier payment allocations",
          openPath: `/accounts?tab=payables`,
          date: pi.invoiceDate,
          supplier: pi.supplierName,
        }),
      );
    }
  }

  for (const rc of receipts) {
    if (!t(rc.paymentReference)) {
      issues.push(
        mkIssue({
          checkId: 29,
          severity: "Major",
          module: "Accounts",
          issueType: "PAYMENT_WITHOUT_REFERENCE",
          documentNumber: rc.receiptNo,
          description: "Payment receipt missing bank/payment reference",
          suggestedAction: "Add payment reference for audit trail",
          openPath: `/accounts?tab=receipts`,
          date: rc.receiptDate,
          customer: rc.customerName,
        }),
      );
    }
  }

  return capIssues(issues);
}

export async function buildDataHealthDashboard(companyId, companyCode = "", rawFilters = {}) {
  const filters = parseFilters(rawFilters);

  const [counts, salesIssues, purchaseIssues, inventoryIssues, customsIssues, masterIssues, accountsIssues] =
    await Promise.all([
      entityCounts(companyId),
      runSalesChecks(companyId),
      runPurchaseChecks(companyId),
      runInventoryChecks(companyId),
      runCustomsChecks(companyId, companyCode),
      runMasterDataChecks(companyId),
      runAccountsChecks(companyId),
    ]);

  let issues = [
    ...salesIssues,
    ...purchaseIssues,
    ...inventoryIssues,
    ...customsIssues,
    ...masterIssues,
    ...accountsIssues,
  ];

  const criticalCount = issues.filter((i) => i.severity === "Critical").length;
  const majorCount = issues.filter((i) => i.severity === "Major").length;
  const minorCount = issues.filter((i) => i.severity === "Minor").length;
  const healthScore = computeHealthScore(issues);
  const rating = healthRating(healthScore);

  issues = applyFilters(issues, filters);

  const charts = buildCharts(issues);

  return {
    generatedAt: new Date().toISOString(),
    companyCode,
    filters,
    counts,
    healthScore,
    healthRating: rating,
    criticalCount,
    majorCount,
    minorCount,
    totalIssues: issues.length,
    issues,
    charts,
  };
}
