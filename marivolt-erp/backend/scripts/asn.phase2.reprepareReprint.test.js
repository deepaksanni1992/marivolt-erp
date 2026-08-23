/**
 * Re-Prepare Receiving Units vs Reprint All — identity vs labels.
 * Run: node scripts/asn.phase2.reprepareReprint.test.js
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyMemoryRuPlan,
  distributionsMatch,
  isCurrentPlanRu,
  retireStatusForRu,
  tryClaimRuPlanVersion,
} from "../src/utils/receivingUnitRules.js";
import {
  evaluateReceivingScanEligibility,
  assertReplanBlockedByReceiving,
  classifyReplanReceivingFreeze,
  isEmptyDraftReceivingSession,
} from "../src/utils/receivingInspectionRules.js";
import { getDefaultPermissionsForRole } from "../src/services/roleService.js";
import { asnLabelTsplOpts } from "../src/services/label/asnLabelService.js";
import { suggestedDistribution } from "../../src/lib/receivingUnitLabels.js";

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

console.log("\nASN Re-Prepare + Reprint All\n");

run("A: qty 5 suggested split is 1+1+1+1+1 unique identities", () => {
  assert.deepEqual(suggestedDistribution(5, 5), [1, 1, 1, 1, 1]);
});

run("forceReplan is required to mint new RUs even when distribution matches", () => {
  const svc = fs.readFileSync(path.join(srcRoot, "services", "receivingUnitService.js"), "utf8");
  assert.match(svc, /forceReplan/);
  assert.match(svc, /!forceReplan && distributionsMatch/);
  assert.match(svc, /nextRuNo/);
  assert.doesNotMatch(svc, /ReceivingUnit\.delete/);
});

run("B/C: PLANNED and PRINTED replan allowed until receiving activity", () => {
  const guard = fs.readFileSync(path.join(srcRoot, "services", "receivingInspectionGuard.js"), "utf8");
  assert.match(guard, /inspectReplanReceivingBlockers/);
  assert.match(guard, /RECEIVING_SESSION/);
  const ruSvc = fs.readFileSync(path.join(srcRoot, "services", "receivingUnitService.js"), "utf8");
  assert.match(ruSvc, /inspectReplanGrnBlockers/);
  assert.doesNotThrow(() => assertReplanBlockedByReceiving(false));
  assert.throws(() => assertReplanBlockedByReceiving(true), (err) => err.code === "RU_RECEIVING_STARTED");
});

run("D-G: replan retires printed as SUPERSEDED and mints new ruNos", () => {
  const line = { ruPlanVersion: 1, ruActivePlanBatchId: "b1", asnQty: 5 };
  const rus = [
    { status: "PRINTED", plannedQty: 1, planBatchId: "b1", ruNo: "MAR-RU-000003", barcodeValue: "MAR-RU-000003" },
    { status: "PRINTED", plannedQty: 1, planBatchId: "b1", ruNo: "MAR-RU-000004", barcodeValue: "MAR-RU-000004" },
    { status: "PRINTED", plannedQty: 1, planBatchId: "b1", ruNo: "MAR-RU-000005", barcodeValue: "MAR-RU-000005" },
    { status: "PRINTED", plannedQty: 1, planBatchId: "b1", ruNo: "MAR-RU-000006", barcodeValue: "MAR-RU-000006" },
    { status: "PRINTED", plannedQty: 1, planBatchId: "b1", ruNo: "MAR-RU-000007", barcodeValue: "MAR-RU-000007" },
  ];
  const result = applyMemoryRuPlan({
    line,
    rus,
    distribution: [3, 2],
    replacePrinted: true,
    batchId: "b2",
    expectedVersion: 1,
  });
  assert.equal(result.ok, true);
  assert.equal(line.ruPlanVersion, 2);
  assert.equal(String(line.ruActivePlanBatchId), "b2");
  const oldNos = ["MAR-RU-000003", "MAR-RU-000004", "MAR-RU-000005", "MAR-RU-000006", "MAR-RU-000007"];
  assert.equal(rus.filter((ru) => ru.status === "SUPERSEDED").length, 5);
  assert.deepEqual(
    rus.filter((ru) => ru.status === "SUPERSEDED").map((ru) => ru.ruNo),
    oldNos
  );
  const active = rus.filter((ru) => isCurrentPlanRu(ru, line.ruActivePlanBatchId));
  assert.equal(active.length, 2);
  assert.equal(active.every((ru) => ru.status === "PLANNED"), true);
  assert.equal(active.every((ru) => !oldNos.includes(ru.ruNo)), true);
  assert.deepEqual(
    active.map((ru) => ru.plannedQty),
    [3, 2]
  );
  assert.equal(retireStatusForRu({ status: "PRINTED" }), "SUPERSEDED");
  assert.equal(retireStatusForRu({ status: "PLANNED" }), "CANCELLED");
});

run("H: superseded barcode cannot start receiving", () => {
  const e = evaluateReceivingScanEligibility(
    { status: "SUPERSEDED", ruNo: "MAR-RU-000003", replacementRuNos: ["MAR-RU-000008"] },
    { current: false }
  );
  assert.equal(e.canReceive, false);
  assert.equal(e.code, "RU_SUPERSEDED");
  assert.match(e.userMessage, /superseded/i);
  assert.match(e.userMessage, /current RU label/i);
});

run("I: current PRINTED barcode is accepted", () => {
  const e = evaluateReceivingScanEligibility(
    { status: "PRINTED", ruNo: "MAR-RU-000008" },
    { current: true }
  );
  assert.equal(e.canReceive, true);
  assert.equal(e.code, "OK");
});

run("1: no session → replan freeze is off", () => {
  const freeze = classifyReplanReceivingFreeze({ session: null, unitCount: 0, photoCount: 0 });
  assert.equal(freeze.blocked, false);
  assert.equal(isEmptyDraftReceivingSession({ session: null, unitCount: 0, photoCount: 0 }), false);
});

run("2: empty DRAFT session → replan freeze is off", () => {
  const session = { status: "DRAFT", completedAt: null };
  assert.equal(isEmptyDraftReceivingSession({ session, unitCount: 0, photoCount: 0 }), true);
  const freeze = classifyReplanReceivingFreeze({ session, unitCount: 0, photoCount: 0 });
  assert.equal(freeze.blocked, false);
});

run("3: successful replacement cancels empty DRAFT inside persist", () => {
  const svc = fs.readFileSync(path.join(srcRoot, "services", "receivingUnitService.js"), "utf8");
  const replica = svc.slice(
    svc.indexOf("async function persistReplacementPlanReplicaSet"),
    svc.indexOf("async function persistReplacementPlanStandalone")
  );
  const standalone = svc.slice(
    svc.indexOf("async function persistReplacementPlanStandalone"),
    svc.indexOf("async function persistReplacementPlan(")
  );
  assert.match(replica, /invalidateEmptyDraftReceivingSession/);
  assert.match(replica, /mongoSession: session/);
  assert.match(standalone, /invalidateEmptyDraftReceivingSession/);
  const guard = fs.readFileSync(path.join(srcRoot, "services", "receivingInspectionGuard.js"), "utf8");
  assert.match(guard, /status: "CANCELLED"/);
  assert.match(guard, /one-active-session-per-ASN/);
});

run("4: first persisted ReceivingSessionUnit → RU_RECEIVING_STARTED", () => {
  const freeze = classifyReplanReceivingFreeze({
    session: { status: "DRAFT" },
    unitCount: 1,
    photoCount: 0,
  });
  assert.equal(freeze.blocked, true);
  assert.equal(freeze.source, "RECEIVING_SESSION_UNIT");
  assert.equal(isEmptyDraftReceivingSession({ session: { status: "DRAFT" }, unitCount: 1, photoCount: 0 }), false);
});

run("5: qty/disposition on a persisted unit → blocked", () => {
  const freeze = classifyReplanReceivingFreeze({
    session: { status: "IN_PROGRESS" },
    unitCount: 1,
    photoCount: 0,
  });
  assert.equal(freeze.blocked, true);
  assert.equal(freeze.source, "RECEIVING_SESSION_UNIT");
});

run("6: ReceivingUnitPhoto → blocked", () => {
  const freeze = classifyReplanReceivingFreeze({
    session: { status: "DRAFT" },
    unitCount: 0,
    photoCount: 1,
  });
  assert.equal(freeze.blocked, true);
  assert.equal(freeze.source, "RECEIVING_PHOTO");
});

run("7: COMPLETED session → blocked", () => {
  const freeze = classifyReplanReceivingFreeze({
    session: { status: "COMPLETED", completedAt: new Date() },
    unitCount: 0,
    photoCount: 0,
  });
  assert.equal(freeze.blocked, true);
  assert.equal(freeze.source, "RECEIVING_SESSION");
  assert.match(freeze.reason, /complete/i);
});

run("8/9: draft and posted ASN GRN freeze Re-Prepare", () => {
  const svc = fs.readFileSync(path.join(srcRoot, "services", "receivingUnitService.js"), "utf8");
  assert.match(svc, /BLOCKING_GRN_STATUSES = \["DRAFT", "RECEIVED", "PARTIAL_RECEIVED", "POSTED", "CLOSED"\]/);
  assert.match(svc, /inspectReplanGrnBlockers/);
});

run("10: failed/concurrent replan must not cancel a used session", () => {
  const svc = fs.readFileSync(path.join(srcRoot, "services", "receivingUnitService.js"), "utf8");
  const standalone = svc.slice(
    svc.indexOf("async function persistReplacementPlanStandalone"),
    svc.indexOf("async function persistReplacementPlan(")
  );
  const catchAt = standalone.indexOf("} catch (err) {");
  const invalidateAt = standalone.indexOf("invalidateEmptyDraftReceivingSession");
  assert.ok(catchAt > 0);
  assert.ok(invalidateAt > catchAt);
  const replica = svc.slice(
    svc.indexOf("async function persistReplacementPlanReplicaSet"),
    svc.indexOf("async function persistReplacementPlanStandalone")
  );
  assert.ok(replica.indexOf("claimAsnLinePlanVersion") < replica.indexOf("invalidateEmptyDraftReceivingSession"));
  const guard = fs.readFileSync(path.join(srcRoot, "services", "receivingInspectionGuard.js"), "utf8");
  assert.match(guard, /NOT_EMPTY/);
  assert.match(guard, /NO_LONGER_DRAFT/);
  assert.match(guard, /RACE_EVIDENCE/);
  assert.match(guard, /status: "DRAFT"/);
});

run("J-L: receiving started / complete / GRN block with RU_RECEIVING_STARTED", () => {
  assert.throws(
    () => assertReplanBlockedByReceiving({ blocked: true, source: "RECEIVING_SESSION", sessionStatus: "IN_PROGRESS" }),
    (err) => err.code === "RU_RECEIVING_STARTED" && /started/i.test(err.message)
  );
  assert.throws(
    () =>
      assertReplanBlockedByReceiving({
        blocked: true,
        source: "RECEIVING_SESSION",
        sessionStatus: "COMPLETED",
        reason: "Receiving is complete. RU structure can no longer be changed.",
      }),
    (err) => err.code === "RU_RECEIVING_STARTED" && /complete/i.test(err.message)
  );
  assert.throws(
    () =>
      assertReplanBlockedByReceiving({
        blocked: true,
        source: "GRN",
        grnNo: "MAR-GRN-1",
        reason: "A GRN already exists for this receiving. RU structure can no longer be changed.",
      }),
    (err) => err.code === "RU_RECEIVING_STARTED" && err.details?.source === "GRN"
  );
});

run("M: concurrent replan CAS — loser is RU_PLAN_CONFLICT", () => {
  const line = { ruPlanVersion: 1, ruActivePlanBatchId: "b1" };
  const a = tryClaimRuPlanVersion(line, 1, "b2");
  const b = tryClaimRuPlanVersion(line, 1, "b3");
  assert.equal(a.ok, true);
  assert.equal(b.ok, false);
  assert.equal(b.reason, "RU_PLAN_CONFLICT");
});

run("N: first print is one job per RU copies=1, not copies=5", () => {
  const asnLabel = fs.readFileSync(path.join(srcRoot, "services", "label", "asnLabelService.js"), "utf8");
  assert.match(asnLabel, /const copies = 1/);
  assert.match(asnLabel, /requestedLabels = 1/);
  assert.match(asnLabel, /toUpperCase\(\) === "PLANNED"/);
  assert.equal(asnLabelTsplOpts({ copies: 1 }).copies, 1);
  assert.doesNotMatch(asnLabel, /copies = 5/);
});

run("O/P: Reprint All uses isReprint and does not bump plan version", () => {
  const asnLabel = fs.readFileSync(path.join(srcRoot, "services", "label", "asnLabelService.js"), "utf8");
  assert.match(asnLabel, /export async function reprintAllReceivingUnits/);
  assert.match(asnLabel, /isReprint: true/);
  assert.match(asnLabel, /ruPlanVersionUnchanged: true/);
  assert.doesNotMatch(asnLabel.slice(asnLabel.indexOf("reprintAllReceivingUnits")), /ruPlanVersion \+/);
  assert.doesNotMatch(asnLabel.slice(asnLabel.indexOf("reprintAllReceivingUnits")), /claimAsnLinePlanVersion/);
});

run("Q: individual reprint route remains", () => {
  const routes = fs.readFileSync(path.join(srcRoot, "routes", "asnRoutes.js"), "utf8");
  const reprintAllAt = routes.indexOf("receiving-units/reprint-all");
  const reprintOneAt = routes.indexOf("receiving-units/:ruId/reprint");
  assert.ok(reprintAllAt > 0);
  assert.ok(reprintOneAt > reprintAllAt);
});

run("R/S: replan service still does not mutate PO/stock/customs/GRN posting", () => {
  const svc = fs.readFileSync(path.join(srcRoot, "services", "receivingUnitService.js"), "utf8");
  assert.doesNotMatch(svc, /asnActiveQty/);
  assert.doesNotMatch(svc, /StockLedger/);
  assert.doesNotMatch(svc, /CustomsLot/);
  assert.doesNotMatch(svc, /GRN\.create/);
  assert.doesNotMatch(svc, /postGrn/);
});

run("T: STORE_OPERATOR keeps ASN view-only and LABELS print/reprint", () => {
  const m = getDefaultPermissionsForRole("store_operator");
  assert.deepEqual(m.ASN, ["view"]);
  assert.ok(m.LABELS.includes("print"));
  assert.ok(m.LABELS.includes("reprint"));
  const routes = fs.readFileSync(path.join(srcRoot, "routes", "asnRoutes.js"), "utf8");
  assert.match(routes, /asnLabelPrint, ru.plan/);
  assert.match(routes, /asnLabelReprint, ru.reprintAll/);
});

run("UI: Re-Prepare and Reprint All are distinct from Cancel Label", () => {
  const incoming = fs.readFileSync(path.join(feRoot, "components", "store", "IncomingShipmentsPanel.jsx"), "utf8");
  const planner = fs.readFileSync(path.join(feRoot, "components", "store", "AsnReceivingLabelPlanner.jsx"), "utf8");
  assert.match(incoming, /Re-Prepare Receiving Units/);
  assert.match(incoming, /Reprint All RU Labels/);
  assert.doesNotMatch(incoming, /Cancel Label/);
  assert.match(incoming, /permanently supersede those RU numbers/);
  assert.doesNotMatch(incoming, /Boolean\(session\)/);
  assert.match(incoming, /ruListQ\.data\?\.replanAllowed === false/);
  assert.match(planner, /forceReplan/);
  assert.match(planner, /Reprint All RU Labels/);
  assert.match(planner, /Reprint RU Label/);
  assert.match(planner, /Print RU Labels/);
});

run("audit records previous and new RU plan identities", () => {
  const svc = fs.readFileSync(path.join(srcRoot, "services", "receivingUnitService.js"), "utf8");
  assert.match(svc, /writeAudit/);
  assert.match(svc, /RECEIVING_UNIT_PLAN/);
  assert.match(svc, /previousRuNos/);
  assert.match(svc, /newRuNos/);
  assert.match(svc, /previousRuPlanVersion/);
});

run("same distribution is reused unless forceReplan", () => {
  assert.equal(distributionsMatch([1, 1, 1, 1, 1], [1, 1, 1, 1, 1]), true);
  assert.equal(distributionsMatch([1, 1, 1, 1, 1], [3, 2]), false);
});

run("print-agent version is independent of this reprepare workflow", () => {
  const agent = fs.readFileSync(path.join(feRoot, "..", "print-agent", "src", "index.js"), "utf8");
  assert.match(agent, /APP_VERSION = "1\.5\.0"/);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
