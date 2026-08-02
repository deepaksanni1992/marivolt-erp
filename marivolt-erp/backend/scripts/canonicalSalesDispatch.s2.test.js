/**
 * S2 — Canonical Sales Dispatch architecture tests (unit / source).
 * Run: node scripts/canonicalSalesDispatch.s2.test.js
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

console.log("S2 canonical Sales Dispatch tests");

run("SalesDispatch model has postingStatus and legacy flag", () => {
  const src = fs.readFileSync(path.join(backendRoot, "src/models/SalesDispatch.js"), "utf8");
  assert.match(src, /postingStatus/);
  assert.match(src, /isLegacyLogisticsOnly/);
  assert.match(src, /linkedStoreDispatchId/);
});

run("StoreDispatch model has canonicalSalesDispatchId", () => {
  const src = fs.readFileSync(path.join(backendRoot, "src/models/StoreDispatch.js"), "utf8");
  assert.match(src, /canonicalSalesDispatchId/);
});

run("Canonical service blocks legacy logistics-only stock post", () => {
  const src = fs.readFileSync(path.join(backendRoot, "src/services/canonicalSalesDispatchService.js"), "utf8");
  assert.match(src, /isLegacyLogisticsOnly/);
  assert.match(src, /LEGACY_LOGISTICS_ONLY_NO_STOCK_POST/);
  assert.match(src, /createStoreDispatchDraftCore/);
  assert.match(src, /postStoreDispatch/);
});

run("Sales routes expose canonical post/cancel", () => {
  const src = fs.readFileSync(path.join(backendRoot, "src/routes/salesRoutes.js"), "utf8");
  assert.match(src, /sales-dispatches\/:id\/post/);
  assert.match(src, /sales-dispatches\/:id\/cancel/);
  assert.match(src, /canonicalDispatch/);
});

run("dispatchRoutes documented as internal", () => {
  const src = fs.readFileSync(path.join(backendRoot, "src/routes/dispatchRoutes.js"), "utf8");
  assert.match(src, /INTERNAL StoreDispatch/);
});

run("Store UI no longer lists Dispatch tab", () => {
  const src = fs.readFileSync(path.join(repoRoot, "src/pages/StoreModule.jsx"), "utf8");
  assert.doesNotMatch(src, /"Dispatch",\s*\n\s*"Store Reports"/);
  assert.match(src, /"Packing",\s*\n\s*"Store Reports"/);
});

run("Sales UI includes Sales Dispatch tab", () => {
  const src = fs.readFileSync(path.join(repoRoot, "src/pages/Sales.jsx"), "utf8");
  assert.match(src, /"Sales Dispatch"/);
  assert.match(src, /sales-dispatches\/\$\{id\}\/post/);
});

run("P0.5B effectKey / DISPATCH_OUT algorithm markers remain", () => {
  const src = fs.readFileSync(path.join(backendRoot, "src/controllers/storeOutboundController.js"), "utf8");
  assert.match(src, /buildDispatchEffectKey/);
  assert.match(src, /DISPATCH_OUT/);
  assert.match(src, /createStoreDispatchDraftCore/);
});

run("RTS remains absent", () => {
  const src = fs.readFileSync(path.join(backendRoot, "src/services/canonicalSalesDispatchService.js"), "utf8");
  assert.equal(/\bRTS\b/.test(src), false);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
