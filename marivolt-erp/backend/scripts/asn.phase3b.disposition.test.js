/**
 * ASN Phase 3B — receiving disposition & discrepancy.
 * Run: node scripts/asn.phase3b.disposition.test.js
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ReceivingInspectionError,
  aggregateAsnLineDisposition,
  applyAllGoodDisposition,
  applyNotReceivedDisposition,
  applyReceivingDraftSave,
  applyReceivingSessionComplete,
  applyReceivingUnitComplete,
  assertConditionDispositionConsistent,
  assertDispositionTotalsActual,
  assertOptimisticVersion,
  assertPhase4CanConsumeReceivingUnits,
  assertUnitCompletable,
  computeDispositionDerived,
  computeDispositionReadiness,
  excessQty,
  hasValidDisposition,
  isDispositionRequired,
  resolveDispositionForComplete,
  shortQty,
  suggestConditionFromDisposition,
  uniqueSessionUnitKey,
  varianceQty,
} from "../src/utils/receivingInspectionRules.js";

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

console.log("\nASN Phase 3B Receiving Disposition\n");

run("valid all-accepted disposition", () => {
  assertDispositionTotalsActual({ actualQty: 25, acceptedQty: 25, damagedQty: 0, rejectedQty: 0 });
  assert.deepEqual(applyAllGoodDisposition(25), {
    acceptedQty: 25,
    damagedQty: 0,
    rejectedQty: 0,
    condition: "GOOD",
  });
});

run("valid mixed 45/3/2 of actual 50", () => {
  assertDispositionTotalsActual({ actualQty: 50, acceptedQty: 45, damagedQty: 3, rejectedQty: 2 });
  assert.equal(suggestConditionFromDisposition({ actualQty: 50, acceptedQty: 45, damagedQty: 3, rejectedQty: 2 }), "MIXED");
});

run("reject disposition over actual 45+5+5=55", () => {
  assert.throws(
    () => assertDispositionTotalsActual({ actualQty: 50, acceptedQty: 45, damagedQty: 5, rejectedQty: 5 }),
    (err) => err.code === "RECEIVING_DISPOSITION_MISMATCH"
  );
});

run("reject disposition under actual 40+5+0=45", () => {
  assert.throws(
    () => assertDispositionTotalsActual({ actualQty: 50, acceptedQty: 40, damagedQty: 5, rejectedQty: 0 }),
    (err) => err.code === "RECEIVING_DISPOSITION_MISMATCH"
  );
});

run("condition GOOD/DAMAGED/REJECTED/MIXED consistency", () => {
  assertConditionDispositionConsistent({
    condition: "GOOD",
    actualQty: 25,
    acceptedQty: 25,
    damagedQty: 0,
    rejectedQty: 0,
  });
  assertConditionDispositionConsistent({
    condition: "DAMAGED",
    actualQty: 1,
    acceptedQty: 0,
    damagedQty: 1,
    rejectedQty: 0,
  });
  assertConditionDispositionConsistent({
    condition: "REJECTED",
    actualQty: 1,
    acceptedQty: 0,
    damagedQty: 0,
    rejectedQty: 1,
  });
  assertConditionDispositionConsistent({
    condition: "MIXED",
    actualQty: 50,
    acceptedQty: 45,
    damagedQty: 5,
    rejectedQty: 0,
  });
  assert.throws(
    () =>
      assertConditionDispositionConsistent({
        condition: "GOOD",
        actualQty: 50,
        acceptedQty: 45,
        damagedQty: 5,
        rejectedQty: 0,
      }),
    (err) => err.code === "RECEIVING_DISPOSITION_CONDITION"
  );
  assert.throws(
    () =>
      assertConditionDispositionConsistent({
        condition: "MIXED",
        actualQty: 50,
        acceptedQty: 50,
        damagedQty: 0,
        rejectedQty: 0,
      }),
    (err) => err.code === "RECEIVING_DISPOSITION_CONDITION"
  );
});

run("short 2 / excess 0 / variance -2", () => {
  const d = computeDispositionDerived({
    plannedQty: 25,
    actualQty: 23,
    acceptedQty: 23,
    damagedQty: 0,
    rejectedQty: 0,
  });
  assert.equal(d.variance, -2);
  assert.equal(d.shortQty, 2);
  assert.equal(d.excessQty, 0);
  assert.equal(shortQty(25, 23), 2);
  assert.equal(varianceQty(25, 23), -2);
});

run("excess 2 / short 0 / variance +2", () => {
  const d = computeDispositionDerived({
    plannedQty: 25,
    actualQty: 27,
    acceptedQty: 27,
    damagedQty: 0,
    rejectedQty: 0,
  });
  assert.equal(d.variance, 2);
  assert.equal(d.shortQty, 0);
  assert.equal(d.excessQty, 2);
  assert.equal(excessQty(25, 27), 2);
});

run("zero actual is NOT_RECEIVED with all-zero buckets + short planned", () => {
  const d = computeDispositionDerived({
    plannedQty: 25,
    actualQty: 0,
    acceptedQty: 0,
    damagedQty: 0,
    rejectedQty: 0,
  });
  assert.equal(d.shortQty, 25);
  assert.equal(d.excessQty, 0);
  assert.equal(d.variance, -25);
  assert.equal(d.acceptedQty, 0);
  assert.equal(suggestConditionFromDisposition({ actualQty: 0, acceptedQty: 0, damagedQty: 0, rejectedQty: 0 }), "NOT_RECEIVED");
  assert.deepEqual(applyNotReceivedDisposition(), {
    acceptedQty: 0,
    damagedQty: 0,
    rejectedQty: 0,
    condition: "NOT_RECEIVED",
  });
  assert.doesNotThrow(() =>
    assertUnitCompletable({
      actualQty: 0,
      condition: "NOT_RECEIVED",
      remarks: "Packet missing from shipment",
      photoCount: 1,
      qtyConfirmed: true,
      plannedQty: 25,
      acceptedQty: 0,
      damagedQty: 0,
      rejectedQty: 0,
    })
  );
  assert.throws(
    () =>
      assertUnitCompletable({
        actualQty: 0,
        condition: "GOOD",
        remarks: "empty",
        photoCount: 1,
        qtyConfirmed: true,
        plannedQty: 25,
        acceptedQty: 0,
        damagedQty: 0,
        rejectedQty: 0,
      }),
    (err) => err.code === "RECEIVING_ZERO_QTY_CONDITION"
  );
  assert.throws(
    () =>
      assertUnitCompletable({
        actualQty: 0,
        condition: "DAMAGED",
        remarks: "empty",
        photoCount: 1,
        qtyConfirmed: true,
        plannedQty: 25,
        acceptedQty: 0,
        damagedQty: 0,
        rejectedQty: 0,
      }),
    (err) => err.code === "RECEIVING_ZERO_QTY_CONDITION"
  );
  assert.throws(
    () =>
      assertUnitCompletable({
        actualQty: 5,
        condition: "NOT_RECEIVED",
        remarks: "no",
        photoCount: 1,
        qtyConfirmed: true,
        plannedQty: 5,
        acceptedQty: 5,
        damagedQty: 0,
        rejectedQty: 0,
      }),
    (err) => err.code === "RECEIVING_DISPOSITION_CONDITION"
  );
});

run("never treat missing qty as rejected", () => {
  const resolved = resolveDispositionForComplete({
    actualQty: 23,
    condition: "GOOD",
  });
  assert.equal(resolved.acceptedQty, 23);
  assert.equal(resolved.rejectedQty, 0);
  const d = computeDispositionDerived({
    plannedQty: 25,
    actualQty: 23,
    ...resolved,
  });
  assert.equal(d.shortQty, 2);
  assert.equal(d.rejectedQty, 0);
});

run("bulk O-ring 43 planned / 41 actual / 39+1+1 MIXED", () => {
  const resolved = resolveDispositionForComplete({
    actualQty: 41,
    acceptedQty: 39,
    damagedQty: 1,
    rejectedQty: 1,
  });
  assert.equal(resolved.condition, "MIXED");
  assert.doesNotThrow(() =>
    assertUnitCompletable({
      actualQty: 41,
      condition: "MIXED",
      remarks: "2 short, 1 damaged, 1 rejected",
      photoCount: 2,
      qtyConfirmed: true,
      plannedQty: 43,
      acceptedQty: 39,
      damagedQty: 1,
      rejectedQty: 1,
      photos: [{ category: "DAMAGE" }, { category: "OVERALL" }],
    })
  );
  const d = computeDispositionDerived({
    plannedQty: 43,
    actualQty: 41,
    acceptedQty: 39,
    damagedQty: 1,
    rejectedQty: 1,
  });
  assert.equal(d.shortQty, 2);
  assert.equal(d.excessQty, 0);
  assert.equal(d.variance, -2);
});

run("piston qty 1 good/damaged/rejected", () => {
  assert.equal(suggestConditionFromDisposition({ actualQty: 1, acceptedQty: 1, damagedQty: 0, rejectedQty: 0 }), "GOOD");
  assert.equal(suggestConditionFromDisposition({ actualQty: 1, acceptedQty: 0, damagedQty: 1, rejectedQty: 0 }), "DAMAGED");
  assert.equal(suggestConditionFromDisposition({ actualQty: 1, acceptedQty: 0, damagedQty: 0, rejectedQty: 1 }), "REJECTED");
  assert.equal(suggestConditionFromDisposition({ actualQty: 5, acceptedQty: 0, damagedQty: 5, rejectedQty: 0 }), "DAMAGED");
  assert.equal(suggestConditionFromDisposition({ actualQty: 50, acceptedQty: 45, damagedQty: 5, rejectedQty: 0 }), "MIXED");
  assert.equal(suggestConditionFromDisposition({ actualQty: 0, acceptedQty: 0, damagedQty: 0, rejectedQty: 0 }), "NOT_RECEIVED");
});

run("damaged requires DAMAGE photo; short/excess/rejected require remarks", () => {
  assert.throws(
    () =>
      assertUnitCompletable({
        actualQty: 5,
        condition: "DAMAGED",
        remarks: "scuffed",
        photoCount: 1,
        qtyConfirmed: true,
        plannedQty: 5,
        acceptedQty: 0,
        damagedQty: 5,
        rejectedQty: 0,
        photos: [{ category: "OVERALL" }],
      }),
    (err) => err.code === "RECEIVING_DAMAGE_PHOTO_REQUIRED"
  );
  assert.throws(
    () =>
      assertUnitCompletable({
        actualQty: 23,
        condition: "GOOD",
        remarks: "",
        photoCount: 1,
        qtyConfirmed: true,
        plannedQty: 25,
        acceptedQty: 23,
        damagedQty: 0,
        rejectedQty: 0,
      }),
    (err) => err.code === "RECEIVING_DISCREPANCY_REMARKS"
  );
  assert.throws(
    () =>
      assertUnitCompletable({
        actualQty: 27,
        condition: "GOOD",
        remarks: "",
        photoCount: 1,
        qtyConfirmed: true,
        plannedQty: 25,
        acceptedQty: 27,
        damagedQty: 0,
        rejectedQty: 0,
      }),
    (err) => err.code === "RECEIVING_DISCREPANCY_REMARKS"
  );
  assert.doesNotThrow(() =>
    assertUnitCompletable({
      actualQty: 25,
      condition: "GOOD",
      remarks: "",
      photoCount: 1,
      qtyConfirmed: true,
      plannedQty: 25,
      acceptedQty: 25,
      damagedQty: 0,
      rejectedQty: 0,
    })
  );
  assert.throws(
    () =>
      assertUnitCompletable({
        actualQty: 5,
        condition: "REJECTED",
        remarks: "wrong part",
        photoCount: 0,
        qtyConfirmed: true,
        plannedQty: 5,
        acceptedQty: 0,
        damagedQty: 0,
        rejectedQty: 5,
      }),
    (err) => err.code === "RECEIVING_PHOTO_REQUIRED"
  );
});

run("KG decimal disposition 12.5 / 12.2 / 12.0 + 0.2", () => {
  assert.doesNotThrow(() =>
    assertUnitCompletable({
      actualQty: 12.2,
      condition: "MIXED",
      remarks: "0.2 kg damaged",
      photoCount: 2,
      qtyConfirmed: true,
      plannedQty: 12.5,
      acceptedQty: 12.0,
      damagedQty: 0.2,
      rejectedQty: 0,
      photos: [{ category: "DAMAGE" }, { category: "OVERALL" }],
    })
  );
  const d = computeDispositionDerived({
    plannedQty: 12.5,
    actualQty: 12.2,
    acceptedQty: 12,
    damagedQty: 0.2,
    rejectedQty: 0,
  });
  assert.equal(d.shortQty, 0.3);
});

run("stale version disposition save conflicts", () => {
  const unit = {
    actualQty: 50,
    acceptedQty: 45,
    damagedQty: 5,
    rejectedQty: 0,
    condition: "MIXED",
    status: "IN_PROGRESS",
    version: 4,
  };
  applyReceivingDraftSave(unit, { acceptedQty: 50, damagedQty: 0, expectedVersion: 4 });
  assert.equal(unit.version, 5);
  assert.throws(
    () => assertOptimisticVersion(unit.version, 4),
    (err) => err.code === "RECEIVING_CONFLICT" && err.status === 409
  );
});

run("late autosave cannot change completed disposition", () => {
  const unit = {
    plannedQty: 25,
    actualQty: 25,
    acceptedQty: 25,
    damagedQty: 0,
    rejectedQty: 0,
    condition: "GOOD",
    qtyConfirmed: true,
    status: "IN_PROGRESS",
    version: 2,
    remarks: "",
  };
  applyReceivingUnitComplete(unit, { photoCount: 1, minPhotosPerRU: 1, actor: "a" });
  assert.throws(
    () => applyReceivingDraftSave(unit, { acceptedQty: 20, damagedQty: 5, expectedVersion: 2 }),
    (err) => err.code === "RECEIVING_UNIT_ALREADY_COMPLETED"
  );
  assert.equal(unit.acceptedQty, 25);
});

run("legacy COMPLETED without buckets is DISPOSITION_REQUIRED", () => {
  const legacy = { status: "COMPLETED", actualQty: 25, condition: "GOOD" };
  assert.equal(hasValidDisposition(legacy), false);
  assert.equal(isDispositionRequired(legacy), true);
  const session = { status: "IN_PROGRESS" };
  assert.throws(
    () => applyReceivingSessionComplete(session, { allRusComplete: true, allDispositionValid: false }),
    (err) => err.code === "RECEIVING_DISPOSITION_REQUIRED"
  );
  const ready = computeDispositionReadiness([legacy]);
  assert.equal(ready.dispositionReady, false);
  assert.equal(ready.dispositionRequiredCount, 1);
  assert.throws(
    () => assertPhase4CanConsumeReceivingUnits([legacy]),
    (err) => err.code === "RECEIVING_DISPOSITION_REQUIRED"
  );
});

run("dispositionReady is false until every current RU has valid disposition", () => {
  const ru1 = {
    status: "COMPLETED",
    plannedQty: 25,
    actualQty: 25,
    acceptedQty: 25,
    damagedQty: 0,
    rejectedQty: 0,
    condition: "GOOD",
  };
  const ru2 = {
    status: "COMPLETED",
    plannedQty: 25,
    actualQty: 0,
    acceptedQty: 0,
    damagedQty: 0,
    rejectedQty: 0,
    condition: "NOT_RECEIVED",
  };
  const missing = { status: "COMPLETED", plannedQty: 25, actualQty: 25, condition: "GOOD" };
  assert.equal(computeDispositionReadiness([ru1, missing]).dispositionReady, false);
  assert.equal(computeDispositionReadiness([ru1, ru2]).dispositionReady, true);
  assert.doesNotThrow(() => assertPhase4CanConsumeReceivingUnits([ru1, ru2]));
});

run("same Article 36 / 43 / 48 stays RU- and ASN-scoped", () => {
  const a = { companyId: "MAR", receivingSessionId: "sA", receivingUnitId: "ruA1", article: "20834", asnId: "asnA", asnLineId: "lineA", ruNo: "MAR-RU-000101", plannedQty: 36, actualQty: 36, acceptedQty: 36 };
  const b1 = { companyId: "MAR", receivingSessionId: "sB", receivingUnitId: "ruB1", article: "20834", asnId: "asnB", asnLineId: "lineB", ruNo: "MAR-RU-000150", plannedQty: 22, actualQty: 22, acceptedQty: 22 };
  const b2 = { companyId: "MAR", receivingSessionId: "sB", receivingUnitId: "ruB2", article: "20834", asnId: "asnB", asnLineId: "lineB", ruNo: "MAR-RU-000151", plannedQty: 21, actualQty: 21, acceptedQty: 21 };
  const c = [
    { ruNo: "MAR-RU-000211", plannedQty: 16, actualQty: 16, acceptedQty: 16, article: "20834", receivingSessionId: "sC", asnId: "asnC", asnLineId: "lineC", receivingUnitId: "ruC1", companyId: "MAR" },
    { ruNo: "MAR-RU-000212", plannedQty: 16, actualQty: 16, acceptedQty: 16, article: "20834", receivingSessionId: "sC", asnId: "asnC", asnLineId: "lineC", receivingUnitId: "ruC2", companyId: "MAR" },
    { ruNo: "MAR-RU-000213", plannedQty: 16, actualQty: 16, acceptedQty: 16, article: "20834", receivingSessionId: "sC", asnId: "asnC", asnLineId: "lineC", receivingUnitId: "ruC3", companyId: "MAR" },
  ];
  assert.notEqual(uniqueSessionUnitKey(a), uniqueSessionUnitKey(b1));
  assert.notEqual(a.asnId, b1.asnId);
  const lineB = aggregateAsnLineDisposition([b1, b2]);
  assert.equal(lineB.plannedQty, 43);
  assert.equal(lineB.acceptedQty, 43);
  const lineC = aggregateAsnLineDisposition(c);
  assert.equal(lineC.plannedQty, 48);
  const allArticle = aggregateAsnLineDisposition([a, b1, b2, ...c]);
  assert.equal(allArticle.plannedQty, 36 + 43 + 48);
  assert.notEqual(a.receivingSessionId, b1.receivingSessionId);
});

run("Phase 4-ready ASN-line summary 25+25 planned, 23+25 actual, 23+20 accepted, 5 damaged", () => {
  const agg = aggregateAsnLineDisposition([
    { plannedQty: 25, actualQty: 23, acceptedQty: 23, damagedQty: 0, rejectedQty: 0 },
    { plannedQty: 25, actualQty: 25, acceptedQty: 20, damagedQty: 5, rejectedQty: 0 },
  ]);
  assert.equal(agg.plannedQty, 50);
  assert.equal(agg.actualQty, 48);
  assert.equal(agg.acceptedQty, 43);
  assert.equal(agg.damagedQty, 5);
  assert.equal(agg.rejectedQty, 0);
  assert.equal(agg.shortQty, 2);
  assert.equal(agg.excessQty, 0);
  assert.equal(agg.variance, -2);
});

run("schema stores disposition qty fields only, not stock", () => {
  const model = fs.readFileSync(path.join(srcRoot, "models", "ReceivingSessionUnit.js"), "utf8");
  assert.match(model, /acceptedQty/);
  assert.match(model, /damagedQty/);
  assert.match(model, /rejectedQty/);
  assert.doesNotMatch(model, /StockLedger/);
  assert.doesNotMatch(model, /onHand/);
});

run("service save/complete/summary use version CAS and derived shortage", () => {
  const svc = fs.readFileSync(path.join(srcRoot, "services", "receivingInspectionService.js"), "utf8");
  assert.match(svc, /acceptedQty/);
  assert.match(svc, /assertOptimisticVersion/);
  assert.match(svc, /RECEIVING_DISPOSITION_REQUIRED/);
  assert.match(svc, /dispositionReady/);
  assert.match(svc, /dispositionRequiredCount/);
  assert.match(svc, /evaluateCompleteDispositionEvidence/);
  assert.doesNotMatch(svc, /StockLedger/);
  assert.doesNotMatch(svc, /createGrn/);
  assert.doesNotMatch(svc, /asnActiveQty/);
  assert.doesNotMatch(svc, /PARTIALLY_RECEIVED/);
});

run("tablet All Good + mixed inputs + discrepancy review exist", () => {
  const inspect = fs.readFileSync(path.join(feRoot, "components", "store", "ReceivingUnitInspectScreen.jsx"), "utf8");
  const review = fs.readFileSync(path.join(feRoot, "components", "store", "ReceivingDispositionReview.jsx"), "utf8");
  const incoming = fs.readFileSync(path.join(feRoot, "components", "store", "IncomingShipmentsPanel.jsx"), "utf8");
  assert.match(inspect, /All Good/);
  assert.match(inspect, /Nothing Received \/ Not Found/);
  assert.match(inspect, /NOT_RECEIVED/);
  assert.match(review, /NOT RECEIVED/);
  assert.match(review, /MIXED/);
  assert.match(inspect, /Accepted/);
  assert.match(inspect, /Damaged/);
  assert.match(inspect, /Rejected/);
  assert.match(inspect, /html5-qrcode|Take Photo/);
  assert.match(inspect, /clientUploadId/);
  assert.match(review, /Discrepancy Review/);
  assert.match(incoming, /ReceivingDispositionReview/);
  assert.match(incoming, /Scan Item/);
});

run("Phase 3B has 0 stock / GRN / customs / accounting side effects", () => {
  const rules = fs.readFileSync(path.join(srcRoot, "utils", "receivingInspectionRules.js"), "utf8");
  const svc = fs.readFileSync(path.join(srcRoot, "services", "receivingInspectionService.js"), "utf8");
  for (const src of [rules, svc]) {
    assert.doesNotMatch(src, /StockLedger/);
    assert.doesNotMatch(src, /CustomsLot/);
    assert.doesNotMatch(src, /CustomsMovement/);
    assert.doesNotMatch(src, /asnActiveQty/);
    assert.doesNotMatch(src, /createJournal/i);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
