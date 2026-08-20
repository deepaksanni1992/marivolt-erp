/**
 * Manual Confirm qty for UNCERTAIN ASN RU first-print jobs (MAR-ASN-0003 pattern).
 * Run: node scripts/labelConfirmUncertain.test.js
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  formatUncertainConfirmSuccessMessage,
  planManualPrintedQtyConfirmation,
} from "../src/utils/labelConfirmRules.js";
import { isSuccessfulLabelJobStatus } from "../src/utils/grnLabelDistribution.js";
import { evaluateReceivingScanEligibility } from "../src/utils/receivingInspectionRules.js";
import { getDefaultPermissionsForRole } from "../src/services/roleService.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.join(__dirname, "..");
const repoRoot = path.join(backendRoot, "..");
const srcRoot = path.join(backendRoot, "src");

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

console.log("\nLabel Confirm qty / UNCERTAIN ASN RU\n");

function simulateConfirmJob(job, qty, { autoRetryRemaining = false } = {}) {
  const planned = planManualPrintedQtyConfirmation({
    status: job.status,
    printedLabels: job.printedLabels,
    remainingLabels: job.remainingLabels,
    requestedLabels: job.requestedLabels,
    confirmedQty: qty,
    allowedStatuses: job.status === "UNCERTAIN" ? ["UNCERTAIN"] : undefined,
  });
  if (!planned.ok) return { ok: false, planned, job, rawWrites: 0 };
  const next = {
    ...job,
    printedLabels: planned.nextPrintedLabels,
    remainingLabels: planned.nextRemainingLabels,
    status: planned.nextStatus,
    lastError: planned.clearLastError ? "" : job.lastError,
  };
  let rawWrites = 0;
  if (autoRetryRemaining && next.remainingLabels > 0) {
    rawWrites = 1;
    next.status = "PENDING";
  }
  const ruPrinted =
    isSuccessfulLabelJobStatus(next.status) && Number(next.remainingLabels) === 0
      ? "PRINTED"
      : "PLANNED";
  return { ok: true, planned, job: next, rawWrites, ruStatus: ruPrinted };
}

run("MAR-ASN-0003 pattern: 4 COMPLETED + 4 UNCERTAIN → confirm qty=1 each → 8/8 PRINTED", () => {
  const jobs = [];
  const rus = [];
  for (let i = 1; i <= 8; i += 1) {
    const ruNo = `MAR-RU-${String(i).padStart(6, "0")}`;
    rus.push({ ruNo, barcodeValue: ruNo, status: "PLANNED", plannedQty: 1 });
    jobs.push({
      jobNo: `LJ-${i}`,
      sourceType: "ASN",
      status: i <= 4 ? "COMPLETED" : "UNCERTAIN",
      requestedLabels: 1,
      printedLabels: i <= 4 ? 1 : 0,
      remainingLabels: i <= 4 ? 0 : 1,
      lastError: i <= 4 ? "" : "Windows spool did not drain before timeout",
      lines: [{ ruNo, receivingUnitId: `id-${i}`, labelQty: 1 }],
      copies: 1,
    });
  }
  for (let i = 0; i < 4; i += 1) rus[i].status = "PRINTED";

  let rawWrites = 0;
  for (let i = 4; i < 8; i += 1) {
    const r = simulateConfirmJob(jobs[i], 1, { autoRetryRemaining: false });
    assert.equal(r.ok, true);
    assert.equal(r.job.status, "COMPLETED");
    assert.equal(r.job.printedLabels, 1);
    assert.equal(r.job.remainingLabels, 0);
    assert.equal(r.job.lastError, "");
    assert.equal(r.ruStatus, "PRINTED");
    assert.equal(r.rawWrites, 0);
    jobs[i] = r.job;
    rus[i].status = r.ruStatus;
    rawWrites += r.rawWrites;
  }

  assert.equal(jobs.filter((j) => j.status === "COMPLETED").length, 8);
  assert.equal(rus.filter((r) => r.status === "PRINTED").length, 8);
  assert.equal(rawWrites, 0);
  assert.deepEqual(
    rus.map((r) => r.ruNo),
    [
      "MAR-RU-000001",
      "MAR-RU-000002",
      "MAR-RU-000003",
      "MAR-RU-000004",
      "MAR-RU-000005",
      "MAR-RU-000006",
      "MAR-RU-000007",
      "MAR-RU-000008",
    ]
  );
  for (const ru of rus) {
    const scan = evaluateReceivingScanEligibility(ru, { current: true });
    assert.equal(scan.canReceive, true, ru.ruNo);
  }
});

run("confirm qty 0 on UNCERTAIN → PARTIAL, no RAW reprint when autoRetry off", () => {
  const r = simulateConfirmJob(
    {
      status: "UNCERTAIN",
      printedLabels: 0,
      remainingLabels: 1,
      requestedLabels: 1,
      lastError: "drain timeout",
    },
    0,
    { autoRetryRemaining: false }
  );
  assert.equal(r.ok, true);
  assert.equal(r.job.status, "PARTIAL");
  assert.equal(r.job.printedLabels, 0);
  assert.equal(r.job.remainingLabels, 1);
  assert.equal(r.rawWrites, 0);
  assert.equal(r.ruStatus, "PLANNED");
});

run("confirm qty > remaining is rejected", () => {
  const planned = planManualPrintedQtyConfirmation({
    status: "UNCERTAIN",
    printedLabels: 0,
    remainingLabels: 1,
    requestedLabels: 1,
    confirmedQty: 2,
    allowedStatuses: ["UNCERTAIN"],
  });
  assert.equal(planned.ok, false);
  assert.equal(planned.code, "LABEL_CONFIRM_EXCEEDS_REMAINING");
});

run("confirm COMPLETED / PENDING / FAILED as resolve-uncertain is rejected", () => {
  for (const status of ["COMPLETED", "PENDING", "FAILED"]) {
    const planned = planManualPrintedQtyConfirmation({
      status,
      printedLabels: status === "COMPLETED" ? 1 : 0,
      remainingLabels: status === "COMPLETED" ? 0 : 1,
      requestedLabels: 1,
      confirmedQty: 1,
      allowedStatuses: ["UNCERTAIN"],
    });
    assert.equal(planned.ok, false, status);
    assert.equal(planned.code, "LABEL_CONFIRM_STATUS");
  }
});

run("double confirm of same UNCERTAIN job: second CAS loses", () => {
  const first = planManualPrintedQtyConfirmation({
    status: "UNCERTAIN",
    printedLabels: 0,
    remainingLabels: 1,
    requestedLabels: 1,
    confirmedQty: 1,
    allowedStatuses: ["UNCERTAIN"],
  });
  assert.equal(first.ok, true);
  assert.equal(first.nextStatus, "COMPLETED");
  const second = planManualPrintedQtyConfirmation({
    status: "COMPLETED",
    printedLabels: 1,
    remainingLabels: 0,
    requestedLabels: 1,
    confirmedQty: 1,
    allowedStatuses: ["UNCERTAIN"],
  });
  assert.equal(second.ok, false);
  assert.equal(second.code, "LABEL_CONFIRM_STATUS");
});

run("success message names the RU", () => {
  assert.equal(
    formatUncertainConfirmSuccessMessage({
      confirmedQty: 1,
      ruNos: ["MAR-RU-000012"],
      jobStatus: "COMPLETED",
    }),
    "1 physical label confirmed. RU MAR-RU-000012 is now PRINTED."
  );
});

run("source: resolveUncertain does not auto-retry / RAW reprint", () => {
  const svc = fs.readFileSync(path.join(srcRoot, "services", "label", "labelService.js"), "utf8");
  const block = svc.slice(svc.indexOf("export async function resolveUncertain"));
  assert.match(block, /autoRetryRemaining: false/);
  assert.match(block, /requireStatuses: \["UNCERTAIN"\]/);
  assert.match(svc, /LABEL_CONFIRM_CONFLICT/);
  assert.match(svc, /clearLastError|lastError: ""/);
  assert.match(svc, /assertAsnViewForAsnLabelJob/);
  assert.match(svc, /applyReceivingUnitPrintResult/);
});

run("source: Confirm qty UI shows errors inline and disables while pending", () => {
  const panel = fs.readFileSync(path.join(repoRoot, "src", "components", "store", "LabelQueuePanel.jsx"), "utf8");
  assert.match(panel, /resolve-uncertain/);
  assert.match(panel, /confirm-partial/);
  assert.match(panel, /confirmMut\.isPending/);
  assert.match(panel, /label-confirm-qty-error/);
  assert.match(panel, /label-confirm-qty-success/);
  assert.match(panel, /asn-receiving-units/);
  assert.match(panel, /does not send another print/);
});

run("routes: resolve-uncertain requires LABELS.print", () => {
  const routes = fs.readFileSync(path.join(srcRoot, "routes", "labelRoutes.js"), "utf8");
  assert.match(routes, /jobs\/:id\/resolve-uncertain", labelsPrint/);
  assert.match(routes, /jobs\/:id\/confirm-partial", labelsPrint/);
  const m = getDefaultPermissionsForRole("store_operator");
  assert.ok(m.LABELS.includes("print"));
  assert.ok(m.LABELS.includes("view"));
  assert.deepEqual(m.ASN, ["view"]);
});

run("confirm does not mutate RU identity fields in applyReceivingUnitPrintResult", () => {
  const ru = fs.readFileSync(path.join(srcRoot, "services", "receivingUnitService.js"), "utf8");
  const start = ru.indexOf("export async function applyReceivingUnitPrintResult");
  const end = ru.indexOf("export function previewPayloadFromReceivingUnits");
  const fn = ru.slice(start, end);
  assert.match(fn, /status: "PRINTED"/);
  assert.doesNotMatch(fn, /\$set:[\s\S]*ruNo:/);
  assert.doesNotMatch(fn, /\$set:[\s\S]*barcodeValue:/);
  assert.doesNotMatch(fn, /\$set:[\s\S]*plannedQty:/);
  assert.doesNotMatch(fn, /ruPlanVersion/);
});

run("print-agent 1.4.0 READY gate unchanged by confirm workflow", () => {
  const agent = fs.readFileSync(path.join(repoRoot, "print-agent", "src", "index.js"), "utf8");
  assert.match(agent, /APP_VERSION = "1.4.0"/);
  const safety = fs.readFileSync(path.join(repoRoot, "print-agent", "src", "printSafety.js"), "utf8");
  assert.match(safety, /Windows spool did not drain before timeout/);
  assert.match(safety, /Printer left READY after spool submit/);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
