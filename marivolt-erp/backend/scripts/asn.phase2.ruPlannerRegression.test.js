/**
 * ASN RU planner regression: status authority, planning rows, first-print vs reprint.
 * Run: node scripts/asn.phase2.ruPlannerRegression.test.js
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildRuFirstPrintRequestBody,
  buildRuReprintRequestBody,
  canPrintSavedRuPlan,
  defaultLinePlan,
  extractReceivingUnitsListing,
  isAsnEligibleForRuPlan,
  isReceivableAsnPlanningLine,
  isReceivingUnitsListingAuthoritative,
  isRuFirstPrintMode,
  isRuReprintMode,
  isUntouchedFirstPreparationAsn,
  isValidReceivingUnitPlan,
  mapAsnLineToPlanningRow,
  normalizeAsnLifecycleStatus,
  resolveAsnStatusForRuPlan,
  resolveRuPlanningLines,
  RU_PLAN_ELIGIBLE_ASN_STATUSES,
  RU_PLAN_LISTING_LOAD_ERROR,
  shouldShowRuListingLoadError,
} from "../../src/lib/receivingUnitLabels.js";
import { REPRINT_REASONS } from "../../src/lib/labelPrinting.js";
import { RU_PLAN_ELIGIBLE_ASN_STATUSES as BACKEND_ELIGIBLE } from "../src/utils/receivingUnitRules.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const feRoot = path.join(__dirname, "..", "..", "src");
const planner = fs.readFileSync(path.join(feRoot, "components", "store", "AsnReceivingLabelPlanner.jsx"), "utf8");
const panel = fs.readFileSync(path.join(feRoot, "components", "store", "IncomingShipmentsPanel.jsx"), "utf8");

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

const marAsn0009 = {
  _id: "6a9573251250989c1676265e",
  asnNo: "MAR-ASN-0009",
  status: "ARRIVED",
  receivingCompleteness: { complete: true, summary: "ASN is complete for receiving.", missing: [] },
  lines: [
    { _id: "6a9573251250989c1676265f", article: "911268022", asnQty: 4, uom: "PCS", remainingAvailableQty: 0 },
    { _id: "6a9573251250989c16762660", article: "911438822", asnQty: 1, uom: "PCS", remainingAvailableQty: 0 },
    { _id: "6a9573251250989c16762661", article: "911313222", asnQty: 2, uom: "PCS", remainingAvailableQty: 0 },
  ],
};

console.log("\nASN RU planner regression\n");

run("1. ARRIVED detail renders RU planning rows", () => {
  const rows = resolveRuPlanningLines({ detail: { ...marAsn0009, status: "ARRIVED" } });
  assert.equal(rows.length, 3);
  assert.equal(isAsnEligibleForRuPlan("ARRIVED"), true);
});

run("2. SHIPPED detail renders RU planning rows", () => {
  const rows = resolveRuPlanningLines({ detail: { ...marAsn0009, status: "SHIPPED" } });
  assert.equal(rows.length, 3);
  assert.equal(isAsnEligibleForRuPlan("SHIPPED"), true);
});

run("3. ineligible status blocks rows in the planner", () => {
  for (const status of ["DRAFT", "CANCELLED", "COMPLETED", "PARTIALLY_RECEIVED"]) {
    assert.equal(isAsnEligibleForRuPlan(status), false);
  }
  assert.match(planner, /eligible && !listingBlocked/);
  assert.match(planner, /Labels can be prepared only when the ASN is Shipped or Arrived/);
});

run("4. fetched detail ARRIVED overrides stale/undefined list-row status", () => {
  assert.equal(
    resolveAsnStatusForRuPlan({
      detail: { status: "ARRIVED" },
      listing: { eligible: false },
      listRow: { status: undefined },
    }),
    "ARRIVED"
  );
  assert.equal(
    resolveAsnStatusForRuPlan({
      detail: { status: "ARRIVED" },
      listRow: {},
    }),
    "ARRIVED"
  );
  assert.equal(isAsnEligibleForRuPlan(resolveAsnStatusForRuPlan({ detail: { status: "ARRIVED" }, listRow: {} })), true);
  assert.match(planner, /resolveAsnStatusForRuPlan\(\{ detail: asn, listing \}\)/);
  assert.match(panel, /asn=\{detail\}/);
  assert.match(panel, /isAsnEligibleForRuPlan\(detail\?\.status\)/);
});

run("5. lowercase/uppercase status normalization", () => {
  assert.equal(normalizeAsnLifecycleStatus("arrived"), "ARRIVED");
  assert.equal(normalizeAsnLifecycleStatus("  shipped "), "SHIPPED");
  assert.equal(isAsnEligibleForRuPlan("arrived"), true);
  assert.equal(isAsnEligibleForRuPlan("Shipped"), true);
  assert.deepEqual([...RU_PLAN_ELIGIBLE_ASN_STATUSES], [...BACKEND_ELIGIBLE]);
});

run("6. correct response-wrapper extraction", () => {
  const inner = { eligible: true, status: "ARRIVED", asnNo: "MAR-ASN-0009", lines: marAsn0009.lines };
  assert.equal(extractReceivingUnitsListing({ data: inner }).asnNo, "MAR-ASN-0009");
  assert.equal(extractReceivingUnitsListing({ listing: inner }).eligible, true);
  assert.equal(extractReceivingUnitsListing(inner).status, "ARRIVED");
  const wrappedRows = resolveRuPlanningLines({ listing: { data: { lines: marAsn0009.lines } }, detail: marAsn0009 });
  assert.equal(wrappedRows.length, 3);
});

run("7. one planning row per receivable line", () => {
  const rows = resolveRuPlanningLines({ listing: undefined, detail: marAsn0009 });
  assert.equal(rows.length, 3);
  assert.deepEqual(
    rows.map((r) => r.article),
    ["911268022", "911438822", "911313222"]
  );
});

run("8. stable line IDs", () => {
  const rows = resolveRuPlanningLines({ detail: marAsn0009 });
  assert.deepEqual(
    rows.map((r) => String(r.asnLineId)),
    ["6a9573251250989c1676265f", "6a9573251250989c16762660", "6a9573251250989c16762661"]
  );
  assert.equal(isReceivableAsnPlanningLine({ remainingAvailableQty: 0, asnQty: 4, _id: "x" }), true);
  assert.equal(isReceivableAsnPlanningLine({ remainingAvailableQty: 0, asnQty: 0, _id: "x" }), false);
});

run("9. valid plan enables Save Receiving Units", () => {
  const rows = resolveRuPlanningLines({ detail: marAsn0009 });
  const plans = Object.fromEntries(rows.map((line) => [String(line.asnLineId), defaultLinePlan(line)]));
  assert.equal(isValidReceivingUnitPlan(rows, plans), true);
  assert.equal(isValidReceivingUnitPlan([], plans), false);
  assert.match(planner, /Save Receiving Units/);
  assert.match(planner, /disabled=\{!canSavePlan\}/);
});

run("10. opening modal performs no write", () => {
  assert.match(planner, /apiGet\(`\/asn\/\$\{asnId\}\/receiving-units`\)/);
  assert.match(planner, /enabled: Boolean\(open && asnId\)/);
  assert.doesNotMatch(planner, /useEffect/);
  assert.doesNotMatch(planner, /receiving-units\/plan`, body\)[\s\S]*enabled: Boolean\(open/);
});

run("11. first preparation has no reprint-reason control", () => {
  assert.equal(isRuReprintMode({ lines: marAsn0009.lines, receivingUnits: [] }), false);
  assert.match(planner, /showReprintReason = Boolean\(canReprint && reprintMode && !listingBlocked\)/);
  assert.match(planner, /\{showReprintReason \?/);
});

run("12. Damaged Label absent on first print", () => {
  assert.equal(REPRINT_REASONS[0], "Damaged Label");
  assert.match(planner, /useState\(""\)/);
  assert.doesNotMatch(planner, /useState\(REPRINT_REASONS\[0\]\)/);
  assert.match(planner, /Select reprint reason/);
  assert.equal(isRuReprintMode(undefined), false);
});

run("13. first-print payload omits reprintReason", () => {
  const body = buildRuFirstPrintRequestBody({ printerCode: "RONGTA1" });
  assert.equal(Object.prototype.hasOwnProperty.call(body, "reprintReason"), false);
  assert.equal(body.printerCode, "RONGTA1");
  assert.deepEqual(buildRuFirstPrintRequestBody({}), {});
  assert.match(planner, /buildRuFirstPrintRequestBody\(\{ printerCode \}\)/);
  assert.match(planner, /receiving-units\/print/);
});

run("14. existing printed RU switches to true reprint mode", () => {
  const listing = {
    receivingUnits: [
      { _id: "ru1", ruNo: "MAR-RU-000001", barcodeValue: "MAR-RU-000001", status: "PRINTED" },
    ],
  };
  assert.equal(isRuReprintMode(listing), true);
});

run("15. true reprint requires and sends reason", () => {
  const missing = buildRuReprintRequestBody({ reason: "" });
  assert.equal(missing.ok, false);
  const ok = buildRuReprintRequestBody({ reason: "Damaged Label", printerCode: "RONGTA1" });
  assert.equal(ok.ok, true);
  assert.equal(ok.body.reason, "Damaged Label");
  assert.match(planner, /receiving-units\/\$\{ruId\}\/reprint/);
  assert.match(planner, /receiving-units\/reprint-all/);
});

run("16. reprint preserves RU identity/barcode", () => {
  assert.match(planner, /Reprint all \$\{printed\} active RU labels/);
  assert.match(planner, /same RU numbers again/);
  const listing = {
    lines: [
      {
        asnLineId: "L1",
        asnQty: 4,
        receivingUnits: [{ _id: "ru1", ruNo: "MAR-RU-000125", barcodeValue: "MAR-RU-000125", status: "PRINTED", plannedQty: 4 }],
      },
    ],
  };
  const rows = resolveRuPlanningLines({ listing });
  assert.equal(rows[0].receivingUnits[0].ruNo, "MAR-RU-000125");
  assert.equal(rows[0].receivingUnits[0].barcodeValue, "MAR-RU-000125");
});

run("17. no prior RU/job for MAR-ASN-0009 is treated as first print", () => {
  const listing = {
    asnId: marAsn0009._id,
    status: "ARRIVED",
    eligible: true,
    lines: marAsn0009.lines,
    receivingUnits: [],
  };
  assert.equal(isRuReprintMode(listing), false);
  assert.equal(isRuFirstPrintMode(listing), true);
  const rows = resolveRuPlanningLines({ listing, detail: marAsn0009 });
  assert.equal(rows.length, 3);
  assert.equal(canPrintSavedRuPlan(rows.flatMap((l) => l.receivingUnits || [])), false);
});

run("18. print button disabled until plan is saved", () => {
  assert.equal(canPrintSavedRuPlan([]), false);
  assert.equal(canPrintSavedRuPlan([{ status: "PLANNED" }]), true);
  assert.equal(canPrintSavedRuPlan([{ status: "PRINTED" }]), false);
  assert.match(planner, /disabled=\{!canPrintPlan \|\| listingBlocked\}/);
  assert.match(planner, /Save Receiving Units before printing labels/);
});

run("19. existing Phase 1/2/3, GRN, RBAC and multi-company contracts stay in source", () => {
  assert.match(planner, /RU_PLAN_CONFLICT/);
  assert.match(planner, /RU_PRINT_IN_PROGRESS/);
  assert.match(planner, /RU_RECEIVING_STARTED/);
  assert.match(panel, /can\("ASN", "view"\)/);
  assert.match(panel, /can\("LABELS", "print"\)/);
  assert.match(panel, /can\("LABELS", "reprint"\)/);
  assert.match(panel, /Generate Draft GRN/);
});

run("20. tablet viewport renders rows and action buttons without hiding them", () => {
  assert.match(planner, /min-h-12/);
  assert.match(planner, /min-h-14/);
  assert.match(planner, /inputMode="numeric"/);
  assert.doesNotMatch(planner, /sm:hidden/);
  assert.doesNotMatch(planner, /md:hidden/);
  assert.doesNotMatch(planner, /hidden md:/);
  assert.doesNotMatch(planner, /onMouseEnter/);
  assert.match(panel, /min-h-14 w-full/);
});

run("empty listing is authoritative; remainingAvailableQty is not the receivable filter", () => {
  const emptyListing = { asnId: marAsn0009._id, status: "ARRIVED", eligible: true, lines: [], receivingUnits: [] };
  const fromEmptyListing = resolveRuPlanningLines({ listing: emptyListing, detail: marAsn0009 });
  assert.equal(fromEmptyListing.length, 0);
  assert.equal(isReceivingUnitsListingAuthoritative(emptyListing), true);
  const fallback = resolveRuPlanningLines({ listing: undefined, detail: marAsn0009 });
  assert.equal(fallback.length, 3);
  assert.equal(mapAsnLineToPlanningRow(marAsn0009.lines[0]).remainingQty, 4);
  assert.equal(mapAsnLineToPlanningRow(marAsn0009.lines[0]).asnQty, 4);
  assert.equal(isUntouchedFirstPreparationAsn(marAsn0009), true);
});

run("first-print steps are visible in the modal", () => {
  assert.match(
    planner,
    /Prepare Receiving Units → Save Receiving Units → Preview → Print RU Labels/
  );
});

function failedListingArgs(detail, context) {
  return {
    listing: undefined,
    detail,
    context,
    listingFailed: true,
  };
}

function withFirstLine(patch) {
  return {
    ...marAsn0009,
    lines: marAsn0009.lines.map((line, idx) => (idx === 0 ? { ...line, ...patch } : { ...line })),
  };
}

run("S1. untouched ARRIVED ASN + failed/missing RU listing → safe detail fallback rows", () => {
  const rows = resolveRuPlanningLines({ listing: undefined, detail: marAsn0009 });
  assert.equal(rows.length, 3);
  assert.equal(shouldShowRuListingLoadError(failedListingArgs(marAsn0009)), false);
  assert.equal(isValidReceivingUnitPlan(rows, Object.fromEntries(rows.map((l) => [String(l.asnLineId), defaultLinePlan(l)]))), true);
});

run("S2. untouched SHIPPED ASN → safe fallback", () => {
  const shipped = { ...marAsn0009, status: "SHIPPED" };
  assert.equal(isUntouchedFirstPreparationAsn(shipped), true);
  assert.equal(resolveRuPlanningLines({ listing: undefined, detail: shipped }).length, 3);
});

run("S3. ruPlanVersion > 0 + failed listing → no fallback", () => {
  const detail = withFirstLine({ ruPlanVersion: 1 });
  assert.equal(isUntouchedFirstPreparationAsn(detail), false);
  assert.equal(resolveRuPlanningLines({ listing: undefined, detail }).length, 0);
  assert.equal(shouldShowRuListingLoadError(failedListingArgs(detail)), true);
});

run("S4. existing plan batch/reference + failed listing → no fallback", () => {
  const detail = withFirstLine({ ruActivePlanBatchId: "6a9573251250989c167626aa" });
  assert.equal(resolveRuPlanningLines({ listing: undefined, detail }).length, 0);
  assert.equal(shouldShowRuListingLoadError(failedListingArgs(detail)), true);
});

run("S5. existing RU indication + failed listing → no fallback", () => {
  const detail = { ...marAsn0009, receivingUnits: [{ _id: "ru1", ruNo: "MAR-RU-000001", status: "PLANNED" }] };
  assert.equal(resolveRuPlanningLines({ listing: undefined, detail }).length, 0);
  const viaContext = resolveRuPlanningLines({
    listing: undefined,
    detail: marAsn0009,
    context: { receivingUnits: [{ _id: "ru1", status: "PRINTED" }] },
  });
  assert.equal(viaContext.length, 0);
});

run("S6. inspection/receiving progress + failed listing → no fallback", () => {
  const viaSession = resolveRuPlanningLines({
    listing: undefined,
    detail: marAsn0009,
    context: { session: { _id: "sess1", status: "IN_PROGRESS" } },
  });
  assert.equal(viaSession.length, 0);
  const viaProgress = resolveRuPlanningLines({
    listing: undefined,
    detail: marAsn0009,
    context: { progress: { ruTotal: 3, ruCompleted: 1 } },
  });
  assert.equal(viaProgress.length, 0);
  assert.equal(
    shouldShowRuListingLoadError(failedListingArgs(marAsn0009, { session: { _id: "sess1", status: "DRAFT" } })),
    true
  );
});

run("S7. draft GRN + failed listing → no fallback", () => {
  const rows = resolveRuPlanningLines({
    listing: undefined,
    detail: marAsn0009,
    context: { draftGrn: { grnNo: "MAR-GRN-0099", status: "DRAFT" } },
  });
  assert.equal(rows.length, 0);
});

run("S8. posted GRN + failed listing → no fallback", () => {
  const rows = resolveRuPlanningLines({
    listing: undefined,
    detail: marAsn0009,
    context: { postedGrn: { grnNo: "MAR-GRN-0100", status: "RECEIVED" } },
  });
  assert.equal(rows.length, 0);
});

run("S9. any received/inspected/disposition qty + failed listing → no fallback", () => {
  const accepted = resolveRuPlanningLines({
    listing: undefined,
    detail: withFirstLine({ acceptedQty: 2 }),
  });
  assert.equal(accepted.length, 0);
  const inspected = resolveRuPlanningLines({
    listing: undefined,
    detail: marAsn0009,
    context: { progress: { countedQty: 4 } },
  });
  assert.equal(inspected.length, 0);
});

run("S10. failed listing never enables Save/Preview/Print for established ASN", () => {
  const detail = withFirstLine({ ruPlanVersion: 2, ruActivePlanBatchId: "batch-9" });
  const rows = resolveRuPlanningLines({ listing: undefined, detail });
  assert.equal(rows.length, 0);
  assert.equal(isValidReceivingUnitPlan(rows, {}), false);
  assert.equal(canPrintSavedRuPlan(rows.flatMap((l) => l.receivingUnits || [])), false);
  assert.equal(shouldShowRuListingLoadError(failedListingArgs(detail)), true);
  assert.match(planner, /RU_PLAN_LISTING_LOAD_ERROR/);
  assert.match(planner, /listingBlocked/);
  assert.match(planner, /disabled=\{!canSavePlan\}/);
  assert.match(planner, /disabled=\{!canPrintPlan \|\| listingBlocked\}/);
});

run("S11. successful listing is authoritative", () => {
  const listing = {
    asnId: marAsn0009._id,
    status: "ARRIVED",
    eligible: true,
    lines: [
      {
        asnLineId: "6a9573251250989c1676265f",
        article: "911268022",
        asnQty: 4,
        uom: "PCS",
        receivingUnits: [{ _id: "ru1", ruNo: "MAR-RU-000010", barcodeValue: "MAR-RU-000010", status: "PLANNED", plannedQty: 4 }],
      },
    ],
    receivingUnits: [{ _id: "ru1", ruNo: "MAR-RU-000010", barcodeValue: "MAR-RU-000010", status: "PLANNED" }],
  };
  const rows = resolveRuPlanningLines({ listing, detail: marAsn0009 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].receivingUnits[0].ruNo, "MAR-RU-000010");
  assert.equal(isReceivingUnitsListingAuthoritative(listing), true);
  assert.equal(shouldShowRuListingLoadError({ listing, detail: marAsn0009, listingFailed: false }), false);
});

run("S12. missing listing does not falsely select first-print mode for established ASN", () => {
  const established = withFirstLine({ ruPlanVersion: 1 });
  assert.equal(isRuFirstPrintMode(undefined), false);
  assert.equal(isRuFirstPrintMode(null), false);
  assert.equal(isRuReprintMode(undefined), false);
  assert.equal(isUntouchedFirstPreparationAsn(established), false);
  assert.match(planner, /isRuReprintMode\(listing\)/);
});

run("S13. MAR-ASN-0009 still renders exactly three first-preparation rows", () => {
  const rows = resolveRuPlanningLines({ listing: undefined, detail: marAsn0009 });
  assert.equal(rows.length, 3);
  assert.deepEqual(
    rows.map((r) => String(r.asnLineId)),
    ["6a9573251250989c1676265f", "6a9573251250989c16762660", "6a9573251250989c16762661"]
  );
  assert.equal(RU_PLAN_LISTING_LOAD_ERROR, "Receiving Unit plan could not be loaded. Refresh and try again.");
});

run("S14. first print still hides Damaged Label", () => {
  assert.equal(isRuFirstPrintMode({ lines: marAsn0009.lines, receivingUnits: [] }), true);
  assert.equal(REPRINT_REASONS[0], "Damaged Label");
  assert.doesNotMatch(planner, /useState\(REPRINT_REASONS\[0\]\)/);
  assert.match(planner, /\{showReprintReason \?/);
});

run("S15. true reprint behavior remains unchanged", () => {
  const listing = {
    lines: [
      {
        asnLineId: "L1",
        asnQty: 4,
        receivingUnits: [{ _id: "ru1", ruNo: "MAR-RU-000125", barcodeValue: "MAR-RU-000125", status: "PRINTED", plannedQty: 4 }],
      },
    ],
  };
  assert.equal(isRuReprintMode(listing), true);
  assert.equal(isRuFirstPrintMode(listing), false);
  const ok = buildRuReprintRequestBody({ reason: "Damaged Label" });
  assert.equal(ok.ok, true);
  assert.equal(ok.body.reason, "Damaged Label");
  assert.match(planner, /receiving-units\/\$\{ruId\}\/reprint/);
  assert.match(planner, /receiving-units\/reprint-all/);
});

run("opening/retrying the modal remains GET-only", () => {
  assert.match(planner, /apiGet\(`\/asn\/\$\{asnId\}\/receiving-units`\)/);
  assert.match(planner, /enabled: Boolean\(open && asnId\)/);
  assert.doesNotMatch(planner, /remainingAvailableQty/);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
