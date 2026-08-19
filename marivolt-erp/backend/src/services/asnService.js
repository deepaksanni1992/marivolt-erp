/**
 * ASN Phase 1 service.
 *
 * Intentionally does not import StockLedger, CustomsLot, CustomsMovement,
 * GRN posting, or inventory services. ASN is a logistics document only.
 */
import mongoose from "mongoose";
import AdvanceShipmentNotice from "../models/AdvanceShipmentNotice.js";
import PurchaseOrder from "../models/PurchaseOrder.js";
import Document from "../models/Document.js";
import { writeAudit, writeStatusChange } from "./auditService.js";
import { nextAsnNo } from "./asnNumberService.js";
import { ensureLineCounterFloor } from "../utils/quantitySerialization.js";
import {
  ASN_ACTIVE_STATUSES,
  ASN_SHIPMENT_MODES,
  ASN_SHIPMENT_PATCH_KEYS,
  ASN_QTY_EPS,
  ALLOWED_ASN_TRANSITIONS,
  AsnError,
  activeAsnQtyByPoLine,
  actorName,
  assertAsnEditable,
  assertArticleMatchesPoLine,
  assertNoImmutableAsnPatch,
  assertQtyWithinAvailable,
  assertValidTransition,
  attachmentsEditable,
  consolidateAsnLinePayload,
  lineQtyDeltas,
  mergeAsnLinesPreservingIds,
  poLineArticle,
  poLineCancelledQtyForAsn,
  poLineIdentity,
  poLineReceivedQtyForAsn,
  poOrderedQtyForAsn,
  remainingAsnQty,
  roundAsnQty,
  sameCompanyId,
  shipmentFieldsEditable,
} from "../utils/asnRules.js";

const PO_BLOCKED_STATUSES = new Set(["CANCELLED", "REJECTED"]);
const MAX_ASN_NUMBER_SAVE_RETRIES = 4;

export function companyScope(companyId, extra = {}) {
  const cid = companyId;
  if (cid == null || cid === "") return { ...extra };
  const s = String(cid).trim();
  if (mongoose.Types.ObjectId.isValid(s)) {
    const oid = new mongoose.Types.ObjectId(s);
    if (!Object.keys(extra).length) {
      return { $or: [{ companyId: oid }, { companyId: s }] };
    }
    return { $and: [{ ...extra }, { $or: [{ companyId: oid }, { companyId: s }] }] };
  }
  return { ...extra, companyId: cid };
}

function asObjectId(value, label) {
  const s = String(value || "").trim();
  if (!mongoose.Types.ObjectId.isValid(s)) {
    throw new AsnError(`Invalid ${label}`, 400, "ASN_INVALID_ID");
  }
  return new mongoose.Types.ObjectId(s);
}

function lineObjectId(value) {
  if (value instanceof mongoose.Types.ObjectId) return value;
  return asObjectId(value, "PO line id");
}

function isTransactionUnsupported(err) {
  const msg = String(err?.message || "");
  const code = err?.code;
  return (
    msg.includes("Transaction numbers are only allowed") ||
    msg.includes("replica set") ||
    msg.includes("Transaction numbers are not allowed") ||
    code === 20 ||
    code === 263
  );
}

function sessionOpts(session) {
  return session ? { session } : {};
}

/** Mongoose 9 requires this for aggregation-pipeline updates (array of $set/$map stages). */
function poLinePipelineUpdateOptions(session) {
  return { new: true, updatePipeline: true, ...sessionOpts(session) };
}

function lineAsnActive(po, poLineId) {
  const want = String(poLineId);
  const line = (po?.lines || []).find((l) => String(l._id) === want);
  return roundAsnQty(line?.asnActiveQty);
}

/**
 * Atomically reserve ASN qty: receivedQty + asnActiveQty + qty <= ordered - cancelled.
 * Uses a pipeline update so receivedQty is read from the persisted PO line, not a stale cap.
 */
export async function claimPoLineAsnQty({ po, poLineId, qty, orderedQty, documentFloor = 0, session = null }) {
  const q = roundAsnQty(qty);
  void orderedQty;
  if (!(q > 0)) {
    throw new AsnError("ASN quantity must be greater than 0", 400, "ASN_QTY_INVALID");
  }
  await ensureLineCounterFloor(PurchaseOrder, session, {
    parentId: po._id,
    companyId: po.companyId,
    lineId: poLineId,
    field: "asnActiveQty",
    floor: roundAsnQty(documentFloor),
  });
  const lineOid = lineObjectId(poLineId);
  const before = lineAsnActive(po, poLineId);
  const updated = await PurchaseOrder.findOneAndUpdate(
    { _id: po._id, companyId: po.companyId, "lines._id": lineOid },
    [
      {
        $set: {
          lines: {
            $map: {
              input: "$lines",
              as: "ln",
              in: {
                $cond: [
                  {
                    $and: [
                      { $eq: ["$$ln._id", lineOid] },
                      {
                        $lte: [
                          {
                            $add: [
                              { $ifNull: ["$$ln.receivedQty", 0] },
                              { $ifNull: ["$$ln.asnActiveQty", 0] },
                              q,
                            ],
                          },
                          {
                            $add: [
                              {
                                $subtract: [
                                  { $ifNull: ["$$ln.orderedQty", { $ifNull: ["$$ln.qty", 0] }] },
                                  { $ifNull: ["$$ln.cancelledQty", 0] },
                                ],
                              },
                              ASN_QTY_EPS,
                            ],
                          },
                        ],
                      },
                    ],
                  },
                  {
                    $mergeObjects: [
                      "$$ln",
                      { asnActiveQty: { $add: [{ $ifNull: ["$$ln.asnActiveQty", 0] }, q] } },
                    ],
                  },
                  "$$ln",
                ],
              },
            },
          },
        },
      },
    ],
    poLinePipelineUpdateOptions(session)
  );
  if (!updated || roundAsnQty(lineAsnActive(updated, poLineId) - before) + ASN_QTY_EPS < q) {
    throw new AsnError("ASN quantity exceeds remaining available", 409, "ASN_QTY_EXCEEDED");
  }
  return updated;
}

/**
 * Restore ASN reservation after GRN reversal.
 * Credits receivedReversalQty so restore can run before PO receivedQty is decremented
 * in the same transaction, without treating still-posted receipt as blocking capacity.
 */
export async function restorePoLineAsnQty({
  po,
  poLineId,
  qty,
  receivedReversalQty = 0,
  session = null,
} = {}) {
  const q = roundAsnQty(qty);
  const credit = roundAsnQty(receivedReversalQty);
  if (!(q > 0)) return po;
  const lineOid = lineObjectId(poLineId);
  const before = lineAsnActive(po, poLineId);
  const updated = await PurchaseOrder.findOneAndUpdate(
    { _id: po._id, companyId: po.companyId, "lines._id": lineOid },
    [
      {
        $set: {
          lines: {
            $map: {
              input: "$lines",
              as: "ln",
              in: {
                $cond: [
                  {
                    $and: [
                      { $eq: ["$$ln._id", lineOid] },
                      {
                        $lte: [
                          {
                            $add: [
                              {
                                $max: [0, { $subtract: [{ $ifNull: ["$$ln.receivedQty", 0] }, credit] }],
                              },
                              { $ifNull: ["$$ln.asnActiveQty", 0] },
                              q,
                            ],
                          },
                          {
                            $add: [
                              {
                                $subtract: [
                                  { $ifNull: ["$$ln.orderedQty", { $ifNull: ["$$ln.qty", 0] }] },
                                  { $ifNull: ["$$ln.cancelledQty", 0] },
                                ],
                              },
                              ASN_QTY_EPS,
                            ],
                          },
                        ],
                      },
                    ],
                  },
                  {
                    $mergeObjects: [
                      "$$ln",
                      { asnActiveQty: { $add: [{ $ifNull: ["$$ln.asnActiveQty", 0] }, q] } },
                    ],
                  },
                  "$$ln",
                ],
              },
            },
          },
        },
      },
    ],
    poLinePipelineUpdateOptions(session)
  );
  if (!updated || roundAsnQty(lineAsnActive(updated, poLineId) - before) + ASN_QTY_EPS < q) {
    throw new AsnError(
      "Cannot restore this ASN reservation while another ASN holds the remaining PO quantity",
      409,
      "ASN_RESERVATION_RESTORE_CONFLICT"
    );
  }
  return updated;
}

export async function releasePoLineAsnQty({ po, poLineId, qty, session = null }) {
  const q = roundAsnQty(qty);
  if (!(q > 0)) return null;
  await ensureLineCounterFloor(PurchaseOrder, session, {
    parentId: po._id,
    companyId: po.companyId,
    lineId: poLineId,
    field: "asnActiveQty",
    floor: 0,
  });
  const lineOid = lineObjectId(poLineId);
  return PurchaseOrder.findOneAndUpdate(
    { _id: po._id, companyId: po.companyId, "lines._id": lineOid },
    [
      {
        $set: {
          lines: {
            $map: {
              input: "$lines",
              as: "ln",
              in: {
                $cond: [
                  { $eq: ["$$ln._id", lineOid] },
                  {
                    $mergeObjects: [
                      "$$ln",
                      {
                        asnActiveQty: {
                          $max: [0, { $subtract: [{ $ifNull: ["$$ln.asnActiveQty", 0] }, q] }],
                        },
                      },
                    ],
                  },
                  "$$ln",
                ],
              },
            },
          },
        },
      },
    ],
    poLinePipelineUpdateOptions(session)
  );
}

async function reverseClaims(po, claims, session = null) {
  for (const row of [...claims].reverse()) {
    if (row.delta > 0) {
      await releasePoLineAsnQty({ po, poLineId: row.poLineId, qty: row.delta, session });
    } else if (row.delta < 0) {
      const poLine = findPoLine(po, row.poLineId);
      await claimPoLineAsnQty({
        po,
        poLineId: row.poLineId,
        qty: -row.delta,
        orderedQty: poOrderedQtyForAsn(poLine),
        documentFloor: 0,
        session,
      });
    }
  }
}

async function applyLineQtyDeltas(po, deltas, { documentFloorByLine = new Map(), session = null } = {}) {
  const applied = [];
  try {
    for (const row of deltas) {
      if (row.delta > ASN_QTY_EPS) {
        const poLine = findPoLine(po, row.poLineId);
        await claimPoLineAsnQty({
          po,
          poLineId: row.poLineId,
          qty: row.delta,
          orderedQty: poOrderedQtyForAsn(poLine) || Number(row.orderedQty) || 0,
          documentFloor: documentFloorByLine.get(String(row.poLineId)) || 0,
          session,
        });
      } else if (row.delta < -ASN_QTY_EPS) {
        await releasePoLineAsnQty({ po, poLineId: row.poLineId, qty: -row.delta, session });
      } else {
        continue;
      }
      applied.push(row);
    }
    return applied;
  } catch (err) {
    if (!session) await reverseClaims(po, applied, null);
    throw err;
  }
}

function findPoLine(po, poLineId) {
  const id = String(poLineId || "");
  const lines = po?.lines || [];
  return lines.find((l) => String(l._id) === id) || null;
}

async function loadPoForCompany(companyId, poId) {
  const po = await PurchaseOrder.findOne(companyScope(companyId, { _id: asObjectId(poId, "purchase order id") }));
  if (!po) throw new AsnError("Purchase order not found", 404, "ASN_PO_NOT_FOUND");
  if (!sameCompanyId(po.companyId, companyId)) {
    throw new AsnError("Purchase order belongs to another company", 403, "ASN_COMPANY_MISMATCH");
  }
  const status = String(po.status || "").toUpperCase();
  if (PO_BLOCKED_STATUSES.has(status)) {
    throw new AsnError(`Cannot create ASN against a ${status.toLowerCase()} PO`, 400, "ASN_PO_BLOCKED");
  }
  return po;
}

async function loadActiveAsnsForPo(companyId, poId, session = null) {
  const filter = companyScope(companyId, {
    $or: [{ sourcePoId: poId }, { poIds: poId }],
    status: { $ne: "CANCELLED" },
  });
  const q = AdvanceShipmentNotice.find(filter).select("_id status lines asnNo").lean();
  if (session) q.session(session);
  return q;
}

function pickShipmentPatch(body = {}) {
  const out = {};
  for (const key of ASN_SHIPMENT_PATCH_KEYS) {
    if (body[key] !== undefined) out[key] = body[key];
  }
  if (out.shipmentMode) {
    const mode = String(out.shipmentMode).toUpperCase();
    if (!ASN_SHIPMENT_MODES.includes(mode)) {
      throw new AsnError("Invalid shipment mode", 400, "ASN_SHIPMENT_MODE");
    }
    out.shipmentMode = mode;
  }
  if (out.numberOfPackages != null) out.numberOfPackages = Math.max(0, Number(out.numberOfPackages) || 0);
  if (out.grossWeight != null) out.grossWeight = Math.max(0, Number(out.grossWeight) || 0);
  if (out.grossWeightUom) out.grossWeightUom = String(out.grossWeightUom).trim().toUpperCase() || "KG";
  if (out.currency) out.currency = String(out.currency).trim().toUpperCase();
  return out;
}

function buildAvailability(po, activeAsns, { excludeAsnId = "" } = {}) {
  const claimed = activeAsnQtyByPoLine(activeAsns, { excludeAsnId });
  const lines = (po.lines || []).map((line) => {
    const poLineId = poLineIdentity(line);
    const poQty = poOrderedQtyForAsn(line);
    const previouslyAsnQty = claimed.get(poLineId) || 0;
    const remaining = remainingAsnQty(
      poQty,
      previouslyAsnQty,
      poLineReceivedQtyForAsn(line),
      poLineCancelledQtyForAsn(line)
    );
    return {
      poId: po._id,
      poLineId: line._id,
      article: poLineArticle(line),
      itemName: line.itemName || line.description || "",
      description: line.description || "",
      supplierPartNumber: line.supplierPartNumber || "",
      partNumber: line.partNumber || line.partNo || "",
      uom: line.uom || "PCS",
      poQty,
      receivedQty: poLineReceivedQtyForAsn(line),
      cancelledQty: poLineCancelledQtyForAsn(line),
      previouslyAsnQty,
      remainingAvailableQty: remaining,
      unitPrice: Number(line.unitPrice) || 0,
      currency: line.currency || po.currency || "",
    };
  });
  const poQty = roundAsnQty(lines.reduce((s, l) => s + l.poQty, 0));
  const asnActiveQty = roundAsnQty(lines.reduce((s, l) => s + l.previouslyAsnQty, 0));
  return {
    poId: po._id,
    poNo: po.poNumber || po.poNo,
    poDate: po.orderDate || null,
    status: po.status,
    supplierId: po.supplierId,
    supplierName: po.supplierName,
    currency: po.currency || "",
    totals: {
      poQty,
      asnActiveQty,
      remainingToAsn: roundAsnQty(lines.reduce((s, l) => s + l.remainingAvailableQty, 0)),
    },
    lines,
  };
}

function snapshotLinesFromPo(po, payloadLines, claimed) {
  const consolidated = consolidateAsnLinePayload(payloadLines);
  if (!consolidated.length) {
    throw new AsnError("ASN requires at least one line with quantity", 400, "ASN_LINES_REQUIRED");
  }
  return consolidated.map((incoming) => {
    const poLine = findPoLine(po, incoming.poLineId);
    if (!poLine) {
      throw new AsnError("PO line not found on the source purchase order", 400, "ASN_PO_LINE_INVALID");
    }
    const expectedArticle = assertArticleMatchesPoLine(incoming.article, poLine);
    const poQty = poOrderedQtyForAsn(poLine);
    const previouslyAsnQty = claimed.get(String(poLine._id)) || 0;
    const requested = roundAsnQty(incoming.asnQty);
    assertQtyWithinAvailable({
      article: expectedArticle,
      poQty,
      alreadyActive: previouslyAsnQty,
      requested,
      receivedQty: poLineReceivedQtyForAsn(poLine),
      cancelledQty: poLineCancelledQtyForAsn(poLine),
    });
    return {
      poId: po._id,
      poLineId: poLine._id,
      itemId: poLine.itemId || null,
      article: expectedArticle,
      itemName: poLine.itemName || poLine.description || "",
      description: poLine.description || "",
      supplierPartNumber: poLine.supplierPartNumber || "",
      partNumber: poLine.partNumber || poLine.partNo || "",
      uom: poLine.uom || "PCS",
      poQty,
      previouslyAsnQty,
      remainingAvailableQty: remainingAsnQty(poQty, previouslyAsnQty + requested),
      asnQty: requested,
      unitPrice: Number(poLine.unitPrice) || 0,
      currency: poLine.currency || po.currency || "",
    };
  });
}

function auditAsn(req, entry) {
  return writeAudit(req, {
    module: "ASN",
    entityType: "ASN",
    ...entry,
  });
}

export async function getPoAsnAvailability(companyId, poId) {
  const po = await loadPoForCompany(companyId, poId);
  const active = await loadActiveAsnsForPo(companyId, po._id);
  const availability = buildAvailability(po, active);
  const linked = await AdvanceShipmentNotice.find(
    companyScope(companyId, { $or: [{ sourcePoId: po._id }, { poIds: po._id }] })
  )
    .select("asnNo status lines shipmentMode expectedArrivalDate createdBy createdAt")
    .sort({ createdAt: -1 })
    .lean();
  return {
    ...availability,
    asns: linked.map((row) => ({
      _id: row._id,
      asnNo: row.asnNo,
      status: row.status,
      shipmentMode: row.shipmentMode,
      expectedArrivalDate: row.expectedArrivalDate,
      createdBy: row.createdBy,
      createdAt: row.createdAt,
      qty: roundAsnQty((row.lines || []).reduce((s, l) => s + (Number(l.asnQty) || 0), 0)),
      uom: (row.lines || [])[0]?.uom || "PCS",
    })),
  };
}

export async function listAsns(companyId, query = {}) {
  const page = Math.max(1, parseInt(String(query.page || "1"), 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(String(query.limit || "50"), 10) || 50));
  const skip = (page - 1) * limit;
  const extra = {};
  if (query.status) {
    const statuses = String(query.status)
      .split(",")
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);
    if (statuses.length === 1) extra.status = statuses[0];
    else if (statuses.length > 1) extra.status = { $in: statuses };
  }
  if (String(query.incoming || "") === "1" && !query.status) {
    extra.status = { $in: ["SHIPPED", "ARRIVED", "PARTIALLY_RECEIVED", "COMPLETED"] };
  }
  if (query.shipmentMode) extra.shipmentMode = String(query.shipmentMode).trim().toUpperCase();
  if (query.supplier) {
    extra.supplierName = new RegExp(String(query.supplier).trim(), "i");
  }
  if (query.asnNo) extra.asnNo = new RegExp(String(query.asnNo).trim(), "i");
  if (query.poNo) extra.sourcePoNo = new RegExp(String(query.poNo).trim(), "i");
  if (query.poId && mongoose.Types.ObjectId.isValid(String(query.poId))) {
    extra.$or = [{ sourcePoId: query.poId }, { poIds: query.poId }];
  }
  if (query.shipmentDateFrom || query.shipmentDateTo) {
    extra.shipmentDate = {};
    if (query.shipmentDateFrom) extra.shipmentDate.$gte = new Date(query.shipmentDateFrom);
    if (query.shipmentDateTo) extra.shipmentDate.$lte = new Date(query.shipmentDateTo);
  }
  if (query.etaFrom || query.etaTo) {
    extra.expectedArrivalDate = {};
    if (query.etaFrom) extra.expectedArrivalDate.$gte = new Date(query.etaFrom);
    if (query.etaTo) extra.expectedArrivalDate.$lte = new Date(query.etaTo);
  }
  const filter = companyScope(companyId, extra);
  const [items, total] = await Promise.all([
    AdvanceShipmentNotice.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    AdvanceShipmentNotice.countDocuments(filter),
  ]);
  return { items, total, page, limit };
}

export async function getAsn(companyId, id) {
  const row = await AdvanceShipmentNotice.findOne(companyScope(companyId, { _id: asObjectId(id, "ASN id") })).lean();
  if (!row) throw new AsnError("ASN not found", 404, "ASN_NOT_FOUND");
  return row;
}

async function insertWithNumber(doc, req, session = null) {
  for (let attempt = 0; attempt < MAX_ASN_NUMBER_SAVE_RETRIES; attempt += 1) {
    doc.asnNo = await nextAsnNo({ companyId: req.companyId, companyCode: req.companyCode });
    try {
      return await doc.save(session ? { session } : undefined);
    } catch (err) {
      if (err?.code !== 11000) throw err;
    }
  }
  throw new AsnError("Unable to allocate a unique ASN number. Please try again.", 500, "ASN_NUMBER_FAILED");
}

function buildCreatePayload(req, po, body, lines) {
  const shipment = pickShipmentPatch(body);
  return new AdvanceShipmentNotice({
    ...shipment,
    companyId: po.companyId,
    status: "DRAFT",
    supplierId: po.supplierId,
    supplierName: po.supplierName,
    currency: po.currency || shipment.currency || "",
    sourcePoId: po._id,
    sourcePoNo: po.poNumber || po.poNo,
    sourcePoDate: po.orderDate || null,
    poIds: [po._id],
    lines,
    createdBy: actorName(req),
    createdByUserId: req.user?._id || req.user?.id || null,
    updatedBy: actorName(req),
    updatedByUserId: req.user?._id || req.user?.id || null,
    asnNo: "PENDING",
  });
}

async function createAsnWithClaims(req, po, body, session) {
  const active = await loadActiveAsnsForPo(req.companyId, po._id, session);
  const claimed = activeAsnQtyByPoLine(active);
  const lines = snapshotLinesFromPo(po, body.lines || [], claimed);
  const deltas = lines.map((line) => ({
    poLineId: String(line.poLineId),
    delta: line.asnQty,
    orderedQty: line.poQty,
    article: line.article,
  }));
  const applied = await applyLineQtyDeltas(po, deltas, {
    documentFloorByLine: claimed,
    session,
  });
  try {
    const doc = buildCreatePayload(req, po, body, lines);
    return await insertWithNumber(doc, req, session);
  } catch (err) {
    if (!session) await reverseClaims(po, applied, null);
    throw err;
  }
}

export async function createAsn(req, body = {}) {
  const companyId = req.companyId;
  const poId = body.sourcePoId || body.poId;
  if (!poId) throw new AsnError("sourcePoId is required", 400, "ASN_PO_REQUIRED");
  const po = await loadPoForCompany(companyId, poId);
  if (body.supplierId && po.supplierId && !sameCompanyId(body.supplierId, po.supplierId)) {
    throw new AsnError("Supplier does not match the source purchase order", 400, "ASN_SUPPLIER_MISMATCH");
  }

  let saved;
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      saved = await createAsnWithClaims(req, po, body, session);
    });
  } catch (err) {
    if (err instanceof AsnError) throw err;
    if (isTransactionUnsupported(err)) {
      saved = await createAsnWithClaims(req, po, body, null);
    } else {
      throw err;
    }
  } finally {
    await session.endSession();
  }

  await auditAsn(req, {
    action: "CREATE",
    entityId: saved._id,
    documentNo: saved.asnNo,
    description: `ASN ${saved.asnNo} created from ${saved.sourcePoNo}`,
    metadata: { sourcePoId: String(saved.sourcePoId), lineCount: saved.lines.length },
  });
  return saved.toObject ? saved.toObject() : saved;
}

async function updateAsnLinesWithClaims(req, doc, po, body, session) {
  const active = await loadActiveAsnsForPo(req.companyId, po._id, session);
  const claimedExcl = activeAsnQtyByPoLine(active, { excludeAsnId: doc._id });
  const snapshots = snapshotLinesFromPo(po, body.lines, claimedExcl);
  const merged = mergeAsnLinesPreservingIds(doc.lines, snapshots);
  const deltas = lineQtyDeltas(doc.lines, merged);
  const floorIncludingSelf = activeAsnQtyByPoLine(active);
  const applied = await applyLineQtyDeltas(po, deltas, {
    documentFloorByLine: floorIncludingSelf,
    session,
  });
  try {
    doc.lines = merged;
    doc.updatedBy = actorName(req);
    doc.updatedByUserId = req.user?._id || req.user?.id || null;
    if (shipmentFieldsEditable(doc.status)) {
      Object.assign(doc, pickShipmentPatch(body));
    }
    await doc.save(session ? { session } : undefined);
  } catch (err) {
    if (!session) await reverseClaims(po, applied, null);
    throw err;
  }
}

export async function updateAsn(req, id, body = {}) {
  const companyId = req.companyId;
  const doc = await AdvanceShipmentNotice.findOne(companyScope(companyId, { _id: asObjectId(id, "ASN id") }));
  if (!doc) throw new AsnError("ASN not found", 404, "ASN_NOT_FOUND");
  const before = { status: doc.status, lines: doc.lines.map((l) => ({ poLineId: l.poLineId, asnQty: l.asnQty })) };

  assertNoImmutableAsnPatch(body);

  const wantsLines = Array.isArray(body.lines);
  if (wantsLines) assertAsnEditable(doc.status, { lines: true });
  else if (!shipmentFieldsEditable(doc.status) && Object.keys(pickShipmentPatch(body)).length) {
    throw new AsnError("Shipment details cannot be edited in this status", 400, "ASN_FROZEN");
  }

  if (wantsLines) {
    const po = await loadPoForCompany(companyId, doc.sourcePoId);
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        await updateAsnLinesWithClaims(req, doc, po, body, session);
      });
    } catch (err) {
      if (err instanceof AsnError) throw err;
      if (isTransactionUnsupported(err)) {
        await updateAsnLinesWithClaims(req, doc, po, body, null);
      } else {
        throw err;
      }
    } finally {
      await session.endSession();
    }
  } else {
    if (shipmentFieldsEditable(doc.status)) {
      Object.assign(doc, pickShipmentPatch(body));
    }
    doc.updatedBy = actorName(req);
    doc.updatedByUserId = req.user?._id || req.user?.id || null;
    await doc.save();
  }

  await auditAsn(req, {
    action: "UPDATE",
    entityId: doc._id,
    documentNo: doc.asnNo,
    description: `ASN ${doc.asnNo} updated`,
    beforeData: before,
    afterData: { status: doc.status, lines: doc.lines.map((l) => ({ poLineId: l.poLineId, asnQty: l.asnQty })) },
  });
  return doc.toObject();
}

async function transition(req, id, toStatus) {
  const companyId = req.companyId;
  const oid = asObjectId(id, "ASN id");
  const allowedFrom = Object.entries(ALLOWED_ASN_TRANSITIONS)
    .filter(([, next]) => next.includes(toStatus))
    .map(([from]) => from);
  const actor = actorName(req);
  const now = new Date();
  const updated = await AdvanceShipmentNotice.findOneAndUpdate(
    companyScope(companyId, { _id: oid, status: { $in: allowedFrom } }),
    {
      $set: {
        status: toStatus,
        ...(toStatus === "SHIPPED" ? { shippedAt: now, shippedBy: actor } : {}),
        ...(toStatus === "ARRIVED" ? { arrivedAt: now, arrivedBy: actor } : {}),
        updatedBy: actor,
        updatedByUserId: req.user?._id || req.user?.id || null,
      },
    },
    { new: true }
  );
  if (!updated) {
    const existing = await AdvanceShipmentNotice.findOne(companyScope(companyId, { _id: oid })).lean();
    if (!existing) throw new AsnError("ASN not found", 404, "ASN_NOT_FOUND");
    assertValidTransition(existing.status, toStatus);
    throw new AsnError(`Cannot change ASN status from ${existing.status} to ${toStatus}`, 409, "ASN_INVALID_TRANSITION");
  }
  const from = allowedFrom.find((s) => s !== toStatus) || existingStatusFromAudit(updated, toStatus);
  await writeStatusChange(req, {
    module: "ASN",
    entityType: "ASN",
    entityId: updated._id,
    documentNo: updated.asnNo,
    fromStatus: from,
    toStatus,
    description: `ASN ${updated.asnNo} ${from} → ${toStatus}`,
  });
  await auditAsn(req, {
    action: "STATUS_CHANGE",
    entityId: updated._id,
    documentNo: updated.asnNo,
    fromStatus: from,
    toStatus,
    description: `ASN ${updated.asnNo} marked ${toStatus}`,
  });
  return updated.toObject();
}

function existingStatusFromAudit(updated, toStatus) {
  if (toStatus === "SHIPPED") return "DRAFT";
  if (toStatus === "ARRIVED") return "SHIPPED";
  return updated.status;
}

export function shipAsn(req, id) {
  return transition(req, id, "SHIPPED");
}

export function arriveAsn(req, id) {
  return transition(req, id, "ARRIVED");
}

const ASN_CANCELLABLE_STATUSES = Object.freeze(["DRAFT", "SHIPPED", "ARRIVED"]);

async function releaseCancelledLines(po, lines, session) {
  for (const line of lines || []) {
    await releasePoLineAsnQty({ po, poLineId: line.poLineId, qty: line.asnQty, session });
  }
}

export async function cancelAsn(req, id, body = {}, opts = {}) {
  if (opts.guard !== "ASN_CANCEL_POLICY") {
    throw new AsnError("ASN cancel must use the logistics cancel policy", 500, "ASN_CANCEL_GUARD_REQUIRED");
  }
  const companyId = req.companyId;
  const reason = String(body.reason || body.cancellationReason || "").trim();
  if (!reason) throw new AsnError("Cancellation reason is required", 400, "ASN_CANCEL_REASON");
  const oid = asObjectId(id, "ASN id");
  const actor = actorName(req);
  const now = new Date();
  const filter = companyScope(companyId, {
    _id: oid,
    status: { $in: [...ASN_CANCELLABLE_STATUSES] },
  });
  const setCancelled = {
    $set: {
      status: "CANCELLED",
      cancelledAt: now,
      cancelledBy: actor,
      cancellationReason: reason,
      updatedBy: actor,
      updatedByUserId: req.user?._id || req.user?.id || null,
    },
  };

  async function cancelOnce(session) {
    const previous = await AdvanceShipmentNotice.findOneAndUpdate(filter, setCancelled, {
      new: false,
      ...sessionOpts(session),
    });
    if (!previous) {
      const existing = await AdvanceShipmentNotice.findOne(
        companyScope(companyId, { _id: oid }),
        null,
        sessionOpts(session)
      ).lean();
      if (!existing) throw new AsnError("ASN not found", 404, "ASN_NOT_FOUND");
      if (existing.status === "CANCELLED") {
        return { doc: existing, alreadyCancelled: true, fromStatus: "CANCELLED" };
      }
      throw new AsnError(
        `Cannot change ASN status from ${existing.status} to CANCELLED`,
        400,
        "ASN_INVALID_TRANSITION"
      );
    }
    const po = await PurchaseOrder.findOne(
      companyScope(companyId, { _id: previous.sourcePoId }),
      null,
      sessionOpts(session)
    );
    if (po) await releaseCancelledLines(po, previous.lines, session);
    const cancelled = previous.toObject ? previous.toObject() : { ...previous };
    cancelled.status = "CANCELLED";
    cancelled.cancelledAt = now;
    cancelled.cancelledBy = actor;
    cancelled.cancellationReason = reason;
    return { doc: cancelled, alreadyCancelled: false, fromStatus: previous.status };
  }

  let result;
  if (opts.session) {
    result = await cancelOnce(opts.session);
  } else {
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        result = await cancelOnce(session);
      });
    } catch (err) {
      if (err instanceof AsnError) throw err;
      if (isTransactionUnsupported(err)) {
        result = await cancelOnce(null);
      } else {
        throw err;
      }
    } finally {
      await session.endSession();
    }
  }

  if (!result.alreadyCancelled) {
    await writeStatusChange(req, {
      module: "ASN",
      entityType: "ASN",
      entityId: result.doc._id,
      documentNo: result.doc.asnNo,
      fromStatus: result.fromStatus,
      toStatus: "CANCELLED",
      description: `ASN ${result.doc.asnNo} ${result.fromStatus} → CANCELLED`,
      metadata: { reason },
    });
    await auditAsn(req, {
      action: "CANCEL",
      entityId: result.doc._id,
      documentNo: result.doc.asnNo,
      fromStatus: result.fromStatus,
      toStatus: "CANCELLED",
      description: `ASN ${result.doc.asnNo} marked CANCELLED`,
    });
  }
  return result.doc;
}

export async function addAsnAttachment(req, id, body = {}) {
  const companyId = req.companyId;
  const doc = await AdvanceShipmentNotice.findOne(companyScope(companyId, { _id: asObjectId(id, "ASN id") }));
  if (!doc) throw new AsnError("ASN not found", 404, "ASN_NOT_FOUND");
  if (!attachmentsEditable(doc.status)) {
    throw new AsnError("Attachments cannot be changed on a cancelled ASN", 400, "ASN_READ_ONLY");
  }
  const documentId = body.documentId;
  if (!documentId || !mongoose.Types.ObjectId.isValid(String(documentId))) {
    throw new AsnError("documentId is required", 400, "ASN_DOCUMENT_REQUIRED");
  }
  const file = await Document.findOne(companyScope(companyId, { _id: documentId })).lean();
  if (!file) throw new AsnError("Document not found in this company", 404, "ASN_DOCUMENT_NOT_FOUND");
  doc.attachments.push({
    documentId: file._id,
    documentType: body.documentType || file.documentType || "ASN Document",
    originalFilename: body.originalFilename || file.originalFileName || file.storedFileName || "",
    storageRef: file.s3Key || file.fileUrl || "",
    uploadedBy: actorName(req),
    uploadedAt: new Date(),
  });
  doc.updatedBy = actorName(req);
  await doc.save();
  await auditAsn(req, {
    action: "ATTACHMENT",
    entityId: doc._id,
    documentNo: doc.asnNo,
    description: `ASN ${doc.asnNo} attachment added`,
    metadata: { documentId: String(file._id), documentType: body.documentType || file.documentType },
  });
  return doc.toObject();
}

export async function removeAsnAttachment(req, id, attachmentId) {
  const companyId = req.companyId;
  const doc = await AdvanceShipmentNotice.findOne(companyScope(companyId, { _id: asObjectId(id, "ASN id") }));
  if (!doc) throw new AsnError("ASN not found", 404, "ASN_NOT_FOUND");
  if (!attachmentsEditable(doc.status)) {
    throw new AsnError("Attachments cannot be changed on a cancelled ASN", 400, "ASN_READ_ONLY");
  }
  const before = doc.attachments.length;
  doc.attachments = doc.attachments.filter((a) => String(a._id) !== String(attachmentId));
  if (doc.attachments.length === before) {
    throw new AsnError("Attachment not found", 404, "ASN_ATTACHMENT_NOT_FOUND");
  }
  doc.updatedBy = actorName(req);
  await doc.save();
  await auditAsn(req, {
    action: "ATTACHMENT",
    entityId: doc._id,
    documentNo: doc.asnNo,
    description: `ASN ${doc.asnNo} attachment removed`,
    metadata: { attachmentId: String(attachmentId) },
  });
  return doc.toObject();
}

export async function listAsnsForPurchaseOrder(companyId, poId) {
  return AdvanceShipmentNotice.find(
    companyScope(companyId, { $or: [{ sourcePoId: poId }, { poIds: poId }] })
  )
    .select("asnNo status lines shipmentMode expectedArrivalDate createdBy createdAt")
    .sort({ createdAt: -1 })
    .lean();
}

export async function getActiveAsnQtyByPoLine(companyId, poId) {
  const active = await loadActiveAsnsForPo(companyId, poId);
  return activeAsnQtyByPoLine(active);
}

export async function assertPoHasNoActiveAsns(companyId, poId) {
  const asns = await AdvanceShipmentNotice.find(
    companyScope(companyId, {
      $or: [{ sourcePoId: poId }, { poIds: poId }],
      status: { $in: [...ASN_ACTIVE_STATUSES] },
    })
  )
    .select("asnNo status")
    .lean();
  if (!asns.length) return;
  const nos = asns.map((a) => a.asnNo).filter(Boolean).join(", ");
  throw new AsnError(
    `Cannot cancel or delete this purchase order while active ASN ${nos} exist`,
    409,
    "ASN_PO_HAS_ACTIVE"
  );
}
