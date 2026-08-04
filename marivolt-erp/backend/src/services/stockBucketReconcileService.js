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
import {
  ALLOCATION_STATUSES_HOLDING_RESERVED,
  PACKING_STATUSES_HOLDING_PACKED,
  computeExpectedReservedFromAllocations,
  computeExpectedPackedFromPackings,
} from "./stockExpectedBuckets.js";

function n(v) {
  return Number(v) || 0;
}
function up(v) {
  return String(v ?? "").trim().toUpperCase();
}

/**
 * Expected reserved / packed via shared stockExpectedBuckets helpers
 * (same formula as Reservation Integrity and Stock Bucket Integrity).
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
    status: { $in: [...ALLOCATION_STATUSES_HOLDING_RESERVED] },
    "lines.article": code,
  })
    .select("allocationNo status customerName lines companyId warehouse")
    .lean();

  const { expectedReservedQty, documents: reservedDocs } = computeExpectedReservedFromAllocations(
    allocations,
    { article: code }
  );
  const allocationEvidence = reservedDocs.map((d) => ({
    allocationNo: d.number,
    status: d.status,
    customerName: d.customerName,
    holdQty: d.qty,
  }));

  const packings = await StorePacking.find({
    companyId,
    warehouse: wh,
    status: { $in: [...PACKING_STATUSES_HOLDING_PACKED] },
    "lines.article": code,
  })
    .select("packingNo status lines companyId warehouse allocationNo")
    .lean();

  const { expectedPackedQty: expectedPackedFromDocs, documents: packedDocs } =
    computeExpectedPackedFromPackings(packings, { article: code });
  const packingEvidence = packedDocs.map((d) => ({
    packingNo: d.number,
    status: d.status,
    packQty: d.qty,
  }));

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
