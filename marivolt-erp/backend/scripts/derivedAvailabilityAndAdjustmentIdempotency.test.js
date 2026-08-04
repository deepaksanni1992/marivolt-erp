/**
 * Derived availability + stockAdjustment effectKey regression tests (no DB).
 * Run: node scripts/derivedAvailabilityAndAdjustmentIdempotency.test.js
 */
import assert from "assert";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  deriveAvailableQty,
  deriveStockBuckets,
  buildPhysicalEffectKey,
} from "../src/services/stockExpectedBuckets.js";

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

// --- Canonical helper ---
ok(
  "deriveAvailableQty formula",
  deriveAvailableQty({ onHandQty: 10, reservedQty: 2, packedQty: 3 }) === 5
);
ok(
  "deriveAvailableQty treats missing as 0",
  deriveAvailableQty({}) === 0
);
ok(
  "deriveAvailableQty preserves negative",
  deriveAvailableQty({ onHandQty: 2, reservedQty: 5, packedQty: 0 }) === -3
);
ok(
  "deriveAvailableQty uses max(allocated, reserved)",
  deriveAvailableQty({ onHandQty: 10, allocatedQty: 4, reservedQty: 1, packedQty: 0 }) === 6
);

{
  const b = deriveStockBuckets({
    onHandQty: 9,
    reservedQty: 0,
    allocatedQty: 0,
    packedQty: 0,
    availableQty: 999, // stale — ignored
  });
  ok("deriveStockBuckets ignores stored availableQty", b.availableQty === 9);
}

// --- Kitting preview regressions ---
{
  const kit = read("src/controllers/kittingController.js");
  ok("kitting uses deriveStockBuckets", /deriveStockBuckets/.test(kit));
  ok(
    "kitting does not read bal?.availableQty for decisions",
    !/bal\?\.availableQty/.test(kit) && !/alt\?\.availableQty/.test(kit)
  );

  // Simulate preview math
  const staleHigh = deriveStockBuckets({
    onHandQty: 5,
    reservedQty: 2,
    packedQty: 1,
    availableQty: 50,
  });
  ok("1. Stale high stored ignored → 2", staleHigh.availableQty === 2);

  const staleLow = deriveStockBuckets({
    onHandQty: 10,
    reservedQty: 0,
    packedQty: 0,
    availableQty: 0,
  });
  ok("2. Stale low stored ignored → 10", staleLow.availableQty === 10);

  ok(
    "3. Reserved reduces availability",
    deriveAvailableQty({ onHandQty: 10, reservedQty: 4, packedQty: 0 }) === 6
  );
  ok(
    "4. Packed reduces availability",
    deriveAvailableQty({ onHandQty: 10, reservedQty: 0, packedQty: 3 }) === 7
  );
  ok(
    "5. Negative derived remains visible",
    deriveAvailableQty({ onHandQty: 1, reservedQty: 5, packedQty: 0 }) === -4
  );
}

// --- Article conversion preview ---
{
  const ac = read("src/controllers/articleConversionController.js");
  ok("article conversion imports deriveAvailableQty", /deriveAvailableQty/.test(ac));
  ok(
    "6. Preview does not use Number(stock.availableQty)",
    !/Number\(stock\.availableQty\)/.test(ac) && !/Number\(live\.availableQty\)/.test(ac)
  );
  ok(
    "7-8. Eligibility derives with reserved+packed fields",
    /deriveAvailableQty\(\{[\s\S]*reservedQty[\s\S]*packedQty/.test(ac)
  );
  ok("9-10. Context uses company+warehouse scoped getStockBalance", /getStockBalance/.test(ac));
  ok(
    "11. Conversion eligibility uses deriveAvailableQty",
    /sourceQty > derivedAvail|sourceQty > available \+/.test(ac)
  );
}

// --- EffectKey audit for stockAdjustment callers ---
function adjKey(opts) {
  return buildPhysicalEffectKey({
    movementType: opts.movementType,
    companyId: opts.companyId || "c1",
    referenceNo: opts.referenceNo,
    article: opts.article,
    warehouse: opts.warehouse || "MAIN",
    lineId: opts.lineId,
    direction: opts.direction,
    qty: opts.qty,
  });
}

{
  const kitOut = adjKey({
    movementType: "KIT_ASSEMBLY_OUT",
    referenceNo: "KIT-1",
    article: "COMP1",
    lineId: "bomLineA",
    direction: "OUT",
    qty: 2,
  });
  const kitOutRetry = adjKey({
    movementType: "KIT_ASSEMBLY_OUT",
    referenceNo: "KIT-1",
    article: "COMP1",
    lineId: "bomLineA",
    direction: "OUT",
    qty: 2,
  });
  ok("12. Kit assembly first post key stable", kitOut.includes("KIT_ASSEMBLY_OUT"));
  ok("13. Kit assembly retry same key", kitOut === kitOutRetry);

  const dekit = adjKey({
    movementType: "DEKIT_OUT",
    referenceNo: "DK-1",
    article: "PARENT",
    lineId: "PARENT:oid1",
    direction: "OUT",
    qty: 1,
  });
  const dekitRetry = adjKey({
    movementType: "DEKIT_OUT",
    referenceNo: "DK-1",
    article: "PARENT",
    lineId: "PARENT:oid1",
    direction: "OUT",
    qty: 1,
  });
  ok("14. De-kit first post key", dekit.includes("DEKIT_OUT"));
  ok("15. De-kit retry same key", dekit === dekitRetry);

  const convOut = buildPhysicalEffectKey({
    movementType: "ARTICLE_CONVERSION_OUT",
    companyId: "c1",
    referenceNo: "ASC-1",
    article: "SRC",
    warehouse: "MAIN",
    lineId: "convId",
    direction: "OUT",
    qty: 3,
  });
  const convReplay = buildPhysicalEffectKey({
    movementType: "ARTICLE_CONVERSION_OUT",
    companyId: "c1",
    referenceNo: "ASC-1",
    article: "SRC",
    warehouse: "MAIN",
    lineId: "convId",
    direction: "OUT",
    qty: 3,
  });
  ok("16. Article conversion replay same key", convOut === convReplay);

  const sr = adjKey({
    movementType: "STOCK_ADJUSTMENT",
    referenceNo: "SR-1",
    article: "A",
    lineId: "lineOid",
    direction: "IN",
    qty: 2,
  });
  ok("17. Sales return key includes lineId", sr.includes("lineOid") && sr.includes("IN"));

  const pr = adjKey({
    movementType: "STOCK_ADJUSTMENT",
    referenceNo: "PR-1",
    article: "B",
    lineId: "prLine",
    direction: "OUT",
    qty: 1,
  });
  ok("18. Purchase return key includes lineId", pr.includes("prLine"));

  const post = adjKey({
    movementType: "STOCK_ADJUSTMENT",
    referenceNo: "ADJ-1",
    article: "X",
    lineId: "L1",
    direction: "IN",
    qty: 5,
  });
  const rev = adjKey({
    movementType: "STOCK_ADJUSTMENT",
    referenceNo: "ADJ-1",
    article: "X",
    lineId: "L1",
    direction: "OUT",
    qty: 5,
  });
  ok("19. Post and reverse direction keys differ", post !== rev);

  const concurrent = [kitOut, kitOutRetry, adjKey({
    movementType: "KIT_ASSEMBLY_OUT",
    referenceNo: "KIT-1",
    article: "COMP1",
    lineId: "bomLineA",
    direction: "OUT",
    qty: 2,
  })];
  ok("20. Concurrent duplicate same effectKey", concurrent.every((k) => k === kitOut));
}

// Source wiring for lineId on callers
{
  const kitExec = read("src/services/kittingExecution.js");
  const sr = read("src/controllers/salesReturnController.js");
  const pr = read("src/controllers/purchaseReturnController.js");
  const q = read("src/controllers/quotationController.js");
  ok("kittingExecution passes lineId", /lineId: lineKey|lineId: `PARENT:/.test(kitExec));
  ok("sales return passes lineId", /lineId: String\(line\._id/.test(sr));
  ok("purchase return passes lineId", /lineId: String\(line\._id/.test(pr));
  ok("quotation passes lineId", /lineId: String\(lineId\)/.test(q));
  ok(
    "stockAdjustment soft-idempotent",
    /findLedgerByEffectKey/.test(read("src/services/stockService.js"))
  );
}

console.log(`\n${passed} assertions passed`);
