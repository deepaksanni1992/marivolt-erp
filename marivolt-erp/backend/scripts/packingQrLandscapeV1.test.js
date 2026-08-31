/**
 * PACKING_QR_LANDSCAPE_150X100_V1 — Phase 1 geometry, preview, print-guard.
 * Run: node scripts/packingQrLandscapeV1.test.js
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PACKING_STANDARD_TEMPLATE_CODE,
  MARIVOLT_STANDARD_TEMPLATE_CODE,
  LABEL_WIDTH_MM,
  LABEL_HEIGHT_MM,
} from "../src/services/label/labelTemplateService.js";
import {
  buildSingleLabelTspl,
  buildSinglePackingLabelTspl,
  getFixedLabelSize,
} from "../src/services/label/tsplGenerator.js";
import {
  PHYSICAL_WIDTH_DOTS,
  PHYSICAL_HEIGHT_DOTS,
  PHYSICAL_MARGIN_LEFT,
  PHYSICAL_MARGIN_RIGHT,
  PHYSICAL_MARGIN_TOP,
  PHYSICAL_MARGIN_BOTTOM,
  PHYSICAL_SAFE,
  LOGICAL_SAFE,
  LOGICAL_WIDTH_DOTS,
  LOGICAL_HEIGHT_DOTS,
  QR_ECC,
  QR_PLACEHOLDER_MARK,
  SAMPLE_PACKING_QR_LANDSCAPE_V1_DATA,
  PACKING_QR_LANDSCAPE_V1_CODE,
  PACKING_QR_LANDSCAPE_V1_PRINT_HINT,
  PACKING_QR_LANDSCAPE_V1_TABLE,
  LABEL_QR_PAYLOAD_OVERFLOW,
  MAR1_KEY_ID_MAX,
  MAR1_KEY_ID_MIN,
  MAR1_LABEL_NO_MAX,
  MAR1_LABEL_NO_MIN,
  MAR1_MAX_PAYLOAD_BYTES,
  MAR1_SIGNATURE_B64URL_EXAMPLE,
  MAR1_PRODUCTION_QR_SPEC,
  analyzeMar1HmacQrGeometry,
  assertPackingQrLandscapeV1Printable,
  buildMar1TokenExample,
  faceDataFromPackingLine,
  layoutPackingQrLandscapeV1,
  layoutToSvg,
  logicalToPhysicalPoint,
  packingQrLandscapeV1Capabilities,
  packingQrLandscapeV1CoordinateRows,
  packingQrLandscapeV1SafeCornersLogical,
  packingQrLandscapeV1SafeCornersPhysical,
  packingQrLandscapeV1TemplateDocument,
  reservedMar1QrGeometry,
  validateMar1ProductionQrToken,
  wrapWordsExact,
} from "../src/services/label/packingQrLandscapeV1.js";
import {
  resolveRequestedPackingTemplateCode,
} from "../src/services/label/packingLabelService.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.join(__dirname, "..");
const srcRoot = path.join(backendRoot, "src");
const frontendRoot = path.join(backendRoot, "..", "src");

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

function boxesOverlap(a, b) {
  return a.x < b.x1 && a.x1 > b.x && a.y < b.y1 && a.y1 > b.y;
}

console.log("\nPACKING_QR_LANDSCAPE_150X100_V1 Phase 1\n");

const sample = layoutPackingQrLandscapeV1(SAMPLE_PACKING_QR_LANDSCAPE_V1_DATA);
const packingSvc = fs.readFileSync(path.join(srcRoot, "services", "label", "packingLabelService.js"), "utf8");
const reprintSrc = fs.readFileSync(path.join(srcRoot, "services", "label", "labelService.js"), "utf8");
const tsplSrc = fs.readFileSync(path.join(srcRoot, "services", "label", "tsplGenerator.js"), "utf8");
const customSrc = fs.readFileSync(path.join(srcRoot, "services", "label", "customPackingLabelService.js"), "utf8");
const asnSrc = fs.readFileSync(path.join(srcRoot, "services", "label", "asnLabelService.js"), "utf8");
const templateSvc = fs.readFileSync(path.join(srcRoot, "services", "label", "labelTemplateService.js"), "utf8");
const v1Src = fs.readFileSync(path.join(srcRoot, "services", "label", "packingQrLandscapeV1.js"), "utf8");
const modalUi = fs.readFileSync(path.join(frontendRoot, "components", "store", "PackingLabelsModal.jsx"), "utf8");
const previewUi = fs.readFileSync(
  path.join(frontendRoot, "components", "store", "PackingQrLandscapePreview.jsx"),
  "utf8"
);
const customModal = fs.readFileSync(
  path.join(frontendRoot, "components", "store", "CustomPackingLabelModal.jsx"),
  "utf8"
);

run("1. Physical canvas exactly 800 × 1200", () => {
  assert.equal(PHYSICAL_WIDTH_DOTS, 800);
  assert.equal(PHYSICAL_HEIGHT_DOTS, 1200);
  assert.equal(sample.canvas.physical.w, 800);
  assert.equal(sample.canvas.physical.h, 1200);
  assert.deepEqual(sample.canvas.physical.sizeMm, [100, 150]);
  assert.equal(sample.canvas.dotsPerMm, 8);
});

run("2. Safe physical margins exactly 80/80/120/120 dots", () => {
  assert.equal(PHYSICAL_MARGIN_LEFT, 80);
  assert.equal(PHYSICAL_MARGIN_RIGHT, 80);
  assert.equal(PHYSICAL_MARGIN_TOP, 120);
  assert.equal(PHYSICAL_MARGIN_BOTTOM, 120);
  assert.equal(PHYSICAL_SAFE.x, 80);
  assert.equal(PHYSICAL_SAFE.x1, 720);
  assert.equal(PHYSICAL_SAFE.y, 120);
  assert.equal(PHYSICAL_SAFE.y1, 1080);
  assert.equal(PHYSICAL_SAFE.w, 640);
  assert.equal(PHYSICAL_SAFE.h, 960);
});

run("3. Logical safe content exactly 960 × 640 dots", () => {
  assert.equal(LOGICAL_WIDTH_DOTS, 1200);
  assert.equal(LOGICAL_HEIGHT_DOTS, 800);
  assert.equal(LOGICAL_SAFE.w, 960);
  assert.equal(LOGICAL_SAFE.h, 640);
  assert.equal(LOGICAL_SAFE.x, 120);
  assert.equal(LOGICAL_SAFE.y, 80);
  assert.equal(LOGICAL_SAFE.x1, 1080);
  assert.equal(LOGICAL_SAFE.y1, 720);
  assert.equal(sample.canvas.viewBox, "0 0 1200 800");
  assert.ok(sample.leftColumnEndY <= LOGICAL_SAFE.y1);
});

run("4. CW transformation of all four safe corners", () => {
  const logical = packingQrLandscapeV1SafeCornersLogical();
  const physical = packingQrLandscapeV1SafeCornersPhysical();
  assert.deepEqual(logicalToPhysicalPoint(120, 80), { x: 720, y: 120 });
  assert.deepEqual(logicalToPhysicalPoint(1080, 80), { x: 720, y: 1080 });
  assert.deepEqual(logicalToPhysicalPoint(120, 720), { x: 80, y: 120 });
  assert.deepEqual(logicalToPhysicalPoint(1080, 720), { x: 80, y: 1080 });
  assert.deepEqual(physical.topLeft, { x: 720, y: 120 });
  assert.deepEqual(physical.topRight, { x: 720, y: 1080 });
  assert.deepEqual(physical.bottomLeft, { x: 80, y: 120 });
  assert.deepEqual(physical.bottomRight, { x: 80, y: 1080 });
  assert.equal(logical.topLeft.x, 120);
});

run("5. Every primitive remains within safe physical bounds", () => {
  assert.equal(sample.ok, true, JSON.stringify(sample.errors));
  for (const p of sample.primitives) {
    assert.ok(p.logical.x >= LOGICAL_SAFE.x, `${p.id} logical x`);
    assert.ok(p.logical.x1 <= LOGICAL_SAFE.x1, `${p.id} logical x1`);
    assert.ok(p.logical.y >= LOGICAL_SAFE.y, `${p.id} logical y`);
    assert.ok(p.logical.y1 <= LOGICAL_SAFE.y1, `${p.id} logical y1`);
    assert.ok(p.physical.x >= PHYSICAL_SAFE.x, `${p.id} physical x`);
    assert.ok(p.physical.x1 <= PHYSICAL_SAFE.x1, `${p.id} physical x1`);
    assert.ok(p.physical.y >= PHYSICAL_SAFE.y, `${p.id} physical y`);
    assert.ok(p.physical.y1 <= PHYSICAL_SAFE.y1, `${p.id} physical y1`);
  }
});

run("6. Glyph extents remain within bounds", () => {
  const glyphs = sample.primitives.filter((p) => p.type === "text");
  assert.ok(glyphs.length > 0);
  for (const g of glyphs) {
    const expectedW = String(g.value || "").length * (g.xMul || 1) * 12;
    assert.equal(g.logical.w, expectedW, `${g.id} glyph width`);
    assert.equal(g.logical.h, (g.yMul || 1) * 24, `${g.id} glyph height`);
    assert.ok(g.logical.x1 <= LOGICAL_SAFE.x1, `${g.id} glyph x1`);
    assert.ok(g.logical.y1 <= LOGICAL_SAFE.y1, `${g.id} glyph y1`);
  }
});

run("7. BOX/BAR endpoints transform correctly", () => {
  const outer = sample.primitives.find((p) => p.id === "outer-box");
  const qrBar = sample.primitives.find((p) => p.id === "col-qr");
  const headerBar = sample.primitives.find((p) => p.id === "row-ref");
  assert.equal(outer.logical.x, 122);
  assert.equal(outer.logical.y, 82);
  assert.equal(outer.logical.w, 956);
  assert.equal(outer.logical.h, 636);
  assert.equal(outer.thickness, 2);
  assert.ok(outer.logical.x > LOGICAL_SAFE.x);
  assert.ok(outer.logical.x1 < LOGICAL_SAFE.x1);
  assert.equal(outer.physical.x, 82);
  assert.equal(outer.physical.y, 122);
  assert.equal(outer.physical.w, 636);
  assert.equal(outer.physical.h, 956);
  assert.ok(outer.physical.x > PHYSICAL_SAFE.x);
  assert.ok(outer.physical.x1 < PHYSICAL_SAFE.x1);
  assert.equal(qrBar.logical.x, 778);
  assert.equal(qrBar.logical.y, 310);
  assert.equal(qrBar.logical.h, 312);
  assert.equal(qrBar.logical.w, 2);
  assert.equal(headerBar.logical.y, 166);
  assert.equal(headerBar.logical.w, 956);
  assert.ok(qrBar.logical.y > headerBar.logical.y);
});

run("8. No layout overlap", () => {
  assert.ok(!sample.errorCodes.includes("LABEL_GEOMETRY_OVERLAP"), JSON.stringify(sample.errors));
  const texts = sample.primitives.filter((p) => p.type === "text");
  for (let i = 0; i < texts.length; i += 1) {
    for (let j = i + 1; j < texts.length; j += 1) {
      const a = texts[i];
      const b = texts[j];
      if (a.field === b.field) continue;
      if (a.field.endsWith("_LABEL") || b.field.endsWith("_LABEL")) continue;
      if (a.field === "HEADER" && b.field === "HEADER") continue;
      if (a.field.startsWith("LABEL_ID") && b.field.startsWith("LABEL_ID")) continue;
      if (a.field === "QR_TEST_MARK" || b.field === "QR_TEST_MARK") continue;
      assert.equal(boxesOverlap(a.logical, b.logical), false, `${a.id} overlaps ${b.id}`);
    }
  }
});

run("9. QR including quiet zone remains square and in bounds", () => {
  const qr = sample.qr;
  assert.equal(qr.logical.w, qr.logical.h);
  assert.equal(qr.inner.w, qr.inner.h);
  assert.equal(qr.quiet * 2 + qr.inner.w, qr.logical.w);
  assert.equal(qr.cellDots, Math.floor(qr.cellDots));
  assert.equal(qr.cellDots, 6);
  assert.equal(qr.geometry.moduleCount, 37);
  assert.equal(qr.inner.w, qr.geometry.moduleCount * qr.cellDots);
  assert.equal(qr.modules.size, 25);
  assert.equal(qr.rendered.w, qr.modules.size * qr.cellDots);
  assert.ok(qr.rendered.x >= qr.inner.x);
  assert.ok(qr.rendered.y >= qr.inner.y);
  assert.ok(qr.rendered.x + qr.rendered.w <= qr.inner.x + qr.inner.w);
  assert.ok(qr.rendered.y + qr.rendered.h <= qr.inner.y + qr.inner.h);
  assert.equal(qr.quietModules, 4);
  assert.equal(qr.ecc, QR_ECC);
  assert.equal(qr.placeholder, true);
  assert.equal(qr.identity, null);
  assert.equal(qr.validIdentity, false);
  assert.equal(qr.mark, QR_PLACEHOLDER_MARK);
  assert.equal(qr.logical.w, 270);
  assert.ok(qr.logical.w >= 240 && qr.logical.w <= 280);
  assert.equal(qr.tsplQrcode.includesQuietZone, false);
  const quietPrim = sample.primitives.find((p) => p.id === "qr-quiet");
  assert.equal(quietPrim.physical.w, quietPrim.physical.h);
  const texts = sample.primitives.filter((p) => p.type === "text");
  for (const t of texts) {
    assert.equal(boxesOverlap(t.logical, qr.logical), false, `${t.id} overlaps QR quiet`);
  }
  assert.ok(texts.some((t) => t.field === "QR_TEST_CAPTION"));
  assert.ok(!texts.some((t) => t.field === "QR_TEST_MARK"));
});

run("9b. MAR1 Base64URL token sizes the reserved QR, not TEST/PREVIEW", () => {
  const mar1 = analyzeMar1HmacQrGeometry();
  const locked = reservedMar1QrGeometry();
  assert.equal(mar1.spec.tokenForm, "MAR1.<labelNo>.<keyId>.<signatureBase64Url>");
  assert.equal(mar1.spec.algorithm, "HMAC-SHA256");
  assert.equal(mar1.spec.doNotReduceBelowBits, 128);
  assert.equal(mar1.spec.overflowCode, LABEL_QR_PAYLOAD_OVERFLOW);
  assert.equal(mar1.spec.maxPayloadBytes, 47);
  assert.equal(mar1.spec.labelNoPattern, "^MAR-PL-[0-9]{1,8}$");
  assert.equal(mar1.spec.keyIdPattern, "^K[0-9]{1,2}$");
  assert.equal(mar1.typical.payloadChars, 44);
  assert.equal(mar1.longestRealistic.payloadChars, 47);
  assert.equal(mar1.typical.qrVersion, 5);
  assert.equal(mar1.longestRealistic.qrVersion, 5);
  assert.equal(mar1.longestRealistic.moduleCount, 37);
  assert.equal(mar1.reserved.sizedFrom, "MAR1_PRODUCTION_QR_SPEC");
  assert.equal(mar1.reserved.cellDots, 6);
  assert.equal(mar1.reserved.outerDots, 270);
  assert.equal(mar1.reserved.outerMm, 33.75);
  assert.equal(mar1.reserved.quietModules, 4);
  assert.equal(locked.moduleCount, 37);
  assert.equal(locked.cellDots, 6);
  assert.equal(locked.quietDots, 24);
  assert.equal(locked.outerDots, 270);
  assert.equal(mar1.phase1TestPreview.qrVersion, 2);
  assert.equal(mar1.phase1TestPreview.moduleCount, 25);
  assert.notEqual(mar1.phase1TestPreview.moduleCount, mar1.reserved.moduleCount);
  assert.equal(mar1.tsplQrcode.includesQuietZone, false);
  assert.ok(!mar1.spec.notInQr.includes("labelNo"));
  assert.ok(mar1.spec.notInQr.includes("article"));
  assert.ok(!v1Src.includes("createHmac"));
  assert.ok(!sample.qr.modules.payload.includes("MAR1."));
  assert.equal(sample.qr.productionToken.present, false);
});

run("9c. MAR1 production token capacity validation", () => {
  const sig = MAR1_SIGNATURE_B64URL_EXAMPLE;
  const shortest = buildMar1TokenExample(MAR1_LABEL_NO_MIN, MAR1_KEY_ID_MIN, sig);
  const maximum = buildMar1TokenExample(MAR1_LABEL_NO_MAX, MAR1_KEY_ID_MAX, sig);
  const eightDigit = buildMar1TokenExample("MAR-PL-12345678", "K1", sig);
  const nineDigit = buildMar1TokenExample("MAR-PL-123456789", "K99", sig);
  const k99 = buildMar1TokenExample("MAR-PL-1", MAR1_KEY_ID_MAX, sig);
  const k100 = buildMar1TokenExample("MAR-PL-1", "K100", sig);
  const invalidB64 = buildMar1TokenExample("MAR-PL-1", "K1", "xY7+k2LmN9pQrStUvWx/zA");
  const padded = buildMar1TokenExample("MAR-PL-1", "K1", `${sig}==`);
  const nonAscii = `MAR1.MAR-PL-1.K1.${sig.slice(0, 21)}é`;
  const over48 = `${maximum}X`;

  const shortestV = validateMar1ProductionQrToken(shortest);
  assert.equal(shortestV.ok, true, JSON.stringify(shortestV.errors));
  assert.ok(shortestV.payloadBytes < MAR1_MAX_PAYLOAD_BYTES);

  const maxV = validateMar1ProductionQrToken(maximum);
  assert.equal(maxV.ok, true, JSON.stringify(maxV.errors));
  assert.equal(maxV.payloadBytes, 47);
  assert.equal(maxV.measured.version, 5);
  assert.equal(maxV.measured.size, 37);
  assert.equal(maxV.reserved.cellDots, 6);
  assert.equal(maxV.reserved.outerDots, 270);
  assert.equal(maxV.adapted, false);

  const eightV = validateMar1ProductionQrToken(eightDigit);
  assert.equal(eightV.ok, true, JSON.stringify(eightV.errors));
  assert.equal(eightV.labelNo, "MAR-PL-12345678");

  const nineV = validateMar1ProductionQrToken(nineDigit);
  assert.equal(nineV.ok, false);
  assert.ok(nineV.errorCodes.includes(LABEL_QR_PAYLOAD_OVERFLOW));
  assert.ok(nineV.errors.some((e) => e.field === "labelNo"));

  const k99V = validateMar1ProductionQrToken(k99);
  assert.equal(k99V.ok, true, JSON.stringify(k99V.errors));

  const k100V = validateMar1ProductionQrToken(k100);
  assert.equal(k100V.ok, false);
  assert.ok(k100V.errorCodes.includes(LABEL_QR_PAYLOAD_OVERFLOW));
  assert.ok(k100V.errors.some((e) => e.field === "keyId"));

  const invalidV = validateMar1ProductionQrToken(invalidB64);
  assert.equal(invalidV.ok, false);
  assert.ok(invalidV.errorCodes.includes(LABEL_QR_PAYLOAD_OVERFLOW));
  assert.ok(invalidV.errors.some((e) => e.field === "signature"));

  const paddedV = validateMar1ProductionQrToken(padded);
  assert.equal(paddedV.ok, false);
  assert.ok(paddedV.errorCodes.includes(LABEL_QR_PAYLOAD_OVERFLOW));
  assert.ok(paddedV.errors.some((e) => e.field === "signature"));

  const nonAsciiV = validateMar1ProductionQrToken(nonAscii);
  assert.equal(nonAsciiV.ok, false);
  assert.ok(nonAsciiV.errorCodes.includes(LABEL_QR_PAYLOAD_OVERFLOW));
  assert.ok(nonAsciiV.errors.some((e) => /ASCII/i.test(e.message)));

  const ok47 = validateMar1ProductionQrToken(maximum);
  assert.equal(ok47.payloadBytes, 47);
  assert.equal(ok47.ok, true);

  assert.equal(Buffer.byteLength(over48, "utf8"), 48);
  const overV = validateMar1ProductionQrToken(over48);
  assert.equal(overV.ok, false);
  assert.equal(overV.payloadBytes, 48);
  assert.ok(overV.errorCodes.includes(LABEL_QR_PAYLOAD_OVERFLOW));
  assert.equal(overV.adapted, false);
  assert.equal(overV.reserved.qrVersion, 5);
  assert.equal(overV.reserved.cellDots, 6);
  assert.equal(overV.reserved.quietDots, 24);
  assert.equal(overV.reserved.outerDots, 270);

  const layoutMax = layoutPackingQrLandscapeV1({
    ...SAMPLE_PACKING_QR_LANDSCAPE_V1_DATA,
    mar1QrToken: maximum,
  });
  assert.equal(layoutMax.ok, true, JSON.stringify(layoutMax.errors));
  assert.equal(layoutMax.printEnabled, false);
  assert.equal(layoutMax.qr.cellDots, 6);
  assert.equal(layoutMax.qr.logical.w, 270);
  assert.equal(layoutMax.qr.modules.payload, maximum);
  assert.equal(layoutMax.qr.modules.size, 37);
  assert.equal(layoutMax.qr.validIdentity, true);
  assert.equal(layoutMax.fields.labelId, null);

  const layoutOver = layoutPackingQrLandscapeV1({
    ...SAMPLE_PACKING_QR_LANDSCAPE_V1_DATA,
    mar1QrToken: over48,
  });
  assert.equal(layoutOver.ok, false);
  assert.ok(layoutOver.errorCodes.includes(LABEL_QR_PAYLOAD_OVERFLOW));
  assert.equal(layoutOver.printEnabled, false);
  assert.equal(layoutOver.qr.cellDots, 6);
  assert.equal(layoutOver.qr.logical.w, 270);
  assert.equal(layoutOver.qr.quietModules, 4);
  assert.equal(layoutOver.qr.ecc, QR_ECC);
  assert.equal(layoutOver.qr.modules.size, 25);
  assert.equal(MAR1_PRODUCTION_QR_SPEC.doNotAdapt.length, 5);
});

run("10. Customer wraps correctly to two lines", () => {
  const two = layoutPackingQrLandscapeV1({
    ...SAMPLE_PACKING_QR_LANDSCAPE_V1_DATA,
    customerName: "Mediterranean Shipping Company",
  });
  assert.equal(two.ok, true, JSON.stringify(two.errors));
  assert.deepEqual(two.customerLines, ["Mediterranean", "Shipping Company"]);
  assert.equal(two.customerLines.join(" "), "Mediterranean Shipping Company");
});

run("11. Customer wraps correctly to three lines", () => {
  assert.deepEqual(sample.customerLines, ["Mediterranean", "Shipping Company", "Cyprus"]);
  assert.equal(sample.customerLines.join(" "), SAMPLE_PACKING_QR_LANDSCAPE_V1_DATA.customerName);
  const wrap = wrapWordsExact("Mediterranean Shipping Company Cyprus", 20);
  assert.deepEqual(wrap.lines, ["Mediterranean", "Shipping Company", "Cyprus"]);
});

run("12. Overlong customer blocks preview/print", () => {
  const overflow = layoutPackingQrLandscapeV1({
    ...SAMPLE_PACKING_QR_LANDSCAPE_V1_DATA,
    customerName:
      "Supercalifragilisticexpialidocious Supercalifragilisticexpialidocious Supercalifragilisticexpialidocious Supercalifragilisticexpialidocious",
  });
  assert.equal(overflow.ok, false);
  assert.ok(overflow.errorCodes.includes("LABEL_CUSTOMER_OVERFLOW"));
  assert.equal(overflow.printEnabled, false);
  assert.ok(!JSON.stringify(overflow.customerLines).includes("…"));
  assert.ok(!JSON.stringify(overflow.customerLines).includes("..."));
});

run("13. Article never truncates", () => {
  const artPrims = sample.primitives.filter((p) => p.field === "ARTICLE");
  assert.ok(artPrims.length >= 1);
  assert.equal(artPrims.map((p) => p.value).join(""), "700004.28");
  assert.equal(sample.articleFit.overflow, false);
  const long = layoutPackingQrLandscapeV1({
    ...SAMPLE_PACKING_QR_LANDSCAPE_V1_DATA,
    article: "ABCDEFGHIJKLMNOPQRSTUVWXYZ-0123456789-EXTRA",
  });
  assert.equal(long.ok, false);
  assert.ok(long.errorCodes.includes("LABEL_ARTICLE_OVERFLOW"));
  assert.equal(long.fields.article, "ABCDEFGHIJKLMNOPQRSTUVWXYZ-0123456789-EXTRA");
  assert.ok(!JSON.stringify(long.fields).includes("…"));
});

run("14. Long description handling", () => {
  const d = layoutPackingQrLandscapeV1({
    ...SAMPLE_PACKING_QR_LANDSCAPE_V1_DATA,
    description:
      "Connecting rod assembly without bolt hydraulic type suitable for marine diesel engines with spare kit extra wording",
  });
  const descLines = d.primitives.filter((p) => p.field === "DESCRIPTION").map((p) => p.value);
  if (d.ok) {
    assert.ok(descLines.join(" ").includes("Connecting"));
    assert.ok(descLines.length <= 3);
  } else {
    assert.ok(d.errorCodes.includes("LABEL_DESCRIPTION_OVERFLOW"));
  }
  const extreme = layoutPackingQrLandscapeV1({
    ...SAMPLE_PACKING_QR_LANDSCAPE_V1_DATA,
    description: "WORD ".repeat(80).trim(),
  });
  assert.equal(extreme.ok, false);
  assert.ok(extreme.errorCodes.includes("LABEL_DESCRIPTION_OVERFLOW"));
});

run("15. Long vessel/plant handling", () => {
  assert.equal(sample.fields.vesselPlant, "");
  assert.equal(sample.fields.vesselPlantSourceMissing, true);
  const longVessel = layoutPackingQrLandscapeV1({
    ...SAMPLE_PACKING_QR_LANDSCAPE_V1_DATA,
    vesselPlant:
      "MV SUPERCALIFRAGILISTICEXPIALIDOCIOUS PLANTNAME SUPERCALIFRAGILISTICEXPIALIDOCIOUS",
  });
  if (longVessel.ok) {
    const lines = longVessel.primitives.filter((p) => p.field === "VESSEL_PLANT").map((p) => p.value);
    assert.ok(lines.length <= 2);
    assert.ok(lines.join(" ").includes("SUPERCALIFRAGILISTIC"));
  } else {
    assert.ok(longVessel.errorCodes.includes("LABEL_REFERENCE_OVERFLOW"));
  }
});

run("16. Part No., MV Ref and Customer PO remain complete", () => {
  const part = sample.primitives.filter((p) => p.field === "PART_NO").map((p) => p.value).join("");
  const mv = sample.primitives.filter((p) => p.field === "MV_REF").map((p) => p.value).join("");
  const po = sample.primitives.filter((p) => p.field === "CUSTOMER_PO").map((p) => p.value).join("");
  assert.equal(part, "432108 AA");
  assert.equal(mv, "MAR-ALLOC-0001");
  assert.equal(po, "PO-266564");
  const overflowPo = layoutPackingQrLandscapeV1({
    ...SAMPLE_PACKING_QR_LANDSCAPE_V1_DATA,
    customerPo: "CUSTOMERPOWITHOUTSPACESANDFARTOOLONGTOFITONONELINEATMINFONT",
  });
  assert.equal(overflowPo.ok, false);
  assert.ok(overflowPo.errorCodes.includes("LABEL_REFERENCE_OVERFLOW"));
});

run("17. Sequence renders as n of N", () => {
  assert.equal(sample.fields.sequence, "1 of 3");
  const seq = sample.primitives.filter((p) => p.field === "SEQUENCE").map((p) => p.value);
  assert.deepEqual(seq, ["1 of 3"]);
  assert.ok(!seq.some((v) => /S\.\s*No/i.test(v)));
});

run("17b. Table-style header, rows, QR cell and Label Qty hierarchy", () => {
  const T = PACKING_QR_LANDSCAPE_V1_TABLE;
  assert.equal(sample.table.x, 122);
  assert.equal(sample.table.y, 82);
  assert.equal(sample.table.x1, 1078);
  assert.equal(sample.table.y1, 718);
  const company = sample.primitives.find((p) => p.id === "header-company");
  assert.equal(company.value, "MARIVOLT FZE");
  assert.equal(company.xMul, 2);
  assert.equal(company.yMul, 2);
  const headerMid = T.x + Math.floor(T.w / 2);
  assert.ok(company.logical.x < headerMid);
  assert.ok(company.logical.x1 > headerMid);
  assert.ok(company.logical.y < T.yRef);
  assert.ok(!sample.primitives.some((p) => p.id === "col-qr" && p.logical.y < T.yMain));
  const qrBar = sample.primitives.find((p) => p.id === "col-qr");
  assert.equal(qrBar.logical.y, T.yMain);
  assert.equal(qrBar.logical.y + qrBar.logical.h, T.yFooter);
  const qr = sample.qr.logical;
  const qrCellPadL = qr.x - T.xQr;
  const qrCellPadR = T.x1 - qr.x1;
  assert.ok(Math.abs(qrCellPadL - qrCellPadR) <= 1);
  const qrCellPadT = qr.y - T.yMain;
  const qrCellPadB = T.yFooter - qr.y1;
  assert.ok(Math.abs(qrCellPadT - qrCellPadB) <= 1);
  assert.equal(qr.w, 270);
  const unusedBelowQr = T.yFooter - qr.y1;
  assert.ok(unusedBelowQr < 40, `unused QR-column below QR: ${unusedBelowQr}`);
  const bars = sample.primitives.filter((p) => p.type === "bar");
  const texts = sample.primitives.filter((p) => p.type === "text");
  for (const bar of bars) {
    for (const t of texts) {
      assert.equal(boxesOverlap(bar.logical, t.logical), false, `${bar.id} crosses ${t.id}`);
    }
    assert.equal(boxesOverlap(bar.logical, qr), false, `${bar.id} crosses QR quiet`);
  }
  const customerRow = { x: T.x, y: T.yCustomer, x1: T.xQr, y1: T.yArticle };
  for (const line of sample.primitives.filter((p) => p.field === "CUSTOMER")) {
    assert.ok(line.logical.x >= customerRow.x);
    assert.ok(line.logical.x1 <= customerRow.x1);
    assert.ok(line.logical.y >= customerRow.y);
    assert.ok(line.logical.y1 <= customerRow.y1);
  }
  const article = sample.primitives.find((p) => p.field === "ARTICLE");
  assert.equal(article.value, "700004.28");
  assert.equal(article.yMul, 2);
  assert.ok(article.xMul >= 2);
  const qty = sample.primitives.find((p) => p.field === "LABEL_QTY");
  assert.equal(qty.xMul, 3);
  assert.equal(qty.yMul, 2);
  assert.ok(qty.logical.y >= T.yFooterQty);
  assert.ok(qty.logical.y1 <= T.yEnd);
  const order = sample.primitives.find((p) => p.field === "ORDER_QTY");
  assert.ok(order.xMul >= 2);
  const seq = sample.primitives.find((p) => p.field === "SEQUENCE");
  assert.ok(seq.xMul >= 2);
  assert.equal(sample.printEnabled, false);
});

run("18. Preview uses the same layout result as the future TSPL path", () => {
  const svg = layoutToSvg(sample);
  assert.ok(svg.includes('viewBox="0 0 1200 800"'));
  for (const p of sample.primitives.filter((x) => x.type === "text")) {
    assert.ok(svg.includes(`x="${p.logical.x}"`), `${p.id} missing from SVG`);
  }
  const line = {
    customerName: SAMPLE_PACKING_QR_LANDSCAPE_V1_DATA.customerName,
    customerRef: SAMPLE_PACKING_QR_LANDSCAPE_V1_DATA.customerPo,
    brand: SAMPLE_PACKING_QR_LANDSCAPE_V1_DATA.brand,
    modelName: SAMPLE_PACKING_QR_LANDSCAPE_V1_DATA.modelName,
    article: SAMPLE_PACKING_QR_LANDSCAPE_V1_DATA.article,
    description: SAMPLE_PACKING_QR_LANDSCAPE_V1_DATA.description,
    partNo: SAMPLE_PACKING_QR_LANDSCAPE_V1_DATA.partNo,
    labelQty: 5,
    totalQty: 9,
    lineCopies: 3,
  };
  for (let seq = 1; seq <= 3; seq += 1) {
    const data = faceDataFromPackingLine(line, { sourceNo: "MAR-ALLOC-0001" }, {
      sequenceIndex: seq,
      sequenceTotal: 3,
    });
    data.previewLabelId = "PREVIEW";
    const layout = layoutPackingQrLandscapeV1(data);
    assert.equal(layout.printEnabled, false);
    assert.equal(layout.fields.sequence, `${seq} of 3`);
    assert.equal(layout.primitives.length, sample.primitives.length);
  }
  assert.ok(!tsplSrc.includes("PACKING_QR_LANDSCAPE_150X100_V1"));
  fs.writeFileSync(path.join(__dirname, "packingQrLandscapeV1.preview.svg"), svg);
});

run("19. Existing 100×50 geometry tests remain unchanged", () => {
  assert.equal(PACKING_STANDARD_TEMPLATE_CODE, "PACKING_STANDARD_100X50");
  assert.equal(LABEL_WIDTH_MM, 100);
  assert.equal(LABEL_HEIGHT_MM, 50);
  assert.equal(getFixedLabelSize().widthMm, 100);
  assert.equal(getFixedLabelSize().heightMm, 50);
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
  assert.ok(!tspl.includes("SIZE 100 mm,150 mm"));
  assert.ok(!tspl.includes("QRCODE"));
});

run("20. GRN / ASN RU / Custom Packing paths stay on 100×50", () => {
  const grn = buildSingleLabelTspl({
    article: "700004.28",
    description: "SET OF GASKETS",
    spn: "432108",
    labelQty: 5,
    uom: "PCS",
  });
  assert.ok(grn.includes("SIZE 100 mm,50 mm"));
  assert.ok(!customSrc.includes("PACKING_QR_LANDSCAPE_150X100_V1"));
  assert.ok(!asnSrc.includes("PACKING_QR_LANDSCAPE_150X100_V1"));
  assert.ok(!customModal.includes("PACKING_QR_LANDSCAPE"));
  assert.equal(MARIVOLT_STANDARD_TEMPLATE_CODE, "MARIVOLT_STANDARD");
});

run("21. Catalog and pre-mint layout stay print-disabled without identity", () => {
  assert.equal(sample.printEnabled, false);
  assert.equal(sample.requiresPersistentIdentity, true);
  assert.equal(sample.printBlockedCode, "LABEL_IDENTITY_REQUIRED");
  assert.equal(packingQrLandscapeV1Capabilities().printEnabled, false);
  let threw = null;
  try {
    assertPackingQrLandscapeV1Printable(PACKING_QR_LANDSCAPE_V1_CODE);
  } catch (e) {
    threw = e;
  }
  assert.ok(threw);
  assert.equal(threw.code, "LABEL_IDENTITY_REQUIRED");
  assert.equal(threw.statusCode, 409);
  assert.equal(threw.message, PACKING_QR_LANDSCAPE_V1_PRINT_HINT);
  assert.equal(resolveRequestedPackingTemplateCode({}), PACKING_STANDARD_TEMPLATE_CODE);
  assert.equal(
    resolveRequestedPackingTemplateCode({ templateCode: PACKING_QR_LANDSCAPE_V1_CODE }),
    PACKING_QR_LANDSCAPE_V1_CODE
  );
  assert.ok(packingSvc.includes("requireActivePackingLabelSigningKey"));
  assert.ok(packingSvc.includes("mintPackingLabelUnits"));
  assert.ok(!reprintSrc.includes("assertPackingQrLandscapeV1Printable(parent.templateCode)"));
  assert.ok(modalUi.includes("isLandscapePreview"));
  assert.ok(modalUi.includes("PACKING_QR_LANDSCAPE_V1_PRINT_HINT"));
  assert.ok(previewUi.includes("svg"));
});

run("22. Layout preview does not invent PackingLabelUnit identity", () => {
  assert.ok(!v1Src.includes("PackingLabelUnit.create"));
  assert.equal(sample.fields.labelId, null);
  assert.equal(sample.qr.identity, null);
  const data = faceDataFromPackingLine(
    { article: "A", customerName: "C", serialNo: 9, jobNo: "LBL1" },
    { sourceNo: "X" },
    { sequenceIndex: 2, sequenceTotal: 4 }
  );
  assert.ok(!Object.values(data).includes("MAR-PL-"));
  assert.equal(data.vesselPlant, "");
  assert.equal(packingQrLandscapeV1TemplateDocument().printEnabled, false);
  const listIdx = templateSvc.indexOf("export async function listTemplates");
  const next = templateSvc.indexOf("export async function", listIdx + 10);
  const listBlock = templateSvc.slice(listIdx, next);
  assert.ok(!listBlock.includes("ensurePackingQrLandscapeV1Template"));
});

run("UI opt-in only; 100×50 remains default", () => {
  assert.ok(modalUi.includes("PACKING_QR_LANDSCAPE_V1_UI_LABEL"));
  assert.ok(modalUi.includes("useState(PACKING_STANDARD_TEMPLATE_CODE)"));
  assert.ok(modalUi.includes("PackingLabelPreviewFace"));
  assert.ok(modalUi.includes("PackingQrLandscapePreview"));
});

run("Vessel/Plant is not sourced from engine/ESN/model", () => {
  const data = faceDataFromPackingLine(
    { article: "A", modelName: "W34SG", brand: "WARTSILA", engine: "WARTSILA 34", esn: "123" },
    { sourceNo: "MV" }
  );
  assert.equal(data.vesselPlant, "");
});

console.log("\nCoordinate table (sample):\n");
for (const row of packingQrLandscapeV1CoordinateRows(sample)) {
  if (row.type === "text" && String(row.field).endsWith("_LABEL")) continue;
  console.log(
    `${row.id.padEnd(22)} ${String(row.logicalX).padStart(4)},${String(row.logicalY).padStart(4)} ${String(row.logicalW).padStart(4)}×${String(row.logicalH).padStart(3)}  phys ${row.physicalMinX},${row.physicalMinY}–${row.physicalMaxX},${row.physicalMaxY}  ${row.value}`
  );
}

run("21b. Landscape print path requires an ACTIVE signing key before minting", () => {
  assert.ok(packingSvc.includes("requireActivePackingLabelSigningKey"));
  assert.ok(packingSvc.includes("LABEL_SIGNING_KEY_REQUIRED") || packingSvc.includes("requireActivePackingLabelSigningKey"));
  assert.ok(packingSvc.includes("createLandscapePackingLabelJobs"));
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
