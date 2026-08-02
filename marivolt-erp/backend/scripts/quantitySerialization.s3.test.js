/**
 * S3 — Cross-document quantity serialization concurrency tests.
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

console.log("\nQuantity serialization (S3)\n");

await run("remainingQty derives from source counters (not stock)", () => {
  assert.equal(remainingQty(10, 4), 6);
  assert.equal(remainingQty(5, 5), 0);
  assert.equal(remainingQty(5, 8), 0);
});

await run("Packing: first claim of remaining succeeds", () => {
  const line = { packedQty: 0 };
  const r = tryClaimLineQty(line, "packedQty", 5, 5);
  assert.equal(r.ok, true);
  assert.equal(line.packedQty, 5);
  assert.equal(r.remaining, 0);
});

await run("Packing: second claim of same remaining fails (A vs B)", () => {
  const line = { packedQty: 0 };
  assert.equal(tryClaimLineQty(line, "packedQty", 5, 5).ok, true);
  const r2 = tryClaimLineQty(line, "packedQty", 5, 5);
  assert.equal(r2.ok, false);
  assert.equal(r2.reason, QUANTITY_CLAIM_EXHAUSTED);
  assert.equal(line.packedQty, 5);
});

await run("Packing: concurrent A+B same remaining — only one succeeds", async () => {
  const { line, results } = await raceSerializedClaims({
    maxQty: 5,
    field: "packedQty",
    claimQtys: [5, 5],
  });
  const ok = results.filter((r) => r.ok);
  const fail = results.filter((r) => !r.ok);
  assert.equal(ok.length, 1);
  assert.equal(fail.length, 1);
  assert.equal(fail[0].reason, QUANTITY_CLAIM_EXHAUSTED);
  assert.equal(line.packedQty, 5);
});

await run("Packing: partials still work", () => {
  const line = { packedQty: 0 };
  assert.equal(tryClaimLineQty(line, "packedQty", 3, 10).ok, true);
  assert.equal(tryClaimLineQty(line, "packedQty", 4, 10).ok, true);
  assert.equal(line.packedQty, 7);
  assert.equal(remainingQty(10, line.packedQty), 3);
  assert.equal(tryClaimLineQty(line, "packedQty", 4, 10).ok, false);
  assert.equal(tryClaimLineQty(line, "packedQty", 3, 10).ok, true);
  assert.equal(line.packedQty, 10);
});

await run("Packing: cancel releases claim and restores remaining", () => {
  const line = { packedQty: 5 };
  const rel = tryReleaseLineQty(line, "packedQty", 5);
  assert.equal(rel.ok, true);
  assert.equal(line.packedQty, 0);
  assert.equal(tryClaimLineQty(line, "packedQty", 5, 5).ok, true);
});

await run("Packing: retry after failed concurrent claim works", async () => {
  const { line, results } = await raceSerializedClaims({
    maxQty: 5,
    field: "packedQty",
    claimQtys: [5, 5],
  });
  assert.equal(results.filter((r) => r.ok).length, 1);
  tryReleaseLineQty(line, "packedQty", 5);
  assert.equal(tryClaimLineQty(line, "packedQty", 5, 5).ok, true);
  assert.equal(line.packedQty, 5);
});

await run("Dispatch: concurrent A+B same packing remaining — only one succeeds", async () => {
  const { line, results } = await raceSerializedClaims({
    maxQty: 4,
    field: "dispatchedQty",
    claimQtys: [4, 4],
  });
  assert.equal(results.filter((r) => r.ok).length, 1);
  assert.equal(results.filter((r) => !r.ok).length, 1);
  assert.equal(line.dispatchedQty, 4);
});

await run("Dispatch: partials still work", () => {
  const line = { dispatchedQty: 0 };
  assert.equal(tryClaimLineQty(line, "dispatchedQty", 2, 8).ok, true);
  assert.equal(tryClaimLineQty(line, "dispatchedQty", 3, 8).ok, true);
  assert.equal(remainingQty(8, line.dispatchedQty), 3);
  assert.equal(tryClaimLineQty(line, "dispatchedQty", 3, 8).ok, true);
});

await run("Dispatch: cancel restores remaining", () => {
  const line = { dispatchedQty: 4 };
  assert.equal(tryReleaseLineQty(line, "dispatchedQty", 4).ok, true);
  assert.equal(line.dispatchedQty, 0);
  assert.equal(tryClaimLineQty(line, "dispatchedQty", 4, 4).ok, true);
});

await run("Release rejects over-release", () => {
  const line = { packedQty: 2 };
  const r = tryReleaseLineQty(line, "packedQty", 5);
  assert.equal(r.ok, false);
  assert.equal(r.reason, QUANTITY_RELEASE_CONFLICT);
});

await run("Controller wires S3 claim before stock (packing + dispatch)", () => {
  const src = fs.readFileSync(path.join(srcRoot, "controllers/storeOutboundController.js"), "utf8");
  assert.match(src, /claimAllocationLinePackQty/);
  assert.match(src, /releaseAllocationLinePackQty/);
  assert.match(src, /claimPackingLineDispatchQty/);
  assert.match(src, /releasePackingLineDispatchQty/);
  assert.match(src, /QUANTITY_CLAIM_EXHAUSTED/);
  const packClaim = src.indexOf("claimAllocationLinePackQty");
  const packStock = src.indexOf("stockService.packFromAllocation");
  assert.ok(packClaim > 0 && packStock > packClaim, "packing claim before stock");
  const dispClaim = src.indexOf("claimPackingLineDispatchQty");
  const dispStock = src.indexOf("stockService.dispatchFromPacked");
  assert.ok(dispClaim > 0 && dispStock > dispClaim, "dispatch claim before stock");
});

await run("Schema counters on allocation + packing lines", () => {
  const alloc = fs.readFileSync(path.join(srcRoot, "models/OrderAllocation.js"), "utf8");
  const pack = fs.readFileSync(path.join(srcRoot, "models/StorePacking.js"), "utf8");
  assert.match(alloc, /packedQty/);
  assert.match(pack, /dispatchedQty/);
});

await run("Quantity util does not touch ledger / effectKey / stockService", () => {
  const qs = fs.readFileSync(path.join(srcRoot, "utils/quantitySerialization.js"), "utf8");
  assert.ok(!/\bstockService\b/.test(qs));
  assert.ok(!/\bStockLedger\b/.test(qs));
  assert.ok(!/\beffectKey\b/.test(qs));
  const packingIdem = fs.readFileSync(path.join(srcRoot, "utils/packingIdempotency.js"), "utf8");
  const dispatchIdem = fs.readFileSync(path.join(srcRoot, "utils/dispatchIdempotency.js"), "utf8");
  assert.match(packingIdem, /buildPackingEffectKey/);
  assert.match(dispatchIdem, /buildDispatchEffectKey/);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
