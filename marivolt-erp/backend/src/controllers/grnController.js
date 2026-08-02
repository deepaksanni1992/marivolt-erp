import mongoose from "mongoose";
import GRN from "../models/GRN.js";
import StockLocation from "../models/StockLocation.js";
import PurchaseOrder from "../models/PurchaseOrder.js";
import StockLedger from "../models/StockLedger.js";
import Setting from "../models/Setting.js";
import * as stockService from "../services/stockService.js";
import { writeAudit, writeStatusChange } from "../services/auditService.js";
import { syncPurchaseOrderApExtensionFields } from "./purchasePoDocumentController.js";
import { nextGrnNo } from "../services/grnNumberService.js";
import { approvalRequiredPayload, ensureApproval } from "../services/approvalService.js";
import { syncPoLinesToItemMaster } from "../services/poItemMasterSyncService.js";
import {
  createCustomsLotFromGrn,
  assertGrnCancelAllowed,
  reverseCustomsLotForCancelledGrn,
  hasCustomsPayload,
  isCustomsEnabled,
} from "../services/customsService.js";
import {
  CANDIDATE_CAP,
  buildEligiblePoMongoFilter,
  escapeRegex,
  paginateArray,
  parseListPaging,
  safeSearchTerm,
  sortEligiblePos,
  summarizePoPendingReceivable,
  toEligiblePoItem,
} from "../utils/eligibleDocumentSearch.js";
import {
  INVALID_GRN_TEMPLATE,
  customsOverrideToLineEditFields,
  grnCsvTemplateHeaderLine,
  mapCsvRowToCustomsOverride,
  parseGrnCsvText,
  readArticleFromCsvRow,
  readGrnQtyFromCsvRow,
  readLocationFromCsvRow,
  readPoLineIdFromCsvRow,
  readRemarksFromCsvRow,
  suggestHeaderDefaultsFromOverrides,
  validateGrnCsvRowRequiredFields,
} from "../utils/grnCsvImport.js";

function withCompany(req, filter = {}) {
  const cid = req.companyId;
  if (cid == null || cid === "") return { ...filter };
  const s = String(cid).trim();
  if (mongoose.Types.ObjectId.isValid(s)) {
    const oid = new mongoose.Types.ObjectId(s);
    if (!Object.keys(filter).length) {
      return { $or: [{ companyId: oid }, { companyId: s }] };
    }
    return { $and: [{ ...filter }, { $or: [{ companyId: oid }, { companyId: s }] }] };
  }
  return { ...filter, companyId: cid };
}
const PO_LINE_ARRAY_KEYS = ["lines", "orderLines", "poItems", "items", "products"];

/** GRN documents that count toward PO received / pending (excludes DRAFT and CANCELLED). */
const GRN_POSTED_FOR_RECEIPT_QTY = ["POSTED", "RECEIVED", "PARTIAL_RECEIVED", "CLOSED"];

async function getPostedAcceptedQtyByPoLineMap(req, poId, session = null) {
  if (!mongoose.Types.ObjectId.isValid(String(poId))) return new Map();
  const oid = new mongoose.Types.ObjectId(String(poId));
  const pipeline = [
    { $match: withCompany(req, { poId: oid, status: { $in: GRN_POSTED_FOR_RECEIPT_QTY } }) },
    { $unwind: "$items" },
    {
      $match: {
        "items.poLineId": { $exists: true, $ne: null },
      },
    },
    {
      $group: {
        _id: "$items.poLineId",
        qty: {
          $sum: {
            $toDouble: {
              $ifNull: ["$items.acceptedQty", { $ifNull: ["$items.receivedQty", 0] }],
            },
          },
        },
      },
    },
  ];
  const agg = GRN.aggregate(pipeline);
  if (session) agg.session(session);
  const rows = await agg;
  return new Map(rows.map((r) => [String(r._id), Math.max(0, Number(r.qty) || 0)]));
}

/** Prefer canonical `lines`, then legacy/alternate array keys used by older imports. */
function extractRawPoLinesFromPo(po) {
  if (!po || typeof po !== "object") return [];
  for (const k of PO_LINE_ARRAY_KEYS) {
    const arr = po[k];
    if (Array.isArray(arr) && arr.length) return arr;
  }
  return [];
}

/** Resolve a PO line subdocument on the hydrated doc (canonical `lines` only for writes). */
function findPoLineSubdocument(po, poLineId) {
  if (!po || poLineId == null || poLineId === "") return null;
  try {
    const via = po.lines?.id?.(poLineId);
    if (via) return via;
  } catch {
    /* ignore */
  }
  const sid = String(poLineId);
  return (po.lines || []).find((l) => String(l._id) === sid) || null;
}

function poLineQtyFromRaw(l) {
  const ordered = Number(l?.orderedQty ?? l?.qty ?? l?.quantity ?? l?.orderedQuantity) || 0;
  const received = Number(l?.receivedQty ?? l?.received ?? l?.receivedQuantity) || 0;
  const cancelled = Number(l?.cancelledQty ?? l?.cancelled) || 0;
  const pending = Math.max(
    0,
    Number(l?.pendingQty ?? l?.openQty ?? Math.max(0, ordered - received - cancelled)) || 0
  );
  return { ordered, received, cancelled, pending };
}

function mapPoRowToGrnLine(l, po) {
  const { ordered, received, cancelled, pending } = poLineQtyFromRaw(l);
  const itemCode = String(
    l?.itemCode || l?.materialCode || l?.article || l?.articleNo || l?.sku || l?.productCode || ""
  ).trim();
  const article = (itemCode || String(l?.article || "").trim()).toUpperCase();
  const lineId = l?._id ?? l?.id ?? null;
  return {
    poLineId: lineId,
    itemId: l?.itemId || l?.itemMasterId || l?.productId || null,
    poId: po._id,
    poNo: po.poNo || po.poNumber,
    article: article || "—",
    description: l?.description || l?.desc || l?.productName || "",
    partNumber: l?.partNumber || l?.partNo || "",
    spn: l?.partNo || l?.spn || l?.partNumber || "",
    materialCode: itemCode || String(l?.materialCode || "").trim(),
    drawingNo: l?.drawingNo || l?.drawingNumber || "",
    orderedQty: ordered,
    receivedQty: received,
    pendingQty: pending,
    unitCost: Number(l?.unitPrice ?? l?.price ?? l?.rate) || 0,
    uom: l?.uom || l?.unit || l?.uOM || "PCS",
  };
}

function t(v) {
  return String(v ?? "").trim();
}

function upper(v) {
  return t(v).toUpperCase();
}

/** Default GRN stock `locationCode` when warehouse is omitted (multi-warehouse expansion later). */
const DEFAULT_GRN_WAREHOUSE_CODE = "MAIN";
const DEFAULT_GRN_WAREHOUSE_NAME = "Main Warehouse";
const MAX_GRN_NUMBER_RETRIES = 2;

function resolveGrnWarehouseCode(warehouseRaw) {
  const w = upper(warehouseRaw || "");
  return w || DEFAULT_GRN_WAREHOUSE_CODE;
}

async function ensureGrnItemMaster({ session, companyId, companyCode = "", poNo = "", supplierName = "", header = {}, line }) {
  const article = upper(line?.article);
  if (!article) throw new Error("GRN line article is required.");
  console.info(`[GRN item lookup] companyId=${companyId} article=${article}`);
  const summary = await syncPoLinesToItemMaster({
    companyId,
    companyCode,
    poNo,
    supplierName,
    header,
    lines: [line],
    session,
  });
  console.info(
    `[GRN item lookup] companyId=${companyId} article=${article} created=${summary.created} updated=${summary.updated}`
  );
}

/**
 * Ensure an Active `StockLocation` exists for {@link DEFAULT_GRN_WAREHOUSE_CODE} so GRN posting
 * and ledger validation succeed without altering existing stock rows.
 */
async function ensureDefaultGrnStockLocation(req, session = null) {
  const cid = req.companyId;
  if (cid == null || cid === "") return null;
  const code = DEFAULT_GRN_WAREHOUSE_CODE;
  const baseFilter = withCompany(req, { locationCode: code });
  const q1 = StockLocation.findOne(baseFilter);
  if (session) q1.session(session);
  let doc = await q1;
  if (doc) {
    let changed = false;
    if (String(doc.status || "") !== "Active") {
      doc.status = "Active";
      changed = true;
    }
    if (!String(doc.locationName || "").trim()) {
      doc.locationName = DEFAULT_GRN_WAREHOUSE_NAME;
      changed = true;
    }
    if (changed) await doc.save({ session });
    return doc;
  }
  try {
    const arr = await StockLocation.create(
      [
        {
          companyId: cid,
          locationCode: code,
          locationName: DEFAULT_GRN_WAREHOUSE_NAME,
          status: "Active",
        },
      ],
      session ? { session } : {}
    );
    return Array.isArray(arr) ? arr[0] : arr;
  } catch (e) {
    const msg = String(e?.message || "");
    if (e?.code === 11000 || msg.includes("duplicate") || msg.includes("E11000")) {
      const q2 = StockLocation.findOne(baseFilter);
      if (session) q2.session(session);
      return await q2;
    }
    throw e;
  }
}

/**
 * Build GRN line items from a PO line selection (Store UI / API).
 * `selections`: { poLineId, grnQty, warehouse?, location?, remarks?, currency? }[]
 * `warehouse` defaults to MAIN when omitted or blank.
 * Only lines with grnQty > 0 are included.
 * `pending` is ordered − posted(GRN) − cancelled; posted sums only non-draft, non-cancelled GRNs.
 */
async function buildGrnItemsFromPoLineSelection(req, poId, selections = [], options = {}) {
  const session = options.session || null;
  const postedOverride = options.postedMap;
  const poQ = PurchaseOrder.findOne(withCompany(req, { _id: poId }));
  if (session) poQ.session(session);
  const poLean = await poQ.lean();
  if (!poLean) throw new Error("Purchase order not found");
  if (String(poLean.status || "").toUpperCase() === "CANCELLED") {
    throw new Error("Cannot create GRN against a cancelled PO");
  }
  const postedMap = postedOverride instanceof Map ? postedOverride : await getPostedAcceptedQtyByPoLineMap(req, poId, session);
  const rawRows = extractRawPoLinesFromPo(poLean);
  const raw = [];
  const selectedLineIds = new Set();
  for (const row of selections) {
    const poLineId = row.poLineId;
    const grnQty = Number(row.grnQty ?? row.receivedQty);
    if (!mongoose.Types.ObjectId.isValid(String(poLineId))) continue;
    const lineKey = String(poLineId);
    if (selectedLineIds.has(lineKey)) {
      throw new Error("Duplicate GRN line selected for the same PO line. Combine the quantity into one line.");
    }
    selectedLineIds.add(lineKey);
    if (!Number.isFinite(grnQty) || grnQty <= 0) continue;
    const src = rawRows.find((x) => String(x._id ?? x.id ?? "") === String(poLineId ?? ""));
    if (!src) throw new Error(`Invalid PO line: ${poLineId}`);
    const ordered = Number(src?.orderedQty ?? src?.qty ?? src?.quantity ?? src?.orderedQuantity) || 0;
    const cancelled = Number(src?.cancelledQty ?? src?.cancelled) || 0;
    const posted = postedMap.get(lineKey) || 0;
    const pending = Math.max(0, ordered - posted - cancelled);
    if (pending <= 0) {
      const label = String(src.itemCode || src.article || src.materialCode || poLineId).trim();
      throw new Error(`No pending quantity for PO line ${label}; this line is fully received.`);
    }
    if (grnQty > pending + 1e-6) {
      const label = String(src.itemCode || src.article || src.materialCode || poLineId).trim();
      throw new Error(`GRN qty (${grnQty}) exceeds pending (${pending}) for line ${label}`);
    }
    const wh = resolveGrnWarehouseCode(row.warehouse);
    const loc = t(row.location);
    if (!loc) throw new Error("Location is required for selected GRN line.");
    raw.push({
      article: String(
        src.itemCode || src.materialCode || src.article || src.articleNo || src.sku || ""
      ).toUpperCase() || "—",
      description: src.description || src.desc || src.productName || "",
      partNumber: src.partNumber || src.partNo || "",
      spn: src.partNo || src.spn || "",
      materialCode: String(src.itemCode || src.materialCode || "").trim(),
      drawingNo: src.drawingNo || src.drawingNumber || "",
      orderedQty: ordered,
      receivedQty: grnQty,
      pendingQty: pending,
      acceptedQty: grnQty,
      rejectedQty: 0,
      cancelledQty: 0,
      unitCost: Number(src.unitPrice ?? src.price ?? src.rate) || 0,
      currency: upper(row.currency || poLean.currency || "USD"),
      warehouse: wh,
      location: loc,
      poLineId,
      poId: poLean._id,
      poNo: poLean.poNo || poLean.poNumber || "",
      remarks: t(row.remarks),
    });
  }
  if (!raw.length) throw new Error("Select at least one PO line with GRN qty greater than zero");
  return { po: poLean, items: normalizeItems(raw) };
}

function normalizeItems(items = []) {
  return (items || []).map((r) => {
    const received = Number(r.receivedQty) || 0;
    const rejected = Number(r.rejectedQty) || 0;
    const cancelled = Number(r.cancelledQty) || 0;
    const pendingCap = Number(r.pendingQty ?? r.orderedQty ?? received + rejected + cancelled) || 0;
    if (received < 0 || rejected < 0 || cancelled < 0) {
      throw new Error("Received/Rejected/Cancelled qty cannot be negative");
    }
    if (received + rejected + cancelled > pendingCap) {
      throw new Error("receivedQty + rejectedQty + cancelledQty cannot exceed pendingQty");
    }
    const accepted = Math.max(0, received - rejected);
    if (accepted > 0) {
      if (!t(r.location)) throw new Error("Location is required for selected GRN line.");
    }
    const ordered = Number(r.orderedQty ?? pendingCap) || 0;
    const pending = Math.max(0, pendingCap - received - rejected - cancelled);
    return {
      article: upper(r.article),
      description: t(r.description),
      partNumber: upper(r.partNumber || r.partNo),
      spn: t(r.spn),
      materialCode: t(r.materialCode),
      drawingNo: t(r.drawingNo || r.drawingNumber),
      uom: upper(r.uom || "PCS") || "PCS",
      orderedQty: ordered,
      receivedQty: received,
      pendingQty: Number.isFinite(pending) ? pending : 0,
      acceptedQty: accepted,
      rejectedQty: rejected,
      cancelledQty: cancelled,
      unitCost: Number(r.unitCost) || 0,
      lineAmount: (Number(r.unitCost) || 0) * accepted,
      currency: upper(r.currency || "USD") || "USD",
      exchangeRate: Number(r.exchangeRate) || 1,
      freight: Number(r.freight) || 0,
      customs: Number(r.customs) || 0,
      landedAdjustment: Number(r.landedAdjustment) || 0,
      location: t(r.location),
      warehouse: resolveGrnWarehouseCode(r.warehouse),
      warehouseId: mongoose.Types.ObjectId.isValid(String(r.warehouseId || "")) ? new mongoose.Types.ObjectId(String(r.warehouseId)) : null,
      batchNo: t(r.batchNo),
      serialNo: t(r.serialNo),
      manufacturingDate: r.manufacturingDate ? new Date(r.manufacturingDate) : null,
      expiryDate: r.expiryDate ? new Date(r.expiryDate) : null,
      poId: mongoose.Types.ObjectId.isValid(String(r.poId || "")) ? new mongoose.Types.ObjectId(String(r.poId)) : null,
      poLineId: mongoose.Types.ObjectId.isValid(String(r.poLineId || "")) ? new mongoose.Types.ObjectId(String(r.poLineId)) : null,
      remarks: t(r.remarks),
      poNo: t(r.poNo),
      recoveryInfo: Array.isArray(r.recoveryInfo)
        ? r.recoveryInfo.map((x) => t(x)).filter(Boolean)
        : [],
    };
  });
}

async function findRecoveryNotes({ session, companyId, article, warehouse, qty }) {
  const outstanding = await StockLedger.find({
    companyId,
    movementType: "ALLOCATION",
    article: upper(article),
    warehouse: upper(warehouse),
    availableAfter: { $lt: 0 },
  })
    .sort({ createdAt: -1 })
    .limit(30)
    .session(session)
    .lean();
  let remaining = Number(qty) || 0;
  const notes = [];
  for (const row of outstanding) {
    if (!(remaining > 0)) break;
    const shortage = Math.abs(Number(row.availableAfter) || 0);
    if (!(shortage > 0)) continue;
    const recovered = Math.min(remaining, shortage);
    remaining -= recovered;
    notes.push(
      `Recovered allocation for ${row.customerName || "Customer"} / Ref ${row.referenceNo || row.referenceType || "N/A"} (${recovered})`
    );
  }
  return notes;
}

function isDuplicateGrnNoError(err) {
  const msg = String(err?.message || "");
  return (
    err?.code === 11000 &&
    (err?.keyPattern?.grnNo || err?.keyValue?.grnNo || msg.includes("grnNo_1") || msg.includes("grnNo"))
  );
}

export async function createGrn(req, res) {
  try {
    return res.status(400).json({
      message:
        "Draft GRN creation is disabled. Select PO lines, enter location and quantities, then use POST /grn/post to post the GRN directly.",
    });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function listGrn(req, res) {
  try {
    const page = Math.max(1, Number(req.query.page || 1));
    const limit = Math.min(200, Math.max(1, Number(req.query.limit || 50)));
    const skip = (page - 1) * limit;
    const filter = withCompany(req);
    if (req.query.status) filter.status = upper(req.query.status);
    else if (String(req.query.includeDrafts || "").trim() !== "1") {
      filter.status = { $ne: "DRAFT" };
    }
    if (req.query.supplierId) filter.supplierId = req.query.supplierId;
    if (req.query.warehouseId) filter.warehouseId = req.query.warehouseId;
    if (req.query.dateFrom || req.query.dateTo) {
      filter.grnDate = {};
      if (req.query.dateFrom) filter.grnDate.$gte = new Date(req.query.dateFrom);
      if (req.query.dateTo) {
        const end = new Date(req.query.dateTo);
        end.setHours(23, 59, 59, 999);
        filter.grnDate.$lte = end;
      }
    }
    const search = safeSearchTerm(req.query.search || req.query.q);
    if (search) {
      const re = new RegExp(escapeRegex(search), "i");
      filter.$or = [
        { grnNo: re },
        { supplierName: re },
        { supplierInvoiceNo: re },
        { poNo: re },
        { blAwbNo: re },
        { packingListNo: re },
        { "items.article": re },
        { "items.partNumber": re },
        { "items.materialCode": re },
      ];
    }
    const [items, total] = await Promise.all([
      GRN.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      GRN.countDocuments(filter),
    ]);
    res.json({ items, total, page, limit, hasMore: skip + items.length < total });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

/**
 * GET /grn/eligible-purchase-orders — searchable POs with pending receivable qty.
 * STORE-scoped; does not change posting / received-qty logic.
 */
export async function listEligiblePurchaseOrdersForGrn(req, res) {
  try {
    const { q, page, limit } = parseListPaging(req.query);
    const mongoFilter = buildEligiblePoMongoFilter({
      companyFilter: withCompany(req),
      q,
      supplierId: t(req.query.supplierId),
      dateFrom: t(req.query.dateFrom),
      dateTo: t(req.query.dateTo),
    });
    const candidates = await PurchaseOrder.find(mongoFilter)
      .select(
        "_id poNo poNumber orderDate status supplierId supplierName supplierReference lines._id lines.orderedQty lines.qty lines.quantity lines.orderedQuantity lines.cancelledQty lines.cancelled lines.article lines.itemCode lines.materialCode lines.partNumber lines.partNo lines.spn"
      )
      .sort({ orderDate: -1 })
      .limit(CANDIDATE_CAP)
      .lean();

    const poIds = candidates.map((p) => p._id).filter(Boolean);
    const postedByPoLine = await getPostedAcceptedQtyByPoIds(req, poIds);

    const eligible = [];
    for (const po of candidates) {
      const postedByLine = postedByPoLine.get(String(po._id)) || new Map();
      const pending = summarizePoPendingReceivable(po, postedByLine);
      if (pending.pendingLineCount <= 0 || pending.pendingQty <= 0) continue;
      eligible.push(toEligiblePoItem(po, pending));
    }

    const ranked = sortEligiblePos(
      eligible.map((it) => ({
        ...it,
        poNo: it.poNo,
        supplierName: it.supplierName,
        orderDate: it.poDate,
        lines: candidates.find((c) => String(c._id) === it.id)?.lines || [],
      })),
      q
    ).map(({ lines, orderDate, ...rest }) => rest);

    const pageResult = paginateArray(ranked, page, limit);
    res.json(pageResult);
  } catch (err) {
    res.status(500).json({ message: "Failed to search purchase orders" });
  }
}

async function getPostedAcceptedQtyByPoIds(req, poIds = []) {
  const out = new Map();
  if (!poIds.length) return out;
  const rows = await GRN.aggregate([
    {
      $match: withCompany(req, {
        poId: { $in: poIds },
        status: { $in: GRN_POSTED_FOR_RECEIPT_QTY },
      }),
    },
    { $unwind: "$items" },
    {
      $match: {
        "items.poLineId": { $exists: true, $ne: null },
      },
    },
    {
      $group: {
        _id: { poId: "$poId", poLineId: "$items.poLineId" },
        qty: {
          $sum: {
            $toDouble: {
              $ifNull: ["$items.acceptedQty", { $ifNull: ["$items.receivedQty", 0] }],
            },
          },
        },
      },
    },
  ]);
  for (const r of rows) {
    const poKey = String(r._id.poId);
    if (!out.has(poKey)) out.set(poKey, new Map());
    out.get(poKey).set(String(r._id.poLineId), Math.max(0, Number(r.qty) || 0));
  }
  return out;
}

export async function getGrn(req, res) {
  try {
    const row = await GRN.findOne(withCompany(req, { grnNo: upper(req.params.grnNo) })).lean();
    if (!row) return res.status(404).json({ message: "GRN not found" });
    if (row._id) {
      row.attachments = row.attachments || [];
    }
    res.json(row);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function updateGrn(req, res) {
  try {
    const grnNo = upper(req.params.grnNo);
    const grn = await GRN.findOne(withCompany(req, { grnNo }));
    if (!grn) return res.status(404).json({ message: "GRN not found" });
    if (grn.status !== "DRAFT") return res.status(400).json({ message: "Only DRAFT GRN can be edited" });
    grn.branchId = req.body.branchId ?? grn.branchId;
    grn.warehouseId = req.body.warehouseId ?? grn.warehouseId;
    grn.grnDate = req.body.grnDate || grn.grnDate;
    grn.supplierId = req.body.supplierId ?? grn.supplierId;
    grn.supplierName = t(req.body.supplierName);
    grn.supplierInvoiceNo = t(req.body.supplierInvoiceNo);
    grn.supplierDeliveryNote = t(req.body.supplierDeliveryNote);
    grn.transporter = t(req.body.transporter);
    grn.vehicleDetails = t(req.body.vehicleDetails);
    grn.packingListNo = t(req.body.packingListNo);
    grn.blAwbNo = t(req.body.blAwbNo);
    grn.customsDocRef = t(req.body.customsDocRef);
    grn.poId = req.body.poId ?? grn.poId;
    grn.poNo = t(req.body.poNo);
    grn.currency = upper(req.body.currency || grn.currency || "USD");
    grn.exchangeRate = Number(req.body.exchangeRate ?? grn.exchangeRate) || 1;
    grn.freight = Number(req.body.freight ?? grn.freight) || 0;
    grn.customs = Number(req.body.customs ?? grn.customs) || 0;
    grn.landedAdjustment = Number(req.body.landedAdjustment ?? grn.landedAdjustment) || 0;
    grn.remarks = t(req.body.remarks);
    const beforeLines = grn.items?.map((x) => ({
      article: x.article,
      receivedQty: x.receivedQty,
      rejectedQty: x.rejectedQty,
      cancelledQty: x.cancelledQty,
      remarks: x.remarks,
    })) || [];
    grn.items = normalizeItems(req.body.items || []);
    if (Array.isArray(req.body.attachments)) grn.attachments = req.body.attachments;
    grn.updatedBy = req.user?.email || "";
    await grn.save();
    await writeAudit(req, {
      action: "UPDATE",
      module: "STORE",
      entityType: "GRN",
      entityId: grn._id,
      documentNo: grn.grnNo,
      description: `GRN ${grn.grnNo} updated`,
      metadata: {
        lineEdit: true,
        beforeLines,
        afterLines: grn.items.map((x) => ({
          article: x.article,
          receivedQty: x.receivedQty,
          rejectedQty: x.rejectedQty,
          cancelledQty: x.cancelledQty,
          remarks: x.remarks,
        })),
      },
    });
    res.json(grn);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

async function applyReceiveToPo({ session, req, grn }) {
  if (!grn.poId) return;
  const po = await PurchaseOrder.findOne(withCompany(req, { _id: grn.poId })).session(session);
  if (!po) return;
  const receiveByLineId = new Map();
  for (const line of grn.items || []) {
    if (!line.poLineId) continue;
    const current = receiveByLineId.get(String(line.poLineId)) || { accepted: 0, rejected: 0 };
    current.accepted += Number(line.acceptedQty) || 0;
    current.rejected += Number(line.rejectedQty) || 0;
    receiveByLineId.set(String(line.poLineId), current);
  }
  for (const [lineIdStr, rec] of receiveByLineId) {
    const poLine = findPoLineSubdocument(po, lineIdStr);
    if (!poLine) continue;
    const ordered = Number(poLine.orderedQty ?? poLine.qty) || 0;
    const nextReceived = Math.min(ordered, (Number(poLine.receivedQty) || 0) + rec.accepted);
    poLine.receivedQty = nextReceived;
    poLine.rejectedQty = (Number(poLine.rejectedQty) || 0) + rec.rejected;
    poLine.pendingQty = Math.max(0, ordered - nextReceived - (Number(poLine.cancelledQty) || 0));
    poLine.qty = ordered;
    poLine.orderedQty = ordered;
    poLine.lineAmount = ordered * (Number(poLine.unitPrice) || 0);
    poLine.lineTotal = poLine.lineAmount;
  }
  const lineSnapshot = extractRawPoLinesFromPo(po);
  const allReceived = lineSnapshot.length > 0 && lineSnapshot.every((l) => poLineQtyFromRaw(l).pending <= 0);
  const anyReceived = lineSnapshot.some((l) => (Number(l.receivedQty ?? l.received) || 0) > 0);
  if (allReceived) po.status = "RECEIVED";
  else if (anyReceived) po.status = "PARTIAL_RECEIVED";
  await po.save({ session });
}

function normKey(s) {
  return String(s ?? "").trim().toLowerCase();
}

/** Match CSV row to PO line by PO Line ID only (Customs template). */
function findPoLineMatchForCsv(rawRows, row) {
  const pid = readPoLineIdFromCsvRow(row);
  if (!pid) return null;
  if (mongoose.Types.ObjectId.isValid(pid)) {
    const hit = rawRows.find((x) => String(x._id ?? x.id ?? "") === pid);
    if (hit) return { line: hit, by: "poLineId" };
  }
  // Also allow exact string id match for non-ObjectId test ids
  const hit = rawRows.find((x) => String(x._id ?? x.id ?? "") === pid);
  return hit ? { line: hit, by: "poLineId" } : null;
}

/** GET /grn/csv-template — Customs GRN column header for CSV import. */
export async function getGrnCsvTemplate(req, res) {
  try {
    const header = grnCsvTemplateHeaderLine();
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", "attachment; filename=\"grn-import-template.csv\"");
    res.send(header);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

/** POST /grn/import-preview — validate Customs GRN CSV against a PO; does not create GRN. */
export async function importGrnCsvPreview(req, res) {
  try {
    const poId = req.body?.poId;
    const csvText = String(req.body?.csvText ?? "");
    if (!mongoose.Types.ObjectId.isValid(String(poId))) {
      return res.status(400).json({ message: "Valid poId is required" });
    }
    if (!csvText.trim()) return res.status(400).json({ message: "csvText is required" });

    const parsed = parseGrnCsvText(csvText);
    if (!parsed.ok) {
      return res.status(400).json({
        code: parsed.code || INVALID_GRN_TEMPLATE,
        message: parsed.message,
        details: parsed.details || [],
      });
    }

    const po = await PurchaseOrder.findOne(withCompany(req, { _id: poId })).lean();
    if (!po) return res.status(404).json({ message: "Purchase order not found" });
    if (String(po.status || "").toUpperCase() === "CANCELLED") {
      return res.status(400).json({ message: "PO is cancelled" });
    }
    const postedMap = await getPostedAcceptedQtyByPoLineMap(req, poId);
    const rawRows = extractRawPoLinesFromPo(po);
    const { rows } = parsed;
    const errors = [];
    const updates = [];
    const seenPoLineIds = new Set();
    const overrideList = [];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const lineNo = i + 2;

      const fieldMsgs = validateGrnCsvRowRequiredFields(row);
      for (const message of fieldMsgs) {
        errors.push({ line: lineNo, message });
      }
      if (fieldMsgs.length) continue;

      const match = findPoLineMatchForCsv(rawRows, row);
      if (!match) {
        errors.push({ line: lineNo, message: "No matching PO line for PO Line ID." });
        continue;
      }
      const src = match.line;
      const lid = String(src._id ?? src.id ?? "");
      const csvArticle = readArticleFromCsvRow(row);
      const poArticle = String(src.itemCode || src.article || src.materialCode || "").trim();
      if (poArticle && normKey(csvArticle) !== normKey(poArticle)) {
        errors.push({
          line: lineNo,
          message: `Article "${csvArticle}" does not match PO line article "${poArticle}".`,
        });
        continue;
      }
      if (seenPoLineIds.has(lid)) {
        errors.push({ line: lineNo, message: "Duplicate CSV row for the same PO line." });
        continue;
      }
      seenPoLineIds.add(lid);

      const ordered = Number(src?.orderedQty ?? src?.qty ?? src?.quantity ?? src?.orderedQuantity) || 0;
      const cancelled = Number(src?.cancelledQty ?? src?.cancelled) || 0;
      const posted = postedMap.get(lid) || 0;
      const pending = Math.max(0, ordered - posted - cancelled);
      const grnQty = readGrnQtyFromCsvRow(row);
      if (grnQty > pending + 1e-6) {
        errors.push({
          line: lineNo,
          message: `GRN Qty (${grnQty}) exceeds pending (${pending}) for this line.`,
        });
        continue;
      }

      const warehouse = resolveGrnWarehouseCode(row.warehouse || "");
      const location = readLocationFromCsvRow(row);
      const { override } = mapCsvRowToCustomsOverride(row, grnQty);

      const update = {
        poLineId: lid,
        grnQty,
        warehouse,
        location,
        remarks: readRemarksFromCsvRow(row),
        matchedBy: match.by,
        customsOverride: override,
        customsLineEdits: customsOverrideToLineEditFields(override),
      };
      overrideList.push(override);
      updates.push(update);
    }

    const headerDefaults = suggestHeaderDefaultsFromOverrides(overrideList);
    res.json({ updates, errors, headerDefaults });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

/** DELETE /grn/id/:id/draft — remove a draft GRN (no stock impact). */
export async function deleteGrnDraft(req, res) {
  try {
    const id = req.params.id;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: "Invalid id" });
    const grn = await GRN.findOne(withCompany(req, { _id: id }));
    if (!grn) return res.status(404).json({ message: "GRN not found" });
    if (String(grn.status || "").toUpperCase() !== "DRAFT") {
      return res.status(400).json({ message: "Only draft GRNs can be deleted" });
    }
    await GRN.deleteOne(withCompany(req, { _id: grn._id }));
    await writeAudit(req, {
      action: "DELETE",
      module: "STORE",
      entityType: "GRN",
      entityId: grn._id,
      documentNo: grn.grnNo,
      description: `Draft GRN ${grn.grnNo} deleted`,
    });
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

/** POST /grn/post — create and post GRN in one step (status POSTED). */
export async function postGrnFromPo(req, res) {
  const session = await mongoose.startSession();
  try {
    const poId = req.body?.poId;
    if (!mongoose.Types.ObjectId.isValid(String(poId))) {
      return res.status(400).json({ message: "poId is required" });
    }
    const selections = Array.isArray(req.body?.lines) ? req.body.lines : [];
    if (!selections.length) return res.status(400).json({ message: "lines[] is required" });

    let savedGrnNo = "";
    let completed = false;
    for (let attempt = 1; attempt <= MAX_GRN_NUMBER_RETRIES; attempt++) {
      try {
        await session.withTransaction(async () => {
          const postedMap = await getPostedAcceptedQtyByPoLineMap(req, poId, session);
          const { items: builtItems, po: poLean } = await buildGrnItemsFromPoLineSelection(req, poId, selections, {
            session,
            postedMap,
          });

          const poDoc = await PurchaseOrder.findOne(withCompany(req, { _id: poId })).session(session);
          if (poDoc && String(poDoc.status || "").toUpperCase() === "CANCELLED") {
            throw new Error("Cannot post GRN for a cancelled PO");
          }

          const grnNo = await nextGrnNo({ companyId: req.companyId, companyCode: req.companyCode });
          savedGrnNo = grnNo;
          const created = await GRN.create(
            [
              {
                companyId: req.companyId,
                branchId: req.body.branchId || poLean.branchId || null,
                warehouseId: req.body.warehouseId || poLean.warehouseId || null,
                grnNo,
                poId,
                grnDate: req.body.grnDate ? new Date(req.body.grnDate) : new Date(),
                supplierId: req.body.supplierId || poLean.supplierId || null,
                supplierName: t(req.body.supplierName) || poLean.supplierName || "",
                supplierInvoiceNo: t(req.body.supplierInvoiceNo),
                supplierDeliveryNote: t(req.body.supplierDeliveryNote),
                transporter: t(req.body.transporter),
                vehicleDetails: t(req.body.vehicleDetails),
                packingListNo: t(req.body.packingListNo),
                blAwbNo: t(req.body.blAwbNo),
                customsDocRef: t(req.body.customsDocRef),
                poNo: t(req.body.poNo) || poLean.poNo || poLean.poNumber || "",
                currency: upper(req.body.currency || poLean.currency || "USD"),
                exchangeRate: Number(req.body.exchangeRate) || 1,
                freight: Number(req.body.freight) || 0,
                customs: Number(req.body.customs) || 0,
                landedAdjustment: Number(req.body.landedAdjustment) || 0,
                remarks: t(req.body.remarks),
                status: "DRAFT",
                approvalStatus: "NOT_REQUIRED",
                items: builtItems,
                attachments: Array.isArray(req.body.attachments) ? req.body.attachments : [],
                createdBy: req.user?.email || "",
                updatedBy: req.user?.email || "",
              },
            ],
            { session }
          );
          const grn = Array.isArray(created) ? created[0] : created;

          const gate = await ensureApproval(req, {
            companyId: req.companyId,
            module: "STORE",
            actionKey: "grn_receive",
            documentType: "GRN",
            documentId: grn._id,
            documentNo: grn.grnNo,
            description: `Post GRN ${grn.grnNo}`,
          });
          if (!gate.approved) {
            grn.approvalStatus = "PENDING_RECEIVE";
            grn.updatedBy = req.user?.email || "";
            await grn.save({ session });
            throw Object.assign(new Error("APPROVAL_REQUIRED"), { _approval: approvalRequiredPayload(gate.request) });
          }

          await ensureDefaultGrnStockLocation(req, session);

          for (const line of grn.items) {
            const article = upper(line.article);
            await ensureGrnItemMaster({
              session,
              companyId: poLean.companyId || req.companyId,
              companyCode: req.companyCode,
              poNo: poLean.poNo || poLean.poNumber || grn.poNo,
              supplierName: grn.supplierName,
              header: poLean,
              line,
            });
            const wh = resolveGrnWarehouseCode(line.warehouse);
            const putaway = t(line.location);
            if (!putaway) throw new Error("Location is required for selected GRN line.");
            const loc = await StockLocation.findOne(withCompany(req, { locationCode: wh, status: "Active" })).session(session);
            if (!loc) throw new Error(`Invalid warehouse (stock location code): ${wh}`);
            if (Number(line.acceptedQty) > 0) {
              const recoveryInfo = await findRecoveryNotes({
                session,
                companyId: req.companyId,
                article,
                warehouse: wh,
                qty: Number(line.acceptedQty),
              });
              await stockService.grnReceive({
                session,
                companyId: req.companyId,
                article,
                warehouse: wh,
                qty: Number(line.acceptedQty),
                referenceType: "GRN",
                referenceNo: grn.grnNo,
                supplierName: grn.supplierName || "",
                unitCost: Number(line.unitCost) || 0,
                currency: line.currency || "USD",
                batchNo: line.batchNo || "",
                serialNo: line.serialNo || "",
                remarks: line.remarks || "",
                putawayLocation: putaway,
                createdBy: req.user?.email || "",
                sourceModule: "STORE",
                transactionDate: grn.grnDate,
              });
              line.recoveryInfo = recoveryInfo;
            }
          }

          await applyReceiveToPo({ session, req, grn });
          const hasPending = (grn.items || []).some((x) => Number(x.pendingQty || 0) > 0);
          const postedStatus = hasPending ? "PARTIAL_RECEIVED" : "RECEIVED";
          grn.status = postedStatus;
          grn.approvalStatus = "APPROVED";
          grn.postedAt = new Date();
          grn.updatedBy = req.user?.email || "";
          await grn.save({ session });
          await writeStatusChange(req, {
            module: "STORE",
            entityType: "GRN",
            entityId: grn._id,
            documentNo: grn.grnNo,
            fromStatus: "DRAFT",
            toStatus: postedStatus,
            description: `GRN ${grn.grnNo} ${postedStatus === "RECEIVED" ? "fully received" : "partially received"}`,
          });
          await writeAudit(req, {
            action: "RECEIVE",
            module: "STORE",
            entityType: "GRN",
            entityId: grn._id,
            documentNo: grn.grnNo,
            fromStatus: "DRAFT",
            toStatus: postedStatus,
            description: `GRN ${grn.grnNo} ${postedStatus === "RECEIVED" ? "fully received" : "partially received"} (${grn.items?.length || 0} lines)`,
            metadata: { supplierName: grn.supplierName || "" },
          });

          if (isCustomsEnabled() && hasCustomsPayload(req.body)) {
            await createCustomsLotFromGrn({
              session,
              req,
              grn,
              body: req.body,
              poDate: poLean.orderDate || poLean.poDate || null,
            });
          }
        });
        completed = true;
        break;
      } catch (err) {
        if (isDuplicateGrnNoError(err) && attempt < MAX_GRN_NUMBER_RETRIES) {
          savedGrnNo = "";
          continue;
        }
        throw err;
      }
    }
    if (!completed) throw new Error("Unable to allocate a unique GRN number. Please retry.");

    if (mongoose.Types.ObjectId.isValid(String(poId))) {
      await syncPurchaseOrderApExtensionFields(req.companyId, poId);
    }
    res.status(201).json({ success: true, grnNo: savedGrnNo });
  } catch (err) {
    if (err?._approval) return res.status(202).json(err._approval);
    res.status(400).json({ message: err.message });
  } finally {
    await session.endSession();
  }
}

export async function postGrn(req, res) {
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const grnNo = upper(req.params.grnNo);
      const grn = await GRN.findOne(withCompany(req, { grnNo })).session(session);
      if (!grn) throw new Error("GRN not found");
      if (grn.status !== "DRAFT") throw new Error("Only DRAFT GRN can be received");
      grn.items = (grn.items || []).filter((x) => Number(x.acceptedQty) > 0.000001);
      if (!(grn.items || []).length) {
        throw new Error("Cannot post GRN with no lines having quantity greater than zero");
      }

      let allowOverPo = false;
      let sourcePo = null;
      if (grn.poId) {
        const po = await PurchaseOrder.findOne(withCompany(req, { _id: grn.poId })).session(session);
        sourcePo = po;
        if (po && String(po.status || "").toUpperCase() === "CANCELLED") {
          throw new Error("Cannot post GRN for a cancelled PO");
        }
        const s = await Setting.findOne(
          withCompany(req, { namespace: "OTHER", branchId: null, key: "STORE_ALLOW_GRN_OVER_PO" })
        )
          .session(session)
          .lean();
        allowOverPo = Boolean(s?.value);
        if (po && !allowOverPo) {
          const postedMap = await getPostedAcceptedQtyByPoLineMap(req, grn.poId, session);
          const rawRows = extractRawPoLinesFromPo(po);
          for (const line of grn.items || []) {
            if (!(Number(line.acceptedQty) > 0)) continue;
            const poLine = line.poLineId ? findPoLineSubdocument(po, line.poLineId) : null;
            if (!poLine) continue;
            const src = rawRows.find((x) => String(x._id ?? x.id ?? "") === String(line.poLineId ?? "")) || poLine;
            const ordered = Number(src?.orderedQty ?? src?.qty ?? poLine.orderedQty ?? poLine.qty) || 0;
            const cancelled = Number(src?.cancelledQty ?? poLine.cancelledQty) || 0;
            const posted = postedMap.get(String(line.poLineId)) || 0;
            const pending = Math.max(0, ordered - posted - cancelled);
            const accepted = Number(line.acceptedQty) || 0;
            if (accepted > pending + 1e-6) {
              throw new Error(
                `Received qty exceeds PO balance for ${line.article}. Enable admin override STORE_ALLOW_GRN_OVER_PO or reduce qty.`
              );
            }
          }
        }
      }

      const gate = await ensureApproval(req, {
        companyId: req.companyId,
        module: "STORE",
        actionKey: "grn_receive",
        documentType: "GRN",
        documentId: grn._id,
        documentNo: grn.grnNo,
        description: `Receive GRN ${grn.grnNo}`,
      });
      if (!gate.approved) {
        grn.approvalStatus = "PENDING_RECEIVE";
        grn.updatedBy = req.user?.email || "";
        await grn.save({ session });
        throw Object.assign(new Error("APPROVAL_REQUIRED"), { _approval: approvalRequiredPayload(gate.request) });
      }

      await ensureDefaultGrnStockLocation(req, session);

      for (const line of grn.items) {
        const article = upper(line.article);
        await ensureGrnItemMaster({
          session,
          companyId: grn.companyId || req.companyId,
          companyCode: req.companyCode,
          poNo: sourcePo?.poNo || sourcePo?.poNumber || grn.poNo,
          supplierName: grn.supplierName,
          header: sourcePo || {},
          line,
        });
        const wh = resolveGrnWarehouseCode(line.warehouse);
        const putaway = t(line.location);
        if (!putaway) throw new Error("Location is required for selected GRN line.");
        const loc = await StockLocation.findOne(withCompany(req, { locationCode: wh, status: "Active" })).session(session);
        if (!loc) throw new Error(`Invalid warehouse (stock location code): ${wh}`);
        if (Number(line.acceptedQty) > 0) {
          const recoveryInfo = await findRecoveryNotes({
            session,
            companyId: req.companyId,
            article,
            warehouse: wh,
            qty: Number(line.acceptedQty),
          });
          await stockService.grnReceive({
            session,
            companyId: req.companyId,
            article,
            warehouse: wh,
            qty: Number(line.acceptedQty),
            referenceType: "GRN",
            referenceNo: grn.grnNo,
            supplierName: grn.supplierName || "",
            unitCost: Number(line.unitCost) || 0,
            currency: line.currency || "USD",
            batchNo: line.batchNo || "",
            serialNo: line.serialNo || "",
            remarks: line.remarks || "",
            putawayLocation: putaway,
            createdBy: req.user?.email || "",
            sourceModule: "STORE",
            transactionDate: grn.grnDate,
          });
          line.recoveryInfo = recoveryInfo;
        }
      }
      await applyReceiveToPo({ session, req, grn });
      const hasPending = (grn.items || []).some((x) => Number(x.pendingQty || 0) > 0);
      grn.status = hasPending ? "PARTIAL_RECEIVED" : "RECEIVED";
      grn.approvalStatus = "APPROVED";
      grn.postedAt = new Date();
      grn.updatedBy = req.user?.email || "";
      await grn.save({ session });
      await writeStatusChange(req, {
        module: "STORE",
        entityType: "GRN",
        entityId: grn._id,
        documentNo: grn.grnNo,
        fromStatus: "DRAFT",
        toStatus: grn.status,
        description: `GRN ${grn.grnNo} received`,
      });
      await writeAudit(req, {
        action: "RECEIVE",
        module: "STORE",
        entityType: "GRN",
        entityId: grn._id,
        documentNo: grn.grnNo,
        fromStatus: "DRAFT",
        toStatus: grn.status,
        description: `GRN ${grn.grnNo} received (${grn.items?.length || 0} lines)`,
        metadata: { supplierName: grn.supplierName || "" },
      });
      await writeAudit(req, {
        action: "PARTIAL_RECEIVE",
        module: "STORE",
        entityType: "GRN",
        entityId: grn._id,
        documentNo: grn.grnNo,
        description: `Partial receive on GRN ${grn.grnNo}`,
        metadata: {
          lines: (grn.items || []).map((x) => ({
            article: x.article,
            acceptedQty: x.acceptedQty,
            rejectedQty: x.rejectedQty,
            cancelledQty: x.cancelledQty,
            recoveryInfo: x.recoveryInfo || [],
          })),
        },
      });
    });
    const postedGrn = await GRN.findOne(withCompany(req, { grnNo: upper(req.params.grnNo) }))
      .select("poId")
      .lean();
    if (postedGrn?.poId) {
      await syncPurchaseOrderApExtensionFields(req.companyId, postedGrn.poId);
    }
    res.json({ success: true });
  } catch (err) {
    if (err?._approval) return res.status(202).json(err._approval);
    res.status(400).json({ message: err.message });
  } finally {
    await session.endSession();
  }
}

/** POST /api/grn/id/:id/post — same as posting by grnNo, for clients that hold the Mongo _id. */
export async function postGrnByMongoId(req, res) {
  try {
    const id = req.params.id;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid GRN id" });
    }
    const row = await GRN.findOne(withCompany(req, { _id: id })).select("grnNo").lean();
    if (!row) return res.status(404).json({ message: "GRN not found" });
    req.params.grnNo = row.grnNo;
    return postGrn(req, res);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function cancelGrn(req, res) {
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const grnNo = upper(req.params.grnNo);
      const grn = await GRN.findOne(withCompany(req, { grnNo })).session(session);
      if (!grn) throw new Error("GRN not found");
      if (!["RECEIVED", "PARTIAL_RECEIVED", "POSTED", "CLOSED"].includes(grn.status)) {
        throw new Error("Only posted/received GRN can be cancelled");
      }

      const gate = await ensureApproval(req, {
        companyId: req.companyId,
        module: "STORE",
        actionKey: "grn_cancel",
        documentType: "GRN",
        documentId: grn._id,
        documentNo: grn.grnNo,
        description: `Cancel GRN ${grn.grnNo}`,
      });
      if (!gate.approved) {
        grn.approvalStatus = "PENDING_CANCEL";
        grn.updatedBy = req.user?.email || "";
        await grn.save({ session });
        throw Object.assign(new Error("APPROVAL_REQUIRED"), { _approval: approvalRequiredPayload(gate.request) });
      }

      if (isCustomsEnabled()) {
        await assertGrnCancelAllowed({
          companyId: req.companyId,
          grnId: grn._id,
          grnNo: grn.grnNo,
          session,
        });
      }

      const prevGrnStatus = grn.status;
      for (const line of grn.items) {
        if (!(Number(line.acceptedQty) > 0)) continue;
        await stockService.cancelGrn({
          session,
          companyId: req.companyId,
          article: upper(line.article),
          warehouse: upper(line.warehouse || "") || upper(line.location),
          qty: Number(line.acceptedQty),
          referenceNo: grn.grnNo,
          supplierName: grn.supplierName || "",
          unitCost: Number(line.unitCost) || 0,
          currency: line.currency || "USD",
          batchNo: line.batchNo || "",
          serialNo: line.serialNo || "",
          remarks: `GRN cancelled: ${grn.grnNo}`,
          createdBy: req.user?.email || "",
          sourceModule: "STORE",
        });
      }
      if (grn.poId) {
        const po = await PurchaseOrder.findOne(withCompany(req, { _id: grn.poId })).session(session);
        if (po) {
          for (const line of grn.items || []) {
            if (!line.poLineId) continue;
            const poLine = findPoLineSubdocument(po, line.poLineId);
            if (!poLine) continue;
            const ordered = Number(poLine.orderedQty ?? poLine.qty) || 0;
            poLine.receivedQty = Math.max(0, (Number(poLine.receivedQty) || 0) - (Number(line.acceptedQty) || 0));
            poLine.pendingQty = Math.max(0, ordered - poLine.receivedQty - (Number(poLine.cancelledQty) || 0));
          }
          const snap = extractRawPoLinesFromPo(po);
          const allReceived = snap.length > 0 && snap.every((l) => poLineQtyFromRaw(l).pending <= 0);
          const anyReceived = snap.some((l) => (Number(l.receivedQty ?? l.received) || 0) > 0);
          po.status = allReceived ? "RECEIVED" : anyReceived ? "PARTIAL_RECEIVED" : "SENT";
          await po.save({ session });
        }
      }
      grn.status = "CANCELLED";
      grn.approvalStatus = "APPROVED";
      grn.cancelledAt = new Date();
      grn.cancellationReason = t(req.body?.reason || req.body?.cancellationReason);
      grn.updatedBy = req.user?.email || "";
      await grn.save({ session });

      if (isCustomsEnabled()) {
        await reverseCustomsLotForCancelledGrn({ session, req, grn });
      }

      await writeStatusChange(req, {
        module: "STORE",
        entityType: "GRN",
        entityId: grn._id,
        documentNo: grn.grnNo,
        fromStatus: prevGrnStatus,
        toStatus: "CANCELLED",
        description: `GRN ${grn.grnNo} cancelled`,
      });
      await writeAudit(req, {
        action: "CANCEL",
        module: "STORE",
        entityType: "GRN",
        entityId: grn._id,
        documentNo: grn.grnNo,
        fromStatus: prevGrnStatus,
        toStatus: "CANCELLED",
        description: `GRN ${grn.grnNo} cancelled — stock reversed`,
        metadata: { supplierName: grn.supplierName || "" },
      });
    });
    res.json({ success: true });
  } catch (err) {
    if (err?._approval) return res.status(202).json(err._approval);
    res.status(400).json({ message: err.message });
  } finally {
    await session.endSession();
  }
}

export async function closeGrn(req, res) {
  try {
    const grnNo = upper(req.params.grnNo);
    const grn = await GRN.findOne(withCompany(req, { grnNo }));
    if (!grn) return res.status(404).json({ message: "GRN not found" });
    if (!["RECEIVED", "PARTIAL_RECEIVED", "POSTED"].includes(grn.status)) {
      return res.status(409).json({ message: "Only posted/received GRN can be closed" });
    }
    const prev = grn.status;
    grn.status = "CLOSED";
    grn.updatedBy = req.user?.email || "";
    await grn.save();
    await writeStatusChange(req, {
      module: "STORE",
      entityType: "GRN",
      entityId: grn._id,
      documentNo: grn.grnNo,
      fromStatus: prev,
      toStatus: "CLOSED",
      description: `GRN ${grn.grnNo} closed`,
    });
    res.json(grn);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function getGrnSummaryReport(req, res) {
  try {
    const filter = withCompany(req);
    if (req.query.status) filter.status = upper(req.query.status);
    else if (String(req.query.includeDrafts || "").trim() !== "1") {
      filter.status = { $ne: "DRAFT" };
    }
    if (req.query.supplierName) filter.supplierName = new RegExp(t(req.query.supplierName), "i");
    const items = await GRN.find(filter).sort({ createdAt: -1 }).lean();
    res.json({ items });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function getSupplierReceivingReport(req, res) {
  try {
    const filter = withCompany(req);
    if (req.query.supplierName) filter.supplierName = new RegExp(t(req.query.supplierName), "i");
    const items = await GRN.find(filter).sort({ createdAt: -1 }).lean();
    const bySupplier = new Map();
    for (const g of items) {
      const key = g.supplierName || "—";
      if (!bySupplier.has(key)) {
        bySupplier.set(key, { supplierName: key, grnCount: 0, receivedQty: 0, acceptedQty: 0, rejectedQty: 0, amount: 0 });
      }
      const row = bySupplier.get(key);
      row.grnCount += 1;
      for (const line of g.items || []) {
        row.receivedQty += Number(line.receivedQty) || 0;
        row.acceptedQty += Number(line.acceptedQty) || 0;
        row.rejectedQty += Number(line.rejectedQty) || 0;
        row.amount += Number(line.lineAmount || 0);
      }
    }
    res.json({ items: Array.from(bySupplier.values()).sort((a, b) => b.amount - a.amount) });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function getGrnFromPo(req, res) {
  try {
    const poId = req.params.poId;
    if (!mongoose.Types.ObjectId.isValid(poId)) return res.status(400).json({ message: "Invalid PO id" });
    try {
      await syncPurchaseOrderApExtensionFields(req.companyId, poId);
    } catch (e) {
      console.error("[grn/from-po] syncPurchaseOrderApExtensionFields:", e?.message || e);
    }
    const po = await PurchaseOrder.findOne(withCompany(req, { _id: poId })).lean();
    if (!po) return res.status(404).json({ message: "Purchase order not found" });
    if (String(po.status || "").toUpperCase() === "CANCELLED") {
      return res.status(400).json({ message: "PO is cancelled" });
    }
    const rawRows = extractRawPoLinesFromPo(po);
    const postedMap = await getPostedAcceptedQtyByPoLineMap(req, poId);
    const lines = rawRows.map((l) => {
      const base = mapPoRowToGrnLine(l, po);
      const lid = String(l._id ?? l.id ?? base.poLineId ?? "");
      const ordered = Number(l?.orderedQty ?? l?.qty ?? l?.quantity ?? l?.orderedQuantity) || 0;
      const cancelled = Number(l?.cancelledQty ?? l?.cancelled) || 0;
      const postedReceivedQty = postedMap.get(lid) || 0;
      const pendingQty = Math.max(0, ordered - postedReceivedQty - cancelled);
      return {
        ...base,
        poLineId: base.poLineId || l._id || l.id,
        orderedQty: ordered,
        postedReceivedQty,
        receivedQty: postedReceivedQty,
        pendingQty,
        lineDisabled: pendingQty <= 0,
      };
    });
    const header = {
      _id: po._id,
      poNo: po.poNo || po.poNumber,
      poNumber: po.poNumber,
      orderDate: po.orderDate,
      currency: po.currency || "USD",
      supplierName: po.supplierName,
      supplierId: po.supplierId,
      branchId: po.branchId || null,
      warehouseId: po.warehouseId || null,
      paymentStatus: po.apPaymentStatus || "NOT_PAID",
      supplierInvoiceStatus: po.supplierDocumentStatus || "NONE",
      grnReceiptStatus: po.grnReceiptStatus || "NOT_RECEIVED",
      grnProgressStatus: po.grnProgressStatus || "NONE",
      poStatus: po.status,
    };
    res.json({
      header,
      lines,
      po,
      supplierName: po.supplierName,
      supplierId: po.supplierId,
      currency: po.currency || "USD",
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function getGrnByMongoId(req, res) {
  try {
    const id = req.params.id;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: "Invalid id" });
    const row = await GRN.findOne(withCompany(req, { _id: id })).lean();
    if (!row) return res.status(404).json({ message: "GRN not found" });
    res.json(row);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function getPendingPoGrnReport(req, res) {
  try {
    const pos = await PurchaseOrder.find(
      withCompany(req, {
        status: { $nin: ["CANCELLED", "CLOSED", "REJECTED"] },
      })
    )
      .sort({ orderDate: -1 })
      .limit(200)
      .lean();
    const items = [];
    for (const po of pos) {
      let pendingLines = 0;
      for (const l of po.lines || []) {
        const p = Number(l.pendingQty ?? 0);
        if (p > 0) pendingLines += 1;
      }
      if (pendingLines > 0) {
        items.push({
          poNo: po.poNo || po.poNumber,
          supplierName: po.supplierName,
          status: po.status,
          pendingLines,
          grandTotal: po.grandTotal,
        });
      }
    }
    res.json({ items });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}
