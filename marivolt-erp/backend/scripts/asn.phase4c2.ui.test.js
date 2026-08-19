/**
 * Phase 4C.2 — Store owns ASN receiving operations; ASN register navigates.
 * Run: node scripts/asn.phase4c2.ui.test.js
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { asnListStatusFilter, INCOMING_ASN_STATUSES } from "../src/services/asnService.js";

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

console.log("\nASN Phase 4C.2 Store receiving ownership\n");

const asnPage = fs.readFileSync(path.join(feRoot, "pages", "Asn.jsx"), "utf8");
const incoming = fs.readFileSync(path.join(feRoot, "components", "store", "IncomingShipmentsPanel.jsx"), "utf8");
const planner = fs.readFileSync(path.join(feRoot, "components", "store", "AsnReceivingLabelPlanner.jsx"), "utf8");
const store = fs.readFileSync(path.join(feRoot, "pages", "StoreModule.jsx"), "utf8");
const asnUi = fs.readFileSync(path.join(feRoot, "lib", "asnUi.js"), "utf8");
const purchase = fs.readFileSync(path.join(feRoot, "pages", "Purchase.jsx"), "utf8");
const rbac = fs.readFileSync(path.join(feRoot, "lib", "rbac.js"), "utf8");
const roleService = fs.readFileSync(path.join(srcRoot, "services", "roleService.js"), "utf8");

run("incoming=1 includes SHIPPED and ARRIVED, not DRAFT or CANCELLED", () => {
  const filter = asnListStatusFilter({ incoming: "1" });
  assert.deepEqual(filter.status.$in, INCOMING_ASN_STATUSES);
  assert.ok(filter.status.$in.includes("SHIPPED"));
  assert.ok(filter.status.$in.includes("ARRIVED"));
  assert.equal(filter.status.$in.includes("DRAFT"), false);
  assert.equal(filter.status.$in.includes("CANCELLED"), false);
});

run("explicit SHIPPED / ARRIVED filters stay single-status", () => {
  assert.deepEqual(asnListStatusFilter({ status: "SHIPPED" }), { status: "SHIPPED" });
  assert.deepEqual(asnListStatusFilter({ status: "ARRIVED" }), { status: "ARRIVED" });
});

run("CSV and repeated status params both produce $in", () => {
  assert.deepEqual(asnListStatusFilter({ status: "SHIPPED,ARRIVED" }).status.$in, ["SHIPPED", "ARRIVED"]);
  assert.deepEqual(asnListStatusFilter({ status: ["SHIPPED", "ARRIVED"] }).status.$in, ["SHIPPED", "ARRIVED"]);
});

run("default Incoming list query uses incoming=1 not CSV status", () => {
  assert.match(asnUi, /incomingAsnListQuery/);
  assert.match(asnUi, /params\.incoming = "1"/);
  assert.match(incoming, /incomingAsnListQuery/);
  assert.match(incoming, /value="incoming"/);
  assert.doesNotMatch(incoming, /SHIPPED,ARRIVED/);
});

run("ASN Register Receive Shipment navigates to Store Incoming with asnId", () => {
  assert.match(asnPage, /Receive Shipment/);
  assert.match(asnPage, /incomingShipmentsPath\(row\._id\)/);
  assert.match(asnUi, /\/store\?tab=\$\{tab\}&asnId=/);
  assert.match(incoming, /searchParams\.get\("asnId"\)/);
  assert.match(incoming, /incomingShipmentsPath\(id\)/);
});

run("ASN page does not render operational receiving components", () => {
  assert.doesNotMatch(asnPage, /ReceivingBarcodeScanner/);
  assert.doesNotMatch(asnPage, /ReceivingUnitInspectScreen/);
  assert.doesNotMatch(asnPage, /AsnReceivingLabelPlanner/);
  assert.doesNotMatch(asnPage, /ReceivingDispositionReview/);
  assert.doesNotMatch(asnPage, /Generate Draft GRN/);
  assert.doesNotMatch(asnPage, /Scan Item/);
});

run("Store Incoming Shipments owns receiving, labels, and ASN GRN", () => {
  assert.match(store, /tab === "Incoming Shipments"/);
  assert.match(incoming, /ReceivingBarcodeScanner/);
  assert.match(incoming, /ReceivingUnitInspectScreen/);
  assert.match(incoming, /AsnReceivingLabelPlanner/);
  assert.match(incoming, /ReceivingDispositionReview/);
  assert.match(incoming, /Generate Draft GRN/);
  assert.match(incoming, /Prepare Receiving Units/);
  assert.match(incoming, /Re-Prepare Receiving Units/);
  assert.match(incoming, /Reprint All RU Labels/);
});

run("RU=0 gates scan / start / enter RU", () => {
  assert.match(incoming, /Receiving Units have not been prepared/);
  assert.match(incoming, /canScanNow/);
  assert.match(incoming, /printedCount > 0/);
  assert.match(incoming, /canEnterRu/);
  assert.match(incoming, /ruCount === 0/);
});

run("Purchase View ASN Receive lands on the same Store workspace", () => {
  assert.match(purchase, /incomingShipmentsPath\(asn\._id\)/);
  assert.match(purchase, /Receive Shipment/);
});

run("Receive Shipment requires STORE.view, not a hidden-only gate on ASN.create", () => {
  assert.match(asnPage, /canStoreView/);
  assert.match(asnPage, /can\("STORE", "view"\)/);
});

run("planner print vs reprint reuse existing label APIs", () => {
  assert.match(planner, /receiving-units\/print/);
  assert.match(planner, /\/reprint/);
  assert.match(planner, /Print RU Labels/);
  assert.match(planner, /Reprint All RU Labels/);
  assert.match(planner, /receiving-units\/reprint-all/);
  assert.doesNotMatch(planner, /createLabelEngine/);
});

run("STORE_OPERATOR matrix is not expanded", () => {
  assert.match(rbac, /STORE_OPERATOR_TABS/);
  const opBlock = roleService.slice(
    roleService.indexOf("STORE_OPERATOR: buildMatrix"),
    roleService.indexOf("LOGISTICS: buildMatrix")
  );
  assert.match(opBlock, /ASN: \["view"\]/);
  assert.doesNotMatch(opBlock, /ASN: \["view", "create"/);
});

run("no ASN → GRN bypass on ASN page", () => {
  assert.doesNotMatch(asnPage, /\/grn\/from-asn/);
  assert.doesNotMatch(asnPage, /createGrnFromAsn/);
});

run("company isolation remains on ASN list", () => {
  const svc = fs.readFileSync(path.join(srcRoot, "services", "asnService.js"), "utf8");
  assert.match(svc, /const filter = companyScope\(companyId, extra\)/);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
