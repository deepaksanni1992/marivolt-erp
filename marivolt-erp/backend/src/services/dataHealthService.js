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
import { getCustomsReconciliationMismatches } from "./customsReconciliationService.js";

const EPS = 0.0001;
const ISSUE_CAP_PER_CHECK = 40;
const CACHE_MS = Number(process.env.DATA_HEALTH_CACHE_MS) || 5 * 60 * 1000;

const scanCache = new Map();

function col(Model) {
  return Model.collection.name;
}

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

function hasActiveFilters(filters) {
  return !!(
    filters.module ||
    filters.severity ||
    filters.documentNumber ||
    filters.article ||
    filters.customer ||
    filters.supplier ||
    filters.dateFrom ||
    filters.dateTo
  );
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

function countBySeverity(issues) {
  let criticalCount = 0;
  let majorCount = 0;
  let minorCount = 0;
  for (const row of issues) {
    if (row.severity === "Critical") criticalCount += 1;
    else if (row.severity === "Major") majorCount += 1;
    else minorCount += 1;
  }
  return { criticalCount, majorCount, minorCount };
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

const ACTIVE_SALES = { status: { $nin: ["CANCELLED", "DRAFT"] } };

async function runSalesChecks(companyId) {
  const issues = [];
  const base = withCompany(companyId, ACTIVE_SALES);

  const [oaRows, allocRows, packingRows, invoiceRows, dispatchRows] = await Promise.all([
    OrderAcknowledgement.aggregate([
      { $match: base },
      {
        $lookup: {
          from: col(OrderAllocation),
          localField: "_id",
          foreignField: "linkedOAId",
          as: "allocs",
        },
      },
      { $match: { allocs: { $size: 0 } } },
      { $limit: ISSUE_CAP_PER_CHECK },
      { $project: { oaNo: 1, oaDate: 1 } },
    ]),
    OrderAllocation.aggregate([
      { $match: withCompany(companyId, ACTIVE_SALES) },
      {
        $lookup: {
          from: col(StorePacking),
          localField: "_id",
          foreignField: "allocationId",
          as: "packings",
        },
      },
      { $match: { packings: { $size: 0 } } },
      { $limit: ISSUE_CAP_PER_CHECK },
      { $project: { allocationNo: 1, linkedOANo: 1, allocationDate: 1 } },
    ]),
    StorePacking.aggregate([
      { $match: withCompany(companyId, { status: { $ne: "CANCELLED" } }) },
      {
        $lookup: {
          from: col(SalesInvoice),
          localField: "_id",
          foreignField: "linkedStorePackingId",
          as: "sis",
        },
      },
      {
        $addFields: {
          hasSi: {
            $or: [
              { $gt: [{ $size: { $ifNull: ["$linkedSalesInvoiceNos", []] } }, 0] },
              { $gt: [{ $size: "$sis" }, 0] },
              {
                $regexMatch: {
                  input: { $ifNull: ["$invoiceStatus", ""] },
                  regex: "FULL",
                  options: "i",
                },
              },
            ],
          },
        },
      },
      { $match: { hasSi: false, status: { $nin: ["DRAFT", "CANCELLED"] } } },
      { $limit: ISSUE_CAP_PER_CHECK },
      { $project: { packingNo: 1, packingDate: 1 } },
    ]),
    SalesInvoice.aggregate([
      { $match: withCompany(companyId, { status: { $nin: ["CANCELLED", "DRAFT"] } }) },
      {
        $lookup: {
          from: col(StoreDispatch),
          localField: "_id",
          foreignField: "salesInvoiceId",
          as: "dispatches",
        },
      },
      { $match: { dispatches: { $size: 0 } } },
      { $limit: ISSUE_CAP_PER_CHECK },
      { $project: { invoiceNo: 1, invoiceDate: 1, _id: 1 } },
    ]),
    StoreDispatch.aggregate([
      { $match: withCompany(companyId, { status: { $ne: "CANCELLED" } }) },
      {
        $lookup: {
          from: col(SalesInvoice),
          localField: "salesInvoiceId",
          foreignField: "_id",
          as: "si",
        },
      },
      {
        $match: {
          $or: [{ salesInvoiceId: null }, { salesInvoiceId: { $exists: false } }, { si: { $size: 0 } }],
        },
      },
      { $limit: ISSUE_CAP_PER_CHECK },
      { $project: { dispatchNo: 1, salesInvoiceNo: 1, dispatchDate: 1 } },
    ]),
  ]);

  for (const oa of oaRows) {
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

  for (const alloc of allocRows) {
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

  for (const pk of packingRows) {
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

  for (const si of invoiceRows) {
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

  for (const d of dispatchRows) {
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

  return capIssues(issues);
}

async function runPurchaseChecks(companyId) {
  const issues = [];
  const [grnWithoutPo, poStatusRows, grnExceedRows] = await Promise.all([
    GRN.aggregate([
      {
        $match: withCompany(companyId, {
          status: { $ne: "CANCELLED" },
          $and: [
            { $or: [{ poId: null }, { poId: { $exists: false } }, { poId: "" }] },
            { $or: [{ poNo: null }, { poNo: { $exists: false } }, { poNo: "" }] },
          ],
        }),
      },
      { $limit: ISSUE_CAP_PER_CHECK },
      { $project: { grnNo: 1, grnDate: 1, supplierName: 1 } },
    ]),
    PurchaseOrder.aggregate([
      { $match: withCompany(companyId, { status: { $ne: "CANCELLED" } }) },
      {
        $addFields: {
          allReceived: {
            $cond: [
              { $gt: [{ $size: { $ifNull: ["$lines", []] } }, 0] },
              {
                $allElementsTrue: {
                  $map: {
                    input: { $ifNull: ["$lines", []] },
                    as: "ln",
                    in: { $gte: [{ $ifNull: ["$$ln.receivedQty", 0] }, { $ifNull: ["$$ln.qty", 0] }] },
                  },
                },
              },
              false,
            ],
          },
        },
      },
      {
        $match: {
          allReceived: true,
          status: { $nin: ["RECEIVED", "CLOSED", "COMPLETED", "FULLY_RECEIVED"] },
        },
      },
      { $limit: ISSUE_CAP_PER_CHECK },
      { $project: { poNo: 1, poNumber: 1, orderDate: 1, _id: 1 } },
    ]),
    GRN.aggregate([
      { $match: withCompany(companyId, { status: { $ne: "CANCELLED" }, poId: { $exists: true, $ne: null } }) },
      {
        $lookup: {
          from: col(PurchaseOrder),
          localField: "poId",
          foreignField: "_id",
          as: "po",
        },
      },
      { $unwind: "$po" },
      { $unwind: "$items" },
      {
        $addFields: {
          poLine: {
            $arrayElemAt: [
              {
                $filter: {
                  input: { $ifNull: ["$po.lines", []] },
                  as: "ln",
                  cond: {
                    $or: [
                      { $eq: ["$$ln._id", "$items.poLineId"] },
                      {
                        $eq: [
                          { $toUpper: { $ifNull: ["$$ln.article", "$$ln.itemCode"] } },
                          { $toUpper: { $ifNull: ["$items.article", ""] } },
                        ],
                      },
                    ],
                  },
                },
              },
              0,
            ],
          },
        },
      },
      {
        $addFields: {
          ordered: { $ifNull: ["$poLine.qty", 0] },
          received: { $ifNull: ["$items.acceptedQty", { $ifNull: ["$items.receivedQty", 0] }] },
        },
      },
      { $match: { $expr: { $and: [{ $gt: ["$ordered", EPS] }, { $gt: ["$received", { $add: ["$ordered", EPS] }] }] } } },
      { $limit: ISSUE_CAP_PER_CHECK },
      {
        $project: {
          grnNo: 1,
          grnDate: 1,
          article: "$items.article",
          poNo: "$po.poNo",
          poNumber: "$po.poNumber",
          ordered: 1,
          received: 1,
        },
      },
    ]),
  ]);

  for (const grn of grnWithoutPo) {
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

  for (const po of poStatusRows) {
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

  for (const row of grnExceedRows) {
    issues.push(
      mkIssue({
        checkId: 8,
        severity: "Critical",
        module: "Purchase",
        issueType: "GRN_EXCEEDS_PO",
        documentNumber: row.grnNo,
        reference: row.poNo || row.poNumber,
        description: `GRN qty ${row.received} exceeds PO ordered qty ${row.ordered} for ${row.article}`,
        suggestedAction: "Review GRN line quantities against PO",
        openPath: `/store?tab=GRN&grnNo=${encodeURIComponent(row.grnNo)}`,
        date: row.grnDate,
        article: row.article,
      }),
    );
  }

  return capIssues(issues);
}

async function runInventoryChecks(companyId) {
  const issues = [];
  const match = withCompany(companyId, {});

  const [negative, allocatedExceeds, packedExceeds, dispatchedExceeds, missingWarehouse] = await Promise.all([
    StockBalance.aggregate([
      { $match: match },
      {
        $addFields: {
          onHand: { $ifNull: ["$onHandQty", "$quantity"] },
          allocated: { $max: [{ $ifNull: ["$allocatedQty", 0] }, { $ifNull: ["$reservedQty", 0] }] },
          available: {
            $ifNull: [
              "$availableQty",
              {
                $subtract: [
                  { $ifNull: ["$onHandQty", "$quantity"] },
                  {
                    $add: [
                      { $max: [{ $ifNull: ["$allocatedQty", 0] }, { $ifNull: ["$reservedQty", 0] }] },
                      { $ifNull: ["$packedQty", 0] },
                    ],
                  },
                ],
              },
            ],
          },
        },
      },
      { $match: { $expr: { $or: [{ $lt: ["$available", -EPS] }, { $lt: ["$onHand", -EPS] }] } } },
      { $limit: ISSUE_CAP_PER_CHECK },
      { $project: { article: 1, warehouse: 1, location: 1, available: 1, onHand: 1 } },
    ]),
    StockBalance.aggregate([
      { $match: match },
      {
        $addFields: {
          onHand: { $ifNull: ["$onHandQty", "$quantity"] },
          allocated: { $max: [{ $ifNull: ["$allocatedQty", 0] }, { $ifNull: ["$reservedQty", 0] }] },
        },
      },
      { $match: { $expr: { $gt: ["$allocated", { $add: ["$onHand", EPS] }] } } },
      { $limit: ISSUE_CAP_PER_CHECK },
      { $project: { article: 1, warehouse: 1, location: 1, allocated: 1, onHand: 1 } },
    ]),
    StockBalance.aggregate([
      { $match: match },
      {
        $addFields: {
          allocated: { $max: [{ $ifNull: ["$allocatedQty", 0] }, { $ifNull: ["$reservedQty", 0] }] },
          packed: { $ifNull: ["$packedQty", 0] },
        },
      },
      { $match: { $expr: { $gt: ["$packed", { $add: ["$allocated", EPS] }] } } },
      { $limit: ISSUE_CAP_PER_CHECK },
      { $project: { article: 1, warehouse: 1, location: 1, packed: 1, allocated: 1 } },
    ]),
    StockBalance.aggregate([
      { $match: match },
      {
        $addFields: {
          onHand: { $ifNull: ["$onHandQty", "$quantity"] },
          packed: { $ifNull: ["$packedQty", 0] },
          dispatched: { $ifNull: ["$dispatchedQty", 0] },
        },
      },
      { $match: { $expr: { $gt: ["$dispatched", { $add: ["$packed", "$onHand", EPS] }] } } },
      { $limit: ISSUE_CAP_PER_CHECK },
      { $project: { article: 1, warehouse: 1, location: 1, dispatched: 1 } },
    ]),
    StockBalance.aggregate([
      { $match: match },
      {
        $match: {
          $and: [
            { $or: [{ warehouse: { $in: [null, ""] } }, { warehouse: { $exists: false } }] },
            { $or: [{ location: { $in: [null, ""] } }, { location: { $exists: false } }] },
          ],
        },
      },
      { $limit: ISSUE_CAP_PER_CHECK },
      { $project: { article: 1 } },
    ]),
  ]);

  for (const row of negative) {
    issues.push(
      mkIssue({
        checkId: 9,
        severity: "Critical",
        module: "Inventory",
        issueType: "NEGATIVE_INVENTORY",
        documentNumber: row.article,
        reference: row.warehouse || row.location,
        description: `Negative stock: available=${row.available}, onHand=${row.onHand}`,
        suggestedAction: "Run stock reconciliation and correct ledger",
        openPath: `/store?tab=Stock`,
        article: row.article,
      }),
    );
  }

  for (const row of allocatedExceeds) {
    issues.push(
      mkIssue({
        checkId: 10,
        severity: "Critical",
        module: "Inventory",
        issueType: "ALLOCATED_EXCEEDS_AVAILABLE",
        documentNumber: row.article,
        reference: row.warehouse || row.location,
        description: `Allocated ${row.allocated} exceeds on-hand ${row.onHand}`,
        suggestedAction: "Review allocations and stock reservations",
        openPath: `/store?tab=Stock`,
        article: row.article,
      }),
    );
  }

  for (const row of packedExceeds) {
    issues.push(
      mkIssue({
        checkId: 11,
        severity: "Critical",
        module: "Inventory",
        issueType: "PACKED_EXCEEDS_ALLOCATED",
        documentNumber: row.article,
        reference: row.warehouse || row.location,
        description: `Packed ${row.packed} exceeds allocated ${row.allocated}`,
        suggestedAction: "Review packing vs allocation quantities",
        openPath: `/store?tab=Packing`,
        article: row.article,
      }),
    );
  }

  for (const row of dispatchedExceeds) {
    issues.push(
      mkIssue({
        checkId: 12,
        severity: "Critical",
        module: "Inventory",
        issueType: "DISPATCHED_EXCEEDS_INVOICED",
        documentNumber: row.article,
        reference: row.warehouse || row.location,
        description: `Dispatched qty ${row.dispatched} may exceed invoiced/packed levels`,
        suggestedAction: "Verify dispatch quantities against invoice lines",
        openPath: `/store?tab=Dispatch`,
        article: row.article,
      }),
    );
  }

  for (const row of missingWarehouse) {
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

  // Stock bucket integrity (orphaned reserved/packed vs live docs) — read-only sample.
  try {
    const { runStockBucketIntegrityAudit } = await import("./stockBucketIntegrityService.js");
    const bucket = await runStockBucketIntegrityAudit({
      companyId,
      includeHealthy: false,
      limit: ISSUE_CAP_PER_CHECK,
      page: 1,
    });
    for (const row of (bucket.rows || []).slice(0, ISSUE_CAP_PER_CHECK)) {
      if (row.healthy) continue;
      const sev =
        row.severity === "Critical" ? "Critical" : row.severity === "Major" ? "Major" : "Minor";
      issues.push(
        mkIssue({
          checkId: 26,
          severity: sev,
          module: "Inventory",
          issueType: "STOCK_BUCKET_INTEGRITY",
          documentNumber: row.article,
          reference: `${row.warehouseCode || row.location || ""}`,
          description: `Bucket mismatch [${(row.mismatchTypes || []).join(", ")}]: reserved ${row.storedReservedQty}→${row.expectedReservedQty}, packed ${row.storedPackedQty}→${row.expectedPackedQty}`,
          suggestedAction: row.safeRepairCandidate
            ? "Review on Stock Bucket Integrity screen; dry-run repair preview available"
            : row.repairBlockedReason || "Investigate manually — auto-repair blocked",
          openPath: `/dashboard/stock-bucket-integrity?article=${encodeURIComponent(row.article)}`,
          article: row.article,
        }),
      );
    }
  } catch (err) {
    issues.push(
      mkIssue({
        checkId: 26,
        severity: "Major",
        module: "Inventory",
        issueType: "STOCK_BUCKET_INTEGRITY",
        documentNumber: "SCAN_ERROR",
        description: `Stock bucket integrity scan failed: ${err.message}`,
        suggestedAction: "Check admin logs / run stockBucketIntegrityAudit.readonly.mjs",
        openPath: `/dashboard/stock-bucket-integrity`,
      }),
    );
  }

  return capIssues(issues);
}

async function runCustomsReconciliationCheck(companyId, companyCode) {
  if (!isCustomsEnabled()) return [];

  const mismatches = await getCustomsReconciliationMismatches(companyId, companyCode, ISSUE_CAP_PER_CHECK);
  return mismatches.map((row) =>
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

async function runCustomsDocChecks(companyId) {
  if (!isCustomsEnabled()) return [];

  const issues = [];
  const [siWithoutCi, ciWithoutSi, lotFacet] = await Promise.all([
    SalesInvoice.aggregate([
      { $match: withCompany(companyId, { status: { $nin: ["CANCELLED", "DRAFT"] } }) },
      {
        $lookup: {
          from: col(CustomsInvoice),
          localField: "_id",
          foreignField: "salesInvoiceId",
          as: "ci",
        },
      },
      { $match: { ci: { $size: 0 } } },
      { $limit: ISSUE_CAP_PER_CHECK },
      { $project: { invoiceNo: 1, invoiceDate: 1, _id: 1 } },
    ]),
    CustomsInvoice.aggregate([
      { $match: withCompany(companyId, { status: { $ne: "CANCELLED" } }) },
      {
        $lookup: {
          from: col(SalesInvoice),
          localField: "salesInvoiceId",
          foreignField: "_id",
          as: "si",
        },
      },
      {
        $match: {
          $or: [{ salesInvoiceId: null }, { salesInvoiceId: { $exists: false } }, { si: { $size: 0 } }],
        },
      },
      { $limit: ISSUE_CAP_PER_CHECK },
      { $project: { customsInvoiceNumber: 1, salesInvoiceNumber: 1, invoiceDate: 1, _id: 1 } },
    ]),
    CustomsLotItem.aggregate([
      { $match: withCompany(companyId, { status: { $ne: "CANCELLED" } }) },
      {
        $facet: {
          missingBl: [
            { $match: { qtyAvailable: { $gt: EPS }, $or: [{ blNumber: { $in: [null, ""] } }, { blNumber: { $exists: false } }] } },
            { $limit: ISSUE_CAP_PER_CHECK },
            { $project: { articleNumber: 1, supplierInvoiceDate: 1 } },
          ],
          missingBoe: [
            { $match: { qtyAvailable: { $gt: EPS }, $or: [{ boeNumber: { $in: [null, ""] } }, { boeNumber: { $exists: false } }] } },
            { $limit: ISSUE_CAP_PER_CHECK },
            { $project: { articleNumber: 1, supplierInvoiceDate: 1 } },
          ],
          consumedExceeds: [
            { $match: { $expr: { $gt: ["$qtyConsumed", { $add: ["$qtyImported", EPS] }] } } },
            { $limit: ISSUE_CAP_PER_CHECK },
            { $project: { articleNumber: 1, qtyConsumed: 1, qtyImported: 1 } },
          ],
        },
      },
    ]),
  ]);

  const lotIssues = lotFacet[0] || {};

  for (const si of siWithoutCi) {
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

  for (const ci of ciWithoutSi) {
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

  for (const it of lotIssues.missingBl || []) {
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

  for (const it of lotIssues.missingBoe || []) {
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

  for (const it of lotIssues.consumedExceeds || []) {
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

  return capIssues(issues);
}

async function runDuplicateArticleCheck(companyId) {
  const dupes = await ItemMaster.aggregate([
    { $match: withCompany(companyId, { status: "Active" }) },
    {
      $group: {
        _id: { $toUpper: { $trim: { input: { $ifNull: ["$article", ""] } } } },
        count: { $sum: 1 },
        firstArticle: { $first: "$article" },
        secondArticle: { $last: "$article" },
      },
    },
    { $match: { count: { $gt: 1 }, _id: { $ne: "" } } },
    { $limit: ISSUE_CAP_PER_CHECK },
  ]);

  return dupes.map((row) =>
    mkIssue({
      checkId: 20,
      severity: "Critical",
      module: "Master Data",
      issueType: "DUPLICATE_ARTICLE",
      documentNumber: row._id,
      reference: row.secondArticle,
      description: "Duplicate article number in item master",
      suggestedAction: "Merge or deactivate duplicate item",
      openPath: `/items?article=${encodeURIComponent(row._id)}`,
      article: row._id,
    }),
  );
}

async function runMasterDataOtherChecks(companyId) {
  const issues = [];
  const match = withCompany(companyId, { status: "Active" });

  const [dupSpn, missingSupplier, missingVertical, missingBrand, missingModel] = await Promise.all([
    ItemMaster.aggregate([
      { $match: match },
      {
        $addFields: {
          spnKey: {
            $toUpper: {
              $trim: {
                input: {
                  $cond: [
                    { $gt: [{ $strLenCP: { $ifNull: ["$supplierPartNumber", ""] } }, 0] },
                    "$supplierPartNumber",
                    { $ifNull: ["$spn", ""] },
                  ],
                },
              },
            },
          },
        },
      },
      { $match: { spnKey: { $ne: "" } } },
      {
        $group: {
          _id: "$spnKey",
          count: { $sum: 1 },
          articles: { $push: "$article" },
        },
      },
      { $match: { count: { $gt: 1 } } },
      { $limit: ISSUE_CAP_PER_CHECK },
    ]),
    ItemMaster.find({ ...match, $or: [{ supplier: { $in: [null, ""] } }, { supplier: { $exists: false } }] })
      .select("article")
      .limit(ISSUE_CAP_PER_CHECK)
      .lean(),
    ItemMaster.find({ ...match, $or: [{ vertical: { $in: [null, ""] } }, { vertical: { $exists: false } }] })
      .select("article")
      .limit(ISSUE_CAP_PER_CHECK)
      .lean(),
    ItemMaster.find({ ...match, $or: [{ brand: { $in: [null, ""] } }, { brand: { $exists: false } }] })
      .select("article")
      .limit(ISSUE_CAP_PER_CHECK)
      .lean(),
    ItemMaster.find({ ...match, $or: [{ model: { $in: [null, ""] } }, { model: { $exists: false } }] })
      .select("article")
      .limit(ISSUE_CAP_PER_CHECK)
      .lean(),
  ]);

  for (const row of dupSpn) {
    const art = row.articles?.[0] || row._id;
    issues.push(
      mkIssue({
        checkId: 21,
        severity: "Major",
        module: "Master Data",
        issueType: "DUPLICATE_SUPPLIER_PART",
        documentNumber: art,
        reference: row.articles?.[1] || "",
        description: `Duplicate supplier part number ${row._id}`,
        suggestedAction: "Review supplier part mapping",
        openPath: `/items?article=${encodeURIComponent(art)}`,
        article: art,
      }),
    );
  }

  for (const it of missingSupplier) {
    issues.push(
      mkIssue({
        checkId: 22,
        severity: "Major",
        module: "Master Data",
        issueType: "ITEM_WITHOUT_SUPPLIER",
        documentNumber: it.article,
        description: "Item master record missing supplier",
        suggestedAction: "Assign supplier on item master",
        openPath: `/items?article=${encodeURIComponent(it.article)}`,
        article: it.article,
      }),
    );
  }

  for (const it of missingVertical) {
    issues.push(
      mkIssue({
        checkId: 23,
        severity: "Minor",
        module: "Master Data",
        issueType: "ITEM_WITHOUT_VERTICAL",
        documentNumber: it.article,
        description: "Item missing vertical classification",
        suggestedAction: "Complete item master vertical field",
        openPath: `/items?article=${encodeURIComponent(it.article)}`,
        article: it.article,
      }),
    );
  }

  for (const it of missingBrand) {
    issues.push(
      mkIssue({
        checkId: 24,
        severity: "Minor",
        module: "Master Data",
        issueType: "ITEM_WITHOUT_BRAND",
        documentNumber: it.article,
        description: "Item missing brand",
        suggestedAction: "Complete item master brand field",
        openPath: `/items?article=${encodeURIComponent(it.article)}`,
        article: it.article,
      }),
    );
  }

  for (const it of missingModel) {
    issues.push(
      mkIssue({
        checkId: 25,
        severity: "Minor",
        module: "Master Data",
        issueType: "ITEM_WITHOUT_MODEL",
        documentNumber: it.article,
        description: "Item missing model",
        suggestedAction: "Complete item master model field",
        openPath: `/items?article=${encodeURIComponent(it.article)}`,
        article: it.article,
      }),
    );
  }

  return capIssues(issues);
}

async function runOutstandingValidation(companyId) {
  const issues = [];
  const [customerMismatch, customerOverpaid, supplierMismatch, supplierOverpaid] = await Promise.all([
    SalesInvoice.aggregate([
      { $match: withCompany(companyId, { status: { $nin: ["CANCELLED", "DRAFT"] } }) },
      {
        $addFields: {
          total: { $ifNull: ["$grandTotal", 0] },
          paid: { $ifNull: ["$totalReceivedAmount", 0] },
          balance: { $ifNull: ["$balanceAmount", 0] },
          expected: { $max: [0, { $subtract: [{ $ifNull: ["$grandTotal", 0] }, { $ifNull: ["$totalReceivedAmount", 0] }] }] },
        },
      },
      { $match: { $expr: { $gt: [{ $abs: { $subtract: ["$balance", "$expected"] } }, 0.02] } } },
      { $limit: ISSUE_CAP_PER_CHECK },
      { $project: { invoiceNo: 1, invoiceDate: 1, customerName: 1, balance: 1, expected: 1 } },
    ]),
    SalesInvoice.aggregate([
      { $match: withCompany(companyId, { status: { $nin: ["CANCELLED", "DRAFT"] } }) },
      {
        $addFields: {
          total: { $ifNull: ["$grandTotal", 0] },
          paid: { $ifNull: ["$totalReceivedAmount", 0] },
        },
      },
      { $match: { $expr: { $gt: ["$paid", { $add: ["$total", 0.02] }] } } },
      { $limit: ISSUE_CAP_PER_CHECK },
      { $project: { invoiceNo: 1, invoiceDate: 1, customerName: 1, total: 1, paid: 1 } },
    ]),
    PurchaseInvoice.aggregate([
      { $match: withCompany(companyId, { status: { $ne: "CANCELLED" } }) },
      {
        $addFields: {
          total: { $ifNull: ["$totalAmount", 0] },
          paid: { $ifNull: ["$totalPaidAmount", 0] },
          balance: { $ifNull: ["$balanceAmount", 0] },
          expected: { $max: [0, { $subtract: [{ $ifNull: ["$totalAmount", 0] }, { $ifNull: ["$totalPaidAmount", 0] }] }] },
        },
      },
      { $match: { $expr: { $gt: [{ $abs: { $subtract: ["$balance", "$expected"] } }, 0.02] } } },
      { $limit: ISSUE_CAP_PER_CHECK },
      { $project: { invoiceNumber: 1, invoiceDate: 1, supplierName: 1, balance: 1, expected: 1 } },
    ]),
    PurchaseInvoice.aggregate([
      { $match: withCompany(companyId, { status: { $ne: "CANCELLED" } }) },
      {
        $addFields: {
          total: { $ifNull: ["$totalAmount", 0] },
          paid: { $ifNull: ["$totalPaidAmount", 0] },
        },
      },
      { $match: { $expr: { $gt: ["$paid", { $add: ["$total", 0.02] }] } } },
      { $limit: ISSUE_CAP_PER_CHECK },
      { $project: { invoiceNumber: 1, invoiceDate: 1, supplierName: 1, total: 1, paid: 1 } },
    ]),
  ]);

  for (const si of customerMismatch) {
    issues.push(
      mkIssue({
        checkId: 26,
        severity: "Critical",
        module: "Accounts",
        issueType: "CUSTOMER_OUTSTANDING_MISMATCH",
        documentNumber: si.invoiceNo,
        description: `Balance ${si.balance} does not match total-paid (${si.expected})`,
        suggestedAction: "Recalculate customer outstanding from receipts",
        openPath: `/accounts?tab=receivables`,
        date: si.invoiceDate,
        customer: si.customerName,
      }),
    );
  }

  for (const si of customerOverpaid) {
    issues.push(
      mkIssue({
        checkId: 28,
        severity: "Critical",
        module: "Accounts",
        issueType: "PAID_EXCEEDS_INVOICE",
        documentNumber: si.invoiceNo,
        description: `Paid ${si.paid} exceeds invoice value ${si.total}`,
        suggestedAction: "Review payment allocations",
        openPath: `/accounts?tab=receivables`,
        date: si.invoiceDate,
        customer: si.customerName,
      }),
    );
  }

  for (const pi of supplierMismatch) {
    issues.push(
      mkIssue({
        checkId: 27,
        severity: "Critical",
        module: "Accounts",
        issueType: "SUPPLIER_OUTSTANDING_MISMATCH",
        documentNumber: pi.invoiceNumber,
        description: `AP balance ${pi.balance} does not match total-paid (${pi.expected})`,
        suggestedAction: "Recalculate supplier outstanding",
        openPath: `/accounts?tab=payables`,
        date: pi.invoiceDate,
        supplier: pi.supplierName,
      }),
    );
  }

  for (const pi of supplierOverpaid) {
    issues.push(
      mkIssue({
        checkId: 28,
        severity: "Critical",
        module: "Accounts",
        issueType: "PAID_EXCEEDS_INVOICE",
        documentNumber: pi.invoiceNumber,
        description: `Supplier paid ${pi.paid} exceeds invoice ${pi.total}`,
        suggestedAction: "Review supplier payment allocations",
        openPath: `/accounts?tab=payables`,
        date: pi.invoiceDate,
        supplier: pi.supplierName,
      }),
    );
  }

  return capIssues(issues);
}

async function runAccountsOtherChecks(companyId) {
  const receipts = await PaymentReceipt.find(
    withCompany(companyId, {
      status: { $ne: "CANCELLED" },
      $or: [{ paymentReference: { $in: [null, ""] } }, { paymentReference: { $exists: false } }],
    }),
  )
    .select("receiptNo customerName receiptDate")
    .limit(ISSUE_CAP_PER_CHECK)
    .lean();

  return receipts.map((rc) =>
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

async function runFullDataHealthScan(companyId, companyCode = "") {
  const [
    counts,
    salesIssues,
    purchaseIssues,
    inventoryIssues,
    customsReconIssues,
    customsDocIssues,
    duplicateArticleIssues,
    masterOtherIssues,
    outstandingIssues,
    accountsOtherIssues,
  ] = await Promise.all([
    entityCounts(companyId),
    runSalesChecks(companyId),
    runPurchaseChecks(companyId),
    runInventoryChecks(companyId),
    runCustomsReconciliationCheck(companyId, companyCode),
    runCustomsDocChecks(companyId),
    runDuplicateArticleCheck(companyId),
    runMasterDataOtherChecks(companyId),
    runOutstandingValidation(companyId),
    runAccountsOtherChecks(companyId),
  ]);

  const issues = [
    ...salesIssues,
    ...purchaseIssues,
    ...inventoryIssues,
    ...customsReconIssues,
    ...customsDocIssues,
    ...duplicateArticleIssues,
    ...masterOtherIssues,
    ...outstandingIssues,
    ...accountsOtherIssues,
  ];

  const { criticalCount, majorCount, minorCount } = countBySeverity(issues);
  const healthScore = computeHealthScore(issues);

  return {
    lastAuditRun: new Date().toISOString(),
    companyCode,
    counts,
    issues,
    healthScore,
    healthRating: healthRating(healthScore),
    criticalCount,
    majorCount,
    minorCount,
    totalIssues: issues.length,
    charts: buildCharts(issues),
  };
}

function cacheKey(companyId) {
  return String(companyId || "").trim();
}

export function invalidateDataHealthCache(companyId) {
  if (companyId) scanCache.delete(cacheKey(companyId));
  else scanCache.clear();
}

async function getOrRunScan(companyId, companyCode, refresh = false) {
  const key = cacheKey(companyId);
  const cached = scanCache.get(key);

  if (!refresh && cached && cached.expiresAt > Date.now()) {
    return { ...cached.payload, fromCache: true, cacheExpiresAt: new Date(cached.expiresAt).toISOString() };
  }

  const payload = await runFullDataHealthScan(companyId, companyCode);
  scanCache.set(key, { expiresAt: Date.now() + CACHE_MS, payload });
  return { ...payload, fromCache: false, cacheExpiresAt: new Date(Date.now() + CACHE_MS).toISOString() };
}

export async function buildDataHealthDashboard(companyId, companyCode = "", rawFilters = {}, options = {}) {
  const filters = parseFilters(rawFilters);
  const refresh = options.refresh || String(rawFilters.refresh || "").toLowerCase() === "true";

  const scan = await getOrRunScan(companyId, companyCode, refresh);
  const filteredIssues = applyFilters(scan.issues, filters);
  const charts = hasActiveFilters(filters) ? buildCharts(filteredIssues) : scan.charts;

  return {
    generatedAt: scan.lastAuditRun,
    lastAuditRun: scan.lastAuditRun,
    fromCache: scan.fromCache,
    cacheExpiresAt: scan.cacheExpiresAt,
    companyCode: scan.companyCode,
    filters,
    counts: scan.counts,
    healthScore: scan.healthScore,
    healthRating: scan.healthRating,
    criticalCount: scan.criticalCount,
    majorCount: scan.majorCount,
    minorCount: scan.minorCount,
    totalIssues: filteredIssues.length,
    issues: filteredIssues,
    charts,
  };
}
