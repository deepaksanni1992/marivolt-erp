/**
 * GRN label distribution — unit tests (no Mongo).
 */
import assert from "assert";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  distributeByQtyPerLabel,
  distributeByLabelCount,
  formatLabelDistribution,
  sumDistribution,
  resolveLabelDistribution,
  validateGrnLabelLinePrintConfig,
  buildGrnLabelConfigFingerprint,
  isSuccessfulLabelJobStatus,
  formatGrnLabelPreviewSummaryLine,
} from "../src/utils/grnLabelDistribution.js";
import { buildJobTspl, buildSingleLabelTspl } from "../src/services/label/tsplGenerator.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.resolve(__dirname, "..");

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

console.log("GRN Label Distribution");

run("30 / qtyPerLabel 1 => 30 labels of 1", () => {
  const d = distributeByQtyPerLabel(30, 1);
  assert.strictEqual(d.length, 30);
  assert.ok(d.every((q) => q === 1));
  assert.strictEqual(sumDistribution(d), 30);
});

run("30 / qtyPerLabel 15 => [15, 15]", () => {
  assert.deepStrictEqual(distributeByQtyPerLabel(30, 15), [15, 15]);
});

run("25 / qtyPerLabel 10 => [10, 10, 5]", () => {
  assert.deepStrictEqual(distributeByQtyPerLabel(25, 10), [10, 10, 5]);
  assert.strictEqual(formatLabelDistribution([10, 10, 5]), "10 + 10 + 5");
});

run("25 / labelCount 2 => [13, 12]", () => {
  assert.deepStrictEqual(distributeByLabelCount(25, 2), [13, 12]);
  assert.strictEqual(sumDistribution([13, 12]), 25);
});

run("10 / labelCount 3 => [4, 3, 3]", () => {
  assert.deepStrictEqual(distributeByLabelCount(10, 3), [4, 3, 3]);
});

run("30 / labelCount 2 => [15, 15]", () => {
  assert.deepStrictEqual(distributeByLabelCount(30, 2), [15, 15]);
});

run("Distribution never pads remainder to full chunk", () => {
  const d = distributeByQtyPerLabel(25, 10);
  assert.ok(!d.includes(undefined));
  assert.strictEqual(d[d.length - 1], 5);
  assert.ok(sumDistribution(d) === 25);
});

run("Validation rejects zero qtyPerLabel", () => {
  const v = validateGrnLabelLinePrintConfig({
    print: true,
    receivedQty: 10,
    qtyPerLabel: 0,
    labelCount: 10,
  });
  assert.strictEqual(v.ok, false);
});

run("Validation accepts 10+10+5 for 25", () => {
  const v = validateGrnLabelLinePrintConfig({
    print: true,
    article: "W1",
    receivedQty: 25,
    qtyPerLabel: 10,
    labelCount: 3,
    labelDistribution: [10, 10, 5],
  });
  assert.strictEqual(v.ok, true);
  assert.deepStrictEqual(v.distribution, [10, 10, 5]);
});

run("Fingerprint changes when GRN qty changes", () => {
  const a = buildGrnLabelConfigFingerprint([
    { poLineId: "1", article: "A", print: true, receivedQty: 30, qtyPerLabel: 15, labelCount: 2, labelDistribution: [15, 15] },
  ]);
  const b = buildGrnLabelConfigFingerprint([
    { poLineId: "1", article: "A", print: true, receivedQty: 25, qtyPerLabel: 15, labelCount: 2, labelDistribution: [15, 10] },
  ]);
  assert.notStrictEqual(a, b);
});

run("Fingerprint changes when distribution changes but GRN Qty stays same", () => {
  const a = buildGrnLabelConfigFingerprint([
    {
      poLineId: "1",
      article: "A",
      print: true,
      receivedQty: 30,
      qtyPerLabel: 15,
      labelCount: 2,
      labelDistribution: [15, 15],
    },
  ]);
  const b = buildGrnLabelConfigFingerprint([
    {
      poLineId: "1",
      article: "A",
      print: true,
      receivedQty: 30,
      qtyPerLabel: 10,
      labelCount: 3,
      labelDistribution: [10, 10, 10],
    },
  ]);
  assert.notStrictEqual(a, b);
});

run("Decimal UOM: 12.5 / 2.5 => five labels of 2.5", () => {
  const d = distributeByQtyPerLabel(12.5, 2.5);
  assert.deepStrictEqual(d, [2.5, 2.5, 2.5, 2.5, 2.5]);
  assert.strictEqual(sumDistribution(d), 12.5);
});

run("Decimal UOM: 10.5 across 2 labels => 5.25 + 5.25", () => {
  const d = distributeByLabelCount(10.5, 2);
  assert.strictEqual(d.length, 2);
  assert.ok(Math.abs(sumDistribution(d) - 10.5) < 1e-9);
  assert.deepStrictEqual(d, [5.25, 5.25]);
});

run("isSuccessfulLabelJobStatus only COMPLETED", () => {
  assert.strictEqual(isSuccessfulLabelJobStatus("COMPLETED"), true);
  assert.strictEqual(isSuccessfulLabelJobStatus("PENDING"), false);
  assert.strictEqual(isSuccessfulLabelJobStatus("LEASED"), false);
  assert.strictEqual(isSuccessfulLabelJobStatus("PRINTING"), false);
  assert.strictEqual(isSuccessfulLabelJobStatus("FAILED"), false);
  assert.strictEqual(isSuccessfulLabelJobStatus("UNCERTAIN"), false);
  assert.strictEqual(isSuccessfulLabelJobStatus("PARTIAL"), false);
});

run("Preview summary line format", () => {
  const line = formatGrnLabelPreviewSummaryLine({
    article: "A",
    grnQty: 30,
    labelCount: 2,
    labelDistribution: [15, 15],
  });
  assert.ok(line.includes("A — GRN 30 — 2 labels — 15 + 15"));
});

run("Legacy TSPL still emits Qty: 1 when no distribution", () => {
  const job = buildJobTspl([{ article: "A1", labelQty: 3, uom: "PCS", qty: 3 }], { copies: 1 });
  const matches = job.match(/Qty: 1 PCS/g) || [];
  assert.strictEqual(matches.length, 3);
});

run("Distribution TSPL emits face qtys 10, 10, 5", () => {
  const job = buildJobTspl(
    [
      {
        article: "W1",
        labelQty: 3,
        uom: "PCS",
        qty: 25,
        labelDistribution: [10, 10, 5],
      },
    ],
    { copies: 1 }
  );
  assert.ok(job.includes("Qty: 10 PCS"));
  assert.ok(job.includes("Qty: 5 PCS"));
  const tens = job.match(/Qty: 10 PCS/g) || [];
  assert.strictEqual(tens.length, 2);
  const fives = job.match(/Qty: 5 PCS/g) || [];
  assert.strictEqual(fives.length, 1);
  assert.ok(!job.includes("Qty: 1 PCS"));
});

run("Single label respects qtyPerLabel option", () => {
  const tspl = buildSingleLabelTspl({ article: "X", uom: "PCS" }, { qtyPerLabel: 15 });
  assert.ok(tspl.includes("Qty: 15 PCS"));
});

run("resolveLabelDistribution from qtyPerLabel", () => {
  const r = resolveLabelDistribution({ grnQty: 30, qtyPerLabel: 15 });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.distribution, [15, 15]);
});

run("Multiple articles independent distributions", () => {
  const a = distributeByQtyPerLabel(100, 1);
  const b = distributeByQtyPerLabel(30, 15);
  const c = distributeByQtyPerLabel(25, 25);
  assert.strictEqual(a.length, 100);
  assert.deepStrictEqual(b, [15, 15]);
  assert.deepStrictEqual(c, [25]);
});

run("createJobsFromGrnPrepost source has zero stock/GRN side effects", () => {
  const src = fs.readFileSync(path.join(backendRoot, "src/services/label/labelService.js"), "utf8");
  const fnStart = src.indexOf("export async function createJobsFromGrnPrepost");
  assert.ok(fnStart >= 0);
  const fnEnd = src.indexOf("export async function registerPrintAgent", fnStart);
  const body = src.slice(fnStart, fnEnd);
  assert.ok(!/stockService|grnReceive|applyReceiveToPo|createCustomsLot|GRN\.create|GRN\.updateOne/.test(body));
  assert.ok(body.includes('sourceType: "GRN_PREPOST"'));
});

run("LabelPrintJob enum includes GRN_PREPOST", () => {
  const src = fs.readFileSync(path.join(backendRoot, "src/models/LabelPrintJob.js"), "utf8");
  assert.ok(src.includes("GRN_PREPOST"));
  assert.ok(src.includes("labelDistribution"));
  assert.ok(src.includes("draftRef"));
});

run("link-grn-prepost route and controller present", () => {
  const routes = fs.readFileSync(path.join(backendRoot, "src/routes/labelRoutes.js"), "utf8");
  const ctrl = fs.readFileSync(path.join(backendRoot, "src/controllers/labelController.js"), "utf8");
  assert.ok(routes.includes("/jobs/link-grn-prepost"));
  assert.ok(ctrl.includes("linkGrnPrepost"));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
