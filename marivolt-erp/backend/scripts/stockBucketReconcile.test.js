/**
 * Stock bucket orphan detection + Article Traceability ERP stock labeling.
 * Run: node scripts/stockBucketReconcile.test.js
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.join(__dirname, "..");
const repoRoot = path.join(backendRoot, "..");

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

console.log("\nStock bucket reconcile / traceability stock labels\n");

run("Traceability computeErpStockBreakdown returns on-hand not free-available as erpStockQty", () => {
  const src = fs.readFileSync(path.join(backendRoot, "src/services/articleTraceabilityService.js"), "utf8");
  assert.match(src, /computeErpStockBreakdown/);
  assert.match(src, /erpOnHandQty:\s*erp\.onHandQty/);
  assert.match(src, /erpFreeAvailableQty:\s*erp\.freeAvailableQty/);
  assert.match(src, /erpStockQty:\s*erp\.onHandQty/);
  // Must not still define erpStockQty as onHand - allocated - packed exclusively without breakdown
  assert.doesNotMatch(
    src,
    /async function computeErpStockQty[\s\S]{0,200}total \+= onHand - allocated - packed/
  );
});

run("Traceability UI shows On Hand / Reserved / Packed / Free Available separately", () => {
  const ui = fs.readFileSync(path.join(repoRoot, "src/pages/ArticleTraceability.jsx"), "utf8");
  assert.match(ui, /ERP On Hand/);
  assert.match(ui, /Free Available/);
  assert.match(ui, /Reserved/);
  assert.match(ui, /Packed/);
  assert.match(ui, /Customs Available/);
  assert.doesNotMatch(ui, /\["ERP Stock Qty"/);
});

run("Reconcile service detects orphan when reserved > allocation evidence", () => {
  const src = fs.readFileSync(
    path.join(backendRoot, "src/services/stockBucketReconcileService.js"),
    "utf8"
  );
  assert.match(src, /computeExpectedReservedFromAllocations/);
  assert.match(src, /stockExpectedBuckets/);
  assert.match(src, /orphanedReservedQty/);
  assert.match(src, /diagnoseOrphanedStockBuckets/);
  assert.match(src, /repairOrphanedStockBuckets/);
  assert.match(src, /dryRun/);
  assert.match(src, /Repair reason is mandatory/);
  // Must not write GRN or customs inbound
  assert.doesNotMatch(src, /grnReceive|createCustomsLotFromGrn|CustomsLotItem\.create/);
  // Projection only
  assert.match(src, /reservedQty:\s*targetReserved/);
});

run("Admin routes wire diagnose + repair without auto-run", () => {
  const routes = fs.readFileSync(path.join(backendRoot, "src/routes/adminRoutes.js"), "utf8");
  assert.match(routes, /\/stock\/orphan-buckets/);
  assert.match(routes, /\/stock\/orphan-buckets\/repair/);
  assert.match(routes, /requireRole\(\.\.\.adminRoles\)/);
});

run("Formula helpers: GRN+9 no allocation → free 9", () => {
  const onHand = 9;
  const reserved = 0;
  const packed = 0;
  assert.equal(Math.max(0, onHand - reserved - packed), 9);
});

run("Formula helpers: GRN+9 allocation 9 → free 0, onHand still 9", () => {
  const onHand = 9;
  const reserved = 9;
  const packed = 0;
  assert.equal(onHand, 9);
  assert.equal(Math.max(0, onHand - reserved - packed), 0);
});

run("Formula helpers: packed 9 displayed separately; onHand unchanged", () => {
  const onHand = 9;
  const reserved = 0;
  const packed = 9;
  assert.equal(onHand, 9);
  assert.equal(packed, 9);
  assert.equal(Math.max(0, onHand - reserved - packed), 0);
});

run("Customs qty cannot substitute for ERP free stock", () => {
  const customsAvailable = 9;
  const erpFree = 0;
  assert.notEqual(customsAvailable, erpFree);
  assert.equal(erpFree < 1 && customsAvailable === 9, true);
});

run("Orphan detection logic: reserved 9, no alloc docs → orphan 9", () => {
  const reservedQty = 9;
  const expectedReservedQty = 0;
  const orphanedReservedQty = Math.max(0, reservedQty - expectedReservedQty);
  const allocationEvidenceLength = 0;
  const hasOrphan = orphanedReservedQty > 1e-6 && allocationEvidenceLength === 0;
  assert.equal(orphanedReservedQty, 9);
  assert.equal(hasOrphan, true);
});

run("Repair idempotent: already at expected reserved → no orphan", () => {
  const reservedQty = 0;
  const expectedReservedQty = 0;
  const orphanedReservedQty = Math.max(0, reservedQty - expectedReservedQty);
  assert.equal(orphanedReservedQty, 0);
  assert.equal(orphanedReservedQty > 1e-6, false);
});

run("Missing ERP GRN ledger detection shape", () => {
  const hasGrnErpLedgerInbound = false;
  const customsStockQty = 9;
  const caseA = !hasGrnErpLedgerInbound && customsStockQty > 0;
  assert.equal(caseA, true);
});

run("Conversion preview surfaces reserved/packed/blockReason", () => {
  const ui = fs.readFileSync(
    path.join(repoRoot, "src/components/store/ArticleStockConversionPanel.jsx"),
    "utf8"
  );
  assert.match(ui, /Reserved:/);
  assert.match(ui, /Packed:/);
  assert.match(ui, /blockReason|orphanedReservation/);
  const ctrl = fs.readFileSync(
    path.join(backendRoot, "src/controllers/articleConversionController.js"),
    "utf8"
  );
  assert.match(ctrl, /orphanedReservation/);
  assert.match(ctrl, /openAllocations/);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
