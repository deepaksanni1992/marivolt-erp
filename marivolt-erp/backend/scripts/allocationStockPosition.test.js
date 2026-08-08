/**
 * Allocation stock-position pure formulas (Cases 1–13).
 * Run: node scripts/allocationStockPosition.test.js
 */
import assert from "node:assert/strict";
import {
  ALLOCATION_PROCUREMENT_STATUSES,
  ALLOCATION_STOCK_STATUSES,
  computeAllocationLineStockPosition,
  computeOutstandingIncomingPoLineQty,
  deriveProcurementStatus,
  deriveStockStatus,
} from "../src/services/allocationStockPositionService.js";

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

console.log("\nAllocation stock position\n");

run("CASE 1 — fully reserved for this allocation", () => {
  const r = computeAllocationLineStockPosition({
    orderedQty: 9,
    physicalQty: 9,
    totalReservedQty: 9,
    totalPackedQty: 0,
    reservedForThisAllocation: 9,
    packedForThisAllocation: 0,
    reservedForOtherAllocations: 0,
    incomingPoCoverageQty: 0,
    poCreatedQty: 0,
    allocationStatus: "OPEN",
  });
  assert.equal(r.reservedForThisAllocation, 9);
  assert.equal(r.reservedForOtherAllocations, 0);
  assert.equal(r.freeAvailableQty, 0);
  assert.equal(r.purchaseShortfallQty, 0);
  assert.equal(r.stockStatus, ALLOCATION_STOCK_STATUSES.FULLY_RESERVED);
  assert.equal(r.procurementStatus, ALLOCATION_PROCUREMENT_STATUSES.NOT_REQUIRED);
});

run("CASE 2 — all reserved for another allocation", () => {
  const r = computeAllocationLineStockPosition({
    orderedQty: 9,
    physicalQty: 9,
    totalReservedQty: 9,
    totalPackedQty: 0,
    reservedForThisAllocation: 0,
    packedForThisAllocation: 0,
    reservedForOtherAllocations: 9,
    incomingPoCoverageQty: 0,
    poCreatedQty: 0,
    allocationStatus: "OPEN",
  });
  assert.equal(r.reservedForThisAllocation, 0);
  assert.equal(r.reservedForOtherAllocations, 9);
  assert.equal(r.freeAvailableQty, 0);
  assert.equal(r.purchaseShortfallQty, 9);
  assert.equal(r.stockStatus, ALLOCATION_STOCK_STATUSES.PURCHASE_REQUIRED);
});

run("CASE 3 — partial here / partial others", () => {
  const r = computeAllocationLineStockPosition({
    orderedQty: 9,
    physicalQty: 9,
    totalReservedQty: 9,
    totalPackedQty: 0,
    reservedForThisAllocation: 4,
    packedForThisAllocation: 0,
    reservedForOtherAllocations: 5,
    incomingPoCoverageQty: 0,
    poCreatedQty: 0,
    allocationStatus: "OPEN",
  });
  assert.equal(r.reservedForThisAllocation, 4);
  assert.equal(r.reservedForOtherAllocations, 5);
  assert.equal(r.freeAvailableQty, 0);
  assert.equal(r.purchaseShortfallQty, 5);
  assert.equal(r.stockStatus, ALLOCATION_STOCK_STATUSES.PURCHASE_REQUIRED);
});

run("CASE 4 — free stock covers demand without current reservation", () => {
  const r = computeAllocationLineStockPosition({
    orderedQty: 5,
    physicalQty: 10,
    totalReservedQty: 3,
    totalPackedQty: 0,
    reservedForThisAllocation: 0,
    packedForThisAllocation: 0,
    reservedForOtherAllocations: 3,
    incomingPoCoverageQty: 0,
    poCreatedQty: 0,
    allocationStatus: "OPEN",
  });
  assert.equal(r.freeAvailableQty, 7);
  assert.equal(r.purchaseShortfallQty, 0);
  assert.equal(r.stockStatus, ALLOCATION_STOCK_STATUSES.AVAILABLE);
  assert.equal(r.procurementStatus, ALLOCATION_PROCUREMENT_STATUSES.NOT_REQUIRED);
});

run("CASE 5 — fully packed does not double-count reserved+packed", () => {
  const r = computeAllocationLineStockPosition({
    orderedQty: 9,
    physicalQty: 9,
    totalReservedQty: 0,
    totalPackedQty: 9,
    reservedForThisAllocation: 0,
    packedForThisAllocation: 9,
    reservedForOtherAllocations: 0,
    incomingPoCoverageQty: 0,
    poCreatedQty: 0,
    allocationStatus: "FULLY_PACKED",
  });
  assert.equal(r.currentAllocationCoverageQty, 9);
  assert.equal(r.purchaseShortfallQty, 0);
  assert.equal(r.stockStatus, ALLOCATION_STOCK_STATUSES.PACKED);
  assert.equal(r.procurementStatus, ALLOCATION_PROCUREMENT_STATUSES.NOT_REQUIRED);
});

run("CASE 6 — cancelled allocation contributes zero remaining reserved", () => {
  // Pure formula: cancelled docs are excluded upstream; remaining reserved input is 0.
  const r = computeAllocationLineStockPosition({
    orderedQty: 9,
    physicalQty: 9,
    totalReservedQty: 0,
    totalPackedQty: 0,
    reservedForThisAllocation: 0,
    packedForThisAllocation: 0,
    reservedForOtherAllocations: 0,
    incomingPoCoverageQty: 0,
    poCreatedQty: 0,
    allocationStatus: "CANCELLED",
  });
  assert.equal(r.reservedForThisAllocation, 0);
  assert.equal(r.freeAvailableQty, 9);
});

run("CASE 7 — company isolation is enforced by query scope (pure inputs)", () => {
  // Cross-company stock must not be mixed into inputs; verify formula uses only provided buckets.
  const r = computeAllocationLineStockPosition({
    orderedQty: 9,
    physicalQty: 0,
    totalReservedQty: 0,
    totalPackedQty: 0,
    reservedForThisAllocation: 0,
    packedForThisAllocation: 0,
    reservedForOtherAllocations: 0,
    incomingPoCoverageQty: 0,
    poCreatedQty: 0,
    allocationStatus: "OPEN",
  });
  assert.equal(r.physicalQty, 0);
  assert.equal(r.purchaseShortfallQty, 9);
  assert.equal(r.stockStatus, ALLOCATION_STOCK_STATUSES.PURCHASE_REQUIRED);
});

run("CASE 8 — reserved 5 + packed 4 = full coverage", () => {
  const r = computeAllocationLineStockPosition({
    orderedQty: 9,
    physicalQty: 9,
    totalReservedQty: 5,
    totalPackedQty: 4,
    reservedForThisAllocation: 5,
    packedForThisAllocation: 4,
    reservedForOtherAllocations: 0,
    incomingPoCoverageQty: 0,
    poCreatedQty: 0,
    allocationStatus: "PARTIALLY_PACKED",
  });
  assert.equal(r.currentAllocationCoverageQty, 9);
  assert.equal(r.purchaseShortfallQty, 0);
  assert.equal(r.procurementStatus, ALLOCATION_PROCUREMENT_STATUSES.NOT_REQUIRED);
});

run("CASE 9 — fully packed, shortfall 0, PACKED status", () => {
  const r = computeAllocationLineStockPosition({
    orderedQty: 9,
    physicalQty: 9,
    totalReservedQty: 0,
    totalPackedQty: 9,
    reservedForThisAllocation: 0,
    packedForThisAllocation: 9,
    reservedForOtherAllocations: 0,
    allocationStatus: "FULLY_PACKED",
  });
  assert.equal(r.purchaseShortfallQty, 0);
  assert.equal(r.stockStatus, ALLOCATION_STOCK_STATUSES.PACKED);
});

run("CASE 10 — reserved 4 + incoming PO 5 = shortfall 0", () => {
  const r = computeAllocationLineStockPosition({
    orderedQty: 9,
    physicalQty: 4,
    totalReservedQty: 4,
    totalPackedQty: 0,
    reservedForThisAllocation: 4,
    packedForThisAllocation: 0,
    reservedForOtherAllocations: 0,
    incomingPoCoverageQty: 5,
    poCreatedQty: 5,
    poStatuses: ["SENT"],
    allocationStatus: "OPEN",
  });
  assert.equal(r.purchaseShortfallQty, 0);
  assert.equal(r.procurementStatus, ALLOCATION_PROCUREMENT_STATUSES.NOT_REQUIRED);
});

run("CASE 11 — do not treat full converted qty as outstanding coverage", () => {
  // PO converted 9 but only 5 outstanding after partial receipt.
  const outstanding = computeOutstandingIncomingPoLineQty(
    { qty: 9, sourceConvertedQty: 9, receivedQty: 4 },
    "PARTIAL_RECEIVED"
  );
  assert.equal(outstanding, 5);

  const r = computeAllocationLineStockPosition({
    orderedQty: 9,
    physicalQty: 4,
    totalReservedQty: 4,
    totalPackedQty: 0,
    reservedForThisAllocation: 4,
    packedForThisAllocation: 0,
    reservedForOtherAllocations: 0,
    incomingPoCoverageQty: outstanding,
    poCreatedQty: 9,
    poStatuses: ["PARTIAL_RECEIVED"],
    allocationStatus: "OPEN",
  });
  // Coverage 4 + incoming 5 = 9 → shortfall 0 (not blindly using converted 9 as free cover).
  assert.equal(r.purchaseShortfallQty, 0);
  assert.equal(r.incomingPoCoverageQty, 5);
});

run("CASE 12 — cancelled PO contributes zero incoming coverage", () => {
  const outstanding = computeOutstandingIncomingPoLineQty(
    { qty: 9, sourceConvertedQty: 9, receivedQty: 0 },
    "CANCELLED"
  );
  assert.equal(outstanding, 0);
  const r = computeAllocationLineStockPosition({
    orderedQty: 9,
    physicalQty: 0,
    totalReservedQty: 0,
    totalPackedQty: 0,
    reservedForThisAllocation: 0,
    packedForThisAllocation: 0,
    reservedForOtherAllocations: 0,
    incomingPoCoverageQty: outstanding,
    poCreatedQty: 0,
    allocationStatus: "OPEN",
  });
  assert.equal(r.purchaseShortfallQty, 9);
});

run("CASE 13 — reserved others from ownership breakdown", () => {
  const r = computeAllocationLineStockPosition({
    orderedQty: 9,
    physicalQty: 9,
    totalReservedQty: 9,
    totalPackedQty: 0,
    reservedForThisAllocation: 4,
    packedForThisAllocation: 0,
    otherReservations: [
      {
        allocationNo: "MAR-ALLOC-0012",
        customerName: "Customer B",
        reservedQty: 5,
      },
    ],
    allocationStatus: "OPEN",
  });
  assert.equal(r.reservedForOtherAllocations, 5);
  assert.equal(r.reservedForThisAllocation, 4);
  assert.equal(r.purchaseShortfallQty, 5);
});

run("MAR-ALLOC-0015 / 700004.28 expected UI numbers", () => {
  const r = computeAllocationLineStockPosition({
    orderedQty: 9,
    physicalQty: 9,
    totalReservedQty: 9,
    totalPackedQty: 0,
    reservedForThisAllocation: 9,
    packedForThisAllocation: 0,
    reservedForOtherAllocations: 0,
    poCreatedQty: 0,
    allocationStatus: "OPEN",
  });
  assert.equal(r.orderedQty, 9);
  assert.equal(r.physicalQty, 9);
  assert.equal(r.reservedForThisAllocation, 9);
  assert.equal(r.reservedForOtherAllocations, 0);
  assert.equal(r.freeAvailableQty, 0);
  assert.equal(r.purchaseShortfallQty, 0);
  assert.equal(r.stockStatus, "FULLY_RESERVED");
  assert.equal(r.procurementStatus, "NOT_REQUIRED");
});

run("procurement NOT_REQUIRED when shortfall 0 even if NOT_CONVERTED conversion", () => {
  assert.equal(
    deriveProcurementStatus({
      purchaseShortfallQty: 0,
      poCreatedQty: 0,
      orderedQty: 9,
      poConversionStatus: "NOT_CONVERTED",
    }),
    "NOT_REQUIRED"
  );
});

run("stock status COMPLETED when allocation CLOSED and covered", () => {
  assert.equal(
    deriveStockStatus({
      orderedQty: 9,
      reservedForThisAllocation: 0,
      packedForThisAllocation: 9,
      currentAllocationCoverageQty: 9,
      freeAvailableQty: 0,
      purchaseShortfallQty: 0,
      allocationStatus: "CLOSED",
    }),
    "COMPLETED"
  );
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
