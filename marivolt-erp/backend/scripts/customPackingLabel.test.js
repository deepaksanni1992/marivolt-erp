/**
 * Custom packing label (CUSTOM_PACKING) — print-only manual stickers.
 * Run: node scripts/customPackingLabel.test.js
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildCustomPackingFingerprint,
  buildCustomPackingIdempotencyKey,
  formatCustomPackingQtyDisplay,
  hashCustomPackingFingerprint,
  normalizeCustomPackingLines,
} from "../src/services/label/customPackingLabelService.js";
import { buildPackingJobTspl, buildSingleLabelTspl, packingLabelPreviewRows } from "../src/services/label/tsplGenerator.js";
import { fitPackingDescription } from "../src/utils/labelTextFit.js";
import { PACKING_STANDARD_TEMPLATE_CODE } from "../src/services/label/labelTemplateService.js";
import { getDefaultPermissionsForRole } from "../src/services/roleService.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.join(__dirname, "..");
const feRoot = path.join(backendRoot, "..", "src");

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

console.log("\nCustom packing label\n");

const sampleLine = {
  customerName: "ALTAMAR OCEANIC",
  customerRef: "21200174",
  brand: "WARTSILA",
  modelName: "W34SG",
  article: "700004.28",
  serialNo: "A1",
  partNo: "432108 AA",
  description: "SET OF GASKETS FOR CYLINDER HEAD",
  labelQty: 5,
  totalQty: 9,
  copies: 2,
};

run("1/2. Normalize lines + preview rows use packing face fields", () => {
  const lines = normalizeCustomPackingLines([sampleLine]);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].qtyDisplay, "5 of 9");
  assert.equal(lines[0].lineCopies, 2);
  assert.equal(lines[0].article, "700004.28");
  const rows = packingLabelPreviewRows(lines[0]);
  const map = Object.fromEntries(rows.map((r) => [r.label, r.value]));
  assert.equal(map.Customer, "ALTAMAR OCEANIC");
  assert.equal(map["Customer Ref."], "21200174");
  assert.equal(map.Brand, "WARTSILA");
  assert.equal(map.Model, "W34SG");
  assert.equal(map.Article, "700004.28");
  assert.equal(map["S. No."], "A1");
  assert.equal(map["Part No."], "432108 AA");
  assert.equal(map.QTY, "5 of 9");
});

run("3. Same PACKING_STANDARD_100X50 TSPL renderer (no barcode)", () => {
  const lines = normalizeCustomPackingLines([sampleLine]);
  const tspl = buildPackingJobTspl(lines, {});
  assert.match(tspl, /SIZE 100 mm,50 mm/);
  assert.match(tspl, /Customer/);
  assert.match(tspl, /ALTAMAR OCEANIC/);
  assert.match(tspl, /QTY/);
  assert.match(tspl, /5 of 9/);
  assert.doesNotMatch(tspl, /BARCODE/);
  assert.equal(PACKING_STANDARD_TEMPLATE_CODE, "PACKING_STANDARD_100X50");
  // Two copies → two PRINT commands
  assert.equal((tspl.match(/PRINT 1,1/g) || []).length, 2);
});

run("7/8. QTY 5 of 9 and QTY 5 when total blank", () => {
  assert.equal(formatCustomPackingQtyDisplay(5, 9), "5 of 9");
  assert.equal(formatCustomPackingQtyDisplay(5, ""), "5");
  assert.equal(formatCustomPackingQtyDisplay(5, null), "5");
  const blankTotal = normalizeCustomPackingLines([{ ...sampleLine, totalQty: "" }]);
  assert.equal(blankTotal[0].qtyDisplay, "5");
});

run("9. Copies independent of QTY text", () => {
  const a = normalizeCustomPackingLines([{ ...sampleLine, copies: 1 }]);
  const b = normalizeCustomPackingLines([{ ...sampleLine, copies: 3 }]);
  assert.equal(a[0].qtyDisplay, b[0].qtyDisplay);
  assert.equal(a[0].lineCopies, 1);
  assert.equal(b[0].lineCopies, 3);
});

run("10/11. Description wrap + overflow detection", () => {
  const fit = fitPackingDescription("WORD ".repeat(80));
  assert.ok(fit.lines.length >= 1);
  const overflow = normalizeCustomPackingLines([
    { ...sampleLine, description: "LONGTOKENWITHOUTSPACES".repeat(40), copies: 1 },
  ]);
  assert.equal(overflow[0].descriptionTruncated, true);
});

run("Validation: labelQty and totalQty rules", () => {
  assert.throws(() => normalizeCustomPackingLines([]), (e) => e.code === "LABEL_NO_LINES");
  assert.throws(
    () => normalizeCustomPackingLines([{ ...sampleLine, labelQty: 0 }]),
    (e) => e.code === "LABEL_QTY_INVALID"
  );
  assert.throws(
    () => normalizeCustomPackingLines([{ ...sampleLine, labelQty: 9, totalQty: 5 }]),
    (e) => e.code === "LABEL_QTY_INVALID"
  );
  assert.throws(
    () => normalizeCustomPackingLines([{ ...sampleLine, copies: 51 }]),
    (e) => e.code === "LABEL_COPIES_MAX"
  );
});

run("16/17. Idempotency key stable; copies included; different payload differs", () => {
  const lines = normalizeCustomPackingLines([sampleLine]);
  const k1 = buildCustomPackingIdempotencyKey(lines);
  const k2 = buildCustomPackingIdempotencyKey(lines);
  assert.equal(k1, k2);
  assert.match(k1, /^custom-packing:[a-f0-9]{16}$/);
  const other = normalizeCustomPackingLines([{ ...sampleLine, copies: 3 }]);
  assert.notEqual(buildCustomPackingIdempotencyKey(lines), buildCustomPackingIdempotencyKey(other));
  assert.equal(
    hashCustomPackingFingerprint(buildCustomPackingFingerprint(lines)).length,
    16
  );
});

run("13/14. STORE_OPERATOR has LABELS print/reprint; no LABELS.admin", () => {
  const m = getDefaultPermissionsForRole("store_operator");
  assert.ok(m.LABELS.includes("view"));
  assert.ok(m.LABELS.includes("print"));
  assert.ok(m.LABELS.includes("reprint"));
  assert.ok(!m.LABELS.includes("admin"));
});

run("18-21. Custom service has no stock/allocation/packing/GRN mutations", () => {
  const src = fs.readFileSync(
    path.join(backendRoot, "src/services/label/customPackingLabelService.js"),
    "utf8"
  );
  assert.doesNotMatch(src, /StockLedger|OrderAllocation|StorePacking|Inventory|Reservation|SalesInvoice|GRN\.|Grn\./);
  assert.match(src, /LabelPrintJob\.create/);
  assert.match(src, /sourceType: "CUSTOM_PACKING"/);
  assert.match(src, /PACKING_STANDARD_TEMPLATE_CODE/);
  assert.match(src, /buildPackingJobTspl/);
});

run("Routes + model + UI wired", () => {
  const routes = fs.readFileSync(path.join(backendRoot, "src/routes/labelRoutes.js"), "utf8");
  assert.match(routes, /\/jobs\/from-custom-packing/);
  assert.match(routes, /\/jobs\/from-custom-packing\/preview/);
  assert.match(routes, /labelsPrint.*createFromCustomPacking|createFromCustomPacking/);
  const model = fs.readFileSync(path.join(backendRoot, "src/models/LabelPrintJob.js"), "utf8");
  assert.match(model, /CUSTOM_PACKING/);
  const queue = fs.readFileSync(path.join(feRoot, "components/store/LabelQueuePanel.jsx"), "utf8");
  assert.match(queue, /Custom Label/);
  assert.match(queue, /CustomPackingLabelModal/);
  const modal = fs.readFileSync(path.join(feRoot, "components/store/CustomPackingLabelModal.jsx"), "utf8");
  assert.match(modal, /from-custom-packing/);
  assert.match(modal, /Print with truncated description/);
  const reprint = fs.readFileSync(path.join(backendRoot, "src/services/label/labelService.js"), "utf8");
  assert.match(reprint, /CUSTOM_PACKING/);
});

run("22. GRN label regression — unit barcode path unchanged", () => {
  const tspl = buildSingleLabelTspl(
    {
      article: "A1",
      description: "Desc",
      spn: "SPN",
      qty: 1,
      barcodeValue: "A1",
    },
    { copies: 1, companyName: "MARIVOLT FZE", barcodeMode: "ARTICLE" }
  );
  assert.match(tspl, /BARCODE/);
  assert.match(tspl, /SIZE 100 mm,50 mm/);
});

run("23. Packing label face still renders qty of total", () => {
  const tspl = buildPackingJobTspl(
    [
      {
        customerName: "C",
        customerRef: "R",
        brand: "B",
        modelName: "M",
        article: "ART",
        serialNo: 1,
        partNo: "P",
        description: "D",
        labelQty: 5,
        totalQty: 9,
        qtyDisplay: "5 of 9",
        lineCopies: 1,
      },
    ],
    {}
  );
  assert.match(tspl, /5 of 9/);
  assert.doesNotMatch(tspl, /BARCODE/);
});

console.log(`\nCustom packing label: ${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
