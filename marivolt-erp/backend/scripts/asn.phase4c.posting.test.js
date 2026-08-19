/**
 * ASN Phase 4C — ASN receiving GRN posting (reuse existing GRN stock/customs engine).
 * Run: node scripts/asn.phase4c.posting.test.js
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "url";
import { tryClaimReceivedQtyInMemory } from "../src/utils/poReceiptClaim.js";
import {
  ASN_GRN_POST_STEPS,
  asnReservationReleaseQty,
  assertAsnDraftEntitlementStillHolds,
  assertAsnGrnReceivingSourcesMatchEvidence,
  buildCustomsPostBodyFromGrn,
  isPostedGrnStatus,
  setAsnGrnPostFailPoint,
  simulateAsnReceivingPostPipeline,
  simulateAsnReservationRestore,
  simulatePostThenConcurrentAsnClaim,
  stockQtyFromAsnGrnItem,
  summarizeAsnGrnDiscrepancies,
} from "../src/utils/asnReceivingPostRules.js";
import { EXCESS_EVIDENCE_ONLY, GRN_DRAFT_ENTITLEMENT_CHANGED, computeAsnDraftEntitlementReview } from "../src/utils/receivingDraftGrnRules.js";
import {
  assertSystemAsnReceivingStatus,
  assertValidTransition,
  canRestoreAsnReservation,
  remainingAsnQty,
  tryClaimAsnQtyInMemory,
} from "../src/utils/asnRules.js";

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

console.log("\nASN Phase 4C Receiving GRN Posting\n");

run("MANUAL_PO stays GRN → PO; ASN_RECEIVING posts via resolver", () => {
  const post = fs.readFileSync(path.join(srcRoot, "services", "asnReceivingPostService.js"), "utf8");
  const ctrl = fs.readFileSync(path.join(srcRoot, "controllers", "grnController.js"), "utf8");
  assert.match(post, /resolveAsnReceivingSource/);
  assert.match(post, /assertAsnReceivingGrnSnapshots/);
  assert.match(ctrl, /postAsnReceivingDraftGrn/);
  assert.match(ctrl, /export async function postGrnFromPo/);
  assert.doesNotMatch(post, /PurchaseOrder\.findOne\(\{[^}]*grn\.poId/);
});

run("post-time source integrity uses ASN line not Article", () => {
  const post = fs.readFileSync(path.join(srcRoot, "services", "asnReceivingPostService.js"), "utf8");
  const rules = fs.readFileSync(path.join(srcRoot, "utils", "asnReceivingPostRules.js"), "utf8");
  assert.match(post, /item\.asnLineId/);
  assert.match(rules, /ASN_GRN_SOURCE_MISMATCH/);
  assert.match(rules, /assertArticleMatchesAsnLine/);
  assert.doesNotMatch(rules, /findPoLineByArticle/);
});

run("stock posts grnAcceptedQty not damaged/rejected/excess", () => {
  const item = {
    acceptedQty: 50,
    receivingSources: [
      { grnAcceptedQty: 43, excessPendingQty: 2, acceptedQty: 45 },
    ],
  };
  assert.equal(stockQtyFromAsnGrnItem(item), 43);
});

run("example PO 50 ASN 50 actual 48 accepted 43 damaged 3 rejected 2 short 2", () => {
  const grn = {
    items: [
      {
        acceptedQty: 43,
        receivingSources: [{ receivingUnitId: "u1", grnAcceptedQty: 43, excessPendingQty: 0, acceptedQty: 43 }],
      },
    ],
  };
  const rows = [{ receivingUnitId: "u1", damagedQty: 3, rejectedQty: 2, shortQty: 2 }];
  const d = summarizeAsnGrnDiscrepancies(grn, rows);
  assert.equal(d.acceptedToStock, 43);
  assert.equal(d.damagedQty, 3);
  assert.equal(d.rejectedQty, 2);
  assert.equal(d.shortQty, 2);
  assert.equal(asnReservationReleaseQty({ asnQty: 50 }), 50);
});

run("stale entitlement refuses post without shrinking draft", () => {
  const poLine = { _id: "pl1", orderedQty: 50, cancelledQty: 0 };
  const maps = {
    poLineByAsnLineId: new Map([["al1", poLine]]),
    poLineIdByAsnLineId: new Map([["al1", "pl1"]]),
    postedByPoLine: new Map([["pl1", 10]]),
    otherDraftByPoLine: new Map(),
  };
  const grn = { items: [{ asnLineId: "al1", acceptedQty: 50 }] };
  assert.throws(
    () => assertAsnDraftEntitlementStillHolds(grn, maps),
    (err) => err.code === GRN_DRAFT_ENTITLEMENT_CHANGED && err.entitlementReview.entitlementShortfall === 10
  );
  assert.equal(grn.items[0].acceptedQty, 50);
});

run("no silent grow: extra entitlement does not change stored qty", () => {
  const poLine = { _id: "pl1", orderedQty: 52, cancelledQty: 0 };
  const maps = {
    poLineByAsnLineId: new Map([["al1", poLine]]),
    poLineIdByAsnLineId: new Map([["al1", "pl1"]]),
    postedByPoLine: new Map(),
    otherDraftByPoLine: new Map(),
  };
  const grn = { items: [{ asnLineId: "al1", acceptedQty: 50 }] };
  const review = computeAsnDraftEntitlementReview(grn, maps);
  assert.equal(review.entitlementValid, true);
  assert.equal(review.additionalEntitlementAvailable, 2);
  assert.equal(grn.items[0].acceptedQty, 50);
});

run("concurrent remaining 30: only one 30-claim succeeds", () => {
  const line = { orderedQty: 100, cancelledQty: 0, receivedQty: 70 };
  const a = tryClaimReceivedQtyInMemory(line, 30);
  const b = tryClaimReceivedQtyInMemory(a.line, 30);
  assert.equal(a.ok, true);
  assert.equal(a.line.receivedQty, 100);
  assert.equal(b.ok, false);
});

run("same GRN retry is treated as posted (idempotent status)", () => {
  assert.equal(isPostedGrnStatus("RECEIVED"), true);
  assert.equal(isPostedGrnStatus("DRAFT"), false);
  assert.equal(isPostedGrnStatus("CANCELLED"), false);
  const svc = fs.readFileSync(path.join(srcRoot, "services", "asnReceivingPostService.js"), "utf8");
  assert.match(svc, /idempotent: true/);
});

run("failure injection rolls simulated pipeline back to DRAFT", () => {
  for (const failAt of ASN_GRN_POST_STEPS) {
    const out = simulateAsnReceivingPostPipeline(
      { poReceivedQty: 0, asnActiveQty: 50, acceptedToStock: 43, asnReleaseQty: 50, customs: true },
      { failAt }
    );
    assert.equal(out.rolledBack, true);
    assert.equal(out.grnStatus, "DRAFT");
    assert.equal(out.stockQty, 0);
    assert.equal(out.poReceivedQty, 0);
    assert.equal(out.asnActiveQty, 50);
    assert.equal(out.asnStatus, "ARRIVED");
    assert.equal(out.customsLots, 0);
  }
  const ok = simulateAsnReceivingPostPipeline(
    { poReceivedQty: 0, asnActiveQty: 50, acceptedToStock: 43, asnReleaseQty: 50, customs: true },
    { failAt: "" }
  );
  assert.equal(ok.grnStatus, "RECEIVED");
  assert.equal(ok.stockQty, 43);
  assert.equal(ok.poReceivedQty, 43);
  assert.equal(ok.asnActiveQty, 0);
  assert.equal(ok.asnStatus, "COMPLETED");
  assert.equal(ok.customsLots, 1);
  setAsnGrnPostFailPoint("");
});

run("post vs concurrent ASN-2 of 50 cannot leave received 43 + asnActive 50", () => {
  const sim = simulatePostThenConcurrentAsnClaim({
    orderedQty: 50,
    asn1Qty: 50,
    acceptedQty: 43,
    concurrentAsnQty: 50,
  });
  assert.equal(sim.midWouldAllowConcurrent, false);
  assert.equal(sim.afterWouldAllowConcurrent, false);
  assert.equal(sim.remainingAfterPost, 7);
  assert.equal(sim.committed.receivedQty, 43);
  assert.equal(sim.committed.asnActiveQty, 0);
});

run("successful reverse with no replacement ASN restores 50", () => {
  assert.equal(
    canRestoreAsnReservation({
      orderedQty: 50,
      receivedQty: 43,
      asnActiveQty: 0,
      restoreQty: 50,
      receivedReversalQty: 43,
    }),
    true
  );
  const out = simulateAsnReservationRestore({
    orderedQty: 50,
    receivedQty: 43,
    asnActiveQty: 0,
    restoreQty: 50,
    receivedReversalQty: 43,
  });
  assert.equal(out.rolledBack, false);
  assert.equal(out.poReceivedQty, 0);
  assert.equal(out.asnActiveQty, 50);
  assert.equal(out.asnStatus, "ARRIVED");
  assert.equal(out.stockQty, 0);
  assert.equal(out.grnStatus, "CANCELLED");
});

run("replacement ASN 7 blocks reverse of original 50 (all-or-nothing)", () => {
  assert.equal(
    canRestoreAsnReservation({
      orderedQty: 50,
      receivedQty: 43,
      asnActiveQty: 7,
      restoreQty: 50,
      receivedReversalQty: 43,
    }),
    false
  );
  const out = simulateAsnReservationRestore({
    orderedQty: 50,
    receivedQty: 43,
    asnActiveQty: 7,
    restoreQty: 50,
    receivedReversalQty: 43,
  });
  assert.equal(out.rolledBack, true);
  assert.equal(out.code, "ASN_RESERVATION_RESTORE_CONFLICT");
  assert.equal(out.grnStatus, "RECEIVED");
  assert.equal(out.stockQty, 43);
  assert.equal(out.poReceivedQty, 43);
  assert.equal(out.asnActiveQty, 7);
  assert.equal(out.asnStatus, "COMPLETED");
  assert.equal(out.customsLots, 1);
});

run("after cancelling replacement ASN, reverse restores original 50", () => {
  assert.equal(
    canRestoreAsnReservation({
      orderedQty: 50,
      receivedQty: 43,
      asnActiveQty: 0,
      restoreQty: 50,
      receivedReversalQty: 43,
    }),
    true
  );
});

run("same Article 20834: 50 → accepted 43 → replacement 7", () => {
  assert.equal(remainingAsnQty(50, 0, 43), 7);
  const line = { orderedQty: 50, receivedQty: 43, asnActiveQty: 0, article: "20834" };
  const claim = tryClaimAsnQtyInMemory(line, 7);
  assert.equal(claim.ok, true);
  assert.equal(claim.line.asnActiveQty, 7);
  assert.equal(tryClaimAsnQtyInMemory(claim.line, 1).ok, false);
});

run("posted accepted qty reconciles with PO receivedQty", () => {
  const line = { orderedQty: 50, receivedQty: 0 };
  const a = tryClaimReceivedQtyInMemory(line, 43);
  assert.equal(a.ok, true);
  assert.equal(a.line.receivedQty, 43);
  const postedGrnAccepted = 43;
  assert.equal(a.line.receivedQty, postedGrnAccepted);
});

run("ASN POST body cannot override persisted Draft customs fields", () => {
  const persisted = buildCustomsPostBodyFromGrn({
    customsDocRef: "BOE-REVIEWED",
    items: [
      {
        poLineId: "pl1",
        article: "20834",
        customsCapture: {
          boeNumber: "BOE-REVIEWED",
          hsCode: "8481",
          customsCurrency: "USD",
          customsUnitPrice: 10,
          countryOfOrigin: "DE",
          declaredQty: 43,
        },
      },
    ],
  });
  assert.equal(persisted.boeNumber, "BOE-REVIEWED");
  assert.equal(persisted.lineOverrides[0].hsCode, "8481");
  assert.equal(persisted.lineOverrides[0].customsUnitPrice, 10);
  const builder = fs.readFileSync(path.join(srcRoot, "utils", "asnReceivingPostRules.js"), "utf8");
  assert.match(builder, /export function buildCustomsPostBodyFromGrn\(grn\)/);
  assert.doesNotMatch(builder, /if \(extraBody && hasCustomsFields/);
});

run("failure inject restore conflict leaves posted state", () => {
  const out = simulateAsnReservationRestore({
    orderedQty: 50,
    receivedQty: 43,
    asnActiveQty: 7,
    restoreQty: 50,
    receivedReversalQty: 43,
    failAt: "restore",
  });
  assert.equal(out.rolledBack, true);
  assert.equal(out.grnStatus, "RECEIVED");
  assert.equal(out.poReceivedQty, 43);
  assert.equal(out.asnActiveQty, 7);
});

run("failure inject post/claim leaves GRN DRAFT and ASN ARRIVED", () => {
  const out = simulateAsnReceivingPostPipeline(
    { poReceivedQty: 0, asnActiveQty: 50, acceptedToStock: 43, asnReleaseQty: 50, customs: true },
    { failAt: "claim_po" }
  );
  assert.equal(out.rolledBack, true);
  assert.equal(out.grnStatus, "DRAFT");
  assert.equal(out.asnStatus, "ARRIVED");
  assert.equal(out.poReceivedQty, 0);
  assert.equal(out.asnActiveQty, 50);
});

run("production post wraps steps in withTransaction", () => {
  const svc = fs.readFileSync(path.join(srcRoot, "services", "asnReceivingPostService.js"), "utf8");
  assert.match(svc, /withTransaction/);
  assert.match(svc, /maybeFailAsnGrnPost\("claim_po"\)/);
  assert.match(svc, /maybeFailAsnGrnPost\("stock"\)/);
  assert.match(svc, /maybeFailAsnGrnPost\("customs"\)/);
  assert.match(svc, /maybeFailAsnGrnPost\("grn_status"\)/);
  assert.match(svc, /maybeFailAsnGrnPost\("asn_release"\)/);
  assert.match(svc, /maybeFailAsnGrnPost\("asn_completed"\)/);
  assert.match(svc, /createCustomsLotFromGrn/);
  assert.match(svc, /grnReceive|receiveGrnItemIntoStock/);
  assert.doesNotMatch(svc, /quarantine/i);
});

run("ASN COMPLETED is system-only; users still cannot PATCH it", () => {
  assert.throws(() => assertValidTransition("ARRIVED", "COMPLETED"), (err) => err.code === "ASN_SYSTEM_STATUS");
  assert.equal(assertSystemAsnReceivingStatus("ARRIVED", "COMPLETED"), true);
  assert.equal(assertSystemAsnReceivingStatus("COMPLETED", "ARRIVED"), true);
});

run("asnActiveQty release uses ASN line qty not accepted", () => {
  assert.equal(asnReservationReleaseQty({ asnQty: 50 }), 50);
  assert.notEqual(asnReservationReleaseQty({ asnQty: 50 }), 43);
});

run("excess is not posted", () => {
  const item = {
    receivingSources: [
      { ruNo: "RU-1", acceptedQty: 22, grnAcceptedQty: 20, excessPendingQty: 2 },
      { ruNo: "RU-2", acceptedQty: 30, grnAcceptedQty: 30, excessPendingQty: 0 },
    ],
  };
  assert.equal(stockQtyFromAsnGrnItem(item), 50);
});

run("same Article different ASN lines stay isolated at post", () => {
  const rules = fs.readFileSync(path.join(srcRoot, "utils", "asnReceivingPostRules.js"), "utf8");
  assert.match(rules, /does not belong to this ASN line/);
  const a = { asnLineId: "A", article: "20834", acceptedQty: 36, receivingSources: [{ receivingUnitId: "1", ruNo: "RU-A", acceptedQty: 36, grnAcceptedQty: 36, excessPendingQty: 0 }] };
  const rows = [
    { receivingUnitId: "1", receivingSessionUnitId: "s1", ruNo: "RU-A", asnLineId: "A", acceptedQty: 36 },
    { receivingUnitId: "2", receivingSessionUnitId: "s2", ruNo: "RU-B", asnLineId: "B", acceptedQty: 43 },
  ];
  assert.doesNotThrow(() => assertAsnGrnReceivingSourcesMatchEvidence({ items: [a] }, rows));
});

run("customs body is built from stored GRN capture (parity with createCustomsLotFromGrn)", () => {
  const body = buildCustomsPostBodyFromGrn({
    customsDocRef: "BOE-1",
    items: [
      {
        poLineId: "pl1",
        article: "20834",
        customsCapture: { boeNumber: "BOE-1", hsCode: "8481", customsCurrency: "USD", unitWeightKg: 0.2 },
      },
    ],
  });
  assert.equal(body.boeNumber, "BOE-1");
  assert.equal(body.lineOverrides[0].hsCode, "8481");
});

run("shared PO claim + stock engine; no second ASN stock engine", () => {
  const post = fs.readFileSync(path.join(srcRoot, "services", "asnReceivingPostService.js"), "utf8");
  const effects = fs.readFileSync(path.join(srcRoot, "services", "grnPostingEffects.js"), "utf8");
  assert.match(effects, /claimPoLineReceivedQty/);
  assert.match(effects, /grnReceive/);
  assert.match(post, /applyReceiveToPo/);
  assert.doesNotMatch(post, /class AsnStockEngine/);
});

run("delete draft uses status DRAFT filter; posted path uses STORE.post", () => {
  const ctrl = fs.readFileSync(path.join(srcRoot, "controllers", "grnController.js"), "utf8");
  const routes = fs.readFileSync(path.join(srcRoot, "routes", "grnRoutes.js"), "utf8");
  assert.match(ctrl, /findOneAndDelete/);
  assert.match(ctrl, /status: "DRAFT"/);
  assert.match(routes, /storePost, c.postGrn/);
  assert.match(routes, /storeCancel, c.cancelGrn/);
});

run("reversal restores ASN reservation and status via shared cancel path", () => {
  const ctrl = fs.readFileSync(path.join(srcRoot, "controllers", "grnController.js"), "utf8");
  const post = fs.readFileSync(path.join(srcRoot, "services", "asnReceivingPostService.js"), "utf8");
  assert.match(ctrl, /reverseAsnReceivingPostedGrn/);
  assert.match(ctrl, /reverseReceiveOnPo/);
  assert.match(post, /ASN_RECEIVING_GRN_REVERSED/);
  assert.match(post, /restorePoLineAsnQty/);
  const cancelFn = ctrl.slice(ctrl.indexOf("export async function cancelGrn"));
  const restoreIdx = cancelFn.indexOf("reverseAsnReceivingPostedGrn");
  const stockIdx = cancelFn.indexOf("stockService.cancelGrn");
  assert.ok(restoreIdx > 0 && stockIdx > restoreIdx, "ASN restore must run before stock reverse");
});

run("freeze remains after posted/cancelled ASN GRN; regenerate allowed after reverse", () => {
  const draft = fs.readFileSync(path.join(srcRoot, "services", "asnReceivingDraftService.js"), "utf8");
  assert.match(draft, /findPostedOrCancelledAsnReceivingGrn/);
  assert.match(draft, /RECEIVING_GRN_POSTED_LOCKED/);
  assert.match(draft, /findDraftAsnReceivingGrn/);
  assert.match(draft, /nextGrnNo/);
  assert.match(draft, /A CANCELLED posted GRN does not/);
});

run("ASN_RECEIVING posting ignores STORE_ALLOW_GRN_OVER_PO and POST body customs", () => {
  const post = fs.readFileSync(path.join(srcRoot, "services", "asnReceivingPostService.js"), "utf8");
  assert.match(post, /never reads STORE_ALLOW_GRN_OVER_PO/);
  assert.match(post, /allowOverPo: false/);
  assert.match(post, /buildCustomsPostBodyFromGrn\(grn\)/);
  assert.doesNotMatch(post, /body: req\.body/);
  assert.doesNotMatch(post, /Setting\.findOne/);
});

run("excess after cap is evidence-only; ASN may COMPLETE", () => {
  const rules = fs.readFileSync(path.join(srcRoot, "utils", "receivingDraftGrnRules.js"), "utf8");
  assert.match(rules, /EXCESS_EVIDENCE_ONLY/);
  assert.match(rules, /Option A/);
  assert.equal(EXCESS_EVIDENCE_ONLY, "EXCESS_EVIDENCE_ONLY");
});

run("tablet UI POST GRN confirmation and no auto reprint", () => {
  const incoming = fs.readFileSync(path.join(feRoot, "components", "store", "IncomingShipmentsPanel.jsx"), "utf8");
  assert.match(incoming, /POST GRN/);
  assert.match(incoming, /Confirm POST GRN/);
  assert.match(incoming, /GRN Posted Successfully/);
  assert.match(incoming, /will not be reprinted/);
  assert.match(incoming, /Back to Incoming Shipments/);
  assert.doesNotMatch(incoming, /from-grn/);
});

run("no production index mutation in Phase 4C services", () => {
  const post = fs.readFileSync(path.join(srcRoot, "services", "asnReceivingPostService.js"), "utf8");
  assert.doesNotMatch(post, /createIndex|dropIndex/);
});

run("StockLedger provenance fields are nullable ASN refs", () => {
  const model = fs.readFileSync(path.join(srcRoot, "models", "StockLedger.js"), "utf8");
  assert.match(model, /asnId/);
  assert.match(model, /asnLineId/);
  assert.match(model, /receivingSessionId/);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
