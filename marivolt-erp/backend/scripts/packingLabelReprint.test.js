/**
 * Packing Builder reprint UX + hardened POST /labels/jobs/:id/reprint.
 * Run: node scripts/packingLabelReprint.test.js
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  parentReprintRejection,
  buildReprintIdempotencyKey,
  packingPhysicalLabelCount,
  canCopyFrozenPackingFaces,
  cloneFrozenFacePayloads,
  choosePackingReprintPrinter,
  packingReprintShownPrinterConflict,
  packingReprintPrinterCompanyError,
  packingReprintPrinterWarehouseError,
  isOriginalPackingPrinterEligible,
  serializePackingReprintTarget,
} from "../src/services/label/labelReprint.js";
import {
  queryLabelJobsScoped,
  buildLabelPrintJobListFilter,
} from "../src/services/label/labelJobListQuery.js";
import {
  PACKING_LABEL_ALREADY_PRINTED_TOAST,
  PACKING_REPRINT_REASONS,
  buildDefaultPackingToolbarFingerprint,
  buildPackingSelectionFingerprint,
  defaultPackingLabelRows,
  formatPackingReprintReason,
  packingLabelActionEnabled,
  pickRelevantPackingLabelJob,
  resolvePackingLabelQueueMessage,
  resolvePackingLabelToolbarState,
  selectAvailablePackingLabelRows,
} from "../../src/lib/labelPrinting.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.join(__dirname, "..");
const srcRoot = path.join(backendRoot, "src");
const frontendRoot = path.join(backendRoot, "..", "src");

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

console.log("\nPacking label reprint\n");

const ALLOC_ID = "6a8c9abec598d831c78443f6";
const ALLOC_NO = "ALLOC/260824.01";
const PARENT_ID = "6a8c9de1c598d831c7844b30";

const sampleLines = [
  { allocationLineId: "6a8c9abec598d831c78443f7", allocatedQty: 6, physicalPackableQty: 6, packQty: 0 },
  { allocationLineId: "6a8c9abec598d831c78443f8", allocatedQty: 12, physicalPackableQty: 12, packQty: 0 },
  { allocationLineId: "6a8c9abec598d831c78443f9", allocatedQty: 12, physicalPackableQty: 12, packQty: 0 },
  { allocationLineId: "6a8c9abec598d831c78443fa", allocatedQty: 2, physicalPackableQty: 2, packQty: 0 },
  { allocationLineId: "6a8c9abec598d831c78443fb", allocatedQty: 4, physicalPackableQty: 4, packQty: 0 },
  { allocationLineId: "6a8c9abec598d831c78443fc", allocatedQty: 200, physicalPackableQty: 200, packQty: 0 },
];

const fingerprint = buildDefaultPackingToolbarFingerprint(sampleLines, "PRE_PACKING");

function firstPrintJob(overrides = {}) {
  return {
    _id: PARENT_ID,
    jobNo: "LBL202608241939BF5A",
    sourceType: "PACKING",
    sourceNo: ALLOC_NO,
    packingMode: "PRE_PACKING",
    allocationId: ALLOC_ID,
    packingId: null,
    isReprint: false,
    parentJobId: null,
    status: "COMPLETED",
    requestedLabels: 6,
    packingSelectionFingerprint: fingerprint,
    createdAt: "2026-08-24T19:39:13.466Z",
    updatedAt: "2026-08-24T19:48:59.040Z",
    createdByName: "operations@marivolt.co",
    windowsPrinterName: "RP4xx Series 200DPI TSPL (Copy 1)",
    payloadMode: "TSPL_LABEL_BATCH",
    rawFacePayloads: ["SIZE A", "SIZE B", "SIZE C", "SIZE D", "SIZE E", "SIZE F"],
    lines: sampleLines.map((ln) => ({
      allocationLineId: ln.allocationLineId,
      labelQty: ln.physicalPackableQty,
      lineCopies: 1,
    })),
    ...overrides,
  };
}

function simulateReprint(state, { parent, userId, clientRequestId, reason, liveLines }) {
  const rejection = parentReprintRejection(parent.status);
  if (!rejection.ok) {
    const err = new Error(rejection.message);
    err.code = rejection.code;
    err.statusCode = rejection.statusCode;
    throw err;
  }
  const key = buildReprintIdempotencyKey({
    parentJobId: parent._id,
    userId,
    clientRequestId,
  });
  if (key && state.byKey.has(key)) {
    return { created: false, reused: true, job: state.byKey.get(key) };
  }
  const requestedLabels = packingPhysicalLabelCount(parent, parent.lines, 1);
  const usedLive = Array.isArray(liveLines) && liveLines.length > 0;
  const faces = canCopyFrozenPackingFaces(parent, requestedLabels)
    ? cloneFrozenFacePayloads(parent)
    : ["REGENERATED_FROM_PARENT_LINES"];
  const job = {
    _id: `reprint-${state.seq++}`,
    jobNo: `LBL-REPRINT-${state.seq}`,
    sourceType: parent.sourceType,
    sourceNo: parent.sourceNo,
    packingMode: "REPRINT",
    allocationId: parent.allocationId,
    isReprint: true,
    parentJobId: parent._id,
    reprintReason: reason,
    status: "PENDING",
    requestedLabels,
    rawFacePayloads: faces,
    packingSelectionFingerprint: parent.packingSelectionFingerprint,
    idempotencyKey: key || null,
    usedLiveAllocation: usedLive,
    createdAt: new Date().toISOString(),
  };
  state.all.push(job);
  if (key) state.byKey.set(key, job);
  return { created: true, reused: false, job };
}

const reprintSvc = fs.readFileSync(path.join(srcRoot, "services", "label", "labelReprint.js"), "utf8");
const labelSvc = fs.readFileSync(path.join(srcRoot, "services", "label", "labelService.js"), "utf8");
const routes = fs.readFileSync(path.join(srcRoot, "routes", "labelRoutes.js"), "utf8");
const ctrl = fs.readFileSync(path.join(srcRoot, "controllers", "labelController.js"), "utf8");
const storeUi = fs.readFileSync(path.join(frontendRoot, "pages", "StoreModule.jsx"), "utf8");
const modalUi = fs.readFileSync(path.join(frontendRoot, "components", "store", "PackingLabelsModal.jsx"), "utf8");
const reprintUi = fs.readFileSync(
  path.join(frontendRoot, "components", "store", "PackingLabelReprintModal.jsx"),
  "utf8"
);
const listQuerySrc = fs.readFileSync(
  path.join(srcRoot, "services", "label", "labelJobListQuery.js"),
  "utf8"
);
const jobModelSrc = fs.readFileSync(path.join(srcRoot, "models", "LabelPrintJob.js"), "utf8");
const customModalUi = fs.readFileSync(
  path.join(frontendRoot, "components", "store", "CustomPackingLabelModal.jsx"),
  "utf8"
);

run("1. No prior job → Print", () => {
  const ui = resolvePackingLabelToolbarState(
    pickRelevantPackingLabelJob([], {
      packingMode: "PRE_PACKING",
      allocationId: ALLOC_ID,
      sourceNo: ALLOC_NO,
      fingerprint,
    })
  );
  assert.equal(ui.action, "print");
  assert.equal(ui.label, "Print Packing Labels");
  assert.equal(ui.disabled, false);
});

run("2. PENDING/LEASED/PRINTING → disabled Printing", () => {
  for (const status of ["PENDING", "LEASED", "PRINTING"]) {
    const ui = resolvePackingLabelToolbarState(firstPrintJob({ status }));
    assert.equal(ui.action, "printing", status);
    assert.equal(ui.label, "Printing…");
    assert.equal(ui.disabled, true);
  }
});

run("3. COMPLETED → Reprint", () => {
  const ui = resolvePackingLabelToolbarState(
    pickRelevantPackingLabelJob([firstPrintJob()], {
      packingMode: "PRE_PACKING",
      allocationId: ALLOC_ID,
      sourceNo: ALLOC_NO,
      fingerprint,
    })
  );
  assert.equal(ui.action, "reprint");
  assert.equal(ui.label, "Reprint Packing Labels");
  assert.equal(ui.job._id, PARENT_ID);
});

run("4. FAILED/CANCELLED → Print", () => {
  for (const status of ["FAILED", "CANCELLED"]) {
    const ui = resolvePackingLabelToolbarState(firstPrintJob({ status }));
    assert.equal(ui.action, "print", status);
    assert.equal(ui.label, "Print Packing Labels");
    assert.equal(ui.disabled, false);
  }
});

run("5. UNCERTAIN/PARTIAL → Resolve Print Status", () => {
  for (const status of ["UNCERTAIN", "PARTIAL"]) {
    const ui = resolvePackingLabelToolbarState(firstPrintJob({ status }));
    assert.equal(ui.action, "resolve", status);
    assert.equal(ui.label, "Resolve Print Status");
  }
});

run("6-7. Reprint creates a new linked job; original unchanged", () => {
  const parent = firstPrintJob();
  const parentSnapshot = JSON.parse(JSON.stringify(parent));
  const state = { byKey: new Map(), all: [parent], seq: 1 };
  const r = simulateReprint(state, {
    parent,
    userId: "user-1",
    clientRequestId: "req-a",
    reason: "Label damaged",
  });
  assert.equal(r.created, true);
  assert.notEqual(r.job._id, parent._id);
  assert.equal(r.job.parentJobId, parent._id);
  assert.equal(r.job.isReprint, true);
  assert.equal(r.job.packingMode, "REPRINT");
  assert.equal(parent.status, "COMPLETED");
  assert.equal(parent.isReprint, false);
  assert.deepEqual(parent, parentSnapshot);
});

run("8. Reprint copies frozen parent faces, not live allocation lines", () => {
  const parent = firstPrintJob();
  const liveLines = [{ allocationLineId: "live", labelQty: 999 }];
  const state = { byKey: new Map(), all: [parent], seq: 1 };
  const r = simulateReprint(state, {
    parent,
    userId: "user-1",
    clientRequestId: "req-frozen",
    reason: "Label lost",
    liveLines,
  });
  assert.deepEqual(r.job.rawFacePayloads, parent.rawFacePayloads);
  assert.equal(r.job.requestedLabels, 6);
  assert.equal(canCopyFrozenPackingFaces(parent, 6), true);
  assert.ok(labelSvc.includes("canCopyFrozenPackingFaces"));
  assert.ok(labelSvc.includes("isPackingSnapshot"));
  assert.match(labelSvc, /Packing reprints always use the frozen parent snapshot/);
});

run("9. Same clientRequestId returns the same reprint job", () => {
  const parent = firstPrintJob();
  const state = { byKey: new Map(), all: [parent], seq: 1 };
  const a = simulateReprint(state, {
    parent,
    userId: "user-1",
    clientRequestId: "same-click",
    reason: "Printer issue",
  });
  const b = simulateReprint(state, {
    parent,
    userId: "user-1",
    clientRequestId: "same-click",
    reason: "Printer issue",
  });
  assert.equal(a.job._id, b.job._id);
  assert.equal(b.reused, true);
  assert.equal(state.all.filter((j) => j.isReprint).length, 1);
});

run("10. New clientRequestId permits another intentional reprint", () => {
  const parent = firstPrintJob();
  const state = { byKey: new Map(), all: [parent], seq: 1 };
  const a = simulateReprint(state, {
    parent,
    userId: "user-1",
    clientRequestId: "first",
    reason: "Additional copy",
  });
  const b = simulateReprint(state, {
    parent,
    userId: "user-1",
    clientRequestId: "second",
    reason: "Additional copy",
  });
  assert.notEqual(a.job._id, b.job._id);
  assert.equal(state.all.filter((j) => j.isReprint).length, 2);
  assert.equal(a.job.parentJobId, PARENT_ID);
  assert.equal(b.job.parentJobId, PARENT_ID);
});

run("11. Non-COMPLETED parent cannot be reprinted", () => {
  for (const status of ["PENDING", "LEASED", "PRINTING", "FAILED", "CANCELLED", "UNCERTAIN", "PARTIAL"]) {
    const r = parentReprintRejection(status);
    assert.equal(r.ok, false, status);
    assert.equal(r.code, "LABEL_REPRINT_PARENT_NOT_COMPLETED");
    assert.equal(r.statusCode, 409);
    const parent = firstPrintJob({ status });
    const state = { byKey: new Map(), all: [parent], seq: 1 };
    assert.throws(
      () =>
        simulateReprint(state, {
          parent,
          userId: "user-1",
          clientRequestId: "x",
          reason: "Label damaged",
        }),
      /Cannot reprint/
    );
  }
  assert.equal(parentReprintRejection("COMPLETED").ok, true);
});

run("12. LABELS.reprint permission rejection is enforced on the route", () => {
  assert.match(routes, /router\.post\("\/jobs\/:id\/reprint", labelsReprint/);
  assert.ok(routes.includes('const labelsReprint = requirePermission("LABELS", "reprint")'));
  assert.ok(storeUi.includes('can("LABELS", "reprint")'));
  assert.ok(storeUi.includes('can("LABELS", "print")'));
  assert.ok(storeUi.includes('can("LABELS", "view")'));
  assert.equal(packingLabelActionEnabled("reprint", { canPrint: true, canReprint: false }), false);
  assert.equal(packingLabelActionEnabled("print", { canPrint: false, canReprint: true }), false);
  assert.equal(packingLabelActionEnabled("reprint", { canPrint: true, canReprint: true }), true);
});

run("13. Physical label count remains 6 (not 236 piece qty)", () => {
  const parent = firstPrintJob();
  assert.equal(packingPhysicalLabelCount(parent, parent.lines, 1), 6);
  const rows = selectAvailablePackingLabelRows(defaultPackingLabelRows(sampleLines, { mode: "PRE_PACKING" }), {
    mode: "PRE_PACKING",
  });
  assert.equal(rows.filter((r) => r.selected).length, 6);
  const ui = resolvePackingLabelToolbarState(parent);
  assert.equal(ui.job.requestedLabels, 6);
  const qtySum = sampleLines.reduce((s, ln) => s + ln.allocatedQty, 0);
  assert.equal(qtySum, 236);
  assert.notEqual(parent.requestedLabels, qtySum);
});

run("14. Reprint child does not replace original for toolbar state", () => {
  const original = firstPrintJob({ createdAt: "2026-08-24T19:39:13.466Z" });
  const child = {
    ...original,
    _id: "reprint-child",
    jobNo: "LBL-REPRINT-1",
    isReprint: true,
    parentJobId: PARENT_ID,
    packingMode: "REPRINT",
    status: "COMPLETED",
    createdAt: "2026-08-30T15:00:00.000Z",
  };
  const otherSelection = firstPrintJob({
    _id: "older-subset",
    packingSelectionFingerprint: "line:other:qty:1",
    createdAt: "2026-08-20T00:00:00.000Z",
    status: "COMPLETED",
  });
  const picked = pickRelevantPackingLabelJob([child, otherSelection, original], {
    packingMode: "PRE_PACKING",
    allocationId: ALLOC_ID,
    sourceNo: ALLOC_NO,
    fingerprint,
  });
  assert.equal(picked._id, PARENT_ID);
  assert.equal(picked.isReprint, false);
});

run("Toast: reused COMPLETED is not treated as a newly queued print", () => {
  const msg = resolvePackingLabelQueueMessage({
    created: false,
    reused: true,
    queueState: "COMPLETED",
    job: { status: "COMPLETED", requestedLabels: 6 },
  });
  assert.equal(msg.type, "warning");
  assert.equal(msg.message, PACKING_LABEL_ALREADY_PRINTED_TOAST);
  assert.match(msg.message, /Reprint Packing Labels below/);
  assert.doesNotMatch(msg.message, /queued successfully/);
});

run("Reprint reasons require remarks only for Other", () => {
  assert.deepEqual(PACKING_REPRINT_REASONS, [
    "Label damaged",
    "Label lost",
    "Printer issue",
    "Additional copy",
    "Other",
  ]);
  assert.equal(formatPackingReprintReason("Label damaged", "ignored"), "Label damaged");
  assert.equal(formatPackingReprintReason("Other", "torn in transit"), "Other: torn in transit");
});

run("Idempotency key is parent + user + clientRequestId (not timestamp-only)", () => {
  const a = buildReprintIdempotencyKey({
    parentJobId: PARENT_ID,
    userId: "user-1",
    clientRequestId: "abc",
  });
  const b = buildReprintIdempotencyKey({
    parentJobId: PARENT_ID,
    userId: "user-1",
    clientRequestId: "abc",
  });
  const c = buildReprintIdempotencyKey({
    parentJobId: PARENT_ID,
    userId: "user-1",
    clientRequestId: "def",
  });
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, new RegExp(`^reprint:${PARENT_ID}:user-1:abc$`));
  assert.equal(buildReprintIdempotencyKey({ parentJobId: PARENT_ID, userId: "u", clientRequestId: "" }), "");
});

run("GET /labels/jobs filters packing relevance without a new status endpoint", () => {
  assert.ok(ctrl.includes("buildLabelPrintJobListFilter"));
  assert.ok(listQuerySrc.includes("query.allocationId"));
  assert.ok(listQuerySrc.includes("query.packingId"));
  assert.ok(listQuerySrc.includes("query.packingMode"));
  assert.ok(listQuerySrc.includes("query.sourceType"));
  assert.ok(listQuerySrc.includes("isReprint"));
  assert.ok(storeUi.includes('packingMode: "PRE_PACKING"'));
  assert.ok(storeUi.includes("allocationId: packingFromAlloc.allocation._id"));
  assert.ok(storeUi.includes("isReprint: false"));
  assert.ok(!routes.includes("from-packing/print-status"));
});

run("1. packingId is applied in the backend filter before limit", () => {
  const filter = buildLabelPrintJobListFilter("co1", {
    sourceType: "PACKING",
    packingMode: "POSTED_PACKING",
    isReprint: "false",
    packingId: "aaaaaaaaaaaaaaaaaaaaaaaa",
    limit: 200,
  });
  assert.equal(String(filter.packingId), "aaaaaaaaaaaaaaaaaaaaaaaa");
  assert.equal(filter.packingMode, "POSTED_PACKING");
  const listFn = ctrl.slice(ctrl.indexOf("export async function listJobs"));
  assert.ok(listFn.indexOf("buildLabelPrintJobListFilter") < listFn.indexOf(".limit("));
  assert.ok(listFn.indexOf("LabelPrintJob.find(filter)") > listFn.indexOf("buildLabelPrintJobListFilter"));
  assert.ok(jobModelSrc.includes("packingId: 1, packingMode: 1, createdAt: -1"));
});

run("2. older posted packing beyond 200 company jobs is still found", () => {
  const companyId = "co1";
  const oldPackingId = "aaaaaaaaaaaaaaaaaaaaaaaa";
  const newPackingId = "bbbbbbbbbbbbbbbbbbbbbbbb";
  const jobs = [];
  for (let i = 0; i < 200; i += 1) {
    jobs.push({
      companyId,
      _id: `new-${i}`,
      sourceType: "PACKING",
      packingMode: "POSTED_PACKING",
      packingId: newPackingId,
      isReprint: false,
      parentJobId: null,
      createdAt: new Date(Date.now() - i * 1000).toISOString(),
    });
  }
  jobs.push({
    companyId,
    _id: "old-posted",
    sourceType: "PACKING",
    packingMode: "POSTED_PACKING",
    packingId: oldPackingId,
    isReprint: false,
    parentJobId: null,
    createdAt: "2020-01-01T00:00:00.000Z",
  });
  const unscoped = queryLabelJobsScoped(
    jobs,
    { sourceType: "PACKING", packingMode: "POSTED_PACKING", isReprint: "false", limit: 200 },
    companyId
  );
  assert.equal(unscoped.some((j) => j._id === "old-posted"), false);
  const scoped = queryLabelJobsScoped(
    jobs,
    {
      sourceType: "PACKING",
      packingMode: "POSTED_PACKING",
      packingId: oldPackingId,
      isReprint: "false",
      limit: 200,
    },
    companyId
  );
  assert.equal(scoped.length, 1);
  assert.equal(scoped[0]._id, "old-posted");
  assert.ok(storeUi.includes("packingId: p._id"));
  assert.ok(storeUi.includes("useQueries"));
  assert.doesNotMatch(
    storeUi,
    /packingMode: "POSTED_PACKING",\s*isReprint: false,\s*limit: 200/
  );
  const ui = resolvePackingLabelToolbarState(
    pickRelevantPackingLabelJob(scoped, {
      packingMode: "POSTED_PACKING",
      packingId: oldPackingId,
      fingerprint: "line:posted:qty:1",
    })
  );
  assert.equal(ui.action, "print");
  const completedOld = [{ ...scoped[0], packingSelectionFingerprint: "line:posted:qty:1", status: "COMPLETED" }];
  const reprintUiState = resolvePackingLabelToolbarState(
    pickRelevantPackingLabelJob(completedOld, {
      packingMode: "POSTED_PACKING",
      packingId: oldPackingId,
      fingerprint: "line:posted:qty:1",
    })
  );
  assert.equal(reprintUiState.action, "reprint");
  assert.equal(reprintUiState.label, "Reprint Packing Labels");
});

run("3. allocationId filtering is scoped to the allocation", () => {
  const companyId = "co1";
  const allocA = ALLOC_ID;
  const allocB = "6a8c9abec598d831c78443f0";
  const jobs = [
    firstPrintJob({ _id: "job-a", companyId: "co1", allocationId: allocA, packingMode: "PRE_PACKING" }),
    firstPrintJob({
      _id: "job-b",
      companyId: "co1",
      allocationId: allocB,
      sourceNo: "ALLOC/OTHER",
      packingMode: "PRE_PACKING",
      packingSelectionFingerprint: fingerprint,
    }),
  ];
  const scoped = queryLabelJobsScoped(
    jobs,
    {
      sourceType: "PACKING",
      packingMode: "PRE_PACKING",
      allocationId: allocA,
      isReprint: "false",
      limit: 50,
    },
    companyId
  );
  assert.equal(scoped.length, 1);
  assert.equal(scoped[0]._id, "job-a");
  assert.ok(storeUi.includes("allocationId: packingFromAlloc.allocation._id"));
  assert.ok(jobModelSrc.includes("allocationId: 1, packingMode: 1, createdAt: -1"));
});

run("4. reprint children cannot become the toolbar parent", () => {
  const original = firstPrintJob({ companyId: "co1", createdAt: "2026-08-24T19:39:13.466Z" });
  const child = {
    ...original,
    _id: "reprint-child-list",
    jobNo: "LBL-REPRINT-LIST",
    isReprint: true,
    parentJobId: PARENT_ID,
    packingMode: "REPRINT",
    status: "COMPLETED",
    createdAt: "2026-08-30T16:00:00.000Z",
  };
  const listed = queryLabelJobsScoped(
    [child, original],
    {
      sourceType: "PACKING",
      packingMode: "PRE_PACKING",
      allocationId: ALLOC_ID,
      isReprint: "false",
      limit: 50,
    },
    "co1"
  );
  assert.equal(listed.length, 1);
  assert.equal(listed[0]._id, PARENT_ID);
  const picked = pickRelevantPackingLabelJob([child, original], {
    packingMode: "PRE_PACKING",
    allocationId: ALLOC_ID,
    sourceNo: ALLOC_NO,
    fingerprint,
  });
  assert.equal(picked._id, PARENT_ID);
  assert.equal(picked.isReprint, false);
});

run("5. active original printer is displayed and used", () => {
  const original = {
    _id: "prn-orig",
    companyId: "co1",
    code: "WH1",
    windowsPrinterName: "Zebra-A",
    warehouseCode: "MAIN",
    isActive: true,
  };
  const chosen = choosePackingReprintPrinter({
    originalEligible: true,
    originalPrinter: original,
    replacementPrinter: { _id: "prn-other", windowsPrinterName: "Zebra-B" },
  });
  assert.equal(chosen.printer._id, "prn-orig");
  assert.equal(chosen.originalUnavailable, false);
  const shown = serializePackingReprintTarget(chosen.printer, {
    originalUnavailable: false,
    originalWindowsPrinterName: "Zebra-A",
  });
  assert.equal(shown.windowsPrinterName, "Zebra-A");
  assert.equal(shown.printerConfigId, "prn-orig");
  assert.equal(shown.warning, "");
  assert.equal(isOriginalPackingPrinterEligible({
    printer: original,
    agent: { isActive: true },
    companyId: "co1",
    parentWarehouse: "MAIN",
  }), true);
  assert.ok(reprintUi.includes("target?.windowsPrinterName"));
  assert.ok(reprintUi.includes("expectedPrinterConfigId: target.printerConfigId"));
});

run("6. inactive original printer shows the resolved replacement", () => {
  const replacement = {
    _id: "prn-repl",
    companyId: "co1",
    code: "WH2",
    windowsPrinterName: "Zebra-B",
    warehouseCode: "MAIN",
    isActive: true,
  };
  const chosen = choosePackingReprintPrinter({
    originalEligible: false,
    originalPrinter: { _id: "prn-orig", isActive: false, windowsPrinterName: "Zebra-A" },
    replacementPrinter: replacement,
  });
  assert.equal(chosen.printer._id, "prn-repl");
  assert.equal(chosen.originalUnavailable, true);
  const shown = serializePackingReprintTarget(chosen.printer, {
    originalUnavailable: true,
    originalWindowsPrinterName: "Zebra-A",
  });
  assert.equal(
    shown.warning,
    "The original printer is unavailable. This reprint will be sent to Zebra-B."
  );
  assert.ok(reprintUi.includes("target?.warning"));
  assert.ok(reprintUi.includes("reprint-target"));
});

run("7. replacement unavailable before submit → conflict, no job created", () => {
  assert.equal(packingReprintShownPrinterConflict("prn-repl", "prn-repl"), false);
  assert.equal(packingReprintShownPrinterConflict("prn-repl", "prn-other"), true);
  assert.equal(packingReprintShownPrinterConflict("", "prn-other"), false);
  const reprintFn = labelSvc.slice(labelSvc.indexOf("export async function reprintJob"));
  const conflictAt = reprintFn.indexOf("LABEL_REPRINT_PRINTER_CHANGED");
  const createAt = reprintFn.indexOf("LabelPrintJob.create");
  assert.ok(conflictAt > 0 && createAt > conflictAt);
  assert.ok(reprintUi.includes("LABEL_REPRINT_PRINTER_CHANGED"));
  assert.ok(reprintUi.includes("targetQ.refetch()"));
});

run("8. another company's printer is rejected", () => {
  const err = packingReprintPrinterCompanyError(
    { _id: "prn-x", companyId: "other-co", code: "WH1", isActive: true },
    "co1"
  );
  assert.equal(err.code, "LABEL_REPRINT_PRINTER_NOT_FOUND");
  assert.equal(err.statusCode, 400);
  assert.equal(packingReprintPrinterCompanyError(null, "co1").code, "LABEL_REPRINT_PRINTER_NOT_FOUND");
  assert.equal(
    isOriginalPackingPrinterEligible({
      printer: { companyId: "other-co", isActive: true, windowsPrinterName: "Z" },
      agent: { isActive: true },
      companyId: "co1",
      parentWarehouse: "MAIN",
    }),
    false
  );
  assert.ok(labelSvc.includes("packingReprintPrinterCompanyError"));
});

run("9. invalid warehouse printer is rejected for PACKING reprint", () => {
  const printer = { warehouseCode: "OTHER", companyId: "co1", isActive: true, windowsPrinterName: "Z" };
  const err = packingReprintPrinterWarehouseError(printer, "MAIN");
  assert.equal(err.code, "LABEL_REPRINT_PRINTER_WAREHOUSE");
  assert.equal(err.statusCode, 400);
  assert.equal(packingReprintPrinterWarehouseError({ warehouseCode: "MAIN" }, "MAIN"), null);
  assert.equal(packingReprintPrinterWarehouseError({ warehouseCode: "" }, "MAIN"), null);
  assert.equal(
    isOriginalPackingPrinterEligible({
      printer,
      agent: { isActive: true },
      companyId: "co1",
      parentWarehouse: "MAIN",
    }),
    false
  );
  assert.ok(labelSvc.includes('upper(parent.sourceType) === "PACKING"'));
  assert.ok(labelSvc.includes("LABEL_REPRINT_PRINTER_WAREHOUSE") || reprintSvc.includes("LABEL_REPRINT_PRINTER_WAREHOUSE"));
});

run("10. Custom Packing existing reprint behavior remains compatible", () => {
  assert.ok(labelSvc.includes("} else if (t(body.printerCode))"));
  assert.ok(customModalUi.includes("printerCode: selectedPrinter || undefined"));
  assert.doesNotMatch(customModalUi, /expectedPrinterConfigId/);
  const reprintFn = labelSvc.slice(labelSvc.indexOf("export async function reprintJob"));
  assert.ok(reprintFn.includes("CUSTOM_PACKING"));
  assert.ok(reprintFn.includes("resolvePrinterForJob(req.companyId, body.printerCode"));
});

run("11. reprint modal resets via unmount and has no set-state-in-effect", () => {
  assert.ok(!reprintUi.includes("useEffect"));
  assert.ok(!reprintUi.includes("eslint-disable"));
  assert.ok(reprintUi.includes("function PackingLabelReprintForm"));
  assert.ok(reprintUi.includes("if (!open || !job) return null"));
  assert.ok(reprintUi.includes("clientRequestIdRef"));
  assert.ok(!reprintUi.includes("printerCode:"));
});

run("Packing Builder UI wires reprint confirmation; does not use modal REPRINT mode", () => {
  const helpers = fs.readFileSync(path.join(frontendRoot, "lib", "labelPrinting.js"), "utf8");
  assert.ok(storeUi.includes("PackingLabelReprintModal"));
  assert.ok(storeUi.includes("PackingLabelsToolbarButton"));
  assert.ok(storeUi.includes("onRequestReprint"));
  assert.ok(helpers.includes("Reprint Packing Labels"));
  assert.ok(modalUi.includes("Reprint Packing Labels"));
  assert.ok(reprintUi.includes("Reprint Packing Labels"));
  assert.ok(reprintUi.includes("This will print another complete set of"));
  assert.ok(reprintUi.includes("clientRequestId"));
  assert.ok(modalUi.includes("keepOpen: true"));
  assert.ok(modalUi.includes("PACKING_LABEL_ALREADY_PRINTED_TOAST"));
  assert.ok(!storeUi.includes('mode: "REPRINT"'));
  assert.match(modalUi, /if \(mode === "REPRINT"\)/);
});

run("reprintJob source: COMPLETED-only, frozen copy, reprint idempotency key", () => {
  assert.ok(labelSvc.includes("parentReprintRejection"));
  assert.ok(labelSvc.includes("buildReprintIdempotencyKey"));
  assert.ok(labelSvc.includes("canCopyFrozenPackingFaces"));
  assert.ok(labelSvc.includes("clientRequestId"));
  assert.ok(reprintSvc.includes("LABEL_REPRINT_PARENT_NOT_COMPLETED"));
  assert.ok(reprintSvc.includes("Cannot reprint a job that is currently printing"));
});

run("Fingerprint for full ALLOC/260824.01 selection is stable", () => {
  const again = buildDefaultPackingToolbarFingerprint([...sampleLines].reverse(), "PRE_PACKING");
  assert.equal(fingerprint, again);
  assert.ok(fingerprint.includes("line:6a8c9abec598d831c78443fc:qty:200"));
  assert.equal(buildPackingSelectionFingerprint([{ allocationLineId: "x", labelQty: 1 }]).startsWith("line:"), true);
});

run("Routes expose packing reprint-target under LABELS.reprint", () => {
  assert.ok(routes.includes("/jobs/:id/reprint-target"));
  assert.ok(routes.includes("labelsReprint, c.getReprintTarget"));
  assert.ok(ctrl.includes("export async function getReprintTarget"));
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
