/**
 * Unit tests for Proforma Invoice Payment Request helpers (no database).
 * Run: node backend/scripts/piPaymentRequest.test.js
 */
import assert from "node:assert/strict";
import {
  buildValidatedPiPaymentRequest,
  defaultFullPiPaymentRequest,
  piPayableTotal,
  resolvePiPaymentRequest,
  roundMoney,
} from "../src/utils/piPaymentRequest.js";

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

const COMMERCIAL = 1120000;

console.log("\nPI Payment Request\n");

run("A. Full-value PI", () => {
  const r = buildValidatedPiPaymentRequest(COMMERCIAL, { piValueType: "FULL" });
  assert.equal(r.commercialGrandTotal, COMMERCIAL);
  assert.equal(r.requestedAmount, COMMERCIAL);
  assert.equal(r.commercialBalanceAmount, 0);
  assert.equal(r.grandTotal, COMMERCIAL);
});

run("B. 30% PI", () => {
  const r = buildValidatedPiPaymentRequest(COMMERCIAL, { piValueType: "PERCENTAGE", advancePercentage: 30 });
  assert.equal(r.requestedAmount, 336000);
  assert.equal(r.commercialBalanceAmount, 784000);
  assert.equal(r.grandTotal, COMMERCIAL);
});

run("C. Fixed PI 250000", () => {
  const r = buildValidatedPiPaymentRequest(COMMERCIAL, {
    piValueType: "FIXED_AMOUNT",
    requestedAmount: 250000,
  });
  assert.equal(r.requestedAmount, 250000);
  assert.equal(r.commercialBalanceAmount, 870000);
});

run("D. Invalid percentage rejected", () => {
  for (const pct of [0, -5, 101]) {
    assert.throws(
      () => buildValidatedPiPaymentRequest(COMMERCIAL, { piValueType: "PERCENTAGE", advancePercentage: pct }),
      /Advance Percentage/
    );
  }
});

run("E. Invalid fixed amount rejected", () => {
  assert.throws(
    () =>
      buildValidatedPiPaymentRequest(COMMERCIAL, {
        piValueType: "FIXED_AMOUNT",
        requestedAmount: -10,
      }),
    /greater than 0/
  );
  assert.throws(
    () =>
      buildValidatedPiPaymentRequest(COMMERCIAL, {
        piValueType: "FIXED_AMOUNT",
        requestedAmount: 1120001,
      }),
    /cannot exceed/
  );
});

run("F. Capacity blocks over-issuance", () => {
  const first = buildValidatedPiPaymentRequest(COMMERCIAL, {
    piValueType: "PERCENTAGE",
    advancePercentage: 30,
  });
  assert.equal(first.requestedAmount, 336000);
  const second = buildValidatedPiPaymentRequest(COMMERCIAL, {
    piValueType: "PERCENTAGE",
    advancePercentage: 40,
  }, { maxRequestedAmount: COMMERCIAL - 336000 });
  assert.equal(second.requestedAmount, 448000);
  const third = buildValidatedPiPaymentRequest(COMMERCIAL, {
    piValueType: "PERCENTAGE",
    advancePercentage: 30,
  }, { maxRequestedAmount: COMMERCIAL - 336000 - 448000 });
  assert.equal(third.requestedAmount, 336000);
  assert.throws(
    () =>
      buildValidatedPiPaymentRequest(COMMERCIAL, { piValueType: "PERCENTAGE", advancePercentage: 1 }, {
        maxRequestedAmount: 0,
      }),
    /exceeds remaining/
  );
});

run("G. Cancel releases capacity (remaining recovers)", () => {
  const issuedAfterCancel = 336000 + 336000; // PI-1 + PI-3; PI-2 cancelled
  const remaining = roundMoney(COMMERCIAL - issuedAfterCancel);
  assert.equal(remaining, 448000);
  const again = buildValidatedPiPaymentRequest(COMMERCIAL, {
    piValueType: "PERCENTAGE",
    advancePercentage: 40,
  }, { maxRequestedAmount: remaining });
  assert.equal(again.requestedAmount, 448000);
});

run("H. Payable total uses requestedAmount", () => {
  const doc = {
    grandTotal: COMMERCIAL,
    piValueType: "PERCENTAGE",
    advancePercentage: 30,
    requestedAmount: 336000,
  };
  assert.equal(piPayableTotal(doc), 336000);
});

run("I. Historical PI resolves as FULL", () => {
  const r = resolvePiPaymentRequest({ grandTotal: COMMERCIAL });
  assert.equal(r.piValueType, "FULL");
  assert.equal(r.requestedAmount, COMMERCIAL);
  assert.equal(r.commercialBalanceAmount, 0);
  assert.equal(r.advanceRemarks, "");
  const d = defaultFullPiPaymentRequest(COMMERCIAL);
  assert.equal(d.piValueType, "FULL");
  assert.equal(d.requestedAmount, COMMERCIAL);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
