/**
 * P0.5A Packing posting / cancellation idempotency tests.
 * Run: node scripts/packingIdempotency.test.js
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PACKING_ALREADY_POSTED,
  PACKING_CANCEL_IN_PROGRESS,
  PACKING_EFFECT_INDEX_SPEC,
  PACKING_EFFECT_UNIQUE_INDEX,
  PACKING_LEDGER_INCONSISTENT,
  PACKING_POST_IN_PROGRESS,
  PACKING_SOURCE_DOCUMENT_TYPE,
  buildPackingEffectKey,
  buildPackingReversalEffectKey,
  isPackingEffectDuplicateKeyError,
  simulatePackingCancel,
  simulatePackingPost,
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

console.log("\nPacking idempotency (P0.5A)\n");

run("Effect key is deterministic and includes source line", () => {
  const a = buildPackingEffectKey({
    companyId: "c1",
    packingId: "p1",
    packingLineId: "l1",
    movementType: "PACKED",
    warehouse: "MAIN",
  });
  const b = buildPackingEffectKey({
    companyId: "c1",
    packingId: "p1",
    packingLineId: "l1",
    movementType: "PACKED",
    warehouse: "main",
  });
  assert.equal(a, b);
  assert.match(a, new RegExp(`^c1\\|${PACKING_SOURCE_DOCUMENT_TYPE}\\|p1\\|l1\\|PACKED\\|`));
  const other = buildPackingEffectKey({
    companyId: "c1",
    packingId: "p1",
    packingLineId: "l2",
    movementType: "PACKED",
    warehouse: "MAIN",
  });
  assert.notEqual(a, other);
});

run("Reversal effect key is derived from original", () => {
  const orig = buildPackingEffectKey({
    companyId: "c1",
    packingId: "p1",
    packingLineId: "l1",
    movementType: "PACKED",
    warehouse: "MAIN",
  });
  assert.equal(buildPackingReversalEffectKey(orig), `${orig}|REVERSAL`);
});

run("Index spec is partial unique on effectKey", () => {
  assert.equal(PACKING_EFFECT_INDEX_SPEC.name, PACKING_EFFECT_UNIQUE_INDEX);
  assert.equal(PACKING_EFFECT_INDEX_SPEC.unique, true);
  assert.deepEqual(PACKING_EFFECT_INDEX_SPEC.key, { effectKey: 1 });
});

run("First packing post succeeds once", () => {
  const store = new Map([["p1", { status: "DRAFT", hasEvidence: false }]]);
  let moves = 0;
  const r = simulatePackingPost({
    store,
    packingId: "p1",
    hasPackedEvidence: (d) => Boolean(d.hasEvidence),
    stockWork: () => {
      moves += 1;
    },
  });
  assert.equal(r.outcome, "posted");
  assert.equal(moves, 1);
  assert.equal(store.get("p1").status, "FULLY_PACKED");
});

run("Repeated post of healthy posted packing is idempotent", () => {
  const store = new Map([["p1", { status: "FULLY_PACKED", hasEvidence: true }]]);
  let moves = 0;
  const r = simulatePackingPost({
    store,
    packingId: "p1",
    hasPackedEvidence: (d) => Boolean(d.hasEvidence),
    stockWork: () => {
      moves += 1;
    },
  });
  assert.equal(r.outcome, "idempotent");
  assert.equal(moves, 0);
});

run("Two simultaneous posts: one stock effect only", () => {
  const store = new Map([["p2", { status: "DRAFT", hasEvidence: false }]]);
  let moves = 0;
  // First claim to POSTING without completing stock (simulate in-flight).
  store.set("p2", { status: "POSTING", hasEvidence: false });
  let secondErr = null;
  try {
    simulatePackingPost({
      store,
      packingId: "p2",
      hasPackedEvidence: (d) => Boolean(d.hasEvidence),
      stockWork: () => {
        moves += 1;
      },
    });
  } catch (e) {
    secondErr = e;
  }
  assert.ok(secondErr);
  assert.equal(secondErr.code, PACKING_POST_IN_PROGRESS);
  assert.equal(moves, 0);
  // Winner finishes.
  store.set("p2", { status: "DRAFT", hasEvidence: false });
  const first = simulatePackingPost({
    store,
    packingId: "p2",
    hasPackedEvidence: (d) => Boolean(d.hasEvidence),
    stockWork: () => {
      moves += 1;
    },
  });
  assert.equal(first.outcome, "posted");
  assert.equal(moves, 1);
});

run("Posted without ledger evidence returns PACKING_LEDGER_INCONSISTENT", () => {
  const store = new Map([["p3", { status: "FULLY_PACKED", hasEvidence: false }]]);
  assert.throws(
    () =>
      simulatePackingPost({
        store,
        packingId: "p3",
        hasPackedEvidence: (d) => Boolean(d.hasEvidence),
        stockWork: () => {},
      }),
    (e) => e.code === PACKING_LEDGER_INCONSISTENT
  );
});

run("Stock failure during post aborts to DRAFT", () => {
  const store = new Map([["p4", { status: "DRAFT", hasEvidence: false }]]);
  assert.throws(
    () =>
      simulatePackingPost({
        store,
        packingId: "p4",
        hasPackedEvidence: (d) => Boolean(d.hasEvidence),
        stockWork: () => {
          throw new Error("simulated stock failure");
        },
      }),
    /simulated stock failure/
  );
  assert.equal(store.get("p4").status, "DRAFT");
});

run("E11000 on effectKey maps to packing conflict detector", () => {
  assert.equal(
    isPackingEffectDuplicateKeyError({
      code: 11000,
      message: `E11000 duplicate key error index: ${PACKING_EFFECT_UNIQUE_INDEX}`,
      keyPattern: { effectKey: 1 },
    }),
    true
  );
  assert.equal(
    isPackingEffectDuplicateKeyError({
      code: 11000,
      keyPattern: { companyId: 1, packingNo: 1 },
      message: "E11000 duplicate key error index: companyId_1_packingNo_1",
    }),
    false
  );
});

run("Cancellation reverses once; repeat is idempotent", () => {
  const store = new Map([["p5", { status: "FULLY_PACKED", hasEvidence: true, hasUnpack: false }]]);
  let moves = 0;
  const r1 = simulatePackingCancel({
    store,
    packingId: "p5",
    hasPackedEvidence: (d) => Boolean(d.hasEvidence),
    hasUnpackEvidence: (d) => Boolean(d.hasUnpack),
    stockWork: () => {
      moves += 1;
    },
  });
  assert.equal(r1.outcome, "cancelled");
  assert.equal(moves, 1);
  const r2 = simulatePackingCancel({
    store,
    packingId: "p5",
    hasPackedEvidence: (d) => Boolean(d.hasEvidence),
    hasUnpackEvidence: (d) => Boolean(d.hasUnpack),
    stockWork: () => {
      moves += 1;
    },
  });
  assert.equal(r2.outcome, "idempotent");
  assert.equal(moves, 1);
});

run("Concurrent cancellation: only one reverses stock", () => {
  const store = new Map([["p6", { status: "FULLY_PACKED", hasEvidence: true, hasUnpack: false }]]);
  let moves = 0;
  const first = simulatePackingCancel({
    store,
    packingId: "p6",
    hasPackedEvidence: (d) => Boolean(d.hasEvidence),
    hasUnpackEvidence: (d) => Boolean(d.hasUnpack),
    stockWork: () => {
      moves += 1;
      // leave in CANCELLING until we finish — simulate by not completing yet
    },
  });
  // After first completes status is CANCELLED; second is idempotent.
  assert.equal(first.outcome, "cancelled");
  let secondErr = null;
  try {
    // Force in-progress path
    store.set("p6", { status: "CANCELLING", hasEvidence: true, hasUnpack: false });
    simulatePackingCancel({
      store,
      packingId: "p6",
      hasPackedEvidence: (d) => Boolean(d.hasEvidence),
      hasUnpackEvidence: (d) => Boolean(d.hasUnpack),
      stockWork: () => {
        moves += 1;
      },
    });
  } catch (e) {
    secondErr = e;
  }
  assert.ok(secondErr);
  assert.equal(secondErr.code, PACKING_CANCEL_IN_PROGRESS);
  assert.equal(moves, 1);
});

run("Missing packed ledger blocks cancellation", () => {
  const store = new Map([["p7", { status: "FULLY_PACKED", hasEvidence: false }]]);
  assert.throws(
    () =>
      simulatePackingCancel({
        store,
        packingId: "p7",
        hasPackedEvidence: (d) => Boolean(d.hasEvidence),
        hasUnpackEvidence: () => false,
        stockWork: () => {},
      }),
    (e) => e.code === PACKING_LEDGER_INCONSISTENT
  );
});

run("Controller uses claim + effectKey + controlled error codes", () => {
  const src = fs.readFileSync(path.join(srcRoot, "controllers/storeOutboundController.js"), "utf8");
  assert.match(src, /status: "POSTING"/);
  assert.match(src, /status: "CANCELLING"/);
  assert.match(src, /buildPackingEffectKey/);
  assert.match(src, /PACKING_ALREADY_POSTED/);
  assert.match(src, /PACKING_LEDGER_INCONSISTENT/);
  assert.match(src, /reversedFromLedgerId/);
  assert.match(src, /recalculateAllocationPackingProgress/);
  assert.doesNotMatch(src, /moveAllocationToRTS/);
  assert.doesNotMatch(src, /\bRTS_COMPLETE\b/);
});

run("stockService pack/unpack accept source identity fields", () => {
  const src = fs.readFileSync(path.join(srcRoot, "services/stockService.js"), "utf8");
  assert.match(src, /effectKey/);
  assert.match(src, /sourceDocumentType/);
  assert.match(src, /sourceLineId/);
  assert.match(src, /reversedFromLedgerId/);
});

run("StockLedger model declares packing effect unique index", () => {
  const src = fs.readFileSync(path.join(srcRoot, "models/StockLedger.js"), "utf8");
  assert.match(src, /uniq_stockledger_packing_effect_key/);
  assert.match(src, /effectKey/);
  assert.match(src, /sourceDocumentId/);
});

run("StorePacking status enum includes POSTING and CANCELLING", () => {
  const src = fs.readFileSync(path.join(srcRoot, "models/StorePacking.js"), "utf8");
  assert.match(src, /"POSTING"/);
  assert.match(src, /"CANCELLING"/);
});

run("RTS remains absent from packing/stock production paths", () => {
  assert.equal(fs.existsSync(path.join(srcRoot, "models/Rts.js")), false);
  const stock = fs.readFileSync(path.join(srcRoot, "services/stockService.js"), "utf8");
  assert.doesNotMatch(stock, /RTS_TRANSFER/);
  assert.doesNotMatch(stock, /rtsQty/);
});

run("Partial packing: distinct packing line keys do not collide", () => {
  const k1 = buildPackingEffectKey({
    companyId: "c",
    packingId: "packA",
    packingLineId: "line1",
    movementType: "PACKED",
    warehouse: "MAIN",
  });
  const k2 = buildPackingEffectKey({
    companyId: "c",
    packingId: "packB",
    packingLineId: "line1",
    movementType: "PACKED",
    warehouse: "MAIN",
  });
  assert.notEqual(k1, k2);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
