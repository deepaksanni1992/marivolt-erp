/**
 * PO additional-cost / adjustment totals + legacy compatibility (no database).
 * Run: node backend/scripts/poAdjustments.test.js
 */
import assert from "node:assert/strict";
import {
  applyPoAdjustmentsRoundTrip,
  buildPoDocumentTotalsRowsHtml,
  calcPoDiscountTotal,
  calcPoGrandTotal,
  calcPoGrandTotalFromAdjustments,
  calcPoTotalsFromDoc,
  calcPoTotalsPreview,
  legacyCostsFromAdjustments,
  legacyCostsToAdjustments,
  listVisiblePoTotalRows,
  preparePoAdjustmentsForSave,
  resolvePoAdjustments,
  validatePoAdjustments,
} from "../src/utils/poTotals.js";
import * as fePoTotals from "../../src/lib/poTotals.js";

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
const sub = 50740;

function po(extra = {}) {
  return { currency: "EUR", lines, subTotal: extra.subTotal ?? sub, ...extra };
}

console.log("\nPO adjustments\n");

run("1. no adjustments → subtotal == grand total and optional zero rows hidden", () => {
  const doc = po({ packingCost: 0, handlingCost: 0, miscellaneousCost: 0, discountType: "NONE" });
  const totals = calcPoTotalsFromDoc(doc);
  assert.equal(totals.subTotal, sub);
  assert.equal(totals.grandTotal, sub);
  assert.equal(listVisiblePoTotalRows(doc).rows.length, 0);
  const html = buildPoDocumentTotalsRowsHtml(doc, "EUR");
  assert.match(html, /Line items subtotal/);
  assert.match(html, /Grand total/);
  assert.doesNotMatch(html, /Packing Cost|Packing cost/);
  assert.doesNotMatch(html, /Handling Cost|Handling cost/);
  assert.doesNotMatch(html, /Miscellaneous Cost|Miscellaneous cost/);
  assert.doesNotMatch(html, /<span>Discount<\/span>/);
});

run("2. Packing Cost adjustment", () => {
  const doc = po({
    adjustments: [{ type: "PACKING", label: "Packing Cost", amount: 500 }],
  });
  const totals = calcPoTotalsFromDoc(doc);
  assert.equal(totals.grandTotal, 51240);
  const rows = listVisiblePoTotalRows(doc).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].label, "Packing Cost");
  assert.equal(rows[0].amount, 500);
});

run("3. Handling Cost adjustment", () => {
  const doc = po({
    adjustments: [{ type: "HANDLING", label: "Handling Cost", amount: 120 }],
  });
  assert.equal(calcPoTotalsFromDoc(doc).grandTotal, 50860);
  assert.equal(listVisiblePoTotalRows(doc).rows[0].label, "Handling Cost");
});

run("4. Freight adjustment", () => {
  const doc = po({
    adjustments: [{ type: "FREIGHT", label: "Freight", amount: 80 }],
  });
  assert.equal(calcPoTotalsFromDoc(doc).grandTotal, 50820);
  assert.equal(listVisiblePoTotalRows(doc).rows[0].label, "Freight");
});

run("5. one custom cost uses the typed description", () => {
  const doc = po({
    adjustments: [{ type: "CUSTOM", label: "Inspection Charges", amount: 250 }],
  });
  const rows = listVisiblePoTotalRows(doc).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].label, "Inspection Charges");
  assert.equal(calcPoTotalsFromDoc(doc).grandTotal, 50990);
  const html = buildPoDocumentTotalsRowsHtml(doc, "EUR");
  assert.match(html, /Inspection Charges/);
  assert.doesNotMatch(html, /Miscellaneous Cost|Miscellaneous cost/);
});

run("6. multiple custom costs", () => {
  const doc = po({
    adjustments: [
      { type: "CUSTOM", label: "Export Packing", amount: 750 },
      { type: "CUSTOM", label: "Inspection Charges", amount: 250 },
      { type: "CUSTOM", label: "Documentation Fee", amount: 100 },
    ],
  });
  const rows = listVisiblePoTotalRows(doc).rows;
  assert.deepEqual(
    rows.map((r) => r.label),
    ["Export Packing", "Inspection Charges", "Documentation Fee"]
  );
  assert.equal(calcPoTotalsFromDoc(doc).grandTotal, 51840);
});

run("7. Discount reduces total", () => {
  const doc = po({
    adjustments: [{ type: "DISCOUNT", label: "Discount", amount: 500 }],
  });
  assert.equal(calcPoTotalsFromDoc(doc).grandTotal, 50240);
  assert.equal(listVisiblePoTotalRows(doc).rows[0].isDiscount, true);
});

run("8. positive costs + Discount", () => {
  const doc = po({
    adjustments: [
      { type: "PACKING", label: "Packing Cost", amount: 500 },
      { type: "CUSTOM", label: "Inspection Charges", amount: 250 },
      { type: "DISCOUNT", label: "Discount", amount: 100 },
    ],
  });
  assert.equal(calcPoTotalsFromDoc(doc).grandTotal, 51390);
});

run("9. legacy packingCost > 0 normalizes to PACKING", () => {
  const doc = po({ packingCost: 500, handlingCost: 0, miscellaneousCost: 0 });
  const adj = resolvePoAdjustments(doc);
  assert.equal(adj.length, 1);
  assert.equal(adj[0].type, "PACKING");
  assert.equal(adj[0].amount, 500);
  assert.equal(calcPoTotalsFromDoc(doc).grandTotal, 51240);
  assert.equal(calcPoTotalsFromDoc(doc).grandTotal, calcPoGrandTotal(sub, 500, 0, 0, 0));
});

run("10. legacy handlingCost > 0 normalizes to HANDLING", () => {
  const doc = po({ packingCost: 0, handlingCost: 75, miscellaneousCost: 0 });
  const adj = resolvePoAdjustments(doc);
  assert.equal(adj[0].type, "HANDLING");
  assert.equal(calcPoTotalsFromDoc(doc).grandTotal, 50815);
});

run("11. legacy miscellaneousCost > 0 normalizes as CUSTOM Miscellaneous Cost", () => {
  const doc = po({ packingCost: 0, handlingCost: 0, miscellaneousCost: 40 });
  const adj = resolvePoAdjustments(doc);
  assert.equal(adj[0].type, "CUSTOM");
  assert.equal(adj[0].label, "Miscellaneous Cost");
  const rows = listVisiblePoTotalRows(doc).rows;
  assert.equal(rows[0].label, "Miscellaneous Cost");
  assert.equal(calcPoTotalsFromDoc(doc).grandTotal, 50780);
});

run("12. legacy FLAT discount still calculates and keeps FLAT mode", () => {
  const doc = po({
    packingCost: 0,
    handlingCost: 0,
    miscellaneousCost: 0,
    discountType: "FLAT",
    discountValue: 200,
  });
  const adj = resolvePoAdjustments(doc);
  assert.equal(adj[0].type, "DISCOUNT");
  assert.equal(adj[0].discountMode, "FLAT");
  assert.equal(adj[0].discountValue, 200);
  assert.equal(adj[0].amount, 200);
  assert.equal(calcPoTotalsFromDoc(doc).grandTotal, 50540);
});

run("13. editing preserves prepared adjustments (round-trip)", () => {
  const original = [
    { type: "PACKING", label: "Packing Cost", amount: 500 },
    { type: "CUSTOM", label: "Inspection Charges", amount: 250 },
  ];
  const prepared = preparePoAdjustmentsForSave(original);
  const again = preparePoAdjustmentsForSave(resolvePoAdjustments({ adjustments: prepared }));
  assert.deepEqual(
    again.map((r) => ({ type: r.type, label: r.label, amount: r.amount })),
    original
  );
});

run("14. custom description survives save/reload sanitize", () => {
  const prepared = preparePoAdjustmentsForSave([
    { type: "CUSTOM", label: "  Wooden Box Charges  ", amount: "90.00" },
  ]);
  assert.equal(prepared[0].label, "Wooden Box Charges");
  assert.equal(prepared[0].amount, 90);
  const reloaded = resolvePoAdjustments({ adjustments: prepared });
  assert.equal(reloaded[0].label, "Wooden Box Charges");
});

run("15. preview hides unused zero-value rows", () => {
  const form = {
    lines,
    adjustments: [
      { type: "PACKING", label: "Packing Cost", amount: 0 },
      { type: "CUSTOM", label: "Inspection Charges", amount: "" },
    ],
    packingCost: 0,
    handlingCost: 0,
    miscellaneousCost: 0,
  };
  const preview = calcPoTotalsPreview(form);
  assert.equal(preview.adjustments.length, 0);
  assert.equal(preview.grandTotal, preview.subTotal);
});

run("16. PDF HTML hides unused zero-value rows", () => {
  const html = buildPoDocumentTotalsRowsHtml(
    po({ packingCost: 0, handlingCost: 0, miscellaneousCost: 0, discountType: "NONE" }),
    "EUR"
  );
  assert.doesNotMatch(html, /EUR 0\.00/);
  assert.match(html, /EUR 50740\.00/);
});

run("17. grand total matches existing formula for mixed adjustments", () => {
  const adjustments = [
    { type: "PACKING", amount: 10 },
    { type: "HANDLING", amount: 5 },
    { type: "FREIGHT", amount: 3 },
    { type: "CUSTOM", label: "Bank telex", amount: 2 },
    { type: "DISCOUNT", amount: 4 },
  ];
  const fromAdj = calcPoGrandTotalFromAdjustments(sub, adjustments);
  const legacy = legacyCostsFromAdjustments(adjustments, sub);
  assert.equal(
    fromAdj,
    calcPoGrandTotal(sub, legacy.packingCost, legacy.handlingCost, legacy.miscellaneousCost, legacy.discountTotal)
  );
  assert.equal(fromAdj, sub + 10 + 5 + 3 + 2 - 4);
});

run("legacy PERCENT discount grand total is unchanged", () => {
  const doc = po({ discountType: "PERCENT", discountValue: 10, packingCost: 10, handlingCost: 5 });
  const expectedDiscount = 5074;
  assert.equal(calcPoTotalsFromDoc(doc).discountTotal, expectedDiscount);
  assert.equal(calcPoTotalsFromDoc(doc).grandTotal, sub - expectedDiscount + 10 + 5);
  const normalized = legacyCostsToAdjustments(doc);
  const disc = normalized.find((r) => r.type === "DISCOUNT");
  assert.equal(disc.amount, expectedDiscount);
  assert.equal(disc.discountMode, "PERCENT");
  assert.equal(disc.discountValue, 10);
});

run("1. legacy FLAT discount round-trip stays FLAT", () => {
  const doc = po({ discountType: "FLAT", discountValue: 200 });
  const saved = applyPoAdjustmentsRoundTrip(doc);
  assert.equal(saved.discountType, "FLAT");
  assert.equal(saved.discountValue, 200);
  assert.equal(saved.discountTotal, 200);
  const disc = saved.adjustments.find((r) => r.type === "DISCOUNT");
  assert.equal(disc.discountMode, "FLAT");
  assert.equal(disc.discountValue, 200);
});

run("2. legacy PERCENT discount round-trip stays PERCENT / 10", () => {
  const doc = po({ discountType: "PERCENT", discountValue: 10 });
  const saved = applyPoAdjustmentsRoundTrip(doc);
  assert.equal(saved.discountType, "PERCENT");
  assert.equal(saved.discountValue, 10);
  assert.equal(saved.discountTotal, 5074);
  const disc = saved.adjustments.find((r) => r.type === "DISCOUNT");
  assert.equal(disc.discountMode, "PERCENT");
  assert.equal(disc.discountValue, 10);
});

run("3. PERCENT survives edit + save (other costs added)", () => {
  const opened = resolvePoAdjustments(po({ discountType: "PERCENT", discountValue: 10 }));
  const edited = [
    ...opened,
    { type: "PACKING", label: "Packing Cost", amount: 500 },
  ];
  const prepared = preparePoAdjustmentsForSave(edited);
  const shadow = legacyCostsFromAdjustments(prepared, sub);
  assert.equal(shadow.discountType, "PERCENT");
  assert.equal(shadow.discountValue, 10);
  assert.equal(shadow.discountTotal, 5074);
  assert.equal(shadow.packingCost, 500);
  assert.equal(calcPoGrandTotalFromAdjustments(sub, prepared), sub - 5074 + 500);
});

run("4. PERCENT recalculates after qty change", () => {
  const adjustments = [
    { type: "DISCOUNT", label: "Discount", discountMode: "PERCENT", discountValue: 10 },
  ];
  const before = calcPoTotalsPreview({
    lines: [{ qty: 10, unitPrice: 100 }],
    adjustments,
  });
  const after = calcPoTotalsPreview({
    lines: [{ qty: 20, unitPrice: 100 }],
    adjustments,
  });
  assert.equal(before.subTotal, 1000);
  assert.equal(before.discountTotal, 100);
  assert.equal(before.grandTotal, 900);
  assert.equal(after.subTotal, 2000);
  assert.equal(after.discountTotal, 200);
  assert.equal(after.grandTotal, 1800);
  const saved = applyPoAdjustmentsRoundTrip({
    lines: [{ qty: 20, unitPrice: 100 }],
    adjustments,
  });
  assert.equal(saved.discountType, "PERCENT");
  assert.equal(saved.discountValue, 10);
  assert.equal(saved.discountTotal, 200);
  assert.equal(saved.grandTotal, 1800);
});

run("5. PERCENT recalculates after rate change", () => {
  const adjustments = [
    { type: "DISCOUNT", label: "Discount", discountMode: "PERCENT", discountValue: 10 },
  ];
  const after = calcPoTotalsPreview({
    lines: [{ qty: 10, unitPrice: 200 }],
    adjustments,
  });
  assert.equal(after.subTotal, 2000);
  assert.equal(after.discountTotal, 200);
  assert.equal(after.grandTotal, 1800);
});

run("6. PERCENT is on line subtotal only, then extra costs are added", () => {
  // Legacy: discount = min(sub, sub * 10 / 100); grand = sub - discount + packing + freight
  const adjustments = [
    { type: "PACKING", amount: 500 },
    { type: "FREIGHT", amount: 300 },
    { type: "DISCOUNT", discountMode: "PERCENT", discountValue: 10 },
  ];
  const subTotal = 10000;
  const discount = 1000;
  const expectedGrand = 9800;
  assert.equal(calcPoDiscountTotal(subTotal, "PERCENT", 10), discount);
  assert.equal(calcPoGrandTotalFromAdjustments(subTotal, adjustments), expectedGrand);
  assert.equal(
    calcPoTotalsPreview({
      lines: [{ qty: 10, unitPrice: 1000 }],
      adjustments,
    }).grandTotal,
    expectedGrand
  );
});

run("7+8. percentage preview and PDF label", () => {
  const doc = {
    currency: "EUR",
    lines: [{ qty: 10, unitPrice: 100 }],
    subTotal: 1000,
    adjustments: [{ type: "DISCOUNT", discountMode: "PERCENT", discountValue: 10 }],
  };
  const rows = listVisiblePoTotalRows(doc).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].label, "Discount (10%)");
  assert.equal(rows[0].amount, 100);
  const html = buildPoDocumentTotalsRowsHtml(doc, "EUR");
  assert.match(html, /Discount \(10%\)/);
  assert.match(html, /EUR 100\.00/);
  assert.doesNotMatch(html, /PERCENT/);
});

run("9. new percentage discount save/reload", () => {
  const created = applyPoAdjustmentsRoundTrip({
    lines: [{ qty: 2, unitPrice: 25370 }],
    adjustments: [{ type: "DISCOUNT", discountMode: "PERCENT", discountValue: 10 }],
  });
  const reloaded = resolvePoAdjustments(created);
  assert.equal(reloaded.length, 1);
  assert.equal(reloaded[0].discountMode, "PERCENT");
  assert.equal(reloaded[0].discountValue, 10);
  assert.equal(created.discountType, "PERCENT");
  assert.equal(created.discountValue, 10);
});

run("10. repeated save/read idempotency", () => {
  let doc = {
    lines: [{ qty: 10, unitPrice: 1000 }],
    adjustments: [
      { type: "FREIGHT", label: "Freight", amount: 100 },
      { type: "CUSTOM", label: "Inspection Charges", amount: 200 },
      { type: "DISCOUNT", discountMode: "PERCENT", discountValue: 10 },
    ],
  };
  for (let i = 0; i < 3; i += 1) {
    doc = applyPoAdjustmentsRoundTrip(doc);
    const types = doc.adjustments.map((r) => r.type);
    assert.deepEqual(types.sort(), ["CUSTOM", "DISCOUNT", "FREIGHT"]);
    assert.equal(doc.adjustments.filter((r) => r.type === "FREIGHT").length, 1);
    assert.equal(doc.adjustments.filter((r) => r.type === "CUSTOM").length, 1);
    assert.equal(doc.adjustments.find((r) => r.type === "CUSTOM").label, "Inspection Charges");
    const disc = doc.adjustments.find((r) => r.type === "DISCOUNT");
    assert.equal(disc.discountMode, "PERCENT");
    assert.equal(disc.discountValue, 10);
    assert.equal(doc.discountType, "PERCENT");
    assert.equal(doc.discountValue, 10);
    assert.equal(doc.grandTotal, 10000 - 1000 + 100 + 200);
  }
});

run("11. legacy save/read idempotency does not duplicate rows", () => {
  let doc = po({
    packingCost: 500,
    miscellaneousCost: 40,
    discountType: "PERCENT",
    discountValue: 10,
  });
  for (let i = 0; i < 3; i += 1) {
    doc = applyPoAdjustmentsRoundTrip(doc);
    assert.equal(doc.adjustments.filter((r) => r.type === "PACKING").length, 1);
    assert.equal(doc.adjustments.filter((r) => r.type === "CUSTOM").length, 1);
    assert.equal(doc.adjustments.filter((r) => r.type === "DISCOUNT").length, 1);
    assert.equal(doc.adjustments.find((r) => r.type === "CUSTOM").label, "Miscellaneous Cost");
    assert.equal(doc.discountType, "PERCENT");
    assert.equal(doc.discountValue, 10);
  }
});

run("12. adjustments + shadow miscellaneousCost does not double count", () => {
  const doc = po({
    adjustments: [
      { type: "FREIGHT", amount: 100 },
      { type: "DOCUMENTATION", amount: 200 },
    ],
    packingCost: 0,
    handlingCost: 0,
    miscellaneousCost: 300,
  });
  const adj = resolvePoAdjustments(doc);
  assert.equal(adj.length, 2);
  assert.equal(calcPoTotalsFromDoc(doc).grandTotal, sub + 300);
  assert.equal(calcPoTotalsFromDoc(doc).miscellaneousCost, 300);
});

run("13. adjustments take precedence over leftover legacy shadow fields", () => {
  const doc = po({
    adjustments: [{ type: "PACKING", amount: 50 }],
    packingCost: 999,
    handlingCost: 888,
    miscellaneousCost: 777,
    discountType: "PERCENT",
    discountValue: 10,
  });
  const adj = resolvePoAdjustments(doc);
  assert.equal(adj.length, 1);
  assert.equal(adj[0].type, "PACKING");
  assert.equal(calcPoTotalsFromDoc(doc).grandTotal, sub + 50);
  assert.equal(calcPoTotalsFromDoc(doc).discountTotal, 0);
});

run("duplicate system type is rejected; multiple CUSTOM allowed", () => {
  const dup = validatePoAdjustments([
    { type: "PACKING", amount: 1 },
    { type: "PACKING", amount: 2 },
  ]);
  assert.ok(dup.length > 0);
  const customs = validatePoAdjustments([
    { type: "CUSTOM", label: "A", amount: 1 },
    { type: "CUSTOM", label: "B", amount: 2 },
  ]);
  assert.deepEqual(customs, []);
});

run("invalid amount is reported, not coerced to 0", () => {
  const errors = validatePoAdjustments([{ type: "PACKING", amount: "abc" }]);
  assert.ok(errors.some((e) => /numeric/i.test(e)));
});

run("CUSTOM with amount and empty description is rejected", () => {
  const errors = validatePoAdjustments([{ type: "CUSTOM", label: "   ", amount: 25 }]);
  assert.ok(errors.some((e) => /description/i.test(e)));
});

run("zero-amount unused rows are dropped on save", () => {
  const prepared = preparePoAdjustmentsForSave([
    { type: "PACKING", amount: 0 },
    { type: "CUSTOM", label: "Inspection Charges", amount: 250 },
  ]);
  assert.equal(prepared.length, 1);
  assert.equal(prepared[0].label, "Inspection Charges");
});

run("PERCENT 0% is stripped; PERCENT > 0 is kept even before amount derivation", () => {
  assert.equal(preparePoAdjustmentsForSave([{ type: "DISCOUNT", discountMode: "PERCENT", discountValue: 0 }]).length, 0);
  const kept = preparePoAdjustmentsForSave([{ type: "DISCOUNT", discountMode: "PERCENT", discountValue: 10 }]);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].discountMode, "PERCENT");
  assert.equal(kept[0].discountValue, 10);
});

run("14. frontend/backend calculation parity", () => {
  const vectors = [
    { lines: [{ qty: 2, unitPrice: 25370 }] },
    { lines: [{ qty: 2, unitPrice: 25370 }], adjustments: [{ type: "PACKING", amount: 500 }] },
    {
      lines: [{ qty: 2, unitPrice: 25370 }],
      adjustments: [
        { type: "CUSTOM", label: "Export Packing", amount: 750 },
        { type: "CUSTOM", label: "Inspection Charges", amount: 250 },
      ],
    },
    {
      lines: [{ qty: 2, unitPrice: 25370 }],
      adjustments: [{ type: "DISCOUNT", discountMode: "FLAT", discountValue: 500 }],
    },
    {
      lines: [{ qty: 10, unitPrice: 100 }],
      adjustments: [{ type: "DISCOUNT", discountMode: "PERCENT", discountValue: 10 }],
    },
    {
      lines: [{ qty: 10, unitPrice: 1000 }],
      adjustments: [
        { type: "PACKING", amount: 500 },
        { type: "FREIGHT", amount: 300 },
        { type: "DISCOUNT", discountMode: "PERCENT", discountValue: 10 },
      ],
    },
    {
      lines: [{ qty: 2, unitPrice: 25370 }],
      packingCost: 0,
      handlingCost: 0,
      miscellaneousCost: 0,
    },
    {
      lines: [{ qty: 2, unitPrice: 25370 }],
      discountType: "PERCENT",
      discountValue: 10,
      packingCost: 500,
    },
  ];
  for (const doc of vectors) {
    const be = calcPoTotalsFromDoc(doc);
    const fe = fePoTotals.calcPoTotalsFromDoc(doc);
    assert.deepEqual(
      {
        subTotal: fe.subTotal,
        grandTotal: fe.grandTotal,
        discountTotal: fe.discountTotal,
        packingCost: fe.packingCost,
        handlingCost: fe.handlingCost,
        miscellaneousCost: fe.miscellaneousCost,
      },
      {
        subTotal: be.subTotal,
        grandTotal: be.grandTotal,
        discountTotal: be.discountTotal,
        packingCost: be.packingCost,
        handlingCost: be.handlingCost,
        miscellaneousCost: be.miscellaneousCost,
      }
    );
    const bePrev = calcPoTotalsPreview(doc);
    const fePrev = fePoTotals.calcPoTotalsPreview(doc);
    assert.equal(fePrev.grandTotal, bePrev.grandTotal);
    assert.equal(fePrev.discountTotal, bePrev.discountTotal);
    const beHtml = buildPoDocumentTotalsRowsHtml(doc, "EUR");
    const feHtml = fePoTotals.buildPoDocumentTotalsRowsHtml(doc, "EUR");
    assert.equal(feHtml, beHtml);
  }
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
