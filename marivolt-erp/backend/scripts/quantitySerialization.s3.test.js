/**
 * S3 — Packing allocation-line quantity serialization tests.
 * Run: node scripts/quantitySerialization.s3.test.js
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  QUANTITY_CLAIM_EXHAUSTED,
  QUANTITY_RELEASE_CONFLICT,
  raceSerializedClaims,
  remainingQty,
  tryClaimLineQty,
  tryReleaseLineQty,
} from "../src/utils/quantitySerialization.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcRoot = path.join(__dirname, "..", "src");

let passed = 0;
let failed = 0;

async function run(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed += 1;
    console.error(`  ✗ ${name}`);
    console.error(`    ${e.message}`);
  }
}

console.log("\nQuantity serialization S3 — packing\n");

await run("remainingQty derives from source counters (not stock)", () => {
  assert.equal(remainingQty(10, 4), 6);
  assert.equal(remainingQty(5, 5), 0);
});

await run("Packing: first claim of remaining succeeds", () => {
  const line = { packedQty: 0 };
  const r = tryClaimLineQty(line, "packedQty", 5, 5);
  assert.equal(r.ok, true);
  assert.equal(line.packedQty, 5);
});

await run("Packing: second claim of same remaining fails (A vs B)", () => {
  const line = { packedQty: 0 };
  assert.equal(tryClaimLineQty(line, "packedQty", 5, 5).ok, true);
  const r2 = tryClaimLineQty(line, "packedQty", 5, 5);
  assert.equal(r2.ok, false);
  assert.equal(r2.reason, QUANTITY_CLAIM_EXHAUSTED);
});

await run("Packing: concurrent A+B same remaining — only one succeeds", async () => {
  const { line, results } = await raceSerializedClaims({
    maxQty: 5,
    field: "packedQty",
    claimQtys: [5, 5],
  });
  assert.equal(results.filter((r) => r.ok).length, 1);
  assert.equal(results.filter((r) => !r.ok).length, 1);
  assert.equal(line.packedQty, 5);
});

await run("Packing: partials still work", () => {
  const line = { packedQty: 0 };
  assert.equal(tryClaimLineQty(line, "packedQty", 3, 10).ok, true);
  assert.equal(tryClaimLineQty(line, "packedQty", 4, 10).ok, true);
  assert.equal(tryClaimLineQty(line, "packedQty", 3, 10).ok, true);
  assert.equal(line.packedQty, 10);
});

await run("Packing: cancel releases claim and restores remaining", () => {
  const line = { packedQty: 5 };
  assert.equal(tryReleaseLineQty(line, "packedQty", 5).ok, true);
  assert.equal(tryClaimLineQty(line, "packedQty", 5, 5).ok, true);
});

await run("Packing: retry after failed concurrent claim works", async () => {
  const { line } = await raceSerializedClaims({
    maxQty: 5,
    field: "packedQty",
    claimQtys: [5, 5],
  });
  tryReleaseLineQty(line, "packedQty", 5);
  assert.equal(tryClaimLineQty(line, "packedQty", 5, 5).ok, true);
});

await run("Release rejects over-release", () => {
  const line = { packedQty: 2 };
  assert.equal(tryReleaseLineQty(line, "packedQty", 5).reason, QUANTITY_RELEASE_CONFLICT);
});

await run("Controller claims allocation line before packing stock", () => {
  const src = fs.readFileSync(path.join(srcRoot, "controllers/storeOutboundController.js"), "utf8");
  assert.match(src, /claimAllocationLinePackQty/);
  assert.match(src, /releaseAllocationLinePackQty/);
  const packClaim = src.indexOf("claimAllocationLinePackQty");
  const packStock = src.indexOf("stockService.packFromAllocation");
  assert.ok(packClaim > 0 && packStock > packClaim);
});

await run("Allocation line schema has packedQty", () => {
  const alloc = fs.readFileSync(path.join(srcRoot, "models/OrderAllocation.js"), "utf8");
  assert.match(alloc, /packedQty/);
});

await run("Quantity util does not import ledger / stock paths", () => {
  const qs = fs.readFileSync(path.join(srcRoot, "utils/quantitySerialization.js"), "utf8");
  assert.ok(!/\bstockService\b/.test(qs));
  assert.ok(!/\bStockLedger\b/.test(qs));
  assert.ok(!/\beffectKey\b/.test(qs));
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
