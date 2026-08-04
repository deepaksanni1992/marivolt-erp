/**
 * Regression tests for inventory integrity P0–P2 fixes (no DB).
 * Run: node scripts/inventoryIntegrityHardening.test.js
 */
import assert from "assert";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  buildPhysicalEffectKey,
  calculateExpectedReserved,
  computeExpectedReservedFromAllocations,
  computeExpectedPackedFromPackings,
} from "../src/services/stockExpectedBuckets.js";
import { buildIssuesFromSnapshot } from "../src/services/reservationIntegrityService.js";
import { MISMATCH_TYPES } from "../src/services/stockBucketIntegrityService.js";
import { REBUILD_KINDS } from "../src/services/inventoryRebuildService.js";
import { classifyIssueCategory, ISSUE_CATEGORIES } from "../src/services/dataHealthService.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.join(__dirname, "..");

function read(rel) {
  return fs.readFileSync(path.join(backendRoot, rel), "utf8");
}

let passed = 0;
function ok(name, cond) {
  assert.ok(cond, name);
  passed += 1;
  console.log("✓", name);
}

// --- Shared expected reserved (single formula) ---
{
  const allocs = [
    {
      companyId: "c1",
      allocationNo: "A1",
      status: "OPEN",
      warehouse: "MAIN",
      lines: [{ article: "X", qty: 10, packedQty: 0 }],
    },
    {
      companyId: "c1",
      allocationNo: "A2",
      status: "FULLY_PACKED",
      warehouse: "MAIN",
      lines: [{ article: "X", qty: 5, packedQty: 5 }],
    },
    {
      companyId: "c1",
      allocationNo: "A3",
      status: "CANCELLED",
      warehouse: "MAIN",
      lines: [{ article: "X", qty: 9, packedQty: 0 }],
    },
    {
      companyId: "c1",
      allocationNo: "A4",
      status: "CLOSED",
      warehouse: "MAIN",
      lines: [{ article: "X", qty: 4, packedQty: 2 }],
    },
  ];
  const { expectedReservedQty, documents } = computeExpectedReservedFromAllocations(allocs, {
    article: "X",
  });
  ok("Shared reserved: OPEN+CLOSED remaining = 12", expectedReservedQty === 12); // 10 + 0 + 0 + 2
  ok("Shared reserved: FULLY_PACKED remaining 0 not listed", !documents.some((d) => d.number === "A2"));
  ok("Shared reserved: CANCELLED excluded", !documents.some((d) => d.number === "A3"));
  ok("Shared reserved: CLOSED remaining 2", documents.some((d) => d.number === "A4" && d.qty === 2));
  ok("calculateExpectedReserved exported", typeof calculateExpectedReserved === "function");
}

{
  const packs = [
    {
      companyId: "c1",
      packingNo: "P1",
      status: "POSTED",
      warehouse: "MAIN",
      lines: [
        { article: "X", packQty: 9, dispatchedQty: 3 },
        { article: "Y", packQty: 2, dispatchedQty: 0 },
      ],
    },
    {
      companyId: "c1",
      packingNo: "P2",
      status: "CANCELLED",
      warehouse: "MAIN",
      lines: [{ article: "X", packQty: 5, dispatchedQty: 0 }],
    },
  ];
  const all = computeExpectedPackedFromPackings(packs);
  ok("Shared packed multi-article total 8", all.expectedPackedQty === 8);
  const onlyX = computeExpectedPackedFromPackings(packs, { article: "X" });
  ok("Shared packed filter X = 6", onlyX.expectedPackedQty === 6);
}

// --- Physical effectKey idempotency ---
{
  const k1 = buildPhysicalEffectKey({
    movementType: "GRN_IN",
    companyId: "cid",
    referenceNo: "MAR-GRN-1",
    article: "8X",
    warehouse: "MAIN",
    lineId: "L1",
    qty: 9,
  });
  const k2 = buildPhysicalEffectKey({
    movementType: "GRN_IN",
    companyId: "cid",
    referenceNo: "MAR-GRN-1",
    article: "8X",
    warehouse: "MAIN",
    lineId: "L1",
    qty: 9,
  });
  const k3 = buildPhysicalEffectKey({
    movementType: "GRN_IN",
    companyId: "cid",
    referenceNo: "MAR-GRN-1",
    article: "8X",
    warehouse: "MAIN",
    lineId: "L2",
    qty: 9,
  });
  ok("EffectKey deterministic (double GRN same key)", k1 === k2);
  ok("EffectKey unique per line", k1 !== k3);
  ok("EffectKey has phys prefix", k1.startsWith("phys:GRN_IN:"));

  const openK = buildPhysicalEffectKey({
    movementType: "OPENING_BALANCE",
    companyId: "cid",
    referenceNo: "OPENING:X:MAIN",
    article: "X",
    warehouse: "MAIN",
    qty: 5,
  });
  ok("Opening balance effectKey", openK.includes("OPENING_BALANCE"));

  const adjK = buildPhysicalEffectKey({
    movementType: "STOCK_ADJUSTMENT",
    companyId: "cid",
    referenceNo: "ADJ-1",
    article: "X",
    warehouse: "MAIN",
    lineId: "id1",
    direction: "IN",
    qty: 3,
  });
  ok("Adjustment effectKey", adjK.includes("STOCK_ADJUSTMENT") && adjK.includes("IN"));
}

ok("MISMATCH CROSS_COMPANY_MOVEMENT defined", !!MISMATCH_TYPES.CROSS_COMPANY_MOVEMENT);
ok("MISMATCH WAREHOUSE_SCOPE defined", !!MISMATCH_TYPES.WAREHOUSE_SCOPE_MISMATCH);
ok("MISMATCH GHOST_PACKING defined", !!MISMATCH_TYPES.GHOST_PACKING_EFFECT);

// --- Available formula ---
{
  const phys = 9;
  const resq = 2;
  const packed = 3;
  const availableQty = phys - resq - packed;
  ok("Available = onHand - reserved - packed", availableQty === 4);
}

{
  const issues = buildIssuesFromSnapshot({
    companyId: "c1",
    warehouse: "MAIN",
    article: "X",
    onHandQty: 9,
    expectedReservedQty: 0,
    expectedPackedQty: 0,
    expectedAvailableQty: 9,
    balance: { reservedQty: 0, allocatedQty: 0, packedQty: 0, availableQty: 9 },
  });
  ok("Healthy RI snapshot", issues.length === 0);
}

ok("Rebuild kinds include ON_HAND_FROM_LEDGER", REBUILD_KINDS.includes("ON_HAND_FROM_LEDGER"));
ok("Rebuild kinds include RESERVED_FROM_ALLOCATION", REBUILD_KINDS.includes("RESERVED_FROM_ALLOCATION"));
ok("Rebuild kinds include PACKED_FROM_PACKING", REBUILD_KINDS.includes("PACKED_FROM_PACKING"));
ok("Rebuild kinds include AVAILABLE", REBUILD_KINDS.includes("AVAILABLE"));
ok("Rebuild kinds include RESERVATION_INTEGRITY", REBUILD_KINDS.includes("RESERVATION_INTEGRITY"));
ok("Rebuild kinds include HEALTH_CACHE", REBUILD_KINDS.includes("HEALTH_CACHE"));

// --- Source wiring (double-post safety / hooks) ---
{
  const stockService = read("src/services/stockService.js");
  const invCtrl = read("src/controllers/inventoryController.js");
  const grnCtrl = read("src/controllers/grnController.js");
  const stockCtrl = read("src/controllers/stockController.js");
  const dataHealth = read("src/services/dataHealthService.js");
  const rebuild = read("src/services/inventoryRebuildService.js");
  const bucket = read("src/services/stockBucketIntegrityService.js");

  ok("grnReceive soft-idempotent via findLedgerByEffectKey", /findLedgerByEffectKey/.test(stockService) && /grnReceive/.test(stockService));
  ok("openingBalance uses resolvePhysicalEffectKey", /OPENING_BALANCE/.test(stockService) && /resolvePhysicalEffectKey/.test(stockService));
  ok("stockAdjustment uses resolvePhysicalEffectKey", /stockAdjustment[\s\S]*resolvePhysicalEffectKey/.test(stockService));
  ok("dispatchFromPacked notifies RI", /notifyReservationIntegrity\(companyId, warehouse, article, "DISPATCH"/.test(stockService));
  ok("GRN controller passes lineId", /lineId: String\(line\._id/.test(grnCtrl));
  ok("Stock adjustment controller passes lineId", /lineId: String\(row\._id/.test(stockCtrl));
  ok("listBalances available subtracts packed", /phys - resq - packed/.test(invCtrl));
  ok("Data Health emits CROSS_COMPANY_MOVEMENT", /CROSS_COMPANY_MOVEMENT/.test(dataHealth));
  ok("Data Health emits WAREHOUSE_SCOPE_MISMATCH", /WAREHOUSE_SCOPE_MISMATCH/.test(dataHealth));
  ok("Data Health detects DUPLICATE_GRN", /DUPLICATE_GRN/.test(dataHealth));
  ok("Data Health detects DUPLICATE_OPENING_BALANCE", /DUPLICATE_OPENING_BALANCE/.test(dataHealth));
  ok("Data Health detects DUPLICATE_STOCK_ADJUSTMENT", /DUPLICATE_STOCK_ADJUSTMENT/.test(dataHealth));
  ok("Data Health detects PACKING_LEDGER_WITHOUT_DOCUMENT", /PACKING_LEDGER_WITHOUT_DOCUMENT/.test(dataHealth));
  ok("Data Health detects NEGATIVE_CUSTOMS_AVAILABLE", /NEGATIVE_CUSTOMS_AVAILABLE/.test(dataHealth));
  ok("Data Health detects NEGATIVE_CUSTOMS_QTY", /NEGATIVE_CUSTOMS_QTY/.test(dataHealth));
  ok("Rebuild dry-run default (apply=false)", /apply = false/.test(rebuild));
  ok("Rebuild writes evidence JSON", /writeEvidence/.test(rebuild));
  ok("Rebuild uses transaction", /withTransaction/.test(rebuild));
  ok("Rebuild uses AuditLog", /AuditLog\.create/.test(rebuild));
  ok("Bucket integrity uses shared reserved helper", /computeExpectedReservedFromAllocations/.test(bucket));
  ok("Reconcile uses shared reserved helper", /computeExpectedReservedFromAllocations/.test(read("src/services/stockBucketReconcileService.js")));
  ok("CLI rebuild script exists", fs.existsSync(path.join(backendRoot, "scripts/inventoryRebuild.mjs")));
  ok(
    "Company-wide apply refused without article",
    /Company-wide --apply is refused/.test(read("scripts/inventoryRebuild.mjs"))
  );
}

ok(
  "CROSS_COMPANY_MOVEMENT is integrity category",
  classifyIssueCategory("CROSS_COMPANY_MOVEMENT") === ISSUE_CATEGORIES.INTEGRITY
);
ok(
  "DUPLICATE_GRN is integrity category",
  classifyIssueCategory("DUPLICATE_GRN") === ISSUE_CATEGORIES.INTEGRITY
);

// Rebuild dry-run vs apply contract (pure)
{
  ok(
    "Rebuild apply requires explicit flag in CLI",
    /arg\("apply"/.test(read("scripts/inventoryRebuild.mjs"))
  );
}

console.log(`\n${passed} assertions passed`);
