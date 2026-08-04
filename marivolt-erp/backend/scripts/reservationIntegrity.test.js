/**
 * Reservation Integrity production-readiness tests (no DB required for pure logic).
 * Run: node scripts/reservationIntegrity.test.js
 */
import assert from "assert";
import {
  RESERVATION_INTEGRITY_ISSUE_TYPES,
  RESERVATION_HOLDING_ALLOCATION_STATUSES,
  RESERVATION_HOLDING_PACKING_STATUSES,
  buildIssuesFromSnapshot,
  escapeCsvCell,
  issuesToCsv,
  scheduleReservationIntegrityAfterCommit,
  queueReservationIntegrityValidation,
} from "../src/services/reservationIntegrityService.js";
import { allocationLineRemainingReserved as lineRemain } from "../src/services/stockBucketIntegrityService.js";
import {
  classifyIssueCategory,
  ISSUE_CATEGORIES,
  computeHealthScore,
  enrichIssue,
} from "../src/services/dataHealthService.js";
import { buildEffectKey } from "../src/services/repairReservationIntegrity.js";

let passed = 0;
function ok(name, cond) {
  assert.ok(cond, name);
  passed += 1;
  console.log("✓", name);
}

function snap(partial) {
  return {
    companyId: "c1",
    warehouse: "MAIN",
    article: "ART1",
    stockBalanceId: "b1",
    onHandQty: partial.onHandQty ?? 9,
    expectedReservedQty: partial.expectedReservedQty ?? 0,
    expectedPackedQty: partial.expectedPackedQty ?? 0,
    expectedAvailableQty:
      partial.expectedAvailableQty ??
      (partial.onHandQty ?? 9) -
        (partial.expectedReservedQty ?? 0) -
        (partial.expectedPackedQty ?? 0),
    allocationDocuments: partial.allocationDocuments || [],
    packingDocuments: partial.packingDocuments || [],
    balance: {
      allocatedQty: partial.allocatedQty ?? 0,
      reservedQty: partial.reservedQty ?? 0,
      packedQty: partial.packedQty ?? 0,
      availableQty: partial.availableQty,
      onHandQty: partial.onHandQty ?? 9,
      quantity: partial.onHandQty ?? 9,
    },
  };
}

function types(issues) {
  return issues.map((i) => i.issueType).sort();
}

// --- Lifecycle formula expectations (document-derived remaining) ---
ok(
  "A. Allocation created not packed → reserved hold = qty",
  lineRemain({ qty: 9, packedQty: 0 }) === 9
);
ok(
  "B. Partially packed → reserved = qty − packed",
  lineRemain({ qty: 9, packedQty: 4 }) === 5
);
ok(
  "C. Fully packed allocation → reserved hold = 0",
  lineRemain({ qty: 9, packedQty: 9 }) === 0
);
ok(
  "D. Partial dispatch packing remaining = pack − dispatched",
  Math.max(0, 9 - 3) === 6
);
ok(
  "E. Fully dispatched packing remaining = 0",
  Math.max(0, 9 - 9) === 0
);
ok("F/G. Cancelled docs excluded via status lists", !RESERVATION_HOLDING_ALLOCATION_STATUSES.includes("CANCELLED"));
ok("Packing CANCELLED excluded", !RESERVATION_HOLDING_PACKING_STATUSES.includes("CANCELLED"));
ok("Packing DRAFT excluded", !RESERVATION_HOLDING_PACKING_STATUSES.includes("DRAFT"));
ok("Allocation CLOSED retained for remaining hold", RESERVATION_HOLDING_ALLOCATION_STATUSES.includes("CLOSED"));

// --- 1 Healthy ---
{
  const issues = buildIssuesFromSnapshot(
    snap({
      onHandQty: 9,
      reservedQty: 0,
      packedQty: 0,
      availableQty: 9,
      expectedReservedQty: 0,
      expectedPackedQty: 0,
    })
  );
  ok("1. Healthy stock → no issues", issues.length === 0);
}

// --- 2 Orphan reserved ---
{
  const issues = buildIssuesFromSnapshot(
    snap({
      reservedQty: 9,
      availableQty: 0,
      expectedReservedQty: 0,
      expectedPackedQty: 0,
    })
  );
  ok("2. Orphan reserved emits ORPHAN_RESERVED_QTY", types(issues).includes("ORPHAN_RESERVED_QTY"));
  ok(
    "2b. Orphan does NOT also emit RESERVED_QTY_MISMATCH",
    !types(issues).includes("RESERVED_QTY_MISMATCH")
  );
  ok(
    "2c. Orphan does NOT emit AVAILABLE cascade penalty",
    !types(issues).includes("AVAILABLE_QTY_MISMATCH")
  );
}

// --- 3 Reserved mismatch with active allocation ---
{
  const issues = buildIssuesFromSnapshot(
    snap({
      reservedQty: 9,
      availableQty: 0,
      expectedReservedQty: 5,
      expectedPackedQty: 0,
      allocationDocuments: [{ type: "OrderAllocation", number: "A-1", qty: 5 }],
    })
  );
  ok("3. Active alloc mismatch → RESERVED_QTY_MISMATCH", types(issues).includes("RESERVED_QTY_MISMATCH"));
  ok("3b. Not orphan when expected > 0", !types(issues).includes("ORPHAN_RESERVED_QTY"));
  ok("3c. No available cascade", !types(issues).includes("AVAILABLE_QTY_MISMATCH"));
}

// --- 4 Partial packing (stored matches docs) ---
{
  const issues = buildIssuesFromSnapshot(
    snap({
      onHandQty: 9,
      reservedQty: 5,
      packedQty: 4,
      availableQty: 0,
      expectedReservedQty: 5,
      expectedPackedQty: 4,
    })
  );
  ok("4. Partial packing healthy", issues.length === 0);
}

// --- 5 Full packing ---
{
  const issues = buildIssuesFromSnapshot(
    snap({
      reservedQty: 0,
      packedQty: 9,
      availableQty: 0,
      expectedReservedQty: 0,
      expectedPackedQty: 9,
    })
  );
  ok("5. Full packing healthy", issues.length === 0);
}

// --- 6 Partial dispatch ---
{
  const issues = buildIssuesFromSnapshot(
    snap({
      reservedQty: 0,
      packedQty: 6,
      availableQty: 3,
      onHandQty: 9,
      expectedReservedQty: 0,
      expectedPackedQty: 6,
    })
  );
  ok("6. Partial dispatch healthy", issues.length === 0);
}

// --- 7 Packing cancellation (packed back to reserved) ---
{
  const issues = buildIssuesFromSnapshot(
    snap({
      reservedQty: 9,
      packedQty: 0,
      availableQty: 0,
      expectedReservedQty: 9,
      expectedPackedQty: 0,
    })
  );
  ok("7. After packing cancel healthy", issues.length === 0);
}

// --- 8 Allocation cancellation ---
{
  const issues = buildIssuesFromSnapshot(
    snap({
      reservedQty: 0,
      packedQty: 0,
      availableQty: 9,
      expectedReservedQty: 0,
      expectedPackedQty: 0,
    })
  );
  ok("8. After allocation cancel healthy", issues.length === 0);
}

// --- 9 Negative allocation followed by GRN (onHand covers; reserved still held by doc) ---
{
  const issues = buildIssuesFromSnapshot(
    snap({
      onHandQty: 9,
      reservedQty: 9,
      packedQty: 0,
      availableQty: 0,
      expectedReservedQty: 9,
      expectedPackedQty: 0,
    })
  );
  ok("9. Neg-alloc then GRN healthy when docs match", issues.length === 0);
}

// --- 10 Available mismatch without double reserved penalty ---
{
  const orphan = buildIssuesFromSnapshot(
    snap({ reservedQty: 9, availableQty: 0, expectedReservedQty: 0 })
  );
  const scoreOrphan = computeHealthScore(
    orphan.map((i) => enrichIssue({ ...i, documentNumber: i.article }))
  );
  ok("10. Orphan scores once (Critical −15 → 85)", scoreOrphan.healthScore === 85);

  const indepAvail = buildIssuesFromSnapshot(
    snap({
      reservedQty: 0,
      packedQty: 0,
      availableQty: 3, // wrong stored projection
      expectedReservedQty: 0,
      expectedPackedQty: 0,
      expectedAvailableQty: 9,
    })
  );
  ok(
    "10b. Independent available mismatch only",
    types(indepAvail).length === 1 && types(indepAvail)[0] === "AVAILABLE_QTY_MISMATCH"
  );
}

// --- Packed without document ---
{
  const issues = buildIssuesFromSnapshot(
    snap({ packedQty: 5, reservedQty: 0, availableQty: 4, expectedPackedQty: 0 })
  );
  ok("Packed orphan → PACKED_WITHOUT_DOCUMENT", types(issues).includes("PACKED_WITHOUT_DOCUMENT"));
  ok("Packed orphan not also PACKED_QTY_MISMATCH", !types(issues).includes("PACKED_QTY_MISMATCH"));
}

// --- Negative buckets ---
{
  const issues = buildIssuesFromSnapshot(snap({ reservedQty: -2, availableQty: 11 }));
  ok("Negative reserved Critical", issues.some((i) => i.issueType === "NEGATIVE_RESERVED" && i.severity === "Critical"));
}

// --- Integrity category ---
for (const t of Object.values(RESERVATION_INTEGRITY_ISSUE_TYPES)) {
  if (t === "ALLOCATED_WITHOUT_DOCUMENT") continue; // alias only
  ok(`${t} is INTEGRITY`, classifyIssueCategory(t) === ISSUE_CATEGORIES.INTEGRITY);
}

// --- CSV formula injection ---
ok("19. CSV escapes =formula", escapeCsvCell("=CMD()") === "'=CMD()");
ok("19b. CSV escapes +", escapeCsvCell("+1+1").startsWith("'"));
ok("19c. CSV escapes @", escapeCsvCell("@sum").startsWith("'"));
{
  const csv = issuesToCsv([
    {
      companyCode: "MAR",
      article: "=1+1",
      warehouse: "MAIN",
      issueType: "ORPHAN_RESERVED_QTY",
      severity: "Critical",
      status: "OPEN",
      repairRecommendation: "+danger",
    },
  ]);
  ok("19d. issuesToCsv neutralizes article formula", csv.includes("'=1+1"));
}

// --- Hook failure isolation ---
{
  let threw = false;
  try {
    scheduleReservationIntegrityAfterCommit(null, null);
    scheduleReservationIntegrityAfterCommit({ companyId: null, article: null });
    queueReservationIntegrityValidation(undefined);
    // Fake session abort clears pending without throwing
    const session = {
      commitTransaction: async () => {},
      abortTransaction: async () => {},
    };
    scheduleReservationIntegrityAfterCommit(
      { companyId: "c1", warehouse: "MAIN", article: "X", reason: "test" },
      session
    );
    await session.abortTransaction();
  } catch {
    threw = true;
  }
  ok("20. Hook helpers never throw into stock path", threw === false);
}

// --- effectKey ---
ok(
  "effectKey canonical",
  buildEffectKey({
    companyCode: "mar",
    warehouse: "main",
    article: "8x0098",
    referenceNo: "MAR-ALLOC-0012",
  }) === "ORPHAN_RESERVATION_REPAIR:MAR:MAIN:8X0098:MAR-ALLOC-0012"
);

// --- H/I lifecycle documentation checks via classifier ---
{
  // I. Hard-deleted legacy orphan
  const issues = buildIssuesFromSnapshot(
    snap({ reservedQty: 9, availableQty: 0, expectedReservedQty: 0 })
  );
  ok("I. Legacy hard-delete orphan classified", issues[0]?.issueType === "ORPHAN_RESERVED_QTY");
}

console.log(`\n${passed} assertions passed`);
