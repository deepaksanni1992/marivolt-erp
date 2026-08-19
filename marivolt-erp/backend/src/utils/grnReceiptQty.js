/**
 * Shared PO pending / posted-GRN quantity helpers.
 * Used by Store GRN posting and ASN Phase 4B Draft GRN generation.
 * Do not invent a second definition of PO pending.
 */
import mongoose from "mongoose";

/** GRN documents that count toward PO received / pending (excludes DRAFT and CANCELLED). */
export const GRN_POSTED_FOR_RECEIPT_QTY = Object.freeze([
  "POSTED",
  "RECEIVED",
  "PARTIAL_RECEIVED",
  "CLOSED",
]);

export const GRN_ACTIVE_ASN_RECEIVING_STATUSES = Object.freeze([
  "DRAFT",
  "RECEIVED",
  "PARTIAL_RECEIVED",
  "POSTED",
  "CLOSED",
]);

export function companyIdOrFilter(companyId) {
  const cid = companyId;
  if (cid == null || cid === "") return {};
  const s = String(cid).trim();
  if (mongoose.Types.ObjectId.isValid(s)) {
    const oid = new mongoose.Types.ObjectId(s);
    return { $or: [{ companyId: oid }, { companyId: s }] };
  }
  return { companyId: cid };
}

export function withCompanyId(companyId, filter = {}) {
  const cidFilter = companyIdOrFilter(companyId);
  if (!Object.keys(cidFilter).length) return { ...filter };
  if (!Object.keys(filter).length) return cidFilter;
  return { $and: [{ ...filter }, cidFilter] };
}

function mapAcceptedByPoLine(rows = []) {
  return new Map(rows.map((r) => [String(r._id), Math.max(0, Number(r.qty) || 0)]));
}

/**
 * Posted accepted qty by PO line (authoritative over persisted pendingQty).
 */
export async function getPostedAcceptedQtyByPoLineMap(GRN, { companyId, poId, session = null } = {}) {
  if (!mongoose.Types.ObjectId.isValid(String(poId))) return new Map();
  const oid = new mongoose.Types.ObjectId(String(poId));
  const pipeline = [
    { $match: withCompanyId(companyId, { poId: oid, status: { $in: [...GRN_POSTED_FOR_RECEIPT_QTY] } }) },
    { $unwind: "$items" },
    { $match: { "items.poLineId": { $exists: true, $ne: null } } },
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
  return mapAcceptedByPoLine(rows);
}

/**
 * Other DRAFT GRNs on the same PO that already claim accepted qty.
 * Prevents two drafts from independently booking the same entitlement.
 */
export async function getOpenDraftAcceptedQtyByPoLineMap(
  GRN,
  { companyId, poId, excludeGrnId = null, session = null } = {}
) {
  if (!mongoose.Types.ObjectId.isValid(String(poId))) return new Map();
  const oid = new mongoose.Types.ObjectId(String(poId));
  const filter = { poId: oid, status: "DRAFT" };
  if (excludeGrnId && mongoose.Types.ObjectId.isValid(String(excludeGrnId))) {
    filter._id = { $ne: new mongoose.Types.ObjectId(String(excludeGrnId)) };
  }
  const match = withCompanyId(companyId, filter);
  const pipeline = [
    { $match: match },
    { $unwind: "$items" },
    { $match: { "items.poLineId": { $exists: true, $ne: null } } },
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
  return mapAcceptedByPoLine(rows);
}

export function poLineEntitlement({ orderedQty = 0, cancelledQty = 0, postedAcceptedQty = 0, otherDraftAcceptedQty = 0 } = {}) {
  const ordered = Math.max(0, Number(orderedQty) || 0);
  const cancelled = Math.max(0, Number(cancelledQty) || 0);
  const posted = Math.max(0, Number(postedAcceptedQty) || 0);
  const drafts = Math.max(0, Number(otherDraftAcceptedQty) || 0);
  return Math.max(0, ordered - cancelled - posted - drafts);
}
