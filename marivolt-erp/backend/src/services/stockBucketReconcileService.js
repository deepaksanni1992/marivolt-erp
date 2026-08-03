/**
 * Detect / repair orphaned StockBalance reservedQty & packedQty projections.
 * Does NOT create GRN/customs/on-hand ledger movements.
 * Repair is admin-invoked only; never auto-runs.
 */
import StockBalance from "../models/StockBalance.js";
import OrderAllocation from "../models/OrderAllocation.js";
import StorePacking from "../models/StorePacking.js";
import StockLedger from "../models/StockLedger.js";
import { writeAudit } from "./auditService.js";

function n(v) {
  return Number(v) || 0;
}
function up(v) {
  return String(v ?? "").trim().toUpperCase();
}

const POSTED_PACKING = new Set(["POSTED", "PARTIALLY_PACKED", "FULLY_PACKED", "POSTING"]);

/**
 * Expected reserved = sum of (allocated − packedQty on line) for non-cancelled allocations.
 * Expected packed = sum of packQty on posted packings that still hold packed staging
 * (approximation: posted packing lines for article; architecture keeps packed on balance
 * until dispatch). For detection we also compare against live docs.
 */
export async function diagnoseOrphanedStockBuckets({
  companyId,
  article,
  warehouse = "MAIN",
}) {
  const code = up(article);
  const wh = up(warehouse) || "MAIN";
  if (!companyId || !code) throw new Error("companyId and article required");

  const balance = await StockBalance.findOne({
    companyId,
    $or: [
      { article: code, location: wh },
      { itemCode: code, warehouse: wh },
    ],
  }).lean();

  const onHandQty = n(balance?.onHandQty ?? balance?.quantity);
  const reservedQty = Math.max(n(balance?.allocatedQty), n(balance?.reservedQty));
  const packedQty = n(balance?.packedQty);
  const freeAvailableQty = Math.max(0, onHandQty - reservedQty - packedQty);

  const allocations = await OrderAllocation.find({
    companyId,
    warehouse: wh,
    status: { $nin: ["CANCELLED"] },
    "lines.article": code,
  })
    .select("allocationNo status customerName lines")
    .lean();

  let expectedReservedQty = 0;
  const allocationEvidence = [];
  for (const a of allocations) {
    for (const ln of a.lines || []) {
      if (up(ln.article) !== code) continue;
      const hold = Math.max(0, n(ln.qty) - n(ln.packedQty));
      expectedReservedQty += hold;
      allocationEvidence.push({
        allocationNo: a.allocationNo,
        status: a.status,
        customerName: a.customerName,
        holdQty: hold,
      });
    }
  }

  const packings = await StorePacking.find({
    companyId,
    warehouse: wh,
    status: { $in: [...POSTED_PACKING] },
    "lines.article": code,
  })
    .select("packingNo status lines")
    .lean();

  let expectedPackedFromDocs = 0;
  const packingEvidence = [];
    for (const p of packings) {
      let q = 0;
      for (const ln of p.lines || []) {
        if (up(ln.article) !== code) continue;
        q += Math.max(0, n(ln.packQty) - n(ln.dispatchedQty));
      }
      expectedPackedFromDocs += q;
      packingEvidence.push({ packingNo: p.packingNo, status: p.status, packQty: q });
    }

  // Orphaned reservation: balance reserved above what open allocations explain.
  const orphanedReservedQty = Math.max(0, reservedQty - expectedReservedQty);
  // Orphaned packed: balance packed with no posted packing docs (or excess).
  const orphanedPackedQty = Math.max(0, packedQty - expectedPackedFromDocs);

  const allocationLedgerWithoutDoc = await StockLedger.find({
    companyId,
    article: code,
    warehouse: wh,
    movementType: "ALLOCATION",
  })
    .select("referenceNo qtyOut createdAt allocatedAfter")
    .sort({ createdAt: -1 })
    .limit(20)
    .lean();

  const cancelLedgers = await StockLedger.find({
    companyId,
    article: code,
    $or: [{ movementType: "ALLOCATION_CANCEL" }, { transactionType: "ORDER_ALLOCATION_CANCEL" }],
  })
    .select("referenceNo qtyIn createdAt")
    .lean();

  const hasOrphan =
    (orphanedReservedQty > 1e-6 && allocationEvidence.length === 0) ||
    (orphanedPackedQty > 1e-6 && packingEvidence.length === 0);

  return {
    article: code,
    warehouse: wh,
    balance: balance
      ? {
          _id: balance._id,
          onHandQty,
          reservedQty,
          allocatedQty: n(balance.allocatedQty),
          packedQty,
          freeAvailableQty,
          updatedAt: balance.updatedAt,
        }
      : null,
    expectedReservedQty,
    expectedPackedFromDocs,
    orphanedReservedQty,
    orphanedPackedQty,
    hasOrphan,
    allocationEvidence,
    packingEvidence,
    allocationLedgerWithoutDoc: allocationLedgerWithoutDoc.map((r) => ({
      referenceNo: r.referenceNo,
      qtyOut: r.qtyOut,
      createdAt: r.createdAt,
      allocatedAfter: r.allocatedAfter,
    })),
    allocationCancelLedgerCount: cancelLedgers.length,
    recommendedRepair:
      hasOrphan
        ? {
            setReservedQty: expectedReservedQty,
            setPackedQty: packingEvidence.length ? Math.min(packedQty, expectedPackedFromDocs) : 0,
            note: "Projection-only correction; does not write GRN/customs/on-hand ledger rows.",
          }
        : null,
  };
}

/**
 * Apply projection repair for orphaned reserved/packed buckets.
 * Idempotent: re-running with same expected values is a no-op.
 */
export async function repairOrphanedStockBuckets({
  companyId,
  article,
  warehouse = "MAIN",
  reason,
  dryRun = false,
  req = null,
  userEmail = "",
}) {
  if (!String(reason || "").trim()) {
    throw Object.assign(new Error("Repair reason is mandatory"), { statusCode: 400 });
  }
  const diagnosis = await diagnoseOrphanedStockBuckets({ companyId, article, warehouse });
  if (!diagnosis.balance) {
    throw Object.assign(new Error("StockBalance row not found"), { statusCode: 404 });
  }
  if (!diagnosis.hasOrphan) {
    return { repaired: false, alreadyConsistent: true, diagnosis };
  }

  const targetReserved = n(diagnosis.recommendedRepair?.setReservedQty);
  const targetPacked = n(diagnosis.recommendedRepair?.setPackedQty);
  const before = { ...diagnosis.balance };

  if (dryRun) {
    return {
      repaired: false,
      dryRun: true,
      before,
      after: {
        ...before,
        reservedQty: targetReserved,
        packedQty: targetPacked,
        freeAvailableQty: Math.max(0, before.onHandQty - targetReserved - targetPacked),
      },
      diagnosis,
    };
  }

  const onHand = before.onHandQty;
  const available = Math.max(0, onHand - targetReserved - targetPacked);
  const updated = await StockBalance.findOneAndUpdate(
    { _id: diagnosis.balance._id, companyId },
    {
      $set: {
        reservedQty: targetReserved,
        allocatedQty: targetReserved,
        packedQty: targetPacked,
        availableQty: available,
      },
    },
    { new: true }
  ).lean();

  if (req) {
    await writeAudit(req, {
      action: "OTHER",
      module: "STORE",
      entityType: "STOCK_BALANCE",
      entityId: diagnosis.balance._id,
      documentNo: `${up(article)}@${up(warehouse)}`,
      description: `Orphaned stock bucket reconcile for ${up(article)} in ${up(warehouse)}`,
      metadata: {
        reason: String(reason).trim(),
        before,
        after: {
          onHandQty: n(updated?.onHandQty ?? updated?.quantity),
          reservedQty: n(updated?.reservedQty),
          packedQty: n(updated?.packedQty),
          availableQty: n(updated?.availableQty),
        },
        userEmail: userEmail || req.user?.email || "",
      },
    });
  }

  return {
    repaired: true,
    before,
    after: {
      onHandQty: n(updated?.onHandQty ?? updated?.quantity),
      reservedQty: n(updated?.reservedQty),
      packedQty: n(updated?.packedQty),
      availableQty: n(updated?.availableQty),
    },
    diagnosis: await diagnoseOrphanedStockBuckets({ companyId, article, warehouse }),
  };
}
