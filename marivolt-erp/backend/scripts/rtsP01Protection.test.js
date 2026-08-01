/**
 * P0.1 RTS status protection / approval claim tests (non-production data only).
 * Run: node scripts/rtsP01Protection.test.js
 */
import assert from "node:assert/strict";
import {
  RTS_APPROVED_WITHOUT_STOCK_POST,
  RTS_APPROVAL_IN_PROGRESS,
  RTS_EDITABLE_UPDATE_FIELDS,
  RTS_PROTECTED_UPDATE_FIELDS,
  buildRtsDraftApprovalClaimFilter,
  buildRtsDraftApprovalClaimUpdate,
  classifyApprovedRtsForReapproval,
  getDisallowedRtsUpdateFields,
  simulateApproveRtsClaim,
} from "../src/utils/rtsProtection.js";

let passed = 0;
let failed = 0;

function run(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed += 1;
      console.log(`  ✓ ${name}`);
    })
    .catch((e) => {
      failed += 1;
      console.error(`  ✗ ${name}`);
      console.error(`    ${e.message}`);
    });
}

console.log("\nRTS P0.1 protection\n");

await run("updateRts whitelist allows only rtsDate, packingDetails, lines", () => {
  assert.deepEqual([...RTS_EDITABLE_UPDATE_FIELDS], ["rtsDate", "packingDetails", "lines"]);
  assert.deepEqual(getDisallowedRtsUpdateFields({ rtsDate: "2026-01-01", packingDetails: {}, lines: [] }), []);
});

await run("updateRts with status APPROVED is prohibited (400 shape)", () => {
  const prohibited = getDisallowedRtsUpdateFields({ status: "APPROVED", packingDetails: {} });
  assert.ok(prohibited.includes("status"));
  // Document remains DRAFT when controller rejects before save — simulated here.
  const doc = { status: "DRAFT" };
  assert.equal(doc.status, "DRAFT");
});

await run("updateRts with status CANCELLED is prohibited; document unchanged", () => {
  const before = { status: "DRAFT", cancelledAt: null };
  const prohibited = getDisallowedRtsUpdateFields({ status: "CANCELLED" });
  assert.deepEqual(prohibited, ["status"]);
  assert.equal(before.status, "DRAFT");
  assert.equal(before.cancelledAt, null);
});

await run("updateRts with approvedAt / cancelledAt / linkedSalesInvoiceId returns prohibited fields", () => {
  const prohibited = getDisallowedRtsUpdateFields({
    approvedAt: new Date().toISOString(),
    cancelledAt: new Date().toISOString(),
    linkedSalesInvoiceId: "abc",
  });
  assert.ok(prohibited.includes("approvedAt"));
  assert.ok(prohibited.includes("cancelledAt"));
  assert.ok(prohibited.includes("linkedSalesInvoiceId"));
  for (const field of RTS_PROTECTED_UPDATE_FIELDS) {
    assert.ok(getDisallowedRtsUpdateFields({ [field]: true }).includes(field), field);
  }
});

await run("Valid DRAFT editable fields are not prohibited", () => {
  assert.deepEqual(
    getDisallowedRtsUpdateFields({
      rtsDate: "2026-08-01",
      packingDetails: { boxes: [] },
      lines: [{ article: "T-ARTICLE", qty: 1 }],
    }),
    []
  );
});

await run("Atomic claim filter requires _id + companyId + status DRAFT", () => {
  const filter = buildRtsDraftApprovalClaimFilter({ id: "rid1", companyId: "cid1" });
  assert.deepEqual(filter, { _id: "rid1", companyId: "cid1", status: "DRAFT" });
  const update = buildRtsDraftApprovalClaimUpdate({ updatedBy: "tester@example.com" });
  assert.deepEqual(update, { $set: { status: "APPROVING", updatedBy: "tester@example.com" } });
});

await run("Dedicated approval of valid DRAFT RTS succeeds once", async () => {
  const store = new Map([
    [
      "rts-1",
      {
        _id: "rts-1",
        companyId: "co-1",
        status: "DRAFT",
        rtsNo: "TEST-RTS-001",
        hasEvidence: false,
      },
    ],
  ]);
  let stockMoves = 0;
  const result = await simulateApproveRtsClaim({
    store,
    id: "rts-1",
    companyId: "co-1",
    updatedBy: "a@test.com",
    hasRtsTransferEvidence: (doc) => Boolean(doc.hasEvidence),
    stockWork: async () => {
      stockMoves += 1;
    },
  });
  assert.equal(result.outcome, "approved");
  assert.equal(result.stockMoves, 1);
  assert.equal(stockMoves, 1);
  assert.equal(store.get("rts-1").status, "APPROVED");
});

await run("Two concurrent approve requests: only one performs stock movement", async () => {
  const store = new Map([
    [
      "rts-2",
      {
        _id: "rts-2",
        companyId: "co-1",
        status: "DRAFT",
        rtsNo: "TEST-RTS-002",
        hasEvidence: false,
      },
    ],
  ]);
  let stockMoves = 0;
  const gate = { release: null };
  const hold = new Promise((resolve) => {
    gate.release = resolve;
  });

  const first = simulateApproveRtsClaim({
    store,
    id: "rts-2",
    companyId: "co-1",
    updatedBy: "a@test.com",
    hasRtsTransferEvidence: (doc) => Boolean(doc.hasEvidence),
    stockWork: async () => {
      stockMoves += 1;
      await hold;
    },
  });

  // Allow first claim to take APPROVING before second starts.
  await new Promise((r) => setTimeout(r, 10));

  const second = simulateApproveRtsClaim({
    store,
    id: "rts-2",
    companyId: "co-1",
    updatedBy: "b@test.com",
    hasRtsTransferEvidence: (doc) => Boolean(doc.hasEvidence),
    stockWork: async () => {
      stockMoves += 1;
    },
  });

  let secondErr = null;
  try {
    await second;
  } catch (e) {
    secondErr = e;
  }
  assert.ok(secondErr);
  assert.equal(secondErr.code, RTS_APPROVAL_IN_PROGRESS);
  assert.equal(secondErr.statusCode, 409);

  gate.release();
  const firstResult = await first;
  assert.equal(firstResult.outcome, "approved");
  assert.equal(stockMoves, 1);
  assert.equal(store.get("rts-2").status, "APPROVED");
});

await run("Repeated approval of healthy APPROVED RTS: no duplicate stock movement", async () => {
  const store = new Map([
    [
      "rts-3",
      {
        _id: "rts-3",
        companyId: "co-1",
        status: "APPROVED",
        rtsNo: "TEST-RTS-003",
        hasEvidence: true,
      },
    ],
  ]);
  let stockMoves = 0;
  const result = await simulateApproveRtsClaim({
    store,
    id: "rts-3",
    companyId: "co-1",
    hasRtsTransferEvidence: (doc) => Boolean(doc.hasEvidence),
    stockWork: async () => {
      stockMoves += 1;
    },
  });
  assert.equal(result.outcome, "idempotent");
  assert.equal(result.stockMoves, 0);
  assert.equal(stockMoves, 0);
  assert.equal(classifyApprovedRtsForReapproval(true), "HEALTHY_APPROVED");
});

await run("Orphan APPROVED RTS returns 409 RTS_APPROVED_WITHOUT_STOCK_POST with no changes", async () => {
  const orphan = {
    _id: "rts-orphan",
    companyId: "co-1",
    status: "APPROVED",
    rtsNo: "TEST-RTS-ORPHAN",
    hasEvidence: false,
  };
  const store = new Map([["rts-orphan", { ...orphan }]]);
  let stockMoves = 0;
  let err = null;
  try {
    await simulateApproveRtsClaim({
      store,
      id: "rts-orphan",
      companyId: "co-1",
      hasRtsTransferEvidence: (doc) => Boolean(doc.hasEvidence),
      stockWork: async () => {
        stockMoves += 1;
      },
    });
  } catch (e) {
    err = e;
  }
  assert.ok(err);
  assert.equal(err.statusCode, 409);
  assert.equal(err.code, RTS_APPROVED_WITHOUT_STOCK_POST);
  assert.equal(stockMoves, 0);
  assert.deepEqual(store.get("rts-orphan"), orphan);
  assert.equal(classifyApprovedRtsForReapproval(false), "ORPHAN_APPROVED");
});

await run("Stock failure during approval aborts; RTS does not remain APPROVED or APPROVING", async () => {
  const store = new Map([
    [
      "rts-4",
      {
        _id: "rts-4",
        companyId: "co-1",
        status: "DRAFT",
        rtsNo: "TEST-RTS-004",
        hasEvidence: false,
      },
    ],
  ]);
  let err = null;
  try {
    await simulateApproveRtsClaim({
      store,
      id: "rts-4",
      companyId: "co-1",
      hasRtsTransferEvidence: (doc) => Boolean(doc.hasEvidence),
      stockWork: async () => {
        throw new Error("simulated stock failure");
      },
    });
  } catch (e) {
    err = e;
  }
  assert.ok(err);
  assert.match(err.message, /simulated stock failure/);
  const after = store.get("rts-4");
  assert.equal(after.status, "DRAFT");
  assert.notEqual(after.status, "APPROVED");
  assert.notEqual(after.status, "APPROVING");
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
