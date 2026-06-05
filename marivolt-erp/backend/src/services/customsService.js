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

/** Aggregate customs stock rows for list/report APIs. */
export async function listCustomsStockRows(companyId, filters = {}) {
  const query = withCompanyId(companyId, {});
  if (filters.articleNumber) query.articleNumber = upper(filters.articleNumber);
  if (filters.partNumber) query.partNumber = upper(filters.partNumber);
  if (filters.status) query.status = String(filters.status).toUpperCase();
  if (filters.search) {
    const s = t(filters.search);
    query.$or = [
      { boeNumber: new RegExp(s, "i") },
      { blNumber: new RegExp(s, "i") },
      { awbNumber: new RegExp(s, "i") },
      { supplierInvoiceNumber: new RegExp(s, "i") },
      { articleNumber: new RegExp(s, "i") },
      { partNumber: new RegExp(s, "i") },
      { grnNo: new RegExp(s, "i") },
    ];
  }

  const items = await CustomsLotItem.find(query)
    .sort({ supplierInvoiceDate: 1, createdAt: 1 })
    .lean();

  return items.map((row, index) => ({
    srNo: index + 1,
    ...row,
    totalPrice: Number(row.totalValue) || Number(row.qtyImported) * Number(row.unitPrice),
  }));
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
