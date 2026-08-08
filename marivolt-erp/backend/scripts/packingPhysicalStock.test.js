/**
 * Physical stock helpers for package-based packing.
 * Run: node scripts/packingPhysicalStock.test.js
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PACKING_OVERRIDE_PHYSICAL_SHORTAGE_PERMISSION,
  collectPackingShortages,
  derivePackingLineStock,
  shouldBlockPhysicalShortagePost,
  shortageForRequestedQty,
} from "../src/utils/packingPhysicalStock.js";
import { PACKING_PHYSICAL_STOCK_SHORTAGE } from "../src/utils/packingIdempotency.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.join(__dirname, "..");

let passed = 0;
let failed = 0;
function run(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed += 1;
    console.error(`  ✗ ${name}`);
    console.error(`    ${e.message}`);
  }
}

console.log("\nPacking physical stock\n");

run("On-hand 9, allocation balance 9 → READY, no shortage", () => {
  const d = derivePackingLineStock(
    { onHandQty: 9, reservedQty: 9, allocatedQty: 9, packedQty: 0, availableQty: 0 },
    { allocatedQty: 9, alreadyPacked: 0, isNegativeAllocation: false }
  );
  assert.equal(d.onHandQty, 9);
  assert.equal(d.reservedForThisAllocationQty, 9);
  assert.equal(d.reservedForOtherAllocationsQty, 0);
  assert.equal(d.freeAvailableQty, 9);
  assert.equal(d.physicalPackableQty, 9);
  assert.equal(d.shortageQty, 0);
  assert.equal(d.stockStatus, "READY");
  assert.equal(shouldBlockPhysicalShortagePost(collectPackingShortages([{ article: "A", packQty: 9, freeAvailableQty: 9 }])), false);
});

run("On-hand 5, allocation balance 9 → PARTIAL, shortage 4", () => {
  const d = derivePackingLineStock(
    { onHandQty: 5, reservedQty: 9, allocatedQty: 9, packedQty: 0, availableQty: -4 },
    { allocatedQty: 9, alreadyPacked: 0, isNegativeAllocation: true }
  );
  assert.equal(d.physicalPackableQty, 5);
  assert.equal(d.shortageQty, 4);
  assert.equal(d.stockStatus, "NEGATIVE_ALLOCATION");
  const shortages = collectPackingShortages([{ article: "A", packQty: 9, freeAvailableQty: 5 }], "MAIN");
  assert.equal(shortages.length, 1);
  assert.equal(shortages[0].shortageQty, 4);
  assert.equal(shouldBlockPhysicalShortagePost(shortages), true);
});

run("On-hand 0, allocation balance 9 → SHORTAGE / NEGATIVE_ALLOCATION", () => {
  const d = derivePackingLineStock(
    { onHandQty: 0, reservedQty: 9, allocatedQty: 9, packedQty: 0, availableQty: -9 },
    { allocatedQty: 9, alreadyPacked: 0, isNegativeAllocation: true }
  );
  assert.equal(d.physicalPackableQty, 0);
  assert.equal(d.shortageQty, 9);
  assert.equal(d.stockStatus, "NEGATIVE_ALLOCATION");
  assert.equal(shortageForRequestedQty(0, 9).shortageQty, 9);
});

run("Negative allocation remains valid but post blocked", () => {
  const d = derivePackingLineStock(
    { onHandQty: 0, reservedQty: 9, allocatedQty: 9, packedQty: 0, availableQty: -9 },
    { allocatedQty: 9, alreadyPacked: 0, isNegativeAllocation: true }
  );
  assert.equal(d.isNegativeAllocation, true);
  assert.ok(["SHORTAGE", "NEGATIVE_ALLOCATION"].includes(d.stockStatus));
  assert.equal(
    shouldBlockPhysicalShortagePost([{ article: "700004.28", shortageQty: 9 }], { allowOverride: false }),
    true
  );
});

run("Current allocation reservation is not double-subtracted", () => {
  // availableQty already subtracted total reserved (9). freeAvailable must add back this claim.
  const d = derivePackingLineStock(
    { onHandQty: 9, reservedQty: 9, allocatedQty: 9, packedQty: 0, availableQty: 0 },
    { allocatedQty: 9, alreadyPacked: 0 }
  );
  assert.equal(d.freeAvailableQty, 9);
  assert.equal(d.physicalPackableQty, 9);
});

run("Other allocations’ reservations reduce free available", () => {
  // onHand 10, total reserved 14 (=9 this + 5 others), packed 0
  const d = derivePackingLineStock(
    { onHandQty: 10, reservedQty: 14, allocatedQty: 14, packedQty: 0, availableQty: -4 },
    { allocatedQty: 9, alreadyPacked: 0 }
  );
  assert.equal(d.reservedForThisAllocationQty, 9);
  assert.equal(d.reservedForOtherAllocationsQty, 5);
  assert.equal(d.freeAvailableQty, 5);
  assert.equal(d.physicalPackableQty, 5);
  assert.equal(d.shortageQty, 4);
  assert.equal(d.stockStatus, "PARTIAL");
});

run("Failed validation architecture: override permission constant reserved", () => {
  assert.equal(PACKING_OVERRIDE_PHYSICAL_SHORTAGE_PERMISSION, "PACKING.overridePhysicalShortage");
  assert.equal(PACKING_PHYSICAL_STOCK_SHORTAGE, "PACKING_PHYSICAL_STOCK_SHORTAGE");
  assert.equal(shouldBlockPhysicalShortagePost([{ shortageQty: 1 }], { allowOverride: true }), false);
});

run("Previously packed qty reduces allocation balance without double-count", () => {
  const d = derivePackingLineStock(
    { onHandQty: 10, reservedQty: 4, allocatedQty: 4, packedQty: 5, availableQty: 1 },
    { allocatedQty: 9, alreadyPacked: 5 }
  );
  assert.equal(d.allocationBalanceQty, 4);
  assert.equal(d.reservedForThisAllocationQty, 4);
  assert.equal(d.freeAvailableQty, 10 - 0 - 5);
  assert.equal(d.physicalPackableQty, 4);
  assert.equal(d.shortageQty, 0);
  assert.equal(d.stockStatus, "READY");
});

run("Malformed stock inputs normalize to finite non-NaN quantities", () => {
  const d = derivePackingLineStock(
    { onHandQty: "x", reservedQty: null, packedQty: undefined },
    { allocatedQty: "9", alreadyPacked: "bad" }
  );
  assert.equal(Number.isFinite(d.onHandQty), true);
  assert.equal(Number.isNaN(d.freeAvailableQty), false);
  assert.equal(d.allocationBalanceQty, 9);
  assert.ok(d.shortageQty >= 0);
});

run("Controller wires live stock enrichment and post gate", () => {
  const ctrl = fs.readFileSync(path.join(backendRoot, "src/controllers/storeOutboundController.js"), "utf8");
  assert.match(ctrl, /derivePackingLineStock/);
  assert.match(ctrl, /PACKING_PHYSICAL_STOCK_SHORTAGE/);
  assert.match(ctrl, /physicalPackableQty/);
  assert.match(ctrl, /warehousePackedQty/);
  assert.match(ctrl, /acknowledgePhysicalShortage/);
  assert.match(ctrl, /hasPhysicalShortage/);
  assert.match(ctrl, /hasPhysicalShortage && !acknowledged[\s\S]*PACKING_PHYSICAL_STOCK_SHORTAGE/);
  assert.match(ctrl, /claimed\.hasPhysicalShortage = false/);
  assert.doesNotMatch(ctrl, /allowPhysicalShortageOverride\s*=\s*true/);
  // Shortage gate must appear before claimAllocationLinePackQty / packFromAllocation
  const gateAt = ctrl.indexOf("shouldBlockPhysicalShortagePost");
  const claimAt = ctrl.indexOf("claimAllocationLinePackQty");
  const packAt = ctrl.indexOf("packFromAllocation({");
  assert.ok(gateAt > 0 && claimAt > gateAt && packAt > claimAt);
});

run("StorePacking model stores shortage acknowledgement fields", () => {
  const model = fs.readFileSync(path.join(backendRoot, "src/models/StorePacking.js"), "utf8");
  assert.match(model, /hasPhysicalShortage/);
  assert.match(model, /physicalShortageQty/);
  assert.match(model, /physicalShortageAcknowledgedAt/);
});

run("Frontend packing UI shows stock columns and shortage confirm", () => {
  const ui = fs.readFileSync(path.join(backendRoot, "../src/pages/StoreModule.jsx"), "utf8");
  assert.match(ui, /Reserved Here/);
  assert.match(ui, /Pick Qty/);
  assert.match(ui, /Last Known Putaway/);
  assert.match(ui, /Print Picking Sheet/);
  assert.match(ui, /renderAllocationPickingSheetPrintWindow/);
  assert.match(ui, /packingStockBadge/);
  assert.match(ui, /Physical stock shortage/);
  assert.match(ui, /PACKING_PHYSICAL_STOCK_SHORTAGE/);
  assert.match(ui, /acknowledgePhysicalShortage/);
  assert.match(ui, /Stock checked at/);
  // Must not reset packages on every stock refetch
  assert.match(ui, /Reset packages only when the allocation selection changes/);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
