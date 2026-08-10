/**
 * Article conversion StockBalance availableQty projection (commercial).
 * Run: node scripts/articleConversionStockBalance.test.js
 *
 * availableQty is a persisted projection; after conversion it must equal
 * deriveAvailableQty(authoritative buckets). No DB required.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "path";
import { fileURLToPath } from "url";
import { deriveAvailableQty } from "../src/services/stockExpectedBuckets.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.join(__dirname, "..");
const stockSrc = fs.readFileSync(path.join(backendRoot, "src/services/stockService.js"), "utf8");

function buckets(partial = {}) {
  return {
    onHandQty: 0,
    quantity: 0,
    reservedQty: 0,
    allocatedQty: 0,
    packedQty: 0,
    availableQty: 0,
    ...partial,
  };
}

/** Simulate conversion physical $inc then projection refresh (canonical helper). */
function applyConversionPhysical({ source, target, take }) {
  const free =
    (Number(source.quantity ?? source.onHandQty) || 0) -
    (Number(source.reservedQty) || 0) -
    (Number(source.packedQty) || 0);
  if (take > free + 1e-9) {
    const err = new Error("ARTICLE_CONVERSION_STOCK_SHORTAGE");
    err.code = "ARTICLE_CONVERSION_STOCK_SHORTAGE";
    throw err;
  }
  const src = {
    ...source,
    onHandQty: (Number(source.onHandQty) || 0) - take,
    quantity: (Number(source.quantity ?? source.onHandQty) || 0) - take,
  };
  src.availableQty = deriveAvailableQty(src);

  const tgt = {
    ...target,
    onHandQty: (Number(target.onHandQty) || 0) + take,
    quantity: (Number(target.quantity ?? target.onHandQty) || 0) + take,
  };
  tgt.availableQty = deriveAvailableQty(tgt);
  return { source: src, target: tgt };
}

// --- Source wiring ---
{
  assert.match(stockSrc, /async function refreshStoredAvailableQty/);
  assert.match(stockSrc, /deriveAvailableQty/);
  const fnStart = stockSrc.indexOf("export async function articleConversion");
  const fnEnd = stockSrc.indexOf("export async function reverseArticleConversion");
  const body = stockSrc.slice(fnStart, fnEnd);
  assert.equal(
    (body.match(/refreshStoredAvailableQty/g) || []).length,
    2,
    "articleConversion refreshes source + target availableQty",
  );
  assert.match(body, /inc:\s*\{\s*quantity:\s*-srcQty,\s*onHandQty:\s*-srcQty/);
  assert.match(body, /inc:\s*\{\s*quantity:\s*tgtQty,\s*onHandQty:\s*tgtQty/);
  // Must not invent a second formula inline
  assert.doesNotMatch(body, /availableQty:\s*tgtQty/);
  assert.doesNotMatch(body, /availableQty:\s*srcQty/);
}

{
  const fnStart = stockSrc.indexOf("export async function reverseArticleConversion");
  const fnEnd = stockSrc.indexOf("export async function packFromAllocation");
  const body = stockSrc.slice(fnStart, fnEnd);
  assert.equal(
    (body.match(/refreshStoredAvailableQty/g) || []).length,
    2,
    "reverseArticleConversion refreshes both legs",
  );
}

// bumpBuckets itself must NOT gain global availableQty maintenance in this phase
{
  const bumpStart = stockSrc.indexOf("async function bumpBuckets");
  const bumpFnEnd = stockSrc.indexOf("\n}\n\n/**\n * Persist StockBalance.availableQty", bumpStart);
  const bumpBody =
    bumpFnEnd > 0 ? stockSrc.slice(bumpStart, bumpFnEnd + 2) : stockSrc.slice(bumpStart, bumpStart + 1200);
  assert.match(bumpBody, /async function bumpBuckets/);
  assert.match(bumpBody, /return updated;/);
  assert.doesNotMatch(bumpBody, /availableQty/);
  assert.doesNotMatch(bumpBody, /deriveAvailableQty/);
}

// --- TEST A — unreserved full conversion ---
{
  const beforeSrc = buckets({ onHandQty: 9, quantity: 9, availableQty: 9 });
  const beforeTgt = buckets();
  const { source, target } = applyConversionPhysical({
    source: beforeSrc,
    target: beforeTgt,
    take: 9,
  });
  assert.equal(source.onHandQty, 0);
  assert.equal(source.availableQty, 0);
  assert.equal(target.onHandQty, 9);
  assert.equal(target.availableQty, 9);
  assert.equal(target.availableQty, deriveAvailableQty(target));
}

// --- TEST B — partial conversion ---
{
  const { source, target } = applyConversionPhysical({
    source: buckets({ onHandQty: 10, quantity: 10, availableQty: 10 }),
    target: buckets(),
    take: 4,
  });
  assert.equal(source.onHandQty, 6);
  assert.equal(source.availableQty, 6);
  assert.equal(target.onHandQty, 4);
  assert.equal(target.availableQty, 4);
}

// --- TEST C — target pre-reserved (MAR-ALLOC-0015 shape) ---
{
  const { source, target } = applyConversionPhysical({
    source: buckets({ onHandQty: 9, quantity: 9, availableQty: 9 }),
    target: buckets({ onHandQty: 0, quantity: 0, reservedQty: 9, availableQty: -9 }),
    take: 9,
  });
  assert.equal(source.onHandQty, 0);
  assert.equal(source.availableQty, 0);
  assert.equal(target.onHandQty, 9);
  assert.equal(target.reservedQty, 9);
  assert.equal(target.availableQty, 0);
  assert.notEqual(target.availableQty, 9);
}

// --- TEST D — source reserved / free-stock guard ---
{
  const source = buckets({ onHandQty: 10, quantity: 10, reservedQty: 3, availableQty: 7 });
  assert.throws(
    () => applyConversionPhysical({ source, target: buckets(), take: 8 }),
    (e) => e.code === "ARTICLE_CONVERSION_STOCK_SHORTAGE",
  );
  const ok = applyConversionPhysical({ source, target: buckets(), take: 7 });
  assert.equal(ok.source.onHandQty, 3);
  assert.equal(ok.source.reservedQty, 3);
  assert.equal(ok.source.availableQty, 0);
}

// --- TEST E — retry / idempotent projection refresh (same final buckets) ---
{
  const final = buckets({ onHandQty: 0, quantity: 0, reservedQty: 0, availableQty: 9 }); // stale
  const refreshed = { ...final, availableQty: deriveAvailableQty(final) };
  assert.equal(refreshed.availableQty, 0);
  const again = { ...refreshed, availableQty: deriveAvailableQty(refreshed) };
  assert.equal(again.availableQty, 0);
  assert.equal(again.availableQty, refreshed.availableQty);
}

// --- TEST F — negative available (allocation-before-purchase) ---
{
  const targetBefore = buckets({ onHandQty: 0, quantity: 0, reservedQty: 9, availableQty: -9 });
  assert.equal(deriveAvailableQty(targetBefore), -9);
  const afterPartial = {
    ...targetBefore,
    onHandQty: 4,
    quantity: 4,
  };
  afterPartial.availableQty = deriveAvailableQty(afterPartial);
  assert.equal(afterPartial.availableQty, -5);
}

// --- Stale 8X0098 shape: stored != derived until refresh ---
{
  const stale = buckets({ onHandQty: 0, quantity: 0, reservedQty: 0, availableQty: 9 });
  assert.equal(deriveAvailableQty(stale), 0);
  assert.notEqual(stale.availableQty, deriveAvailableQty(stale));
  stale.availableQty = deriveAvailableQty(stale);
  assert.equal(stale.availableQty, 0);
}

console.log("articleConversionStockBalance.test.js: all passed");
