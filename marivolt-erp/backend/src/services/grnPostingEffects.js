/**
 * Shared GRN stock + PO receipt effects used by MANUAL_PO and ASN_RECEIVING.
 * ASN source resolution stays in asnReceivingSourceResolver — this file only applies effects.
 */
import mongoose from "mongoose";
import PurchaseOrder from "../models/PurchaseOrder.js";
import StockLocation from "../models/StockLocation.js";
import StockLedger from "../models/StockLedger.js";
import * as stockService from "./stockService.js";
import { syncPoLinesToItemMaster } from "./poItemMasterSyncService.js";
import {
  claimPoLineReceivedQty,
  derivePoReceiptStatus,
  recalcPoLinePending,
  releasePoLineReceivedQty,
} from "../utils/poReceiptClaim.js";

const DEFAULT_GRN_WAREHOUSE_CODE = "MAIN";
const DEFAULT_GRN_WAREHOUSE_NAME = "Main Warehouse";

function upper(v) {
  return String(v || "").trim().toUpperCase();
}
function t(v) {
  return String(v ?? "").trim();
}

function withCompanyId(companyId, filter = {}) {
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

function findPoLineSubdocument(po, poLineId) {
  if (!po || poLineId == null || poLineId === "") return null;
  try {
    const via = po.lines?.id?.(poLineId);
    if (via) return via;
  } catch {
    /* lean */
  }
  return (po.lines || []).find((l) => String(l._id) === String(poLineId)) || null;
}

export function resolveGrnWarehouseCode(warehouseRaw) {
  return upper(warehouseRaw) || DEFAULT_GRN_WAREHOUSE_CODE;
}

export async function ensureDefaultGrnStockLocation(req, session = null) {
  const cid = req.companyId;
  if (cid == null || cid === "") return null;
  const code = DEFAULT_GRN_WAREHOUSE_CODE;
  const baseFilter = withCompanyId(cid, { locationCode: code });
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
      [{ companyId: cid, locationCode: code, locationName: DEFAULT_GRN_WAREHOUSE_NAME, status: "Active" }],
      session ? { session } : {}
    );
    return Array.isArray(arr) ? arr[0] : arr;
  } catch (e) {
    const msg = String(e?.message || "");
    if (e?.code === 11000 || msg.includes("duplicate") || msg.includes("E11000")) {
      const q2 = StockLocation.findOne(baseFilter);
      if (session) q2.session(session);
      return q2;
    }
    throw e;
  }
}

async function findRecoveryNotes({ session, companyId, article, warehouse, qty }) {
  const code = upper(article);
  const wh = upper(warehouse);
  if (!code || !wh || !(Number(qty) > 0)) return [];
  const q = StockLedger.find(withCompanyId(companyId, { article: code, warehouse: wh, isNegativeAllocation: true }))
    .sort({ transactionDate: -1 })
    .limit(5)
    .lean();
  if (session) q.session(session);
  const rows = await q;
  return (rows || []).map((r) => r.remarks).filter(Boolean);
}

export async function receiveGrnItemIntoStock({
  session,
  req,
  grn,
  line,
  sourcePo = null,
  provenance = {},
} = {}) {
  const article = upper(line.article);
  await syncPoLinesToItemMaster({
    companyId: grn.companyId || req.companyId,
    companyCode: req.companyCode,
    poNo: sourcePo?.poNo || sourcePo?.poNumber || grn.poNo,
    supplierName: grn.supplierName,
    header: sourcePo || {},
    lines: [line],
    session,
  });
  const wh = resolveGrnWarehouseCode(line.warehouse);
  const putaway = t(line.location) || wh;
  if (!putaway) throw new Error("Location is required for selected GRN line.");
  const loc = await StockLocation.findOne(withCompanyId(req.companyId, { locationCode: wh, status: "Active" })).session(
    session
  );
  if (!loc) throw new Error(`Invalid warehouse (stock location code): ${wh}`);
  const qty = Number(line.acceptedQty) || 0;
  if (!(qty > 0)) return { recoveryInfo: [] };
  const recoveryInfo = await findRecoveryNotes({
    session,
    companyId: req.companyId,
    article,
    warehouse: wh,
    qty,
  });
  await stockService.grnReceive({
    session,
    companyId: req.companyId,
    article,
    warehouse: wh,
    qty,
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
    lineId: String(line._id || line.asnLineId || line.poLineId || `${article}:${wh}`),
    sourceDocumentType: "GRN",
    sourceDocumentId: grn._id,
    sourceLineId: line.asnLineId || line.poLineId || null,
    asnId: provenance.asnId || grn.asnId || null,
    asnNo: provenance.asnNo || grn.asnNo || "",
    asnLineId: line.asnLineId || null,
    receivingSessionId: provenance.receivingSessionId || grn.receivingSessionId || null,
  });
  return { recoveryInfo };
}

export async function applyReceiveToPo({ session, req, grn, allowOverPo = false }) {
  if (!grn.poId) return;
  const companyId = req.companyId;
  const po = await PurchaseOrder.findOne(withCompanyId(companyId, { _id: grn.poId })).session(session);
  if (!po) return;
  const receiveByLineId = new Map();
  for (const line of grn.items || []) {
    if (!line.poLineId) continue;
    const current = receiveByLineId.get(String(line.poLineId)) || { accepted: 0, rejected: 0 };
    current.accepted += Number(line.acceptedQty) || 0;
    current.rejected += Number(line.rejectedQty) || 0;
    receiveByLineId.set(String(line.poLineId), current);
  }
  if (allowOverPo) {
    for (const [lineIdStr, rec] of receiveByLineId) {
      const poLine = findPoLineSubdocument(po, lineIdStr);
      if (!poLine) continue;
      const ordered = Number(poLine.orderedQty ?? poLine.qty) || 0;
      const nextReceived = Math.min(ordered, (Number(poLine.receivedQty) || 0) + rec.accepted);
      poLine.receivedQty = nextReceived;
      poLine.rejectedQty = (Number(poLine.rejectedQty) || 0) + rec.rejected;
      recalcPoLinePending(poLine);
      poLine.lineAmount = ordered * (Number(poLine.unitPrice) || 0);
      poLine.lineTotal = poLine.lineAmount;
    }
    const status = derivePoReceiptStatus(po.lines);
    if (status) po.status = status;
    await po.save({ session });
    return;
  }
  for (const [lineIdStr, rec] of receiveByLineId) {
    const poLine = findPoLineSubdocument(po, lineIdStr);
    if (!poLine) continue;
    const ordered = Number(poLine.orderedQty ?? poLine.qty) || 0;
    if (rec.accepted > 0) {
      await claimPoLineReceivedQty({
        companyId: po.companyId,
        poId: po._id,
        poLineId: poLine._id,
        qty: rec.accepted,
        orderedQty: ordered,
        cancelledQty: Number(poLine.cancelledQty) || 0,
        session,
      });
    }
  }
  const fresh = await PurchaseOrder.findOne(withCompanyId(companyId, { _id: grn.poId })).session(session);
  if (!fresh) return;
  for (const [lineIdStr, rec] of receiveByLineId) {
    const poLine = findPoLineSubdocument(fresh, lineIdStr);
    if (!poLine) continue;
    poLine.rejectedQty = (Number(poLine.rejectedQty) || 0) + rec.rejected;
    recalcPoLinePending(poLine);
  }
  const status = derivePoReceiptStatus(fresh.lines);
  if (status) fresh.status = status;
  await fresh.save({ session });
}

export async function reverseReceiveOnPo({ session, req, grn }) {
  if (!grn.poId) return;
  const companyId = req.companyId;
  for (const line of grn.items || []) {
    if (!line.poLineId || !(Number(line.acceptedQty) > 0)) continue;
    await releasePoLineReceivedQty({
      companyId,
      poId: grn.poId,
      poLineId: line.poLineId,
      qty: Number(line.acceptedQty) || 0,
      session,
    });
  }
  const po = await PurchaseOrder.findOne(withCompanyId(companyId, { _id: grn.poId })).session(session);
  if (!po) return;
  for (const line of po.lines || []) recalcPoLinePending(line);
  const status = derivePoReceiptStatus(po.lines);
  po.status = status || po.status;
  await po.save({ session });
}
