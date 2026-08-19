/**
 * Atomic PO commercial receipt claim.
 * Caps receivedQty so concurrent GRNs cannot both consume the same remaining ordered qty.
 * Does not invent a second reservation counter — it claims PurchaseOrder.lines.receivedQty.
 */
import mongoose from "mongoose";
import PurchaseOrder from "../models/PurchaseOrder.js";
import { ASN_QTY_EPS, roundAsnQty } from "./asnRules.js";

export const PO_RECEIPT_QTY_EXCEEDED = "PO_RECEIPT_QTY_EXCEEDED";

export class PoReceiptClaimError extends Error {
  constructor(message, status = 409, code = PO_RECEIPT_QTY_EXCEEDED) {
    super(message);
    this.name = "PoReceiptClaimError";
    this.status = status;
    this.statusCode = status;
    this.code = code;
  }
}

function lineObjectId(poLineId) {
  const s = String(poLineId || "").trim();
  if (!s || !mongoose.Types.ObjectId.isValid(s)) {
    throw new PoReceiptClaimError("PO line id is required to claim receipt qty", 400, "PO_LINE_REQUIRED");
  }
  return new mongoose.Types.ObjectId(s);
}

export function receiptClaimCapBeforeInc({ orderedQty = 0, cancelledQty = 0, qty = 0 } = {}) {
  const ordered = roundAsnQty(orderedQty);
  const cancelled = roundAsnQty(cancelledQty);
  const q = roundAsnQty(qty);
  return roundAsnQty(ordered - cancelled - q);
}

/**
 * In-memory model of the Mongo $elemMatch + $inc predicate.
 * Used to prove two concurrent 30-vs-30 claims against remaining 30 yield one winner.
 */
export function tryClaimReceivedQtyInMemory(line, qty) {
  const q = roundAsnQty(qty);
  const cap = receiptClaimCapBeforeInc({
    orderedQty: line.orderedQty ?? line.qty,
    cancelledQty: line.cancelledQty,
    qty: q,
  });
  const current = roundAsnQty(line.receivedQty);
  if (current - cap > ASN_QTY_EPS) return { ok: false, line };
  return {
    ok: true,
    line: {
      ...line,
      receivedQty: roundAsnQty(current + q),
      pendingQty: Math.max(
        0,
        roundAsnQty((Number(line.orderedQty ?? line.qty) || 0) - (current + q) - (Number(line.cancelledQty) || 0))
      ),
    },
  };
}

export async function claimPoLineReceivedQty({
  companyId,
  poId,
  poLineId,
  qty,
  orderedQty,
  cancelledQty = 0,
  session = null,
} = {}) {
  const q = roundAsnQty(qty);
  if (!(q > 0)) return null;
  const cap = receiptClaimCapBeforeInc({ orderedQty, cancelledQty, qty: q });
  const lineOid = lineObjectId(poLineId);
  const opts = { new: true };
  if (session) opts.session = session;
  const updated = await PurchaseOrder.findOneAndUpdate(
    {
      _id: poId,
      companyId,
      lines: {
        $elemMatch: {
          _id: lineOid,
          receivedQty: { $lte: cap + ASN_QTY_EPS },
        },
      },
    },
    { $inc: { "lines.$.receivedQty": q } },
    opts
  );
  if (!updated) {
    throw new PoReceiptClaimError(
      "PO line remaining quantity was claimed by another receipt",
      409,
      PO_RECEIPT_QTY_EXCEEDED
    );
  }
  return updated;
}

export async function releasePoLineReceivedQty({
  companyId,
  poId,
  poLineId,
  qty,
  session = null,
} = {}) {
  const q = roundAsnQty(qty);
  if (!(q > 0)) return null;
  const lineOid = lineObjectId(poLineId);
  const opts = { new: true };
  if (session) opts.session = session;
  return PurchaseOrder.findOneAndUpdate(
    { _id: poId, companyId, "lines._id": lineOid },
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
                        receivedQty: {
                          $max: [0, { $subtract: [{ $ifNull: ["$$ln.receivedQty", 0] }, q] }],
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
    opts
  );
}

export function recalcPoLinePending(poLine) {
  const ordered = Number(poLine.orderedQty ?? poLine.qty) || 0;
  const received = Number(poLine.receivedQty) || 0;
  const cancelled = Number(poLine.cancelledQty) || 0;
  poLine.pendingQty = Math.max(0, ordered - received - cancelled);
  poLine.qty = ordered;
  poLine.orderedQty = ordered;
  return poLine.pendingQty;
}

export function derivePoReceiptStatus(lines = []) {
  const snap = lines || [];
  if (!snap.length) return null;
  const pendingOf = (l) => {
    const ordered = Number(l.orderedQty ?? l.qty) || 0;
    const received = Number(l.receivedQty) || 0;
    const cancelled = Number(l.cancelledQty) || 0;
    return Math.max(0, ordered - received - cancelled);
  };
  const allReceived = snap.every((l) => pendingOf(l) <= 0);
  const anyReceived = snap.some((l) => (Number(l.receivedQty) || 0) > 0);
  if (allReceived) return "RECEIVED";
  if (anyReceived) return "PARTIAL_RECEIVED";
  return "SENT";
}
