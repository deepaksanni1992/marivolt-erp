/**
 * ASN receiving source resolver — GRN → ASN → PO.
 *
 * For sourceType = ASN_RECEIVING the ASN is the only commercial authority.
 * PurchaseOrder is loaded through ASN.sourcePoId / ASN.poIds / ASN line.poId.
 * GRN.poId and items[].poLineId are derived snapshots, never independent keys.
 *
 * Phase 4B supports one PO per ASN. The maps are shaped for future multi-PO
 * (poById, poIdByAsnLineId) without implementing multi-PO GRNs.
 */
import mongoose from "mongoose";
import AdvanceShipmentNotice from "../models/AdvanceShipmentNotice.js";
import PurchaseOrder from "../models/PurchaseOrder.js";
import ReceivingSession from "../models/ReceivingSession.js";
import { ReceivingInspectionError } from "../utils/receivingInspectionRules.js";
import {
  ReceivingDraftGrnError,
  RECEIVING_GRN_MULTI_PO,
  assertSinglePoForReceivingGrn,
} from "../utils/receivingDraftGrnRules.js";

function oid(value) {
  const s = String(value || "").trim();
  if (!s || !mongoose.Types.ObjectId.isValid(s)) return null;
  return new mongoose.Types.ObjectId(s);
}

function idStr(value) {
  if (value == null || value === "") return "";
  return String(value);
}

/** Collect every PO id the ASN claims. Does not pick an arbitrary GRN.poId. */
export function collectAsnSourcePoIds(asn) {
  const ids = [];
  if (asn?.sourcePoId) ids.push(asn.sourcePoId);
  for (const extra of asn?.poIds || []) {
    if (extra) ids.push(extra);
  }
  for (const line of asn?.lines || []) {
    if (line?.poId) ids.push(line.poId);
  }
  return [...new Set(ids.map(idStr).filter(Boolean))];
}

export function findPoLineOnOrder(po, poLineId) {
  if (!po || !poLineId) return null;
  const want = idStr(poLineId);
  try {
    const via = po.lines?.id?.(poLineId);
    if (via) return via;
  } catch {
    /* lean docs have no .id() */
  }
  return (po.lines || []).find((ln) => idStr(ln._id) === want) || null;
}

/**
 * Build ASN-line → PO-line maps. PO identity always comes from the ASN line
 * (line.poId || asn.sourcePoId), then that PO's line via asnLine.poLineId.
 */
export function buildAsnPoLineMaps(asn, poById) {
  const asnLineById = new Map();
  const poLineByAsnLineId = new Map();
  const poLineIdByAsnLineId = new Map();
  const poIdByAsnLineId = new Map();
  for (const line of asn?.lines || []) {
    const asnLineId = idStr(line._id);
    asnLineById.set(asnLineId, line);
    const poId = idStr(line.poId || asn.sourcePoId);
    const po = poById.get(poId);
    if (!po) {
      throw new ReceivingDraftGrnError(
        `ASN line ${asnLineId} references a purchase order that is not on this ASN`,
        409,
        "ASN_GRN_SOURCE_MISMATCH"
      );
    }
    const poLine = findPoLineOnOrder(po, line.poLineId);
    if (!poLine) {
      throw new ReceivingDraftGrnError(
        `ASN line is missing its source PO line`,
        409,
        "ASN_GRN_SOURCE_MISMATCH"
      );
    }
    poLineByAsnLineId.set(asnLineId, poLine);
    poLineIdByAsnLineId.set(asnLineId, poLine._id);
    poIdByAsnLineId.set(asnLineId, po._id);
  }
  return { asnLineById, poLineByAsnLineId, poLineIdByAsnLineId, poIdByAsnLineId };
}

export function assertGrnHeaderMatchesAsnSource(grn, source) {
  if (idStr(grn.asnId) !== idStr(source.asn._id)) {
    throw new ReceivingDraftGrnError(
      "GRN ASN snapshot does not match the receiving session ASN",
      409,
      "ASN_GRN_SOURCE_MISMATCH"
    );
  }
  if (idStr(grn.receivingSessionId) && idStr(grn.receivingSessionId) !== idStr(source.receivingSession._id)) {
    throw new ReceivingDraftGrnError(
      "GRN receiving session snapshot does not match the source session",
      409,
      "ASN_GRN_SOURCE_MISMATCH"
    );
  }
  const expectedPoId = idStr(source.po?._id);
  if (expectedPoId && idStr(grn.poId) !== expectedPoId) {
    throw new ReceivingDraftGrnError(
      "GRN PO snapshot does not match the ASN source purchase order",
      409,
      "ASN_GRN_SOURCE_MISMATCH"
    );
  }
}

export function assertGrnLineMatchesAsnSource(item, source) {
  const asnLineId = idStr(item?.asnLineId);
  if (!asnLineId) {
    throw new ReceivingDraftGrnError(
      "ASN receiving GRN line is missing asnLineId",
      409,
      "ASN_GRN_SOURCE_MISMATCH"
    );
  }
  const asnLine = source.asnLineById.get(asnLineId);
  if (!asnLine) {
    throw new ReceivingDraftGrnError(
      "GRN line asnLineId is not on the source ASN",
      409,
      "ASN_GRN_SOURCE_MISMATCH"
    );
  }
  const authoritativePoLineId = idStr(source.poLineIdByAsnLineId.get(asnLineId));
  if (idStr(item.poLineId) !== authoritativePoLineId) {
    throw new ReceivingDraftGrnError(
      "GRN line PO snapshot does not match the ASN line's PO line",
      409,
      "ASN_GRN_SOURCE_MISMATCH"
    );
  }
}

export function assertAsnReceivingGrnSnapshots(grn, source) {
  assertGrnHeaderMatchesAsnSource(grn, source);
  for (const item of grn.items || []) {
    assertGrnLineMatchesAsnSource(item, source);
  }
  return true;
}

export async function resolveAsnReceivingSource({
  companyId,
  receivingSessionId,
  mongoSession = null,
} = {}) {
  const sid = oid(receivingSessionId);
  if (!sid) {
    throw new ReceivingInspectionError("Receiving session id is required", 400, "RECEIVING_SESSION_REQUIRED");
  }
  const sessionQ = ReceivingSession.findOne({ _id: sid, companyId });
  if (mongoSession) sessionQ.session(mongoSession);
  const receivingSession = await sessionQ.lean();
  if (!receivingSession) {
    throw new ReceivingInspectionError("Receiving session not found", 404, "RECEIVING_SESSION_NOT_FOUND");
  }

  const asnQ = AdvanceShipmentNotice.findOne({ _id: receivingSession.asnId, companyId });
  if (mongoSession) asnQ.session(mongoSession);
  const asn = await asnQ.lean();
  if (!asn) throw new ReceivingInspectionError("ASN not found", 404, "ASN_NOT_FOUND");
  if (idStr(asn._id) !== idStr(receivingSession.asnId)) {
    throw new ReceivingInspectionError("Receiving session does not belong to this ASN", 409, "RECEIVING_SESSION_ASN_MISMATCH");
  }

  const poIdList = collectAsnSourcePoIds(asn);
  let singlePoId;
  try {
    singlePoId = assertSinglePoForReceivingGrn(poIdList);
  } catch (err) {
    if (err?.code === RECEIVING_GRN_MULTI_PO) throw err;
    throw err;
  }

  const poQ = PurchaseOrder.findOne({ _id: singlePoId, companyId });
  if (mongoSession) poQ.session(mongoSession);
  const po = await poQ.lean();
  if (!po) {
    throw new ReceivingDraftGrnError("Source purchase order not found on ASN", 404, "RECEIVING_GRN_PO_MISSING");
  }

  const poById = new Map([[idStr(po._id), po]]);
  const maps = buildAsnPoLineMaps(asn, poById);
  return {
    receivingSession,
    asn,
    po,
    poById,
    poIds: poIdList,
    ...maps,
  };
}
