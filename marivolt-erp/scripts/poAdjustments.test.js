/**
 * Frontend PO adjustment display helpers (preview / PDF totals HTML).
 * Run: node scripts/poAdjustments.test.js
 */
import assert from "node:assert/strict";
import {
  applyPoAdjustmentsRoundTrip,
  buildPoDocumentTotalsRowsHtml,
  calcPoGrandTotalFromAdjustments,
  calcPoTotalsFromDoc,
  calcPoTotalsPreview,
  listVisiblePoTotalRows,
  preparePoAdjustmentsForSave,
  resolvePoAdjustments,
} from "../src/lib/poTotals.js";

let passed = 0;
let failed = 0;

function run(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed += 1;
  } catch (e) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${e.message}`);
    failed += 1;
  }
}

const lines = [{ qty: 2, unitPrice: 25370 }];

console.log("\nPO adjustments (frontend)\n");

run("preview hides unused zero-value rows", () => {
  const rows = listVisiblePoTotalRows({
    lines,
    packingCost: 0,
    handlingCost: 0,
    miscellaneousCost: 0,
    discountType: "NONE",
  }).rows;
  assert.equal(rows.length, 0);
});

run("PDF HTML hides unused zero-value rows", () => {
  const html = buildPoDocumentTotalsRowsHtml(
    {
      currency: "EUR",
      lines,
      packingCost: 0,
      handlingCost: 0,
      miscellaneousCost: 0,
      discountType: "NONE",
    },
    "EUR"
  );
  assert.match(html, /Line items subtotal/);
  assert.match(html, /Grand total/);
  assert.doesNotMatch(html, /Packing cost|Packing Cost/);
  assert.doesNotMatch(html, /Handling cost|Handling Cost/);
  assert.doesNotMatch(html, /Miscellaneous cost|Miscellaneous Cost/);
  assert.doesNotMatch(html, /<span>Discount<\/span>/);
});

run("PDF prints custom description, not Miscellaneous Cost", () => {
  const html = buildPoDocumentTotalsRowsHtml(
    {
      currency: "EUR",
      lines,
      adjustments: [{ type: "CUSTOM", label: "Inspection Charges", amount: 250 }],
    },
    "EUR"
  );
  assert.match(html, /Inspection Charges/);
  assert.match(html, /EUR 250\.00/);
  assert.doesNotMatch(html, /Miscellaneous Cost|Miscellaneous cost/);
});

run("form preview recalculates immediately when a row is removed", () => {
  const withPacking = calcPoTotalsPreview({
    lines,
    adjustments: [{ type: "PACKING", label: "Packing Cost", amount: 500 }],
  });
  const removed = calcPoTotalsPreview({ lines, adjustments: [] });
  assert.equal(withPacking.grandTotal, 51240);
  assert.equal(removed.grandTotal, removed.subTotal);
});

run("legacy miscellaneousCost still previews as Miscellaneous Cost", () => {
  const doc = {
    lines,
    packingCost: 0,
    handlingCost: 0,
    miscellaneousCost: 40,
  };
  assert.equal(resolvePoAdjustments(doc)[0].label, "Miscellaneous Cost");
  assert.equal(calcPoTotalsFromDoc(doc).grandTotal, 50780);
});

run("custom description survives prepare/reload", () => {
  const prepared = preparePoAdjustmentsForSave([
    { type: "CUSTOM", label: "Certificate Charges", amount: "15.5" },
  ]);
  assert.equal(prepared[0].label, "Certificate Charges");
  assert.equal(resolvePoAdjustments({ adjustments: prepared })[0].label, "Certificate Charges");
});

run("PERCENT preview label and live qty recalc", () => {
  const adjustments = [{ type: "DISCOUNT", discountMode: "PERCENT", discountValue: 10 }];
  const before = calcPoTotalsPreview({ lines: [{ qty: 10, unitPrice: 100 }], adjustments });
  const after = calcPoTotalsPreview({ lines: [{ qty: 20, unitPrice: 100 }], adjustments });
  assert.equal(before.grandTotal, 900);
  assert.equal(after.grandTotal, 1800);
  const rows = listVisiblePoTotalRows({
    lines: [{ qty: 10, unitPrice: 100 }],
    subTotal: 1000,
    adjustments,
  }).rows;
  assert.equal(rows[0].label, "Discount (10%)");
});

run("PERCENT PDF label", () => {
  const html = buildPoDocumentTotalsRowsHtml(
    {
      currency: "EUR",
      lines: [{ qty: 10, unitPrice: 100 }],
      subTotal: 1000,
      adjustments: [{ type: "DISCOUNT", discountMode: "PERCENT", discountValue: 10 }],
    },
    "EUR"
  );
  assert.match(html, /Discount \(10%\)/);
  assert.match(html, /EUR 100\.00/);
  assert.doesNotMatch(html, /PERCENT/);
});

run("PERCENT + additional costs uses subtotal-only discount basis", () => {
  const grand = calcPoGrandTotalFromAdjustments(10000, [
    { type: "PACKING", amount: 500 },
    { type: "FREIGHT", amount: 300 },
    { type: "DISCOUNT", discountMode: "PERCENT", discountValue: 10 },
  ]);
  assert.equal(grand, 9800);
});

run("legacy PERCENT save/reload stays PERCENT", () => {
  const saved = applyPoAdjustmentsRoundTrip({
    lines: [{ qty: 2, unitPrice: 25370 }],
    discountType: "PERCENT",
    discountValue: 10,
  });
  assert.equal(saved.discountType, "PERCENT");
  assert.equal(saved.discountValue, 10);
  assert.equal(resolvePoAdjustments(saved)[0].discountMode, "PERCENT");
});

run("shadow miscellaneousCost does not double-count when adjustments exist", () => {
  const doc = {
    lines,
    adjustments: [
      { type: "FREIGHT", amount: 100 },
      { type: "DOCUMENTATION", amount: 200 },
    ],
    miscellaneousCost: 300,
  };
  assert.equal(resolvePoAdjustments(doc).length, 2);
  assert.equal(calcPoTotalsFromDoc(doc).grandTotal, 50740 + 300);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
