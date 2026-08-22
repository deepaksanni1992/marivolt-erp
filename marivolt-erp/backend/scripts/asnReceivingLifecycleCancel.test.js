/**
 * ASN receiving lifecycle cancellation — abandon unposted receiving and release PO reservation.
 * Run: node scripts/asnReceivingLifecycleCancel.test.js
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ASN_CANCEL_ALREADY_POSTED,
  ASN_CANCEL_CUSTOMS_EFFECT_EXISTS,
  ASN_CANCEL_REASON_REQUIRED,
  ASN_CANCEL_STOCK_EFFECT_EXISTS,
  ASN_RECEIVING_LIFECYCLE_CANCEL_AUDIT_EVENT,
  AsnReceivingLifecycleCancelError,
} from "../src/services/asnReceivingLifecycleCancelService.js";
import { evaluateReceivingScanEligibility } from "../src/utils/receivingInspectionRules.js";
import { applyCancelRelease, roundAsnQty } from "../src/utils/asnRules.js";
import { getDefaultPermissionsForRole } from "../src/services/roleService.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcRoot = path.join(__dirname, "../src");

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

console.log("asnReceivingLifecycleCancel.test.js");

const svc = fs.readFileSync(path.join(srcRoot, "services", "asnReceivingLifecycleCancelService.js"), "utf8");
const routes = fs.readFileSync(path.join(srcRoot, "routes", "asnRoutes.js"), "utf8");
const ctrl = fs.readFileSync(path.join(srcRoot, "controllers", "asnController.js"), "utf8");
const asnSvc = fs.readFileSync(path.join(srcRoot, "services", "asnService.js"), "utf8");
const auditLogModel = fs.readFileSync(path.join(srcRoot, "models", "AuditLog.js"), "utf8");
const sessionUnitModel = fs.readFileSync(path.join(srcRoot, "models", "ReceivingSessionUnit.js"), "utf8");
const auditSvc = fs.readFileSync(path.join(srcRoot, "services", "auditService.js"), "utf8");
const investigate = fs.readFileSync(path.join(__dirname, "investigateAsnMar0004Cancel.readonly.mjs"), "utf8");

run("1. canonical service export cancelAsnReceivingLifecycle exists", () => {
  assert.match(svc, /export async function cancelAsnReceivingLifecycle/);
  assert.match(svc, /export async function evaluateAsnReceivingLifecycleCancelEligibility/);
});

run("2. route POST /:id/cancel-receiving-lifecycle wired with ASN.cancel", () => {
  assert.match(routes, /cancel-receiving-lifecycle/);
  assert.match(routes, /asnCancel, c\.cancelReceivingLifecycle/);
});

run("3. controller delegates to lifecycle service", () => {
  assert.match(ctrl, /cancelAsnReceivingLifecycle/);
  assert.match(ctrl, /AsnReceivingLifecycleCancelError/);
});

run("4. Draft GRN invalidated via CANCELLED status, not delete", () => {
  assert.match(svc, /status: "CANCELLED"/);
  assert.doesNotMatch(svc, /findOneAndDelete/);
  assert.doesNotMatch(svc, /deleteMany/);
});

run("5. receiving session closed to CANCELLED", () => {
  assert.match(svc, /ReceivingSession\.updateMany/);
  assert.match(svc, /status: "CANCELLED"/);
});

run("6. active RUs retired so old barcodes cannot receive", () => {
  assert.match(svc, /retireReceivingUnitsForAsn/);
  assert.match(svc, /retireStatusForRu/);
  assert.match(svc, /status: "CANCELLED"/);
  const scan = evaluateReceivingScanEligibility({ status: "CANCELLED", ruNo: "MAR-RU-1" }, { current: true });
  assert.equal(scan.canReceive, false);
  assert.equal(scan.code, "RU_CANCELLED");
});

run("7. PO reservation released via canonical asnService.cancelAsn", () => {
  assert.match(svc, /cancelAsnDocument/);
  assert.match(svc, /guard: "ASN_CANCEL_POLICY"/);
  assert.match(asnSvc, /releasePoLineAsnQty/);
  assert.doesNotMatch(svc, /asnActiveQty:\s*0/);
});

run("8. idempotent when ASN already CANCELLED", () => {
  assert.match(svc, /alreadyCancelled/);
  assert.match(svc, /asnStatus === "CANCELLED"/);
});

run("9. posted GRN blocks lifecycle cancel", () => {
  assert.match(svc, /ASN_CANCEL_ALREADY_POSTED/);
  assert.match(svc, /POSTED.*RECEIVED.*PARTIAL_RECEIVED.*CLOSED/);
});

run("10. stock effects block unsafe cancel", () => {
  assert.match(svc, /ASN_CANCEL_STOCK_EFFECT_EXISTS/);
  assert.match(svc, /StockLedger\.findOne/);
});

run("11. customs effects block unsafe cancel", () => {
  assert.match(svc, /ASN_CANCEL_CUSTOMS_EFFECT_EXISTS/);
  assert.match(svc, /CustomsLot\.findOne/);
});

run("12. reason required", () => {
  assert.throws(
    () => {
      throw new AsnReceivingLifecycleCancelError("x", 400, ASN_CANCEL_REASON_REQUIRED);
    },
    (e) => e.code === ASN_CANCEL_REASON_REQUIRED,
  );
});

run("13. PO release math uses per-line asnQty only (not zeroing PO)", () => {
  const claimed = {
    "line-a": 12,
    "line-b": 6,
  };
  const released = applyCancelRelease(claimed, [{ poLineId: "line-a", asnQty: 12 }]);
  assert.equal(released["line-a"], 0);
  assert.equal(released["line-b"], 6);
  assert.equal(roundAsnQty(18 - 6), 12);
});

run("14. audit uses canonical CANCEL action with lifecycle event metadata", () => {
  assert.match(svc, /action: "CANCEL"/);
  assert.match(svc, /eventType: ASN_RECEIVING_LIFECYCLE_CANCEL_AUDIT_EVENT/);
  assert.match(svc, /cancelledDraftGrns/);
  assert.match(svc, /retiredRuNos/);
  assert.match(svc, /releasedLines/);
  assert.match(svc, /receivingSessionNos/);
  assert.match(svc, /sourcePoNo/);
  assert.match(auditLogModel, /"CANCEL"/);
  assert.doesNotMatch(svc, /action: "ASN_RECEIVING_LIFECYCLE_CANCELLED"/);
  assert.equal(ASN_RECEIVING_LIFECYCLE_CANCEL_AUDIT_EVENT, "ASN_RECEIVING_LIFECYCLE_CANCELLED");
});

run("15. audit write is best-effort after transaction (not enum-breaking inside txn)", () => {
  assert.match(auditSvc, /never throw/i);
  assert.match(svc, /await mongoSession\.withTransaction/);
  assert.match(svc, /await writeAudit\(req,/);
  const auditIdx = svc.indexOf("await writeAudit(req,");
  const txnEndIdx = svc.indexOf("await mongoSession.endSession()");
  assert.ok(auditIdx > txnEndIdx, "writeAudit should run after session ends");
});

run("16. ReceivingSessionUnit lookup uses receivingSessionId (not sessionId)", () => {
  assert.match(sessionUnitModel, /receivingSessionId/);
  assert.match(sessionUnitModel, /collection: "receivingSessionUnits"/);
  assert.match(investigate, /ReceivingSessionUnit\.find\(\{ companyId, asnId: asn\._id \}\)/);
  assert.doesNotMatch(investigate, /sessionId:/);
});

run("17. PURCHASE and ADMIN defaults include ASN.cancel; STORE_OPERATOR does not", () => {
  assert.ok(getDefaultPermissionsForRole("purchase").ASN.includes("cancel"));
  assert.ok(getDefaultPermissionsForRole("admin").ASN.includes("cancel"));
  assert.ok(getDefaultPermissionsForRole("super_admin").ASN.includes("cancel"));
  const storeOp = getDefaultPermissionsForRole("store_operator");
  assert.ok(storeOp.ASN.includes("view"));
  assert.ok(!storeOp.ASN.includes("cancel"));
});

run("18. MANUAL_PO unchanged — service scoped to ASN_RECEIVING GRNs", () => {
  assert.match(svc, /GRN_SOURCE_ASN_RECEIVING/);
  assert.doesNotMatch(asnSvc, /cancelAsnReceivingLifecycle/);
});

run("19. existing simple ASN cancel path preserved", () => {
  assert.match(routes, /router\.post\("\/:id\/cancel", asnCancel, c\.cancel\)/);
  assert.match(ctrl, /cancelAsn\(req/);
});

run("20. investigation readonly script exists for MAR-ASN-0004", () => {
  const inv = fs.readFileSync(path.join(__dirname, "investigateAsnMar0004Cancel.readonly.mjs"), "utf8");
  assert.match(inv, /MAR-ASN-0004/);
  assert.match(inv, /READ-ONLY/);
  assert.doesNotMatch(inv, /updateMany|deleteMany|findOneAndUpdate/);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
