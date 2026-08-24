/**
 * Unit tests: canonical sales commercial totals + OA→PI packing/clearance regression.
 * Run: node backend/scripts/salesCommercialTotals.test.js
 */
import assert from "node:assert/strict";
import {
  computeSalesCommercialTotals,
  plainCommercialSource,
} from "../src/utils/salesCommercialTotals.js";
import {
  buildValidatedPiPaymentRequest,
  defaultFullPiPaymentRequest,
  piPayableTotal,
  resolvePiPaymentRequest,
  roundMoney,
} from "../src/utils/piPaymentRequest.js";
import {
  buildOaPiProgressSummary,
  buildOaCommercialRevision,
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

/** Mimic Mongoose document: spread drops schema paths; getters still work. */
function fakeMongooseOa(data) {
  const _doc = { ...data };
  const doc = { _doc };
  for (const key of Object.keys(_doc)) {
    Object.defineProperty(doc, key, {
      enumerable: false,
      configurable: true,
      get() {
        return this._doc[key];
      },
      set(v) {
        this._doc[key] = v;
      },
    });
  }
  doc.toObject = () => ({ ..._doc });
  return doc;
}

console.log("\nSales commercial totals / PI regression\n");

run("A. Clearance cost — QT/OA/PI/PDF/progress (1406.08 case)", () => {
  const lines = [{ totalPrice: 1331.08 }];
  const oa = {
    packingCost: 0,
    clearanceCost: 75,
    discountType: "NONE",
    discountValue: 0,
    taxTotal: 0,
  };
  const totals = computeSalesCommercialTotals(lines, oa);
  assert.equal(roundMoney(totals.subTotal), 1331.08);
  assert.equal(roundMoney(totals.clearanceCost), 75);
  assert.equal(roundMoney(totals.grandTotal), 1406.08);

  const pay = defaultFullPiPaymentRequest(totals.grandTotal);
  assert.equal(pay.commercialGrandTotal, 1406.08);
  assert.equal(pay.requestedAmount, 1406.08);

  const pdf = resolvePiPaymentRequest({
    ...totals,
    ...pay,
    piValueType: "FULL",
  });
  assert.equal(pdf.commercialGrandTotal, 1406.08);
  assert.equal(pdf.requestedAmount, 1406.08);

  const progress = buildOaPiProgressSummary(
    { grandTotal: totals.grandTotal, status: "ACTIVE" },
    {
      piIssuedRequestedTotal: pay.requestedAmount,
      piRemainingEligibleAmount: 0,
      activePiCount: 1,
    }
  );
  assert.equal(progress.commercialTotal, 1406.08);
  assert.equal(progress.piIssuedRequestedTotal, 1406.08);
  assert.equal(progress.piRemainingEligibleAmount, 0);
  assert.equal(progress.piProgressPercent, 100);
});

run("A2. Mongoose spread bug: { ...oa } drops clearance; plainCommercialSource keeps it", () => {
  const lines = [{ totalPrice: 1331.08 }];
  const oa = fakeMongooseOa({
    packingCost: 0,
    clearanceCost: 75,
    discountType: "NONE",
    discountValue: 0,
    taxTotal: 0,
    grandTotal: 1406.08,
  });
  const broken = computeSalesCommercialTotals(lines, { ...oa, discountType: "NONE", discountValue: 0 });
  assert.equal(roundMoney(broken.grandTotal), 1331.08, "spread path wrongly uses subtotal only");
  assert.equal(roundMoney(broken.clearanceCost), 0);

  const fixed = computeSalesCommercialTotals(
    lines,
    plainCommercialSource(oa, { discountType: "NONE", discountValue: 0 })
  );
  assert.equal(roundMoney(fixed.clearanceCost), 75);
  assert.equal(roundMoney(fixed.grandTotal), 1406.08);
  assert.equal(defaultFullPiPaymentRequest(fixed.grandTotal).requestedAmount, 1406.08);
});

run("B. Packing cost", () => {
  const totals = computeSalesCommercialTotals([{ totalPrice: 1000 }], {
    packingCost: 100,
    clearanceCost: 0,
  });
  assert.equal(totals.grandTotal, 1100);
  assert.equal(defaultFullPiPaymentRequest(totals.grandTotal).requestedAmount, 1100);
});

run("C. Packing + clearance", () => {
  const totals = computeSalesCommercialTotals([{ totalPrice: 1000 }], {
    packingCost: 50,
    clearanceCost: 75,
  });
  assert.equal(totals.grandTotal, 1125);
});

run("D. Percentage discount after qty/rate change", () => {
  const totals = computeSalesCommercialTotals([{ totalPrice: 2000 }], {
    discountType: "PERCENT",
    discountValue: 10,
    packingCost: 0,
    clearanceCost: 0,
  });
  assert.equal(totals.discountTotal, 200);
  assert.equal(totals.grandTotal, 1800);
});

run("E. Flat discount", () => {
  const totals = computeSalesCommercialTotals([{ totalPrice: 1000 }], {
    discountType: "FLAT",
    discountValue: 100,
    packingCost: 50,
    clearanceCost: 0,
  });
  assert.equal(totals.discountTotal, 100);
  assert.equal(totals.grandTotal, 950);
  assert.equal(defaultFullPiPaymentRequest(totals.grandTotal).requestedAmount, 950);
});

run("F. Tax included", () => {
  const totals = computeSalesCommercialTotals([{ totalPrice: 1000 }], {
    packingCost: 50,
    clearanceCost: 75,
    discountType: "FLAT",
    discountValue: 100,
    taxTotal: 51.25,
  });
  assert.equal(totals.grandTotal, 1076.25);
  assert.equal(defaultFullPiPaymentRequest(totals.grandTotal).requestedAmount, 1076.25);
});

run("G. Partial PIs against OA commercial", () => {
  const commercial = 1406.08;
  const pi1 = buildValidatedPiPaymentRequest(commercial, {
    piValueType: "PERCENTAGE",
    advancePercentage: 50,
  });
  assert.equal(pi1.requestedAmount, 703.04);
  const remaining1 = roundMoney(commercial - pi1.requestedAmount);
  assert.equal(remaining1, 703.04);

  const pi2 = buildValidatedPiPaymentRequest(commercial, {
    piValueType: "PERCENTAGE",
    advancePercentage: 25,
  });
  assert.equal(pi2.requestedAmount, 351.52);
  const remaining2 = roundMoney(remaining1 - pi2.requestedAmount);
  assert.equal(remaining2, 351.52);

  const pi3 = buildValidatedPiPaymentRequest(commercial, {
    piValueType: "FIXED_AMOUNT",
    requestedAmount: remaining2,
  }, { maxRequestedAmount: remaining2 });
  assert.equal(pi3.requestedAmount, 351.52);

  const issued = roundMoney(pi1.requestedAmount + pi2.requestedAmount + pi3.requestedAmount);
  assert.equal(issued, 1406.08);
  const summary = buildOaPiProgressSummary(
    { grandTotal: commercial },
    { piIssuedRequestedTotal: issued, piRemainingEligibleAmount: 0, activePiCount: 3 }
  );
  assert.equal(summary.piProgressPercent, 100);
});

run("H. Capacity guard rejects over-issue", () => {
  assert.throws(
    () =>
      buildValidatedPiPaymentRequest(1406.08, {
        piValueType: "FIXED_AMOUNT",
        requestedAmount: 800,
      }, { maxRequestedAmount: 703.04 }),
    /remaining PI-eligible/
  );
});

run("I. OA commercial revision freezes issued PI; remaining recalculates", () => {
  const revision = buildOaCommercialRevision({
    previousCommercial: 1406.08,
    revisedCommercial: 1500,
    issuedRequestedTotal: 703.04,
    reason: "Customer scope change",
  });
  assert.equal(revision.originalCommercialValue, 1406.08);
  assert.equal(revision.revisedCommercialValue, 1500);
  assert.equal(revision.difference, 93.92);
  const remaining = roundMoney(1500 - 703.04);
  assert.equal(remaining, 796.96);
  const summary = buildOaPiProgressSummary(
    { grandTotal: 1500 },
    {
      piIssuedRequestedTotal: 703.04,
      piRemainingEligibleAmount: remaining,
      activePiCount: 1,
    }
  );
  assert.equal(summary.piIssuedRequestedTotal, 703.04);
  assert.equal(summary.piRemainingEligibleAmount, 796.96);
  assert.equal(summary.piProgressPercent, roundMoney((703.04 / 1500) * 100));
});

run("J. PDF data prefers commercialGrandTotal snapshot (must equal commercial, not subtotal)", () => {
  const badPersisted = {
    subTotal: 1331.08,
    packingCost: 0,
    clearanceCost: 75,
    grandTotal: 1406.08,
    commercialGrandTotal: 1331.08,
    requestedAmount: 1331.08,
    piValueType: "FULL",
  };
  const stale = resolvePiPaymentRequest(badPersisted);
  assert.equal(stale.commercialGrandTotal, 1331.08, "documents the stale snapshot bug");

  const repaired = {
    ...badPersisted,
    ...buildValidatedPiPaymentRequest(1406.08, { piValueType: "FULL" }),
  };
  const pdf = resolvePiPaymentRequest(repaired);
  assert.equal(pdf.commercialGrandTotal, 1406.08);
  assert.equal(pdf.requestedAmount, 1406.08);
  assert.equal(pdf.commercialBalanceAmount, 0);
  assert.equal(piPayableTotal(pdf), 1406.08);
});

run("Zero adjustments still preserve subtotal as commercial", () => {
  const totals = computeSalesCommercialTotals([{ totalPrice: 500 }], {
    packingCost: 0,
    clearanceCost: 0,
    discountType: "NONE",
    taxTotal: 0,
  });
  assert.equal(totals.grandTotal, 500);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
