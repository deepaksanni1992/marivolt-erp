/**
 * Reservation Integrity Engine — permanent ERP capability.
 *
 * Canonical rules (never trust StockBalance buckets blindly):
 *   Expected Reserved = Σ active OrderAllocation remaining (qty − packedQty)
 *   Expected Packed   = Σ active Packing remaining (packQty − dispatchedQty)
 *   Expected Available = OnHand − ExpectedReserved − ExpectedPacked
 *
 * Packed qty is never double-counted: once moved to packing (line.packedQty),
 * it leaves the allocation remaining hold.
 */
import crypto from "crypto";
import mongoose from "mongoose";
import Company from "../models/Company.js";
import StockBalance from "../models/StockBalance.js";
import OrderAllocation from "../models/OrderAllocation.js";
import StorePacking from "../models/StorePacking.js";
import StoreDispatch from "../models/StoreDispatch.js";
import ReservationIntegrityIssue from "../models/ReservationIntegrityIssue.js";
import {
  ALLOCATION_STATUSES_HOLDING_RESERVED,
  allocationLineRemainingReserved,
  PACKING_STATUSES_HOLDING_PACKED,
} from "./stockBucketIntegrityService.js";

const EPS = 1e-6;

/** Mirrors dataHealthService.INTEGRITY_SCORE_WEIGHTS (avoid circular import). */
const SCORE_WEIGHTS = Object.freeze({ Critical: 15, Major: 5, Minor: 1, Info: 0 });

/**
 * Allocation statuses that may hold remaining reservation in Marivolt.
 * Excluded (do not exist as holds): CANCELLED.
 * Note: CLOSED is retained — remaining (qty−packedQty) can still be > 0 until fully packed.
 * REVERSED is not in the OrderAllocation enum but is treated as non-holding defensively.
 */
export const RESERVATION_HOLDING_ALLOCATION_STATUSES = ALLOCATION_STATUSES_HOLDING_RESERVED;

/**
 * Packing statuses that may hold packed staging.
 * Excluded: DRAFT, CANCELLED, CANCELLING (terminal / ephemeral cancel).
 * Remaining = packQty − dispatchedQty (fully dispatched → 0).
 */
export const RESERVATION_HOLDING_PACKING_STATUSES = PACKING_STATUSES_HOLDING_PACKED;

async function invalidateHealthCache(companyId) {
  try {
    const { invalidateDataHealthCache } = await import("./dataHealthService.js");
    invalidateDataHealthCache(companyId);
  } catch {
    /* optional */
  }
}

export const RESERVATION_INTEGRITY_ISSUE_TYPES = Object.freeze({
  ORPHAN_RESERVED_QTY: "ORPHAN_RESERVED_QTY",
  RESERVED_QTY_MISMATCH: "RESERVED_QTY_MISMATCH",
  PACKED_QTY_MISMATCH: "PACKED_QTY_MISMATCH",
  AVAILABLE_QTY_MISMATCH: "AVAILABLE_QTY_MISMATCH",
  NEGATIVE_RESERVED: "NEGATIVE_RESERVED",
  NEGATIVE_PACKED: "NEGATIVE_PACKED",
  ALLOCATED_WITHOUT_DOCUMENT: "ALLOCATED_WITHOUT_DOCUMENT",
  PACKED_WITHOUT_DOCUMENT: "PACKED_WITHOUT_DOCUMENT",
});

function n(v) {
  return Number(v) || 0;
}
function up(v) {
  return String(v ?? "").trim().toUpperCase();
}
function s(v) {
  return String(v ?? "").trim();
}

function healthImpactFor(severity) {
  return SCORE_WEIGHTS[severity] || 0;
}

function severityForIssue(issueType, difference) {
  const abs = Math.abs(n(difference));
  if (
    issueType === RESERVATION_INTEGRITY_ISSUE_TYPES.NEGATIVE_RESERVED ||
    issueType === RESERVATION_INTEGRITY_ISSUE_TYPES.NEGATIVE_PACKED
  ) {
    return "Critical";
  }
  if (
    issueType === RESERVATION_INTEGRITY_ISSUE_TYPES.ORPHAN_RESERVED_QTY ||
    issueType === RESERVATION_INTEGRITY_ISSUE_TYPES.ALLOCATED_WITHOUT_DOCUMENT ||
    issueType === RESERVATION_INTEGRITY_ISSUE_TYPES.PACKED_WITHOUT_DOCUMENT
  ) {
    return abs >= 9 ? "Critical" : "Major";
  }
  if (
    issueType === RESERVATION_INTEGRITY_ISSUE_TYPES.RESERVED_QTY_MISMATCH ||
    issueType === RESERVATION_INTEGRITY_ISSUE_TYPES.PACKED_QTY_MISMATCH
  ) {
    return abs >= 9 ? "Critical" : "Major";
  }
  return abs >= 9 ? "Major" : "Minor";
}

function repairRecommendationFor(issueType) {
  switch (issueType) {
    case RESERVATION_INTEGRITY_ISSUE_TYPES.ORPHAN_RESERVED_QTY:
    case RESERVATION_INTEGRITY_ISSUE_TYPES.ALLOCATED_WITHOUT_DOCUMENT:
      return "Dry-run then apply repairReservationIntegrity (ALLOCATION_CANCEL compensating ledger). Do not recreate deleted documents.";
    case RESERVATION_INTEGRITY_ISSUE_TYPES.PACKED_WITHOUT_DOCUMENT:
    case RESERVATION_INTEGRITY_ISSUE_TYPES.PACKED_QTY_MISMATCH:
      return "Investigate packing / dispatch documents; diagnose only — automatic packed repair is out of scope.";
    case RESERVATION_INTEGRITY_ISSUE_TYPES.RESERVED_QTY_MISMATCH:
      return "Investigate live allocations; automatic repair only when orphan (expected reserved = 0) and provenance is unique.";
    case RESERVATION_INTEGRITY_ISSUE_TYPES.AVAILABLE_QTY_MISMATCH:
      return "Recalculate availableQty = onHand − reserved − packed after reserved/packed buckets are correct.";
    case RESERVATION_INTEGRITY_ISSUE_TYPES.NEGATIVE_RESERVED:
    case RESERVATION_INTEGRITY_ISSUE_TYPES.NEGATIVE_PACKED:
      return "Investigate ledger and live documents immediately — negative buckets are Critical integrity defects.";
    default:
      return "Review Reservation Integrity screen and run Validate All Stock.";
  }
}

function fingerprintOf({ companyId, warehouse, article, issueType }) {
  return crypto
    .createHash("sha1")
    .update(`${companyId}|${up(warehouse)}|${up(article)}|${issueType}`)
    .digest("hex");
}

function balanceKey(companyId, warehouse, article) {
  return `${String(companyId)}|${up(warehouse) || "MAIN"}|${up(article)}`;
}

function toObjectId(id) {
  if (!id) return null;
  if (id instanceof mongoose.Types.ObjectId) return id;
  try {
    return new mongoose.Types.ObjectId(String(id));
  } catch {
    return null;
  }
}

/**
 * Expected reserved from live OrderAllocation documents only.
 */
export async function calculateExpectedReservation(companyId, warehouse, article) {
  const code = up(article);
  const wh = up(warehouse) || "MAIN";
  if (!companyId || !code) {
    throw new Error("calculateExpectedReservation: companyId and article required");
  }

  const allocations = await OrderAllocation.find({
    companyId,
    warehouse: wh,
    status: { $in: [...RESERVATION_HOLDING_ALLOCATION_STATUSES] },
    "lines.article": code,
  })
    .select("_id allocationNo status customerName lines warehouse")
    .lean();

  let expectedReservedQty = 0;
  const documents = [];
  for (const a of allocations) {
    const st = up(a.status);
    if (st === "CANCELLED" || st === "REVERSED") continue;
    if (!RESERVATION_HOLDING_ALLOCATION_STATUSES.includes(st)) continue;
    for (const ln of a.lines || []) {
      if (up(ln.article) !== code) continue;
      const hold = allocationLineRemainingReserved(ln);
      if (hold <= EPS) continue;
      expectedReservedQty += hold;
      documents.push({
        type: "OrderAllocation",
        id: String(a._id),
        number: a.allocationNo || "",
        qty: hold,
        status: a.status,
        customerName: a.customerName || "",
      });
    }
  }

  return {
    companyId: String(companyId),
    warehouse: wh,
    article: code,
    expectedReservedQty,
    documents,
  };
}

/**
 * Expected packed from live StorePacking documents only.
 */
export async function calculateExpectedPacked(companyId, warehouse, article) {
  const code = up(article);
  const wh = up(warehouse) || "MAIN";
  if (!companyId || !code) {
    throw new Error("calculateExpectedPacked: companyId and article required");
  }

  const packings = await StorePacking.find({
    companyId,
    warehouse: wh,
    status: { $in: [...RESERVATION_HOLDING_PACKING_STATUSES] },
    "lines.article": code,
  })
    .select("_id packingNo status lines warehouse allocationNo")
    .lean();

  let expectedPackedQty = 0;
  const documents = [];
  for (const p of packings) {
    const st = up(p.status);
    if (st === "CANCELLED" || st === "CANCELLING" || st === "DRAFT") continue;
    let q = 0;
    for (const ln of p.lines || []) {
      if (up(ln.article) !== code) continue;
      q += Math.max(0, n(ln.packQty) - n(ln.dispatchedQty));
    }
    if (q <= EPS) continue;
    expectedPackedQty += q;
    documents.push({
      type: "StorePacking",
      id: String(p._id),
      number: p.packingNo || "",
      qty: q,
      status: p.status,
      allocationNo: p.allocationNo || "",
    });
  }

  return {
    companyId: String(companyId),
    warehouse: wh,
    article: code,
    expectedPackedQty,
    documents,
  };
}

/**
 * Canonical available from physical on-hand + document-derived buckets.
 */
export async function calculateAvailable(companyId, warehouse, article) {
  const code = up(article);
  const wh = up(warehouse) || "MAIN";

  const balance = await StockBalance.findOne({
    companyId,
    $or: [
      { article: code, location: wh },
      { article: code, warehouse: wh },
      { itemCode: code, warehouse: wh },
      { itemCode: code, location: wh },
    ],
  }).lean();

  const onHandQty = n(balance?.onHandQty ?? balance?.quantity);
  const [reserved, packed] = await Promise.all([
    calculateExpectedReservation(companyId, wh, code),
    calculateExpectedPacked(companyId, wh, code),
  ]);

  const expectedAvailableQty =
    onHandQty - reserved.expectedReservedQty - packed.expectedPackedQty;

  return {
    companyId: String(companyId),
    warehouse: wh,
    article: code,
    stockBalanceId: balance?._id ? String(balance._id) : null,
    onHandQty,
    expectedReservedQty: reserved.expectedReservedQty,
    expectedPackedQty: packed.expectedPackedQty,
    expectedAvailableQty,
    allocationDocuments: reserved.documents,
    packingDocuments: packed.documents,
    balance,
  };
}

/**
 * Pure issue classifier with deterministic precedence (no DB).
 *
 * Precedence / dedupe (at most one scored root-cause family per article):
 *  1. NEGATIVE_RESERVED / NEGATIVE_PACKED
 *  2. ORPHAN_RESERVED_QTY | PACKED_WITHOUT_DOCUMENT  (source-document orphans)
 *  3. RESERVED_QTY_MISMATCH | PACKED_QTY_MISMATCH
 *  4. AVAILABLE_QTY_MISMATCH only when reserved+packed match expected
 *     (i.e. stored available is independently wrong)
 *
 * Never emit both ORPHAN_RESERVED_QTY and RESERVED_QTY_MISMATCH.
 * Never emit AVAILABLE_QTY_MISMATCH when a reserved/packed mismatch already exists.
 */
export function buildIssuesFromSnapshot(snap, companyCode = "") {
  const issues = [];
  const bal = snap.balance;
  const onHandQty = snap.onHandQty;
  const rawAllocated = n(bal?.allocatedQty);
  const rawReserved = n(bal?.reservedQty);
  const storedReserved = Math.max(rawAllocated, rawReserved);
  const storedPacked = n(bal?.packedQty);
  const derivedFromStoredBuckets = onHandQty - storedReserved - storedPacked;
  const storedAvailable =
    bal?.availableQty != null ? n(bal.availableQty) : derivedFromStoredBuckets;

  const expectedReserved = n(snap.expectedReservedQty);
  const expectedPacked = n(snap.expectedPackedQty);
  const expectedAvailable = n(snap.expectedAvailableQty);

  const base = {
    companyId: snap.companyId,
    companyCode: companyCode || "",
    warehouse: snap.warehouse,
    article: snap.article,
    stockBalanceId: snap.stockBalanceId || "",
    onHandQty,
    reservedQty: storedReserved,
    expectedReservedQty: expectedReserved,
    packedQty: storedPacked,
    expectedPackedQty: expectedPacked,
    availableQty: storedAvailable,
    expectedAvailableQty: expectedAvailable,
  };

  const push = (issueType, expected, actual, documentReferences, extraMeta = {}) => {
    const difference = actual - expected;
    if (
      Math.abs(difference) <= EPS &&
      issueType !== RESERVATION_INTEGRITY_ISSUE_TYPES.NEGATIVE_RESERVED &&
      issueType !== RESERVATION_INTEGRITY_ISSUE_TYPES.NEGATIVE_PACKED
    ) {
      return;
    }
    if (
      (issueType === RESERVATION_INTEGRITY_ISSUE_TYPES.NEGATIVE_RESERVED ||
        issueType === RESERVATION_INTEGRITY_ISSUE_TYPES.NEGATIVE_PACKED) &&
      actual >= -EPS
    ) {
      return;
    }
    const severity = severityForIssue(issueType, difference);
    issues.push({
      ...base,
      issueType,
      severity,
      expected,
      actual,
      difference,
      repairRecommendation: repairRecommendationFor(issueType),
      healthScoreImpact: healthImpactFor(severity),
      documentReferences,
      metadata: extraMeta,
      fingerprint: fingerprintOf({
        companyId: snap.companyId,
        warehouse: snap.warehouse,
        article: snap.article,
        issueType,
      }),
    });
  };

  // 1. Negatives — inspect raw bucket fields (Math.max would hide a lone negative)
  const negativeReservedActual = Math.min(rawAllocated, rawReserved, storedReserved);
  if (rawAllocated < -EPS || rawReserved < -EPS) {
    push(
      RESERVATION_INTEGRITY_ISSUE_TYPES.NEGATIVE_RESERVED,
      0,
      negativeReservedActual,
      snap.allocationDocuments || [],
      { rawAllocated, rawReserved }
    );
  }
  if (storedPacked < -EPS) {
    push(
      RESERVATION_INTEGRITY_ISSUE_TYPES.NEGATIVE_PACKED,
      0,
      storedPacked,
      snap.packingDocuments || []
    );
  }

  // 2–3. Reserved / packed (mutually exclusive orphan vs mismatch)
  const reservedDelta = storedReserved - expectedReserved;
  let hasReservedIssue = false;
  if (Math.abs(reservedDelta) > EPS) {
    hasReservedIssue = true;
    if (reservedDelta > EPS && expectedReserved <= EPS) {
      push(
        RESERVATION_INTEGRITY_ISSUE_TYPES.ORPHAN_RESERVED_QTY,
        expectedReserved,
        storedReserved,
        snap.allocationDocuments || [],
        { aliasType: "ALLOCATED_WITHOUT_DOCUMENT" }
      );
    } else {
      push(
        RESERVATION_INTEGRITY_ISSUE_TYPES.RESERVED_QTY_MISMATCH,
        expectedReserved,
        storedReserved,
        snap.allocationDocuments || []
      );
    }
  }

  const packedDelta = storedPacked - expectedPacked;
  let hasPackedIssue = false;
  if (Math.abs(packedDelta) > EPS) {
    hasPackedIssue = true;
    if (packedDelta > EPS && expectedPacked <= EPS) {
      push(
        RESERVATION_INTEGRITY_ISSUE_TYPES.PACKED_WITHOUT_DOCUMENT,
        expectedPacked,
        storedPacked,
        snap.packingDocuments || []
      );
    } else {
      push(
        RESERVATION_INTEGRITY_ISSUE_TYPES.PACKED_QTY_MISMATCH,
        expectedPacked,
        storedPacked,
        snap.packingDocuments || []
      );
    }
  }

  // 4. Available only when independently incorrect (not a cascade of reserved/packed)
  if (!hasReservedIssue && !hasPackedIssue) {
    const availableDelta = storedAvailable - expectedAvailable;
    if (Math.abs(availableDelta) > EPS) {
      push(
        RESERVATION_INTEGRITY_ISSUE_TYPES.AVAILABLE_QTY_MISMATCH,
        expectedAvailable,
        storedAvailable,
        [...(snap.allocationDocuments || []), ...(snap.packingDocuments || [])],
        {
          derivedFromStoredBuckets,
          note: "Reserved and packed match documents; stored available projection is independently wrong",
        }
      );
    }
  }

  return issues;
}

async function persistIssues({ companyId, warehouse, article, issues, scanId, checkedAt }) {
  const now = checkedAt || new Date();
  const wh = up(warehouse);
  const art = up(article);
  const openFingerprints = new Set(issues.map((i) => i.fingerprint));
  const cid = toObjectId(companyId) || companyId;

  const ops = issues.map((issue) => ({
    updateOne: {
      filter: {
        companyId: cid,
        warehouse: wh,
        article: art,
        issueType: issue.issueType,
      },
      update: {
        $set: {
          ...issue,
          companyId: cid,
          warehouse: wh,
          article: art,
          status: "OPEN",
          lastCheckedAt: now,
          resolvedAt: null,
          scanId: scanId || "",
          fingerprint: issue.fingerprint,
        },
      },
      upsert: true,
    },
  }));

  if (ops.length) {
    await ReservationIntegrityIssue.bulkWrite(ops, { ordered: false });
  }

  const resolveFilter = {
    companyId: cid,
    warehouse: wh,
    article: art,
    status: "OPEN",
  };
  if (openFingerprints.size) {
    resolveFilter.fingerprint = { $nin: [...openFingerprints] };
  }
  await ReservationIntegrityIssue.updateMany(resolveFilter, {
    $set: { status: "RESOLVED", resolvedAt: now, lastCheckedAt: now, scanId: scanId || "" },
  });
}

function rowFromSnap(snap, companyCode, issues, scanId, checkedAt) {
  const storedReserved = Math.max(n(snap.balance?.allocatedQty), n(snap.balance?.reservedQty));
  const storedPacked = n(snap.balance?.packedQty);
  const availableQty =
    snap.balance?.availableQty != null
      ? n(snap.balance.availableQty)
      : snap.onHandQty - storedReserved - storedPacked;
  return {
    ok: issues.length === 0,
    companyId: String(snap.companyId),
    companyCode,
    warehouse: snap.warehouse,
    article: snap.article,
    stockBalanceId: snap.stockBalanceId,
    onHandQty: snap.onHandQty,
    reservedQty: storedReserved,
    expectedReservedQty: snap.expectedReservedQty,
    packedQty: storedPacked,
    expectedPackedQty: snap.expectedPackedQty,
    availableQty,
    expectedAvailableQty: snap.expectedAvailableQty,
    differenceReserved: storedReserved - snap.expectedReservedQty,
    differencePacked: storedPacked - snap.expectedPackedQty,
    differenceAvailable: availableQty - snap.expectedAvailableQty,
    issues,
    allocationDocuments: snap.allocationDocuments,
    packingDocuments: snap.packingDocuments,
    lastCheckedAt: checkedAt,
    scanId,
    healthy: issues.length === 0,
  };
}

/**
 * Validate one StockBalance key against live documents.
 */
export async function validateStockBuckets(companyId, warehouse, article, opts = {}) {
  const code = up(article);
  const wh = up(warehouse) || "MAIN";
  const persist = opts.persist !== false;
  const company =
    opts.companyCode != null
      ? { code: opts.companyCode }
      : await Company.findById(companyId).select("code companyCode").lean();
  const companyCode = up(company?.code || company?.companyCode || opts.companyCode || "");

  const snap = await calculateAvailable(companyId, wh, code);
  const issues = buildIssuesFromSnapshot(snap, companyCode);
  const scanId = opts.scanId || `ri-${Date.now()}`;
  const checkedAt = new Date();

  if (persist) {
    await persistIssues({
      companyId,
      warehouse: wh,
      article: code,
      issues,
      scanId,
      checkedAt,
    });
  }

  return rowFromSnap(snap, companyCode, issues, scanId, checkedAt);
}

/**
 * Bulk expected maps — avoids N+1 per StockBalance row.
 * Query count ≈ 1 balances + 1 allocation agg + 1 packing agg (+ bulkWrite).
 */
async function loadExpectedBucketMaps({ companyIds, warehouse, article }) {
  const cidFilter =
    companyIds.length === 1
      ? toObjectId(companyIds[0])
      : { $in: companyIds.map((id) => toObjectId(id)).filter(Boolean) };
  const wh = warehouse ? up(warehouse) : null;
  const art = article ? up(article) : null;

  const allocMatch = {
    companyId: cidFilter,
    status: { $in: [...RESERVATION_HOLDING_ALLOCATION_STATUSES] },
  };
  if (wh) allocMatch.warehouse = wh;

  const packMatch = {
    companyId: cidFilter,
    status: { $in: [...RESERVATION_HOLDING_PACKING_STATUSES] },
  };
  if (wh) packMatch.warehouse = wh;

  const [reservedRows, packedRows] = await Promise.all([
    OrderAllocation.aggregate([
      { $match: allocMatch },
      { $unwind: "$lines" },
      ...(art ? [{ $match: { "lines.article": art } }] : []),
      {
        $project: {
          companyId: 1,
          warehouse: { $toUpper: { $ifNull: ["$warehouse", "MAIN"] } },
          article: { $toUpper: { $ifNull: ["$lines.article", ""] } },
          hold: {
            $max: [
              0,
              {
                $subtract: [
                  { $ifNull: ["$lines.qty", 0] },
                  { $ifNull: ["$lines.packedQty", 0] },
                ],
              },
            ],
          },
          allocationNo: 1,
          status: 1,
          _id: 1,
        },
      },
      { $match: { article: { $ne: "" }, hold: { $gt: 0 } } },
      {
        $group: {
          _id: {
            companyId: "$companyId",
            warehouse: "$warehouse",
            article: "$article",
          },
          expectedReservedQty: { $sum: "$hold" },
          documents: {
            $push: {
              type: "OrderAllocation",
              id: { $toString: "$_id" },
              number: "$allocationNo",
              qty: "$hold",
              status: "$status",
            },
          },
        },
      },
    ]),
    StorePacking.aggregate([
      { $match: packMatch },
      { $unwind: "$lines" },
      ...(art ? [{ $match: { "lines.article": art } }] : []),
      {
        $project: {
          companyId: 1,
          warehouse: { $toUpper: { $ifNull: ["$warehouse", "MAIN"] } },
          article: { $toUpper: { $ifNull: ["$lines.article", ""] } },
          hold: {
            $max: [
              0,
              {
                $subtract: [
                  { $ifNull: ["$lines.packQty", 0] },
                  { $ifNull: ["$lines.dispatchedQty", 0] },
                ],
              },
            ],
          },
          packingNo: 1,
          status: 1,
          allocationNo: 1,
          _id: 1,
        },
      },
      { $match: { article: { $ne: "" }, hold: { $gt: 0 } } },
      {
        $group: {
          _id: {
            companyId: "$companyId",
            warehouse: "$warehouse",
            article: "$article",
          },
          expectedPackedQty: { $sum: "$hold" },
          documents: {
            $push: {
              type: "StorePacking",
              id: { $toString: "$_id" },
              number: "$packingNo",
              qty: "$hold",
              status: "$status",
              allocationNo: "$allocationNo",
            },
          },
        },
      },
    ]),
  ]);

  const reservedMap = new Map();
  for (const row of reservedRows) {
    const key = balanceKey(row._id.companyId, row._id.warehouse, row._id.article);
    reservedMap.set(key, {
      expectedReservedQty: n(row.expectedReservedQty),
      documents: row.documents || [],
    });
  }
  const packedMap = new Map();
  for (const row of packedRows) {
    const key = balanceKey(row._id.companyId, row._id.warehouse, row._id.article);
    packedMap.set(key, {
      expectedPackedQty: n(row.expectedPackedQty),
      documents: row.documents || [],
    });
  }
  return { reservedMap, packedMap };
}

/**
 * Validate all StockBalance rows with bulk expected aggregations (no per-row N+1).
 */
export async function validateAllStock(opts = {}) {
  const scanId = opts.scanId || `ri-all-${Date.now()}`;
  const checkedAt = new Date();
  const filter = {};
  if (opts.companyId) filter.companyId = opts.companyId;
  if (opts.warehouse) {
    const wh = up(opts.warehouse);
    filter.$or = [{ location: wh }, { warehouse: wh }];
  }
  if (opts.article) {
    const art = up(opts.article);
    filter.$and = [
      ...(filter.$and || []),
      { $or: [{ article: art }, { itemCode: art }] },
    ];
  }

  const balances = await StockBalance.find(filter)
    .select(
      "_id companyId article itemCode location warehouse onHandQty quantity reservedQty allocatedQty packedQty availableQty"
    )
    .lean();

  const companies = await Company.find({}).select("_id code companyCode").lean();
  const companyById = new Map(
    companies.map((c) => [String(c._id), up(c.code || c.companyCode)])
  );

  const companyIds = [
    ...new Set(balances.map((b) => String(b.companyId)).filter(Boolean)),
  ];
  if (opts.companyId && !companyIds.includes(String(opts.companyId))) {
    companyIds.push(String(opts.companyId));
  }

  const { reservedMap, packedMap } =
    companyIds.length > 0
      ? await loadExpectedBucketMaps({
          companyIds,
          warehouse: opts.warehouse,
          article: opts.article,
        })
      : { reservedMap: new Map(), packedMap: new Map() };

  const rows = [];
  let issueCount = 0;
  const issueTypeCounts = {};
  const seen = new Set();
  const persist = opts.persist !== false;

  for (const bal of balances) {
    const article = up(bal.article || bal.itemCode);
    const warehouse = up(bal.warehouse || bal.location) || "MAIN";
    const companyId = String(bal.companyId);
    if (!article || !companyId) continue;
    const key = balanceKey(companyId, warehouse, article);
    if (seen.has(key)) continue;
    seen.add(key);

    const onHandQty = n(bal.onHandQty ?? bal.quantity);
    const r = reservedMap.get(key) || { expectedReservedQty: 0, documents: [] };
    const p = packedMap.get(key) || { expectedPackedQty: 0, documents: [] };
    const snap = {
      companyId,
      warehouse,
      article,
      stockBalanceId: String(bal._id),
      onHandQty,
      expectedReservedQty: r.expectedReservedQty,
      expectedPackedQty: p.expectedPackedQty,
      expectedAvailableQty: onHandQty - r.expectedReservedQty - p.expectedPackedQty,
      allocationDocuments: r.documents,
      packingDocuments: p.documents,
      balance: bal,
    };
    const companyCode = companyById.get(companyId) || "";
    const issues = buildIssuesFromSnapshot(snap, companyCode);
    if (persist) {
      await persistIssues({
        companyId,
        warehouse,
        article,
        issues,
        scanId,
        checkedAt,
      });
    }
    const result = rowFromSnap(snap, companyCode, issues, scanId, checkedAt);
    rows.push(result);
    issueCount += issues.length;
    for (const iss of issues) {
      issueTypeCounts[iss.issueType] = (issueTypeCounts[iss.issueType] || 0) + 1;
    }
  }

  if (opts.companyId) {
    await invalidateHealthCache(opts.companyId);
  }

  const mismatched = rows.filter((r) => !r.ok);
  return {
    scanId,
    checkedAt,
    totalRowsScanned: rows.length,
    healthyRows: rows.length - mismatched.length,
    mismatchRows: mismatched.length,
    issueCount,
    issueTypeCounts,
    rows: opts.includeHealthy === false ? mismatched : rows,
    queryStrategy: {
      balanceFind: 1,
      allocationAggregate: companyIds.length ? 1 : 0,
      packingAggregate: companyIds.length ? 1 : 0,
      note: "O(1) maps after bulk aggregations; persist uses bulkWrite per article key",
    },
    summary: {
      totalRowsScanned: rows.length,
      healthyRows: rows.length - mismatched.length,
      mismatchRows: mismatched.length,
      issueCount,
      issueTypeCounts,
    },
  };
}

export async function listReservationIntegrityIssues(opts = {}) {
  const filter = {};
  if (opts.companyId) filter.companyId = opts.companyId;
  if (opts.warehouse) filter.warehouse = up(opts.warehouse);
  if (opts.article) filter.article = up(opts.article);
  if (opts.issueType) filter.issueType = up(opts.issueType);
  if (opts.severity) filter.severity = opts.severity;
  if (opts.status && up(opts.status) !== "ALL") filter.status = up(opts.status);
  else if (!opts.status) filter.status = { $in: ["OPEN"] };

  const page = Math.max(1, Number(opts.page) || 1);
  const limit = Math.min(500, Math.max(1, Number(opts.limit) || 100));
  const skip = (page - 1) * limit;

  const [total, items] = await Promise.all([
    ReservationIntegrityIssue.countDocuments(filter),
    ReservationIntegrityIssue.find(filter)
      .sort({ updatedAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
  ]);

  const summary = await ReservationIntegrityIssue.aggregate([
    { $match: { ...(opts.companyId ? { companyId: toObjectId(opts.companyId) || opts.companyId } : {}), status: "OPEN" } },
    {
      $group: {
        _id: "$severity",
        count: { $sum: 1 },
        healthImpact: { $sum: "$healthScoreImpact" },
      },
    },
  ]);

  return {
    total,
    page,
    limit,
    items,
    summary: {
      openBySeverity: Object.fromEntries(summary.map((r) => [r._id, r.count])),
      openHealthImpact: summary.reduce((a, r) => a + n(r.healthImpact), 0),
      openCount: summary.reduce((a, r) => a + n(r.count), 0),
    },
  };
}

/** Escape CSV cells; neutralize spreadsheet formula injection (= + - @). */
export function escapeCsvCell(v) {
  let t = v == null ? "" : String(v);
  if (/^[=+\-@]/.test(t)) t = `'${t}`;
  if (/[",\n\r]/.test(t)) return `"${t.replace(/"/g, '""')}"`;
  return t;
}

export function issuesToCsv(items = []) {
  const headers = [
    "companyCode",
    "warehouse",
    "article",
    "issueType",
    "severity",
    "status",
    "onHandQty",
    "reservedQty",
    "expectedReservedQty",
    "packedQty",
    "expectedPackedQty",
    "availableQty",
    "expectedAvailableQty",
    "difference",
    "repairRecommendation",
    "healthScoreImpact",
    "lastCheckedAt",
  ];
  const lines = [headers.join(",")];
  for (const row of items) {
    lines.push(headers.map((h) => escapeCsvCell(row[h])).join(","));
  }
  return lines.join("\n");
}

/* ------------------------------------------------------------------ */
/* Auto-validation queue — only enqueue after successful commit        */
/* ------------------------------------------------------------------ */

const pendingChecks = new Map();
let flushTimer = null;
const DEBOUNCE_MS = Number(process.env.RESERVATION_INTEGRITY_DEBOUNCE_MS) || 1500;
const SESSION_PENDING = "__riPendingChecks";
const SESSION_HOOKED = "__riCommitHooked";

export function queueReservationIntegrityCheck({ companyId, warehouse, article, reason = "" }) {
  if (!companyId || !article) return;
  if (process.env.RESERVATION_INTEGRITY_AUTO_VALIDATE === "false") return;
  const wh = up(warehouse) || "MAIN";
  const art = up(article);
  const key = balanceKey(companyId, wh, art);
  pendingChecks.set(key, {
    companyId,
    warehouse: wh,
    article: art,
    reason: s(reason),
    queuedAt: Date.now(),
  });
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushReservationIntegrityQueue().catch((err) => {
      console.error("[reservationIntegrity] flush failed:", err?.message || err);
    });
  }, DEBOUNCE_MS);
}

/** Alias used by stockService — never throws. */
export function queueReservationIntegrityValidation(opts) {
  try {
    queueReservationIntegrityCheck(opts || {});
  } catch (err) {
    console.error("[reservationIntegrity] queue failed:", err?.message || err);
  }
}

function flushSessionPending(session) {
  const list = session?.[SESSION_PENDING];
  if (!Array.isArray(list) || !list.length) return;
  session[SESSION_PENDING] = [];
  for (const item of list) {
    queueReservationIntegrityValidation(item);
  }
}

function clearSessionPending(session) {
  if (session) session[SESSION_PENDING] = [];
}

/**
 * Defer validation until the Mongo session commits.
 * When no session is provided, enqueue immediately (caller already committed / non-txn).
 * Never throws into the stock mutation path.
 */
export function scheduleReservationIntegrityAfterCommit(opts = {}, session = null) {
  try {
    const companyId = opts?.companyId;
    const warehouse = opts?.warehouse;
    const article = opts?.article;
    const reason = opts?.reason || "";
    if (!companyId || !article) return;
    if (process.env.RESERVATION_INTEGRITY_AUTO_VALIDATE === "false") return;

    if (session && typeof session === "object") {
      if (!session[SESSION_PENDING]) session[SESSION_PENDING] = [];
      session[SESSION_PENDING].push({
        companyId,
        warehouse,
        article,
        reason,
      });

      if (!session[SESSION_HOOKED]) {
        session[SESSION_HOOKED] = true;
        const originalCommit = session.commitTransaction?.bind(session);
        const originalAbort = session.abortTransaction?.bind(session);
        if (typeof originalCommit === "function") {
          session.commitTransaction = async function riCommitWrapped(...args) {
            const result = await originalCommit(...args);
            try {
              flushSessionPending(session);
            } catch (err) {
              console.error("[reservationIntegrity] post-commit flush failed:", err?.message || err);
            }
            return result;
          };
        }
        if (typeof originalAbort === "function") {
          session.abortTransaction = async function riAbortWrapped(...args) {
            clearSessionPending(session);
            return originalAbort(...args);
          };
        }
      }
      return;
    }

    queueReservationIntegrityValidation({ companyId, warehouse, article, reason });
  } catch (err) {
    console.error("[reservationIntegrity] schedule failed:", err?.message || err);
  }
}

/** Used by stockService.withTransaction after successful commit. */
export function releaseReservationIntegritySessionPending(session) {
  try {
    flushSessionPending(session);
  } catch (err) {
    console.error("[reservationIntegrity] release pending failed:", err?.message || err);
  }
}

export function discardReservationIntegritySessionPending(session) {
  try {
    clearSessionPending(session);
  } catch {
    /* ignore */
  }
}

export async function flushReservationIntegrityQueue() {
  const batch = [...pendingChecks.values()];
  pendingChecks.clear();
  const companyIds = new Set();
  for (const item of batch) {
    try {
      await validateStockBuckets(item.companyId, item.warehouse, item.article, {
        persist: true,
        scanId: `auto-${item.reason || "mutation"}-${Date.now()}`,
      });
      companyIds.add(String(item.companyId));
    } catch (err) {
      console.error(
        `[reservationIntegrity] validate ${item.article}@${item.warehouse} failed:`,
        err?.message || err
      );
    }
  }
  for (const cid of companyIds) {
    await invalidateHealthCache(cid);
  }
  return { flushed: batch.length };
}

export async function collectRepairSafetySignals({ companyId, warehouse, article }) {
  const code = up(article);
  const wh = up(warehouse) || "MAIN";

  const [reserved, packed, openDispatches] = await Promise.all([
    calculateExpectedReservation(companyId, wh, code),
    calculateExpectedPacked(companyId, wh, code),
    StoreDispatch.find({
      companyId,
      warehouse: wh,
      status: { $in: ["DRAFT", "POSTING", "POSTED", "PARTIALLY_DISPATCHED", "CANCELLING"] },
      "lines.article": code,
    })
      .select("_id dispatchNo status lines")
      .lean()
      .catch(() => []),
  ]);

  const dispatchInProgress = (openDispatches || []).filter((d) => {
    const st = up(d.status);
    if (st === "CANCELLED" || st === "FULLY_DISPATCHED" || st === "REVERSED") return false;
    // POSTED with no remaining packing hold is still "in progress" only if lines exist;
    // treat DRAFT/POSTING/CANCELLING/PARTIALLY_DISPATCHED as blocking.
    if (["DRAFT", "POSTING", "CANCELLING", "PARTIALLY_DISPATCHED"].includes(st)) {
      return (d.lines || []).some((ln) => up(ln.article) === code);
    }
    return false;
  });

  return {
    expectedReservedQty: reserved.expectedReservedQty,
    expectedPackedQty: packed.expectedPackedQty,
    openAllocations: reserved.documents,
    openPackings: packed.documents,
    openDispatches: dispatchInProgress.map((d) => ({
      type: "StoreDispatch",
      id: String(d._id),
      number: d.dispatchNo || "",
      status: d.status,
    })),
    hasOpenAllocation: reserved.expectedReservedQty > EPS,
    hasOpenPacking: packed.expectedPackedQty > EPS,
    hasDispatchInProgress: dispatchInProgress.length > 0,
  };
}

export default {
  RESERVATION_INTEGRITY_ISSUE_TYPES,
  RESERVATION_HOLDING_ALLOCATION_STATUSES,
  RESERVATION_HOLDING_PACKING_STATUSES,
  calculateExpectedReservation,
  calculateExpectedPacked,
  calculateAvailable,
  buildIssuesFromSnapshot,
  validateStockBuckets,
  validateAllStock,
  listReservationIntegrityIssues,
  issuesToCsv,
  escapeCsvCell,
  queueReservationIntegrityCheck,
  queueReservationIntegrityValidation,
  scheduleReservationIntegrityAfterCommit,
  releaseReservationIntegritySessionPending,
  discardReservationIntegritySessionPending,
  flushReservationIntegrityQueue,
  collectRepairSafetySignals,
};
