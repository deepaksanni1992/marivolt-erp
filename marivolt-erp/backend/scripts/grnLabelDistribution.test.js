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
  formatLabelDistributionCompact,
  formatGrnLabelPrintButtonText,
  parseDistributionInput,
  sumDistribution,
  resolveLabelDistribution,
  validateGrnLabelLinePrintConfig,
  buildGrnLabelConfigFingerprint,
  isSuccessfulLabelJobStatus,
  formatGrnLabelPreviewSummaryLine,
} from "../src/utils/grnLabelDistribution.js";
import { buildJobTspl, buildSingleLabelTspl } from "../src/services/label/tsplGenerator.js";
import {
  defaultLabelLineFields,
  getLineLabelDistribution,
  buildLabelLinesFromEdits,
  sumPhysicalLabelQty,
  buildGrnLabelPreviewRows,
  applyGrnQtyToLabelFields,
  syncLabelFieldsFromLabelCount,
  syncLabelFieldsFromCustomDistribution,
} from "../../src/lib/labelPrinting.js";

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

run("Validation uses No. Labels when qtyPerLabel is 0", () => {
  const v = validateGrnLabelLinePrintConfig({
    print: true,
    receivedQty: 10,
    qtyPerLabel: 0,
    labelCount: 10,
  });
  assert.strictEqual(v.ok, true);
  assert.deepStrictEqual(v.distribution, Array.from({ length: 10 }, () => 1));
});

run("Validation defaults to one label of full GRN qty", () => {
  const v = validateGrnLabelLinePrintConfig({
    print: true,
    article: "260811",
    receivedQty: 118,
  });
  assert.strictEqual(v.ok, true);
  assert.deepStrictEqual(v.distribution, [118]);
  assert.strictEqual(v.labelCount, 1);
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
  assert.ok(line.includes("A — GRN Qty 30 — 2 labels — Distribution 15 + 15"));
});

run("Preview summary is compact for long unit distributions", () => {
  const dist = Array.from({ length: 118 }, () => 1);
  const line = formatGrnLabelPreviewSummaryLine({
    article: "260811",
    grnQty: 118,
    labelCount: 118,
    labelDistribution: dist,
  });
  assert.ok(line.includes("118 labels"));
  assert.ok(line.includes("118 labels · Total Qty 118"));
  assert.ok(!line.includes("1 + 1 + 1"));
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

run("TEST 1: GRN Qty 118 default is 1 label [118]", () => {
  const fields = defaultLabelLineFields(118);
  assert.strictEqual(fields.labelCount, "1");
  assert.deepStrictEqual(fields.labelDistribution, [118]);
  assert.deepStrictEqual(getLineLabelDistribution({ grnQty: 118, ...fields }), [118]);
  const resolved = resolveLabelDistribution({ grnQty: 118 });
  assert.deepStrictEqual(resolved.distribution, [118]);
});

run("TEST 2: 118 / 2 labels => [59, 59]", () => {
  assert.deepStrictEqual(distributeByLabelCount(118, 2), [59, 59]);
});

run("TEST 3: 118 / 3 labels => [40, 39, 39]", () => {
  assert.deepStrictEqual(distributeByLabelCount(118, 3), [40, 39, 39]);
});

run("TEST 4: 118 / 4 labels => [30, 30, 29, 29]", () => {
  assert.deepStrictEqual(distributeByLabelCount(118, 4), [30, 30, 29, 29]);
});

run("TEST 5: custom [50, 50, 18] is valid", () => {
  const v = validateGrnLabelLinePrintConfig({
    print: true,
    article: "260811",
    receivedQty: 118,
    labelCount: 3,
    labelDistribution: [50, 50, 18],
  });
  assert.strictEqual(v.ok, true);
  assert.deepStrictEqual(v.distribution, [50, 50, 18]);
  assert.deepStrictEqual(parseDistributionInput("50 + 50 + 18"), [50, 50, 18]);
});

run("TEST 6: custom [50, 50] is blocked (100 != 118)", () => {
  const v = validateGrnLabelLinePrintConfig({
    print: true,
    article: "260811",
    receivedQty: 118,
    labelCount: 2,
    labelDistribution: [50, 50],
  });
  assert.strictEqual(v.ok, false);
  assert.ok(/does not match GRN Qty 118/.test(v.message));
});

run("TEST 7: multiple lines total physical labels = 5", () => {
  const selected = [
    { poLineId: "a", article: "260811", description: "Cooled Nozzle" },
    { poLineId: "b", article: "ART-B" },
  ];
  const edits = {
    a: { ...defaultLabelLineFields(118), grnQty: "118", printLabel: true, ...syncLabelFieldsFromLabelCount({ grnQty: "118" }, 2) },
    b: { ...defaultLabelLineFields(30), grnQty: "30", printLabel: true, ...syncLabelFieldsFromLabelCount({ grnQty: "30" }, 3) },
  };
  const lines = buildLabelLinesFromEdits(selected, edits);
  assert.deepStrictEqual(lines[0].labelDistribution, [59, 59]);
  assert.deepStrictEqual(lines[1].labelDistribution, [10, 10, 10]);
  assert.strictEqual(sumPhysicalLabelQty(lines), 5);
});

run("TEST 8: copies 3 print 6 labels without changing distribution", () => {
  const dist = [59, 59];
  assert.strictEqual(sumDistribution(dist), 118);
  const printed = dist.length * 3;
  assert.strictEqual(printed, 6);
  const job = buildJobTspl(
    [{ article: "260811", labelQty: 2, uom: "PCS", qty: 118, labelDistribution: dist }],
    { copies: 3 }
  );
  const fiftyNine = job.match(/Qty: 59 PCS/g) || [];
  assert.strictEqual(fiftyNine.length, 6);
  assert.ok(!job.includes("Qty: 118 PCS"));
  assert.strictEqual(formatGrnLabelPrintButtonText(2, 3), "Print 6 Copies/Labels");
});

run("TEST 9: decimal UOM 12.5 across 2 labels => 6.25 + 6.25", () => {
  const d = distributeByLabelCount(12.5, 2);
  assert.deepStrictEqual(d, [6.25, 6.25]);
  const v = validateGrnLabelLinePrintConfig({
    print: true,
    receivedQty: 12.5,
    labelCount: 2,
    labelDistribution: [6.25, 6.25],
  });
  assert.strictEqual(v.ok, true);
});

run("TEST 10: backend rejects manipulated distribution total", () => {
  const v = validateGrnLabelLinePrintConfig({
    print: true,
    article: "260811",
    receivedQty: 118,
    labelCount: 2,
    labelDistribution: [100, 10],
  });
  assert.strictEqual(v.ok, false);
  assert.strictEqual(sumDistribution(v.distribution), 110);
});

run("TEST 11: preview distribution is preserved for Post GRN & Print payload", () => {
  const ed = {
    grnQty: "118",
    printLabel: true,
    ...syncLabelFieldsFromLabelCount({ grnQty: "118" }, 2),
  };
  const preview = buildGrnLabelPreviewRows(
    buildLabelLinesFromEdits([{ poLineId: "p1", article: "260811" }], { p1: ed })
  );
  assert.deepStrictEqual(preview[0].labelDistribution, [59, 59]);
  const posted = buildLabelLinesFromEdits([{ poLineId: "p1", article: "260811" }], { p1: ed });
  assert.deepStrictEqual(posted[0].labelDistribution, preview[0].labelDistribution);
  assert.strictEqual(posted[0].labelCount, 2);
});

run("TEST 12: fingerprint distinguishes 118×1 vs 2×59 vs 1×118", () => {
  const unit = buildGrnLabelConfigFingerprint([
    { poLineId: "1", article: "260811", print: true, receivedQty: 118, qtyPerLabel: 1, labelCount: 118, labelDistribution: Array.from({ length: 118 }, () => 1) },
  ]);
  const two = buildGrnLabelConfigFingerprint([
    { poLineId: "1", article: "260811", print: true, receivedQty: 118, qtyPerLabel: 59, labelCount: 2, labelDistribution: [59, 59] },
  ]);
  const one = buildGrnLabelConfigFingerprint([
    { poLineId: "1", article: "260811", print: true, receivedQty: 118, qtyPerLabel: 118, labelCount: 1, labelDistribution: [118] },
  ]);
  assert.notStrictEqual(unit, two);
  assert.notStrictEqual(two, one);
  assert.notStrictEqual(unit, one);
});

run("Custom parse accepts comma and plus separators", () => {
  assert.deepStrictEqual(parseDistributionInput("50,50,18"), [50, 50, 18]);
  assert.deepStrictEqual(parseDistributionInput("50 50 18"), [50, 50, 18]);
});

run("Integer GRN qty rejects fractional custom parts", () => {
  const v = validateGrnLabelLinePrintConfig({
    print: true,
    receivedQty: 118,
    labelDistribution: [59.5, 58.5],
  });
  assert.strictEqual(v.ok, false);
});

run("Compact format leaves short distributions readable", () => {
  assert.strictEqual(formatLabelDistributionCompact([59, 59]), "59 + 59");
  assert.strictEqual(formatLabelDistributionCompact([118]), "118");
});

run("Print button text for 1 and 2 labels", () => {
  assert.strictEqual(formatGrnLabelPrintButtonText(1, 1), "Print 1 Label");
  assert.strictEqual(formatGrnLabelPrintButtonText(2, 1), "Print 2 Labels");
});

run("Changing GRN qty rebalances an existing label count", () => {
  const started = applyGrnQtyToLabelFields({}, 118);
  const two = syncLabelFieldsFromLabelCount({ ...started, grnQty: "118" }, 2);
  const resized = applyGrnQtyToLabelFields(two, 120);
  assert.deepStrictEqual(resized.labelDistribution, [60, 60]);
});

run("Custom distribution sync stores authoritative faces", () => {
  const ed = syncLabelFieldsFromCustomDistribution({ grnQty: "118" }, [50, 50, 18]);
  assert.strictEqual(ed.labelEditMode, "custom");
  assert.deepStrictEqual(getLineLabelDistribution(ed), [50, 50, 18]);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
