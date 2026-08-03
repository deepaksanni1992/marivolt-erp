/**
 * Global Stock Bucket Integrity Audit — READ-ONLY.
 * Compares StockBalance projections to live allocation/packing docs and ledger.
 */
import fs from "fs";
import path from "path";
import crypto from "crypto";
import mongoose from "mongoose";
import Company from "../models/Company.js";
import StockBalance from "../models/StockBalance.js";
import StockLedger from "../models/StockLedger.js";
import OrderAllocation from "../models/OrderAllocation.js";
import StorePacking from "../models/StorePacking.js";

const EPS = 1e-6;

/** Allocation statuses that may still hold reservation (qty − packedQty).
 * OPEN / APPROVED: active hold.
 * PARTIALLY_PACKED: remaining unpaked qty holds reserved.
 * FULLY_PACKED: hold is normally 0 when line.packedQty === line.qty (no double-count with packed).
 * CLOSED (canonical INVOICED): remaining hold only if packedQty < qty; normally 0 after full pack/invoice.
 * CANCELLED: excluded — holds nothing.
 */
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

/** Movement types that change physical on-hand. */
export const ON_HAND_MOVEMENT_TYPES = Object.freeze([
  "GRN_IN",
  "KIT_ASSEMBLY_OUT",
  "KIT_ASSEMBLY_IN",
  "DEKIT_OUT",
  "DEKIT_IN",
  "STOCK_TRANSFER_OUT",
  "STOCK_TRANSFER_IN",
  "STOCK_ADJUSTMENT",
  "OPENING_BALANCE",
  "DISPATCH_OUT",
  "DISPATCH_CANCEL",
  "ARTICLE_CONVERSION_OUT",
  "ARTICLE_CONVERSION_IN",
  "ARTICLE_CONVERSION_REVERSAL_OUT",
  "ARTICLE_CONVERSION_REVERSAL_IN",
  "SALES_INVOICE_OUT",
  "SALES_INVOICE_CANCEL",
]);

export const MISMATCH_TYPES = Object.freeze({
  ORPHANED_RESERVED: "ORPHANED_RESERVED",
  MISSING_RESERVED: "MISSING_RESERVED",
  ORPHANED_PACKED: "ORPHANED_PACKED",
  MISSING_PACKED: "MISSING_PACKED",
  ON_HAND_LEDGER_MISMATCH: "ON_HAND_LEDGER_MISMATCH",
  STORED_AVAILABLE_MISMATCH: "STORED_AVAILABLE_MISMATCH",
  GHOST_ALLOCATION_EFFECT: "GHOST_ALLOCATION_EFFECT",
  GHOST_PACKING_EFFECT: "GHOST_PACKING_EFFECT",
  NEGATIVE_BUCKET: "NEGATIVE_BUCKET",
  CROSS_COMPANY_REFERENCE: "CROSS_COMPANY_REFERENCE",
  WAREHOUSE_SCOPE_MISMATCH: "WAREHOUSE_SCOPE_MISMATCH",
  DUPLICATE_EFFECT: "DUPLICATE_EFFECT",
  LEGACY_UNCLASSIFIED: "LEGACY_UNCLASSIFIED",
});

function n(v) {
  return Number(v) || 0;
}
function up(v) {
  return String(v ?? "").trim().toUpperCase();
}
function keyOf(companyId, warehouse, article) {
  return `${String(companyId)}|${up(warehouse) || "MAIN"}|${up(article)}`;
}

function severityFor(types, orphanedReserved, orphanedPacked, onHandDelta) {
  if (
    types.includes(MISMATCH_TYPES.CROSS_COMPANY_REFERENCE) ||
    types.includes(MISMATCH_TYPES.DUPLICATE_EFFECT) ||
    Math.abs(onHandDelta) > EPS
  ) {
    return "Critical";
  }
  if (
    types.includes(MISMATCH_TYPES.ORPHANED_RESERVED) ||
    types.includes(MISMATCH_TYPES.ORPHANED_PACKED) ||
    types.includes(MISMATCH_TYPES.GHOST_ALLOCATION_EFFECT) ||
    types.includes(MISMATCH_TYPES.GHOST_PACKING_EFFECT)
  ) {
    return orphanedReserved + orphanedPacked >= 9 ? "Critical" : "Major";
  }
  if (
    types.includes(MISMATCH_TYPES.MISSING_RESERVED) ||
    types.includes(MISMATCH_TYPES.MISSING_PACKED) ||
    types.includes(MISMATCH_TYPES.STORED_AVAILABLE_MISMATCH) ||
    types.includes(MISMATCH_TYPES.NEGATIVE_BUCKET)
  ) {
    return "Major";
  }
  return "Minor";
}

function isPhysicalLedgerRow(row) {
  const mt = up(row.movementType);
  if (mt && ON_HAND_MOVEMENT_TYPES.includes(mt)) return true;
  if (mt) return false;
  // Legacy rows without movementType
  const tx = up(row.transactionType);
  return [
    "GRN",
    "STOCK_ADJUSTMENT",
    "TRANSFER_IN",
    "TRANSFER_OUT",
    "OPENING",
    "DISPATCH_OUT",
    "DISPATCH_CANCEL",
    "SALES_INVOICE",
    "SALES_INVOICE_CANCEL",
  ].includes(tx);
}

/**
 * Run full read-only integrity scan.
 * @param {object} opts
 * @param {string} [opts.companyId]
 * @param {string} [opts.companyCode]
 * @param {string} [opts.warehouse]
 * @param {string} [opts.article]
 * @param {boolean} [opts.includeHealthy=false]
 * @param {number} [opts.limit]
 * @param {number} [opts.page]
 * @param {string[]} [opts.mismatchTypes]
 */
export async function runStockBucketIntegrityAudit(opts = {}) {
  const includeHealthy = Boolean(opts.includeHealthy);
  const page = Math.max(1, Number(opts.page) || 1);
  const limit = Math.min(5000, Math.max(1, Number(opts.limit) || 500));
  const filterMismatchTypes = Array.isArray(opts.mismatchTypes)
    ? opts.mismatchTypes.map(up)
    : null;

  const companies = await Company.find({}).select("_id code companyCode name").lean();
  const companyById = new Map(companies.map((c) => [String(c._id), c]));

  let companyFilter = {};
  if (opts.companyId) {
    companyFilter.companyId = opts.companyId;
  } else if (opts.companyCode) {
    const c = companies.find(
      (x) => up(x.code || x.companyCode) === up(opts.companyCode)
    );
    if (c) companyFilter.companyId = c._id;
  }

  const balanceFilter = { ...companyFilter };
  if (opts.warehouse) {
    const wh = up(opts.warehouse);
    balanceFilter.$or = [{ location: wh }, { warehouse: wh }];
  }
  if (opts.article) balanceFilter.article = up(opts.article);

  const balances = await StockBalance.find(balanceFilter).lean();
  const companyIds = [
    ...new Set(balances.map((b) => String(b.companyId)).filter(Boolean)),
  ];

  // Load supporting docs for relevant companies
  const allocFilter = {
    companyId: companyIds.length === 1 ? companyIds[0] : { $in: companyIds },
    status: { $in: [...ALLOCATION_STATUSES_HOLDING_RESERVED] },
  };
  const packFilter = {
    companyId: companyIds.length === 1 ? companyIds[0] : { $in: companyIds },
    status: { $in: [...PACKING_STATUSES_HOLDING_PACKED] },
  };
  if (opts.warehouse) {
    allocFilter.warehouse = up(opts.warehouse);
    packFilter.warehouse = up(opts.warehouse);
  }

  const [allocations, packings, allocationLedgers, packingLedgers, effectKeyDupes] =
    await Promise.all([
      companyIds.length
        ? OrderAllocation.find(allocFilter).select("companyId allocationNo status warehouse lines customerName").lean()
        : [],
      companyIds.length
        ? StorePacking.find(packFilter).select("companyId packingNo status warehouse lines allocationNo").lean()
        : [],
      companyIds.length
        ? StockLedger.find({
            companyId: companyIds.length === 1 ? companyIds[0] : { $in: companyIds },
            $or: [
              { movementType: "ALLOCATION" },
              { transactionType: "SALES_ALLOCATION" },
            ],
          })
            .select("companyId article warehouse location referenceNo qtyOut qtyIn createdAt")
            .lean()
        : [],
      companyIds.length
        ? StockLedger.find({
            companyId: companyIds.length === 1 ? companyIds[0] : { $in: companyIds },
            $or: [
              { movementType: { $in: ["PACKED", "UNPACKED"] } },
              { transactionType: { $in: ["PACKED", "UNPACKED"] } },
            ],
          })
            .select(
              "companyId article warehouse location referenceNo movementType transactionType qtyIn qtyOut effectKey createdAt"
            )
            .lean()
        : [],
      companyIds.length
        ? StockLedger.aggregate([
            {
              $match: {
                companyId:
                  companyIds.length === 1
                    ? new mongoose.Types.ObjectId(companyIds[0])
                    : { $in: companyIds.map((id) => new mongoose.Types.ObjectId(id)) },
                effectKey: { $type: "string", $gt: "" },
              },
            },
            { $group: { _id: "$effectKey", count: { $sum: 1 }, articles: { $addToSet: "$article" } } },
            { $match: { count: { $gt: 1 } } },
            { $limit: 200 },
          ])
        : [],
    ]);

  const allocNosByCompany = new Map();
  for (const a of allocations) {
    const set = allocNosByCompany.get(String(a.companyId)) || new Set();
    set.add(up(a.allocationNo));
    allocNosByCompany.set(String(a.companyId), set);
  }

  // expected reserved / packed maps
  const expectedReserved = new Map(); // key -> { qty, docs: [] }
  const expectedPacked = new Map();
  /** allocationNo+article → packed qty claimed on live packing docs */
  const packingClaimByAllocArticle = new Map();

  for (const p of packings) {
    const wh = up(p.warehouse) || "MAIN";
    for (const ln of p.lines || []) {
      const art = up(ln.article);
      if (!art) continue;
      if (opts.article && art !== up(opts.article)) continue;
      // Staging still held = packed minus already dispatched from this line.
      const staging = Math.max(0, n(ln.packQty) - n(ln.dispatchedQty));
      const claimed = n(ln.packQty);
      if (claimed > EPS) {
        const packClaimKey = `${String(p.companyId)}|${up(p.allocationNo)}|${art}`;
        packingClaimByAllocArticle.set(
          packClaimKey,
          (packingClaimByAllocArticle.get(packClaimKey) || 0) + claimed
        );
      }
      if (staging <= EPS) continue;
      const k = keyOf(p.companyId, wh, art);
      const cur = expectedPacked.get(k) || { qty: 0, docs: [] };
      cur.qty += staging;
      cur.docs.push(p.packingNo);
      expectedPacked.set(k, cur);
    }
  }

  for (const a of allocations) {
    const wh = up(a.warehouse) || "MAIN";
    const st = up(a.status);
    // FULLY_PACKED / CLOSED (invoiced): no remaining ERP reservation by lifecycle.
    // Prevents false MISSING_RESERVED when line.packedQty was not backfilled (legacy).
    if (st === "FULLY_PACKED" || st === "CLOSED") continue;

    for (const ln of a.lines || []) {
      const art = up(ln.article);
      if (!art) continue;
      if (opts.article && art !== up(opts.article)) continue;
      let hold = allocationLineRemainingReserved(ln);
      // Prefer packing-document claims when allocation line packedQty is stale.
      const packClaimKey = `${String(a.companyId)}|${up(a.allocationNo)}|${art}`;
      const packedFromDocs = packingClaimByAllocArticle.get(packClaimKey) || 0;
      if (packedFromDocs > n(ln.packedQty)) {
        hold = Math.max(0, n(ln.qty) - packedFromDocs);
      }
      if (hold <= EPS) continue;
      const k = keyOf(a.companyId, wh, art);
      const cur = expectedReserved.get(k) || { qty: 0, docs: [] };
      cur.qty += hold;
      cur.docs.push(a.allocationNo);
      expectedReserved.set(k, cur);
    }
  }

  // Ghost allocation ledger refs (ALLOCATION ledger with no live allocation doc)
  const ghostAllocByKey = new Map(); // balance key -> refs[]
  for (const row of allocationLedgers) {
    const wh = up(row.warehouse || row.location) || "MAIN";
    const art = up(row.article);
    const ref = up(row.referenceNo);
    if (!art || !ref) continue;
    const live = allocNosByCompany.get(String(row.companyId));
    if (live && live.has(ref)) continue;
    // Check if ANY allocation doc exists (including cancelled)
    // Deferred: treat missing from active set as ghost candidate; refine below
    const k = keyOf(row.companyId, wh, art);
    const arr = ghostAllocByKey.get(k) || [];
    arr.push({ referenceNo: row.referenceNo, qtyOut: n(row.qtyOut), createdAt: row.createdAt });
    ghostAllocByKey.set(k, arr);
  }

  // Verify cancelled allocations still exist for ghost filtering
  const allAllocNos = await OrderAllocation.find({
    companyId: companyIds.length === 1 ? companyIds[0] : { $in: companyIds },
  })
    .select("companyId allocationNo")
    .lean();
  const anyAllocByCompany = new Map();
  for (const a of allAllocNos) {
    const set = anyAllocByCompany.get(String(a.companyId)) || new Set();
    set.add(up(a.allocationNo));
    anyAllocByCompany.set(String(a.companyId), set);
  }
  for (const [k, refs] of ghostAllocByKey) {
    const companyId = k.split("|")[0];
    const any = anyAllocByCompany.get(companyId) || new Set();
    ghostAllocByKey.set(
      k,
      refs.filter((r) => !any.has(up(r.referenceNo)))
    );
  }

  // Ledger-derived on-hand per key
  const ledgerOnHand = new Map();
  if (companyIds.length) {
    const physicalLedgers = await StockLedger.find({
      companyId: companyIds.length === 1 ? companyIds[0] : { $in: companyIds },
      ...(opts.article ? { article: up(opts.article) } : {}),
    })
      .select(
        "companyId article warehouse location movementType transactionType qtyIn qtyOut"
      )
      .lean();
    for (const row of physicalLedgers) {
      if (!isPhysicalLedgerRow(row)) continue;
      const wh = up(row.warehouse || row.location) || "MAIN";
      const art = up(row.article);
      const k = keyOf(row.companyId, wh, art);
      ledgerOnHand.set(k, (ledgerOnHand.get(k) || 0) + n(row.qtyIn) - n(row.qtyOut));
    }
  }

  const dupeEffectKeys = new Set((effectKeyDupes || []).map((d) => d._id));

  const rows = [];
  let healthy = 0;
  let mismatch = 0;
  let totalOrphanReserved = 0;
  let totalOrphanPacked = 0;
  let totalOnHandMismatch = 0;
  const byCompany = new Map();
  const byWarehouse = new Map();
  const byType = new Map();
  const bySeverity = new Map();
  let oldest = null;
  let newest = null;

  for (const b of balances) {
    const companyId = String(b.companyId);
    const company = companyById.get(companyId);
    const companyCode = up(company?.code || company?.companyCode || "");
    const warehouse = up(b.location || b.warehouse) || "MAIN";
    const article = up(b.article || b.itemCode);
    if (!article) continue;
    if (opts.warehouse && warehouse !== up(opts.warehouse)) continue;

    const k = keyOf(companyId, warehouse, article);
    const onHandQty = n(b.onHandQty ?? b.quantity);
    const storedReservedQty = Math.max(n(b.allocatedQty), n(b.reservedQty));
    const storedAllocatedQty = n(b.allocatedQty);
    const storedPackedQty = n(b.packedQty);
    const storedAvailableQty =
      b.availableQty != null ? n(b.availableQty) : onHandQty - storedReservedQty - storedPackedQty;

    const expR = expectedReserved.get(k) || { qty: 0, docs: [] };
    const expP = expectedPacked.get(k) || { qty: 0, docs: [] };
    const expectedReservedQty = expR.qty;
    const expectedPackedQty = expP.qty;
    const expectedFreeAvailableQty = onHandQty - expectedReservedQty - expectedPackedQty;
    const ledgerDerivedOnHandQty = ledgerOnHand.has(k) ? ledgerOnHand.get(k) : null;

    const orphanedReservedQty = Math.max(0, storedReservedQty - expectedReservedQty);
    const orphanedPackedQty = Math.max(0, storedPackedQty - expectedPackedQty);
    const missingReservedQty = Math.max(0, expectedReservedQty - storedReservedQty);
    const missingPackedQty = Math.max(0, expectedPackedQty - storedPackedQty);
    const balanceMismatchQty =
      ledgerDerivedOnHandQty == null ? 0 : Math.abs(onHandQty - ledgerDerivedOnHandQty);

    const mismatchTypes = [];
    if (orphanedReservedQty > EPS) mismatchTypes.push(MISMATCH_TYPES.ORPHANED_RESERVED);
    if (missingReservedQty > EPS) mismatchTypes.push(MISMATCH_TYPES.MISSING_RESERVED);
    if (orphanedPackedQty > EPS) mismatchTypes.push(MISMATCH_TYPES.ORPHANED_PACKED);
    if (missingPackedQty > EPS) mismatchTypes.push(MISMATCH_TYPES.MISSING_PACKED);
    if (ledgerDerivedOnHandQty != null && Math.abs(onHandQty - ledgerDerivedOnHandQty) > 0.01) {
      mismatchTypes.push(MISMATCH_TYPES.ON_HAND_LEDGER_MISMATCH);
    }
    // availableQty is a persisted projection and MAY be negative (allowNegative allocations).
    // Compare to unclamped onHand − reserved − packed — never treat intentional negatives as orphans.
    const derivedAvailableUnclamped = onHandQty - storedReservedQty - storedPackedQty;
    if (Math.abs(storedAvailableQty - derivedAvailableUnclamped) > 0.01) {
      mismatchTypes.push(MISMATCH_TYPES.STORED_AVAILABLE_MISMATCH);
    }
    const ghosts = ghostAllocByKey.get(k) || [];
    if (ghosts.length && orphanedReservedQty > EPS) {
      mismatchTypes.push(MISMATCH_TYPES.GHOST_ALLOCATION_EFFECT);
    }
    if (onHandQty < -EPS || storedReservedQty < -EPS || storedPackedQty < -EPS) {
      mismatchTypes.push(MISMATCH_TYPES.NEGATIVE_BUCKET);
    }
    if (dupeEffectKeys.size) {
      // mark if any packing ledger for this article has dupe key — cheap check via packingLedgers
      const hasDupe = packingLedgers.some(
        (r) =>
          String(r.companyId) === companyId &&
          up(r.article) === article &&
          r.effectKey &&
          dupeEffectKeys.has(r.effectKey)
      );
      if (hasDupe) mismatchTypes.push(MISMATCH_TYPES.DUPLICATE_EFFECT);
    }

    if (filterMismatchTypes?.length) {
      if (!mismatchTypes.some((t) => filterMismatchTypes.includes(t))) continue;
    }

    const isHealthy = mismatchTypes.length === 0;
    if (isHealthy) {
      healthy += 1;
      if (!includeHealthy) continue;
    } else {
      mismatch += 1;
      totalOrphanReserved += orphanedReservedQty;
      totalOrphanPacked += orphanedPackedQty;
      totalOnHandMismatch += balanceMismatchQty;
    }

    const severity = isHealthy
      ? "Healthy"
      : severityFor(mismatchTypes, orphanedReservedQty, orphanedPackedQty, balanceMismatchQty);

    const safeRepairCandidate =
      !isHealthy &&
      mismatchTypes.every((t) =>
        [
          MISMATCH_TYPES.ORPHANED_RESERVED,
          MISMATCH_TYPES.ORPHANED_PACKED,
          MISMATCH_TYPES.STORED_AVAILABLE_MISMATCH,
          // Ghost refs explain orphans; projection repair still safe if no missing/on-hand issues.
          MISMATCH_TYPES.GHOST_ALLOCATION_EFFECT,
          MISMATCH_TYPES.GHOST_PACKING_EFFECT,
        ].includes(t)
      ) &&
      !mismatchTypes.includes(MISMATCH_TYPES.ON_HAND_LEDGER_MISMATCH) &&
      !mismatchTypes.includes(MISMATCH_TYPES.DUPLICATE_EFFECT) &&
      !mismatchTypes.includes(MISMATCH_TYPES.CROSS_COMPANY_REFERENCE) &&
      missingReservedQty <= EPS &&
      missingPackedQty <= EPS;

    let repairBlockedReason = null;
    if (!isHealthy && !safeRepairCandidate) {
      if (mismatchTypes.includes(MISMATCH_TYPES.ON_HAND_LEDGER_MISMATCH)) {
        repairBlockedReason = "ON_HAND_LEDGER_MISMATCH requires manual investigation";
      } else if (missingReservedQty > EPS || missingPackedQty > EPS) {
        repairBlockedReason = "Missing reserved/packed vs live docs — do not auto-lower documents";
      } else {
        repairBlockedReason = `Unsafe mismatch types: ${mismatchTypes.join(",")}`;
      }
    }

    const updatedAt = b.updatedAt ? new Date(b.updatedAt) : null;
    if (updatedAt && !isHealthy) {
      if (!oldest || updatedAt < oldest) oldest = updatedAt;
      if (!newest || updatedAt > newest) newest = updatedAt;
    }

    const bump = (map, key, amt = 1) => map.set(key, (map.get(key) || 0) + amt);
    bump(byCompany, companyCode || companyId);
    bump(byWarehouse, warehouse);
    bump(bySeverity, severity);
    for (const t of mismatchTypes) bump(byType, t);

    rows.push({
      companyId,
      companyCode: companyCode || "—",
      warehouseCode: warehouse,
      location: warehouse,
      article,
      onHandQty,
      storedReservedQty,
      storedAllocatedQty,
      storedPackedQty,
      storedAvailableQty,
      ledgerDerivedOnHandQty,
      expectedReservedQty,
      expectedPackedQty,
      expectedFreeAvailableQty,
      orphanedReservedQty,
      orphanedPackedQty,
      missingReservedQty,
      missingPackedQty,
      balanceMismatchQty,
      supportingAllocationNos: [...new Set(expR.docs)],
      supportingPackingNos: [...new Set(expP.docs)],
      ghostAllocationLedgerRefs: ghosts,
      ghostPackingLedgerRefs: [],
      lastUpdatedAt: b.updatedAt || null,
      mismatchTypes,
      severity,
      safeRepairCandidate,
      repairBlockedReason,
      healthy: isHealthy,
    });
  }

  // Sort mismatches first
  rows.sort((a, b) => {
    if (a.healthy !== b.healthy) return a.healthy ? 1 : -1;
    return (b.orphanedReservedQty || 0) - (a.orphanedReservedQty || 0);
  });

  const totalScanned = balances.length;
  const start = (page - 1) * limit;
  const pageRows = rows.slice(start, start + limit);

  const safeCandidates = rows.filter((r) => r.safeRepairCandidate);
  const blocked = rows.filter((r) => !r.healthy && !r.safeRepairCandidate);

  return {
    scannedAt: new Date().toISOString(),
    readOnly: true,
    mutated: false,
    statusMatrix: {
      allocationHoldingReserved: ALLOCATION_STATUSES_HOLDING_RESERVED,
      packingHoldingPacked: PACKING_STATUSES_HOLDING_PACKED,
      notes: [
        "Allocation hold = max(0, line.qty - max(line.packedQty, packingClaims)) for OPEN/PARTIALLY_PACKED/APPROVED.",
        "FULLY_PACKED / CLOSED contribute 0 remaining reserved (prevents false MISSING_RESERVED when line.packedQty stale).",
        "Packed hold = sum max(0, packQty − dispatchedQty) on POSTED/PARTIALLY_PACKED/FULLY_PACKED/POSTING.",
        "availableQty may be negative (allowNegative allocations); STORED_AVAILABLE_MISMATCH uses unclamped onHand−reserved−packed.",
        "onHand ledger uses physical movement types only; ALLOCATION/PACKED excluded.",
      ],
    },
    summary: {
      totalStockBalanceRowsScanned: totalScanned,
      healthyRows: healthy,
      mismatchRows: mismatch,
      totalOrphanedReservedQty: totalOrphanReserved,
      totalOrphanedPackedQty: totalOrphanPacked,
      totalOnHandLedgerMismatchQty: totalOnHandMismatch,
      countsByCompany: Object.fromEntries(byCompany),
      countsByWarehouse: Object.fromEntries(byWarehouse),
      countsByMismatchType: Object.fromEntries(byType),
      countsBySeverity: Object.fromEntries(bySeverity),
      oldestUnresolvedIssue: oldest,
      newestIssue: newest,
      safeRepairCandidateCount: safeCandidates.length,
      blockedRepairCount: blocked.length,
      duplicateEffectKeyCount: effectKeyDupes.length,
    },
    topAffectedArticles: rows
      .filter((r) => !r.healthy)
      .slice(0, 100)
      .map((r) => ({
        companyCode: r.companyCode,
        warehouse: r.warehouseCode,
        article: r.article,
        orphanedReservedQty: r.orphanedReservedQty,
        orphanedPackedQty: r.orphanedPackedQty,
        mismatchTypes: r.mismatchTypes,
        severity: r.severity,
      })),
    safeRepairCandidates: safeCandidates.slice(0, 500),
    blockedRepairs: blocked.slice(0, 200),
    rows: pageRows,
    pagination: { page, limit, total: rows.length, totalPages: Math.ceil(rows.length / limit) },
  };
}

export function auditRowsToCsv(rows = []) {
  const headers = [
    "companyCode",
    "warehouseCode",
    "article",
    "onHandQty",
    "storedReservedQty",
    "expectedReservedQty",
    "storedPackedQty",
    "expectedPackedQty",
    "storedAvailableQty",
    "expectedFreeAvailableQty",
    "ledgerDerivedOnHandQty",
    "orphanedReservedQty",
    "orphanedPackedQty",
    "mismatchTypes",
    "severity",
    "safeRepairCandidate",
    "supportingAllocationNos",
    "ghostAllocationLedgerRefs",
    "repairBlockedReason",
  ];
  const esc = (v) => {
    const s = v == null ? "" : String(v);
    if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const lines = [headers.join(",")];
  for (const r of rows) {
    lines.push(
      [
        r.companyCode,
        r.warehouseCode,
        r.article,
        r.onHandQty,
        r.storedReservedQty,
        r.expectedReservedQty,
        r.storedPackedQty,
        r.expectedPackedQty,
        r.storedAvailableQty,
        r.expectedFreeAvailableQty,
        r.ledgerDerivedOnHandQty,
        r.orphanedReservedQty,
        r.orphanedPackedQty,
        (r.mismatchTypes || []).join("|"),
        r.severity,
        r.safeRepairCandidate,
        (r.supportingAllocationNos || []).join("|"),
        (r.ghostAllocationLedgerRefs || []).map((g) => g.referenceNo).join("|"),
        r.repairBlockedReason || "",
      ]
        .map(esc)
        .join(",")
    );
  }
  return lines.join("\n");
}

export async function writeAuditEvidence(report, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const jsonPath = path.join(outDir, `stock-bucket-integrity-${stamp}.json`);
  const csvPath = path.join(outDir, `stock-bucket-integrity-${stamp}.csv`);
  const allMismatch = [
    ...(report.safeRepairCandidates || []),
    ...(report.blockedRepairs || []),
  ];
  // Prefer full mismatch set from topAffected + candidates
  const mismatchRows = (report.rows || []).filter((r) => !r.healthy);
  const csvSource = mismatchRows.length ? mismatchRows : allMismatch;
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2), "utf8");
  fs.writeFileSync(csvPath, auditRowsToCsv(csvSource), "utf8");
  return { jsonPath, csvPath };
}

const PREVIEW_TTL_MS = 30 * 60 * 1000;
/** @type {Map<string, { expiresAt: number, fingerprint: string, reason: string, rows: object[] }>} */
const previewTokens = new Map();

function rowFingerprint(row) {
  return [
    row.companyId,
    row.warehouseCode,
    row.article,
    row.storedReservedQty,
    row.storedPackedQty,
    row.onHandQty,
    row.lastUpdatedAt || "",
  ].join("|");
}

/**
 * Dry-run bulk repair preview only. Does not mutate any data.
 * Live apply is intentionally not exposed until the Phase-1 audit is reviewed.
 */
export async function previewBucketIntegrityRepair(opts = {}) {
  const maxRows = Math.min(500, Math.max(1, Number(opts.maxRows) || 500));
  const reason = String(opts.reason || "").trim();
  if (!reason) {
    throw Object.assign(new Error("reason is mandatory"), { statusCode: 400 });
  }
  const mismatchTypes =
    Array.isArray(opts.mismatchTypes) && opts.mismatchTypes.length
      ? opts.mismatchTypes
      : ["ORPHANED_RESERVED", "ORPHANED_PACKED", "STORED_AVAILABLE_MISMATCH"];

  const report = await runStockBucketIntegrityAudit({
    companyCode: opts.companyCode,
    companyId: opts.companyId,
    warehouse: opts.warehouseCode || opts.warehouse,
    includeHealthy: false,
    limit: 5000,
    page: 1,
    mismatchTypes,
  });

  let candidates = (report.safeRepairCandidates || []).filter((r) => r.safeRepairCandidate);
  if (Array.isArray(opts.articles) && opts.articles.length) {
    const set = new Set(opts.articles.map(up));
    candidates = candidates.filter((r) => set.has(up(r.article)));
  }
  candidates = candidates.slice(0, maxRows);

  const plans = candidates.map((r) => {
    const proposedReserved = r.expectedReservedQty;
    const proposedPacked = r.expectedPackedQty;
    // Persist available as unclamped projection (may be negative when allowNegative).
    const proposedAvailable = r.onHandQty - proposedReserved - proposedPacked;
    return {
      companyId: r.companyId,
      companyCode: r.companyCode,
      warehouseCode: r.warehouseCode,
      article: r.article,
      mismatchTypes: r.mismatchTypes,
      severity: r.severity,
      balanceVersion: r.lastUpdatedAt || null,
      before: {
        onHandQty: r.onHandQty,
        reservedQty: r.storedReservedQty,
        packedQty: r.storedPackedQty,
        availableQty: r.storedAvailableQty,
        updatedAt: r.lastUpdatedAt || null,
      },
      expected: {
        reservedQty: r.expectedReservedQty,
        packedQty: r.expectedPackedQty,
        freeAvailableQty: r.expectedFreeAvailableQty,
      },
      proposedAfter: {
        onHandQty: r.onHandQty,
        reservedQty: proposedReserved,
        packedQty: proposedPacked,
        availableQty: proposedAvailable,
      },
      supportingAllocationNos: r.supportingAllocationNos,
      supportingPackingNos: r.supportingPackingNos,
      ghostAllocationLedgerRefs: r.ghostAllocationLedgerRefs,
      safetyDecision: "SAFE_PROJECTION_ONLY",
      fieldsThatWouldChange: ["reservedQty", "allocatedQty", "packedQty", "availableQty"].filter(
        (f) =>
          (f === "reservedQty" && Math.abs(r.storedReservedQty - proposedReserved) > EPS) ||
          (f === "allocatedQty" && Math.abs(r.storedAllocatedQty - proposedReserved) > EPS) ||
          (f === "packedQty" && Math.abs(r.storedPackedQty - proposedPacked) > EPS) ||
          (f === "availableQty" && Math.abs(r.storedAvailableQty - proposedAvailable) > EPS)
      ),
      fieldsGuaranteedUnchanged: [
        "onHandQty",
        "quantity",
        "customs",
        "GRN",
        "OrderAllocation",
        "StorePacking",
        "StockLedger",
      ],
      fingerprint: rowFingerprint(r),
    };
  });

  const fingerprint = crypto
    .createHash("sha256")
    .update(plans.map((p) => p.fingerprint).join("\n") + "|" + reason)
    .digest("hex");
  const previewToken = crypto.randomBytes(24).toString("hex");
  const expiresAt = Date.now() + PREVIEW_TTL_MS;
  previewTokens.set(previewToken, {
    expiresAt,
    fingerprint,
    reason,
    rows: plans,
  });

  const repairEnabled = String(process.env.STOCK_BUCKET_BULK_REPAIR_ENABLED || "").toLowerCase() === "true";

  return {
    dryRun: true,
    mutated: false,
    applyEnabled: repairEnabled,
    applyBlockedReason: repairEnabled
      ? null
      : "Live bulk repair gated until STOCK_BUCKET_BULK_REPAIR_ENABLED=true after deploy + explicit approval.",
    previewToken,
    previewId: previewToken,
    expiresAt: new Date(expiresAt).toISOString(),
    fingerprint,
    reason,
    candidateCount: plans.length,
    candidates: plans,
    neverRepair: [
      "ON_HAND_LEDGER_MISMATCH",
      "CROSS_COMPANY_REFERENCE",
      "DUPLICATE_EFFECT",
      "LEGACY_UNCLASSIFIED",
      "MISSING_RESERVED",
      "MISSING_PACKED",
    ],
  };
}

/**
 * Controlled bulk projection repair. Requires prior preview token.
 * Disabled unless STOCK_BUCKET_BULK_REPAIR_ENABLED=true.
 */
export async function applyBucketIntegrityRepair({
  previewToken,
  reason,
  dryRun = false,
  maxRows = 500,
  req = null,
  userEmail = "",
}) {
  if (String(process.env.STOCK_BUCKET_BULK_REPAIR_ENABLED || "").toLowerCase() !== "true") {
    throw Object.assign(
      new Error(
        "Bulk projection repair is gated. Set STOCK_BUCKET_BULK_REPAIR_ENABLED=true only after explicit approval."
      ),
      { statusCode: 403, code: "REPAIR_GATED" }
    );
  }
  if (!String(reason || "").trim()) {
    throw Object.assign(new Error("reason is mandatory"), { statusCode: 400 });
  }
  const token = String(previewToken || "").trim();
  const cached = previewTokens.get(token);
  if (!cached) {
    throw Object.assign(new Error("Invalid or expired preview token — run repair-preview again"), {
      statusCode: 409,
      code: "PREVIEW_TOKEN_INVALID",
    });
  }
  if (cached.expiresAt < Date.now()) {
    previewTokens.delete(token);
    throw Object.assign(new Error("Preview token expired — run repair-preview again"), {
      statusCode: 409,
      code: "PREVIEW_TOKEN_EXPIRED",
    });
  }

  const {
    diagnoseOrphanedStockBuckets,
    repairOrphanedStockBuckets,
  } = await import("./stockBucketReconcileService.js");

  const results = [];
  let applied = 0;
  let skipped = 0;
  const limit = Math.min(maxRows, cached.rows.length);

  for (const plan of cached.rows.slice(0, limit)) {
    // Never auto-repair MISSING_RESERVED / on-hand / etc.
    if ((plan.mismatchTypes || []).includes("MISSING_RESERVED")) {
      results.push({ article: plan.article, status: "SKIPPED", skipReason: "MISSING_RESERVED excluded" });
      skipped += 1;
      continue;
    }
    const live = await diagnoseOrphanedStockBuckets({
      companyId: plan.companyId,
      article: plan.article,
      warehouse: plan.warehouseCode,
    });
    if (!live.balance) {
      results.push({ ...plan, status: "SKIPPED", skipReason: "StockBalance missing" });
      skipped += 1;
      continue;
    }
    const liveReserved = Math.max(n(live.balance.allocatedQty), n(live.balance.reservedQty));
    if (
      Math.abs(liveReserved - n(plan.before.reservedQty)) > EPS ||
      Math.abs(n(live.balance.packedQty) - n(plan.before.packedQty)) > EPS ||
      Math.abs(n(live.balance.onHandQty) - n(plan.before.onHandQty)) > EPS
    ) {
      results.push({
        article: plan.article,
        warehouseCode: plan.warehouseCode,
        status: "SKIPPED",
        skipReason: "Row changed since preview (stale token)",
      });
      skipped += 1;
      continue;
    }

    if (dryRun) {
      results.push({ article: plan.article, warehouseCode: plan.warehouseCode, status: "WOULD_APPLY", plan });
      applied += 1;
      continue;
    }

    // For pure availableQty projection drift (no orphan), recalculate only.
    if (
      (plan.mismatchTypes || []).length === 1 &&
      (plan.mismatchTypes || [])[0] === "STORED_AVAILABLE_MISMATCH"
    ) {
      const { recalculateStockBalance } = await import("./stockService.js");
      await recalculateStockBalance({
        companyId: plan.companyId,
        article: plan.article,
        warehouse: plan.warehouseCode,
      });
      results.push({ article: plan.article, status: "APPLIED", mode: "recalculateAvailable" });
      applied += 1;
      continue;
    }

    const repair = await repairOrphanedStockBuckets({
      companyId: plan.companyId,
      article: plan.article,
      warehouse: plan.warehouseCode,
      reason,
      dryRun: false,
      req,
      userEmail,
    });
    results.push({
      article: plan.article,
      warehouseCode: plan.warehouseCode,
      status: repair.repaired ? "APPLIED" : repair.alreadyConsistent ? "IDEMPOTENT" : "SKIPPED",
      repair,
    });
    if (repair.repaired || repair.alreadyConsistent) applied += 1;
    else skipped += 1;
  }

  if (!dryRun) previewTokens.delete(token);

  return {
    dryRun: Boolean(dryRun),
    applied,
    skipped,
    results,
    mutated: !dryRun && applied > 0,
  };
}

export function getPreviewTokenMeta(token) {
  return previewTokens.get(String(token || "").trim()) || null;
}

export function _clearPreviewTokensForTests() {
  previewTokens.clear();
}
