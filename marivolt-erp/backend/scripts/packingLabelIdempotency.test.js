/**
 * Packing label queue idempotency regression tests.
 * Run: node scripts/packingLabelIdempotency.test.js
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PACKING_LABEL_ACTIVE_IDEMPOTENCY_STATUSES,
  PACKING_LABEL_BLOCKING_REPRINT_STATUSES,
  PACKING_LABEL_COMPLETED_IDEMPOTENCY_STATUSES,
  PACKING_LABEL_RELEASE_KEY_STATUSES,
  buildPackingLabelEnqueueResponse,
  isActivePackingLabelQueueStatus,
  listPackingLabelJobStatuses,
  resolvePackingLabelIdempotencyAction,
} from "../src/services/label/packingLabelIdempotency.js";
import {
  buildInitialPackingLabelIdempotencyKey,
  buildPrePackingLabelIdempotencyKey,
  rebuildPackingLabelIdempotencyKey,
} from "../src/services/label/packingLabelService.js";
import { buildPackingLabelBatchPayloads } from "../src/services/label/tsplGenerator.js";
import { resolvePackingLabelQueueMessage } from "../../src/lib/labelPrinting.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.join(__dirname, "..");
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

console.log("\nPacking label idempotency (queue fix)\n");

/** In-memory idempotency store mirroring createJobsFromPacking decision tree. */
function simulatePackingEnqueue(state, idempotencyKey, createJobFn) {
  const existing = state.byKey.get(idempotencyKey);
  if (existing) {
    const resolution = resolvePackingLabelIdempotencyAction(existing.status);
    if (resolution.action === "reuse" || resolution.action === "dedupe") {
      return buildPackingLabelEnqueueResponse(existing, { created: false, reused: true });
    }
    if (resolution.action === "block") {
      const err = new Error(resolution.message);
      err.code = resolution.code;
      throw err;
    }
    if (resolution.action === "create") {
      state.byKey.delete(idempotencyKey);
      const idx = state.all.findIndex((j) => j._id === existing._id);
      if (idx >= 0) state.all[idx] = { ...existing, idempotencyKey: null };
    }
  }
  try {
    const job = createJobFn();
    job.idempotencyKey = idempotencyKey;
    state.byKey.set(idempotencyKey, job);
    state.all.push(job);
    return buildPackingLabelEnqueueResponse(job, { created: true, reused: false });
  } catch (e) {
    if (e.code === 11000) {
      const raced = state.byKey.get(idempotencyKey);
      if (raced && isActivePackingLabelQueueStatus(raced.status)) {
        return buildPackingLabelEnqueueResponse(raced, { created: false, reused: true });
      }
    }
    throw e;
  }
}

function makeJob(overrides = {}) {
  return {
    _id: overrides._id || `job-${Math.random().toString(36).slice(2, 8)}`,
    jobNo: overrides.jobNo || `LBL${Date.now()}`,
    status: overrides.status || "PENDING",
    requestedLabels: overrides.requestedLabels ?? 6,
    idempotencyKey: overrides.idempotencyKey ?? null,
    sourceNo: overrides.sourceNo || "ALLOC/260824.01",
    packingMode: overrides.packingMode || "PRE_PACKING",
    lines: overrides.lines || sampleLines(),
    ...overrides,
  };
}

function sampleLines() {
  return [
    { allocationLineId: "6a8c9abec598d831c78443f7", labelQty: 6, lineCopies: 1 },
    { allocationLineId: "6a8c9abec598d831c78443f8", labelQty: 12, lineCopies: 1 },
    { allocationLineId: "6a8c9abec598d831c78443f9", labelQty: 12, lineCopies: 1 },
    { allocationLineId: "6a8c9abec598d831c78443fa", labelQty: 2, lineCopies: 1 },
    { allocationLineId: "6a8c9abec598d831c78443fb", labelQty: 4, lineCopies: 1 },
    { allocationLineId: "6a8c9abec598d831c78443fc", labelQty: 200, lineCopies: 1 },
  ];
}

const preKey = buildPrePackingLabelIdempotencyKey("ALLOC/260824.01", sampleLines());

run("Status enum covers all schema values", () => {
  const model = fs.readFileSync(path.join(srcRoot, "models", "LabelPrintJob.js"), "utf8");
  for (const s of listPackingLabelJobStatuses()) {
    assert.ok(model.includes(`"${s}"`));
  }
});

run("Test 1 — active duplicate: identical POST while PENDING reuses same job", () => {
  const state = { byKey: new Map(), all: [] };
  let seq = 0;
  const r1 = simulatePackingEnqueue(state, preKey, () => makeJob({ _id: "job-a", jobNo: "LBL-A" }));
  const r2 = simulatePackingEnqueue(state, preKey, () => {
    seq += 1;
    return makeJob({ _id: "job-b", jobNo: "LBL-B" });
  });
  assert.equal(r1.created, true);
  assert.equal(r2.created, false);
  assert.equal(r2.reused, true);
  assert.equal(r1.job._id, r2.job._id);
  assert.equal(state.all.length, 1);
  assert.equal(r1.job.requestedLabels, 6);
});

run("Test 2 — cancel → same selection creates new PENDING job (PRIMARY)", () => {
  const state = { byKey: new Map(), all: [] };
  const r1 = simulatePackingEnqueue(state, preKey, () => makeJob({ _id: "job-a", jobNo: "LBL-A" }));
  const cancelled = { ...r1.job, status: "CANCELLED", idempotencyKey: null };
  state.byKey.delete(preKey);
  state.all[0] = cancelled;

  const r2 = simulatePackingEnqueue(state, preKey, () =>
    makeJob({ _id: "job-b", jobNo: "LBL-B", status: "PENDING" })
  );
  assert.equal(r2.created, true);
  assert.equal(r2.reused, false);
  assert.equal(r2.job._id, "job-b");
  assert.notEqual(r2.job._id, r1.job._id);
  assert.notEqual(r2.job.jobNo, r1.job.jobNo);
  assert.equal(r2.job.status, "PENDING");
  assert.equal(state.all[0].status, "CANCELLED");
  assert.equal(state.all.length, 2);
  const active = state.all.filter((j) => isActivePackingLabelQueueStatus(j.status));
  assert.equal(active.length, 1);
});

run("Test 2b — legacy CANCELLED job still holding key releases claim and allows new job", () => {
  const state = { byKey: new Map(), all: [] };
  const jobA = makeJob({ _id: "job-a", jobNo: "LBL-A", status: "CANCELLED", idempotencyKey: preKey });
  state.byKey.set(preKey, jobA);
  state.all.push(jobA);

  const r2 = simulatePackingEnqueue(state, preKey, () =>
    makeJob({ _id: "job-b", jobNo: "LBL-B", status: "PENDING" })
  );
  assert.equal(r2.created, true);
  assert.equal(state.all[0].idempotencyKey, null);
  assert.equal(state.all[0].status, "CANCELLED");
  assert.equal(state.all[1].status, "PENDING");
});

run("Test 3 — cancelled job remains visible alongside new PENDING job", () => {
  const state = { byKey: new Map(), all: [] };
  simulatePackingEnqueue(state, preKey, () => makeJob({ _id: "job-a", status: "PENDING" }));
  state.all[0] = { ...state.all[0], status: "CANCELLED", idempotencyKey: null };
  state.byKey.delete(preKey);
  simulatePackingEnqueue(state, preKey, () => makeJob({ _id: "job-b", status: "PENDING" }));
  const statuses = state.all.map((j) => j.status).sort();
  assert.deepEqual(statuses, ["CANCELLED", "PENDING"]);
});

run("Test 4 — backend new-job response metadata", () => {
  const job = makeJob({ status: "PENDING" });
  const res = buildPackingLabelEnqueueResponse(job, { created: true, reused: false });
  assert.equal(res.created, true);
  assert.equal(res.reused, false);
  assert.equal(res.queueState, "PENDING");
  assert.equal(res.job.requestedLabels, 6);
});

run("Test 5 — active reused metadata", () => {
  const job = makeJob({ status: "PENDING" });
  const res = buildPackingLabelEnqueueResponse(job, { created: false, reused: true });
  assert.equal(res.created, false);
  assert.equal(res.reused, true);
  assert.equal(res.queueState, "PENDING");
});

run("Test 6 — six-label semantics unchanged (faces not label qty sum)", () => {
  const lines = sampleLines();
  const requestedLabels = lines.reduce((s, ln) => s + Math.max(1, Number(ln.lineCopies) || 1), 0);
  const payloads = buildPackingLabelBatchPayloads(lines, {});
  assert.equal(requestedLabels, 6);
  assert.equal(payloads.length, 6);
  const qtySum = lines.reduce((s, ln) => s + Number(ln.labelQty), 0);
  assert.equal(qtySum, 236);
  assert.notEqual(requestedLabels, qtySum);
});

run("Test 7 — concurrency after cancel: two POSTs → one active job", () => {
  const state = { byKey: new Map(), all: [] };
  state.all.push(makeJob({ _id: "job-a", status: "CANCELLED", idempotencyKey: preKey }));
  state.byKey.set(preKey, state.all[0]);

  let createCount = 0;
  const createFn = () => {
    createCount += 1;
    if (createCount > 1) {
      const err = new Error("duplicate key");
      err.code = 11000;
      throw err;
    }
    return makeJob({ _id: "job-b", jobNo: "LBL-B", status: "PENDING" });
  };

  const r1 = simulatePackingEnqueue(state, preKey, createFn);
  const r2 = simulatePackingEnqueue(state, preKey, createFn);
  assert.equal(r1.created, true);
  assert.equal(r2.reused, true);
  assert.equal(r1.job._id, r2.job._id);
  assert.equal(createCount, 1);
  const active = state.all.filter((j) => isActivePackingLabelQueueStatus(j.status));
  assert.equal(active.length, 1);
});

run("Test 8 — COMPLETED identical request dedupes (no duplicate print)", () => {
  const resolution = resolvePackingLabelIdempotencyAction("COMPLETED");
  assert.equal(resolution.action, "dedupe");
  const state = { byKey: new Map(), all: [] };
  const completed = makeJob({ _id: "job-c", status: "COMPLETED", idempotencyKey: preKey });
  state.byKey.set(preKey, completed);
  state.all.push(completed);
  const r = simulatePackingEnqueue(state, preKey, () => makeJob({ _id: "job-new" }));
  assert.equal(r.reused, true);
  assert.equal(r.created, false);
  assert.equal(state.all.length, 1);
});

run("Test 9 — UNCERTAIN blocks fresh physical print", () => {
  const resolution = resolvePackingLabelIdempotencyAction("UNCERTAIN");
  assert.equal(resolution.action, "block");
  assert.equal(resolution.code, "LABEL_UNCERTAIN_EXISTING");
  const state = { byKey: new Map(), all: [] };
  state.byKey.set(preKey, makeJob({ status: "UNCERTAIN" }));
  assert.throws(() => simulatePackingEnqueue(state, preKey, () => makeJob()), /uncertain/i);
});

run("FAILED allows new job after key release path", () => {
  assert.equal(resolvePackingLabelIdempotencyAction("FAILED").action, "create");
});

run("PARTIAL blocks auto re-enqueue", () => {
  assert.equal(resolvePackingLabelIdempotencyAction("PARTIAL").action, "block");
});

run("Frontend — fresh job success toast", () => {
  const msg = resolvePackingLabelQueueMessage({
    created: true,
    reused: false,
    queueState: "PENDING",
    job: { status: "PENDING", requestedLabels: 6 },
  });
  assert.equal(msg.type, "success");
  assert.match(msg.message, /6 labels queued successfully/);
});

run("Frontend — reused active job warning", () => {
  const msg = resolvePackingLabelQueueMessage({
    created: false,
    reused: true,
    queueState: "PENDING",
    job: { status: "PENDING", requestedLabels: 6 },
  });
  assert.equal(msg.type, "warning");
  assert.match(msg.message, /already queued/i);
});

run("Frontend — cancelled job must not show success", () => {
  const msg = resolvePackingLabelQueueMessage({
    created: false,
    reused: true,
    job: { status: "CANCELLED", requestedLabels: 6 },
  });
  assert.equal(msg.type, "error");
});

run("Source — packing service uses status-aware idempotency", () => {
  const svc = fs.readFileSync(path.join(srcRoot, "services", "label", "packingLabelService.js"), "utf8");
  assert.ok(svc.includes("resolvePackingLabelIdempotencyAction"));
  assert.ok(svc.includes("$unset: { idempotencyKey"));
  assert.ok(!svc.includes("if (existing) return existing"));
});

run("Source — cancelJob clears idempotencyKey", () => {
  const svc = fs.readFileSync(path.join(srcRoot, "services", "label", "labelService.js"), "utf8");
  assert.ok(svc.includes("job.idempotencyKey = null"));
});

run("Source — controller returns created/reused metadata", () => {
  const ctrl = fs.readFileSync(path.join(srcRoot, "controllers", "labelController.js"), "utf8");
  assert.ok(ctrl.includes("...result"));
  assert.ok(ctrl.includes("createFromPacking"));
});

run("Source — printQueue releases packing idempotency on FAILED", () => {
  const pq = fs.readFileSync(path.join(srcRoot, "services", "label", "printQueue.js"), "utf8");
  assert.ok(pq.includes('$unset = { idempotencyKey: "" }'));
  assert.ok(pq.includes('"PACKING"'));
});

run("rebuildPackingLabelIdempotencyKey restores PRE_PACKING key", () => {
  const job = {
    sourceNo: "ALLOC/260824.01",
    packingMode: "PRE_PACKING",
    lines: sampleLines(),
  };
  assert.equal(rebuildPackingLabelIdempotencyKey(job), preKey);
});

run("Active / terminal status classification is explicit", () => {
  assert.deepEqual(PACKING_LABEL_ACTIVE_IDEMPOTENCY_STATUSES, ["PENDING", "LEASED", "PRINTING"]);
  assert.deepEqual(PACKING_LABEL_COMPLETED_IDEMPOTENCY_STATUSES, ["COMPLETED"]);
  assert.deepEqual(PACKING_LABEL_BLOCKING_REPRINT_STATUSES, ["UNCERTAIN", "PARTIAL"]);
  assert.deepEqual(PACKING_LABEL_RELEASE_KEY_STATUSES, ["CANCELLED", "FAILED"]);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
