/**
 * Unit tests for PO → Item Master sync identity helpers (no database).
 * Run: node backend/scripts/poItemMasterSync.test.js
 */
import assert from "node:assert/strict";
import { normalizePoItemIdentity } from "../src/services/poItemMasterSyncService.js";

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    return true;
  } catch (e) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${e.message}`);
    return false;
  }
}

let passed = 0;
let failed = 0;
function run(name, fn) {
  if (test(name, fn)) passed += 1;
  else failed += 1;
}

console.log("\nPO Item Master Sync\n");

run("normalizes part number case and whitespace", () => {
  const id = normalizePoItemIdentity({ partNumber: "  433598  aa  ", article: "x" });
  assert.equal(id.partNumber, "433598 AA");
  assert.equal(id.article, "X");
});

run("prefers explicit article over partNumber for article field", () => {
  const id = normalizePoItemIdentity({ article: "ART-1", partNumber: "433598 AA" });
  assert.equal(id.article, "ART-1");
  assert.equal(id.partNumber, "433598 AA");
});

run("falls back article from part number when article missing", () => {
  const id = normalizePoItemIdentity({ partNumber: "433598 AA" });
  assert.equal(id.article, "433598 AA");
  assert.equal(id.partNumber, "433598 AA");
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
