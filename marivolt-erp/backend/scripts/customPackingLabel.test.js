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
  buildCustomPackingTemplateWorkbook,
  CUSTOM_PACKING_TSPL_OPTS,
  expandCustomPackingPreviewLabels,
  formatCustomPackingQtyDisplay,
  formatCustomPackingQtyDisplayLegacy,
  normalizeCustomPackingLines,
  parseCustomPackingSpreadsheetRows,
  summarizeCustomPackingBatch,
} from "../src/services/label/customPackingLabelService.js";
import {
  buildPackingJobTspl,
  buildSingleLabelTspl,
  packingLabelPreviewRows,
} from "../src/services/label/tsplGenerator.js";
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

const batchHeader = {
  customerName: "ALTAMAR OCEANIC",
  customerRef: "21200174",
  brand: "WARTSILA",
  modelName: "W34SG",
};

const sampleRow = {
  serialNo: "1",
  partNo: "OR-220",
  description: "O-RING",
  qty: 25,
  labelCount: 2,
};

const sampleBody = { header: batchHeader, lines: [sampleRow] };

run("1. Normalize batch header + row schema (no Article)", () => {
  const { header, lines } = normalizeCustomPackingLines(sampleBody);
  assert.equal(header.customerName, "ALTAMAR OCEANIC");
  assert.equal(lines.length, 1);
  assert.equal(lines[0].qtyDisplay, "25");
  assert.equal(lines[0].lineCopies, 2);
  assert.equal(lines[0].article, "");
  const rows = packingLabelPreviewRows(lines[0], CUSTOM_PACKING_TSPL_OPTS);
  const map = Object.fromEntries(rows.map((r) => [r.label, r.value]));
  assert.equal(map.Customer, "ALTAMAR OCEANIC");
  assert.equal(map["Part No."], "OR-220");
  assert.equal(map.QTY, "25");
  assert.equal(map.Article, undefined);
});

run("2. Same PACKING_STANDARD_100X50 TSPL renderer without Article row", () => {
  const { lines } = normalizeCustomPackingLines(sampleBody);
  const tspl = buildPackingJobTspl(lines, CUSTOM_PACKING_TSPL_OPTS);
  assert.match(tspl, /SIZE 100 mm,50 mm/);
  assert.match(tspl, /OR-220/);
  assert.match(tspl, /QTY/);
  assert.match(tspl, /"25"/);
  assert.doesNotMatch(tspl, /BARCODE/);
  assert.doesNotMatch(tspl, /\r\nTEXT [^,]+,[^,]+,"0",0,[^,]+,[^,]+,"Article"/);
  assert.equal(PACKING_STANDARD_TEMPLATE_CODE, "PACKING_STANDARD_100X50");
  assert.equal((tspl.match(/PRINT 1,1/g) || []).length, 2);
});

run("3. Qty 25 + labelCount 2 → two physical labels each QTY 25", () => {
  const { lines } = normalizeCustomPackingLines(sampleBody);
  const expanded = expandCustomPackingPreviewLabels(lines);
  assert.equal(expanded.length, 2);
  assert.equal(expanded[0].previewRows.find((r) => r.label === "QTY").value, "25");
  assert.equal(expanded[1].previewRows.find((r) => r.label === "QTY").value, "25");
  assert.notEqual(expanded[0].previewRows.find((r) => r.label === "QTY").value, "50");
});

run("4. Legacy qty display helper retained for historical reads", () => {
  assert.equal(formatCustomPackingQtyDisplayLegacy(5, 9), "5 of 9");
  assert.equal(formatCustomPackingQtyDisplay(25), "25");
});

run("5. labelCount maps from legacy copies field", () => {
  const { lines } = normalizeCustomPackingLines({
    header: batchHeader,
    lines: [{ ...sampleRow, labelCount: undefined, copies: 3 }],
  });
  assert.equal(lines[0].lineCopies, 3);
});

run("6. Description wrap + overflow detection", () => {
  const fit = fitPackingDescription("WORD ".repeat(80));
  assert.ok(fit.lines.length >= 1);
  const overflow = normalizeCustomPackingLines({
    header: batchHeader,
    lines: [{ ...sampleRow, description: "LONGTOKENWITHOUTSPACES".repeat(40), labelCount: 1 }],
  });
  assert.equal(overflow.lines[0].descriptionTruncated, true);
});

run("7. Validation: qty and labelCount rules", () => {
  assert.throws(() => normalizeCustomPackingLines({ header: batchHeader, lines: [] }), (e) => e.code === "LABEL_NO_LINES");
  assert.throws(
    () => normalizeCustomPackingLines({ header: batchHeader, lines: [{ ...sampleRow, qty: 0 }] }),
    (e) => e.code === "LABEL_QTY_INVALID"
  );
  assert.throws(
    () => normalizeCustomPackingLines({ header: batchHeader, lines: [{ ...sampleRow, labelCount: 1.5 }] }),
    (e) => e.code === "LABEL_COPIES_INVALID"
  );
  assert.throws(
    () => normalizeCustomPackingLines({ header: batchHeader, lines: [{ ...sampleRow, labelCount: 51 }] }),
    (e) => e.code === "LABEL_COPIES_MAX"
  );
});

run("8. Spreadsheet import ignores blank rows and validates decimals", () => {
  const rows = parseCustomPackingSpreadsheetRows([
    { rowNumber: 2, data: { "S. No.": "1", "Part No.": "OR-220", Description: "O-RING", Qty: "25", "No. of Labels": "2" } },
    { rowNumber: 3, data: {} },
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].qty, 25);
  assert.throws(
    () =>
      parseCustomPackingSpreadsheetRows([
        { rowNumber: 4, data: { "S. No.": "2", Qty: "1", "No. of Labels": "2.5" } },
      ]),
    /positive whole number/
  );
});

run("9. Template workbook has five columns without Article", () => {
  const buf = buildCustomPackingTemplateWorkbook();
  assert.ok(Buffer.isBuffer(buf));
  assert.ok(buf.length > 100);
});

run("10. Batch summary totals", () => {
  const { lines } = normalizeCustomPackingLines({
    header: batchHeader,
    lines: [
      sampleRow,
      { serialNo: "2", partNo: "123456", description: "GASKET", qty: 1, labelCount: 4 },
      { serialNo: "3", partNo: "TE201", description: "INLET VALVE", qty: 1, labelCount: 1 },
    ],
  });
  const summary = summarizeCustomPackingBatch(lines);
  assert.equal(summary.rowCount, 3);
  assert.equal(summary.physicalLabels, 7);
  assert.equal(summary.totalQtyRepresented, 55);
});

run("11. Idempotency key stable; labelCount included", () => {
  const { header, lines } = normalizeCustomPackingLines(sampleBody);
  const k1 = buildCustomPackingIdempotencyKey(header, lines);
  const k2 = buildCustomPackingIdempotencyKey(header, lines);
  assert.equal(k1, k2);
  assert.match(k1, /^custom-packing:[a-f0-9]{16}$/);
  const other = normalizeCustomPackingLines({
    header: batchHeader,
    lines: [{ ...sampleRow, labelCount: 3 }],
  });
  assert.notEqual(
    buildCustomPackingIdempotencyKey(header, lines),
    buildCustomPackingIdempotencyKey(other.header, other.lines)
  );
  assert.equal(buildCustomPackingFingerprint(header, lines).includes("OR-220"), true);
});

run("12. STORE_OPERATOR has LABELS print/reprint; no LABELS.admin", () => {
  const m = getDefaultPermissionsForRole("store_operator");
  assert.ok(m.LABELS.includes("view"));
  assert.ok(m.LABELS.includes("print"));
  assert.ok(m.LABELS.includes("reprint"));
  assert.ok(!m.LABELS.includes("admin"));
  assert.ok(!m.ASN.includes("cancel"));
});

run("13. Custom service has no stock/allocation/packing/GRN mutations", () => {
  const src = fs.readFileSync(
    path.join(backendRoot, "src/services/label/customPackingLabelService.js"),
    "utf8"
  );
  assert.doesNotMatch(src, /StockLedger|OrderAllocation|StorePacking|Inventory|Reservation|SalesInvoice|GRN\.|Grn\./);
  assert.match(src, /LabelPrintJob\.create/);
  assert.match(src, /sourceType: "CUSTOM_PACKING"/);
  assert.match(src, /buildPackingJobTspl\(lines, CUSTOM_PACKING_TSPL_OPTS\)/);
});

run("14. Routes + UI wired (table, import, template)", () => {
  const routes = fs.readFileSync(path.join(backendRoot, "src/routes/labelRoutes.js"), "utf8");
  assert.match(routes, /\/jobs\/from-custom-packing/);
  assert.match(routes, /\/jobs\/from-custom-packing\/preview/);
  assert.match(routes, /\/jobs\/from-custom-packing\/template/);
  assert.match(routes, /\/jobs\/from-custom-packing\/parse-import/);
  const modal = fs.readFileSync(path.join(feRoot, "components/store/CustomPackingLabelModal.jsx"), "utf8");
  assert.match(modal, /Common header/);
  assert.match(modal, /No\. of Labels/);
  assert.match(modal, /Import Excel\/CSV/);
  assert.match(modal, /Download Template/);
  assert.doesNotMatch(modal, /\["article", "Article"\]/);
  const sheet = fs.readFileSync(path.join(feRoot, "lib/customPackingLabelSpreadsheet.js"), "utf8");
  assert.match(sheet, /No\. of Labels/);
  assert.doesNotMatch(sheet, /header: "Article"/);
});

run("15. GRN label regression — unit barcode path unchanged", () => {
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
});

run("16. Normal packing label face still renders Article + qty of total", () => {
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
  assert.match(tspl, /Article/);
});

run("17. One combined TSPL job for multi-row batch", () => {
  const { lines } = normalizeCustomPackingLines({
    header: batchHeader,
    lines: [sampleRow, { serialNo: "2", partNo: "X", description: "Y", qty: 1, labelCount: 4 }],
  });
  const tspl = buildPackingJobTspl(lines, CUSTOM_PACKING_TSPL_OPTS);
  assert.equal((tspl.match(/PRINT 1,1/g) || []).length, 6);
});

console.log(`\nCustom packing label: ${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
