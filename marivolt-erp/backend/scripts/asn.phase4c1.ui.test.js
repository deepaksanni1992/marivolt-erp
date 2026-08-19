/**
 * Phase 4C.1 — ASN / GRN workflow UI integration (source assertions).
 * Run: node scripts/asn.phase4c1.ui.test.js
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { remainingAsnQty } from "../src/utils/asnRules.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcRoot = path.join(__dirname, "..", "src");
const feRoot = path.join(__dirname, "..", "..", "src");

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

console.log("\nASN Phase 4C.1 Workflow UI\n");

const asnPage = fs.readFileSync(path.join(feRoot, "pages", "Asn.jsx"), "utf8");
const picker = fs.readFileSync(path.join(feRoot, "components", "asn", "AsnCreatePoPicker.jsx"), "utf8");
const purchase = fs.readFileSync(path.join(feRoot, "pages", "Purchase.jsx"), "utf8");
const store = fs.readFileSync(path.join(feRoot, "pages", "StoreModule.jsx"), "utf8");
const incoming = fs.readFileSync(path.join(feRoot, "components", "store", "IncomingShipmentsPanel.jsx"), "utf8");
const post = fs.readFileSync(path.join(srcRoot, "services", "asnReceivingPostService.js"), "utf8");
const resolver = fs.readFileSync(path.join(srcRoot, "services", "asnReceivingSourceResolver.js"), "utf8");
const rbac = fs.readFileSync(path.join(feRoot, "lib", "rbac.js"), "utf8");
const asnUi = fs.readFileSync(path.join(feRoot, "lib", "asnUi.js"), "utf8");
const roleService = fs.readFileSync(path.join(srcRoot, "services", "roleService.js"), "utf8");

run("A. ASN page exposes Create ASN", () => {
  assert.match(asnPage, /\+ Create ASN/);
  assert.match(asnPage, /to="\/asn\/new"/);
});

run("B. eligible PO can be selected on Create ASN", () => {
  assert.match(picker, /Select Purchase Order/);
  assert.match(picker, /\/purchase-orders/);
  assert.match(asnPage, /AsnCreatePoPicker/);
});

run("C. PO detail launches the same ASN create workflow", () => {
  assert.match(purchase, /\/asn\/new\?poId=/);
  assert.match(asnPage, /sourcePoId: poId/);
  assert.match(asnPage, /apiPost\("\/asn"/);
});

run("D. available ASN qty is ordered - cancelled - received - active ASN", () => {
  assert.equal(remainingAsnQty(100, 30, 20), 50);
  assert.equal(remainingAsnQty(100, 20, 25), 55);
  const svc = fs.readFileSync(path.join(srcRoot, "services", "asnService.js"), "utf8");
  assert.match(svc, /receivedQty: poLineReceivedQtyForAsn\(line\)/);
  assert.match(svc, /remainingAsnQty\(/);
});

run("E. server still blocks excess ASN qty", () => {
  const svc = fs.readFileSync(path.join(srcRoot, "services", "asnService.js"), "utf8");
  assert.match(svc, /claimPoLineAsnQty/);
  assert.match(svc, /ASN_QTY_EXCEEDED/);
});

run("F. multiple ASNs against one PO remain supported", () => {
  const svc = fs.readFileSync(path.join(srcRoot, "services", "asnService.js"), "utf8");
  assert.match(svc, /loadActiveAsnsForPo/);
});

run("G. ASN register empty state offers Create ASN", () => {
  assert.match(asnPage, /No ASNs found/);
  assert.match(asnPage, /Create an ASN from an eligible purchase order/);
});

run("H. Incoming Shipments remains ASN receiving entry point", () => {
  assert.match(store, /tab === "Incoming Shipments"/);
  assert.match(asnUi, /incomingShipmentsPath/);
  assert.match(incoming, /receiving\/asn/);
});

run("I. GRN page shows ASN Receiving navigation", () => {
  assert.match(store, /ASN Receiving/);
  assert.match(store, /Go to Incoming Shipments/);
  assert.match(store, /incomingShipmentsPath\(\)/);
});

run("J/K. GRN page retains Direct / Manual GRN from PO", () => {
  assert.match(store, /Direct \/ Manual GRN from Purchase Order/);
  assert.match(store, /Load PO lines/);
  assert.match(store, /searchEligiblePosForGrn/);
  assert.match(store, /\/grn\/from-po\//);
});

run("L. no ASN → GRN bypass without ReceivingSession", () => {
  assert.doesNotMatch(asnPage, /generateDraftGrnFromReceivingSession/);
  assert.doesNotMatch(asnPage, /\/grn\/from-asn/);
  assert.match(incoming, /receivingComplete/);
});

run("M/N. ASN_RECEIVING is GRN → ASN → PO; MANUAL_PO is GRN → PO", () => {
  assert.match(resolver, /resolveAsnReceivingSource/);
  assert.match(post, /resolveAsnReceivingSource/);
  assert.match(store, /GRN → ASN → PO/);
  assert.match(store, /GRN → PO/);
  assert.match(asnUi, /export function isAsnReceivingGrn/);
  assert.match(asnUi, /Direct PO/);
});

run("O. GRN Register distinguishes source", () => {
  assert.match(store, /grnSourceLabel/);
  assert.match(store, />Source</);
});

run("P. STORE_OPERATOR RBAC is not broadened", () => {
  assert.match(rbac, /STORE_OPERATOR_TABS/);
  assert.match(roleService, /STORE_OPERATOR: buildMatrix/);
  const opBlock = roleService.slice(roleService.indexOf("STORE_OPERATOR: buildMatrix"), roleService.indexOf("LOGISTICS: buildMatrix"));
  assert.match(opBlock, /ASN: \["view"\]/);
  assert.doesNotMatch(opBlock, /ASN: \["view", "create"/);
});

run("Create ASN uses existing /asn POST, not a second engine", () => {
  assert.match(asnPage, /apiPost\("\/asn", body\)/);
  assert.doesNotMatch(asnPage, /createAsnFromPoEngine/);
});

run("unknown GRN sourceType is not forced to Direct PO", () => {
  assert.match(asnUi, /if \(!src \|\| src === "MANUAL_PO"\) return "Direct PO"/);
  assert.match(asnUi, /return src\.replace/);
});

run("/asn/new requires ASN.create, not only a hidden button", () => {
  assert.match(asnPage, /creating && !canCreate/);
  assert.match(asnPage, /You need ASN create permission/);
  const routes = fs.readFileSync(path.join(srcRoot, "routes", "asnRoutes.js"), "utf8");
  assert.match(routes, /router\.post\("\/", asnCreate, c\.create\)/);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
