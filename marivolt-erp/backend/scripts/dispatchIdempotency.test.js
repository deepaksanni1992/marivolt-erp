/**
 * P0.5B Store Dispatch posting / cancellation idempotency tests.
 * Run: node scripts/dispatchIdempotency.test.js
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DISPATCH_CANCEL_IN_PROGRESS,
  DISPATCH_EFFECT_INDEX_SPEC,
  DISPATCH_EFFECT_UNIQUE_INDEX,
  DISPATCH_LEDGER_INCONSISTENT,
  DISPATCH_POST_IN_PROGRESS,
  DISPATCH_POSTING_CONFLICT,
  DISPATCH_SOURCE_DOCUMENT_TYPE,
  buildDispatchEffectKey,
  buildDispatchReversalEffectKey,
  isDispatchEffectDuplicateKeyError,
  simulateDispatchCancel,
  simulateDispatchPost,
} from "../src/utils/dispatchIdempotency.js";
import {
  PACKING_EFFECT_UNIQUE_INDEX,
  buildPackingEffectKey,
} from "../src/utils/packingIdempotency.js";

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

console.log("\nDispatch idempotency (P0.5B)\n");

run("Effect key is deterministic and includes source line", () => {
  const a = buildDispatchEffectKey({
    companyId: "c1",
    dispatchId: "d1",
    dispatchLineId: "l1",
    movementType: "DISPATCH_OUT",
    warehouse: "MAIN",
  });
  const b = buildDispatchEffectKey({
    companyId: "c1",
    dispatchId: "d1",
    dispatchLineId: "l1",
    movementType: "DISPATCH_OUT",
    warehouse: "main",
  });
  assert.equal(a, b);
  assert.match(a, new RegExp(`^c1\\|${DISPATCH_SOURCE_DOCUMENT_TYPE}\\|d1\\|l1\\|DISPATCH_OUT\\|`));
  const other = buildDispatchEffectKey({
    companyId: "c1",
    dispatchId: "d1",
    dispatchLineId: "l2",
    movementType: "DISPATCH_OUT",
    warehouse: "MAIN",
  });
  assert.notEqual(a, other);
});

run("Dispatch and Packing effect keys do not collide for same ids", () => {
  const d = buildDispatchEffectKey({
    companyId: "c1",
    dispatchId: "x1",
    dispatchLineId: "l1",
    movementType: "DISPATCH_OUT",
    warehouse: "MAIN",
  });
  const p = buildPackingEffectKey({
    companyId: "c1",
    packingId: "x1",
    packingLineId: "l1",
    movementType: "PACKED",
    warehouse: "MAIN",
  });
  assert.notEqual(d, p);
});

run("Reversal effect key is derived from original", () => {
  const orig = buildDispatchEffectKey({
    companyId: "c1",
    dispatchId: "d1",
    dispatchLineId: "l1",
    movementType: "DISPATCH_OUT",
    warehouse: "MAIN",
  });
  assert.equal(buildDispatchReversalEffectKey(orig), `${orig}|REVERSAL`);
});

run("Index spec reuses P0.5A generic effectKey unique index", () => {
  assert.equal(DISPATCH_EFFECT_INDEX_SPEC.name, DISPATCH_EFFECT_UNIQUE_INDEX);
  assert.equal(DISPATCH_EFFECT_UNIQUE_INDEX, PACKING_EFFECT_UNIQUE_INDEX);
  assert.equal(DISPATCH_EFFECT_INDEX_SPEC.unique, true);
  assert.deepEqual(DISPATCH_EFFECT_INDEX_SPEC.key, { effectKey: 1 });
});

run("First dispatch post succeeds once", () => {
  const store = new Map([["d1", { status: "DRAFT", hasEvidence: false }]]);
  let moves = 0;
  const r = simulateDispatchPost({
    store,
    dispatchId: "d1",
    hasDispatchOutEvidence: (d) => Boolean(d.hasEvidence),
    stockWork: () => {
      moves += 1;
    },
  });
  assert.equal(r.outcome, "posted");
  assert.equal(moves, 1);
  assert.equal(store.get("d1").status, "FULLY_DISPATCHED");
});

run("Repeated post of healthy posted dispatch is idempotent", () => {
  const store = new Map([["d1", { status: "FULLY_DISPATCHED", hasEvidence: true }]]);
  let moves = 0;
  const r = simulateDispatchPost({
    store,
    dispatchId: "d1",
    hasDispatchOutEvidence: (d) => Boolean(d.hasEvidence),
    stockWork: () => {
      moves += 1;
    },
  });
  assert.equal(r.outcome, "idempotent");
  assert.equal(moves, 0);
  assert.equal(r.doc.status, "FULLY_DISPATCHED");
});

run("Two simultaneous posts: one stock effect only", () => {
  const store = new Map([["d2", { status: "DRAFT", hasEvidence: false }]]);
  let moves = 0;
  const results = [];
  for (let i = 0; i < 2; i += 1) {
    try {
      results.push(
        simulateDispatchPost({
          store,
          dispatchId: "d2",
          hasDispatchOutEvidence: (d) => Boolean(d.hasEvidence),
          stockWork: () => {
            moves += 1;
          },
        })
      );
    } catch (e) {
      results.push({ outcome: "conflict", code: e.code });
    }
  }
  assert.equal(moves, 1);
  assert.equal(results.filter((r) => r.outcome === "posted").length, 1);
  assert.ok(
    results.some((r) => r.outcome === "idempotent" || r.code === DISPATCH_POSTING_CONFLICT || r.code === DISPATCH_POST_IN_PROGRESS)
  );
});

run("Posted without ledger evidence returns conflict", () => {
  const store = new Map([["d3", { status: "PARTIALLY_DISPATCHED", hasEvidence: false }]]);
  assert.throws(
    () =>
      simulateDispatchPost({
        store,
        dispatchId: "d3",
        hasDispatchOutEvidence: (d) => Boolean(d.hasEvidence),
        stockWork: () => {},
      }),
    (e) => e.code === DISPATCH_LEDGER_INCONSISTENT
  );
});

run("Ledger exists with DRAFT is not treated as posted (claim path)", () => {
  // Document still DRAFT means first post claims; inconsistency of ledger+DRAFT is
  // surfaced by unique index / controller consistency check — simulate claim succeeds.
  const store = new Map([["d4", { status: "DRAFT", hasEvidence: true }]]);
  const r = simulateDispatchPost({
    store,
    dispatchId: "d4",
    hasDispatchOutEvidence: (d) => Boolean(d.hasEvidence),
    stockWork: () => {},
  });
  assert.equal(r.outcome, "posted");
});

run("Transaction failure rolls status back and leaves stock untouched", () => {
  const store = new Map([["d5", { status: "DRAFT", hasEvidence: false }]]);
  let moves = 0;
  assert.throws(() =>
    simulateDispatchPost({
      store,
      dispatchId: "d5",
      hasDispatchOutEvidence: () => false,
      stockWork: () => {
        moves += 1;
        throw new Error("boom");
      },
    })
  );
  assert.equal(moves, 1);
  assert.equal(store.get("d5").status, "DRAFT");
});

run("E11000 on effectKey maps to controlled duplicate detection", () => {
  assert.equal(
    isDispatchEffectDuplicateKeyError({
      code: 11000,
      message: `E11000 duplicate key error collection: stockledgers index: ${DISPATCH_EFFECT_UNIQUE_INDEX} dup key`,
      keyPattern: { effectKey: 1 },
    }),
    true
  );
  assert.equal(isDispatchEffectDuplicateKeyError({ code: 11000, message: "other" }), false);
  assert.equal(isDispatchEffectDuplicateKeyError({ code: 1 }), false);
});

run("POSTING in progress returns controlled conflict", () => {
  const store = new Map([["d6", { status: "POSTING", hasEvidence: false }]]);
  assert.throws(
    () =>
      simulateDispatchPost({
        store,
        dispatchId: "d6",
        hasDispatchOutEvidence: () => false,
        stockWork: () => {},
      }),
    (e) => e.code === DISPATCH_POST_IN_PROGRESS
  );
});

run("Cancellation reverses once", () => {
  const store = new Map([["d7", { status: "FULLY_DISPATCHED", hasEvidence: true, hasCancel: false }]]);
  let moves = 0;
  const r = simulateDispatchCancel({
    store,
    dispatchId: "d7",
    hasDispatchOutEvidence: (d) => Boolean(d.hasEvidence),
    hasCancelEvidence: (d) => Boolean(d.hasCancel),
    stockWork: () => {
      moves += 1;
    },
  });
  assert.equal(r.outcome, "cancelled");
  assert.equal(moves, 1);
  assert.equal(store.get("d7").status, "CANCELLED");
});

run("Repeated cancellation is idempotent when reverse evidence exists", () => {
  const store = new Map([
    ["d8", { status: "CANCELLED", hasEvidence: false, hasCancel: true }],
  ]);
  let moves = 0;
  const r = simulateDispatchCancel({
    store,
    dispatchId: "d8",
    hasDispatchOutEvidence: (d) => Boolean(d.hasEvidence),
    hasCancelEvidence: (d) => Boolean(d.hasCancel),
    stockWork: () => {
      moves += 1;
    },
  });
  assert.equal(r.outcome, "idempotent");
  assert.equal(moves, 0);
});

run("Concurrent cancellation: one reversal only", () => {
  const store = new Map([["d9", { status: "FULLY_DISPATCHED", hasEvidence: true, hasCancel: false }]]);
  let moves = 0;
  const results = [];
  for (let i = 0; i < 2; i += 1) {
    try {
      results.push(
        simulateDispatchCancel({
          store,
          dispatchId: "d9",
          hasDispatchOutEvidence: (d) => Boolean(d.hasEvidence),
          hasCancelEvidence: (d) => Boolean(d.hasCancel),
          stockWork: () => {
            moves += 1;
          },
        })
      );
    } catch (e) {
      results.push({ outcome: "conflict", code: e.code });
    }
  }
  assert.equal(moves, 1);
  assert.equal(results.filter((r) => r.outcome === "cancelled").length, 1);
});

run("Missing original ledger blocks cancellation", () => {
  const store = new Map([["d10", { status: "FULLY_DISPATCHED", hasEvidence: false }]]);
  assert.throws(
    () =>
      simulateDispatchCancel({
        store,
        dispatchId: "d10",
        hasDispatchOutEvidence: (d) => Boolean(d.hasEvidence),
        hasCancelEvidence: () => false,
        stockWork: () => {},
      }),
    (e) => e.code === DISPATCH_LEDGER_INCONSISTENT
  );
});

run("CANCELLING in progress returns controlled conflict", () => {
  const store = new Map([["d11", { status: "CANCELLING", hasEvidence: true }]]);
  assert.throws(
    () =>
      simulateDispatchCancel({
        store,
        dispatchId: "d11",
        hasDispatchOutEvidence: () => true,
        hasCancelEvidence: () => false,
        stockWork: () => {},
      }),
    (e) => e.code === DISPATCH_CANCEL_IN_PROGRESS
  );
});

run("Partial dispatch statuses are treated as posted for cancel claim", () => {
  const store = new Map([["d12", { status: "PARTIALLY_DISPATCHED", hasEvidence: true }]]);
  const r = simulateDispatchCancel({
    store,
    dispatchId: "d12",
    hasDispatchOutEvidence: (d) => Boolean(d.hasEvidence),
    hasCancelEvidence: () => false,
    stockWork: () => {},
  });
  assert.equal(r.outcome, "cancelled");
});

run("Controller and stockService expose Dispatch identity fields (source scan)", () => {
  const ctrl = fs.readFileSync(path.join(srcRoot, "controllers/storeOutboundController.js"), "utf8");
  const stock = fs.readFileSync(path.join(srcRoot, "services/stockService.js"), "utf8");
  const ledger = fs.readFileSync(path.join(srcRoot, "models/StockLedger.js"), "utf8");
  assert.match(ctrl, /buildDispatchEffectKey/);
  assert.match(ctrl, /DISPATCH_ALREADY_POSTED/);
  assert.match(ctrl, /reversedFromLedgerId/);
  assert.match(ctrl, /status:\s*"POSTING"/);
  assert.match(stock, /sourcePackingId/);
  assert.match(stock, /effectKey/);
  assert.match(ledger, /sourceSalesInvoiceId/);
  assert.match(ledger, /uniq_stockledger_packing_effect_key/);
});

run("Packing P0.5A helpers remain intact", () => {
  const packingUtil = fs.readFileSync(path.join(srcRoot, "utils/packingIdempotency.js"), "utf8");
  assert.match(packingUtil, /buildPackingEffectKey/);
  assert.match(packingUtil, /STORE_PACKING/);
});

run("RTS remains absent from Dispatch/Packing stock paths", () => {
  const ctrl = fs.readFileSync(path.join(srcRoot, "controllers/storeOutboundController.js"), "utf8");
  const stock = fs.readFileSync(path.join(srcRoot, "services/stockService.js"), "utf8");
  assert.doesNotMatch(ctrl, /\bRTS\b/);
  assert.doesNotMatch(stock, /\breadyToShip\b/i);
});

run("Sales Invoice stock path is not used by Dispatch post (source scan)", () => {
  const ctrl = fs.readFileSync(path.join(srcRoot, "controllers/storeOutboundController.js"), "utf8");
  const postBlock = ctrl.slice(ctrl.indexOf("export async function postStoreDispatch"), ctrl.indexOf("export async function cancelStoreDispatch"));
  assert.match(postBlock, /dispatchFromPacked/);
  assert.doesNotMatch(postBlock, /cancelInvoice|SALES_INVOICE_OUT/);
});

console.log(`\nDispatch idempotency: ${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
