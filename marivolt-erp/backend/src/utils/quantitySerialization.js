/**
 * S3 — Cross-document quantity serialization.
 *
 * Claims consume remaining qty on source lines inside a MongoDB transaction.
 * On abort the claim write rolls back (no abandoned claims / no cleanup).
 *
 * Packing owner: OrderAllocation line (qty vs packedQty)
 * Dispatch owner: StorePacking line (packQty vs dispatchedQty)
 *
 * Does not redesign stock movement, ledger keys, or balance buckets.
 */
import mongoose from "mongoose";

export const QUANTITY_CLAIM_EXHAUSTED = "QUANTITY_CLAIM_EXHAUSTED";
export const QUANTITY_RELEASE_CONFLICT = "QUANTITY_RELEASE_CONFLICT";

export const QTY_EPS = 1e-9;

export function quantityClaimError(code, message, details = null, statusCode = 409) {
  const err = new Error(message);
  err.code = code;
  err.statusCode = statusCode;
  err.details = details;
  return err;
}

export function remainingQty(maxQty, claimedQty) {
  return Math.max(0, (Number(maxQty) || 0) - (Number(claimedQty) || 0));
}

function asOid(id) {
  if (id instanceof mongoose.Types.ObjectId) return id;
  return new mongoose.Types.ObjectId(String(id));
}

/**
 * Pure atomic claim simulation (unit / concurrency tests).
 * Mutates `line[field]` only when remaining allows.
 */
export function tryClaimLineQty(line, field, qty, maxQty, eps = QTY_EPS) {
  const q = Number(qty) || 0;
  if (!(q > eps)) return { ok: false, reason: "INVALID_QTY" };
  const cur = Number(line[field]) || 0;
  const max = Number(maxQty) || 0;
  if (cur + q > max + eps) {
    return { ok: false, reason: QUANTITY_CLAIM_EXHAUSTED, remaining: remainingQty(max, cur) };
  }
  line[field] = cur + q;
  return { ok: true, claimed: line[field], remaining: remainingQty(max, line[field]) };
}

export function tryReleaseLineQty(line, field, qty, eps = QTY_EPS) {
  const q = Number(qty) || 0;
  if (!(q > eps)) return { ok: false, reason: "INVALID_QTY" };
  const cur = Number(line[field]) || 0;
  if (cur + eps < q) return { ok: false, reason: QUANTITY_RELEASE_CONFLICT, claimed: cur };
  line[field] = Math.max(0, cur - q);
  return { ok: true, claimed: line[field] };
}

/**
 * Simulate concurrent claimants serialized by a mutex (Mongo txn write-conflict
 * on the same parent document behaves similarly).
 */
export async function raceSerializedClaims({ maxQty, field = "packedQty", claimQtys }) {
  const line = { [field]: 0 };
  let gate = Promise.resolve();
  const results = new Array(claimQtys.length);
  await Promise.all(
    claimQtys.map((qty, i) => {
      const job = gate.then(() => {
        results[i] = tryClaimLineQty(line, field, qty, maxQty);
        return results[i];
      });
      gate = job.then(
        () => undefined,
        () => undefined
      );
      return job;
    })
  );
  return { line, results };
}

/** Ensure subdocument counter field exists (legacy rows) before conditional $inc. */
async function ensureLineCounter(Model, session, { parentId, companyId, lineId, field }) {
  await Model.updateOne(
    {
      _id: parentId,
      ...(companyId ? { companyId } : {}),
      lines: { $elemMatch: { _id: asOid(lineId), [field]: { $exists: false } } },
    },
    { $set: { [`lines.$.${field}`]: 0 } },
    { session }
  );
}

/**
 * Raise counter to at least `floor` when behind posted-effect sums (legacy sync).
 * Never lowers the counter (would free qty incorrectly).
 */
export async function ensureLineCounterFloor(
  Model,
  session,
  { parentId, companyId, lineId, field, floor }
) {
  const f = Math.max(0, Number(floor) || 0);
  await ensureLineCounter(Model, session, { parentId, companyId, lineId, field });
  if (!(f > 0)) return;
  await Model.updateOne(
    {
      _id: parentId,
      ...(companyId ? { companyId } : {}),
      lines: {
        $elemMatch: {
          _id: asOid(lineId),
          $or: [{ [field]: { $lt: f - QTY_EPS } }, { [field]: null }],
        },
      },
    },
    { $set: { [`lines.$.${field}`]: f } },
    { session }
  );
}

/**
 * Atomically claim pack qty against an allocation line.
 * Condition: packedQty + packQty <= allocatedQty
 */
export async function claimAllocationLinePackQty(
  OrderAllocation,
  session,
  { companyId, allocationId, allocationLineId, packQty, allocatedQty, postedFloor = 0 }
) {
  const q = Number(packQty) || 0;
  const max = Number(allocatedQty) || 0;
  if (!(q > 0)) {
    throw quantityClaimError(QUANTITY_CLAIM_EXHAUSTED, "Invalid pack qty for claim", null, 400);
  }
  await ensureLineCounterFloor(OrderAllocation, session, {
    parentId: allocationId,
    companyId,
    lineId: allocationLineId,
    field: "packedQty",
    floor: postedFloor,
  });
  const cap = max - q;
  const updated = await OrderAllocation.findOneAndUpdate(
    {
      _id: allocationId,
      companyId,
      lines: {
        $elemMatch: {
          _id: asOid(allocationLineId),
          packedQty: { $lte: cap + QTY_EPS },
        },
      },
    },
    { $inc: { "lines.$.packedQty": q } },
    { new: true, session }
  );
  if (!updated) {
    throw quantityClaimError(
      QUANTITY_CLAIM_EXHAUSTED,
      "Pack qty exceeds remaining allocation line quantity (concurrent claim)",
      {
        allocationId: String(allocationId),
        allocationLineId: String(allocationLineId),
        packQty: q,
        allocatedQty: max,
      }
    );
  }
  return updated;
}

/**
 * Release pack claim. Clamps at 0 so legacy rows with under-synced counters still cancel.
 */
export async function releaseAllocationLinePackQty(
  OrderAllocation,
  session,
  { companyId, allocationId, allocationLineId, packQty, postedFloor = 0 }
) {
  const q = Number(packQty) || 0;
  if (!(q > 0)) return null;
  await ensureLineCounterFloor(OrderAllocation, session, {
    parentId: allocationId,
    companyId,
    lineId: allocationLineId,
    field: "packedQty",
    floor: postedFloor,
  });
  const lineOid = asOid(allocationLineId);
  const updated = await OrderAllocation.findOneAndUpdate(
    { _id: allocationId, companyId, "lines._id": lineOid },
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
                        packedQty: {
                          $max: [0, { $subtract: [{ $ifNull: ["$$ln.packedQty", 0] }, q] }],
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
    { new: true, session }
  );
  return updated;
}

/**
 * Atomically claim dispatch qty against a packing line.
 * Condition: dispatchedQty + dispatchQty <= packQty
 */
export async function claimPackingLineDispatchQty(
  StorePacking,
  session,
  { companyId, packingId, packingLineId, dispatchQty, packQty, postedFloor = 0 }
) {
  const q = Number(dispatchQty) || 0;
  const max = Number(packQty) || 0;
  if (!(q > 0)) {
    throw quantityClaimError(QUANTITY_CLAIM_EXHAUSTED, "Invalid dispatch qty for claim", null, 400);
  }
  await ensureLineCounterFloor(StorePacking, session, {
    parentId: packingId,
    companyId,
    lineId: packingLineId,
    field: "dispatchedQty",
    floor: postedFloor,
  });
  const cap = max - q;
  const updated = await StorePacking.findOneAndUpdate(
    {
      _id: packingId,
      companyId,
      lines: {
        $elemMatch: {
          _id: asOid(packingLineId),
          dispatchedQty: { $lte: cap + QTY_EPS },
        },
      },
    },
    { $inc: { "lines.$.dispatchedQty": q } },
    { new: true, session }
  );
  if (!updated) {
    throw quantityClaimError(
      QUANTITY_CLAIM_EXHAUSTED,
      "Dispatch qty exceeds remaining packing line quantity (concurrent claim)",
      {
        packingId: String(packingId),
        packingLineId: String(packingLineId),
        dispatchQty: q,
        packQty: max,
      }
    );
  }
  return updated;
}

export async function releasePackingLineDispatchQty(
  StorePacking,
  session,
  { companyId, packingId, packingLineId, dispatchQty, postedFloor = 0 }
) {
  const q = Number(dispatchQty) || 0;
  if (!(q > 0)) return null;
  await ensureLineCounterFloor(StorePacking, session, {
    parentId: packingId,
    companyId,
    lineId: packingLineId,
    field: "dispatchedQty",
    floor: postedFloor,
  });
  const lineOid = asOid(packingLineId);
  const updated = await StorePacking.findOneAndUpdate(
    { _id: packingId, companyId, "lines._id": lineOid },
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
                        dispatchedQty: {
                          $max: [0, { $subtract: [{ $ifNull: ["$$ln.dispatchedQty", 0] }, q] }],
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
    { new: true, session }
  );
  return updated;
}
