/**
 * Unit tests for PO → Item Master sync identity helpers (no database).
 * Run: node backend/scripts/poItemMasterSync.test.js
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizePoItemIdentity } from "../src/services/poItemMasterSyncService.js";
import { sanitizeIncomingTaxonomy } from "../src/utils/itemMasterTaxonomy.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcRoot = path.join(__dirname, "..", "src");

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

run("create/update PO controller imports syncPoLinesToItemMaster", () => {
  const src = fs.readFileSync(path.join(srcRoot, "controllers", "purchaseController.js"), "utf8");
  assert.match(src, /import \{ syncPoLinesToItemMaster \} from "\.\.\/services\/poItemMasterSyncService\.js"/);
  const createStart = src.indexOf("export async function createPurchaseOrder");
  const updateStart = src.indexOf("export async function updatePurchaseOrder");
  const create = src.slice(createStart, updateStart);
  const update = src.slice(updateStart);
  assert.match(create, /await syncPoLinesToItemMaster\(/);
  assert.match(create, /asnActiveQty: 0/);
  assert.match(update, /await syncPoLinesToItemMaster\(/);
  assert.doesNotMatch(src, /from "\.\.\/services\/asnReceivingPostService/);
});

run("PO Item Master sync sanitizes inverted Vertical/Brand before write", () => {
  const service = fs.readFileSync(path.join(srcRoot, "services", "poItemMasterSyncService.js"), "utf8");
  assert.match(service, /sanitizeIncomingTaxonomy/);
  const fixed = sanitizeIncomingTaxonomy({ vertical: "Wartsila", brand: "Engine", engine: "Engine" });
  assert.equal(fixed.vertical, "Engine");
  assert.equal(fixed.brand, "Wartsila");
  assert.notEqual(fixed.vertical, "Wartsila");
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
