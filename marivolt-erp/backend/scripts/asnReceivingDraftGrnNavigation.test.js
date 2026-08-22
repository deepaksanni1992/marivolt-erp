/**
 * Regression: Review Draft GRN must open the exact existing draft modal, not generic register only.
 * Run: node scripts/asnReceivingDraftGrnNavigation.test.js
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const feRoot = path.join(__dirname, "../../src");

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
    console.error(e);
  }
}

console.log("asnReceivingDraftGrnNavigation.test.js");

const incoming = fs.readFileSync(path.join(feRoot, "components", "store", "IncomingShipmentsPanel.jsx"), "utf8");
const store = fs.readFileSync(path.join(feRoot, "pages", "StoreModule.jsx"), "utf8");
const asnUi = fs.readFileSync(path.join(feRoot, "lib", "asnUi.js"), "utf8");

run("1. storeGrnOpenPath encodes tab + grnNo + optional returnAsnId", () => {
  assert.match(asnUi, /export function storeGrnOpenPath/);
  assert.match(asnUi, /params\.set\("grnNo", no\)/);
  assert.match(asnUi, /returnAsnId/);
});

run("2. Review click requests specific GRN via canonical openExistingDraftGrn", () => {
  assert.match(incoming, /function openExistingDraftGrn\(\)/);
  assert.match(incoming, /onOpenDraftGrn\(grnNo/);
  assert.match(incoming, /storeGrnOpenPath\(grnNo/);
  assert.match(incoming, /Complete \/ Review Draft GRN/);
  assert.doesNotMatch(incoming, /function reviewDraftGrn/);
});

run("3. Open existing Draft GRN uses open path, not generate POST", () => {
  const openBlock = incoming.slice(incoming.indexOf("Open existing Draft GRN") - 400, incoming.indexOf("Open existing Draft GRN") + 80);
  assert.match(openBlock, /onClick=\{openExistingDraftGrn\}/);
  assert.doesNotMatch(openBlock, /onClick=\{generateDraftGrn\}/);
});

run("4. StoreModule fetches exact GRN and sets register detail modal", () => {
  assert.match(store, /const openExistingDraftGrn = useCallback/);
  assert.match(store, /apiGet\(`\/grn\/\$\{encodeURIComponent\(grnNo\)\}`\)/);
  assert.match(store, /setGrnRegisterDetail\(row\)/);
  assert.match(store, /open=\{Boolean\(grnRegisterDetail\)\}/);
  assert.match(store, /onOpenDraftGrn=\{openExistingDraftGrn\}/);
});

run("5. URL deep-link effect does not depend on paginated register list", () => {
  assert.match(store, /grnNoFromUrl/);
  assert.doesNotMatch(store, /grns\?\.items[\s\S]{0,120}setGrnRegisterDetail\(found\)/);
});

run("6. POST remains gated on postReadiness.postReady", () => {
  assert.match(store, /postReadiness\?\.postReady !== true/);
  assert.match(store, /postReadiness\?\.postReady === true/);
});

run("7. Draft review uses AsnReceivingDraftCustomsReview in modal", () => {
  assert.match(store, /AsnReceivingDraftCustomsReview/);
  assert.match(store, /onSaved=\{\(row\) => setGrnRegisterDetail\(row\)\}/);
});

run("8. Closing modal can return to Incoming Shipments via returnAsnId", () => {
  assert.match(store, /closeGrnRegisterDetail/);
  assert.match(store, /returnAsnId/);
  assert.match(store, /incomingShipmentsPath\(asnId\)/);
});

run("9. generateDraftGrn remains for first-time generation only", () => {
  assert.match(incoming, /async function generateDraftGrn/);
  assert.match(incoming, /\/receiving\/sessions\/\$\{session\._id\}\/grn/);
  assert.match(incoming, /Generate Draft GRN/);
  const genIdx = incoming.indexOf("Generate Draft GRN");
  const genBlock = incoming.slice(genIdx - 200, genIdx + 120);
  assert.match(genBlock, /generateDraftGrn/);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
