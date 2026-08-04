/**
 * ERP Data Health — read-only validation engine (no mutations).
 *
 * Categories:
 *   INTEGRITY  — genuine ERP data / stock / ledger failures (affect Health Score)
 *   OPERATIONAL — normal workflow pending states (informational only)
 *   AGING      — operational pending items past configurable age thresholds
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

/** Parse DATA_HEALTH_AGING_DAYS safely: invalid/zero/negative → 7; clamp 1–365. */
export function parseAgingDays(raw = process.env.DATA_HEALTH_AGING_DAYS) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 7;
  return Math.min(365, Math.max(1, Math.floor(n)));
}

const DEFAULT_AGING_DAYS = parseAgingDays();

/** Integrity score penalties (Health Score uses INTEGRITY only). */
export const INTEGRITY_SCORE_WEIGHTS = Object.freeze({
  Critical: 15,
  Major: 5,
  Minor: 1,
});

export const ISSUE_CATEGORIES = Object.freeze({
  INTEGRITY: "INTEGRITY",
  OPERATIONAL: "OPERATIONAL",
  AGING: "AGING",
});

/**
 * Issue types that are legitimate workflow pending states — never reduce Health Score.
 *
 * Decision table (Marivolt active workflows):
 * - OA_WITHOUT_ALLOCATION → OPERATIONAL (OA may wait for allocation)
 * - ALLOCATION_WITHOUT_PACKING → OPERATIONAL
 * - PACKING_WITHOUT_INVOICE → OPERATIONAL
 * - PACKING_WITHOUT_DISPATCH → OPERATIONAL
 * - INVOICE_WITHOUT_DISPATCH → OPERATIONAL (invoice-before-dispatch is allowed)
 * - PO_AWAITING_GRN → OPERATIONAL
 * - PI_AWAITING_PAYMENT → OPERATIONAL
 * - NEGATIVE_INVENTORY / AVAILABLE_BELOW_ZERO / ALLOCATED_EXCEEDS_* → OPERATIONAL
 *   (Allocation before PO/GRN is intentional; free available may be negative)
 * - WAITING_PURCHASE_AFTER_ALLOCATION → OPERATIONAL (procurement queue)
 * - GRN_WITHOUT_PO → INTEGRITY (Store GRN post is PO-line based; orphan GRN is a broken reference)
 * - DISPATCH_WITHOUT_INVOICE → INTEGRITY (dispatch create requires salesInvoiceId)
 * - NEGATIVE_PHYSICAL_ON_HAND → INTEGRITY (true physical on-hand < 0)
 */
export const OPERATIONAL_ISSUE_TYPES = Object.freeze(
  new Set([
    "OA_WITHOUT_ALLOCATION",
    "ALLOCATION_WITHOUT_PACKING",
    "PACKING_WITHOUT_INVOICE",
    "PACKING_WITHOUT_DISPATCH",
    "INVOICE_WITHOUT_DISPATCH",
    "PO_AWAITING_GRN",
    "PI_AWAITING_PAYMENT",
    "SI_WITHOUT_CUSTOMS_INVOICE",
    "PO_STATUS_NOT_UPDATED",
    "MISSING_BL_NUMBER",
    "MISSING_BOE_NUMBER",
    "ITEM_WITHOUT_SUPPLIER",
    "ITEM_WITHOUT_VERTICAL",
    "ITEM_WITHOUT_BRAND",
    "ITEM_WITHOUT_MODEL",
    // Sell / allocate before procurement — valid Marivolt workflow, not ERP defects
    "NEGATIVE_INVENTORY",
    "ALLOCATED_EXCEEDS_AVAILABLE",
    "ALLOCATED_EXCEEDS_ONHAND",
    "AVAILABLE_BELOW_ZERO",
    "OUT_OF_STOCK_FOR_ALLOCATION",
    "BACKORDER_REQUIRED",
    "WAITING_PURCHASE_AFTER_ALLOCATION",
  ])
);

/** Procurement / stock-cover queue within Operational Pending. */
export const PROCUREMENT_QUEUE_TYPES = Object.freeze(
  new Set([
    "NEGATIVE_INVENTORY",
    "ALLOCATED_EXCEEDS_AVAILABLE",
    "ALLOCATED_EXCEEDS_ONHAND",
    "AVAILABLE_BELOW_ZERO",
    "OUT_OF_STOCK_FOR_ALLOCATION",
    "BACKORDER_REQUIRED",
    "WAITING_PURCHASE_AFTER_ALLOCATION",
    "PO_AWAITING_GRN",
  ])
);

/** Friendly pending labels for Operational / Aging sections. */
export const OPERATIONAL_PENDING_LABELS = Object.freeze({
  OA_WITHOUT_ALLOCATION: "OA awaiting Allocation",
  ALLOCATION_WITHOUT_PACKING: "Allocation awaiting Packing",
  PACKING_WITHOUT_INVOICE: "Packing awaiting Invoice",
  PACKING_WITHOUT_DISPATCH: "Packing awaiting Dispatch",
  INVOICE_WITHOUT_DISPATCH: "Sales Invoice awaiting Dispatch",
  PO_AWAITING_GRN: "PO awaiting GRN",
  PI_AWAITING_PAYMENT: "PI awaiting Payment",
  SI_WITHOUT_CUSTOMS_INVOICE: "Sales Invoice awaiting Customs Invoice",
  PO_STATUS_NOT_UPDATED: "PO status awaiting update",
  MISSING_BL_NUMBER: "Customs lot awaiting BL number",
  MISSING_BOE_NUMBER: "Customs lot awaiting BOE number",
  ITEM_WITHOUT_SUPPLIER: "Item master awaiting supplier",
  ITEM_WITHOUT_VERTICAL: "Item master awaiting vertical",
  ITEM_WITHOUT_BRAND: "Item master awaiting brand",
  ITEM_WITHOUT_MODEL: "Item master awaiting model",
  NEGATIVE_INVENTORY: "Waiting Purchase (available below zero)",
  ALLOCATED_EXCEEDS_AVAILABLE: "Waiting Purchase (allocated exceeds available)",
  ALLOCATED_EXCEEDS_ONHAND: "Waiting Purchase (allocated exceeds on hand)",
  AVAILABLE_BELOW_ZERO: "Waiting Purchase (available below zero)",
  OUT_OF_STOCK_FOR_ALLOCATION: "Out of stock for allocation — purchase required",
  BACKORDER_REQUIRED: "Backorder required",
  WAITING_PURCHASE_AFTER_ALLOCATION: "Waiting Purchase after Allocation",
});

const PROCUREMENT_FOLLOW_UP = "Follow up with Purchasing — allocate-before-stock is allowed; cover with PO/GRN";

/** Optional per-type aging thresholds (days). Falls back to DEFAULT_AGING_DAYS. */
function buildAgingDaysByType() {
  const base = DEFAULT_AGING_DAYS;
  const pick = (envKey) => {
    const n = Number(process.env[envKey]);
    if (!Number.isFinite(n) || n <= 0) return base;
    return Math.min(365, Math.max(1, Math.floor(n)));
  };
  return Object.freeze({
    OA_WITHOUT_ALLOCATION: pick("DATA_HEALTH_AGING_OA_DAYS"),
    ALLOCATION_WITHOUT_PACKING: pick("DATA_HEALTH_AGING_ALLOC_DAYS"),
    PACKING_WITHOUT_INVOICE: pick("DATA_HEALTH_AGING_PACKING_DAYS"),
    PACKING_WITHOUT_DISPATCH: pick("DATA_HEALTH_AGING_PACKING_DAYS"),
    INVOICE_WITHOUT_DISPATCH: pick("DATA_HEALTH_AGING_INVOICE_DAYS"),
    PO_AWAITING_GRN: pick("DATA_HEALTH_AGING_PO_DAYS"),
    PI_AWAITING_PAYMENT: pick("DATA_HEALTH_AGING_PI_DAYS"),
    WAITING_PURCHASE_AFTER_ALLOCATION: pick("DATA_HEALTH_AGING_PROCUREMENT_DAYS"),
    AVAILABLE_BELOW_ZERO: pick("DATA_HEALTH_AGING_PROCUREMENT_DAYS"),
    ALLOCATED_EXCEEDS_ONHAND: pick("DATA_HEALTH_AGING_PROCUREMENT_DAYS"),
    ALLOCATED_EXCEEDS_AVAILABLE: pick("DATA_HEALTH_AGING_PROCUREMENT_DAYS"),
    NEGATIVE_INVENTORY: pick("DATA_HEALTH_AGING_PROCUREMENT_DAYS"),
    OUT_OF_STOCK_FOR_ALLOCATION: pick("DATA_HEALTH_AGING_PROCUREMENT_DAYS"),
    BACKORDER_REQUIRED: pick("DATA_HEALTH_AGING_PROCUREMENT_DAYS"),
  });
}

const AGING_DAYS_BY_TYPE = buildAgingDaysByType();

export function isOperationalIssueType(issueType) {
  return OPERATIONAL_ISSUE_TYPES.has(String(issueType || "").trim().toUpperCase());
}

export function isProcurementQueueType(issueType) {
  return PROCUREMENT_QUEUE_TYPES.has(String(issueType || "").trim().toUpperCase());
}

export function classifyIssueCategory(issueType) {
  return isOperationalIssueType(issueType)
    ? ISSUE_CATEGORIES.OPERATIONAL
    : ISSUE_CATEGORIES.INTEGRITY;
}

/** UTC-safe whole-day age from an issue date. */
export function ageDaysFrom(date, now = new Date()) {
  if (!date) return null;
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return null;
  const startUtc = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const nowUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.max(0, Math.floor((nowUtc - startUtc) / (24 * 60 * 60 * 1000)));
}

/**
 * Aging band for operational / procurement monitors (not integrity severity).
 * Bands: 0-6 · 7+ · 30+ · 90+
 */
export function agingBandFromDays(ageDays) {
  if (ageDays == null || !Number.isFinite(Number(ageDays))) return null;
  const n = Math.max(0, Math.floor(Number(ageDays)));
  if (n >= 90) return "90+";
  if (n >= 30) return "30+";
  if (n >= 7) return "7+";
  return "0-6";
}

function agingThresholdFor(issueType) {
  const key = String(issueType || "").trim().toUpperCase();
  const n = AGING_DAYS_BY_TYPE[key];
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_AGING_DAYS;
}

/** Stable identity for dedupe / aging linkage. */
export function buildIssueId({ companyCode = "", issueType, documentNumber, reference = "", article = "", warehouse = "" }) {
  return [
    String(companyCode || "").trim().toUpperCase() || "CO",
    String(issueType || "").trim().toUpperCase(),
    String(documentNumber || "").trim().toUpperCase() || "—",
    String(reference || "").trim().toUpperCase() || "",
    String(article || "").trim().toUpperCase() || "",
    String(warehouse || "").trim().toUpperCase() || "",
  ].join("|");
}

/**
 * Enrich a raw issue with category / section / pending label / age / stable id.
 * Operational items never contribute to Health Score.
 */
export function enrichIssue(raw, opts = {}) {
  const issueType = String(raw.issueType || "").trim().toUpperCase();
  const category = classifyIssueCategory(issueType);
  const ageDays = ageDaysFrom(raw.date, opts.now);
  const pendingLabel = OPERATIONAL_PENDING_LABELS[issueType] || null;
  const thresholdDays = category === ISSUE_CATEGORIES.OPERATIONAL ? agingThresholdFor(issueType) : null;
  const isAging =
    category === ISSUE_CATEGORIES.OPERATIONAL &&
    ageDays != null &&
    thresholdDays != null &&
    ageDays >= thresholdDays;
  const agingBand = category === ISSUE_CATEGORIES.OPERATIONAL ? agingBandFromDays(ageDays) : null;
  const operationalGroup = isProcurementQueueType(issueType) ? "PROCUREMENT" : category === ISSUE_CATEGORIES.OPERATIONAL ? "WORKFLOW" : null;
  const issueId =
    raw.issueId ||
    buildIssueId({
      companyCode: opts.companyCode || raw.companyCode,
      issueType,
      documentNumber: raw.documentNumber,
      reference: raw.reference,
      article: raw.article,
      warehouse: raw.warehouse || raw.reference,
    });

  const suggestedAction =
    category === ISSUE_CATEGORIES.OPERATIONAL && isProcurementQueueType(issueType)
      ? PROCUREMENT_FOLLOW_UP
      : raw.suggestedAction;

  return {
    ...raw,
    issueId,
    issueType,
    category,
    section: category,
    pendingLabel,
    ageDays,
    agingBand,
    agingThresholdDays: thresholdDays,
    isAging: Boolean(isAging),
    operationalGroup,
    // Operational rows stay visible as Info — never Critical/Major for scoring.
    severity:
      category === ISSUE_CATEGORIES.OPERATIONAL
        ? "Info"
        : raw.severity || "Minor",
    suggestedAction,
    description:
      category === ISSUE_CATEGORIES.OPERATIONAL && pendingLabel
        ? `${pendingLabel}${raw.description ? ` — ${raw.description}` : ""}`
        : raw.description,
  };
}

function dedupeByIssueId(rows) {
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const id = row.issueId || buildIssueId(row);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ ...row, issueId: id });
  }
  return out;
}

function partitionIssues(enriched) {
  const integrityIssues = [];
  const operationalPending = [];
  const agingMonitor = [];
  for (const row of enriched) {
    if (row.category === ISSUE_CATEGORIES.INTEGRITY) {
      integrityIssues.push(row);
      continue;
    }
    operationalPending.push(row);
    if (row.isAging) {
      // Linked aging representation — distinct ID, references operational source.
      agingMonitor.push({
        ...row,
        issueId: `${row.issueId}|AGING`,
        sourceIssueId: row.issueId,
        category: ISSUE_CATEGORIES.AGING,
        section: ISSUE_CATEGORIES.AGING,
        severity: "Info",
      });
    }
  }
  return {
    integrityIssues: dedupeByIssueId(integrityIssues),
    operationalPending: dedupeByIssueId(operationalPending),
    agingMonitor: dedupeByIssueId(agingMonitor),
  };
}

function operationalCounters(operationalPending) {
  const byType = new Map();
  for (const row of operationalPending) {
    const key = row.issueType;
    const label = row.pendingLabel || row.issueType;
    const cur = byType.get(key) || { label, issueType: key, count: 0, group: row.operationalGroup || "WORKFLOW" };
    cur.count += 1;
    byType.set(key, cur);
  }
  return [...byType.values()].sort((a, b) => b.count - a.count);
}

function procurementCounters(operationalPending) {
  return operationalCounters(
    (operationalPending || []).filter((row) => isProcurementQueueType(row.issueType))
  );
}

function agingBandCounters(rows) {
  const bands = { "0-6": 0, "7+": 0, "30+": 0, "90+": 0 };
  for (const row of rows || []) {
    const band = row.agingBand || agingBandFromDays(row.ageDays);
    if (band && bands[band] != null) bands[band] += 1;
  }
  return Object.entries(bands).map(([label, count]) => ({ label, count }));
}

/**
 * Health Score — INTEGRITY issues only.
 * Critical −15, Major −5, Minor −1; Info/Operational/Aging = 0.
 * Deduped by issueId before scoring.
 */
export function computeHealthScore(issues) {
  const integrity = dedupeByIssueId(
    (issues || []).filter(
      (row) =>
        (!row.category || row.category === ISSUE_CATEGORIES.INTEGRITY) &&
        row.severity !== "Info"
    )
  );
  let penalties = 0;
  const breakdown = { critical: 0, major: 0, minor: 0, penaltyPoints: 0 };
  for (const row of integrity) {
    if (row.severity === "Critical") {
      penalties += INTEGRITY_SCORE_WEIGHTS.Critical;
      breakdown.critical += 1;
    } else if (row.severity === "Major") {
      penalties += INTEGRITY_SCORE_WEIGHTS.Major;
      breakdown.major += 1;
    } else {
      penalties += INTEGRITY_SCORE_WEIGHTS.Minor;
      breakdown.minor += 1;
    }
  }
  breakdown.penaltyPoints = penalties;
  const healthScore = Math.max(0, Math.min(100, 100 - penalties));
  return { healthScore, scoreBreakdown: breakdown };
}

export function healthRating(score) {
  if (score >= 90) return "Healthy";
  if (score >= 75) return "Attention";
  if (score >= 50) return "Poor";
  return "Critical";
}

function countBySeverity(issues) {
  let criticalCount = 0;
  let majorCount = 0;
  let minorCount = 0;
  let infoCount = 0;
  for (const row of issues) {
    if (row.severity === "Critical") criticalCount += 1;
    else if (row.severity === "Major") majorCount += 1;
    else if (row.severity === "Info") infoCount += 1;
    else minorCount += 1;
  }
  return { criticalCount, majorCount, minorCount, infoCount };
}

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
        description: "Order Acknowledgement has no allocation yet (normal pending workflow)",
        suggestedAction: "Create allocation when ready, or cancel obsolete OA",
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
        description: "Allocation has no store packing yet (normal pending workflow)",
        suggestedAction: "Create packing from allocation when ready",
        openPath: "/store?tab=Packing",
        date: alloc.allocationDate,
      }),
    );
  }

  for (const pk of packingRows) {
    issues.push(
      mkIssue({
        checkId: 3,
        severity: "Major",
        module: "Sales",
        issueType: "PACKING_WITHOUT_INVOICE",
        documentNumber: pk.packingNo,
        description: "Packing has no sales invoice yet (normal pending workflow)",
        suggestedAction: "Create sales invoice from packing when ready",
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
        description: "Sales invoice has no dispatch yet (allowed pending workflow)",
        suggestedAction: "Create dispatch when goods are ready to ship",
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
        description: "Dispatch exists without valid sales invoice link (broken document reference)",
        suggestedAction: "Link dispatch to sales invoice or cancel dispatch",
        openPath: `/store?tab=Dispatch&dispatchNo=${encodeURIComponent(d.dispatchNo)}`,
        date: d.dispatchDate,
      }),
    );
  }

  // Packing awaiting Dispatch (posted packing with no related store dispatch)
  const packingAwaitingDispatch = await StorePacking.aggregate([
    {
      $match: withCompany(companyId, {
        status: { $in: ["POSTED", "PARTIALLY_PACKED", "FULLY_PACKED"] },
      }),
    },
    {
      $lookup: {
        from: col(StoreDispatch),
        localField: "_id",
        foreignField: "packingId",
        as: "dispatches",
      },
    },
    { $match: { dispatches: { $size: 0 } } },
    { $limit: ISSUE_CAP_PER_CHECK },
    { $project: { packingNo: 1, packingDate: 1 } },
  ]);
  for (const pk of packingAwaitingDispatch) {
    issues.push(
      mkIssue({
        checkId: 30,
        severity: "Major",
        module: "Sales",
        issueType: "PACKING_WITHOUT_DISPATCH",
        documentNumber: pk.packingNo,
        description: "Posted packing has no dispatch yet (normal pending workflow)",
        suggestedAction: "Create dispatch when ready to ship",
        openPath: `/store?tab=Packing&packingNo=${encodeURIComponent(pk.packingNo)}`,
        date: pk.packingDate,
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
        description: "PO fully received but status not updated (workflow status lag)",
        suggestedAction: "Update PO status to received/closed when convenient",
        openPath: `/purchase?tab=orders&id=${po._id}`,
        date: po.orderDate,
      }),
    );
  }

  // PO awaiting GRN — open POs with no linked GRN (informational pending)
  const poAwaitingGrn = await PurchaseOrder.aggregate([
    {
      $match: withCompany(companyId, {
        status: { $nin: ["CANCELLED", "CLOSED", "COMPLETED", "FULLY_RECEIVED", "RECEIVED"] },
      }),
    },
    {
      $lookup: {
        from: col(GRN),
        localField: "_id",
        foreignField: "poId",
        as: "grns",
      },
    },
    { $match: { grns: { $size: 0 } } },
    { $limit: ISSUE_CAP_PER_CHECK },
    { $project: { poNo: 1, poNumber: 1, orderDate: 1, _id: 1, supplierName: 1 } },
  ]);
  for (const po of poAwaitingGrn) {
    issues.push(
      mkIssue({
        checkId: 31,
        severity: "Minor",
        module: "Purchase",
        issueType: "PO_AWAITING_GRN",
        documentNumber: po.poNo || po.poNumber,
        description: "Purchase order has no GRN yet (normal pending workflow)",
        suggestedAction: "Receive goods via GRN when shipment arrives",
        openPath: `/purchase?tab=orders&id=${po._id}`,
        date: po.orderDate,
        supplier: po.supplierName,
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
      {
        $project: {
          article: 1,
          warehouse: 1,
          location: 1,
          available: 1,
          onHand: 1,
          allocated: 1,
          lastTransactionDate: 1,
          updatedAt: 1,
        },
      },
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
      {
        $project: {
          article: 1,
          warehouse: 1,
          location: 1,
          allocated: 1,
          onHand: 1,
          lastTransactionDate: 1,
          updatedAt: 1,
        },
      },
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

  const stockAgeDate = (row) => row.lastTransactionDate || row.updatedAt || null;
  const waitingPurchaseKeys = new Set();

  // Allocated > on-hand with non-negative physical stock = sell/allocate before procurement (operational).
  for (const row of allocatedExceeds) {
    const onHand = Number(row.onHand) || 0;
    if (onHand < -EPS) continue; // physical negative handled as integrity below
    const key = `${upper(row.article)}|${upper(row.warehouse || row.location || "")}`;
    waitingPurchaseKeys.add(key);
    issues.push(
      mkIssue({
        checkId: 10,
        severity: "Info",
        module: "Inventory",
        issueType: "WAITING_PURCHASE_AFTER_ALLOCATION",
        documentNumber: row.article,
        reference: row.warehouse || row.location,
        description: `On hand ${onHand}, allocated ${row.allocated}, available shortfall ${Number(row.allocated) - onHand}. Allocation before PO/GRN is allowed.`,
        suggestedAction: PROCUREMENT_FOLLOW_UP,
        openPath: `/store?tab=Stock`,
        article: row.article,
        date: stockAgeDate(row),
      }),
    );
  }

  for (const row of negative) {
    const onHand = Number(row.onHand) || 0;
    const available = Number(row.available) || 0;
    const allocated = Number(row.allocated) || 0;
    const wh = row.warehouse || row.location;
    const key = `${upper(row.article)}|${upper(wh || "")}`;

    if (onHand < -EPS) {
      // True physical ledger defect — integrity only.
      issues.push(
        mkIssue({
          checkId: 9,
          severity: "Critical",
          module: "Inventory",
          issueType: "NEGATIVE_PHYSICAL_ON_HAND",
          documentNumber: row.article,
          reference: wh,
          description: `Negative physical on-hand: onHand=${onHand}, available=${available}`,
          suggestedAction: "Investigate stock ledger / GRN / reverse transactions — physical on-hand must not be negative",
          openPath: `/store?tab=Stock`,
          article: row.article,
          date: stockAgeDate(row),
        }),
      );
      continue;
    }

    // Free available < 0 with onHand >= 0 is valid when reserved/packed cover exceeds on-hand.
    if (available < -EPS && !waitingPurchaseKeys.has(key)) {
      const issueType =
        allocated > onHand + EPS ? "WAITING_PURCHASE_AFTER_ALLOCATION" : "AVAILABLE_BELOW_ZERO";
      if (issueType === "WAITING_PURCHASE_AFTER_ALLOCATION") waitingPurchaseKeys.add(key);
      issues.push(
        mkIssue({
          checkId: 9,
          severity: "Info",
          module: "Inventory",
          issueType,
          documentNumber: row.article,
          reference: wh,
          description: `On hand ${onHand}, allocated ${allocated}, available ${available}. Negative free available is a valid cover-shortfall until PO/GRN.`,
          suggestedAction: PROCUREMENT_FOLLOW_UP,
          openPath: `/store?tab=Stock`,
          article: row.article,
          date: stockAgeDate(row),
        }),
      );
    }
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

  // Reservation Integrity — expected reserved/packed from live documents only.
  try {
    const { validateAllStock } = await import("./reservationIntegrityService.js");
    const ri = await validateAllStock({
      companyId,
      includeHealthy: false,
      persist: true,
    });
    let emitted = 0;
    for (const row of ri.rows || []) {
      for (const iss of row.issues || []) {
        if (emitted >= ISSUE_CAP_PER_CHECK) break;
        emitted += 1;
        issues.push(
          mkIssue({
            checkId: 27,
            severity: iss.severity === "Critical" ? "Critical" : iss.severity === "Major" ? "Major" : "Minor",
            module: "Inventory",
            issueType: iss.issueType,
            documentNumber: row.article,
            reference: row.warehouse,
            description: `${iss.issueType}: actual ${iss.actual} vs expected ${iss.expected} (Δ ${iss.difference})`,
            suggestedAction: iss.repairRecommendation,
            openPath: `/inventory/integrity/reservation?article=${encodeURIComponent(row.article)}&warehouse=${encodeURIComponent(row.warehouse || "")}`,
            article: row.article,
          }),
        );
      }
      if (emitted >= ISSUE_CAP_PER_CHECK) break;
    }
  } catch (err) {
    issues.push(
      mkIssue({
        checkId: 27,
        severity: "Major",
        module: "Inventory",
        issueType: "RESERVED_QTY_MISMATCH",
        documentNumber: "SCAN_ERROR",
        description: `Reservation integrity scan failed: ${err.message}`,
        suggestedAction: "Check admin logs / open Reservation Integrity and Run Validation",
        openPath: `/inventory/integrity/reservation`,
      }),
    );
  }

  // Broader stock bucket integrity (ledger / on-hand / ghost effects) — exclude pure reservation types already scored above.
  try {
    const { runStockBucketIntegrityAudit, MISMATCH_TYPES } = await import(
      "./stockBucketIntegrityService.js"
    );
    const reservationOnly = new Set([
      MISMATCH_TYPES.ORPHANED_RESERVED,
      MISMATCH_TYPES.MISSING_RESERVED,
      MISMATCH_TYPES.ORPHANED_PACKED,
      MISMATCH_TYPES.MISSING_PACKED,
      MISMATCH_TYPES.STORED_AVAILABLE_MISMATCH,
    ]);
    const bucket = await runStockBucketIntegrityAudit({
      companyId,
      includeHealthy: false,
      limit: ISSUE_CAP_PER_CHECK,
      page: 1,
    });
    for (const row of (bucket.rows || []).slice(0, ISSUE_CAP_PER_CHECK)) {
      if (row.healthy) continue;
      const types = (row.mismatchTypes || []).map(String);
      const nonReservation = types.filter((x) => !reservationOnly.has(x));
      if (!nonReservation.length) continue;
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
          description: `Bucket mismatch [${nonReservation.join(", ")}]: reserved ${row.storedReservedQty}→${row.expectedReservedQty}, packed ${row.storedPackedQty}→${row.expectedPackedQty}`,
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

async function runPurchaseInvoicePendingChecks(companyId) {
  const issues = [];
  const unpaid = await PurchaseInvoice.aggregate([
    { $match: withCompany(companyId, { status: { $nin: ["CANCELLED", "PAID", "CLOSED"] } }) },
    {
      $addFields: {
        balance: {
          $ifNull: [
            "$balanceAmount",
            { $subtract: [{ $ifNull: ["$totalAmount", 0] }, { $ifNull: ["$totalPaidAmount", 0] }] },
          ],
        },
      },
    },
    { $match: { $expr: { $gt: ["$balance", 0.02] } } },
    { $sort: { invoiceDate: 1 } },
    { $limit: ISSUE_CAP_PER_CHECK },
    { $project: { invoiceNumber: 1, invoiceDate: 1, supplierName: 1, balance: 1 } },
  ]);

  for (const pi of unpaid) {
    issues.push(
      mkIssue({
        checkId: 32,
        severity: "Minor",
        module: "Accounts",
        issueType: "PI_AWAITING_PAYMENT",
        documentNumber: pi.invoiceNumber,
        description: `Purchase invoice balance ${pi.balance} awaiting payment (normal pending workflow)`,
        suggestedAction: "Record supplier payment when due",
        openPath: `/accounts?tab=payables`,
        date: pi.invoiceDate,
        supplier: pi.supplierName,
      })
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
    piPendingIssues,
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
    runPurchaseInvoicePendingChecks(companyId),
  ]);

  const rawIssues = [
    ...salesIssues,
    ...purchaseIssues,
    ...inventoryIssues,
    ...customsReconIssues,
    ...customsDocIssues,
    ...duplicateArticleIssues,
    ...masterOtherIssues,
    ...outstandingIssues,
    ...accountsOtherIssues,
    ...piPendingIssues,
  ];

  const enriched = dedupeByIssueId(
    rawIssues.map((row) => enrichIssue(row, { companyCode }))
  );
  const { integrityIssues, operationalPending, agingMonitor } = partitionIssues(enriched);

  // Combined list for backward compatibility: integrity + operational only
  // (Aging is linked via sourceIssueId — not double-counted here.)
  const combinedIssues = [...integrityIssues, ...operationalPending];

  // Health Score + severity KPIs use integrity failures only.
  const { criticalCount, majorCount, minorCount } = countBySeverity(integrityIssues);
  const { healthScore, scoreBreakdown } = computeHealthScore(integrityIssues);

  const stockBucketIntegrity = integrityIssues.filter((r) => r.issueType === "STOCK_BUCKET_INTEGRITY");
  const stockBucketSummary = {
    mismatchCount: stockBucketIntegrity.length,
    criticalCount: stockBucketIntegrity.filter((r) => r.severity === "Critical").length,
    majorCount: stockBucketIntegrity.filter((r) => r.severity === "Major").length,
    lastScan: new Date().toISOString(),
  };

  return {
    lastAuditRun: new Date().toISOString(),
    generatedAt: new Date().toISOString(),
    companyCode,
    /** Combined integrity + operational (with `section`). Aging is separate. */
    issues: combinedIssues,
    integrityIssues,
    operationalPending,
    agingMonitor,
    operationalCounters: operationalCounters(operationalPending),
    procurementCounters: procurementCounters(operationalPending),
    agingBandCounters: agingBandCounters([...operationalPending, ...agingMonitor]),
    sections: {
      integrity: integrityIssues,
      operationalPending,
      agingMonitor,
    },
    healthScore,
    healthRating: healthRating(healthScore),
    scoreBreakdown,
    criticalCount,
    majorCount,
    minorCount,
    integrityIssueCount: integrityIssues.length,
    operationalIssueCount: operationalPending.length,
    operationalPendingCount: operationalPending.length,
    procurementQueueCount: operationalPending.filter((r) => isProcurementQueueType(r.issueType)).length,
    agingIssueCount: agingMonitor.length,
    agingMonitorCount: agingMonitor.length,
    uniquePendingDocumentCount: operationalPending.length,
    totalIssues: combinedIssues.length,
    agingThresholdDays: DEFAULT_AGING_DAYS,
    agingDefaults: { defaultDays: DEFAULT_AGING_DAYS },
    stockBucketSummary,
    charts: buildCharts(integrityIssues),
    chartsOperational: buildCharts(operationalPending),
    counts,
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
  const sectionRaw = upper(rawFilters.section || rawFilters.category || "");
  const sectionFilter = ["INTEGRITY", "OPERATIONAL", "OPERATIONAL_PENDING", "AGING"].includes(sectionRaw)
    ? sectionRaw === "OPERATIONAL_PENDING"
      ? "OPERATIONAL"
      : sectionRaw
    : "";

  const scan = await getOrRunScan(companyId, companyCode, refresh);

  let scoped = scan.issues || [];
  if (sectionFilter === "INTEGRITY") scoped = scan.integrityIssues || [];
  else if (sectionFilter === "OPERATIONAL") scoped = scan.operationalPending || [];
  else if (sectionFilter === "AGING") scoped = scan.agingMonitor || [];

  const filteredIssues = applyFilters(scoped, filters);
  const filteredIntegrity = applyFilters(scan.integrityIssues || [], filters);
  const filteredOperational = applyFilters(scan.operationalPending || [], filters);
  const filteredAging = applyFilters(scan.agingMonitor || [], filters);

  const charts = hasActiveFilters(filters) || sectionFilter
    ? buildCharts(filteredIntegrity)
    : scan.charts;

  return {
    generatedAt: scan.generatedAt || scan.lastAuditRun,
    lastAuditRun: scan.lastAuditRun,
    fromCache: scan.fromCache,
    cacheExpiresAt: scan.cacheExpiresAt,
    companyCode: scan.companyCode,
    filters: { ...filters, section: sectionFilter || "" },
    counts: scan.counts,
    healthScore: scan.healthScore,
    healthRating: scan.healthRating,
    scoreBreakdown: scan.scoreBreakdown,
    criticalCount: scan.criticalCount,
    majorCount: scan.majorCount,
    minorCount: scan.minorCount,
    integrityIssueCount: scan.integrityIssueCount,
    operationalIssueCount: filteredOperational.length,
    operationalPendingCount: filteredOperational.length,
    procurementQueueCount: filteredOperational.filter((r) => isProcurementQueueType(r.issueType)).length,
    agingIssueCount: filteredAging.length,
    agingMonitorCount: filteredAging.length,
    uniquePendingDocumentCount: filteredOperational.length,
    totalIssues: filteredIssues.length,
    /** Combined integrity + operational (section field on each row). */
    issues: filteredIssues,
    integrityIssues: filteredIntegrity,
    operationalPending: filteredOperational,
    agingMonitor: filteredAging,
    operationalCounters: operationalCounters(filteredOperational),
    procurementCounters: procurementCounters(filteredOperational),
    agingBandCounters: agingBandCounters([...filteredOperational, ...filteredAging]),
    sections: {
      integrity: filteredIntegrity,
      operationalPending: filteredOperational,
      agingMonitor: filteredAging,
    },
    agingThresholdDays: scan.agingThresholdDays,
    agingDefaults: scan.agingDefaults,
    stockBucketSummary: scan.stockBucketSummary,
    charts,
    chartsOperational: buildCharts(filteredOperational),
  };
}
