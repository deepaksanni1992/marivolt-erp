/**
 * ============================================================================
 * COMPLETED ONE-OFF REPAIR — DO NOT REUSE
 * ============================================================================
 * Article: 8X0098 / MAR / MAIN / MAR-ALLOC-0012
 * Applied successfully on 2026-08-04. Evidence retained under scripts/repair-evidence/.
 *
 * Future orphan reservation repairs MUST use the generic engine:
 *   npm run repair:reservation-integrity:dry-run -- --company=CODE --warehouse=WH --article=ART
 *   npm run repair:reservation-integrity:apply -- --company=CODE --warehouse=WH --article=ART --apply
 *
 * This file is archived for historical audit only.
 * ============================================================================
 *
 * Controlled one-time orphan reservation repair for MAR / MAIN / 8X0098.
 *
 * Default: READ-ONLY dry-run (validates only; never writes).
 * Apply:   node scripts/repairOrphanReservation.8X0098.mjs --apply
 *
 * Does NOT recreate deleted OrderAllocation / OA.
 * Does NOT touch onHandQty, packedQty, or customs quantities.
 * Does NOT run company-wide reconcile.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import mongoose from "mongoose";
import "../../src/loadEnv.js";
import Company from "../../src/models/Company.js";
import StockBalance from "../../src/models/StockBalance.js";
import StockLedger from "../../src/models/StockLedger.js";
import OrderAllocation from "../../src/models/OrderAllocation.js";
import StorePacking from "../../src/models/StorePacking.js";
import AuditLog from "../../src/models/AuditLog.js";
import stockService from "../../src/services/stockService.js";
import {
  ALLOCATION_STATUSES_HOLDING_RESERVED,
  allocationLineRemainingReserved,
} from "../../src/services/stockBucketIntegrityService.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Hard-coded target — do not broaden. */
export const TARGET = Object.freeze({
  companyCode: "MAR",
  warehouse: "MAIN",
  article: "8X0098",
  stockBalanceId: "6a54ceccfa2faadf84deb2a0",
  missingAllocationId: "6a54cecb436e67731e3fa972",
  allocationNo: "MAR-ALLOC-0012",
  orphanQty: 9,
  originalAllocationLedgerId: "6a54cecc436e67731e3fa977",
  expectedOnHand: 9,
  expectedReservedBefore: 9,
  expectedPacked: 0,
  effectKey: "ORPHAN_RESERVATION_REPAIR:MAR:MAIN:8X0098:MAR-ALLOC-0012",
  remarks:
    "Administrative orphan reservation reconciliation. Original allocation MAR-ALLOC-0012 was hard-deleted by legacy customer transaction cleanup without stock release.",
  reason: "Legacy hard deletion of MAR-ALLOC-0012 without cancelAllocation",
});

const EPS = 1e-9;

function n(v) {
  return Number(v) || 0;
}

function fail(checks, msg) {
  checks.push({ ok: false, message: msg });
}

function pass(checks, msg, detail = null) {
  checks.push({ ok: true, message: msg, detail });
}

function derivedAvailable(row) {
  const onHand = n(row?.onHandQty ?? row?.quantity);
  const reserved = Math.max(n(row?.allocatedQty), n(row?.reservedQty));
  const packed = n(row?.packedQty);
  return onHand - reserved - packed;
}

/**
 * Read-only validation of the hard-coded orphan case.
 * @returns {{ ok: boolean, checks: object[], snapshot: object, alreadyRepaired: boolean }}
 */
export async function validateOrphanReservationCase(companyId) {
  const checks = [];
  const t = TARGET;
  const balId = new mongoose.Types.ObjectId(t.stockBalanceId);
  const origLedgerId = new mongoose.Types.ObjectId(t.originalAllocationLedgerId);
  const missingAllocId = new mongoose.Types.ObjectId(t.missingAllocationId);

  const balance = await StockBalance.findById(balId).lean();
  if (!balance) {
    fail(checks, `StockBalance ${t.stockBalanceId} not found`);
  } else {
    const companyOk = String(balance.companyId) === String(companyId);
    const wh = String(balance.warehouse || balance.location || "").toUpperCase();
    const article = String(balance.article || balance.itemCode || "").toUpperCase();
    if (!companyOk) fail(checks, `StockBalance companyId mismatch`);
    else pass(checks, "StockBalance company = MAR");
    if (wh !== t.warehouse) fail(checks, `warehouse=${wh} expected MAIN`);
    else pass(checks, "StockBalance warehouse = MAIN");
    if (article !== t.article) fail(checks, `article=${article} expected 8X0098`);
    else pass(checks, "StockBalance article = 8X0098");
    if (Math.abs(n(balance.onHandQty ?? balance.quantity) - t.expectedOnHand) > EPS) {
      fail(checks, `onHandQty=${balance.onHandQty} expected 9`);
    } else pass(checks, "onHandQty = 9");
    if (Math.abs(n(balance.packedQty) - t.expectedPacked) > EPS) {
      fail(checks, `packedQty=${balance.packedQty} expected 0`);
    } else pass(checks, "packedQty = 0");
  }

  const existingRepair = await StockLedger.findOne({ effectKey: t.effectKey }).lean();
  if (existingRepair) {
    pass(checks, "Idempotent: repair effectKey already exists", {
      ledgerId: String(existingRepair._id),
    });
    return {
      ok: true,
      alreadyRepaired: true,
      checks,
      snapshot: {
        balance,
        existingRepair,
        openAllocationRemaining: 0,
        orphanQty: 0,
      },
    };
  }

  // reservedQty must still be 9 if not yet repaired
  if (balance) {
    if (Math.abs(n(balance.reservedQty) - t.expectedReservedBefore) > EPS) {
      fail(checks, `reservedQty=${balance.reservedQty} expected 9 (pre-repair)`);
    } else pass(checks, "reservedQty = 9 (pre-repair)");
  }

  const holdingStatuses = [...ALLOCATION_STATUSES_HOLDING_RESERVED];
  const openAllocs = await OrderAllocation.find({
    companyId,
    status: { $in: holdingStatuses },
    "lines.article": t.article,
  })
    .select("allocationNo status warehouse lines")
    .lean();

  let openAllocationRemaining = 0;
  for (const a of openAllocs) {
    for (const line of a.lines || []) {
      if (String(line.article || "").toUpperCase() !== t.article) continue;
      openAllocationRemaining += allocationLineRemainingReserved(line);
    }
  }
  if (openAllocs.length > 0 || openAllocationRemaining > EPS) {
    fail(
      checks,
      `Active OrderAllocation holding 8X0098 found (docs=${openAllocs.length}, remaining=${openAllocationRemaining})`
    );
  } else {
    pass(checks, "Zero active OrderAllocation lines holding 8X0098");
  }

  const packingDocs = await StorePacking.find({
    companyId,
    status: { $nin: ["CANCELLED", "REVERSED"] },
    "lines.article": t.article,
  })
    .select("packingNo status lines")
    .lean();
  const packingHold = packingDocs.reduce((sum, p) => {
    for (const line of p.lines || []) {
      if (String(line.article || "").toUpperCase() !== t.article) continue;
      sum += Math.max(0, n(line.qty ?? line.packedQty));
    }
    return sum;
  }, 0);
  if (packingDocs.length > 0 || packingHold > EPS) {
    fail(checks, `Packing holding 8X0098 found (docs=${packingDocs.length}, qty=${packingHold})`);
  } else {
    pass(checks, "Zero packing lines holding 8X0098");
  }

  const originalLedger = await StockLedger.findById(origLedgerId).lean();
  if (!originalLedger) {
    fail(checks, `Original ALLOCATION ledger ${t.originalAllocationLedgerId} not found`);
  } else {
    const mt = String(originalLedger.movementType || "").toUpperCase();
    const tt = String(originalLedger.transactionType || "").toUpperCase();
    const isAlloc = mt === "ALLOCATION" || tt === "SALES_ALLOCATION";
    if (!isAlloc) fail(checks, `Original ledger movementType/transactionType not ALLOCATION (${mt}/${tt})`);
    else pass(checks, "Original ledger movementType = ALLOCATION");
    if (String(originalLedger.referenceNo || "").trim() !== t.allocationNo) {
      fail(checks, `Original ledger referenceNo=${originalLedger.referenceNo} expected MAR-ALLOC-0012`);
    } else pass(checks, "Original ledger referenceNo = MAR-ALLOC-0012");
    if (Math.abs(n(originalLedger.qtyOut) - t.orphanQty) > EPS) {
      fail(checks, `Original ledger qtyOut=${originalLedger.qtyOut} expected 9`);
    } else pass(checks, "Original ledger qtyOut = 9");
  }

  const cancelOrRepair = await StockLedger.find({
    companyId,
    $or: [
      {
        referenceNo: t.allocationNo,
        $or: [
          { movementType: "ALLOCATION_CANCEL" },
          { transactionType: "ORDER_ALLOCATION_CANCEL" },
        ],
      },
      { effectKey: t.effectKey },
      {
        referenceNo: t.allocationNo,
        remarks: /orphan reservation reconciliation/i,
      },
    ],
  })
    .select("_id movementType transactionType effectKey referenceNo remarks createdAt")
    .lean();

  if (cancelOrRepair.length) {
    fail(
      checks,
      `Existing ALLOCATION_CANCEL / orphan-repair ledger already present for MAR-ALLOC-0012 (${cancelOrRepair.length} row(s))`
    );
  } else {
    pass(checks, "No existing ALLOCATION_CANCEL or orphan-repair ledger for MAR-ALLOC-0012");
  }

  if (Math.abs(openAllocationRemaining) > EPS) {
    fail(checks, `Expected reserved from active docs = ${openAllocationRemaining}, want 0`);
  } else {
    pass(checks, "Expected reserved from active documents = 0");
  }

  const orphanQty = balance
    ? Math.max(0, Math.max(n(balance.reservedQty), n(balance.allocatedQty)) - openAllocationRemaining)
    : 0;
  if (Math.abs(orphanQty - t.orphanQty) > EPS) {
    fail(checks, `orphanQty=${orphanQty} expected exactly 9`);
  } else {
    pass(checks, "Orphan quantity is exactly 9");
  }

  // Confirm deleted allocation is still absent (do not recreate)
  const ghostAlloc = await OrderAllocation.findById(missingAllocId).lean();
  if (ghostAlloc) {
    fail(checks, `Allocation ${t.missingAllocationId} unexpectedly still exists — abort (manual review)`);
  } else {
    pass(checks, "Missing allocation document remains absent (will not recreate)");
  }

  const ok = checks.every((c) => c.ok);
  return {
    ok,
    alreadyRepaired: false,
    checks,
    snapshot: {
      balance,
      originalLedger,
      openAllocs,
      packingDocs,
      openAllocationRemaining,
      orphanQty,
      availableBefore: balance ? derivedAvailable(balance) : null,
      missingAllocationId: t.missingAllocationId,
      effectKey: t.effectKey,
    },
  };
}

async function verifyAfterRepair(companyId) {
  const t = TARGET;
  const balance = await StockBalance.findById(t.stockBalanceId).lean();
  const repairLedgers = await StockLedger.find({ effectKey: t.effectKey }).lean();
  const holdingStatuses = [...ALLOCATION_STATUSES_HOLDING_RESERVED];
  const openAllocs = await OrderAllocation.find({
    companyId,
    status: { $in: holdingStatuses },
    "lines.article": t.article,
  })
    .select("lines")
    .lean();
  let openAllocationRemaining = 0;
  for (const a of openAllocs) {
    for (const line of a.lines || []) {
      if (String(line.article || "").toUpperCase() !== t.article) continue;
      openAllocationRemaining += allocationLineRemainingReserved(line);
    }
  }
  const available = balance ? derivedAvailable(balance) : null;
  return {
    balance: balance
      ? {
          _id: String(balance._id),
          onHandQty: n(balance.onHandQty ?? balance.quantity),
          reservedQty: n(balance.reservedQty),
          allocatedQty: n(balance.allocatedQty),
          packedQty: n(balance.packedQty),
          availableQty: available,
          storedAvailableQty: balance.availableQty,
        }
      : null,
    openAllocationRemaining,
    repairLedgerCount: repairLedgers.length,
    repairLedgerIds: repairLedgers.map((r) => String(r._id)),
    expectationsMet: Boolean(
      balance &&
        Math.abs(n(balance.onHandQty ?? balance.quantity) - 9) < EPS &&
        Math.abs(n(balance.reservedQty)) < EPS &&
        Math.abs(n(balance.packedQty)) < EPS &&
        Math.abs(available - 9) < EPS &&
        Math.abs(openAllocationRemaining) < EPS &&
        repairLedgers.length === 1
    ),
  };
}

/**
 * Apply repair inside session.withTransaction. Idempotent via effectKey.
 */
export async function applyOrphanReservationRepair(companyId, { repairedBy = "repairOrphanReservation.8X0098.mjs" } = {}) {
  const t = TARGET;
  const pre = await validateOrphanReservationCase(companyId);
  if (pre.alreadyRepaired) {
    const verification = await verifyAfterRepair(companyId);
    return {
      applied: false,
      idempotent: true,
      message: "Repair effectKey already present — no stock change",
      validation: pre,
      verification,
    };
  }
  if (!pre.ok) {
    const err = new Error("Validation failed — repair aborted");
    err.validation = pre;
    throw err;
  }

  const balId = new mongoose.Types.ObjectId(t.stockBalanceId);
  const missingAllocId = new mongoose.Types.ObjectId(t.missingAllocationId);
  const origLedgerId = new mongoose.Types.ObjectId(t.originalAllocationLedgerId);

  const session = await mongoose.startSession();
  let result;
  try {
    await session.withTransaction(async () => {
      // Re-check idempotency inside the transaction
      const existing = await StockLedger.findOne({ effectKey: t.effectKey }).session(session).lean();
      if (existing) {
        result = {
          applied: false,
          idempotent: true,
          message: "Repair effectKey appeared concurrently — no stock change",
          ledgerId: String(existing._id),
        };
        return;
      }

      const updateRes = await StockBalance.updateOne(
        {
          _id: balId,
          companyId,
          article: t.article,
          reservedQty: t.orphanQty,
          packedQty: 0,
        },
        {
          $set: {
            reservedQty: 0,
            allocatedQty: 0,
            availableQty: t.expectedOnHand, // onHand 9 − reserved 0 − packed 0
            // do not touch onHandQty / quantity / packedQty
          },
        },
        { session }
      );

      if (updateRes.matchedCount !== 1) {
        throw new Error(
          `Conditional StockBalance update matchedCount=${updateRes.matchedCount} (expected 1). Aborting.`
        );
      }
      if (updateRes.modifiedCount !== 1) {
        throw new Error(
          `Conditional StockBalance update modifiedCount=${updateRes.modifiedCount} (expected 1). Aborting.`
        );
      }

      const afterSnap = await stockService.getStockBalance({
        companyId,
        article: t.article,
        warehouse: t.warehouse,
        session,
      });

      const ledgerDoc = await stockService.createStockLedgerEntry({
        session,
        companyId,
        movementType: stockService.MOVEMENT_TYPES.ALLOCATION_CANCEL,
        article: t.article,
        warehouse: t.warehouse,
        qtyIn: t.orphanQty,
        qtyOut: 0,
        referenceType: "ORDER_ALLOCATION_CANCEL",
        referenceNo: t.allocationNo,
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
            companyId,
            userEmail: repairedBy,
            userName: repairedBy,
            action: "ORPHAN_RESERVATION_REPAIRED",
            module: "STOCK",
            entityType: "StockBalance",
            entityId: t.stockBalanceId,
            documentNo: t.allocationNo,
            description: `Orphan reservation repaired for ${t.article} / ${t.warehouse}: reservedQty 9 → 0`,
            beforeData: {
              onHandQty: 9,
              reservedQty: 9,
              packedQty: 0,
              availableQty: 0,
            },
            afterData: {
              onHandQty: 9,
              reservedQty: 0,
              packedQty: 0,
              availableQty: 9,
            },
            metadata: {
              reason: t.reason,
              repairedBy,
              stockBalanceId: t.stockBalanceId,
              missingAllocationId: t.missingAllocationId,
              allocationNo: t.allocationNo,
              originalAllocationLedgerId: t.originalAllocationLedgerId,
              compensatingLedgerId: String(ledgerDoc._id),
              effectKey: t.effectKey,
              orphanQty: t.orphanQty,
            },
          },
        ],
        { session }
      );

      result = {
        applied: true,
        idempotent: false,
        stockBalanceId: t.stockBalanceId,
        matchedCount: updateRes.matchedCount,
        modifiedCount: updateRes.modifiedCount,
        compensatingLedgerId: String(ledgerDoc._id),
        effectKey: t.effectKey,
        before: pre.snapshot.balance
          ? {
              onHandQty: n(pre.snapshot.balance.onHandQty ?? pre.snapshot.balance.quantity),
              reservedQty: n(pre.snapshot.balance.reservedQty),
              allocatedQty: n(pre.snapshot.balance.allocatedQty),
              packedQty: n(pre.snapshot.balance.packedQty),
              availableQty: derivedAvailable(pre.snapshot.balance),
            }
          : null,
        after: {
          onHandQty: afterSnap.onHandQty,
          reservedQty: afterSnap.reservedQty,
          allocatedQty: afterSnap.allocatedQty,
          packedQty: afterSnap.packedQty,
          availableQty: afterSnap.availableQty,
        },
      };
    });
  } finally {
    session.endSession();
  }

  const verification = await verifyAfterRepair(companyId);
  return { ...result, validation: pre, verification };
}

function parseArgs(argv) {
  return {
    apply: argv.includes("--apply"),
    help: argv.includes("--help") || argv.includes("-h"),
  };
}

function writeEvidence(payload) {
  const dir = path.join(__dirname, "repair-evidence");
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(dir, `orphan-8x0098-${payload.mode}-${stamp}.json`);
  fs.writeFileSync(file, JSON.stringify(payload, null, 2), "utf8");
  return file;
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log(`Usage:
  node scripts/repairOrphanReservation.8X0098.mjs           # dry-run (default)
  node scripts/repairOrphanReservation.8X0098.mjs --apply   # execute repair
`);
    process.exit(0);
  }

  if (!process.env.MONGO_URI) throw new Error("MONGO_URI missing");
  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 20000 });

  const company = await Company.findOne({ code: TARGET.companyCode }).lean();
  if (!company?._id) throw new Error("Company MAR not found");

  console.log("=== TARGET ===");
  console.log(JSON.stringify(TARGET, null, 2));
  console.log(`\nMode: ${args.apply ? "APPLY" : "DRY-RUN (read-only)"}`);

  try {
    if (!args.apply) {
      const validation = await validateOrphanReservationCase(company._id);
      console.log("\n=== VALIDATION CHECKS ===");
      for (const c of validation.checks) {
        console.log(`${c.ok ? "PASS" : "FAIL"} — ${c.message}`);
      }
      console.log("\n=== SNAPSHOT (before) ===");
      console.log(
        JSON.stringify(
          {
            alreadyRepaired: validation.alreadyRepaired,
            ok: validation.ok,
            balance: validation.snapshot.balance
              ? {
                  _id: String(validation.snapshot.balance._id),
                  onHandQty: n(validation.snapshot.balance.onHandQty ?? validation.snapshot.balance.quantity),
                  reservedQty: n(validation.snapshot.balance.reservedQty),
                  allocatedQty: n(validation.snapshot.balance.allocatedQty),
                  packedQty: n(validation.snapshot.balance.packedQty),
                  availableQty: derivedAvailable(validation.snapshot.balance),
                }
              : null,
            openAllocationRemaining: validation.snapshot.openAllocationRemaining,
            orphanQty: validation.snapshot.orphanQty,
            originalLedgerId: validation.snapshot.originalLedger
              ? String(validation.snapshot.originalLedger._id)
              : null,
            proposedAfter: validation.ok
              ? { onHandQty: 9, reservedQty: 0, packedQty: 0, availableQty: 9 }
              : null,
          },
          null,
          2
        )
      );

      const evidencePath = writeEvidence({
        mode: "dry-run",
        at: new Date().toISOString(),
        target: TARGET,
        validation,
      });
      console.log(`\nEvidence written: ${evidencePath}`);
      if (!validation.ok && !validation.alreadyRepaired) {
        console.error("\nDRY-RUN FAILED validation — do not apply.");
        process.exitCode = 2;
      } else {
        console.log("\nDRY-RUN OK — ready for --apply when explicitly approved.");
      }
      return;
    }

    console.log("\n=== APPLYING REPAIR ===");
    const outcome = await applyOrphanReservationRepair(company._id);
    console.log("\n=== BEFORE / AFTER ===");
    console.log(JSON.stringify({ before: outcome.before, after: outcome.after, applied: outcome.applied, idempotent: outcome.idempotent }, null, 2));
    console.log("\n=== VERIFICATION ===");
    console.log(JSON.stringify(outcome.verification, null, 2));

    const evidencePath = writeEvidence({
      mode: "apply",
      at: new Date().toISOString(),
      target: TARGET,
      outcome,
    });
    console.log(`\nEvidence written: ${evidencePath}`);

    if (!outcome.verification?.expectationsMet && !outcome.idempotent) {
      console.error("\nPost-repair verification FAILED");
      process.exitCode = 3;
    } else {
      console.log("\nRepair complete / idempotent success.");
    }
  } finally {
    await mongoose.disconnect();
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    console.error(err);
    if (err.validation) {
      console.error("Validation detail:", JSON.stringify(err.validation.checks, null, 2));
    }
    process.exit(1);
  });
}
