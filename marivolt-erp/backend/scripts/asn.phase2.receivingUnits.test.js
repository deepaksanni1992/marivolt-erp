/**
 * ASN Phase 2 — Receiving Unit label planning.
 * Run: node scripts/asn.phase2.receivingUnits.test.js
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  distributeByLabelCount,
  distributeByQtyPerLabel,
  isSuccessfulLabelJobStatus,
  sumDistribution,
} from "../src/utils/grnLabelDistribution.js";
import {
  RU_PLAN_ELIGIBLE_ASN_STATUSES,
  RU_PRINTED_IMMUTABLE_KEYS,
  RU_CREATED_IMMUTABLE_KEYS,
  RU_STATUSES,
  ReceivingUnitError,
  applyMemoryRuPlan,
  applyMintThenPublishRuPlan,
  applySuccessfulPrintToRu,
  applyTransactionalRuPlan,
  assertAsnEligibleForRuPlan,
  assertCompletedPlanQtyInvariant,
  assertPrintedIdentityUnchanged,
  assertReplanAllowedForPrintJobs,
  buildReceivingUnitLabelFingerprint,
  distributionsMatch,
  formatAsnPartNo,
  isCurrentPlanRu,
  sumActivePlannedQty,
  tryClaimRuPlanVersion,
} from "../src/utils/receivingUnitRules.js";
import { formatRuNumber, ruCounterKey, padRuSeq } from "../src/services/receivingUnitNumberService.js";
import { validateAsnLineDistribution } from "../src/services/receivingUnitService.js";
import { encodeBarcodeValue } from "../src/services/label/barcodeGenerator.js";
import { buildJobTspl, buildSingleLabelTspl, wrapDescription } from "../src/services/label/tsplGenerator.js";
import { asnLabelTsplOpts, buildAsnRuJobLine, isAsnLabelJob } from "../src/services/label/asnLabelService.js";
import { assertAsnEditable } from "../src/utils/asnRules.js";
import {
  getDefaultPermissionsForRole,
  hasPermission,
} from "../src/services/roleService.js";
import {
  suggestedDistribution,
  validateAsnLabelDistribution,
  distributionDifference,
} from "../../src/lib/receivingUnitLabels.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.join(__dirname, "..");
const srcRoot = path.join(backendRoot, "src");
const feRoot = path.join(backendRoot, "..", "src");

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

async function runAsync(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed += 1;
    console.error(`  ✗ ${name}`);
    console.error(`    ${e.message}`);
  }
}

console.log("\nASN Phase 2 Receiving Units\n");

run("distribution 50 → [50]", () => {
  assert.deepEqual(distributeByLabelCount(50, 1), [50]);
  assert.deepEqual(suggestedDistribution(50, 1), [50]);
});

run("distribution 50 → [25, 25]", () => {
  assert.deepEqual(distributeByLabelCount(50, 2), [25, 25]);
});

run("distribution 50 → [20, 20, 10] custom", () => {
  const v = validateAsnLineDistribution(50, { article: "20834", labelDistribution: [20, 20, 10], labelCount: 3 });
  assert.equal(v.ok, true);
  assert.deepEqual(v.distribution, [20, 20, 10]);
});

run("distribution 25 → [10, 10, 5]", () => {
  assert.deepEqual(distributeByQtyPerLabel(25, 10), [10, 10, 5]);
});

run("distribution 10 → ten × 1", () => {
  const d = distributeByLabelCount(10, 10);
  assert.equal(d.length, 10);
  assert.ok(d.every((q) => q === 1));
  assert.equal(sumDistribution(d), 10);
});

run("uneven custom split rejects wrong sum", () => {
  assert.throws(
    () => validateAsnLineDistribution(50, { article: "W", labelDistribution: [20, 20, 9] }),
    (err) => err instanceof ReceivingUnitError && err.code === "RU_DISTRIBUTION_INVALID"
  );
});

run("frontend validator remaps GRN Qty wording", () => {
  const v = validateAsnLabelDistribution(50, { article: "X", labelDistribution: [20, 20, 9] });
  assert.equal(v.ok, false);
  assert.match(v.message, /ASN Qty/);
  assert.doesNotMatch(v.message, /GRN Qty/);
});

run("difference must be zero to confirm", () => {
  const ok = distributionDifference(50, [25, 25]);
  assert.equal(ok.difference, 0);
  const bad = distributionDifference(50, [20, 20, 9]);
  assert.notEqual(bad.difference, 0);
});

run("RU numbering format is company-scoped 6 digits", () => {
  assert.equal(formatRuNumber("MAR", 1), "MAR-RU-000001");
  assert.equal(formatRuNumber("OKE", 1), "OKE-RU-000001");
  assert.equal(ruCounterKey("MAR"), "ru:MAR");
  assert.equal(padRuSeq(12), "000012");
});

run("eligible ASN statuses are SHIPPED and ARRIVED only", () => {
  assert.deepEqual([...RU_PLAN_ELIGIBLE_ASN_STATUSES], ["SHIPPED", "ARRIVED"]);
  assert.equal(assertAsnEligibleForRuPlan("SHIPPED"), "SHIPPED");
  assert.equal(assertAsnEligibleForRuPlan("ARRIVED"), "ARRIVED");
  for (const s of ["DRAFT", "CANCELLED", "COMPLETED", "PARTIALLY_RECEIVED"]) {
    assert.throws(() => assertAsnEligibleForRuPlan(s), ReceivingUnitError);
  }
});

run("fingerprints differ by distribution and RU identity", () => {
  const a = buildReceivingUnitLabelFingerprint([
    { _id: "1", ruNo: "MAR-RU-000001", plannedQty: 50, barcodeValue: "MAR-RU-000001", asnLineId: "L1", article: "A" },
  ]);
  const b = buildReceivingUnitLabelFingerprint([
    { _id: "2", ruNo: "MAR-RU-000002", plannedQty: 25, barcodeValue: "MAR-RU-000002", asnLineId: "L1", article: "A" },
    { _id: "3", ruNo: "MAR-RU-000003", plannedQty: 25, barcodeValue: "MAR-RU-000003", asnLineId: "L1", article: "A" },
  ]);
  assert.notEqual(a, b);
  assert.equal(distributionsMatch([25, 25], [25, 25]), true);
  assert.equal(distributionsMatch([25, 25], [20, 20, 10]), false);
});

run("printed RU identity cannot silently change", () => {
  const ru = { status: "PRINTED", ruNo: "MAR-RU-000125", barcodeValue: "MAR-RU-000125", plannedQty: 25, article: "20834", asnId: "A", asnLineId: "L" };
  assert.throws(
    () => assertPrintedIdentityUnchanged(ru, { plannedQty: 50 }),
    (err) => err.code === "RU_PRINTED_IMMUTABLE"
  );
  assert.ok(RU_PRINTED_IMMUTABLE_KEYS.includes("ruNo"));
  assert.ok(RU_PRINTED_IMMUTABLE_KEYS.includes("barcodeValue"));
});

run("GRN barcode remains Article; ASN RU barcode is RU number", () => {
  const grn = encodeBarcodeValue({ mode: "ARTICLE", article: "20834" });
  assert.equal(grn.value, "20834");
  const ru = encodeBarcodeValue({ mode: "LABEL_ID", labelId: "MAR-RU-000125" });
  assert.equal(ru.value, "MAR-RU-000125");
  const grnTspl = buildSingleLabelTspl(
    { article: "20834", description: "O-Ring", uom: "PCS", grnNo: "GRN1" },
    { barcodeMode: "ARTICLE", qtyPerLabel: 50 }
  );
  assert.match(grnTspl, /BARCODE .*"20834"/);
  assert.doesNotMatch(grnTspl, /MAR-RU-/);
  const asnTspl = buildSingleLabelTspl(
    {
      article: "20834",
      partNo: "TE201 / TE402",
      description: "O-Ring",
      ruNo: "MAR-RU-000125",
      labelId: "MAR-RU-000125",
      barcodeValue: "MAR-RU-000125",
      grnNo: "MAR-ASN-0045",
      uom: "PCS",
    },
    { ...asnLabelTsplOpts({ companyName: "MARIVOLT FZE" }), qtyPerLabel: 25 }
  );
  assert.match(asnTspl, /SIZE 100 mm,50 mm/);
  assert.match(asnTspl, /BARCODE .*"MAR-RU-000125"/);
  assert.match(asnTspl, /ASN: MAR-ASN-0045/);
  assert.match(asnTspl, /RU: MAR-RU-000125/);
  assert.match(asnTspl, /TE201 \/ TE402/);
  assert.match(asnTspl, /Qty: 25 PCS/);
  assert.match(asnTspl, /20834/);
  assert.doesNotMatch(asnTspl, /GRN:/);
});

run("one RU job line is one face, copies=1, LABEL_ID", () => {
  const line = buildAsnRuJobLine(
    {
      _id: "ru1",
      ruNo: "MAR-RU-000002",
      article: "WASH",
      plannedQty: 25,
      uom: "PCS",
      asnNo: "MAR-ASN-0001",
      asnLineId: "line1",
    },
    { asnNo: "MAR-ASN-0001" }
  );
  assert.equal(line.barcodeValue, "MAR-RU-000002");
  assert.equal(line.labelCount, 1);
  assert.deepEqual(line.labelDistribution, [25]);
  assert.equal(line.labelQty, 1);
  const tspl = buildJobTspl([line], asnLabelTsplOpts({ copies: 1 }));
  assert.equal((tspl.match(/PRINT 1,1/g) || []).length, 1);
  assert.equal(isAsnLabelJob({ sourceType: "ASN" }), true);
  assert.equal(isAsnLabelJob({ sourceType: "GRN" }), false);
});

run("COMPLETED is the only successful print status", () => {
  assert.equal(isSuccessfulLabelJobStatus("COMPLETED"), true);
  for (const s of ["PENDING", "LEASED", "PRINTING", "PARTIAL", "FAILED", "UNCERTAIN", "CANCELLED"]) {
    assert.equal(isSuccessfulLabelJobStatus(s), false);
  }
});

run("part no combines article part and SPN", () => {
  assert.equal(formatAsnPartNo({ partNumber: "TE201", supplierPartNumber: "TE402" }), "TE201 / TE402");
  assert.equal(formatAsnPartNo({ partNo: "TE201", spn: "TE201" }), "TE201");
});

run("LabelPrintJob sourceType includes ASN; no second job model", () => {
  const model = fs.readFileSync(path.join(srcRoot, "models", "LabelPrintJob.js"), "utf8");
  assert.match(model, /"ASN"/);
  assert.match(model, /receivingUnitId/);
  assert.match(model, /ruNo/);
  assert.equal(fs.existsSync(path.join(srcRoot, "models", "ReceivingUnit.js")), true);
  assert.equal(fs.existsSync(path.join(srcRoot, "models", "AsnLabelPlan.js")), false);
  assert.equal(fs.existsSync(path.join(srcRoot, "models", "AsnPrintJob.js")), false);
});

run("RU schema is tablet-ready without photo/actualQty fields", () => {
  const model = fs.readFileSync(path.join(srcRoot, "models", "ReceivingUnit.js"), "utf8");
  for (const field of ["ruNo", "barcodeValue", "asnId", "asnLineId", "plannedQty", "status", "lastLabelJobId"]) {
    assert.ok(model.includes(field), field);
  }
  assert.ok(!model.includes("actualQty:"));
  assert.ok(!model.includes("photos:"));
  assert.ok(!model.includes("acceptedQty:"));
  assert.match(model, /companyId: 1, barcodeValue: 1/);
});

run("partial print mapping is one job per RU", () => {
  const svc = fs.readFileSync(path.join(srcRoot, "services", "label", "asnLabelService.js"), "utf8");
  assert.match(svc, /One LabelPrintJob per Receiving Unit/);
  assert.match(svc, /requestedLabels = 1/);
  const ruSvc = fs.readFileSync(path.join(srcRoot, "services", "receivingUnitService.js"), "utf8");
  assert.match(ruSvc, /isSuccessfulLabelJobStatus/);
  assert.match(ruSvc, /PARTIAL \/ FAILED \/ UNCERTAIN never mark/);
});

run("print platform reused — no ASN agent/queue/TSPL fork", () => {
  const svc = fs.readFileSync(path.join(srcRoot, "services", "label", "asnLabelService.js"), "utf8");
  assert.match(svc, /resolvePrinterForJob/);
  assert.match(svc, /LabelPrintJob.create/);
  assert.match(svc, /buildJobTspl/);
  assert.match(svc, /barcodeMode: "LABEL_ID"/);
  assert.ok(!svc.includes("function buildAsnTsplGenerator"));
  const tspl = fs.readFileSync(path.join(srcRoot, "services", "label", "tsplGenerator.js"), "utf8");
  assert.match(tspl, /faceVariant === "ASN_RU"/);
  assert.match(tspl, /function buildAsnReceivingUnitFace/);
});

run("GRN reprint/retry keep ARTICLE unless sourceType ASN", () => {
  const labelSvc = fs.readFileSync(path.join(srcRoot, "services", "label", "labelService.js"), "utf8");
  assert.match(labelSvc, /function tsplOptsForJob/);
  assert.match(labelSvc, /barcodeMode: "LABEL_ID"/);
  assert.match(labelSvc, /barcodeMode: "ARTICLE"/);
  assert.match(labelSvc, /if \(!isAsnLabelJob\(parent\) && Array.isArray\(body.lines\)/);
  assert.match(labelSvc, /if \(sourceType && sourceType !== "GRN"\) return/);
});

run("routes: plan/print require ASN.view + LABELS.print, not ASN.edit", () => {
  const asnRoutes = fs.readFileSync(path.join(srcRoot, "routes", "asnRoutes.js"), "utf8");
  assert.match(asnRoutes, /receiving-units\/plan/);
  assert.match(asnRoutes, /receiving-units\/print/);
  assert.match(asnRoutes, /requireAllPermissions\(\["ASN", "view"\], \["LABELS", "print"\]\)/);
  assert.match(asnRoutes, /receiving-units\/reprint-all/);
  assert.match(asnRoutes, /receiving-units\/:ruId\/reprint/);
  assert.ok(!asnRoutes.includes('requirePermission("ASN", "edit"), ru.plan'));
  const labelRoutes = fs.readFileSync(path.join(srcRoot, "routes", "labelRoutes.js"), "utf8");
  assert.match(labelRoutes, /\/jobs\/from-asn/);
  assert.match(labelRoutes, /requireAllPermissions\(\["ASN", "view"\], \["LABELS", "view"\]\)/);
  const ruRoutes = fs.readFileSync(path.join(srcRoot, "routes", "receivingUnitRoutes.js"), "utf8");
  assert.match(ruRoutes, /by-barcode\/:barcode/);
  assert.doesNotMatch(ruRoutes, /router\.(patch|put|delete)/);
  const server = fs.readFileSync(path.join(srcRoot, "server.js"), "utf8");
  assert.match(server, /\/api\/receiving-units/);
});

run("planning does not touch stock / PO reservation / GRN", () => {
  const svc = fs.readFileSync(path.join(srcRoot, "services", "receivingUnitService.js"), "utf8");
  assert.doesNotMatch(svc, /StockLedger/);
  assert.doesNotMatch(svc, /asnActiveQty/);
  assert.doesNotMatch(svc, /CustomsLot/);
  assert.doesNotMatch(svc, /GRN\.create/);
  assert.match(svc, /PurchaseOrder.findOne/);
  assert.doesNotMatch(svc, /PurchaseOrder\.update/);
  const asnLabel = fs.readFileSync(path.join(srcRoot, "services", "label", "asnLabelService.js"), "utf8");
  assert.doesNotMatch(asnLabel, /StockLedger/);
  assert.doesNotMatch(asnLabel, /asnActiveQty/);
});

run("STORE_OPERATOR can plan/print without ASN.edit", () => {
  const m = getDefaultPermissionsForRole("store_operator");
  assert.deepEqual(m.ASN, ["view"]);
  assert.ok(m.LABELS.includes("print"));
  assert.ok(m.LABELS.includes("reprint"));
  assert.ok(!m.ASN.includes("edit"));
  const purchase = getDefaultPermissionsForRole("purchase");
  assert.ok(purchase.ASN.includes("edit"));
  assert.ok(!(purchase.LABELS || []).includes("print"));
});

await runAsync("hasPermission STORE_OPERATOR plan vs edit", async () => {
  const req = { user: { role: "store_operator" } };
  assert.equal(await hasPermission(req, "ASN", "view"), true);
  assert.equal(await hasPermission(req, "LABELS", "print"), true);
  assert.equal(await hasPermission(req, "LABELS", "reprint"), true);
  assert.equal(await hasPermission(req, "ASN", "edit"), false);
  assert.equal(await hasPermission(req, "ASN", "create"), false);
});

run("frontend Incoming Shipments has Prepare Receiving Units and tablet planner", () => {
  const panel = fs.readFileSync(path.join(feRoot, "components", "store", "IncomingShipmentsPanel.jsx"), "utf8");
  assert.match(panel, /Prepare Receiving Units/);
  assert.match(panel, /Print RU Labels/);
  assert.match(panel, /AsnReceivingLabelPlanner/);
  assert.match(panel, /can\("ASN", "view"\)/);
  assert.match(panel, /can\("LABELS", "print"\)/);
  const planner = fs.readFileSync(path.join(feRoot, "components", "store", "AsnReceivingLabelPlanner.jsx"), "utf8");
  assert.match(planner, /inputMode="numeric"/);
  assert.match(planner, /min-h-12/);
  assert.match(planner, /min-h-14/);
  assert.match(planner, /AsnRuLabelPreviewFace/);
  assert.doesNotMatch(planner, /onMouseEnter/);
  assert.doesNotMatch(planner, /draggable/);
});

run("replan retires old RUs and never reuses numbers", () => {
  const svc = fs.readFileSync(path.join(srcRoot, "services", "receivingUnitService.js"), "utf8");
  assert.match(svc, /status: nextStatus/);
  assert.match(svc, /SUPERSEDED/);
  assert.match(svc, /nextRuNo/);
  assert.match(svc, /RU_PRINTED_PLAN_LOCKED/);
  assert.match(svc, /claimAsnLinePlanVersion/);
  const num = fs.readFileSync(path.join(srcRoot, "services", "receivingUnitNumberService.js"), "utf8");
  assert.match(num, /numbers are never reused/);
  assert.match(num, /\$inc: \{ seq: 1 \}/);
});

run("agent result maps COMPLETED onto RU printed state", () => {
  const agent = fs.readFileSync(path.join(srcRoot, "controllers", "labelAgentController.js"), "utf8");
  assert.match(agent, /applyReceivingUnitPrintResult/);
  const ruSvc = fs.readFileSync(path.join(srcRoot, "services", "receivingUnitService.js"), "utf8");
  assert.match(ruSvc, /status: "PLANNED"/);
  assert.match(ruSvc, /labelPrintedAt: ru.labelPrintedAt \|\| printedAt/);
});

run("RU lifecycle includes SUPERSEDED distinct from CANCELLED", () => {
  assert.deepEqual([...RU_STATUSES], ["PLANNED", "PRINTED", "SUPERSEDED", "CANCELLED"]);
  const model = fs.readFileSync(path.join(srcRoot, "models", "ReceivingUnit.js"), "utf8");
  assert.match(model, /SUPERSEDED/);
  assert.match(model, /supersededAt/);
  assert.ok(RU_CREATED_IMMUTABLE_KEYS.includes("planBatchId"));
  assert.ok(RU_CREATED_IMMUTABLE_KEYS.includes("barcodeValue"));
});

run("ASN line stores atomic current plan identity", () => {
  const model = fs.readFileSync(path.join(srcRoot, "models", "AdvanceShipmentNotice.js"), "utf8");
  assert.match(model, /ruPlanVersion/);
  assert.match(model, /ruActivePlanBatchId/);
  assert.doesNotMatch(model, /ReceivingUnit/);
  assert.doesNotMatch(model, /barcode/);
});

await runAsync("concurrent first plans: exactly one active plan wins", async () => {
  const line = { ruPlanVersion: 0, ruActivePlanBatchId: null };
  const rus = [];
  const results = await Promise.allSettled([
    (async () => {
      await new Promise((r) => setImmediate(r));
      return applyMemoryRuPlan({
        line,
        rus,
        distribution: [25, 25],
        batchId: "batch-a",
        expectedVersion: 0,
      });
    })(),
    (async () => {
      await new Promise((r) => setImmediate(r));
      return applyMemoryRuPlan({
        line,
        rus,
        distribution: [50],
        batchId: "batch-b",
        expectedVersion: 0,
      });
    })(),
  ]);
  const ok = results.filter((r) => r.status === "fulfilled");
  const bad = results.filter((r) => r.status === "rejected");
  assert.equal(ok.length, 1, "exactly one plan must succeed");
  assert.equal(bad.length, 1);
  assert.equal(bad[0].reason.code, "RU_PLAN_CONFLICT");
  const activeQty = sumActivePlannedQty(rus, line.ruActivePlanBatchId);
  assert.equal(activeQty, 50);
  assert.ok(activeQty <= 50);
  assert.notEqual(activeQty, 100);
  const currentIds = new Set(
    rus.filter((ru) => isCurrentPlanRu(ru, line.ruActivePlanBatchId)).map((ru) => ru.planBatchId)
  );
  assert.equal(currentIds.size, 1);
});

await runAsync("concurrent replace-plan: exactly one current revision", async () => {
  const batch0 = "batch-0";
  const line = { ruPlanVersion: 1, ruActivePlanBatchId: batch0 };
  const rus = [
    { status: "PLANNED", plannedQty: 25, planBatchId: batch0, ruNo: "RU-A", barcodeValue: "RU-A" },
    { status: "PLANNED", plannedQty: 25, planBatchId: batch0, ruNo: "RU-B", barcodeValue: "RU-B" },
  ];
  const results = await Promise.allSettled([
    (async () => {
      await new Promise((r) => setImmediate(r));
      return applyMemoryRuPlan({
        line,
        rus,
        distribution: [20, 20, 10],
        replacePrinted: true,
        batchId: "batch-a",
        expectedVersion: 1,
      });
    })(),
    (async () => {
      await new Promise((r) => setImmediate(r));
      return applyMemoryRuPlan({
        line,
        rus,
        distribution: [50],
        replacePrinted: true,
        batchId: "batch-b",
        expectedVersion: 1,
      });
    })(),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(results.filter((r) => r.status === "rejected").length, 1);
  const current = rus.filter((ru) => isCurrentPlanRu(ru, line.ruActivePlanBatchId));
  const currentBatches = new Set(current.map((ru) => String(ru.planBatchId)));
  assert.equal(currentBatches.size, 1);
  assert.equal(sumActivePlannedQty(rus, line.ruActivePlanBatchId), 50);
  assert.equal(line.ruPlanVersion, 2);
});

run("current plan identity is the ASN line pointer, not createdAt", () => {
  const current = "batch-new";
  const rus = [
    { status: "PLANNED", plannedQty: 25, planBatchId: "batch-old", createdAt: "2026-08-19T10:00:00Z" },
    { status: "PLANNED", plannedQty: 50, planBatchId: current, createdAt: "2026-08-19T09:00:00Z" },
  ];
  const active = rus.filter((ru) => isCurrentPlanRu(ru, current));
  assert.equal(active.length, 1);
  assert.equal(active[0].plannedQty, 50);
  const claim = tryClaimRuPlanVersion({ ruPlanVersion: 3, ruActivePlanBatchId: current }, 3, "batch-next");
  assert.equal(claim.ok, true);
  const lost = tryClaimRuPlanVersion({ ruPlanVersion: 4, ruActivePlanBatchId: "batch-next" }, 3, "batch-late");
  assert.equal(lost.ok, false);
});

run("printed replacement marks old barcode SUPERSEDED, not current", () => {
  const line = { ruPlanVersion: 1, ruActivePlanBatchId: "b1" };
  const rus = [
    {
      status: "PRINTED",
      plannedQty: 50,
      planBatchId: "b1",
      ruNo: "MAR-RU-000125",
      barcodeValue: "MAR-RU-000125",
    },
  ];
  applyMemoryRuPlan({
    line,
    rus,
    distribution: [25, 25],
    replacePrinted: true,
    batchId: "b2",
    expectedVersion: 1,
  });
  const old = rus.find((ru) => ru.ruNo === "MAR-RU-000125");
  assert.equal(old.status, "SUPERSEDED");
  assert.equal(isCurrentPlanRu(old, line.ruActivePlanBatchId), false);
  const current = rus.filter((ru) => isCurrentPlanRu(ru, line.ruActivePlanBatchId));
  assert.equal(current.length, 2);
  assert.equal(current.every((ru) => ru.status === "PLANNED"), true);
});

run("ASN cancel is blocked by PRINTED RUs; planned RUs must be cancelled first", () => {
  const ctrl = fs.readFileSync(path.join(srcRoot, "controllers", "asnController.js"), "utf8");
  const svc = fs.readFileSync(path.join(srcRoot, "services", "receivingUnitService.js"), "utf8");
  const asnSvc = fs.readFileSync(path.join(srcRoot, "services", "asnService.js"), "utf8");
  assert.match(ctrl, /cancelAsn/);
  assert.match(ctrl, /from \"\.\.\/services\/receivingUnitService\.js\"/);
  assert.doesNotMatch(ctrl, /prepareAsnCancelReceivingUnits/);
  assert.match(svc, /export async function cancelAsn/);
  assert.match(svc, /RU_PRINTED_BLOCKS_ASN_CANCEL/);
  assert.match(svc, /ASN cancelled — unprinted Receiving Units cancelled/);
  assert.match(svc, /guard: \"ASN_CANCEL_POLICY\"/);
  assert.match(asnSvc, /ASN_CANCEL_GUARD_REQUIRED/);
  assert.match(asnSvc, /opts.guard !== \"ASN_CANCEL_POLICY\"/);
  assert.doesNotMatch(asnSvc, /ReceivingUnit/);
});

run("SHIPPED/ARRIVED ASN line qty is frozen; DRAFT cannot have RUs", () => {
  assert.throws(() => assertAsnEditable("SHIPPED", { lines: true }), (err) => err.code === "ASN_LINES_FROZEN");
  assert.throws(() => assertAsnEditable("ARRIVED", { lines: true }), (err) => err.code === "ASN_LINES_FROZEN");
  assert.equal(assertAsnEditable("DRAFT", { lines: true }), true);
  assert.throws(() => assertAsnEligibleForRuPlan("DRAFT"), ReceivingUnitError);
});

run("print enqueue is server-authoritative from persisted RU", () => {
  const persisted = {
    _id: "ru1",
    ruNo: "MAR-RU-000125",
    plannedQty: 25,
    article: "20834",
    asnNo: "MAR-ASN-0045",
    description: "O-Ring",
    uom: "PCS",
  };
  const clientTamper = { barcodeValue: "HACKED", plannedQty: 99, ruNo: "MAR-RU-999999" };
  const line = buildAsnRuJobLine(persisted, { asnNo: "MAR-ASN-0045" });
  assert.equal(line.barcodeValue, "MAR-RU-000125");
  assert.equal(line.qty, 25);
  assert.equal(line.ruNo, "MAR-RU-000125");
  assert.notEqual(line.barcodeValue, clientTamper.barcodeValue);
  const asnLabel = fs.readFileSync(path.join(srcRoot, "services", "label", "asnLabelService.js"), "utf8");
  assert.match(asnLabel, /loadPersistedRusForPrint/);
  assert.doesNotMatch(asnLabel, /body\.barcodeValue/);
  assert.doesNotMatch(asnLabel, /body\.plannedQty/);
});

run("duplicate COMPLETED print does not overwrite first print telemetry", () => {
  const ru = { status: "PLANNED", labelPrintedAt: null, labelPrintedBy: "", lastLabelJobId: null };
  const firstAt = new Date("2026-08-18T10:00:00Z");
  applySuccessfulPrintToRu(ru, { jobId: "job-1", printedAt: firstAt, printedBy: "Store A" });
  assert.equal(ru.status, "PRINTED");
  applySuccessfulPrintToRu(ru, { jobId: "job-2", printedAt: new Date("2026-08-18T11:00:00Z"), printedBy: "Store B" });
  assert.equal(ru.status, "PRINTED");
  assert.equal(String(ru.labelPrintedAt), String(firstAt));
  assert.equal(ru.labelPrintedBy, "Store A");
  assert.equal(ru.lastLabelJobId, "job-2");
  const dead = { status: "SUPERSEDED", labelPrintedAt: firstAt, labelPrintedBy: "Store A" };
  applySuccessfulPrintToRu(dead, { jobId: "job-3", printedAt: new Date(), printedBy: "X" });
  assert.equal(dead.status, "SUPERSEDED");
  assert.equal(dead.labelPrintedBy, "Store A");
  assert.equal(dead.staleLabelJobId, "job-3");
});

run("reprint keeps the same RU identity", () => {
  const ru = { _id: "ru1", ruNo: "MAR-RU-000125", plannedQty: 25, article: "20834", status: "PRINTED", asnNo: "MAR-ASN-0045" };
  const original = { ruNo: ru.ruNo, barcode: "MAR-RU-000125", plannedQty: ru.plannedQty };
  const reprintLine = buildAsnRuJobLine(ru, { asnNo: "MAR-ASN-0045" });
  assert.equal(reprintLine.receivingUnitId, "ru1");
  assert.equal(reprintLine.ruNo, original.ruNo);
  assert.equal(reprintLine.barcodeValue, original.barcode);
  assert.equal(reprintLine.qty, original.plannedQty);
  const asnLabel = fs.readFileSync(path.join(srcRoot, "services", "label", "asnLabelService.js"), "utf8");
  assert.match(asnLabel, /isReprint: true/);
  assert.match(asnLabel, /parentJobId/);
  assert.match(asnLabel, /RU_SUPERSEDED/);
  assert.doesNotMatch(asnLabel, /nextRuNo/);
  const ruSvc = fs.readFileSync(path.join(srcRoot, "services", "receivingUnitService.js"), "utf8");
  assert.doesNotMatch(ruSvc, /asnActiveQty/);
});

run("retry vs reprint vs uncertain stay on the same RU", () => {
  const labelSvc = fs.readFileSync(path.join(srcRoot, "services", "label", "labelService.js"), "utf8");
  assert.match(labelSvc, /export async function retryJob/);
  assert.match(labelSvc, /LABEL_UNCERTAIN_CONFIRM_REQUIRED/);
  assert.match(labelSvc, /companyId: req.companyId/);
  assert.match(labelSvc, /assertAsnViewForAsnLabelJob/);
  assert.match(labelSvc, /if \(!isAsnLabelJob\(parent\) && Array.isArray\(body.lines\)/);
});

run("TSPL ASN face fits long article/part/description and never prints GRN:", () => {
  const longArticle = "ART-VERY-LONG-CODE-12345678901234567890";
  const longPart = "PN-ABCDEFGHIJKLMNOPQRSTUVWXYZ-1234567890 / SPN-LONG";
  const longDesc = "Hydraulic damper assembly with extra long warehouse description text that must wrap";
  const wrapped = wrapDescription(longDesc);
  assert.ok(wrapped.length <= 2);
  const tspl = buildSingleLabelTspl(
    {
      article: longArticle,
      partNo: longPart,
      description: longDesc,
      ruNo: "MAR-RU-000125",
      labelId: "MAR-RU-000125",
      barcodeValue: "MAR-RU-000125",
      asnNo: "MAR-ASN-0045",
      uom: "PCS",
    },
    { ...asnLabelTsplOpts({ companyName: "MARIVOLT FZE" }), qtyPerLabel: 25 }
  );
  assert.match(tspl, /SIZE 100 mm,50 mm/);
  assert.match(tspl, /ASN: MAR-ASN-0045/);
  assert.match(tspl, /RU: MAR-RU-000125/);
  assert.match(tspl, /BARCODE .*"MAR-RU-000125"/);
  assert.match(tspl, /Qty: 25 PCS/);
  assert.doesNotMatch(tspl, /GRN:/);
  assert.match(tspl, /ART-VERY-LONG-CODE-123456789012/);
  assert.ok(!tspl.includes(longArticle), "article is fitted to label width");
});

run("cross-company Phase 2 actions are company-scoped", () => {
  const ruSvc = fs.readFileSync(path.join(srcRoot, "services", "receivingUnitService.js"), "utf8");
  assert.match(ruSvc, /ReceivingUnit.findOne\(\{ companyId, barcodeValue: value \}\)/);
  assert.match(ruSvc, /ReceivingUnit.findOne\(\{ _id: id, companyId \}\)/);
  assert.match(ruSvc, /AdvanceShipmentNotice.findOne\(\{ _id: id, companyId \}\)/);
  const asnLabel = fs.readFileSync(path.join(srcRoot, "services", "label", "asnLabelService.js"), "utf8");
  assert.match(asnLabel, /loadAsnForCompany\(req.companyId/);
  assert.match(asnLabel, /getReceivingUnitById\(req.companyId, ruId\)/);
  const labelSvc = fs.readFileSync(path.join(srcRoot, "services", "label", "labelService.js"), "utf8");
  assert.match(labelSvc, /LabelPrintJob.findOne\(\{ _id: jobId, companyId: req.companyId \}\)/);
});

run("barcode lookup contract distinguishes active vs superseded", () => {
  const current = "batch-2";
  const old = { status: "SUPERSEDED", planBatchId: "batch-1", barcodeValue: "MAR-RU-000125" };
  const neu = { status: "PLANNED", planBatchId: current, ruNo: "MAR-RU-000200" };
  assert.equal(isCurrentPlanRu(old, current), false);
  assert.equal(isCurrentPlanRu(neu, current), true);
  const ruRoutes = fs.readFileSync(path.join(srcRoot, "routes", "receivingUnitRoutes.js"), "utf8");
  assert.match(ruRoutes, /active:false/);
  const svc = fs.readFileSync(path.join(srcRoot, "services", "receivingUnitService.js"), "utf8");
  assert.match(svc, /replacementRuNos/);
  assert.match(svc, /extras.current === true/);
});

run("planner surfaces concurrent plan conflict", () => {
  const planner = fs.readFileSync(path.join(feRoot, "components", "store", "AsnReceivingLabelPlanner.jsx"), "utf8");
  assert.match(planner, /RU_PLAN_CONFLICT/);
  assert.match(planner, /RU_PRINT_IN_PROGRESS/);
  assert.match(planner, /RU_PRINT_UNCERTAIN/);
});

run("Phase 3 scan contract remains company + barcode → current RU", () => {
  const model = fs.readFileSync(path.join(srcRoot, "models", "ReceivingUnit.js"), "utf8");
  assert.match(model, /company \+ barcodeValue/);
  assert.doesNotMatch(model, /actualQty:/);
  assert.doesNotMatch(model, /photos:/);
  assert.match(model, /separate collection keyed by receivingUnitId/);
});

run("failure after plan claim rolls back to the previous current plan", () => {
  const line = { ruPlanVersion: 1, ruActivePlanBatchId: "b1", asnQty: 50 };
  const rus = [
    { status: "PLANNED", plannedQty: 50, planBatchId: "b1", ruNo: "MAR-RU-000100", barcodeValue: "MAR-RU-000100" },
  ];
  const result = applyTransactionalRuPlan({
    line,
    rus,
    distribution: [25, 25],
    batchId: "b2",
    expectedVersion: 1,
    failAfter: "claim",
  });
  assert.equal(result.rolledBack, true);
  assert.equal(line.ruActivePlanBatchId, "b1");
  assert.equal(line.ruPlanVersion, 1);
  assert.equal(isCurrentPlanRu(rus[0], line.ruActivePlanBatchId), true);
  assert.equal(sumActivePlannedQty(rus, line.ruActivePlanBatchId), 50);
  assert.equal(assertCompletedPlanQtyInvariant(line, rus), true);
  const svc = fs.readFileSync(path.join(srcRoot, "services", "receivingUnitService.js"), "utf8");
  assert.match(svc, /session.withTransaction/);
  assert.match(svc, /insertMany/);
  assert.match(svc, /persistReplacementPlanReplicaSet/);
  assert.match(svc, /persistReplacementPlanStandalone/);
});

run("standalone mint-then-publish never makes a partial batch current", () => {
  const line = { ruPlanVersion: 1, ruActivePlanBatchId: "b1", asnQty: 50 };
  const rus = [
    { status: "PRINTED", plannedQty: 50, planBatchId: "b1", ruNo: "MAR-RU-000100", barcodeValue: "MAR-RU-000100" },
  ];
  const result = applyMintThenPublishRuPlan({
    line,
    rus,
    distribution: [25, 25],
    replacePrinted: true,
    batchId: "b2",
    expectedVersion: 1,
    failAfter: "before-publish",
  });
  assert.equal(result.published, false);
  assert.equal(line.ruActivePlanBatchId, "b1");
  assert.equal(isCurrentPlanRu(rus[0], line.ruActivePlanBatchId), true);
  const incomplete = rus.filter((ru) => String(ru.planBatchId) === "b2");
  assert.ok(incomplete.length > 0);
  assert.equal(incomplete.every((ru) => isCurrentPlanRu(ru, line.ruActivePlanBatchId) === false), true);
  assert.equal(sumActivePlannedQty(rus, line.ruActivePlanBatchId), 50);
});

run("replan is blocked while print is PENDING/LEASED/PRINTING or UNCERTAIN", () => {
  const line = { ruPlanVersion: 1, ruActivePlanBatchId: "b1", asnQty: 50 };
  const rus = [
    { status: "PLANNED", plannedQty: 50, planBatchId: "b1", ruNo: "MAR-RU-000100", barcodeValue: "MAR-RU-000100" },
  ];
  for (const status of ["PENDING", "LEASED", "PRINTING"]) {
    assert.throws(
      () =>
        applyMemoryRuPlan({
          line,
          rus,
          distribution: [25, 25],
          batchId: "b2",
          expectedVersion: 1,
          inflightJobs: [{ status }],
        }),
      (err) => err.code === "RU_PRINT_IN_PROGRESS"
    );
  }
  assert.throws(
    () =>
      applyMemoryRuPlan({
        line,
        rus,
        distribution: [25, 25],
        batchId: "b2",
        expectedVersion: 1,
        inflightJobs: [{ status: "UNCERTAIN" }],
      }),
    (err) => err.code === "RU_PRINT_UNCERTAIN"
  );
  assert.equal(assertReplanAllowedForPrintJobs([{ status: "FAILED" }]), true);
  assert.equal(line.ruActivePlanBatchId, "b1");
});

run("print completion during ASN cancel cannot leave PRINTED + CANCELLED ASN", () => {
  const planned = [{ status: "PLANNED", planBatchId: "b1", plannedQty: 50 }];
  const printFirst = [...planned];
  applySuccessfulPrintToRu(printFirst[0], { jobId: "job-1", printedAt: new Date(), printedBy: "A", current: true });
  assert.equal(printFirst[0].status, "PRINTED");
  const cancelBlocked = printFirst.some((ru) => ru.status === "PRINTED");
  assert.equal(cancelBlocked, true);

  const cancelFirst = [{ status: "PLANNED", planBatchId: "b1", plannedQty: 50 }];
  cancelFirst[0].status = "CANCELLED";
  applySuccessfulPrintToRu(cancelFirst[0], { jobId: "job-1", printedAt: new Date(), printedBy: "A", current: false });
  assert.equal(cancelFirst[0].status, "CANCELLED");
  assert.equal(cancelFirst[0].staleLabelJobId, "job-1");
});

run("stale COMPLETED after supersede does not reactivate the old RU", () => {
  const ru = {
    status: "SUPERSEDED",
    planBatchId: "b1",
    barcodeValue: "MAR-RU-000125",
    labelPrintedAt: new Date("2026-08-18T10:00:00Z"),
    labelPrintedBy: "Store A",
  };
  applySuccessfulPrintToRu(ru, { jobId: "late-job", printedAt: new Date(), printedBy: "Agent", current: false });
  assert.equal(ru.status, "SUPERSEDED");
  assert.equal(isCurrentPlanRu(ru, "b2"), false);
  assert.equal(ru.staleLabelJobId, "late-job");
  const svc = fs.readFileSync(path.join(srcRoot, "services", "receivingUnitService.js"), "utf8");
  assert.match(svc, /staleLabelJobId/);
  assert.match(svc, /isCurrentPlanRu\(ru, currentBatchId\)/);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
