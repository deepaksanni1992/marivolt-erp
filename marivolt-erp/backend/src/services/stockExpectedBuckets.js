/**
 * Canonical expected reserved / packed from live business documents.
 * All integrity scanners MUST use these helpers — no duplicated formulas.
 */
import OrderAllocation from "../models/OrderAllocation.js";
import StorePacking from "../models/StorePacking.js";

const EPS = 1e-6;

function n(v) {
  return Number(v) || 0;
}
function up(v) {
  return String(v ?? "").trim().toUpperCase();
}

/** Allocation statuses that may still hold reservation (qty − packedQty). */
export const ALLOCATION_STATUSES_HOLDING_RESERVED = Object.freeze([
  "OPEN",
  "PARTIALLY_PACKED",
  "FULLY_PACKED",
  "APPROVED",
  "CLOSED",
]);

/**
 * Remaining reservation for one allocation line.
 * Never double-counts packed qty (moved to packed bucket on packing post).
 */
export function allocationLineRemainingReserved(line = {}) {
  return Math.max(0, n(line.qty) - n(line.packedQty));
}

/**
 * Whether a document status should be scanned for expected reserved.
 * CANCELLED/REVERSED never contribute.
 */
export function allocationStatusHoldsReservation(status) {
  const st = up(status);
  if (!st || st === "CANCELLED" || st === "REVERSED") return false;
  return ALLOCATION_STATUSES_HOLDING_RESERVED.includes(st);
}

/** Packing statuses that hold packed staging before dispatch/cancel. */
export const PACKING_STATUSES_HOLDING_PACKED = Object.freeze([
  "POSTED",
  "PARTIALLY_PACKED",
  "FULLY_PACKED",
  "POSTING",
]);

/**
 * Pure: sum remaining reservation from allocation documents.
 * Holding statuses include OPEN / PARTIALLY_PACKED / FULLY_PACKED / APPROVED / CLOSED.
 * CANCELLED / REVERSED never contribute.
 * Remaining = max(0, qty − packedQty), optionally refined by packing-doc claims.
 *
 * @param {object[]} allocations
 * @param {object} [opts]
 * @param {string} [opts.article] filter one article
 * @param {Map<string, number>} [opts.packingClaimByAllocArticle] key `${companyId}|${allocationNo}|${article}`
 */
export function computeExpectedReservedFromAllocations(allocations = [], opts = {}) {
  const artFilter = opts.article ? up(opts.article) : null;
  const packingClaims = opts.packingClaimByAllocArticle || null;
  let expectedReservedQty = 0;
  const documents = [];

  for (const a of allocations) {
    const st = up(a.status);
    if (!st || st === "CANCELLED" || st === "REVERSED") continue;
    if (!ALLOCATION_STATUSES_HOLDING_RESERVED.includes(st)) continue;

    for (const ln of a.lines || []) {
      const art = up(ln.article);
      if (!art) continue;
      if (artFilter && art !== artFilter) continue;

      let hold = allocationLineRemainingReserved(ln);
      if (packingClaims) {
        const packClaimKey = `${String(a.companyId)}|${up(a.allocationNo)}|${art}`;
        const packedFromDocs = packingClaims.get(packClaimKey) || 0;
        if (packedFromDocs > n(ln.packedQty)) {
          hold = Math.max(0, n(ln.qty) - packedFromDocs);
        }
      }
      if (hold <= EPS) continue;
      expectedReservedQty += hold;
      documents.push({
        type: "OrderAllocation",
        id: a._id != null ? String(a._id) : "",
        number: a.allocationNo || "",
        qty: hold,
        status: a.status,
        warehouse: up(a.warehouse) || "MAIN",
        article: art,
        companyId: a.companyId != null ? String(a.companyId) : "",
        customerName: a.customerName || "",
      });
    }
  }

  return { expectedReservedQty, documents };
}

/**
 * Pure: sum packing remaining = max(0, packQty − dispatchedQty) per line.
 */
export function computeExpectedPackedFromPackings(packings = [], opts = {}) {
  const artFilter = opts.article ? up(opts.article) : null;
  let expectedPackedQty = 0;
  const documents = [];

  for (const p of packings) {
    const st = up(p.status);
    if (st === "CANCELLED" || st === "CANCELLING" || st === "DRAFT") continue;
    if (!PACKING_STATUSES_HOLDING_PACKED.includes(st)) continue;

    for (const ln of p.lines || []) {
      const art = up(ln.article);
      if (!art) continue;
      if (artFilter && art !== artFilter) continue;
      const q = Math.max(0, n(ln.packQty) - n(ln.dispatchedQty));
      if (q <= EPS) continue;
      expectedPackedQty += q;
      documents.push({
        type: "StorePacking",
        id: p._id != null ? String(p._id) : "",
        number: p.packingNo || "",
        qty: q,
        status: p.status,
        warehouse: up(p.warehouse) || "MAIN",
        article: art,
        companyId: p.companyId != null ? String(p.companyId) : "",
        allocationNo: p.allocationNo || "",
      });
    }
  }

  return { expectedPackedQty, documents };
}

/**
 * calculateExpectedReserved — canonical async API (single article/warehouse).
 * ALL systems must call this (or computeExpectedReservedFromAllocations) — no duplicates.
 */
export async function calculateExpectedReserved(companyId, warehouse, article) {
  const code = up(article);
  const wh = up(warehouse) || "MAIN";
  if (!companyId || !code) {
    throw new Error("calculateExpectedReserved: companyId and article required");
  }

  const allocations = await OrderAllocation.find({
    companyId,
    warehouse: wh,
    status: { $in: [...ALLOCATION_STATUSES_HOLDING_RESERVED] },
    "lines.article": code,
  })
    .select("_id allocationNo status customerName lines warehouse companyId")
    .lean();

  const { expectedReservedQty, documents } = computeExpectedReservedFromAllocations(allocations, {
    article: code,
  });

  return {
    companyId: String(companyId),
    warehouse: wh,
    article: code,
    expectedReservedQty,
    documents,
  };
}

/** Alias kept for callers that used the longer name. */
export const calculateExpectedReservation = calculateExpectedReserved;

export async function calculateExpectedPacked(companyId, warehouse, article) {
  const code = up(article);
  const wh = up(warehouse) || "MAIN";
  if (!companyId || !code) {
    throw new Error("calculateExpectedPacked: companyId and article required");
  }

  const packings = await StorePacking.find({
    companyId,
    warehouse: wh,
    status: { $in: [...PACKING_STATUSES_HOLDING_PACKED] },
    "lines.article": code,
  })
    .select("_id packingNo status lines warehouse allocationNo companyId")
    .lean();

  const { expectedPackedQty, documents } = computeExpectedPackedFromPackings(packings, {
    article: code,
  });

  return {
    companyId: String(companyId),
    warehouse: wh,
    article: code,
    expectedPackedQty,
    documents,
  };
}

/**
 * Canonical free-stock derivation — NEVER trust persisted availableQty.
 * reserved = max(allocatedQty, reservedQty) for legacy dual-field compatibility.
 * Does not clamp negatives (allowNegative allocations may produce negative free stock).
 */
export function deriveAvailableQty({
  onHandQty,
  quantity,
  reservedQty,
  allocatedQty,
  packedQty,
} = {}) {
  const onHand = Number(onHandQty ?? quantity ?? 0) || 0;
  const reserved = Math.max(Number(allocatedQty) || 0, Number(reservedQty) || 0);
  const packed = Number(packedQty) || 0;
  return onHand - reserved - packed;
}

/**
 * Normalize a StockBalance-shaped row to live bucket fields + derived available.
 */
export function deriveStockBuckets(row = {}) {
  const onHandQty = Number(row?.onHandQty ?? row?.quantity ?? 0) || 0;
  const reservedQty = Math.max(Number(row?.allocatedQty) || 0, Number(row?.reservedQty) || 0);
  const packedQty = Number(row?.packedQty) || 0;
  const availableQty = deriveAvailableQty({
    onHandQty,
    reservedQty,
    allocatedQty: reservedQty,
    packedQty,
  });
  return {
    onHandQty,
    reservedQty,
    allocatedQty: reservedQty,
    packedQty,
    availableQty,
    isNegativeAvailable: availableQty < 0,
  };
}

/**
 * Mongo aggregation expression matching deriveAvailableQty() exactly.
 * Null/missing bucket fields are treated as 0.
 *
 * derived = ifNull(onHandQty, quantity, 0)
 *         − max(ifNull(allocatedQty,0), ifNull(reservedQty,0))
 *         − ifNull(packedQty, 0)
 */
export function buildDerivedAvailableExpression({
  onHandField = "$onHandQty",
  quantityField = "$quantity",
  allocatedField = "$allocatedQty",
  reservedField = "$reservedQty",
  packedField = "$packedQty",
} = {}) {
  return {
    $subtract: [
      { $ifNull: [onHandField, { $ifNull: [quantityField, 0] }] },
      {
        $add: [
          {
            $max: [{ $ifNull: [allocatedField, 0] }, { $ifNull: [reservedField, 0] }],
          },
          { $ifNull: [packedField, 0] },
        ],
      },
    ],
  };
}

/**
 * $match stage: derived availability strictly less than -eps (true negative free stock).
 */
export function buildDerivedAvailableNegativeMatch(eps = 1e-6) {
  return {
    $expr: {
      $lt: [buildDerivedAvailableExpression(), -Math.abs(Number(eps) || 0)],
    },
  };
}

/**
 * Immutable physical stock effectKey.
 * Format: phys:{MOVEMENT}:{companyId}:{referenceNo}:{article}:{warehouse}[:lineId][:batch][:serial][:dir][:qty]
 */
export function buildPhysicalEffectKey({
  movementType,
  companyId,
  referenceNo = "",
  article,
  warehouse = "MAIN",
  lineId = "",
  batchNo = "",
  serialNo = "",
  direction = "",
  qty = "",
  extra = "",
}) {
  const parts = [
    "phys",
    up(movementType) || "STOCK_ADJUSTMENT",
    String(companyId || ""),
    up(referenceNo) || "NOREF",
    up(article),
    up(warehouse) || "MAIN",
  ];
  if (lineId) parts.push(String(lineId));
  if (batchNo) parts.push(up(batchNo));
  if (serialNo) parts.push(up(serialNo));
  if (direction) parts.push(up(direction));
  if (qty !== "" && qty != null) parts.push(String(Number(qty) || 0));
  if (extra) parts.push(String(extra));
  return parts.join(":");
}

export default {
  calculateExpectedReserved,
  calculateExpectedReservation,
  calculateExpectedPacked,
  computeExpectedReservedFromAllocations,
  computeExpectedPackedFromPackings,
  buildPhysicalEffectKey,
  deriveAvailableQty,
  deriveStockBuckets,
  buildDerivedAvailableExpression,
  buildDerivedAvailableNegativeMatch,
  ALLOCATION_STATUSES_HOLDING_RESERVED,
  allocationLineRemainingReserved,
  allocationStatusHoldsReservation,
  PACKING_STATUSES_HOLDING_PACKED,
};
