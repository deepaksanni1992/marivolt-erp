/**
 * P0.3 — active Order Allocation uniqueness / concurrency helpers.
 * Run: node scripts/allocationUniqueness.test.js
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ACTIVE_ALLOCATION_ALREADY_EXISTS,
  ACTIVE_ALLOCATION_INDEX_SPECS,
  ACTIVE_ALLOCATION_OA_INDEX,
  ACTIVE_ALLOCATION_PI_INDEX,
  ACTIVE_ALLOCATION_STATUSES,
  activeAllocationConflictError,
  activeAllocationPartialFilter,
  claimActiveAllocationLink,
  isActiveAllocationDuplicateKeyError,
  isAllocationStatusActive,
  releaseActiveAllocationLinks,
} from "../src/utils/allocationUniqueness.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.join(__dirname, "..");
const srcRoot = path.join(backendRoot, "src");

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

console.log("\nAllocation uniqueness (P0.3)\n");

run("Active statuses are the positive non-CANCELLED list", () => {
  assert.deepEqual([...ACTIVE_ALLOCATION_STATUSES], [
    "OPEN",
    "PARTIALLY_PACKED",
    "FULLY_PACKED",
    "APPROVED",
    "CLOSED",
  ]);
  assert.equal(isAllocationStatusActive("OPEN"), true);
  assert.equal(isAllocationStatusActive("CANCELLED"), false);
});

run("Partial filter uses $type objectId and $in active statuses", () => {
  const f = activeAllocationPartialFilter("linkedOAId");
  assert.deepEqual(f.linkedOAId, { $type: "objectId" });
  assert.deepEqual(f.status.$in, [...ACTIVE_ALLOCATION_STATUSES]);
});

run("Index specs have stable names and unique:true", () => {
  assert.equal(ACTIVE_ALLOCATION_INDEX_SPECS.length, 2);
  assert.equal(ACTIVE_ALLOCATION_INDEX_SPECS[0].name, ACTIVE_ALLOCATION_OA_INDEX);
  assert.equal(ACTIVE_ALLOCATION_INDEX_SPECS[1].name, ACTIVE_ALLOCATION_PI_INDEX);
  assert.equal(ACTIVE_ALLOCATION_INDEX_SPECS[0].unique, true);
  assert.equal(ACTIVE_ALLOCATION_INDEX_SPECS[1].unique, true);
});

run("E11000 on OA/PI unique index maps to ACTIVE_ALLOCATION_ALREADY_EXISTS", () => {
  const err = {
    code: 11000,
    message: `E11000 duplicate key error collection: erp.orderallocations index: ${ACTIVE_ALLOCATION_OA_INDEX} dup key`,
    keyPattern: { companyId: 1, linkedOAId: 1 },
    keyValue: { companyId: "c1", linkedOAId: "oa1" },
  };
  assert.equal(isActiveAllocationDuplicateKeyError(err), true);
  const conflict = activeAllocationConflictError({
    _id: "alloc1",
    allocationNo: "MAR-OA-001",
    status: "OPEN",
  });
  assert.equal(conflict.code, ACTIVE_ALLOCATION_ALREADY_EXISTS);
  assert.equal(conflict.statusCode, 409);
  assert.equal(conflict.details.allocationId, "alloc1");
});

run("Unrelated E11000 is not treated as allocation uniqueness", () => {
  assert.equal(
    isActiveAllocationDuplicateKeyError({
      code: 11000,
      keyPattern: { companyId: 1, allocationNo: 1 },
      message: "E11000 duplicate key error index: companyId_1_allocationNo_1",
    }),
    false
  );
});

run("First OA conversion claim succeeds; second returns conflict", () => {
  const store = new Map();
  const first = claimActiveAllocationLink(store, {
    companyId: "co1",
    linkedOAId: "oa1",
    allocationId: "a1",
  });
  assert.equal(first.ok, true);
  const second = claimActiveAllocationLink(store, {
    companyId: "co1",
    linkedOAId: "oa1",
    allocationId: "a2",
  });
  assert.equal(second.ok, false);
  assert.equal(second.existingId, "a1");
});

run("Two simultaneous OA claims: only one wins", () => {
  const store = new Map();
  const results = [];
  // Synchronous race on shared Map (atomic in single-threaded JS between statements).
  results.push(
    claimActiveAllocationLink(store, { companyId: "co1", linkedOAId: "oa-race", allocationId: "a1" })
  );
  results.push(
    claimActiveAllocationLink(store, { companyId: "co1", linkedOAId: "oa-race", allocationId: "a2" })
  );
  assert.equal(results.filter((r) => r.ok).length, 1);
  assert.equal(results.filter((r) => !r.ok).length, 1);
});

run("First PI claim succeeds; second conflicts", () => {
  const store = new Map();
  assert.equal(
    claimActiveAllocationLink(store, {
      companyId: "co1",
      linkedProformaId: "pi1",
      allocationId: "a1",
    }).ok,
    true
  );
  assert.equal(
    claimActiveAllocationLink(store, {
      companyId: "co1",
      linkedProformaId: "pi1",
      allocationId: "a2",
    }).ok,
    false
  );
});

run("Simultaneous PI claims: one winner only", () => {
  const store = new Map();
  const a = claimActiveAllocationLink(store, {
    companyId: "co1",
    linkedProformaId: "pi-race",
    allocationId: "a1",
  });
  const b = claimActiveAllocationLink(store, {
    companyId: "co1",
    linkedProformaId: "pi-race",
    allocationId: "a2",
  });
  assert.equal([a, b].filter((r) => r.ok).length, 1);
});

run("Advance allocation with both OA+PI links blocks either source", () => {
  const store = new Map();
  const claim = claimActiveAllocationLink(store, {
    companyId: "co1",
    linkedOAId: "oa-both",
    linkedProformaId: "pi-both",
    allocationId: "a-both",
  });
  assert.equal(claim.ok, true);
  assert.equal(
    claimActiveAllocationLink(store, {
      companyId: "co1",
      linkedOAId: "oa-both",
      allocationId: "a2",
    }).ok,
    false
  );
  assert.equal(
    claimActiveAllocationLink(store, {
      companyId: "co1",
      linkedProformaId: "pi-both",
      allocationId: "a3",
    }).ok,
    false
  );
});

run("Cancelled release permits new allocation (reallocation)", () => {
  const store = new Map();
  claimActiveAllocationLink(store, {
    companyId: "co1",
    linkedOAId: "oa-cancel",
    linkedProformaId: "pi-cancel",
    allocationId: "a-old",
  });
  releaseActiveAllocationLinks(store, {
    companyId: "co1",
    linkedOAId: "oa-cancel",
    linkedProformaId: "pi-cancel",
  });
  const again = claimActiveAllocationLink(store, {
    companyId: "co1",
    linkedOAId: "oa-cancel",
    linkedProformaId: "pi-cancel",
    allocationId: "a-new",
  });
  assert.equal(again.ok, true);
  assert.equal(store.get("co1::oa::oa-cancel"), "a-new");
});

run("Create-before-reserve simulation: loser never reserves stock", () => {
  const store = new Map();
  let stockReserves = 0;
  function simulateConvert({ id, oaId }) {
    const claim = claimActiveAllocationLink(store, {
      companyId: "co1",
      linkedOAId: oaId,
      allocationId: id,
    });
    if (!claim.ok) {
      return { ok: false, code: ACTIVE_ALLOCATION_ALREADY_EXISTS, stockReserves: 0 };
    }
    // Stock only after successful claim/create.
    stockReserves += 1;
    return { ok: true, stockReserves: 1 };
  }
  const r1 = simulateConvert({ id: "a1", oaId: "oa-stock" });
  const r2 = simulateConvert({ id: "a2", oaId: "oa-stock" });
  assert.equal(r1.ok, true);
  assert.equal(r2.ok, false);
  assert.equal(r2.code, ACTIVE_ALLOCATION_ALREADY_EXISTS);
  assert.equal(stockReserves, 1);
});

run("Transaction failure simulation leaves no orphan claim or stock", () => {
  const store = new Map();
  let stockReserves = 0;
  function simulateFailingConvert() {
    const claim = claimActiveAllocationLink(store, {
      companyId: "co1",
      linkedOAId: "oa-fail",
      allocationId: "a-fail",
    });
    assert.equal(claim.ok, true);
    try {
      throw new Error("simulated stock failure");
    } catch (e) {
      // abort → release claim (unique index document rolled back)
      releaseActiveAllocationLinks(store, { companyId: "co1", linkedOAId: "oa-fail" });
      stockReserves = 0;
      throw e;
    }
  }
  assert.throws(() => simulateFailingConvert(), /simulated stock failure/);
  assert.equal(store.has("co1::oa::oa-fail"), false);
  assert.equal(stockReserves, 0);
  // Retry after abort succeeds.
  assert.equal(
    claimActiveAllocationLink(store, {
      companyId: "co1",
      linkedOAId: "oa-fail",
      allocationId: "a-retry",
    }).ok,
    true
  );
});

run("Controller source uses ACTIVE_ALLOCATION_ALREADY_EXISTS and create-first pattern", () => {
  const src = fs.readFileSync(path.join(srcRoot, "controllers/salesFlowController.js"), "utf8");
  assert.match(src, /ACTIVE_ALLOCATION_ALREADY_EXISTS/);
  assert.match(src, /isActiveAllocationDuplicateKeyError/);
  assert.match(src, /findActiveAllocationByOA/);
  assert.match(src, /findActiveAllocationByProforma/);
  // PI eligibility still required
  assert.match(src, /PAID_PENDING_SHIPMENT/);
  // No RTS reintroduction
  assert.doesNotMatch(src, /\bRTS_COMPLETE\b/);
  assert.doesNotMatch(src, /\blinkedRtsId\b/);
  assert.doesNotMatch(src, /moveAllocationToRTS/);
});

run("OrderAllocation model declares both partial unique indexes", () => {
  const src = fs.readFileSync(path.join(srcRoot, "models/OrderAllocation.js"), "utf8");
  assert.match(src, /ACTIVE_ALLOCATION_OA_INDEX/);
  assert.match(src, /ACTIVE_ALLOCATION_PI_INDEX/);
  assert.match(src, /partialFilterExpression/);
  assert.match(src, /activeAllocationPartialFilter\("linkedOAId"\)/);
  assert.match(src, /activeAllocationPartialFilter\("linkedProformaId"\)/);
});

run("RTS routes/fields remain removed (P0.4 regression)", () => {
  const routes = fs.readFileSync(path.join(srcRoot, "routes/salesRoutes.js"), "utf8");
  assert.doesNotMatch(routes, /\/rts\b/i);
  assert.equal(fs.existsSync(path.join(srcRoot, "models/Rts.js")), false);
  const stock = fs.readFileSync(path.join(srcRoot, "services/stockService.js"), "utf8");
  assert.doesNotMatch(stock, /RTS_TRANSFER/);
  assert.doesNotMatch(stock, /rtsQty/);
});

run("Unpaid PI gate remains in convertProformaToOrderAllocation", () => {
  const src = fs.readFileSync(path.join(srcRoot, "controllers/salesFlowController.js"), "utf8");
  const fnStart = src.indexOf("export async function convertProformaToOrderAllocation");
  const fnEnd = src.indexOf("export async function convertOrderAllocationToSalesInvoice");
  const body = src.slice(fnStart, fnEnd);
  assert.match(body, /Proforma must be APPROVED or PAID/);
  assert.match(body, /findActiveAllocationByProforma/);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
