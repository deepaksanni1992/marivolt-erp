import mongoose from "mongoose";
import crypto from "crypto";
import OrderAllocation from "../models/OrderAllocation.js";
import OrderAcknowledgement from "../models/OrderAcknowledgement.js";
import ProformaInvoice from "../models/ProformaInvoice.js";
import Quotation from "../models/Quotation.js";
import StorePacking from "../models/StorePacking.js";
import StoreDispatch from "../models/StoreDispatch.js";
import SalesDispatch from "../models/SalesDispatch.js";
import SalesInvoice from "../models/SalesInvoice.js";
import StockLedger from "../models/StockLedger.js";
import * as stockService from "../services/stockService.js";
import { writeAudit } from "../services/auditService.js";
import { nextUniqueSalesDocNumber } from "../utils/salesDocNumber.js";
import {
  firstNonEmpty,
  resolveDocumentCustomerFields,
} from "../utils/customerTransactionFields.js";
import {
  PACKING_CSV_HEADER,
  buildPackingImportPreview,
  validatePackingPackagesForSave,
} from "../services/packingCsvService.js";
import {
  CLAIMABLE_CANCEL_STATUSES,
  PACKING_ALREADY_CANCELLED,
  PACKING_ALREADY_POSTED,
  PACKING_CANCEL_CONFLICT,
  PACKING_CANCEL_IN_PROGRESS,
  PACKING_LEDGER_INCONSISTENT,
  PACKING_POST_IN_PROGRESS,
  PACKING_POSTING_CONFLICT,
  PACKING_SOURCE_DOCUMENT_TYPE,
  POSTED_PACKING_STATUSES,
  buildPackingEffectKey,
  buildPackingReversalEffectKey,
  isPackingEffectDuplicateKeyError,
  packingConflictError,
} from "../utils/packingIdempotency.js";
import {
  CLAIMABLE_DISPATCH_CANCEL_STATUSES,
  DISPATCH_ALREADY_CANCELLED,
  DISPATCH_ALREADY_POSTED,
  DISPATCH_CANCEL_CONFLICT,
  DISPATCH_CANCEL_IN_PROGRESS,
  DISPATCH_EXCEEDS_PACKED_QTY,
  DISPATCH_LEDGER_INCONSISTENT,
  DISPATCH_POST_IN_PROGRESS,
  DISPATCH_POSTING_CONFLICT,
  DISPATCH_SOURCE_DOCUMENT_TYPE,
  DISPATCH_SOURCE_PACKING_INVALID,
  POSTED_DISPATCH_STATUSES,
  buildDispatchEffectKey,
  buildDispatchReversalEffectKey,
  dispatchConflictError,
  isDispatchEffectDuplicateKeyError,
} from "../utils/dispatchIdempotency.js";
import {
  computeDispatchStatus,
  isInvoiceDispatchEligible,
} from "../utils/salesInvoiceState.js";
import {
  QUANTITY_CLAIM_EXHAUSTED,
  claimAllocationLinePackQty,
  claimPackingLineDispatchQty,
  releaseAllocationLinePackQty,
  releasePackingLineDispatchQty,
} from "../utils/quantitySerialization.js";
import {
  CANDIDATE_CAP,
  buildEligibleAllocationMongoFilter,
  escapeRegex,
  paginateArray,
  parseListPaging,
  safeSearchTerm,
  sortEligibleAllocations,
  summarizeAllocationPendingPack,
  toEligibleAllocationItem,
} from "../utils/eligibleDocumentSearch.js";

function withCompany(req, filter = {}) {
  return { companyId: req.companyId, ...filter };
}
function t(v) {
  return String(v ?? "").trim();
}

async function resolveCustomerSnapshotForAllocation(req, allocation) {
  const [oa, pi, quotation] = await Promise.all([
    allocation?.linkedOAId
      ? OrderAcknowledgement.findOne(withCompany(req, { _id: allocation.linkedOAId })).lean()
      : null,
    allocation?.linkedProformaId
      ? ProformaInvoice.findOne(withCompany(req, { _id: allocation.linkedProformaId })).lean()
      : null,
    allocation?.linkedQuotationId
      ? Quotation.findOne(withCompany(req, { _id: allocation.linkedQuotationId })).lean()
      : null,
  ]);
  const fromOa = oa ? resolveDocumentCustomerFields(oa) : {};
  const fromPi = pi ? resolveDocumentCustomerFields(pi) : {};
  const fromQtn = quotation ? resolveDocumentCustomerFields(quotation) : {};
  const pick = (key) => firstNonEmpty(fromOa[key], fromPi[key], fromQtn[key]);
  return {
    customerReference: firstNonEmpty(
      oa?.customerPORef,
      pi?.customerReference,
      quotation?.customerReference
    ),
    contactPerson: pick("contactPerson"),
    attention: pick("attention"),
    billingAddress: pick("billingAddress"),
    shippingAddress: pick("shippingAddress"),
    paymentTerms: pick("paymentTerms"),
  };
}

const PACKAGE_TYPES = new Set(["CARTON", "PALLET", "WOODEN_BOX", "CRATE", "BUNDLE"]);

function normalizePackageType(v) {
  const raw = t(v || "CARTON").toUpperCase().replace(/[\s-]+/g, "_");
  return PACKAGE_TYPES.has(raw) ? raw : "CARTON";
}

async function nextPackingNo(companyId, companyCode) {
  return nextUniqueSalesDocNumber({ companyId, companyCode, docKey: "PACKING", model: StorePacking, field: "packingNo" });
}

async function nextDispatchNo(companyId, companyCode) {
  return nextUniqueSalesDocNumber({ companyId, companyCode, docKey: "DISPATCH", model: StoreDispatch, field: "dispatchNo" });
}

async function sumPostedPackQtyByLine(companyId, allocationId, session = null) {
  const q = StorePacking.find({
    companyId,
    allocationId,
    status: { $in: POSTED_PACKING_STATUSES },
  }).select("lines");
  if (session) q.session(session);
  const packs = await q.lean();
  const map = new Map();
  for (const p of packs) {
    for (const ln of p.lines || []) {
      if (!ln.allocationLineId) continue;
      const k = String(ln.allocationLineId);
      map.set(k, (map.get(k) || 0) + (Number(ln.packQty) || 0));
    }
  }
  return map;
}

async function findPackingPackedLedgers(companyId, packingId, session = null) {
  const q = StockLedger.find({
    companyId,
    sourceDocumentType: PACKING_SOURCE_DOCUMENT_TYPE,
    sourceDocumentId: packingId,
    movementType: "PACKED",
  });
  if (session) q.session(session);
  return q.lean();
}

async function findPackingUnpackedLedgers(companyId, packingId, session = null) {
  const q = StockLedger.find({
    companyId,
    sourceDocumentType: PACKING_SOURCE_DOCUMENT_TYPE,
    sourceDocumentId: packingId,
    movementType: "UNPACKED",
  });
  if (session) q.session(session);
  return q.lean();
}

async function findLegacyPackedLedgersByPackingNo(companyId, packingNo, session = null) {
  const q = StockLedger.find({
    companyId,
    referenceNo: String(packingNo || ""),
    $or: [{ movementType: "PACKED" }, { transactionType: "PACKED" }],
  });
  if (session) q.session(session);
  return q.lean();
}

function packingLinesNeedingStock(doc) {
  return (doc.lines || []).filter((ln) => (Number(ln.packQty) || 0) > 0 && ln._id);
}

async function assertPackingPostConsistency(companyId, doc, session = null) {
  const need = packingLinesNeedingStock(doc);
  const ledgers = await findPackingPackedLedgers(companyId, doc._id, session);
  if (ledgers.length === need.length && need.every((ln) => ledgers.some((r) => String(r.sourceLineId) === String(ln._id)))) {
    return { ok: true, mode: "source" };
  }
  // Legacy posted packings: evidence by packingNo only (no source identity).
  const legacy = await findLegacyPackedLedgersByPackingNo(companyId, doc.packingNo, session);
  if (legacy.length > 0 && ledgers.length === 0) {
    return { ok: true, mode: "legacy" };
  }
  return { ok: false, mode: "missing", expected: need.length, found: ledgers.length, legacy: legacy.length };
}

async function recalculateAllocationPackingProgress(req, allocation, session) {
  if (!allocation) return;
  const packedByLine = await sumPostedPackQtyByLine(req.companyId, allocation._id, session);
  let totalAlloc = 0;
  let totalPacked = 0;
  for (const ln of allocation.lines || []) {
    const qty = Number(ln.qty) || 0;
    totalAlloc += qty;
    totalPacked += Number(packedByLine.get(String(ln._id)) || 0);
  }
  if (!(totalAlloc > 0) || totalPacked <= 0) {
    if (String(allocation.status || "").toUpperCase() !== "CANCELLED") {
      allocation.status = "OPEN";
      allocation.packingStatus = "NOT_PACKED";
    }
  } else if (totalPacked >= totalAlloc - 1e-6) {
    allocation.status = "FULLY_PACKED";
    allocation.packingStatus = "FULLY_PACKED";
  } else {
    allocation.status = "PARTIALLY_PACKED";
    allocation.packingStatus = "PARTIALLY_PACKED";
  }
  allocation.updatedBy = req.user?.email || "";
  await allocation.save({ session });
}

async function sumPostedDispatchQtyByPackingLine(companyId, packingId, session = null) {
  const q = StoreDispatch.find({
    companyId,
    packingId,
    status: { $in: [...POSTED_DISPATCH_STATUSES] },
  }).select("lines");
  if (session) q.session(session);
  const rows = await q.lean();
  const map = new Map();
  for (const d of rows) {
    for (const ln of d.lines || []) {
      if (!ln.packingLineId) continue;
      const k = String(ln.packingLineId);
      map.set(k, (map.get(k) || 0) + (Number(ln.dispatchQty) || 0));
    }
  }
  return map;
}

async function sumPostedDispatchQtyByInvoiceLine(companyId, salesInvoiceId, session = null) {
  const q = StoreDispatch.find({
    companyId,
    salesInvoiceId,
    status: { $in: [...POSTED_DISPATCH_STATUSES] },
  }).select("lines");
  if (session) q.session(session);
  const rows = await q.lean();
  const map = new Map();
  for (const d of rows) {
    for (const ln of d.lines || []) {
      if (!ln.invoiceLineId) continue;
      const k = String(ln.invoiceLineId);
      map.set(k, (map.get(k) || 0) + (Number(ln.dispatchQty) || 0));
    }
  }
  return map;
}

async function findDispatchOutLedgers(companyId, dispatchId, session = null) {
  const q = StockLedger.find({
    companyId,
    sourceDocumentType: DISPATCH_SOURCE_DOCUMENT_TYPE,
    sourceDocumentId: dispatchId,
    movementType: "DISPATCH_OUT",
  });
  if (session) q.session(session);
  return q.lean();
}

async function findDispatchCancelLedgers(companyId, dispatchId, session = null) {
  const q = StockLedger.find({
    companyId,
    sourceDocumentType: DISPATCH_SOURCE_DOCUMENT_TYPE,
    sourceDocumentId: dispatchId,
    movementType: "DISPATCH_CANCEL",
  });
  if (session) q.session(session);
  return q.lean();
}

async function findLegacyDispatchOutLedgersByDispatchNo(companyId, dispatchNo, session = null) {
  const q = StockLedger.find({
    companyId,
    referenceNo: String(dispatchNo || ""),
    $or: [{ movementType: "DISPATCH_OUT" }, { transactionType: "DISPATCH_OUT" }],
  });
  if (session) q.session(session);
  return q.lean();
}

function dispatchLinesNeedingStock(doc) {
  return (doc.lines || []).filter((ln) => (Number(ln.dispatchQty) || 0) > 0 && ln._id);
}

async function assertDispatchPostConsistency(companyId, doc, session = null) {
  const need = dispatchLinesNeedingStock(doc);
  const ledgers = await findDispatchOutLedgers(companyId, doc._id, session);
  if (
    ledgers.length === need.length &&
    need.every((ln) => ledgers.some((r) => String(r.sourceLineId) === String(ln._id)))
  ) {
    return { ok: true, mode: "source" };
  }
  const legacy = await findLegacyDispatchOutLedgersByDispatchNo(companyId, doc.dispatchNo, session);
  if (legacy.length > 0 && ledgers.length === 0) {
    return { ok: true, mode: "legacy" };
  }
  return { ok: false, mode: "missing", expected: need.length, found: ledgers.length, legacy: legacy.length };
}

async function recalculateInvoiceDispatchProgress(req, invoice, session) {
  if (!invoice) return;
  const remaining = await StoreDispatch.find({
    companyId: req.companyId,
    salesInvoiceId: invoice._id,
    status: { $in: [...POSTED_DISPATCH_STATUSES] },
  })
    .session(session)
    .sort({ postedAt: -1, createdAt: -1 })
    .lean();

  const dispatchedByLine = await sumPostedDispatchQtyByInvoiceLine(req.companyId, invoice._id, session);
  const totalInvoiceQty = (invoice.lines || []).reduce((sum, ln) => sum + (Number(ln.qty) || 0), 0);
  const totalDispatched = Array.from(dispatchedByLine.values()).reduce(
    (sum, qty) => sum + (Number(qty) || 0),
    0
  );

  // S1 — dispatch ownership only. Never write paymentStatus or documentStatus.
  invoice.dispatchStatus = computeDispatchStatus({
    invoiceQty: totalInvoiceQty,
    dispatchedQty: totalDispatched,
  });

  if (!remaining.length) {
    // Clear Store-Dispatch link only when it points at a StoreDispatch id.
    // Do not clear a SalesDispatch logistics link (S2 boundary).
    const linkedId = invoice.linkedSalesDispatchId;
    if (linkedId) {
      const isStore = await StoreDispatch.findOne({ _id: linkedId })
        .session(session)
        .select("_id")
        .lean();
      if (isStore) {
        invoice.linkedSalesDispatchId = null;
        invoice.linkedSalesDispatchNo = "";
      }
    }
  } else {
    const latest = remaining[0];
    // S2 — prefer canonical Sales Dispatch link when the StoreDispatch was posted for one.
    if (latest.canonicalSalesDispatchId) {
      const canon = await SalesDispatch.findOne({ _id: latest.canonicalSalesDispatchId })
        .session(session)
        .select("dispatchNo")
        .lean();
      invoice.linkedSalesDispatchId = latest.canonicalSalesDispatchId;
      invoice.linkedSalesDispatchNo = canon?.dispatchNo || latest.canonicalSalesDispatchNo || "";
    } else {
      invoice.linkedSalesDispatchId = latest._id;
      invoice.linkedSalesDispatchNo = latest.dispatchNo || "";
    }
  }
  invoice.updatedBy = req.user?.email || "";
  await invoice.save({ session });
}

async function recalculateAllocationDispatchProgress(req, allocationId, session) {
  if (!allocationId) return;
  const allocation = await OrderAllocation.findOne(withCompany(req, { _id: allocationId })).session(session);
  if (!allocation) return;
  const remaining = await StoreDispatch.find({
    companyId: req.companyId,
    allocationId,
    status: { $in: [...POSTED_DISPATCH_STATUSES] },
  })
    .session(session)
    .select("status")
    .lean();
  if (!remaining.length) {
    allocation.dispatchStatus = "NOT_DISPATCHED";
  } else if (remaining.some((d) => d.status === "PARTIALLY_DISPATCHED")) {
    allocation.dispatchStatus = "PARTIALLY_DISPATCHED";
  } else if (remaining.every((d) => d.status === "FULLY_DISPATCHED" || d.status === "POSTED")) {
    allocation.dispatchStatus = "DISPATCHED";
  } else {
    allocation.dispatchStatus = "PARTIALLY_DISPATCHED";
  }
  allocation.updatedBy = req.user?.email || "";
  await allocation.save({ session });
}

async function sumInvoicedQtyByPackingLine(companyId, packingId) {
  const invoices = await SalesInvoice.find({
    companyId,
    linkedStorePackingId: packingId,
    $and: [
      { status: { $ne: "CANCELLED" } },
      { documentStatus: { $ne: "CANCELLED" } },
    ],
  })
    .select("lines")
    .lean();
  const map = new Map();
  for (const inv of invoices) {
    for (const ln of inv.lines || []) {
      if (!ln.packingLineId) continue;
      const k = String(ln.packingLineId);
      map.set(k, (map.get(k) || 0) + (Number(ln.qty) || 0));
    }
  }
  return map;
}

function normalizePackageItems(bodyItems = [], allocation) {
  const allocLines = allocation.lines || [];
  return (bodyItems || [])
    .map((ln) => {
      const allocationLineId = mongoose.Types.ObjectId.isValid(String(ln.allocationLineId || ""))
        ? new mongoose.Types.ObjectId(String(ln.allocationLineId))
        : null;
      const match = allocationLineId ? allocLines.find((x) => String(x._id) === String(allocationLineId)) : null;
      const article = String(ln.article || match?.article || "").trim().toUpperCase();
      return {
        allocationLineId,
        article,
        description: t(ln.description || match?.description || ""),
        spn: t(ln.spn || ln.partNumber || match?.partNumber || ""),
        materialCode: t(ln.materialCode || match?.materialCode || ""),
        allocatedQty: Number(match?.qty) || 0,
        qty: Math.max(0, Number(ln.qty ?? ln.packQty) || 0),
        uom: t(ln.uom || match?.uom || "PCS") || "PCS",
        remarks: t(ln.remarks),
      };
    })
    .filter((ln) => ln.article && ln.qty > 0 && ln.allocationLineId);
}

function mergeDuplicatePackageItems(items = []) {
  const map = new Map();
  for (const it of items) {
    const k = String(it.allocationLineId || "");
    if (!k) continue;
    const prev = map.get(k);
    if (!prev) map.set(k, { ...it });
    else prev.qty = (Number(prev.qty) || 0) + (Number(it.qty) || 0);
  }
  return Array.from(map.values()).filter((ln) => ln.qty > 0);
}

function normalizePackingPackages(bodyPackages = [], allocation) {
  return (bodyPackages || [])
    .map((pkg, idx) => {
      const items = mergeDuplicatePackageItems(normalizePackageItems(pkg.items || [], allocation));
      return {
        packageNo: t(pkg.packageNo) || `Carton-${idx + 1}`,
        packageType: normalizePackageType(pkg.packageType),
        dimensions: t(pkg.dimensions),
        grossWeightKg: Math.max(0, Number(pkg.grossWeightKg) || 0),
        netWeightKg: Math.max(0, Number(pkg.netWeightKg) || 0),
        packageRemarks: t(pkg.packageRemarks || pkg.remarks),
        marksAndNumbers: t(pkg.marksAndNumbers),
        barcode: t(pkg.barcode),
        qrCode: t(pkg.qrCode),
        items,
      };
    })
    .filter((pkg) => pkg.packageNo && pkg.items.length);
}

function legacyLinesToPackages(bodyLines = [], allocation) {
  const items = normalizePackageItems(bodyLines, allocation);
  if (!items.length) return [];
  return [
    {
      packageNo: "Carton-1",
      packageType: "CARTON",
      dimensions: "",
      grossWeightKg: 0,
      netWeightKg: 0,
      packageRemarks: "",
      marksAndNumbers: "",
      barcode: "",
      qrCode: "",
      items,
    },
  ];
}

function aggregatePackingLines(packages = [], allocation) {
  const allocLines = allocation.lines || [];
  const map = new Map();
  for (const pkg of packages || []) {
    for (const item of pkg.items || []) {
      const lineId = String(item.allocationLineId || "");
      const match = allocLines.find((x) => String(x._id) === lineId);
      if (!match) continue;
      const prev = map.get(lineId) || {
        allocationLineId: item.allocationLineId,
        article: String(item.article || match.article || "").trim().toUpperCase(),
        description: t(item.description || match.description || ""),
        spn: t(item.spn || match.partNumber || ""),
        materialCode: t(item.materialCode || match.materialCode || ""),
        allocatedQty: Number(match.qty) || 0,
        packQty: 0,
        uom: t(item.uom || match.uom || "PCS") || "PCS",
        remarks: "",
      };
      prev.packQty += Number(item.qty) || 0;
      map.set(lineId, prev);
    }
  }
  return Array.from(map.values()).filter((ln) => ln.article && ln.packQty > 0 && ln.allocationLineId);
}

function packageTotals(packages = []) {
  return {
    totalPackages: packages.length,
    totalGrossWeightKg: packages.reduce((sum, pkg) => sum + (Number(pkg.grossWeightKg) || 0), 0),
    totalNetWeightKg: packages.reduce((sum, pkg) => sum + (Number(pkg.netWeightKg) || 0), 0),
  };
}

export async function listStorePacking(req, res) {
  try {
    const page = Math.max(1, Number(req.query.page || 1));
    const limit = Math.min(200, Math.max(1, Number(req.query.limit || 50)));
    const skip = (page - 1) * limit;
    const filter = withCompany(req);
    if (req.query.status) filter.status = String(req.query.status).toUpperCase();
    if (req.query.customerId) filter.customerId = req.query.customerId;
    if (req.query.warehouse) filter.warehouse = String(req.query.warehouse).toUpperCase();
    if (req.query.dateFrom || req.query.dateTo) {
      filter.packingDate = {};
      if (req.query.dateFrom) filter.packingDate.$gte = new Date(req.query.dateFrom);
      if (req.query.dateTo) {
        const end = new Date(req.query.dateTo);
        end.setHours(23, 59, 59, 999);
        filter.packingDate.$lte = end;
      }
    }
    const search = safeSearchTerm(req.query.search || req.query.q);
    if (search) {
      const re = new RegExp(escapeRegex(search), "i");
      filter.$or = [
        { packingNo: re },
        { customerName: re },
        { customerReference: re },
        { allocationNo: re },
        { linkedOANo: re },
        { linkedProformaNo: re },
        { linkedSalesInvoiceNos: re },
        { "lines.article": re },
        { "lines.partNumber": re },
        { "lines.materialCode": re },
      ];
    }
    const [items, total] = await Promise.all([
      StorePacking.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      StorePacking.countDocuments(filter),
    ]);
    res.json({ items, total, page, limit, hasMore: skip + items.length < total });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function getStorePacking(req, res) {
  try {
    const id = req.params.id;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: "Invalid id" });
    const doc = await StorePacking.findOne(withCompany(req, { _id: id })).lean();
    if (!doc) return res.status(404).json({ message: "Not found" });
    res.json(doc);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

async function sumPostedPackQtyByAllocationIds(companyId, allocationIds = []) {
  const byAlloc = new Map();
  if (!allocationIds.length) return byAlloc;
  const packs = await StorePacking.find({
    companyId,
    allocationId: { $in: allocationIds },
    status: { $in: POSTED_PACKING_STATUSES },
  })
    .select("allocationId lines")
    .lean();
  for (const p of packs) {
    const aKey = String(p.allocationId);
    if (!byAlloc.has(aKey)) byAlloc.set(aKey, new Map());
    const map = byAlloc.get(aKey);
    for (const ln of p.lines || []) {
      if (!ln.allocationLineId) continue;
      const k = String(ln.allocationLineId);
      map.set(k, (map.get(k) || 0) + (Number(ln.packQty) || 0));
    }
  }
  return byAlloc;
}

/**
 * Shared eligible allocation lookup for packing selectors.
 * Preserves pending-pack formula; batches posted packing qty (no N+1).
 */
async function listEligibleAllocationsForPackingCore(req) {
  const { q, page, limit } = parseListPaging(req.query);
  const mongoFilter = buildEligibleAllocationMongoFilter({
    companyFilter: withCompany(req),
    q,
    customerId: t(req.query.customerId),
    status: t(req.query.status),
    dateFrom: t(req.query.dateFrom),
    dateTo: t(req.query.dateTo),
  });
  const candidates = await OrderAllocation.find(mongoFilter)
    .select(
      "_id allocationNo allocationDate status customerName warehouse linkedOANo linkedProformaNo linkedSalesInvoiceNo linkedQuotationNo lines._id lines.qty lines.article lines.partNumber lines.materialCode"
    )
    .sort({ allocationDate: -1 })
    .limit(CANDIDATE_CAP)
    .lean();

  const packedByAlloc = await sumPostedPackQtyByAllocationIds(
    req.companyId,
    candidates.map((a) => a._id)
  );

  const eligible = [];
  for (const allocation of candidates) {
    const packedByLine = packedByAlloc.get(String(allocation._id)) || new Map();
    const pending = summarizeAllocationPendingPack(allocation, packedByLine);
    if (pending.pendingPackQty <= 0) continue;
    eligible.push(toEligibleAllocationItem(allocation, pending));
  }

  const ranked = sortEligibleAllocations(eligible, q);
  return paginateArray(ranked, page, limit);
}

export async function listPendingPackingAllocations(req, res) {
  try {
    const result = await listEligibleAllocationsForPackingCore(req);
    res.json(result);
  } catch (err) {
    res.status(500).json({ message: "Failed to search allocations" });
  }
}

/** Alias with explicit naming for searchable packing source selector. */
export async function listEligibleAllocationsForPacking(req, res) {
  return listPendingPackingAllocations(req, res);
}

/** GET /packing/csv-template — column headers for packing CSV import. */
export async function getPackingCsvTemplate(req, res) {
  try {
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", "attachment; filename=\"packing-import-template.csv\"");
    res.send(`${PACKING_CSV_HEADER}\n`);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

/** POST /packing/import-preview — validate CSV; returns packages for UI when canApply. */
export async function importPackingCsvPreview(req, res) {
  try {
    const allocationId = req.body?.allocationId;
    const csvText = String(req.body?.csvText ?? "");
    if (!mongoose.Types.ObjectId.isValid(String(allocationId || ""))) {
      return res.status(400).json({ message: "Valid allocationId is required" });
    }
    if (!csvText.trim()) return res.status(400).json({ message: "csvText is required" });
    const allocation = await OrderAllocation.findOne(withCompany(req, { _id: allocationId })).lean();
    if (!allocation) return res.status(404).json({ message: "Allocation not found" });
    if (String(allocation.status || "").toUpperCase() === "CANCELLED") {
      return res.status(400).json({ message: "Allocation is cancelled" });
    }
    const postedByLine = await sumPostedPackQtyByLine(req.companyId, allocation._id);
    const result = buildPackingImportPreview({
      allocation,
      postedByLine,
      draftPackages: req.body?.draftPackages || [],
      csvText,
    });
    res.json(result);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function getPackingFromAllocation(req, res) {
  try {
    const allocationId = req.params.allocationId;
    if (!mongoose.Types.ObjectId.isValid(allocationId)) {
      return res.status(400).json({ message: "Invalid allocation id" });
    }
    const allocation = await OrderAllocation.findOne(withCompany(req, { _id: allocationId })).lean();
    if (!allocation) return res.status(404).json({ message: "Allocation not found" });
    const packedByLine = await sumPostedPackQtyByLine(req.companyId, allocation._id);
    const wh = String(allocation.warehouse || "MAIN").toUpperCase();
    const lines = [];
    for (const ln of allocation.lines || []) {
      const stock = await stockService.getStockBalance({
        companyId: req.companyId,
        article: ln.article,
        warehouse: wh,
      });
      const allocatedQty = Number(ln.qty) || 0;
      const alreadyPacked = packedByLine.get(String(ln._id)) || 0;
      lines.push({
        allocationLineId: ln._id,
        article: ln.article,
        description: ln.description || "",
        partNumber: ln.partNumber || "",
        materialCode: ln.materialCode || "",
        location: wh,
        qty: allocatedQty,
        allocatedQty,
        alreadyPacked,
        pendingPack: Math.max(0, allocatedQty - alreadyPacked),
        availableStock: stock.availableQty,
        uom: ln.uom || "PCS",
      });
    }
    res.json({
      allocation,
      lines,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function createStorePackingDraft(req, res) {
  try {
    const allocationId = req.body.allocationId;
    if (!mongoose.Types.ObjectId.isValid(String(allocationId || ""))) {
      return res.status(400).json({ message: "allocationId required" });
    }
    const allocation = await OrderAllocation.findOne(withCompany(req, { _id: allocationId }));
    if (!allocation) return res.status(404).json({ message: "Allocation not found" });
    if (String(allocation.status || "").toUpperCase() === "CANCELLED") {
      return res.status(400).json({ message: "Cannot pack a cancelled allocation" });
    }
    const packingNo = t(req.body.packingNo) || (await nextPackingNo(req.companyId, req.companyCode));
    const rawPackages = req.body.packages || [];
    const packedByLine = await sumPostedPackQtyByLine(req.companyId, allocation._id);
    const saveErrors = validatePackingPackagesForSave(rawPackages, allocation, packedByLine);
    if (saveErrors.length) {
      return res.status(400).json({ message: saveErrors[0], errors: saveErrors });
    }
    const packages = normalizePackingPackages(rawPackages, allocation);
    const normalizedPackages = packages.length ? packages : legacyLinesToPackages(req.body.lines || [], allocation);
    const lines = aggregatePackingLines(normalizedPackages, allocation);
    if (!lines.length) return res.status(400).json({ message: "At least one packing line required" });
    for (const ln of lines) {
      const allocLine = (allocation.lines || []).find((x) => String(x._id) === String(ln.allocationLineId));
      const maxQty = Number(allocLine?.qty) || 0;
      const already = packedByLine.get(String(ln.allocationLineId)) || 0;
      if (already + (Number(ln.packQty) || 0) > maxQty) {
        return res.status(400).json({ message: `Pack qty exceeds pending for ${ln.article} (max ${Math.max(0, maxQty - already)})` });
      }
    }
    const totals = packageTotals(normalizedPackages);
    const customerSnap = await resolveCustomerSnapshotForAllocation(req, allocation);
    const doc = await StorePacking.create({
      companyId: req.companyId,
      branchId: req.body.branchId || null,
      packingNo,
      packingDate: req.body.packingDate || new Date(),
      warehouse: String(allocation.warehouse || "MAIN").toUpperCase(),
      sourceDocumentType: "ORDER_ALLOCATION",
      sourceDocumentId: allocation._id,
      allocationId: allocation._id,
      allocationNo: allocation.allocationNo,
      linkedOANo: allocation.linkedOANo || "",
      linkedProformaNo: allocation.linkedProformaNo || "",
      customerName: allocation.customerName,
      customerReference: customerSnap.customerReference || "",
      contactPerson: customerSnap.contactPerson || "",
      attention: customerSnap.attention || "",
      billingAddress: customerSnap.billingAddress || "",
      shippingAddress: customerSnap.shippingAddress || "",
      paymentTerms: customerSnap.paymentTerms || "",
      engine: allocation.engine || "",
      model: allocation.model || "",
      esn: allocation.esn || "",
      currency: String(allocation.currency || "USD").toUpperCase(),
      ...totals,
      marksAndNumbers: t(req.body.marksAndNumbers),
      packages: normalizedPackages,
      lines,
      attachments: Array.isArray(req.body.attachments) ? req.body.attachments : [],
      remarks: t(req.body.remarks),
      status: "DRAFT",
      createdBy: req.user?.email || "",
      updatedBy: req.user?.email || "",
    });
    await writeAudit(req, {
      action: "CREATE",
      module: "STORE",
      entityType: "STORE_PACKING",
      entityId: doc._id,
      documentNo: doc.packingNo,
      description: `Packing ${doc.packingNo} draft`,
    });
    res.status(201).json(doc);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function postStorePacking(req, res) {
  const session = await mongoose.startSession();
  try {
    let idempotent = false;
    await session.withTransaction(async () => {
      const id = req.params.id;
      if (!mongoose.Types.ObjectId.isValid(id)) {
        throw packingConflictError(PACKING_POSTING_CONFLICT, "Invalid packing id", null, 400);
      }

      const claimed = await StorePacking.findOneAndUpdate(
        withCompany(req, { _id: id, status: "DRAFT" }),
        { $set: { status: "POSTING", updatedBy: req.user?.email || "" } },
        { new: true, session }
      );

      if (!claimed) {
        const existing = await StorePacking.findOne(withCompany(req, { _id: id })).session(session);
        if (!existing) throw packingConflictError(PACKING_POSTING_CONFLICT, "Packing not found", null, 404);
        const st = String(existing.status || "").toUpperCase();
        if (st === "POSTING") {
          throw packingConflictError(PACKING_POST_IN_PROGRESS, "Packing post already in progress");
        }
        if (st === "CANCELLING") {
          throw packingConflictError(PACKING_POSTING_CONFLICT, "Packing cancellation in progress");
        }
        if (POSTED_PACKING_STATUSES.includes(st)) {
          const consistency = await assertPackingPostConsistency(req.companyId, existing, session);
          if (!consistency.ok) {
            throw packingConflictError(
              PACKING_LEDGER_INCONSISTENT,
              "Packing is posted but expected PACKED ledger evidence is missing or incomplete",
              { packingId: String(existing._id), ...consistency }
            );
          }
          idempotent = true;
          return;
        }
        if (st === "CANCELLED") {
          throw packingConflictError(PACKING_POSTING_CONFLICT, "Cannot post a cancelled packing");
        }
        throw packingConflictError(PACKING_POSTING_CONFLICT, `Only DRAFT packing can be posted (status ${st})`);
      }

      const allocation = await OrderAllocation.findOne(withCompany(req, { _id: claimed.allocationId })).session(session);
      if (!allocation) throw new Error("Allocation not found");
      if (String(allocation.status || "").toUpperCase() === "CANCELLED") throw new Error("Allocation cancelled");

      const packedByLine = await sumPostedPackQtyByLine(req.companyId, allocation._id, session);
      const postPkgErrors = validatePackingPackagesForSave(claimed.packages || [], allocation, packedByLine);
      if (postPkgErrors.length) throw new Error(postPkgErrors[0]);
      const wh = String(claimed.warehouse || allocation.warehouse || "MAIN").toUpperCase();
      if (claimed.packages?.length) {
        const totals = packageTotals(claimed.packages);
        claimed.totalPackages = totals.totalPackages;
        claimed.totalGrossWeightKg = totals.totalGrossWeightKg;
        claimed.totalNetWeightKg = totals.totalNetWeightKg;
      }

      const postingOperationId = crypto.randomUUID();
      // S3 — claim allocation-line remaining qty BEFORE stock movement (txn-only).
      for (const ln of claimed.lines || []) {
        const lineId = String(ln.allocationLineId || "");
        const allocLine = (allocation.lines || []).find((x) => String(x._id) === lineId);
        if (!allocLine) throw new Error(`Allocation line missing for ${ln.article}`);
        if (!ln._id) throw new Error(`Packing line id missing for ${ln.article}`);
        const maxQty = Number(allocLine.qty) || 0;
        const already = packedByLine.get(lineId) || 0;
        const packQty = Number(ln.packQty) || 0;
        if (packQty <= 0) throw new Error(`Invalid pack qty for ${ln.article}`);
        if (already + packQty > maxQty) {
          throw new Error(`Pack qty exceeds pending for ${ln.article} (max ${maxQty - already})`);
        }
        await claimAllocationLinePackQty(OrderAllocation, session, {
          companyId: req.companyId,
          allocationId: allocation._id,
          allocationLineId: allocLine._id,
          packQty,
          allocatedQty: maxQty,
          postedFloor: already,
        });
        allocLine.packedQty = already + packQty;
      }

      for (const ln of claimed.lines || []) {
        const lineId = String(ln.allocationLineId || "");
        const allocLine = (allocation.lines || []).find((x) => String(x._id) === lineId);
        const packQty = Number(ln.packQty) || 0;
        const effectKey = buildPackingEffectKey({
          companyId: req.companyId,
          packingId: claimed._id,
          packingLineId: ln._id,
          movementType: "PACKED",
          warehouse: wh,
          location: wh,
        });
        try {
          await stockService.packFromAllocation({
            session,
            companyId: req.companyId,
            article: ln.article,
            warehouse: wh,
            qty: packQty,
            customerName: allocation.customerName || "",
            referenceType: "STORE_PACKING",
            referenceNo: claimed.packingNo,
            remarks: `Packing ${claimed.packingNo}`,
            createdBy: req.user?.email || "",
            sourceModule: "STORE",
            allocationId: allocation._id,
            transactionDate: claimed.packingDate || new Date(),
            sourceDocumentType: PACKING_SOURCE_DOCUMENT_TYPE,
            sourceDocumentId: claimed._id,
            sourceLineId: ln._id,
            sourceAllocationId: allocation._id,
            sourceAllocationLineId: allocLine._id,
            postingOperationId,
            effectKey,
          });
        } catch (stockErr) {
          if (isPackingEffectDuplicateKeyError(stockErr)) {
            throw packingConflictError(
              PACKING_POSTING_CONFLICT,
              "Packing stock effect already exists for this line",
              { packingId: String(claimed._id), packingLineId: String(ln._id) }
            );
          }
          throw stockErr;
        }
      }

      // Reload allocation so status save does not overwrite S3 packedQty claims.
      const allocationFresh = await OrderAllocation.findOne(
        withCompany(req, { _id: claimed.allocationId })
      ).session(session);
      if (!allocationFresh) throw new Error("Allocation not found");
      const totalAlloc = (allocationFresh.lines || []).reduce((sum, ln) => sum + (Number(ln.qty) || 0), 0);
      const totalPackedBefore = Array.from(packedByLine.values()).reduce((sum, qty) => sum + (Number(qty) || 0), 0);
      const totalPackedNow = (claimed.lines || []).reduce((sum, ln) => sum + (Number(ln.packQty) || 0), 0);
      claimed.status = totalPackedBefore + totalPackedNow >= totalAlloc - 1e-6 ? "FULLY_PACKED" : "PARTIALLY_PACKED";
      allocationFresh.status = claimed.status;
      allocationFresh.packingStatus = claimed.status === "FULLY_PACKED" ? "FULLY_PACKED" : "PARTIALLY_PACKED";
      allocationFresh.updatedBy = req.user?.email || "";
      claimed.postedAt = new Date();
      claimed.updatedBy = req.user?.email || "";
      await allocationFresh.save({ session });
      await claimed.save({ session });
      await writeAudit(req, {
        action: "POST",
        module: "STORE",
        entityType: "STORE_PACKING",
        entityId: claimed._id,
        documentNo: claimed.packingNo,
        description: `Packing ${claimed.packingNo} posted`,
        metadata: { postingOperationId },
      });
    });
    if (idempotent) {
      return res.status(200).json({ success: true, code: PACKING_ALREADY_POSTED, alreadyPosted: true });
    }
    res.json({ success: true });
  } catch (err) {
    if (
      err?.code === PACKING_ALREADY_POSTED ||
      err?.code === PACKING_POST_IN_PROGRESS ||
      err?.code === PACKING_POSTING_CONFLICT ||
      err?.code === PACKING_LEDGER_INCONSISTENT ||
      err?.code === QUANTITY_CLAIM_EXHAUSTED
    ) {
      return res.status(err.statusCode || 409).json({
        message: err.message,
        code: err.code,
        details: err.details || null,
      });
    }
    if (isPackingEffectDuplicateKeyError(err)) {
      return res.status(409).json({
        message: "Packing stock effect already exists",
        code: PACKING_POSTING_CONFLICT,
      });
    }
    res.status(400).json({ message: err.message });
  } finally {
    session.endSession();
  }
}

export async function cancelStorePacking(req, res) {
  const session = await mongoose.startSession();
  try {
    let idempotent = false;
    await session.withTransaction(async () => {
      const id = req.params.id;
      if (!mongoose.Types.ObjectId.isValid(id)) {
        throw packingConflictError(PACKING_CANCEL_CONFLICT, "Invalid packing id", null, 400);
      }

      const draftClaim = await StorePacking.findOneAndUpdate(
        withCompany(req, { _id: id, status: "DRAFT" }),
        {
          $set: {
            status: "CANCELLED",
            cancelledAt: new Date(),
            cancellationReason: t(req.body?.reason),
            updatedBy: req.user?.email || "",
          },
        },
        { new: true, session }
      );
      if (draftClaim) {
        await writeAudit(req, {
          action: "CANCEL",
          module: "STORE",
          entityType: "STORE_PACKING",
          entityId: draftClaim._id,
          documentNo: draftClaim.packingNo,
          description: `Packing ${draftClaim.packingNo} cancelled (DRAFT, no stock impact)`,
        });
        return;
      }

      const claimed = await StorePacking.findOneAndUpdate(
        withCompany(req, { _id: id, status: { $in: [...CLAIMABLE_CANCEL_STATUSES] } }),
        { $set: { status: "CANCELLING", updatedBy: req.user?.email || "" } },
        { new: true, session }
      );

      if (!claimed) {
        const existing = await StorePacking.findOne(withCompany(req, { _id: id })).session(session);
        if (!existing) throw packingConflictError(PACKING_CANCEL_CONFLICT, "Packing not found", null, 404);
        const st = String(existing.status || "").toUpperCase();
        if (st === "CANCELLED") {
          idempotent = true;
          return;
        }
        if (st === "CANCELLING") {
          throw packingConflictError(PACKING_CANCEL_IN_PROGRESS, "Packing cancellation already in progress");
        }
        if (st === "POSTING") {
          throw packingConflictError(PACKING_CANCEL_CONFLICT, "Packing post in progress");
        }
        throw packingConflictError(PACKING_CANCEL_CONFLICT, `Cannot cancel packing in status ${st}`);
      }

      const invoiced = await SalesInvoice.findOne({
        companyId: req.companyId,
        linkedStorePackingId: claimed._id,
        status: { $ne: "CANCELLED" },
      })
        .session(session)
        .select("_id invoiceNo")
        .lean();
      if (invoiced) throw new Error(`Cannot cancel packing: sales invoice ${invoiced.invoiceNo} exists`);

      const dispatched = await StoreDispatch.findOne({
        companyId: req.companyId,
        packingId: claimed._id,
        status: { $in: POSTED_DISPATCH_STATUSES },
      })
        .session(session)
        .select("_id")
        .lean();
      if (dispatched) throw new Error("Cannot cancel packing: dispatch already posted");

      const allocation = await OrderAllocation.findOne(withCompany(req, { _id: claimed.allocationId })).session(session);
      const cancellationOperationId = crypto.randomUUID();

      const sourced = await findPackingPackedLedgers(req.companyId, claimed._id, session);
      let effects = sourced;
      if (!effects.length) {
        const legacy = await findLegacyPackedLedgersByPackingNo(req.companyId, claimed.packingNo, session);
        if (!legacy.length) {
          throw packingConflictError(
            PACKING_LEDGER_INCONSISTENT,
            "Cannot cancel: original PACKED ledger evidence is missing",
            { packingId: String(claimed._id) }
          );
        }
        // Legacy: reverse using ledger warehouse/batch/serial dimensions (do not guess from defaults).
        effects = legacy;
      }

      const existingUnpack = await findPackingUnpackedLedgers(req.companyId, claimed._id, session);
      if (existingUnpack.length > 0) {
        throw packingConflictError(
          PACKING_CANCEL_CONFLICT,
          "Packing reversal effects already exist",
          { packingId: String(claimed._id), unpackCount: existingUnpack.length }
        );
      }

      for (const packedRow of effects) {
        const q = Number(packedRow.qtyOut) || 0;
        if (!(q > 0)) continue;
        const warehouse = String(packedRow.warehouse || packedRow.location || "").toUpperCase();
        if (!warehouse) {
          throw packingConflictError(
            PACKING_LEDGER_INCONSISTENT,
            "Cannot cancel: PACKED ledger row has no warehouse/location",
            { ledgerId: String(packedRow._id) }
          );
        }
        const packingLineId = packedRow.sourceLineId || null;
        const originalEffectKey =
          packedRow.effectKey ||
          buildPackingEffectKey({
            companyId: req.companyId,
            packingId: claimed._id,
            packingLineId: packingLineId || packedRow._id,
            movementType: "PACKED",
            warehouse,
            location: warehouse,
            batchNo: packedRow.batchNo || "",
            serialNo: packedRow.serialNo || "",
          });
        const effectKey = buildPackingReversalEffectKey(originalEffectKey);
        try {
          await stockService.unpackFromPacked({
            session,
            companyId: req.companyId,
            article: packedRow.article,
            warehouse,
            qty: q,
            batchNo: packedRow.batchNo || "",
            serialNo: packedRow.serialNo || "",
            customerName: allocation?.customerName || packedRow.customerName || "",
            referenceType: "STORE_PACKING",
            referenceNo: claimed.packingNo,
            remarks: `Cancel packing ${claimed.packingNo}`,
            createdBy: req.user?.email || "",
            sourceModule: "STORE",
            allocationId: claimed.allocationId,
            sourceDocumentType: PACKING_SOURCE_DOCUMENT_TYPE,
            sourceDocumentId: claimed._id,
            sourceLineId: packingLineId,
            sourceAllocationId: packedRow.sourceAllocationId || claimed.allocationId,
            sourceAllocationLineId: packedRow.sourceAllocationLineId || null,
            cancellationOperationId,
            effectKey,
            originalEffectKey,
            reversedFromLedgerId: packedRow._id,
          });
        } catch (stockErr) {
          if (isPackingEffectDuplicateKeyError(stockErr)) {
            throw packingConflictError(
              PACKING_CANCEL_CONFLICT,
              "Packing reversal effect already exists",
              { packingId: String(claimed._id), reversedFromLedgerId: String(packedRow._id) }
            );
          }
          throw stockErr;
        }
      }

      // S3 — return allocation-line pack claims (status is CANCELLING so soft sums exclude this doc).
      const otherPackedByLine = await sumPostedPackQtyByLine(req.companyId, claimed.allocationId, session);
      for (const ln of claimed.lines || []) {
        const packQty = Number(ln.packQty) || 0;
        if (!(packQty > 0) || !ln.allocationLineId) continue;
        const lineId = String(ln.allocationLineId);
        await releaseAllocationLinePackQty(OrderAllocation, session, {
          companyId: req.companyId,
          allocationId: claimed.allocationId,
          allocationLineId: ln.allocationLineId,
          packQty,
          postedFloor: (otherPackedByLine.get(lineId) || 0) + packQty,
        });
      }

      claimed.status = "CANCELLED";
      claimed.cancelledAt = new Date();
      claimed.cancellationReason = t(req.body?.reason);
      claimed.updatedBy = req.user?.email || "";
      await claimed.save({ session });
      const allocationFresh = allocation
        ? await OrderAllocation.findOne(withCompany(req, { _id: claimed.allocationId })).session(session)
        : null;
      await recalculateAllocationPackingProgress(req, allocationFresh, session);
      await writeAudit(req, {
        action: "CANCEL",
        module: "STORE",
        entityType: "STORE_PACKING",
        entityId: claimed._id,
        documentNo: claimed.packingNo,
        description: `Packing ${claimed.packingNo} cancelled`,
        metadata: { cancellationOperationId, reversedEffects: effects.length },
      });
    });
    if (idempotent) {
      return res.status(200).json({ success: true, code: PACKING_ALREADY_CANCELLED, alreadyCancelled: true });
    }
    res.json({ success: true });
  } catch (err) {
    if (
      err?.code === PACKING_ALREADY_CANCELLED ||
      err?.code === PACKING_CANCEL_IN_PROGRESS ||
      err?.code === PACKING_CANCEL_CONFLICT ||
      err?.code === PACKING_LEDGER_INCONSISTENT ||
      err?.code === QUANTITY_CLAIM_EXHAUSTED
    ) {
      return res.status(err.statusCode || 409).json({
        message: err.message,
        code: err.code,
        details: err.details || null,
      });
    }
    if (isPackingEffectDuplicateKeyError(err)) {
      return res.status(409).json({
        message: "Packing reversal effect already exists",
        code: PACKING_CANCEL_CONFLICT,
      });
    }
    res.status(400).json({ message: err.message });
  } finally {
    session.endSession();
  }
}

export async function listStoreDispatch(req, res) {
  try {
    const page = Math.max(1, Number(req.query.page || 1));
    const limit = Math.min(200, Math.max(1, Number(req.query.limit || 50)));
    const skip = (page - 1) * limit;
    const filter = withCompany(req);
    if (req.query.status) filter.status = String(req.query.status).toUpperCase();
    if (req.query.search) {
      const re = new RegExp(t(req.query.search), "i");
      filter.$or = [{ dispatchNo: re }, { customerName: re }, { packingNo: re }];
    }
    const [items, total] = await Promise.all([
      StoreDispatch.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      StoreDispatch.countDocuments(filter),
    ]);
    res.json({ items, total, page, limit });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function getStoreDispatch(req, res) {
  try {
    const id = req.params.id;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: "Invalid id" });
    const doc = await StoreDispatch.findOne(withCompany(req, { _id: id })).lean();
    if (!doc) return res.status(404).json({ message: "Not found" });
    res.json(doc);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function listPendingDispatchPackings(req, res) {
  try {
    return listPendingDispatchInvoices(req, res);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function listPendingDispatchInvoices(req, res) {
  try {
    const q = t(req.query.search);
    const filter = withCompany(req, {
      $or: [
        { documentStatus: "ISSUED" },
        // Pre-migration rows: issued-like legacy statuses that are not cancelled/draft.
        {
          documentStatus: { $in: [null, ""] },
          status: { $in: ["ISSUED", "PARTIALLY_PAID", "PAID", "DISPATCHED"] },
        },
      ],
      linkedStorePackingId: { $ne: null },
    });
    if (q) {
      const re = new RegExp(q, "i");
      filter.$or = [
        { invoiceNo: re },
        { customerName: re },
        { linkedStorePackingNo: re },
        { linkedOrderAllocationNo: re },
        { linkedOANo: re },
        { linkedProformaNo: re },
      ];
    }
    const invoices = await SalesInvoice.find(filter).sort({ invoiceDate: -1 }).limit(200).lean();
    const items = [];
    for (const invoice of invoices) {
      const dispatchedByLine = await sumPostedDispatchQtyByInvoiceLine(req.companyId, invoice._id);
      let invoiceQty = 0;
      let dispatchedQty = 0;
      for (const ln of invoice.lines || []) {
        invoiceQty += Number(ln.qty) || 0;
        dispatchedQty += dispatchedByLine.get(String(ln._id)) || 0;
      }
      const pendingDispatchQty = Math.max(0, invoiceQty - dispatchedQty);
      if (pendingDispatchQty <= 0) continue;
      items.push({
        _id: invoice._id,
        invoiceNo: invoice.invoiceNo,
        packingNo: invoice.linkedStorePackingNo || "",
        allocationNo: invoice.linkedOrderAllocationNo || "",
        linkedQuotationNo: invoice.linkedQuotationNo || "",
        linkedOANo: invoice.linkedOANo || "",
        linkedProformaNo: invoice.linkedProformaNo || "",
        customerName: invoice.customerName,
        status: invoice.status,
        invoiceQty,
        alreadyDispatchedQty: dispatchedQty,
        pendingDispatchQty,
      });
    }
    res.json({ items, total: items.length });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function getDispatchFromPacking(req, res) {
  return res.status(400).json({ message: "Dispatch must be created from a posted Sales Invoice, not directly from packing" });
}

export async function getDispatchFromInvoice(req, res) {
  try {
    const invoiceId = req.params.invoiceId;
    if (!mongoose.Types.ObjectId.isValid(invoiceId)) return res.status(400).json({ message: "Invalid invoice id" });
    const invoice = await SalesInvoice.findOne(withCompany(req, { _id: invoiceId })).lean();
    if (!invoice) return res.status(404).json({ message: "Sales Invoice not found" });
    if (!isInvoiceDispatchEligible(invoice)) {
      return res.status(400).json({ message: "Dispatch requires an issued (non-cancelled) Sales Invoice" });
    }
    if (!invoice.linkedStorePackingId) return res.status(400).json({ message: "Cannot dispatch without invoice linked to packing" });
    const packing = await StorePacking.findOne(withCompany(req, { _id: invoice.linkedStorePackingId })).lean();
    if (!packing) return res.status(404).json({ message: "Linked packing not found" });
    const dispatchedByLine = await sumPostedDispatchQtyByInvoiceLine(req.companyId, invoice._id);
    const lines = (invoice.lines || []).map((ln) => {
      const invoiceQty = Number(ln.qty) || 0;
      const out = dispatchedByLine.get(String(ln._id)) || 0;
      return {
        invoiceLineId: ln._id,
        packingLineId: ln.packingLineId || null,
        article: ln.article,
        description: ln.description || "",
        spn: ln.partNumber || "",
        materialCode: ln.materialCode || "",
        invoiceQty,
        dispatchedQty: out,
        pendingDispatch: Math.max(0, invoiceQty - out),
        uom: ln.uom || "PCS",
      };
    });
    res.json({ invoice, packing, lines });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

function normalizeDispatchLines(bodyLines = [], invoice) {
  const invoiceLines = invoice.lines || [];
  return (bodyLines || [])
    .map((ln) => {
      const invoiceLineId = mongoose.Types.ObjectId.isValid(String(ln.invoiceLineId || ""))
        ? new mongoose.Types.ObjectId(String(ln.invoiceLineId))
        : null;
      const match = invoiceLineId ? invoiceLines.find((x) => String(x._id) === String(invoiceLineId)) : null;
      return {
        invoiceLineId,
        packingLineId: match?.packingLineId || null,
        article: String(ln.article || match?.article || "").trim().toUpperCase(),
        description: t(ln.description || match?.description || ""),
        spn: t(ln.spn || match?.partNumber || ""),
        materialCode: t(ln.materialCode || match?.materialCode || ""),
        invoiceQty: Number(match?.qty) || 0,
        packedQty: Number(match?.qty) || 0,
        dispatchQty: Math.max(0, Number(ln.dispatchQty) || 0),
        uom: t(ln.uom || match?.uom || "PCS") || "PCS",
        remarks: t(ln.remarks),
      };
    })
    .filter((ln) => ln.article && ln.dispatchQty > 0 && ln.invoiceLineId);
}

export async function createStoreDispatchDraftCore(req, body = {}) {
  const invoiceId = body.salesInvoiceId || body.invoiceId;
  if (!mongoose.Types.ObjectId.isValid(String(invoiceId || ""))) {
    const err = new Error("salesInvoiceId required. Dispatch must be created from posted Sales Invoice.");
    err.statusCode = 400;
    throw err;
  }
  const invoice = await SalesInvoice.findOne(withCompany(req, { _id: invoiceId }));
  if (!invoice) {
    const err = new Error("Sales Invoice not found");
    err.statusCode = 404;
    throw err;
  }
  if (!isInvoiceDispatchEligible(invoice)) {
    const err = new Error("Dispatch requires an issued (non-cancelled) Sales Invoice");
    err.statusCode = 400;
    throw err;
  }
  if (!invoice.linkedStorePackingId) {
    const err = new Error("Cannot dispatch without invoice linked to packing");
    err.statusCode = 400;
    throw err;
  }
  const packing = await StorePacking.findOne(withCompany(req, { _id: invoice.linkedStorePackingId }));
  if (!packing) {
    const err = new Error("Linked packing not found");
    err.statusCode = 404;
    throw err;
  }
  if (!POSTED_PACKING_STATUSES.includes(packing.status)) {
    const err = new Error("Linked packing must be posted");
    err.statusCode = 400;
    throw err;
  }

  const dispatchedByLine = await sumPostedDispatchQtyByInvoiceLine(req.companyId, invoice._id);
  const linesIn = Array.isArray(body.lines) && body.lines.length
    ? body.lines
    : (invoice.lines || []).map((ln) => {
        const invoiceQty = Number(ln.qty) || 0;
        const out = dispatchedByLine.get(String(ln._id)) || 0;
        return { invoiceLineId: ln._id, article: ln.article, dispatchQty: Math.max(0, invoiceQty - out) };
      });

  const dispatchNo = t(body.dispatchNo) || (await nextDispatchNo(req.companyId, req.companyCode));
  const lines = normalizeDispatchLines(linesIn, invoice);
  if (!lines.length) {
    const err = new Error("Nothing to dispatch (all lines complete or empty)");
    err.statusCode = 400;
    throw err;
  }

  for (const ln of lines) {
    const match = (invoice.lines || []).find((x) => String(x._id) === String(ln.invoiceLineId));
    const invoiceQty = Number(match?.qty) || 0;
    const out = dispatchedByLine.get(String(ln.invoiceLineId)) || 0;
    if (out + ln.dispatchQty > invoiceQty) {
      const err = new Error(`Dispatch qty exceeds invoice pending dispatch qty for ${ln.article}`);
      err.statusCode = 400;
      throw err;
    }
  }

  const doc = await StoreDispatch.create({
    companyId: req.companyId,
    branchId: body.branchId || packing.branchId || null,
    dispatchNo,
    dispatchDate: body.dispatchDate || new Date(),
    warehouse: String(packing.warehouse || "MAIN").toUpperCase(),
    sourceDocumentType: "SALES_INVOICE",
    sourceDocumentId: invoice._id,
    packingId: packing._id,
    packingNo: packing.packingNo,
    salesInvoiceId: invoice._id,
    salesInvoiceNo: invoice.invoiceNo,
    canonicalSalesDispatchId: body.canonicalSalesDispatchId || null,
    canonicalSalesDispatchNo: t(body.canonicalSalesDispatchNo),
    allocationId: packing.allocationId,
    allocationNo: packing.allocationNo,
    linkedQuotationNo: invoice.linkedQuotationNo || "",
    linkedOANo: invoice.linkedOANo || packing.linkedOANo || "",
    linkedProformaNo: invoice.linkedProformaNo || packing.linkedProformaNo || "",
    customerName: invoice.customerName || packing.customerName,
    engine: packing.engine || "",
    model: packing.model || "",
    esn: packing.esn || "",
    transporter: t(body.transporter || body.courier),
    courier: t(body.courier || body.transporter),
    awbNo: t(body.awbNo || body.awbBlLrNo),
    blNo: t(body.blNo),
    trackingNo: t(body.trackingNo || body.awbNo || body.awbBlLrNo),
    containerNo: t(body.containerNo),
    lrNo: t(body.lrNo),
    vehicleNo: t(body.vehicleNo),
    driverName: t(body.driverName),
    driverPhone: t(body.driverPhone),
    deliveryNote: t(body.deliveryNote),
    shipmentMode: t(body.shipmentMode),
    currency: String(packing.currency || "USD").toUpperCase(),
    lines,
    attachments: Array.isArray(body.attachments) ? body.attachments : [],
    remarks: t(body.remarks),
    status: "DRAFT",
    createdBy: req.user?.email || "",
    updatedBy: req.user?.email || "",
  });
  await writeAudit(req, {
    action: "CREATE",
    module: "STORE",
    entityType: "STORE_DISPATCH",
    entityId: doc._id,
    documentNo: doc.dispatchNo,
    description: `Dispatch ${doc.dispatchNo} draft`,
    metadata: body.canonicalSalesDispatchId
      ? { canonicalSalesDispatchId: String(body.canonicalSalesDispatchId), internal: true }
      : undefined,
  });
  return doc;
}

export async function createStoreDispatchDraft(req, res) {
  try {
    const doc = await createStoreDispatchDraftCore(req, req.body || {});
    res.status(201).json(doc);
  } catch (err) {
    res.status(err.statusCode || 400).json({ message: err.message });
  }
}

export async function postStoreDispatch(req, res) {
  const session = await mongoose.startSession();
  try {
    let idempotent = false;
    await session.withTransaction(async () => {
      const id = req.params.id;
      if (!mongoose.Types.ObjectId.isValid(id)) {
        throw dispatchConflictError(DISPATCH_POSTING_CONFLICT, "Invalid dispatch id", null, 400);
      }

      const claimed = await StoreDispatch.findOneAndUpdate(
        withCompany(req, { _id: id, status: "DRAFT" }),
        { $set: { status: "POSTING", updatedBy: req.user?.email || "" } },
        { new: true, session }
      );

      if (!claimed) {
        const existing = await StoreDispatch.findOne(withCompany(req, { _id: id })).session(session);
        if (!existing) {
          throw dispatchConflictError(DISPATCH_POSTING_CONFLICT, "Dispatch not found", null, 404);
        }
        const st = String(existing.status || "").toUpperCase();
        if (st === "POSTING") {
          throw dispatchConflictError(DISPATCH_POST_IN_PROGRESS, "Dispatch post already in progress");
        }
        if (st === "CANCELLING") {
          throw dispatchConflictError(DISPATCH_POSTING_CONFLICT, "Dispatch cancellation in progress");
        }
        if (POSTED_DISPATCH_STATUSES.includes(st)) {
          const consistency = await assertDispatchPostConsistency(req.companyId, existing, session);
          if (!consistency.ok) {
            throw dispatchConflictError(
              DISPATCH_LEDGER_INCONSISTENT,
              "Dispatch is posted but expected DISPATCH_OUT ledger evidence is missing or incomplete",
              { dispatchId: String(existing._id), ...consistency }
            );
          }
          idempotent = true;
          return;
        }
        if (st === "CANCELLED") {
          throw dispatchConflictError(DISPATCH_POSTING_CONFLICT, "Cannot post a cancelled dispatch");
        }
        throw dispatchConflictError(
          DISPATCH_POSTING_CONFLICT,
          `Only DRAFT dispatch can be posted (status ${st})`
        );
      }

      const packing = await StorePacking.findOne(withCompany(req, { _id: claimed.packingId })).session(session);
      if (!packing || !POSTED_PACKING_STATUSES.includes(packing.status)) {
        throw dispatchConflictError(
          DISPATCH_SOURCE_PACKING_INVALID,
          "Linked packing is missing or not posted"
        );
      }
      const invoice = await SalesInvoice.findOne(withCompany(req, { _id: claimed.salesInvoiceId })).session(
        session
      );
      if (!invoice) throw new Error("Sales Invoice required before dispatch");
      if (!isInvoiceDispatchEligible(invoice)) {
        throw new Error("Dispatch requires an issued (non-cancelled) Sales Invoice");
      }

      const dispatchedByLine = await sumPostedDispatchQtyByInvoiceLine(
        req.companyId,
        invoice._id,
        session
      );
      const dispatchedByPackingLine = await sumPostedDispatchQtyByPackingLine(
        req.companyId,
        packing._id,
        session
      );
      const wh = String(claimed.warehouse || packing.warehouse || "MAIN").toUpperCase();
      const postingOperationId = crypto.randomUUID();

      // S3 — claim packing-line remaining qty BEFORE stock movement (txn-only).
      for (const ln of claimed.lines || []) {
        const dq = Number(ln.dispatchQty) || 0;
        if (!(dq > 0)) continue;
        if (!ln._id) throw new Error(`Dispatch line id missing for ${ln.article}`);

        const match = (invoice.lines || []).find((x) => String(x._id) === String(ln.invoiceLineId));
        if (!match) {
          throw dispatchConflictError(
            DISPATCH_POSTING_CONFLICT,
            `Invoice line missing for ${ln.article}`
          );
        }
        const invoiceQty = Number(match?.qty) || 0;
        const out = dispatchedByLine.get(String(ln.invoiceLineId)) || 0;
        if (out + dq > invoiceQty + 1e-6) {
          throw dispatchConflictError(
            DISPATCH_EXCEEDS_PACKED_QTY,
            `Dispatch qty exceeds invoice pending dispatch qty for ${ln.article}`,
            { article: ln.article, pending: Math.max(0, invoiceQty - out), requested: dq }
          );
        }

        const packingLineId = ln.packingLineId || match.packingLineId || null;
        if (!packingLineId) {
          throw dispatchConflictError(
            DISPATCH_SOURCE_PACKING_INVALID,
            `Dispatch line missing packing line link for ${ln.article}`
          );
        }
        const packLine = (packing.lines || []).find((x) => String(x._id) === String(packingLineId));
        if (!packLine) {
          throw dispatchConflictError(
            DISPATCH_SOURCE_PACKING_INVALID,
            `Packing line missing for ${ln.article}`
          );
        }
        const packedQty = Number(packLine.packQty) || Number(ln.packedQty) || invoiceQty;
        const packOut = dispatchedByPackingLine.get(String(packingLineId)) || 0;
        if (packOut + dq > packedQty + 1e-6) {
          throw dispatchConflictError(
            DISPATCH_EXCEEDS_PACKED_QTY,
            `Dispatch qty exceeds packed quantity for ${ln.article}`,
            { article: ln.article, packedQty, alreadyDispatched: packOut, requested: dq }
          );
        }
        await claimPackingLineDispatchQty(StorePacking, session, {
          companyId: req.companyId,
          packingId: packing._id,
          packingLineId,
          dispatchQty: dq,
          packQty: packedQty,
          postedFloor: packOut,
        });
        packLine.dispatchedQty = packOut + dq;
      }

      for (const ln of claimed.lines || []) {
        const dq = Number(ln.dispatchQty) || 0;
        if (!(dq > 0)) continue;
        const match = (invoice.lines || []).find((x) => String(x._id) === String(ln.invoiceLineId));
        const packingLineId = ln.packingLineId || match?.packingLineId || null;
        const effectKey = buildDispatchEffectKey({
          companyId: req.companyId,
          dispatchId: claimed._id,
          dispatchLineId: ln._id,
          movementType: "DISPATCH_OUT",
          warehouse: wh,
          location: wh,
        });
        try {
          await stockService.dispatchFromPacked({
            session,
            companyId: req.companyId,
            article: ln.article,
            warehouse: wh,
            qty: dq,
            customerName: claimed.customerName || "",
            referenceType: "STORE_DISPATCH",
            referenceNo: claimed.dispatchNo,
            remarks: `Dispatch ${claimed.dispatchNo}`,
            createdBy: req.user?.email || "",
            sourceModule: "STORE",
            transactionDate: claimed.dispatchDate || new Date(),
            sourceDocumentType: DISPATCH_SOURCE_DOCUMENT_TYPE,
            sourceDocumentId: claimed._id,
            sourceLineId: ln._id,
            sourceAllocationId: claimed.allocationId || packing.allocationId || null,
            sourcePackingId: packing._id,
            sourcePackingLineId: packingLineId,
            sourceSalesInvoiceId: invoice._id,
            sourceSalesInvoiceLineId: ln.invoiceLineId || match._id,
            postingOperationId,
            effectKey,
          });
        } catch (stockErr) {
          if (isDispatchEffectDuplicateKeyError(stockErr)) {
            throw dispatchConflictError(
              DISPATCH_POSTING_CONFLICT,
              "Dispatch stock effect already exists for this line",
              { dispatchId: String(claimed._id), dispatchLineId: String(ln._id) }
            );
          }
          throw stockErr;
        }
      }

      const totalInvoiceQty = (invoice.lines || []).reduce((sum, ln) => sum + (Number(ln.qty) || 0), 0);
      const totalDispatchedBefore = Array.from(dispatchedByLine.values()).reduce(
        (sum, qty) => sum + (Number(qty) || 0),
        0
      );
      const totalDispatchedNow = (claimed.lines || []).reduce(
        (sum, ln) => sum + (Number(ln.dispatchQty) || 0),
        0
      );
      claimed.status =
        totalDispatchedBefore + totalDispatchedNow >= totalInvoiceQty - 1e-6
          ? "FULLY_DISPATCHED"
          : "PARTIALLY_DISPATCHED";
      // S1 — dispatch writes dispatchStatus only (never payment/document status).
      // S2 — when an owning Sales Dispatch exists, SI logistics link points at that
      // canonical document; StoreDispatch id is stored on SalesDispatch.linkedStoreDispatchId.
      invoice.dispatchStatus = computeDispatchStatus({
        invoiceQty: totalInvoiceQty,
        dispatchedQty: totalDispatchedBefore + totalDispatchedNow,
      });
      if (claimed.canonicalSalesDispatchId) {
        const canon = await SalesDispatch.findOne(
          withCompany(req, { _id: claimed.canonicalSalesDispatchId })
        ).session(session);
        invoice.linkedSalesDispatchId = claimed.canonicalSalesDispatchId;
        invoice.linkedSalesDispatchNo = canon?.dispatchNo || claimed.canonicalSalesDispatchNo || "";
      } else {
        invoice.linkedSalesDispatchId = claimed._id;
        invoice.linkedSalesDispatchNo = claimed.dispatchNo;
      }
      invoice.updatedBy = req.user?.email || "";
      await invoice.save({ session });
      if (claimed.allocationId) {
        const allocation = await OrderAllocation.findOne(
          withCompany(req, { _id: claimed.allocationId })
        ).session(session);
        if (allocation) {
          allocation.dispatchStatus =
            claimed.status === "FULLY_DISPATCHED" ? "DISPATCHED" : "PARTIALLY_DISPATCHED";
          allocation.updatedBy = req.user?.email || "";
          await allocation.save({ session });
        }
      }
      claimed.postedAt = new Date();
      claimed.updatedBy = req.user?.email || "";
      await claimed.save({ session });
      await writeAudit(req, {
        action: "POST",
        module: "STORE",
        entityType: "STORE_DISPATCH",
        entityId: claimed._id,
        documentNo: claimed.dispatchNo,
        description: `Dispatch ${claimed.dispatchNo} posted`,
        metadata: { postingOperationId },
      });
    });
    if (idempotent) {
      return res.status(200).json({
        success: true,
        code: DISPATCH_ALREADY_POSTED,
        alreadyPosted: true,
      });
    }
    res.json({ success: true });
  } catch (err) {
    if (
      err?.code === DISPATCH_ALREADY_POSTED ||
      err?.code === DISPATCH_POST_IN_PROGRESS ||
      err?.code === DISPATCH_POSTING_CONFLICT ||
      err?.code === DISPATCH_LEDGER_INCONSISTENT ||
      err?.code === DISPATCH_EXCEEDS_PACKED_QTY ||
      err?.code === DISPATCH_SOURCE_PACKING_INVALID ||
      err?.code === QUANTITY_CLAIM_EXHAUSTED
    ) {
      return res.status(err.statusCode || 409).json({
        message: err.message,
        code: err.code,
        details: err.details || null,
      });
    }
    if (isDispatchEffectDuplicateKeyError(err)) {
      return res.status(409).json({
        message: "Dispatch stock effect already exists",
        code: DISPATCH_POSTING_CONFLICT,
      });
    }
    res.status(400).json({ message: err.message });
  } finally {
    session.endSession();
  }
}

export async function cancelStoreDispatch(req, res) {
  const session = await mongoose.startSession();
  try {
    let idempotent = false;
    await session.withTransaction(async () => {
      const id = req.params.id;
      if (!mongoose.Types.ObjectId.isValid(id)) {
        throw dispatchConflictError(DISPATCH_CANCEL_CONFLICT, "Invalid dispatch id", null, 400);
      }

      const draftClaim = await StoreDispatch.findOneAndUpdate(
        withCompany(req, { _id: id, status: "DRAFT" }),
        {
          $set: {
            status: "CANCELLED",
            cancelledAt: new Date(),
            cancellationReason: t(req.body?.reason),
            updatedBy: req.user?.email || "",
          },
        },
        { new: true, session }
      );
      if (draftClaim) {
        await writeAudit(req, {
          action: "CANCEL",
          module: "STORE",
          entityType: "STORE_DISPATCH",
          entityId: draftClaim._id,
          documentNo: draftClaim.dispatchNo,
          description: `Dispatch ${draftClaim.dispatchNo} cancelled (DRAFT, no stock impact)`,
        });
        return;
      }

      const claimed = await StoreDispatch.findOneAndUpdate(
        withCompany(req, { _id: id, status: { $in: [...CLAIMABLE_DISPATCH_CANCEL_STATUSES] } }),
        { $set: { status: "CANCELLING", updatedBy: req.user?.email || "" } },
        { new: true, session }
      );

      if (!claimed) {
        const existing = await StoreDispatch.findOne(withCompany(req, { _id: id })).session(session);
        if (!existing) {
          throw dispatchConflictError(DISPATCH_CANCEL_CONFLICT, "Dispatch not found", null, 404);
        }
        const st = String(existing.status || "").toUpperCase();
        if (st === "CANCELLED") {
          idempotent = true;
          return;
        }
        if (st === "CANCELLING") {
          throw dispatchConflictError(
            DISPATCH_CANCEL_IN_PROGRESS,
            "Dispatch cancellation already in progress"
          );
        }
        if (st === "POSTING") {
          throw dispatchConflictError(DISPATCH_CANCEL_CONFLICT, "Dispatch post in progress");
        }
        throw dispatchConflictError(
          DISPATCH_CANCEL_CONFLICT,
          `Cannot cancel dispatch in status ${st}`
        );
      }

      const cancellationOperationId = crypto.randomUUID();
      const sourced = await findDispatchOutLedgers(req.companyId, claimed._id, session);
      let effects = sourced;
      if (!effects.length) {
        const legacy = await findLegacyDispatchOutLedgersByDispatchNo(
          req.companyId,
          claimed.dispatchNo,
          session
        );
        if (!legacy.length) {
          throw dispatchConflictError(
            DISPATCH_LEDGER_INCONSISTENT,
            "Cannot cancel: original DISPATCH_OUT ledger evidence is missing",
            { dispatchId: String(claimed._id) }
          );
        }
        effects = legacy;
      }

      const existingCancel = await findDispatchCancelLedgers(req.companyId, claimed._id, session);
      if (existingCancel.length > 0) {
        throw dispatchConflictError(
          DISPATCH_CANCEL_CONFLICT,
          "Dispatch reversal effects already exist",
          { dispatchId: String(claimed._id), cancelCount: existingCancel.length }
        );
      }

      for (const outRow of effects) {
        const q = Number(outRow.qtyOut) || 0;
        if (!(q > 0)) continue;
        const warehouse = String(outRow.warehouse || outRow.location || "").toUpperCase();
        if (!warehouse) {
          throw dispatchConflictError(
            DISPATCH_LEDGER_INCONSISTENT,
            "Cannot cancel: DISPATCH_OUT ledger row has no warehouse/location",
            { ledgerId: String(outRow._id) }
          );
        }
        const dispatchLineId = outRow.sourceLineId || null;
        const originalEffectKey =
          outRow.effectKey ||
          buildDispatchEffectKey({
            companyId: req.companyId,
            dispatchId: claimed._id,
            dispatchLineId: dispatchLineId || outRow._id,
            movementType: "DISPATCH_OUT",
            warehouse,
            location: warehouse,
            batchNo: outRow.batchNo || "",
            serialNo: outRow.serialNo || "",
          });
        const effectKey = buildDispatchReversalEffectKey(originalEffectKey);
        try {
          await stockService.cancelDispatchFromPacked({
            session,
            companyId: req.companyId,
            article: outRow.article,
            warehouse,
            qty: q,
            batchNo: outRow.batchNo || "",
            serialNo: outRow.serialNo || "",
            customerName: claimed.customerName || outRow.customerName || "",
            referenceType: "STORE_DISPATCH",
            referenceNo: claimed.dispatchNo,
            remarks: `Cancel dispatch ${claimed.dispatchNo}`,
            createdBy: req.user?.email || "",
            sourceModule: "STORE",
            sourceDocumentType: DISPATCH_SOURCE_DOCUMENT_TYPE,
            sourceDocumentId: claimed._id,
            sourceLineId: dispatchLineId,
            sourceAllocationId: outRow.sourceAllocationId || claimed.allocationId || null,
            sourceAllocationLineId: outRow.sourceAllocationLineId || null,
            sourcePackingId: outRow.sourcePackingId || claimed.packingId || null,
            sourcePackingLineId: outRow.sourcePackingLineId || null,
            sourceSalesInvoiceId: outRow.sourceSalesInvoiceId || claimed.salesInvoiceId || null,
            sourceSalesInvoiceLineId: outRow.sourceSalesInvoiceLineId || null,
            cancellationOperationId,
            effectKey,
            originalEffectKey,
            reversedFromLedgerId: outRow._id,
          });
        } catch (stockErr) {
          if (isDispatchEffectDuplicateKeyError(stockErr)) {
            throw dispatchConflictError(
              DISPATCH_CANCEL_CONFLICT,
              "Dispatch reversal effect already exists",
              { dispatchId: String(claimed._id), reversedFromLedgerId: String(outRow._id) }
            );
          }
          throw stockErr;
        }
      }

      // S3 — return packing-line dispatch claims (status is CANCELLING so soft sums exclude this doc).
      if (claimed.packingId) {
        const otherByPackLine = await sumPostedDispatchQtyByPackingLine(
          req.companyId,
          claimed.packingId,
          session
        );
        for (const ln of claimed.lines || []) {
          const dq = Number(ln.dispatchQty) || 0;
          const packingLineId = ln.packingLineId || null;
          if (!(dq > 0) || !packingLineId) continue;
          await releasePackingLineDispatchQty(StorePacking, session, {
            companyId: req.companyId,
            packingId: claimed.packingId,
            packingLineId,
            dispatchQty: dq,
            postedFloor: (otherByPackLine.get(String(packingLineId)) || 0) + dq,
          });
        }
      }

      claimed.status = "CANCELLED";
      claimed.cancelledAt = new Date();
      claimed.cancellationReason = t(req.body?.reason);
      claimed.updatedBy = req.user?.email || "";
      await claimed.save({ session });

      if (claimed.salesInvoiceId) {
        const invoice = await SalesInvoice.findOne(
          withCompany(req, { _id: claimed.salesInvoiceId })
        ).session(session);
        await recalculateInvoiceDispatchProgress(req, invoice, session);
      }
      await recalculateAllocationDispatchProgress(req, claimed.allocationId, session);

      await writeAudit(req, {
        action: "CANCEL",
        module: "STORE",
        entityType: "STORE_DISPATCH",
        entityId: claimed._id,
        documentNo: claimed.dispatchNo,
        description: `Dispatch ${claimed.dispatchNo} cancelled`,
        metadata: { cancellationOperationId, reversedEffects: effects.length },
      });
    });
    if (idempotent) {
      return res.status(200).json({
        success: true,
        code: DISPATCH_ALREADY_CANCELLED,
        alreadyCancelled: true,
      });
    }
    res.json({ success: true });
  } catch (err) {
    if (
      err?.code === DISPATCH_ALREADY_CANCELLED ||
      err?.code === DISPATCH_CANCEL_IN_PROGRESS ||
      err?.code === DISPATCH_CANCEL_CONFLICT ||
      err?.code === DISPATCH_LEDGER_INCONSISTENT ||
      err?.code === QUANTITY_CLAIM_EXHAUSTED
    ) {
      return res.status(err.statusCode || 409).json({
        message: err.message,
        code: err.code,
        details: err.details || null,
      });
    }
    if (isDispatchEffectDuplicateKeyError(err)) {
      return res.status(409).json({
        message: "Dispatch reversal effect already exists",
        code: DISPATCH_CANCEL_CONFLICT,
      });
    }
    res.status(400).json({ message: err.message });
  } finally {
    session.endSession();
  }
}

/**
 * Read-only fulfilment status for Sales > Dispatch Status tab.
 */
export async function listDispatchStatus(req, res) {
  try {
    const filter = withCompany(req, {});
    if (req.query.customer) filter.customerName = new RegExp(t(req.query.customer), "i");
    const allocations = await OrderAllocation.find({
      ...filter,
      status: { $nin: ["CANCELLED"] },
    })
      .sort({ allocationDate: -1 })
      .limit(300)
      .lean();

    const allocIds = allocations.map((a) => a._id);
    const [packings, dispatches, invoices] = await Promise.all([
      StorePacking.find(withCompany(req, { allocationId: { $in: allocIds }, status: { $in: POSTED_PACKING_STATUSES } }))
        .select("packingNo allocationId lines")
        .lean(),
      StoreDispatch.find(withCompany(req, { allocationId: { $in: allocIds }, status: { $in: POSTED_DISPATCH_STATUSES } }))
        .select("dispatchNo dispatchDate allocationId packingNo lines status transporter courier awbNo trackingNo attachments")
        .lean(),
      SalesInvoice.find(withCompany(req, { linkedOrderAllocationId: { $in: allocIds }, status: { $ne: "CANCELLED" } }))
        .select("invoiceNo linkedOrderAllocationId lines")
        .lean(),
    ]);

    const packByAlloc = new Map();
    for (const p of packings) {
      const k = String(p.allocationId);
      if (!packByAlloc.has(k)) packByAlloc.set(k, []);
      packByAlloc.get(k).push(p);
    }
    const dispByAlloc = new Map();
    for (const d of dispatches) {
      const k = String(d.allocationId);
      if (!dispByAlloc.has(k)) dispByAlloc.set(k, []);
      dispByAlloc.get(k).push(d);
    }
    const invByAlloc = new Map();
    for (const inv of invoices) {
      const k = String(inv.linkedOrderAllocationId || "");
      if (!k) continue;
      invByAlloc.set(k, inv);
    }

    const rows = [];
    for (const a of allocations) {
      const id = String(a._id);
      let totalAlloc = 0;
      for (const ln of a.lines || []) totalAlloc += Number(ln.qty) || 0;
      let packed = 0;
      for (const p of packByAlloc.get(id) || []) {
        for (const ln of p.lines || []) packed += Number(ln.packQty) || 0;
      }
      let dispatched = 0;
      for (const d of dispByAlloc.get(id) || []) {
        for (const ln of d.lines || []) dispatched += Number(ln.dispatchQty) || 0;
      }
      const inv = invByAlloc.get(id);
      const invoiceNo = inv?.invoiceNo || "";
      const packingNos = [...new Set((packByAlloc.get(id) || []).map((p) => p.packingNo).filter(Boolean))].join(", ");
      const dispatchRows = dispByAlloc.get(id) || [];
      const dispatchNos = [...new Set(dispatchRows.map((d) => d.dispatchNo).filter(Boolean))].join(", ");
      const latestDispatch = dispatchRows
        .slice()
        .sort((a, b) => new Date(b.dispatchDate || b.createdAt || 0) - new Date(a.dispatchDate || a.createdAt || 0))[0];
      let dispatchStatus = "Pending Packing";
      if (packed <= 0) dispatchStatus = "Pending Packing";
      else if (dispatched >= packed) dispatchStatus = "Fully Dispatched";
      else if (dispatched > 0) dispatchStatus = "Partially Dispatched";
      else dispatchStatus = "Packed";
      rows.push({
        customerName: a.customerName,
        oaNo: a.linkedOANo || "",
        piNo: a.linkedProformaNo || "",
        allocationNo: a.allocationNo,
        packingNo: packingNos || "—",
        dispatchNo: dispatchNos || "—",
        invoiceNo: invoiceNo || "—",
        packedQty: packed,
        dispatchedQty: dispatched,
        balanceQty: Math.max(0, packed - dispatched),
        allocationQty: totalAlloc,
        dispatchStatus,
        awbNo: latestDispatch?.awbNo || "",
        trackingNo: latestDispatch?.trackingNo || latestDispatch?.awbNo || "",
        transporter: latestDispatch?.transporter || latestDispatch?.courier || "",
        dispatchDate: latestDispatch?.dispatchDate || null,
        uploadedDocumentLink:
          latestDispatch?.attachments?.find?.((attachment) => attachment?.documentId)?.documentId || "",
        companyId: a.companyId,
      });
    }
    res.json({ items: rows, total: rows.length });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function reportPackingPendingDispatch(req, res) {
  try {
    const posted = await StorePacking.find(withCompany(req, { status: { $in: POSTED_PACKING_STATUSES } })).lean();
    const items = [];
    for (const p of posted) {
      const dispatchedByLine = await sumPostedDispatchQtyByPackingLine(req.companyId, p._id);
      let pending = 0;
      for (const ln of p.lines || []) {
        const packed = Number(ln.packQty) || 0;
        const out = dispatchedByLine.get(String(ln._id)) || 0;
        pending += Math.max(0, packed - out);
      }
      if (pending > 0) {
        items.push({
          packingNo: p.packingNo,
          customerName: p.customerName,
          allocationNo: p.allocationNo,
          pendingQty: pending,
        });
      }
    }
    res.json({ items });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function reportDispatchSummary(req, res) {
  try {
    const rows = await StoreDispatch.find(withCompany(req, { status: { $in: POSTED_DISPATCH_STATUSES } }))
      .sort({ dispatchDate: -1 })
      .limit(500)
      .lean();
    const items = rows.map((d) => ({
      dispatchNo: d.dispatchNo,
      dispatchDate: d.dispatchDate,
      customerName: d.customerName,
      packingNo: d.packingNo,
      awbNo: d.awbNo,
      courier: d.courier,
      lineCount: (d.lines || []).length,
    }));
    res.json({ items });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function reportPackedNotInvoiced(req, res) {
  try {
    const packings = await StorePacking.find(withCompany(req, { status: { $in: POSTED_PACKING_STATUSES } })).lean();
    const items = [];
    for (const p of packings) {
      const invoicedByLine = await sumInvoicedQtyByPackingLine(req.companyId, p._id);
      let packedQty = 0;
      let invoicedQty = 0;
      for (const ln of p.lines || []) {
        packedQty += Number(ln.packQty) || 0;
        invoicedQty += invoicedByLine.get(String(ln._id)) || 0;
      }
      const pendingInvoiceQty = Math.max(0, packedQty - invoicedQty);
      if (pendingInvoiceQty <= 0) continue;
      items.push({
        packingNo: p.packingNo,
        customerName: p.customerName,
        allocationNo: p.allocationNo,
        oaNo: p.linkedOANo || "",
        piNo: p.linkedProformaNo || "",
        packedQty,
        invoicedQty,
        pendingInvoiceQty,
        invoiceStatus: p.invoiceStatus || "NOT_INVOICED",
      });
    }
    res.json({ items, total: items.length });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function reportInvoicedNotDispatched(req, res) {
  try {
    const invoices = await SalesInvoice.find(
      withCompany(req, { linkedStorePackingId: { $ne: null }, status: { $nin: ["DRAFT", "CANCELLED"] } })
    )
      .sort({ invoiceDate: -1 })
      .lean();
    const items = [];
    for (const inv of invoices) {
      const dispatchedByLine = await sumPostedDispatchQtyByInvoiceLine(req.companyId, inv._id);
      let invoiceQty = 0;
      let dispatchedQty = 0;
      for (const ln of inv.lines || []) {
        invoiceQty += Number(ln.qty) || 0;
        dispatchedQty += dispatchedByLine.get(String(ln._id)) || 0;
      }
      const pendingDispatchQty = Math.max(0, invoiceQty - dispatchedQty);
      if (pendingDispatchQty <= 0) continue;
      items.push({
        invoiceNo: inv.invoiceNo,
        packingNo: inv.linkedStorePackingNo || "",
        customerName: inv.customerName,
        allocationNo: inv.linkedOrderAllocationNo || "",
        oaNo: inv.linkedOANo || "",
        piNo: inv.linkedProformaNo || "",
        invoiceQty,
        dispatchedQty,
        pendingDispatchQty,
      });
    }
    res.json({ items, total: items.length });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function reportCustomerInvoicePendingDispatch(req, res) {
  try {
    const byCustomer = new Map();
    const invoices = await SalesInvoice.find(
      withCompany(req, { linkedStorePackingId: { $ne: null }, status: { $nin: ["DRAFT", "CANCELLED"] } })
    ).lean();
    for (const inv of invoices) {
      const dispatchedByLine = await sumPostedDispatchQtyByInvoiceLine(req.companyId, inv._id);
      let invoiceQty = 0;
      let dispatchedQty = 0;
      for (const ln of inv.lines || []) {
        invoiceQty += Number(ln.qty) || 0;
        dispatchedQty += dispatchedByLine.get(String(ln._id)) || 0;
      }
      const pendingDispatchQty = Math.max(0, invoiceQty - dispatchedQty);
      if (pendingDispatchQty <= 0) continue;
      const key = inv.customerName || "Unknown";
      const item = byCustomer.get(key) || { customerName: key, invoiceCount: 0, pendingDispatchQty: 0 };
      item.invoiceCount += 1;
      item.pendingDispatchQty += pendingDispatchQty;
      byCustomer.set(key, item);
    }
    res.json({ items: Array.from(byCustomer.values()).sort((a, b) => b.pendingDispatchQty - a.pendingDispatchQty) });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function reportPendingPacking(req, res) {
  try {
    req.query = { ...(req.query || {}) };
    return listPendingPackingAllocations(req, res);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function reportPackingByStatus(req, res) {
  try {
    const routeHint = String(req.originalUrl || "").toUpperCase();
    const status = String(req.params.status || req.query.status || (routeHint.includes("FULLY-PACKED") ? "FULLY_PACKED" : routeHint.includes("PARTIALLY-PACKED") ? "PARTIALLY_PACKED" : "")).trim().toUpperCase();
    const allowed = status === "FULLY_PACKED" ? ["FULLY_PACKED"] : status === "PARTIALLY_PACKED" ? ["PARTIALLY_PACKED"] : POSTED_PACKING_STATUSES;
    const rows = await StorePacking.find(withCompany(req, { status: { $in: allowed } }))
      .sort({ packingDate: -1, createdAt: -1 })
      .limit(500)
      .lean();
    const items = rows.map((p) => ({
      packingNo: p.packingNo,
      packingDate: p.packingDate,
      customerName: p.customerName,
      allocationNo: p.allocationNo,
      linkedOANo: p.linkedOANo || "",
      linkedProformaNo: p.linkedProformaNo || "",
      packedQty: (p.lines || []).reduce((sum, line) => sum + (Number(line.packQty) || 0), 0),
      totalPackages: p.totalPackages || (p.packages || []).length,
      invoiceStatus: p.invoiceStatus || "NOT_INVOICED",
      status: p.status,
    }));
    res.json({ items, total: items.length });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function reportDispatchByCustomer(req, res) {
  try {
    const rows = await StoreDispatch.find(withCompany(req, { status: { $in: POSTED_DISPATCH_STATUSES } })).lean();
    const byCustomer = new Map();
    for (const d of rows) {
      const key = d.customerName || "Unknown";
      const row = byCustomer.get(key) || { customerName: key, dispatchCount: 0, dispatchQty: 0 };
      row.dispatchCount += 1;
      for (const ln of d.lines || []) row.dispatchQty += Number(ln.dispatchQty) || 0;
      byCustomer.set(key, row);
    }
    res.json({ items: Array.from(byCustomer.values()).sort((a, b) => b.dispatchQty - a.dispatchQty) });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function reportDispatchByArticle(req, res) {
  try {
    const rows = await StoreDispatch.find(withCompany(req, { status: { $in: POSTED_DISPATCH_STATUSES } })).lean();
    const byArticle = new Map();
    for (const d of rows) {
      for (const ln of d.lines || []) {
        const key = ln.article || "UNKNOWN";
        const row = byArticle.get(key) || { article: key, description: ln.description || "", dispatchQty: 0, dispatchCount: 0 };
        row.dispatchQty += Number(ln.dispatchQty) || 0;
        row.dispatchCount += 1;
        byArticle.set(key, row);
      }
    }
    res.json({ items: Array.from(byArticle.values()).sort((a, b) => b.dispatchQty - a.dispatchQty) });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function reportPackingEfficiency(req, res) {
  try {
    const allocations = await OrderAllocation.find(withCompany(req, { status: { $nin: ["CANCELLED"] } })).lean();
    let allocatedQty = 0;
    let packedQty = 0;
    for (const a of allocations) {
      for (const ln of a.lines || []) allocatedQty += Number(ln.qty) || 0;
    }
    const packings = await StorePacking.find(withCompany(req, { status: { $in: POSTED_PACKING_STATUSES } })).lean();
    for (const p of packings) {
      for (const ln of p.lines || []) packedQty += Number(ln.packQty) || 0;
    }
    const efficiencyPct = allocatedQty > 0 ? (packedQty / allocatedQty) * 100 : 0;
    res.json({ allocatedQty, packedQty, pendingQty: Math.max(0, allocatedQty - packedQty), efficiencyPct });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function reportDailyDispatch(req, res) {
  try {
    const rows = await StoreDispatch.find(withCompany(req, { status: { $in: POSTED_DISPATCH_STATUSES } })).lean();
    const byDate = new Map();
    for (const d of rows) {
      const key = new Date(d.dispatchDate || d.createdAt || Date.now()).toISOString().slice(0, 10);
      const row = byDate.get(key) || { dispatchDate: key, dispatchCount: 0, dispatchQty: 0 };
      row.dispatchCount += 1;
      for (const ln of d.lines || []) row.dispatchQty += Number(ln.dispatchQty) || 0;
      byDate.set(key, row);
    }
    res.json({ items: Array.from(byDate.values()).sort((a, b) => String(b.dispatchDate).localeCompare(String(a.dispatchDate))) });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}
