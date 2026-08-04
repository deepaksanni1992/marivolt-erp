/**
 * Generic Reservation Integrity repair engine.
 *
 * Dry-run by default. Explicit apply=true (or CLI --apply) required.
 * Compensating ALLOCATION_CANCEL ledger + conditional StockBalance update.
 * Never recreates deleted business documents. Never mutates onHandQty / customs.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import mongoose from "mongoose";
import Company from "../models/Company.js";
import StockBalance from "../models/StockBalance.js";
import StockLedger from "../models/StockLedger.js";
import AuditLog from "../models/AuditLog.js";
import stockService from "./stockService.js";
import {
  calculateExpectedReservation,
  calculateExpectedPacked,
  collectRepairSafetySignals,
  validateStockBuckets,
} from "./reservationIntegrityService.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EPS = 1e-9;

function n(v) {
  return Number(v) || 0;
}
function up(v) {
  return String(v ?? "").trim().toUpperCase();
}
function s(v) {
  return String(v ?? "").trim();
}

function evidenceDir() {
  return path.resolve(__dirname, "../../scripts/repair-evidence");
}

function writeEvidence(name, payload) {
  const dir = evidenceDir();
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(dir, `${name}-${stamp}.json`);
  fs.writeFileSync(file, JSON.stringify(payload, null, 2), "utf8");
  return file;
}

function buildEffectKey({ companyCode, warehouse, article, referenceNo }) {
  return `ORPHAN_RESERVATION_REPAIR:${up(companyCode)}:${up(warehouse)}:${up(article)}:${up(referenceNo) || "NOREF"}`;
}

export { buildEffectKey };

/**
 * Diagnose a candidate orphan reserved repair for any article.
 */
export async function diagnoseReservationRepair({
  companyId,
  companyCode,
  warehouse = "MAIN",
  article,
}) {
  const code = up(article);
  const wh = up(warehouse) || "MAIN";
  let cid = companyId;
  let cCode = up(companyCode);
  if (!cid && cCode) {
    const c = await Company.findOne({
      $or: [{ code: cCode }, { companyCode: cCode }],
    })
      .select("_id code companyCode")
      .lean();
    if (!c) throw Object.assign(new Error(`Company ${cCode} not found`), { statusCode: 404 });
    cid = c._id;
    cCode = up(c.code || c.companyCode);
  }
  if (!cid || !code) {
    throw Object.assign(new Error("companyId/companyCode and article required"), { statusCode: 400 });
  }
  if (!cCode) {
    const c = await Company.findById(cid).select("code companyCode").lean();
    cCode = up(c?.code || c?.companyCode);
  }

  const balance = await StockBalance.findOne({
    companyId: cid,
    $or: [
      { article: code, location: wh },
      { article: code, warehouse: wh },
      { itemCode: code, warehouse: wh },
    ],
  }).lean();

  if (!balance) {
    throw Object.assign(new Error("StockBalance not found"), { statusCode: 404 });
  }

  const onHandQty = n(balance.onHandQty ?? balance.quantity);
  const reservedQty = Math.max(n(balance.allocatedQty), n(balance.reservedQty));
  const packedQty = n(balance.packedQty);
  const availableQty =
    balance.availableQty != null ? n(balance.availableQty) : onHandQty - reservedQty - packedQty;

  const [expectedReserved, expectedPacked, safety] = await Promise.all([
    calculateExpectedReservation(cid, wh, code),
    calculateExpectedPacked(cid, wh, code),
    collectRepairSafetySignals({ companyId: cid, warehouse: wh, article: code }),
  ]);

  const orphanReservedQty = Math.max(0, reservedQty - expectedReserved.expectedReservedQty);
  const expectedAvailableQty =
    onHandQty - expectedReserved.expectedReservedQty - expectedPacked.expectedPackedQty;

  const allocationLedgers = await StockLedger.find({
    companyId: cid,
    article: code,
    warehouse: wh,
    $or: [{ movementType: "ALLOCATION" }, { transactionType: "SALES_ALLOCATION" }],
  })
    .select("_id referenceNo qtyOut qtyIn effectKey createdAt allocationId")
    .sort({ createdAt: -1 })
    .limit(30)
    .lean();

  const cancelOrRepair = await StockLedger.find({
    companyId: cid,
    article: code,
    warehouse: wh,
    $or: [
      { movementType: "ALLOCATION_CANCEL" },
      { transactionType: "ORDER_ALLOCATION_CANCEL" },
      { effectKey: { $regex: `^ORPHAN_RESERVATION_REPAIR:${cCode}:${wh}:${code}:` } },
    ],
  })
    .select("_id referenceNo effectKey qtyIn createdAt")
    .lean();

  const refusalReasons = [];
  if (orphanReservedQty <= EPS) {
    refusalReasons.push("No orphan reserved quantity (stored reserved matches live documents)");
  }
  if (safety.hasOpenAllocation) {
    refusalReasons.push(
      `Open allocation remaining exists (${safety.expectedReservedQty}) — refuse orphan repair`
    );
  }
  if (safety.hasOpenPacking) {
    refusalReasons.push(`Open packing remaining exists (${safety.expectedPackedQty})`);
  }
  if (safety.hasDispatchInProgress) {
    refusalReasons.push("Dispatch in progress for this article/warehouse");
  }
  if (Math.abs(packedQty - expectedPacked.expectedPackedQty) > EPS) {
    refusalReasons.push("Packed bucket also mismatched — resolve packing integrity first");
  }
  if (orphanReservedQty > EPS && allocationLedgers.length === 0) {
    refusalReasons.push("Stock mismatch cannot be proven — no ALLOCATION ledger rows found");
  }

  // Prefer a single unmatched ALLOCATION ledger as provenance.
  const cancelRefs = new Set(
    cancelOrRepair.map((r) => up(r.referenceNo)).filter(Boolean)
  );
  const unmatchedAlloc = allocationLedgers.filter((r) => !cancelRefs.has(up(r.referenceNo)));
  let provenance = null;
  if (unmatchedAlloc.length === 1) {
    const row = unmatchedAlloc[0];
    provenance = {
      originalAllocationLedgerId: String(row._id),
      allocationNo: row.referenceNo || "",
      missingAllocationId: row.allocationId ? String(row.allocationId) : null,
      qtyOut: n(row.qtyOut),
    };
    if (Math.abs(n(row.qtyOut) - orphanReservedQty) > EPS) {
      refusalReasons.push(
        `Provenance ledger qtyOut=${row.qtyOut} does not equal orphan qty=${orphanReservedQty}`
      );
    }
  } else if (unmatchedAlloc.length > 1) {
    refusalReasons.push(
      `Multiple possible ALLOCATION ledger sources (${unmatchedAlloc.length}) — refuse automatic repair`
    );
  } else if (orphanReservedQty > EPS) {
    refusalReasons.push("No unmatched ALLOCATION ledger available as provenance");
  }

  const effectKey = provenance
    ? buildEffectKey({
        companyCode: cCode,
        warehouse: wh,
        article: code,
        referenceNo: provenance.allocationNo || String(balance._id),
      })
    : buildEffectKey({
        companyCode: cCode,
        warehouse: wh,
        article: code,
        referenceNo: String(balance._id),
      });

  const existingEffect = await StockLedger.findOne({ effectKey }).select("_id").lean();
  if (existingEffect) {
    return {
      repairable: false,
      alreadyRepaired: true,
      effectKey,
      existingLedgerId: String(existingEffect._id),
      message: "Idempotent: repair effectKey already exists — no stock change needed",
      snapshot: {
        onHandQty,
        reservedQty,
        packedQty,
        availableQty,
        expectedReservedQty: expectedReserved.expectedReservedQty,
        expectedPackedQty: expectedPacked.expectedPackedQty,
        expectedAvailableQty,
        orphanReservedQty,
      },
    };
  }

  const repairable = refusalReasons.length === 0 && orphanReservedQty > EPS && provenance;

  return {
    repairable: Boolean(repairable),
    alreadyRepaired: false,
    companyId: String(cid),
    companyCode: cCode,
    warehouse: wh,
    article: code,
    stockBalanceId: String(balance._id),
    refusalReasons,
    provenance,
    effectKey,
    safety,
    snapshot: {
      onHandQty,
      reservedQty,
      packedQty,
      availableQty,
      expectedReservedQty: expectedReserved.expectedReservedQty,
      expectedPackedQty: expectedPacked.expectedPackedQty,
      expectedAvailableQty,
      orphanReservedQty,
    },
    proposedAfter: {
      onHandQty,
      reservedQty: expectedReserved.expectedReservedQty,
      packedQty,
      availableQty: expectedAvailableQty,
    },
    remarks:
      provenance?.allocationNo
        ? `Administrative orphan reservation reconciliation. Original allocation ${provenance.allocationNo} was removed without stock release.`
        : "Administrative orphan reservation reconciliation without recreating deleted documents.",
    reason: provenance?.allocationNo
      ? `Legacy hard deletion of ${provenance.allocationNo} without cancelAllocation`
      : "Orphan reservedQty without live OrderAllocation hold",
  };
}

/**
 * Apply (or dry-run) a confirmed orphan reservation repair.
 */
export async function repairReservationIntegrity({
  companyId,
  companyCode,
  warehouse = "MAIN",
  article,
  apply = false,
  repairedBy = "repairReservationIntegrity",
  reason = "",
}) {
  const diagnosis = await diagnoseReservationRepair({
    companyId,
    companyCode,
    warehouse,
    article,
  });

  const mode = apply ? "apply" : "dry-run";
  const evidencePath = writeEvidence(`reservation-integrity-${mode}`, {
    mode,
    at: new Date().toISOString(),
    diagnosis,
    repairedBy,
  });

  if (diagnosis.alreadyRepaired) {
    return { ...diagnosis, applied: false, idempotent: true, evidencePath };
  }

  if (!diagnosis.repairable) {
    return {
      ...diagnosis,
      applied: false,
      idempotent: false,
      evidencePath,
      message: "Repair refused — safety / validation gates failed",
    };
  }

  if (!apply) {
    return {
      ...diagnosis,
      applied: false,
      dryRun: true,
      evidencePath,
      message: "DRY-RUN OK — pass apply:true or --apply to execute",
    };
  }

  const t = diagnosis;
  const orphanQty = n(t.snapshot.orphanReservedQty);
  const balId = new mongoose.Types.ObjectId(t.stockBalanceId);
  const cid = new mongoose.Types.ObjectId(t.companyId);
  const missingAllocId = t.provenance?.missingAllocationId
    ? new mongoose.Types.ObjectId(t.provenance.missingAllocationId)
    : null;
  const origLedgerId = t.provenance?.originalAllocationLedgerId
    ? new mongoose.Types.ObjectId(t.provenance.originalAllocationLedgerId)
    : null;

  // Re-validate immediately before write
  const live = await validateStockBuckets(t.companyId, t.warehouse, t.article, {
    persist: false,
  });
  if (live.expectedReservedQty > EPS) {
    throw Object.assign(
      new Error("Abort: open allocation appeared before apply"),
      { statusCode: 409 }
    );
  }
  if (Math.abs(live.reservedQty - orphanQty) > EPS) {
    throw Object.assign(
      new Error(
        `Abort: reservedQty changed (now ${live.reservedQty}, expected orphan ${orphanQty})`
      ),
      { statusCode: 409 }
    );
  }

  const session = await mongoose.startSession();
  let result;
  try {
    await session.withTransaction(async () => {
      const existing = await StockLedger.findOne({ effectKey: t.effectKey }).session(session).lean();
      if (existing) {
        result = {
          applied: false,
          idempotent: true,
          compensatingLedgerId: String(existing._id),
          message: "effectKey appeared concurrently — no stock change",
        };
        return;
      }

      const targetReserved = n(t.proposedAfter.reservedQty);
      const targetAvailable = n(t.proposedAfter.availableQty);

      const updateRes = await StockBalance.updateOne(
        {
          _id: balId,
          companyId: cid,
          reservedQty: orphanQty,
          packedQty: n(t.snapshot.packedQty),
        },
        {
          $set: {
            reservedQty: targetReserved,
            allocatedQty: targetReserved,
            availableQty: targetAvailable,
          },
        },
        { session }
      );

      if (updateRes.matchedCount !== 1) {
        throw new Error(
          `Conditional StockBalance update matchedCount=${updateRes.matchedCount} (expected 1). Aborting.`
        );
      }

      const afterSnap = await stockService.getStockBalance({
        companyId: cid,
        article: t.article,
        warehouse: t.warehouse,
        session,
      });

      const ledgerDoc = await stockService.createStockLedgerEntry({
        session,
        companyId: cid,
        movementType: stockService.MOVEMENT_TYPES.ALLOCATION_CANCEL,
        article: t.article,
        warehouse: t.warehouse,
        qtyIn: orphanQty,
        qtyOut: 0,
        referenceType: "ORDER_ALLOCATION_CANCEL",
        referenceNo: t.provenance?.allocationNo || t.effectKey,
        remarks: t.remarks,
        createdBy: repairedBy,
        sourceModule: "ADMIN_REPAIR",
        effectKey: t.effectKey,
        allocationId: missingAllocId,
        sourceAllocationId: missingAllocId,
        reversedFromLedgerId: origLedgerId,
        onHandAfter: afterSnap.onHandQty,
        allocatedAfter: afterSnap.allocatedQty,
        packedAfter: afterSnap.packedQty,
        availableAfter: afterSnap.availableQty,
        dispatchedAfter: afterSnap.dispatchedQty,
      });

      await AuditLog.create(
        [
          {
            companyId: cid,
            userEmail: repairedBy,
            userName: repairedBy,
            action: "ORPHAN_RESERVATION_REPAIRED",
            module: "STOCK",
            entityType: "StockBalance",
            entityId: t.stockBalanceId,
            documentNo: t.provenance?.allocationNo || t.article,
            description: `Orphan reservation repaired for ${t.article} / ${t.warehouse}: reservedQty ${orphanQty} → ${targetReserved}`,
            beforeData: {
              onHandQty: t.snapshot.onHandQty,
              reservedQty: t.snapshot.reservedQty,
              packedQty: t.snapshot.packedQty,
              availableQty: t.snapshot.availableQty,
            },
            afterData: {
              onHandQty: t.proposedAfter.onHandQty,
              reservedQty: t.proposedAfter.reservedQty,
              packedQty: t.proposedAfter.packedQty,
              availableQty: t.proposedAfter.availableQty,
            },
            metadata: {
              reason: s(reason) || t.reason,
              repairedBy,
              effectKey: t.effectKey,
              provenance: t.provenance,
              compensatingLedgerId: String(ledgerDoc._id),
              orphanQty,
            },
          },
        ],
        { session }
      );

      result = {
        applied: true,
        idempotent: false,
        matchedCount: updateRes.matchedCount,
        modifiedCount: updateRes.modifiedCount,
        compensatingLedgerId: String(ledgerDoc._id),
        effectKey: t.effectKey,
        before: {
          onHandQty: t.snapshot.onHandQty,
          reservedQty: t.snapshot.reservedQty,
          packedQty: t.snapshot.packedQty,
          availableQty: t.snapshot.availableQty,
        },
        after: {
          onHandQty: afterSnap.onHandQty,
          reservedQty: afterSnap.reservedQty,
          packedQty: afterSnap.packedQty,
          availableQty: afterSnap.availableQty,
        },
      };
    });
  } finally {
    session.endSession();
  }

  const verification = await validateStockBuckets(t.companyId, t.warehouse, t.article, {
    persist: true,
  });

  const out = {
    ...diagnosis,
    ...result,
    verification: {
      onHandQty: verification.onHandQty,
      reservedQty: verification.reservedQty,
      packedQty: verification.packedQty,
      availableQty: verification.availableQty,
      expectedReservedQty: verification.expectedReservedQty,
      expectedPackedQty: verification.expectedPackedQty,
      expectedAvailableQty: verification.expectedAvailableQty,
      openAllocationRemaining: verification.expectedReservedQty,
      healthy: verification.ok,
      issues: verification.issues.map((i) => i.issueType),
    },
    evidencePath,
  };

  writeEvidence("reservation-integrity-apply-result", out);
  return out;
}

export default {
  diagnoseReservationRepair,
  repairReservationIntegrity,
  buildEffectKey,
};
