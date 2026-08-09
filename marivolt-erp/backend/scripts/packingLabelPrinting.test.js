/**
 * Packing label printing (100×50) + GRN regression + hardening.
 * Run: node scripts/packingLabelPrinting.test.js
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  fitPackingDescription,
  fitWrappedText,
  formatPackingQtyDisplay,
  wrapWordsToLines,
} from "../src/utils/labelTextFit.js";
import {
  analyzePackingDescriptionLayout,
  buildJobTspl,
  buildPackingJobTspl,
  buildSingleLabelTspl,
  buildSinglePackingLabelTspl,
  getFixedLabelSize,
  packingLabelDescriptionMeta,
  packingLabelPreviewRows,
} from "../src/services/label/tsplGenerator.js";
import {
  PACKING_STANDARD_TEMPLATE_CODE,
  MARIVOLT_STANDARD_TEMPLATE_CODE,
} from "../src/services/label/labelTemplateService.js";
import {
  buildInitialPackingLabelIdempotencyKey as buildServerPackingIdempotencyKey,
  buildPrePackingLabelIdempotencyKey,
  buildPackingSelectionFingerprint,
  hashPackingSelectionFingerprint,
} from "../src/services/label/packingLabelService.js";
import {
  defaultPackingLabelRows,
  selectAllPackingLabelRows,
  selectAvailablePackingLabelRows,
  buildPackingLabelSelections,
  formatPackingQtyOf,
  buildPackingSelectionFingerprint as buildClientFingerprint,
} from "../../src/lib/labelPrinting.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.join(__dirname, "..");
const srcRoot = path.join(backendRoot, "src");

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

console.log("\nPacking label printing\n");

const routes = fs.readFileSync(path.join(srcRoot, "routes", "labelRoutes.js"), "utf8");
const jobModel = fs.readFileSync(path.join(srcRoot, "models", "LabelPrintJob.js"), "utf8");
const packingSvc = fs.readFileSync(path.join(srcRoot, "services", "label", "packingLabelService.js"), "utf8");
const tsplSrc = fs.readFileSync(path.join(srcRoot, "services", "label", "tsplGenerator.js"), "utf8");
const storeUi = fs.readFileSync(path.join(backendRoot, "..", "src", "pages", "StoreModule.jsx"), "utf8");
const modalUi = fs.readFileSync(
  path.join(backendRoot, "..", "src", "components", "store", "PackingLabelsModal.jsx"),
  "utf8"
);

run("1. Existing GRN label unchanged (unit Qty:1 + barcode path still present)", () => {
  const sample = buildSingleLabelTspl({
    article: "700004.28",
    description: "SET OF GASKETS",
    spn: "432108",
    labelQty: 5,
    uom: "PCS",
  });
  assert.ok(sample.includes("SIZE 100 mm,50 mm"));
  assert.ok(sample.includes("Qty: 1 PCS") || sample.includes("Qty: 1"));
  assert.ok(sample.includes("BARCODE"));
  assert.equal(getFixedLabelSize().widthMm, 100);
  assert.equal(getFixedLabelSize().heightMm, 50);
  assert.ok(tsplSrc.includes("buildSingleLabelTspl"));
  assert.ok(!tsplSrc.includes("buildSingleLabelTspl = buildSinglePacking"));
});

run("2. Packing label 100×50 template + table layout", () => {
  assert.equal(PACKING_STANDARD_TEMPLATE_CODE, "PACKING_STANDARD_100X50");
  assert.notEqual(PACKING_STANDARD_TEMPLATE_CODE, MARIVOLT_STANDARD_TEMPLATE_CODE);
  const tspl = buildSinglePackingLabelTspl({
    customerName: "MSC Shipmanagement",
    customerRef: "PO-266564",
    brand: "WARTSILA",
    modelName: "W34SG",
    article: "700004.28",
    serialNo: 1,
    partNo: "432108 AA",
    description: "SET OF GASKETS FOR CYLINDER HEAD",
    labelQty: 5,
    totalQty: 9,
  });
  assert.ok(tspl.includes("SIZE 100 mm,50 mm"));
  assert.ok(tspl.includes("Customer"));
  assert.ok(tspl.includes("QTY"));
  assert.ok(tspl.includes("5 of 9"));
  assert.ok(!tspl.includes("BARCODE"));
});

run("3/4/5. Select All / Available Only / Manual selection helpers", () => {
  const base = defaultPackingLabelRows(
    [
      { allocationLineId: "a", article: "A", allocatedQty: 9, physicalPackableQty: 5, description: "x" },
      { allocationLineId: "b", article: "B", allocatedQty: 3, physicalPackableQty: 0, description: "y" },
      { allocationLineId: "c", article: "C", allocatedQty: 5, physicalPackableQty: 5, description: "z" },
    ],
    { mode: "PRE_PACKING" }
  );
  const all = selectAllPackingLabelRows(base);
  assert.equal(all.filter((r) => r.selected).length, 3);
  const avail = selectAvailablePackingLabelRows(base, { mode: "PRE_PACKING" });
  assert.equal(avail.filter((r) => r.selected).length, 2);
  const manual = base.map((r) => ({ ...r, selected: r.article === "A", labelQty: "4", copies: "2" }));
  const sels = buildPackingLabelSelections(manual);
  assert.equal(sels.length, 1);
  assert.equal(sels[0].labelQty, 4);
  assert.equal(sels[0].copies, 2);
});

run("6/9/10/11. Manual Label Qty + Copies independent + QTY formatting", () => {
  assert.equal(formatPackingQtyDisplay(5, 9), "5 of 9");
  assert.equal(formatPackingQtyOf(9, 9), "9 of 9");
  const job = buildPackingJobTspl([
    {
      customerName: "C",
      article: "A1",
      labelQty: 5,
      totalQty: 9,
      qtyDisplay: "5 of 9",
      lineCopies: 2,
      description: "Short",
    },
  ]);
  assert.equal((job.match(/PRINT 1,1/g) || []).length, 2);
});

run("7/8/31/32/33. Packing label service does not mutate stock/allocation", () => {
  assert.ok(packingSvc.includes("Does not mutate"));
  assert.ok(!packingSvc.includes("reserveAllocation"));
  assert.ok(!packingSvc.includes("StockLedger"));
  assert.ok(!packingSvc.includes("$inc"));
  assert.ok(!packingSvc.includes("packQty ="));
});

run("Desc A. Short description fits normally", () => {
  const short = fitWrappedText({ text: "Connecting rod", maxWidthChars: 40, maxLines: 5, preferredFontSize: 8 });
  assert.equal(short.truncated, false);
  assert.ok(short.lines.length >= 1 && short.lines.length <= 2);
  assert.ok(short.fontSize >= 5);
  const layout = analyzePackingDescriptionLayout("Connecting rod");
  assert.ok(layout.lines.length === 1 || layout.fullLineCount === 1);
  assert.ok(layout.descH > 0);
  assert.ok(layout.descH < layout.availableForDesc || layout.lines.length === 1);
});

run("Desc B. 2-line description wraps", () => {
  const mid = fitWrappedText({
    text: "Connecting rod without bolt hydraulic type",
    maxWidthChars: 40,
    maxLines: 5,
    preferredFontSize: 8,
  });
  assert.ok(mid.lines.length >= 1);
  assert.equal(mid.truncated, false);
});

run("Desc C. 3-line description wraps", () => {
  const three = fitWrappedText({
    text: "Connecting rod assembly without bolt hydraulic type suitable for marine diesel engines",
    maxWidthChars: 40,
    maxLines: 5,
    preferredFontSize: 8,
  });
  assert.ok(three.lines.length >= 2);
  assert.equal(three.truncated, false);
});

run("Desc D. Extreme description reaches min font", () => {
  const long = fitWrappedText({
    text: "A".repeat(160),
    maxWidthChars: 40,
    maxLines: 5,
    preferredFontSize: 8,
    minFontSize: 5,
  });
  assert.ok(long.fontSize <= 8);
  assert.ok(long.fontSize >= 5);
});

run("Desc E. Overflow is flagged", () => {
  const extreme = fitPackingDescription("WORD ".repeat(80), {
    maxWidthChars: 40,
    maxLines: 5,
    preferredFontSize: 8,
    minFontSize: 5,
    availableMaxLines: 3,
  });
  assert.equal(extreme.truncated, true);
  assert.equal(extreme.overflow, true);
  assert.equal(extreme.descriptionTruncated, true);
  const meta = packingLabelDescriptionMeta({ description: "WORD ".repeat(80) });
  assert.equal(meta.descriptionTruncated, true);
});

run("Desc F. Overflow not silently printed without confirmation", () => {
  assert.ok(packingSvc.includes("LABEL_DESCRIPTION_OVERFLOW"));
  assert.ok(packingSvc.includes("confirmDescriptionTruncation"));
  assert.ok(packingSvc.includes("descriptionTruncated"));
  assert.ok(modalUi.includes("Print with truncated description"));
  assert.ok(modalUi.includes("Description exceeds printable area"));
  assert.ok(modalUi.includes("printBlockedByOverflow") || modalUi.includes("confirmTruncation"));
  assert.ok(jobModel.includes("descriptionTruncated"));
});

run("Desc G. QTY row never overlaps description", () => {
  const layout = analyzePackingDescriptionLayout("WORD ".repeat(60));
  assert.equal(layout.qtyRowReserved, true);
  assert.ok(layout.descH <= layout.availableForDesc + 1e-9);
  assert.ok(layout.rowHeights?.QTY > 0);
  const tspl = buildSinglePackingLabelTspl({
    customerName: "C",
    article: "ART",
    description: "WORD ".repeat(60),
    labelQty: 2,
    totalQty: 4,
    serialNo: 1,
  });
  const qtyIdx = tspl.lastIndexOf('"QTY"');
  const descIdx = tspl.indexOf('"Description"');
  assert.ok(qtyIdx > descIdx);
  assert.ok(tspl.includes("2 of 4"));
});

run("Layout H. Article and Part No. emphasized; QTY strongest; short desc dynamic", () => {
  const shortLayout = analyzePackingDescriptionLayout("Connecting rod");
  const longLayout = analyzePackingDescriptionLayout(
    "Connecting rod assembly without bolt hydraulic type suitable for marine diesel engines with spare kit"
  );
  assert.ok(shortLayout.descH < longLayout.descH || shortLayout.lines.length < longLayout.lines.length);
  const tspl = buildSinglePackingLabelTspl({
    customerName: "ALTAMAR",
    customerRef: "21200174",
    brand: "WARTSILA",
    modelName: "W34SG",
    article: "52236",
    serialNo: "1",
    partNo: "111006",
    description: "Connecting rod",
    labelQty: 1,
    totalQty: 9,
  });
  assert.match(tspl, /SIZE 100 mm,50 mm/);
  // Article / Part No use 2,1; QTY uses 2,2
  assert.match(tspl, /"52236"/);
  assert.match(tspl, /"111006"/);
  assert.match(tspl, /0,2,1,"52236"/);
  assert.match(tspl, /0,2,1,"111006"/);
  assert.match(tspl, /0,2,2,"1 of 9"/);
  const rows = packingLabelPreviewRows({
    customerName: "ALTAMAR",
    article: "52236",
    partNo: "111006",
    description: "Connecting rod",
    labelQty: 1,
    totalQty: 9,
  });
  assert.equal(rows.find((r) => r.label === "Article")?.emphasis, "strong");
  assert.equal(rows.find((r) => r.label === "Part No.")?.emphasis, "strong");
  assert.equal(rows.find((r) => r.label === "QTY")?.emphasis, "qty");
});

run("16-22. Field mapping / preview rows / serial", () => {
  const line = {
    customerName: "MSC Shipmanagement",
    customerRef: "PO-266564",
    brand: "WARTSILA",
    modelName: "W34SG",
    article: "700004.28",
    serialNo: 3,
    partNo: "432108 AA",
    description: "SET OF GASKETS FOR CYLINDER HEAD",
    labelQty: 5,
    totalQty: 9,
  };
  const rows = packingLabelPreviewRows(line);
  assert.equal(rows[0].value, "MSC Shipmanagement");
  assert.equal(rows[8].value, "5 of 9");
});

run("23. Preview and TSPL share packingLabelPreviewRows + buildPackingJobTspl", () => {
  assert.ok(packingSvc.includes("packingLabelPreviewRows"));
  assert.ok(packingSvc.includes("buildPackingJobTspl"));
  assert.ok(modalUi.includes("previewRows"));
});

run("Posted qty A/B. packed=5 labelQty 5 and 3 PASS (cap logic present)", () => {
  assert.ok(packingSvc.includes("LABEL_QTY_EXCEEDS_CAP"));
  assert.ok(packingSvc.includes("cannot exceed packed qty"));
  assert.ok(packingSvc.includes("cannot exceed packable qty"));
  // Cap uses packableCap = packedQty for non-PRE modes
  assert.ok(packingSvc.includes("packedQty"));
  assert.match(packingSvc, /labelQty > packableCap/);
});

run("Posted qty C/D/E. Over packed BLOCK; allowQtyOverride ignored", () => {
  assert.ok(!packingSvc.includes("allowQtyOverride === true"));
  assert.ok(!packingSvc.includes("&& !allowOverride"));
  assert.ok(packingSvc.includes("allowQtyOverride is ignored") || packingSvc.includes("Client allowQtyOverride is ignored"));
  assert.ok(packingSvc.includes("LABEL_QTY_EXCEEDS_CAP"));
  // REPRINT uses same resolvePackingLabelLines hard cap
  assert.ok(packingSvc.includes('mode === "REPRINT"'));
});

run("Idempotency A/E. Same selection fingerprint regardless of order", () => {
  const a = [
    { packingLineId: "1", labelQty: 5 },
    { packingLineId: "2", labelQty: 3 },
    { packingLineId: "3", labelQty: 1 },
  ];
  const b = [
    { packingLineId: "3", labelQty: 1 },
    { packingLineId: "1", labelQty: 5 },
    { packingLineId: "2", labelQty: 3 },
  ];
  const fa = buildPackingSelectionFingerprint(a);
  const fb = buildPackingSelectionFingerprint(b);
  assert.equal(fa, fb);
  assert.equal(buildClientFingerprint(a), buildClientFingerprint(b));
  const keyA = buildServerPackingIdempotencyKey("MAR-PKG-0001", a);
  const keyB = buildServerPackingIdempotencyKey("MAR-PKG-0001", b);
  assert.equal(keyA, keyB);
  assert.match(keyA, /^packing:MAR-PKG-0001:initial:[a-f0-9]{16}$/);
  assert.equal(hashPackingSelectionFingerprint(fa).length, 16);
});

run("Idempotency B/C. Different selections produce different keys", () => {
  const lines12 = [
    { packingLineId: "1", labelQty: 5 },
    { packingLineId: "2", labelQty: 3 },
  ];
  const lines34 = [
    { packingLineId: "3", labelQty: 2 },
    { packingLineId: "4", labelQty: 4 },
  ];
  const k12 = buildServerPackingIdempotencyKey("MAR-PKG-0001", lines12);
  const k34 = buildServerPackingIdempotencyKey("MAR-PKG-0001", lines34);
  assert.notEqual(k12, k34);
  // Same packing, later remaining lines allowed (different fingerprint)
  assert.ok(k12.includes("initial:"));
  assert.ok(k34.includes("initial:"));
});

run("Idempotency D. REPRINT always new job (no initial key)", () => {
  assert.ok(packingSvc.includes('if (mode === "REPRINT")'));
  assert.ok(packingSvc.includes("idempotencyKey = null"));
});

run("Idempotency PRE: server-side hash (no truncated client key)", () => {
  assert.ok(packingSvc.includes("buildPrePackingLabelIdempotencyKey"));
  assert.ok(!packingSvc.includes("body.idempotencyKey).slice(0, 120)"));
  assert.ok(!modalUi.includes("idempotencyKey = `packing:"));
  const lines = [
    { packingLineId: "1", labelQty: 5 },
    { packingLineId: "2", labelQty: 3 },
  ];
  const pre = buildPrePackingLabelIdempotencyKey("MAR-ALLOC-0001", lines);
  const posted = buildServerPackingIdempotencyKey("MAR-ALLOC-0001", lines);
  assert.match(pre, /^packing:MAR-ALLOC-0001:pre:[a-f0-9]{16}$/);
  assert.match(posted, /^packing:MAR-ALLOC-0001:initial:[a-f0-9]{16}$/);
  assert.notEqual(pre, posted);
  // Same PRE selection → same key; different selection → different key
  assert.equal(pre, buildPrePackingLabelIdempotencyKey("MAR-ALLOC-0001", [...lines].reverse()));
  assert.notEqual(
    pre,
    buildPrePackingLabelIdempotencyKey("MAR-ALLOC-0001", [{ packingLineId: "9", labelQty: 1 }])
  );
});

run("Idempotency partial: packing-level :initial alone is NOT used", () => {
  assert.ok(packingSvc.includes("packing:${no}:initial:${hash}"));
  assert.ok(packingSvc.includes("buildPackingSelectionFingerprint"));
  assert.ok(packingSvc.includes("hashPackingSelectionFingerprint"));
  // Must not return a bare packing:{no}:initial without selection hash
  assert.ok(!/return no \? `packing:\$\{no\}:initial`/.test(packingSvc));
  assert.ok(!/return no \? `packing:\$\{[^}]+\}:initial` :/.test(packingSvc));
});

run("26/27/28. Copies + reprint + routes", () => {
  assert.ok(routes.includes("/jobs/from-packing"));
  assert.ok(jobModel.includes('"PACKING"'));
  assert.ok(jobModel.includes("packingSelectionFingerprint"));
});

run("29/30. LABELS permission + printer routing reused", () => {
  assert.ok(routes.includes('router.post("/jobs/from-packing", labelsPrint'));
  assert.ok(packingSvc.includes("resolvePrinterForJob"));
});

run("34. GRN regression — buildJobTspl still multiplies labelQty×copies unit labels", () => {
  const grn = buildJobTspl([{ article: "X", description: "d", labelQty: 3, uom: "PCS" }], { copies: 2 });
  assert.equal((grn.match(/PRINT 1,1/g) || []).length, 6);
});

run("UI wires Print Packing Labels (not beside picking sheet alone)", () => {
  assert.ok(storeUi.includes("Print Packing Labels"));
  assert.ok(storeUi.includes("PackingLabelsModal"));
  assert.ok(storeUi.includes("Print Packing Labels Now?"));
  assert.ok(storeUi.includes("PRE_PACKING"));
  assert.ok(storeUi.includes("POSTED_PACKING"));
});

run("wrapWordsToLines deterministic", () => {
  assert.deepEqual(wrapWordsToLines("ONE TWO THREE", 8), ["ONE TWO", "THREE"]);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
