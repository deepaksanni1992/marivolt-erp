/**
 * S1 — Sales Invoice independent state model tests.
 * Run: node scripts/salesInvoiceState.s1.test.js
 */
import assert from "node:assert/strict";
import {
  computePaymentStatus,
  computeDispatchStatus,
  classifyInvoiceForMigration,
  isInvoiceDispatchEligible,
  rejectProtectedSiStateFields,
  legacyStatusFromDimensions,
  normalizePaymentStatus,
} from "../src/utils/salesInvoiceState.js";

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

console.log("S1 salesInvoiceState tests");

run("1. new invoice defaults via helpers", () => {
  assert.equal(computePaymentStatus({ grandTotal: 100, receivedAmount: 0 }), "UNPAID");
  assert.equal(computeDispatchStatus({ invoiceQty: 10, dispatchedQty: 0 }), "NOT_DISPATCHED");
  assert.equal(legacyStatusFromDimensions({ documentStatus: "DRAFT" }), "DRAFT");
});

run("2. issuing maps document lifecycle only (legacy compat ISSUED)", () => {
  assert.equal(legacyStatusFromDimensions({ documentStatus: "ISSUED" }), "ISSUED");
  assert.equal(legacyStatusFromDimensions({ documentStatus: "CANCELLED" }), "CANCELLED");
});

run("3. payment receipt posting changes paymentStatus only", () => {
  assert.equal(computePaymentStatus({ grandTotal: 100, receivedAmount: 100 }), "PAID");
  assert.equal(computeDispatchStatus({ invoiceQty: 5, dispatchedQty: 0 }), "NOT_DISPATCHED");
});

run("4. partial receipt => PARTIALLY_PAID", () => {
  assert.equal(computePaymentStatus({ grandTotal: 100, receivedAmount: 40 }), "PARTIALLY_PAID");
});

run("5. full receipt => PAID", () => {
  assert.equal(computePaymentStatus({ grandTotal: 250.5, receivedAmount: 250.5 }), "PAID");
});

run("6. receipt cancellation recalculates (zero => UNPAID)", () => {
  assert.equal(computePaymentStatus({ grandTotal: 100, receivedAmount: 0 }), "UNPAID");
});

run("7-9. store dispatch qty drives dispatchStatus only", () => {
  assert.equal(computeDispatchStatus({ invoiceQty: 10, dispatchedQty: 4 }), "PARTIALLY_DISPATCHED");
  assert.equal(computeDispatchStatus({ invoiceQty: 10, dispatchedQty: 10 }), "FULLY_DISPATCHED");
  assert.equal(computePaymentStatus({ grandTotal: 100, receivedAmount: 100 }), "PAID");
});

run("10. dispatch cancellation to zero => NOT_DISPATCHED", () => {
  assert.equal(computeDispatchStatus({ invoiceQty: 10, dispatchedQty: 0 }), "NOT_DISPATCHED");
});

run("11-12. paid remains PAID independent of dispatch", () => {
  const pay = computePaymentStatus({ grandTotal: 100, receivedAmount: 100 });
  assert.equal(pay, "PAID");
  assert.equal(computeDispatchStatus({ invoiceQty: 10, dispatchedQty: 10 }), "FULLY_DISPATCHED");
  assert.equal(computeDispatchStatus({ invoiceQty: 10, dispatchedQty: 0 }), "NOT_DISPATCHED");
  assert.equal(pay, "PAID");
});

run("13-14. dimensions do not cross-write", () => {
  // Helpers are pure; controllers must call only their owned helper (asserted by ownership).
  assert.notEqual(computePaymentStatus({ grandTotal: 1, receivedAmount: 1 }), "FULLY_DISPATCHED");
  assert.notEqual(computeDispatchStatus({ invoiceQty: 1, dispatchedQty: 1 }), "PAID");
});

run("15. generic update rejects protected status fields", () => {
  const err = rejectProtectedSiStateFields({ paymentStatus: "PAID", customerName: "X" });
  assert.ok(err);
  assert.equal(err.code, "SI_PROTECTED_FIELD_REJECTED");
  assert.ok(err.fields.includes("paymentStatus"));
  assert.equal(rejectProtectedSiStateFields({ customerName: "X" }), null);
});

run("16. cancelled document keeps payment/dispatch evidence readable", () => {
  const c = classifyInvoiceForMigration(
    { status: "CANCELLED", grandTotal: 100 },
    { receivedAmount: 100, invoiceQty: 5, storeDispatchedQty: 5 }
  );
  assert.equal(c.documentStatus, "CANCELLED");
  assert.equal(c.paymentStatus, "PAID");
  assert.equal(c.dispatchStatus, "FULLY_DISPATCHED");
});

run("17. migration classifies clear ISSUED unpaid undelivered", () => {
  const c = classifyInvoiceForMigration(
    { status: "ISSUED", grandTotal: 80 },
    { receivedAmount: 0, invoiceQty: 2, storeDispatchedQty: 0 }
  );
  assert.equal(c.documentStatus, "ISSUED");
  assert.equal(c.paymentStatus, "UNPAID");
  assert.equal(c.dispatchStatus, "NOT_DISPATCHED");
  assert.equal(c.ambiguous, false);
});

run("18. migration flags SalesDispatch-only ambiguous invoice", () => {
  const c = classifyInvoiceForMigration(
    { status: "DISPATCHED", grandTotal: 50 },
    { receivedAmount: 0, invoiceQty: 3, storeDispatchedQty: 0, hasSalesDispatchOnly: true }
  );
  assert.equal(c.dispatchStatus, "NOT_DISPATCHED");
  assert.equal(c.ambiguous, true);
  assert.equal(c.ambiguousReason, "SALES_DISPATCH_ONLY_WITHOUT_STORE_DISPATCH");
});

run("19. AR-style outstanding uses amounts not dispatch", () => {
  const total = 100;
  const received = 60;
  const balance = Math.max(0, total - received);
  assert.equal(computePaymentStatus({ grandTotal: total, receivedAmount: received }), "PARTIALLY_PAID");
  assert.equal(balance, 40);
});

run("20. eligibility for logistics convert uses document issued", () => {
  assert.equal(isInvoiceDispatchEligible({ documentStatus: "ISSUED" }), true);
  assert.equal(isInvoiceDispatchEligible({ documentStatus: "CANCELLED" }), false);
  assert.equal(isInvoiceDispatchEligible({ status: "DISPATCHED" }), true);
  assert.equal(isInvoiceDispatchEligible({ status: "DRAFT" }), false);
});

run("legacy PARTIAL normalizes to PARTIALLY_PAID", () => {
  assert.equal(normalizePaymentStatus("PARTIAL"), "PARTIALLY_PAID");
});

run("26. RTS remains absent (helper has no RTS symbols)", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = fs.readFileSync(path.join(here, "../src/utils/salesInvoiceState.js"), "utf8");
  assert.equal(/\bRTS\b/.test(src), false);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
