/**
 * Post-GRN optional label decision — frontend helpers (no Mongo / API).
 */
import assert from "assert";
import {
  buildInitialGrnLabelIdempotencyKey,
  buildLabelLinesFromEdits,
  formatLabelsQueuedMessage,
  resolvePostGrnLabelMode,
  sumPhysicalLabelQty,
  validateInitialLabelLines,
} from "../src/lib/labelPrinting.js";

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

console.log("\nPost-GRN label decision\n");

run("labels disabled → mode none", () => {
  assert.equal(resolvePostGrnLabelMode({ enabled: false, autoPrintAfterGrn: true }), "none");
  assert.equal(resolvePostGrnLabelMode(null), "none");
  assert.equal(resolvePostGrnLabelMode(undefined), "none");
});

run("labels enabled + auto off → ask", () => {
  assert.equal(resolvePostGrnLabelMode({ enabled: true, autoPrintAfterGrn: false }), "ask");
});

run("labels enabled + auto on → auto", () => {
  assert.equal(resolvePostGrnLabelMode({ enabled: true, autoPrintAfterGrn: true }), "auto");
});

run("sumPhysicalLabelQty excludes unchecked and zero", () => {
  const lines = [
    { print: true, labelQty: 5 },
    { print: false, labelQty: 9 },
    { print: true, labelQty: 0 },
    { print: true, labelQty: 3 },
  ];
  assert.equal(sumPhysicalLabelQty(lines), 8);
});

run("buildLabelLinesFromEdits respects print + labelQty", () => {
  const selected = [
    { poLineId: "a1", article: "ART-1" },
    { poLineId: "a2", article: "ART-2" },
  ];
  const edits = {
    a1: { selected: true, grnQty: "10", printLabel: true, labelQty: "4" },
    a2: { selected: true, grnQty: "2", printLabel: false, labelQty: "2" },
  };
  const lines = buildLabelLinesFromEdits(selected, edits);
  assert.equal(sumPhysicalLabelQty(lines), 4);
});

run("validateInitialLabelLines rejects over-received", () => {
  const bad = validateInitialLabelLines([{ print: true, labelQty: 5, receivedQty: 2, article: "X" }]);
  assert.equal(bad.ok, false);
  const good = validateInitialLabelLines([{ print: true, labelQty: 2, receivedQty: 2, article: "X" }]);
  assert.equal(good.ok, true);
});

run("idempotency key is stable per GRN", () => {
  const a = buildInitialGrnLabelIdempotencyKey("MAR-GRN-1");
  const b = buildInitialGrnLabelIdempotencyKey("MAR-GRN-1");
  assert.equal(a, b);
  assert.equal(a, "grn:MAR-GRN-1:initial");
});

run("queued message singular/plural", () => {
  assert.equal(formatLabelsQueuedMessage(1), "1 label queued successfully.");
  assert.equal(formatLabelsQueuedMessage(18), "18 labels queued successfully.");
});

run("double-open guard: same grn keeps previous decision", () => {
  const prev = { grnNo: "G1", labelBody: { idempotencyKey: "grn:G1:initial" } };
  const nextGrnNo = "G1";
  const merged = prev?.grnNo === nextGrnNo ? prev : { grnNo: nextGrnNo };
  assert.strictEqual(merged, prev);
  assert.equal(merged.labelBody.idempotencyKey, "grn:G1:initial");
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
