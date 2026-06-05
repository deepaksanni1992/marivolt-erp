import mongoose from "mongoose";
import CustomsLot from "../models/CustomsLot.js";
import CustomsLotItem from "../models/CustomsLotItem.js";
import CustomsMovement from "../models/CustomsMovement.js";
import StockBalance from "../models/StockBalance.js";
import { isCustomsEnabled } from "../config/customsConfig.js";
import { nextCustomsLotRef } from "../services/customsNumberService.js";
import { writeAudit } from "./auditService.js";

export { isCustomsEnabled };

function t(v) {
  return String(v ?? "").trim();
}

function upper(v) {
  return t(v).toUpperCase();
}

function withCompanyId(companyId, filter = {}) {
  const cid = companyId;
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

function parseDate(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function deriveBlAwbParts(payload = {}, grn = {}) {
  const blNumber = t(payload.blNumber) || t(grn.blAwbNo);
  const awbNumber = t(payload.awbNumber);
  return { blNumber, awbNumber };
}

function resolveDocumentId(value) {
  if (value == null) return null;
  if (typeof value === "object") {
    const id = t(value._id || value.id);
    return mongoose.Types.ObjectId.isValid(id) ? id : null;
  }
  const id = t(value);
  return mongoose.Types.ObjectId.isValid(id) ? id : null;
}

function hasCustomsDocuments(customs = {}) {
  const docs = customs?.documents;
  if (!docs || typeof docs !== "object") return false;
  if (
    resolveDocumentId(docs.blDocumentId) ||
    resolveDocumentId(docs.blCopy) ||
    resolveDocumentId(docs.supplierInvoiceDocumentId) ||
    resolveDocumentId(docs.supplierInvoiceCopy) ||
    resolveDocumentId(docs.packingListDocumentId) ||
    resolveDocumentId(docs.packingListCopy)
  ) {
    return true;
  }
  const otherLists = [docs.otherDocumentIds, docs.otherDocuments];
  for (const list of otherLists) {
    if (!Array.isArray(list)) continue;
    if (list.some((entry) => resolveDocumentId(entry))) return true;
  }
  return false;
}

/**
 * True when optional customs payload contains at least one identifying field.
 */
export function hasCustomsPayload(body = {}) {
  const customs = body?.customs && typeof body.customs === "object" ? body.customs : body;
  const fields = [
    customs?.boeNumber,
    customs?.blNumber,
    customs?.awbNumber,
    customs?.blAwbNo,
    customs?.customsDocRef,
    customs?.supplierInvoiceNumber,
    customs?.supplierInvoiceDate,
    customs?.supplierInvoiceNo,
    customs?.countryOfOrigin,
    customs?.hsCode,
    customs?.currency,
    customs?.unitPrice,
    customs?.weightKg,
    customs?.remarks,
    body?.boeNumber,
    body?.blNumber,
    body?.awbNumber,
    body?.blAwbNo,
    body?.customsDocRef,
    body?.supplierInvoiceNo,
    body?.supplierInvoiceNumber,
  ];
  if (fields.some((f) => t(f))) return true;
  if (hasCustomsDocuments(customs)) return true;

  for (const row of customs?.lineOverrides || []) {
    if (
      [row?.hsCode, row?.countryOfOrigin, row?.unitPrice, row?.weightKg, row?.currency, row?.remarks].some(
        (f) => t(f),
      )
    ) {
      return true;
    }
  }
  return false;
}

export function normalizeCustomsPayload(body = {}, grn = {}) {
  const customs = body?.customs && typeof body.customs === "object" ? body.customs : body;
  const { blNumber, awbNumber } = deriveBlAwbParts(customs, grn);
  const boeNumber = t(customs.boeNumber) || t(customs.customsDocRef) || t(grn.customsDocRef);
  const supplierInvoiceNumber =
    t(customs.supplierInvoiceNumber) || t(customs.supplierInvoiceNo) || t(grn.supplierInvoiceNo);
  const supplierInvoiceDate =
    parseDate(customs.supplierInvoiceDate) || parseDate(grn.supplierInvoiceDate) || null;

  if (!hasCustomsPayload(body)) return null;

  const docSrc = customs.documents && typeof customs.documents === "object" ? customs.documents : {};
  const otherDocumentIds = [
    ...(Array.isArray(docSrc.otherDocumentIds) ? docSrc.otherDocumentIds : []),
    ...(Array.isArray(docSrc.otherDocuments) ? docSrc.otherDocuments : []),
    ...(Array.isArray(customs.otherDocumentIds) ? customs.otherDocumentIds : []),
    ...(Array.isArray(customs.otherDocuments) ? customs.otherDocuments : []),
  ]
    .map((entry) => resolveDocumentId(entry))
    .filter(Boolean);

  const documents = {
    blDocumentId:
      resolveDocumentId(docSrc.blDocumentId) ||
      resolveDocumentId(docSrc.blCopy) ||
      resolveDocumentId(customs.blDocumentId) ||
      null,
    supplierInvoiceDocumentId:
      resolveDocumentId(docSrc.supplierInvoiceDocumentId) ||
      resolveDocumentId(docSrc.supplierInvoiceCopy) ||
      resolveDocumentId(customs.supplierInvoiceDocumentId) ||
      null,
    packingListDocumentId:
      resolveDocumentId(docSrc.packingListDocumentId) ||
      resolveDocumentId(docSrc.packingListCopy) ||
      resolveDocumentId(customs.packingListDocumentId) ||
      null,
    otherDocumentIds: [...new Set(otherDocumentIds.map(String))],
  };

  const lineOverrides = new Map();
  for (const row of customs.lineOverrides || []) {
    const key = String(row?.poLineId ?? row?.grnLineId ?? "");
    if (key) lineOverrides.set(key, row);
  }

  return {
    boeNumber,
    blNumber,
    awbNumber,
    supplierInvoiceNumber,
    supplierInvoiceDate,
    countryOfOrigin: upper(customs.countryOfOrigin || ""),
    hsCode: upper(customs.hsCode || ""),
    currency: upper(customs.currency || grn.currency || "USD"),
    unitPrice: Number(customs.unitPrice) || 0,
    weightKg: Number(customs.weightKg) || 0,
    remarks: t(customs.remarks || grn.remarks),
    documents,
    lineOverrides,
  };
}

function deriveItemStatus(qtyAvailable, qtyImported) {
  if (qtyAvailable <= 0.000001) return "CONSUMED";
  if (qtyAvailable + 0.000001 < qtyImported) return "PARTIAL";
  return "IN_STOCK";
}

function deriveLotStatus(items = []) {
  if (!items.length) return "OPEN";
  const active = items.filter((i) => i.status !== "CANCELLED");
  if (!active.length) return "CANCELLED";
  if (active.every((i) => Number(i.qtyAvailable) <= 0.000001)) return "CONSUMED";
  if (active.some((i) => Number(i.qtyConsumed) > 0)) return "PARTIAL";
  return "OPEN";
}

/**
 * Create customs lot, items, and inbound movements from a posted GRN.
 */
export async function createCustomsLotFromGrn({ session, req, grn, body = {} }) {
  if (!isCustomsEnabled()) return null;
  if (!grn?._id) throw new Error("GRN is required for customs lot creation");

  const payload = normalizeCustomsPayload(body, grn);
  if (!payload) return null;

  const existing = await CustomsLot.findOne(
    withCompanyId(req.companyId, { grnId: grn._id }),
  ).session(session);
  if (existing) return existing;

  const customsLotRef = await nextCustomsLotRef({
    companyId: req.companyId,
    companyCode: req.companyCode,
  });

  const lotRows = await CustomsLot.create(
    [
      {
        companyId: req.companyId,
        companyCode: upper(req.companyCode || "CMP"),
        customsLotRef,
        grnId: grn._id,
        grnNo: grn.grnNo,
        poId: grn.poId || null,
        poNo: grn.poNo || "",
        supplierId: grn.supplierId || null,
        supplierName: grn.supplierName || "",
        boeNumber: payload.boeNumber,
        blNumber: payload.blNumber,
        awbNumber: payload.awbNumber,
        supplierInvoiceNumber: payload.supplierInvoiceNumber,
        supplierInvoiceDate: payload.supplierInvoiceDate,
        countryOfOrigin: payload.countryOfOrigin,
        currency: payload.currency,
        status: "OPEN",
        remarks: payload.remarks,
        documents: payload.documents,
        createdBy: req.user?.email || "",
        updatedBy: req.user?.email || "",
      },
    ],
    { session },
  );
  const lot = lotRows[0];
  const createdItems = [];

  for (const line of grn.items || []) {
    const qty = Number(line.acceptedQty ?? line.receivedQty) || 0;
    if (qty <= 0) continue;

    const lineKey = String(line.poLineId ?? "");
    const override = payload.lineOverrides.get(lineKey) || {};
    const unitPrice =
      Number(override.unitPrice ?? (payload.unitPrice || undefined) ?? line.unitCost) || 0;
    const weightKg = Number(override.weightKg ?? payload.weightKg) || 0;
    const totalValue = qty * unitPrice;

    const itemRows = await CustomsLotItem.create(
      [
        {
          companyId: req.companyId,
          companyCode: lot.companyCode,
          customsLotId: lot._id,
          customsLotRef: lot.customsLotRef,
          grnId: grn._id,
          grnNo: grn.grnNo,
          grnLineId: line.poLineId ?? null,
          articleNumber: upper(line.article),
          partNumber: upper(line.partNumber || line.spn || ""),
          partName: line.description || "",
          description: line.description || "",
          hsCode: upper(override.hsCode || payload.hsCode || ""),
          currency: upper(override.currency || line.currency || payload.currency),
          unitPrice,
          qtyImported: qty,
          qtyAvailable: qty,
          qtyConsumed: 0,
          weightKg,
          totalValue,
          customStock: qty,
          customStockBalance: qty,
          supplierInvoiceNumber: payload.supplierInvoiceNumber,
          supplierInvoiceDate: payload.supplierInvoiceDate,
          boeNumber: payload.boeNumber,
          blNumber: payload.blNumber,
          awbNumber: payload.awbNumber,
          countryOfOrigin: upper(override.countryOfOrigin || payload.countryOfOrigin || ""),
          status: "IN_STOCK",
          remarks1: t(override.remarks1 || line.remarks),
          remarks2: t(override.remarks2),
        },
      ],
      { session },
    );
    const item = itemRows[0];
    createdItems.push(item);

    await createCustomsMovement({
      session,
      req,
      movementType: "INBOUND",
      customsLotId: lot._id,
      customsLotItemId: item._id,
      articleNumber: item.articleNumber,
      partNumber: item.partNumber,
      qty,
      referenceType: "GRN",
      referenceId: grn._id,
      referenceNumber: grn.grnNo,
      movementDate: grn.grnDate || new Date(),
      remarks: `Inbound from GRN ${grn.grnNo}`,
    });
  }

  lot.status = deriveLotStatus(createdItems);
  lot.updatedBy = req.user?.email || "";
  await lot.save({ session });

  await writeAudit(req, {
    action: "CREATE",
    module: "CUSTOMS",
    entityType: "CUSTOMS_LOT",
    entityId: lot._id,
    documentNo: lot.customsLotRef,
    description: `Customs lot ${lot.customsLotRef} created from GRN ${grn.grnNo}`,
    metadata: {
      grnNo: grn.grnNo,
      boeNumber: lot.boeNumber,
      blNumber: lot.blNumber,
      awbNumber: lot.awbNumber,
      supplierInvoiceNumber: lot.supplierInvoiceNumber,
    },
  });

  return lot;
}

/**
 * Block GRN cancel when outbound customs movements have consumed stock.
 */
export async function assertGrnCancelAllowed({ companyId, grnId, grnNo, session = null }) {
  if (!isCustomsEnabled()) return;
  if (!grnId) return;

  const q = CustomsLotItem.findOne(
    withCompanyId(companyId, {
      grnId,
      qtyConsumed: { $gt: 0 },
      status: { $ne: "CANCELLED" },
    }),
  ).select("_id qtyConsumed articleNumber");
  if (session) q.session(session);
  const consumed = await q.lean();
  if (consumed) {
    throw new Error(
      `Cannot cancel GRN ${grnNo}: customs stock for article ${consumed.articleNumber} has outbound movements (qty consumed: ${consumed.qtyConsumed}).`,
    );
  }
}

/**
 * Reverse inbound customs lot when GRN is cancelled (only if nothing was consumed).
 */
export async function reverseCustomsLotForCancelledGrn({ session, req, grn }) {
  if (!isCustomsEnabled()) return null;
  if (!grn?._id) return null;

  await assertGrnCancelAllowed({
    companyId: req.companyId,
    grnId: grn._id,
    grnNo: grn.grnNo,
    session,
  });

  const lot = await CustomsLot.findOne(withCompanyId(req.companyId, { grnId: grn._id })).session(
    session,
  );
  if (!lot) return null;

  const items = await CustomsLotItem.find(
    withCompanyId(req.companyId, { customsLotId: lot._id, status: { $ne: "CANCELLED" } }),
  ).session(session);

  for (const item of items) {
    const qty = Number(item.qtyAvailable) || 0;
    if (qty > 0) {
      await createCustomsMovement({
        session,
        req,
        movementType: "REVERSAL",
        customsLotId: lot._id,
        customsLotItemId: item._id,
        articleNumber: item.articleNumber,
        partNumber: item.partNumber,
        qty,
        referenceType: "GRN",
        referenceId: grn._id,
        referenceNumber: grn.grnNo,
        movementDate: new Date(),
        remarks: `GRN ${grn.grnNo} cancelled — reverse inbound customs stock`,
      });
    }
    item.qtyAvailable = 0;
    item.customStockBalance = 0;
    item.status = "CANCELLED";
    await item.save({ session });
  }

  lot.status = "CANCELLED";
  lot.updatedBy = req.user?.email || "";
  await lot.save({ session });

  await writeAudit(req, {
    action: "REVERSAL",
    module: "CUSTOMS",
    entityType: "CUSTOMS_LOT",
    entityId: lot._id,
    documentNo: lot.customsLotRef,
    description: `Customs lot ${lot.customsLotRef} reversed for cancelled GRN ${grn.grnNo}`,
    metadata: { grnNo: grn.grnNo },
  });

  return lot;
}

export async function createCustomsMovement({
  session = null,
  req,
  movementType,
  customsLotId,
  customsLotItemId,
  articleNumber,
  partNumber = "",
  qty,
  referenceType,
  referenceId = null,
  referenceNumber = "",
  movementDate = new Date(),
  remarks = "",
}) {
  const rows = await CustomsMovement.create(
    [
      {
        companyId: req.companyId,
        companyCode: upper(req.companyCode || "CMP"),
        movementType,
        customsLotId,
        customsLotItemId,
        articleNumber: upper(articleNumber),
        partNumber: upper(partNumber),
        qty: Number(qty) || 0,
        referenceType,
        referenceId,
        referenceNumber: t(referenceNumber),
        movementDate: movementDate || new Date(),
        remarks: t(remarks),
        createdBy: req.user?.email || "",
      },
    ],
    session ? { session } : undefined,
  );
  return rows[0];
}

/**
 * List available customs lot items for an article (FIFO order).
 */
export async function getAvailableCustomsLots({
  companyId,
  articleNumber,
  partNumber = "",
  limit = 100,
  session = null,
}) {
  const filter = withCompanyId(companyId, {
    articleNumber: upper(articleNumber),
    qtyAvailable: { $gt: 0 },
    status: { $in: ["IN_STOCK", "PARTIAL"] },
  });
  if (partNumber) filter.partNumber = upper(partNumber);

  const q = CustomsLotItem.find(filter)
    .sort({ supplierInvoiceDate: 1, createdAt: 1 })
    .limit(Math.min(Number(limit) || 100, 500));
  if (session) q.session(session);
  return q.lean();
}

/**
 * Allocate customs stock using FIFO (oldest supplier invoice / GRN first).
 */
export async function allocateCustomsStockFIFO({
  companyId,
  articleNumber,
  qty,
  partNumber = "",
  session = null,
}) {
  const need = Number(qty) || 0;
  if (need <= 0) return [];

  const items = await getAvailableCustomsLots({
    companyId,
    articleNumber,
    partNumber,
    limit: 500,
    session,
  });

  let remaining = need;
  const allocations = [];
  for (const item of items) {
    if (remaining <= 0.000001) break;
    const available = Number(item.qtyAvailable) || 0;
    if (available <= 0) continue;
    const take = Math.min(available, remaining);
    allocations.push({
      customsLotItemId: item._id,
      customsLotId: item.customsLotId,
      qty: take,
      item,
    });
    remaining -= take;
  }

  if (remaining > 0.000001) {
    throw new Error(
      `Insufficient customs stock for ${upper(articleNumber)} (short by ${remaining.toFixed(4)})`,
    );
  }

  return allocations;
}

function parseStockDateRange(dateFrom, dateTo) {
  const range = {};
  const from = parseDate(dateFrom);
  const to = parseDate(dateTo);
  if (from) {
    from.setHours(0, 0, 0, 0);
    range.$gte = from;
  }
  if (to) {
    to.setHours(23, 59, 59, 999);
    range.$lte = to;
  }
  return Object.keys(range).length ? range : null;
}

async function buildCustomsStockItemQuery(companyId, filters = {}) {
  const base = {};
  if (filters.articleNumber) base.articleNumber = upper(filters.articleNumber);
  if (filters.partNumber) base.partNumber = upper(filters.partNumber);
  if (filters.status) base.status = String(filters.status).toUpperCase();
  if (filters.countryOfOrigin) base.countryOfOrigin = upper(filters.countryOfOrigin);

  const dateRange = parseStockDateRange(filters.dateFrom, filters.dateTo);
  if (dateRange) base.supplierInvoiceDate = dateRange;

  if (filters.supplier) {
    const lots = await CustomsLot.find(
      withCompanyId(companyId, {
        supplierName: new RegExp(t(filters.supplier), "i"),
      }),
    )
      .select("_id")
      .lean();
    const lotIds = lots.map((l) => l._id);
    base.customsLotId = lotIds.length ? { $in: lotIds } : { $in: [] };
  }

  if (filters.companyCode) {
    base.companyCode = upper(filters.companyCode);
  }

  if (filters.search) {
    const s = t(filters.search);
    base.$or = [
      { boeNumber: new RegExp(s, "i") },
      { blNumber: new RegExp(s, "i") },
      { awbNumber: new RegExp(s, "i") },
      { supplierInvoiceNumber: new RegExp(s, "i") },
      { articleNumber: new RegExp(s, "i") },
      { partNumber: new RegExp(s, "i") },
      { partName: new RegExp(s, "i") },
      { grnNo: new RegExp(s, "i") },
      { hsCode: new RegExp(s, "i") },
      { countryOfOrigin: new RegExp(s, "i") },
    ];
  }

  return withCompanyId(companyId, base);
}

export function mapCustomsStockRow(item, lot, srNo) {
  const qtyImported = Number(item.qtyImported) || 0;
  const qtyAvailable = Number(item.qtyAvailable) || 0;
  const unitPrice = Number(item.unitPrice) || 0;
  const totalValue = Number(item.totalValue) || qtyImported * unitPrice;

  return {
    srNo,
    _id: item._id,
    customsLotId: item.customsLotId,
    customsLotRef: item.customsLotRef || lot?.customsLotRef || "",
    companyCode: item.companyCode || lot?.companyCode || "",
    boeNumber: item.boeNumber || lot?.boeNumber || "",
    awbNumber: item.awbNumber || lot?.awbNumber || "",
    blNumber: item.blNumber || lot?.blNumber || "",
    date: item.supplierInvoiceDate || lot?.supplierInvoiceDate || null,
    supplier: lot?.supplierName || "",
    invoiceNo: item.supplierInvoiceNumber || lot?.supplierInvoiceNumber || "",
    countryOfOrigin: item.countryOfOrigin || lot?.countryOfOrigin || "",
    articleNumber: item.articleNumber || "",
    partName: item.partName || item.description || "",
    partNumber: item.partNumber || "",
    hsCode: item.hsCode || "",
    currency: item.currency || lot?.currency || "USD",
    unitPrice,
    qtyImported,
    weightKg: Number(item.weightKg) || 0,
    totalValue,
    customsStock: qtyImported,
    customsStockBalance: qtyAvailable,
    remarks1: item.remarks1 || "",
    remarks2: item.remarks2 || "",
    status: item.status || "IN_STOCK",
    grnId: item.grnId || lot?.grnId || null,
    grnNo: item.grnNo || lot?.grnNo || "",
    documents: {
      blDocumentId: lot?.documents?.blDocumentId || null,
      supplierInvoiceDocumentId: lot?.documents?.supplierInvoiceDocumentId || null,
    },
  };
}

/** Paginated customs stock list with lot metadata for UI / export. */
export async function listCustomsStockPage(companyId, filters = {}, paging = {}) {
  const page = Math.max(1, Number(paging.page) || 1);
  const limit = Math.min(Number(paging.limit) || 50, Number(paging.maxLimit) || 200);
  const skip = (page - 1) * limit;
  const query = await buildCustomsStockItemQuery(companyId, filters);

  const [items, total] = await Promise.all([
    CustomsLotItem.find(query)
      .sort({ supplierInvoiceDate: -1, createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    CustomsLotItem.countDocuments(query),
  ]);

  const lotIds = [...new Set(items.map((row) => String(row.customsLotId)).filter(Boolean))];
  const lots = lotIds.length
    ? await CustomsLot.find({ _id: { $in: lotIds } })
        .select("supplierName supplierInvoiceNumber supplierInvoiceDate countryOfOrigin currency boeNumber blNumber awbNumber grnId grnNo customsLotRef companyCode documents")
        .lean()
    : [];
  const lotMap = new Map(lots.map((lot) => [String(lot._id), lot]));

  return {
    items: items.map((row, index) => mapCustomsStockRow(row, lotMap.get(String(row.customsLotId)), skip + index + 1)),
    total,
    page,
    limit,
  };
}

/** @deprecated Use listCustomsStockPage — kept for internal callers expecting full list. */
export async function listCustomsStockRows(companyId, filters = {}) {
  const { items } = await listCustomsStockPage(companyId, filters, {
    page: 1,
    limit: 5000,
    maxLimit: 5000,
  });
  return items;
}

function deriveQtyInOut(movement = {}) {
  const qty = Number(movement.qty) || 0;
  const type = String(movement.movementType || "").toUpperCase();
  if (type === "INBOUND") return { qtyIn: qty, qtyOut: 0 };
  if (type === "OUTBOUND" || type === "REVERSAL") return { qtyIn: 0, qtyOut: qty };
  if (type === "ADJUSTMENT") {
    if (qty < 0) return { qtyIn: 0, qtyOut: Math.abs(qty) };
    return { qtyIn: qty, qtyOut: 0 };
  }
  return { qtyIn: 0, qtyOut: 0 };
}

async function buildCustomsLedgerQuery(companyId, filters = {}) {
  const base = {};
  if (filters.articleNumber) base.articleNumber = upper(filters.articleNumber);
  if (filters.partNumber) base.partNumber = upper(filters.partNumber);
  if (filters.movementType) base.movementType = upper(filters.movementType);
  if (filters.referenceType) base.referenceType = upper(filters.referenceType);

  const dateRange = parseStockDateRange(filters.dateFrom, filters.dateTo);
  if (dateRange) base.movementDate = dateRange;

  const lotPredicates = [];
  if (filters.supplier) lotPredicates.push({ supplierName: new RegExp(t(filters.supplier), "i") });
  if (filters.boeNumber) lotPredicates.push({ boeNumber: new RegExp(t(filters.boeNumber), "i") });
  if (filters.blNumber) lotPredicates.push({ blNumber: new RegExp(t(filters.blNumber), "i") });
  if (filters.awbNumber) lotPredicates.push({ awbNumber: new RegExp(t(filters.awbNumber), "i") });

  if (lotPredicates.length) {
    const lotFilter = withCompanyId(companyId, lotPredicates.length === 1 ? lotPredicates[0] : { $and: lotPredicates });
    const lots = await CustomsLot.find(lotFilter).select("_id").lean();
    base.customsLotId = { $in: lots.map((l) => l._id) };
    if (!lots.length) base.customsLotId = { $in: [] };
  }

  if (filters.search) {
    const s = t(filters.search);
    base.$or = [
      { referenceNumber: new RegExp(s, "i") },
      { articleNumber: new RegExp(s, "i") },
      { partNumber: new RegExp(s, "i") },
      { remarks: new RegExp(s, "i") },
      { createdBy: new RegExp(s, "i") },
    ];
  }

  return withCompanyId(companyId, base);
}

async function computeOpeningBalances(companyId, filters = {}, beforeDate) {
  const q = await buildCustomsLedgerQuery(companyId, {
    ...filters,
    dateFrom: undefined,
    dateTo: undefined,
  });
  const cutoff = parseDate(beforeDate);
  if (cutoff) {
    cutoff.setHours(0, 0, 0, 0);
    q.movementDate = { ...(q.movementDate || {}), $lt: cutoff };
  }
  const prior = await CustomsMovement.find(q).sort({ movementDate: 1, createdAt: 1 }).lean();
  const balances = new Map();
  for (const movement of prior) {
    const key = String(movement.customsLotItemId || "");
    const { qtyIn, qtyOut } = deriveQtyInOut(movement);
    balances.set(key, (Number(balances.get(key)) || 0) + qtyIn - qtyOut);
  }
  return balances;
}

export function mapCustomsLedgerRow(movement, lot, item, balanceAfter, srNo) {
  const { qtyIn, qtyOut } = deriveQtyInOut(movement);
  return {
    srNo,
    _id: movement._id,
    date: movement.movementDate || movement.createdAt,
    movementType: movement.movementType,
    company: movement.companyCode || lot?.companyCode || item?.companyCode || "",
    articleNumber: movement.articleNumber || item?.articleNumber || "",
    partNumber: movement.partNumber || item?.partNumber || "",
    partName: item?.partName || item?.description || "",
    boeNumber: item?.boeNumber || lot?.boeNumber || "",
    blNumber: item?.blNumber || lot?.blNumber || "",
    awbNumber: item?.awbNumber || lot?.awbNumber || "",
    supplierInvoiceNumber: item?.supplierInvoiceNumber || lot?.supplierInvoiceNumber || "",
    supplier: lot?.supplierName || "",
    qtyIn,
    qtyOut,
    balance: balanceAfter,
    referenceType: movement.referenceType,
    referenceNumber: movement.referenceNumber || "",
    user: movement.createdBy || "",
    remarks: movement.remarks || "",
    customsLotItemId: movement.customsLotItemId,
    customsLotId: movement.customsLotId,
  };
}

/** Paginated customs stock ledger from CustomsMovement with running balance per lot item. */
export async function listCustomsLedgerPage(companyId, filters = {}, paging = {}) {
  const page = Math.max(1, Number(paging.page) || 1);
  const limit = Math.min(Number(paging.limit) || 50, Number(paging.maxLimit) || 200);
  const query = await buildCustomsLedgerQuery(companyId, filters);

  const movements = await CustomsMovement.find(query)
    .sort({ movementDate: 1, createdAt: 1 })
    .lean();

  const lotIds = [...new Set(movements.map((m) => String(m.customsLotId)).filter(Boolean))];
  const itemIds = [...new Set(movements.map((m) => String(m.customsLotItemId)).filter(Boolean))];

  const [lots, items] = await Promise.all([
    lotIds.length
      ? CustomsLot.find({ _id: { $in: lotIds } })
          .select(
            "supplierName supplierInvoiceNumber boeNumber blNumber awbNumber companyCode grnNo customsLotRef",
          )
          .lean()
      : [],
    itemIds.length
      ? CustomsLotItem.find({ _id: { $in: itemIds } })
          .select("articleNumber partNumber partName description boeNumber blNumber awbNumber supplierInvoiceNumber companyCode")
          .lean()
      : [],
  ]);

  const lotMap = new Map(lots.map((lot) => [String(lot._id), lot]));
  const itemMap = new Map(items.map((item) => [String(item._id), item]));
  const balanceByItem = filters.dateFrom
    ? await computeOpeningBalances(companyId, filters, filters.dateFrom)
    : new Map();

  const enriched = movements.map((movement, index) => {
    const itemKey = String(movement.customsLotItemId || "");
    const lot = lotMap.get(String(movement.customsLotId));
    const item = itemMap.get(itemKey);
    const { qtyIn, qtyOut } = deriveQtyInOut(movement);
    const prev = Number(balanceByItem.get(itemKey)) || 0;
    const nextBalance = prev + qtyIn - qtyOut;
    balanceByItem.set(itemKey, nextBalance);
    return mapCustomsLedgerRow(movement, lot, item, nextBalance, index + 1);
  });

  enriched.sort((a, b) => {
    const da = new Date(a.date).getTime();
    const db = new Date(b.date).getTime();
    if (db !== da) return db - da;
    return String(b._id).localeCompare(String(a._id));
  });

  enriched.forEach((row, idx) => {
    row.srNo = idx + 1;
  });

  const total = enriched.length;
  const skip = (page - 1) * limit;
  const pageItems = enriched.slice(skip, skip + limit);

  return { items: pageItems, total, page, limit };
}

/** ERP stock vs customs stock by article. */
export async function buildCustomsReconciliation(companyId) {
  const customsAgg = await CustomsLotItem.aggregate([
    { $match: withCompanyId(companyId, { status: { $ne: "CANCELLED" } }) },
    {
      $group: {
        _id: { article: "$articleNumber", partNumber: "$partNumber" },
        customsStock: { $sum: "$qtyAvailable" },
      },
    },
  ]);

  const erpAgg = await StockBalance.aggregate([
    { $match: withCompanyId(companyId, {}) },
    {
      $group: {
        _id: { article: "$article", partNumber: "$itemCode" },
        erpStock: { $sum: { $ifNull: ["$availableQty", "$quantity"] } },
      },
    },
  ]);

  const map = new Map();
  for (const row of erpAgg) {
    const key = `${row._id.article || ""}::${row._id.partNumber || ""}`;
    map.set(key, {
      article: row._id.article || "",
      partNumber: row._id.partNumber || "",
      erpStock: Number(row.erpStock) || 0,
      customsStock: 0,
    });
  }
  for (const row of customsAgg) {
    const key = `${row._id.article || ""}::${row._id.partNumber || ""}`;
    const existing = map.get(key) || {
      article: row._id.article || "",
      partNumber: row._id.partNumber || "",
      erpStock: 0,
      customsStock: 0,
    };
    existing.customsStock = Number(row.customsStock) || 0;
    map.set(key, existing);
  }

  return [...map.values()]
    .map((row) => ({
      ...row,
      difference: Number(row.erpStock) - Number(row.customsStock),
      actionRequired: Math.abs(Number(row.erpStock) - Number(row.customsStock)) > 0.0001,
    }))
    .sort((a, b) => Math.abs(b.difference) - Math.abs(a.difference));
}

export { withCompanyId as customsWithCompanyId };
