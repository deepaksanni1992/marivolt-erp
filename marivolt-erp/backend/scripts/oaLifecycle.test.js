/**
 * Unit tests for OA lifecycle / multi partial PI progress.
 * Run: node backend/scripts/oaLifecycle.test.js
 */
import assert from "node:assert/strict";
import {
  buildOaPiProgressSummary,
  buildOaCommercialRevision,
  isOaEditLockedByLifecycle,
  recalculatePiAdvancePercentage,
  resolveOaProgressStatus,
  suggestOaStatusAfterPiIssuance,
} from "../src/utils/oaLifecycle.js";

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    return true;
  } catch (e) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${e.message}`);
    return false;
  }
}

let passed = 0;
let failed = 0;
function run(name, fn) {
  if (test(name, fn)) passed += 1;
  else failed += 1;
}

console.log("\nOA Lifecycle\n");

run("ACTIVE with no PIs", () => {
  assert.equal(resolveOaProgressStatus({ status: "ACTIVE" }, { activePiCount: 0 }), "ACTIVE");
  assert.equal(isOaEditLockedByLifecycle({ status: "ACTIVE" }, { activePiCount: 0 }), false);
});

run("PARTIALLY_PI_ISSUED does not lock edit", () => {
  const oa = { status: "APPROVED", convertedTo: ["PROFORMA"], grandTotal: 1000 };
  const ctx = { activePiCount: 1, piIssuedRequestedTotal: 300, piRemainingEligibleAmount: 700 };
  assert.equal(resolveOaProgressStatus(oa, ctx), "PARTIALLY_PI_ISSUED");
  assert.equal(isOaEditLockedByLifecycle(oa, ctx), false);
  assert.equal(suggestOaStatusAfterPiIssuance(ctx), "PARTIALLY_PI_ISSUED");
});

run("FULLY_PI_ISSUED does not lock edit", () => {
  const oa = { status: "ACTIVE", grandTotal: 1000 };
  const ctx = { activePiCount: 3, piIssuedRequestedTotal: 1000, piRemainingEligibleAmount: 0 };
  assert.equal(resolveOaProgressStatus(oa, ctx), "FULLY_PI_ISSUED");
  assert.equal(isOaEditLockedByLifecycle(oa, ctx), false);
  assert.equal(suggestOaStatusAfterPiIssuance(ctx), "FULLY_PI_ISSUED");
});

run("PACKING locks edit", () => {
  const oa = { status: "PACKING", convertedTo: ["PROFORMA", "ORDER_ALLOCATION"] };
  assert.equal(resolveOaProgressStatus(oa, {}), "PACKING");
  assert.equal(isOaEditLockedByLifecycle(oa, {}), true);
});

run("Historical CONVERTED maps to PACKING and locks", () => {
  const oa = { status: "CONVERTED", convertedTo: ["ORDER_ALLOCATION"] };
  assert.equal(resolveOaProgressStatus(oa, {}), "PACKING");
  assert.equal(isOaEditLockedByLifecycle(oa, {}), true);
});

run("COMPLETED / SI locks", () => {
  const oa = { status: "ACTIVE", convertedTo: ["SALES_INVOICE"] };
  assert.equal(resolveOaProgressStatus(oa, { hasSalesInvoice: true }), "COMPLETED");
  assert.equal(isOaEditLockedByLifecycle(oa, { hasSalesInvoice: true }), true);
});

run("Progress summary fields", () => {
  const summary = buildOaPiProgressSummary(
    { grandTotal: 1120000, status: "ACTIVE" },
    { piIssuedRequestedTotal: 336000, piRemainingEligibleAmount: 784000, activePiCount: 1 }
  );
  assert.equal(summary.progressStatus, "PARTIALLY_PI_ISSUED");
  assert.equal(summary.commercialTotal, 1120000);
  assert.equal(summary.piIssuedRequestedTotal, 336000);
  assert.equal(summary.piRemainingEligibleAmount, 784000);
  assert.equal(summary.piProgressPercent, 30);
  assert.equal(summary.isEditLocked, false);
  assert.equal(summary.canCreateAdditionalProforma, true);
});

run("Commercial revision requires reason and respects floor", () => {
  assert.throws(
    () =>
      buildOaCommercialRevision({
        previousCommercial: 1000,
        revisedCommercial: 1200,
        issuedRequestedTotal: 300,
        reason: "",
      }),
    /Revision reason/
  );
  assert.throws(
    () =>
      buildOaCommercialRevision({
        previousCommercial: 1000,
        revisedCommercial: 200,
        issuedRequestedTotal: 300,
        reason: "Cut price",
      }),
    /below PI amount/
  );
  const rev = buildOaCommercialRevision({
    previousCommercial: 1120000,
    revisedCommercial: 1200000,
    issuedRequestedTotal: 336000,
    existingRevisions: [],
    reason: "Customer approved price increase",
    revisedBy: "ops@marivolt.com",
  });
  assert.equal(rev.revisionNumber, 1);
  assert.equal(rev.originalCommercialValue, 1120000);
  assert.equal(rev.revisedCommercialValue, 1200000);
  assert.equal(rev.difference, 80000);
  assert.equal(recalculatePiAdvancePercentage(336000, 1200000), 28);
  assert.equal(recalculatePiAdvancePercentage(336000, 1120000), 30);
});

run("Cancel restores capacity suggestion to ACTIVE", () => {
  assert.equal(suggestOaStatusAfterPiIssuance({ activePiCount: 0, piRemainingEligibleAmount: 1000 }), "ACTIVE");
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
