/**
 * Unit tests for Document Snapshot Engine (no database required).
 * Run: node backend/scripts/documentSnapshotEngine.test.js
 */
import assert from "node:assert/strict";
import {
  lineArticlePartKey,
  applyConsumptionToWorkingLines,
  findOverOrderViolations,
} from "../src/services/documentSnapshot/quotationConsumptionService.js";
import {
  normalizeOALinesFromWorkingCopy,
  isOaWorkingCopyPayload,
} from "../src/services/documentSnapshot/documentSnapshotService.js";
import {
  validateOaLineFields,
  buildConsumptionBaseline,
  detectStaleConsumption,
} from "../src/services/documentSnapshot/oaCreateValidation.js";
import { buildSourceMetadataFromDocument, resolvePersistedSourceMetadata } from "../src/services/documentSnapshot/documentSourceMetadata.js";
import { copyRouteKey, normalizeDocumentType, DOC_TYPES } from "../src/services/documentSnapshot/documentTypes.js";
import { getCopyRoute } from "../src/services/documentSnapshot/documentSnapshotRegistry.js";

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

console.log("\nDocument Snapshot Engine — unit tests\n");

run("normalizeDocumentType aliases", () => {
  assert.equal(normalizeDocumentType("oa"), DOC_TYPES.ORDER_ACKNOWLEDGEMENT);
  assert.equal(normalizeDocumentType("quotation"), DOC_TYPES.QUOTATION);
});

run("copyRouteKey", () => {
  assert.equal(copyRouteKey("QUOTATION", "ORDER_ACKNOWLEDGEMENT"), "QUOTATION:ORDER_ACKNOWLEDGEMENT");
});

run("getCopyRoute for quotation→oa", () => {
  const route = getCopyRoute(DOC_TYPES.QUOTATION, DOC_TYPES.ORDER_ACKNOWLEDGEMENT);
  assert.equal(route.sourceType, DOC_TYPES.QUOTATION);
  assert.equal(route.destinationType, DOC_TYPES.ORDER_ACKNOWLEDGEMENT);
});

run("buildSourceMetadataFromDocument", () => {
  const meta = buildSourceMetadataFromDocument(
    {
      _id: "507f1f77bcf86cd799439011",
      quotationNo: "MAR-QTN-0013",
      createdBy: "deepak@test.com",
      createdAt: new Date("2026-01-15"),
    },
    DOC_TYPES.QUOTATION,
    { copiedBy: "admin@test.com" }
  );
  assert.equal(meta.sourceDocumentNumber, "MAR-QTN-0013");
  assert.equal(meta.sourceCreatedBy, "deepak@test.com");
  assert.equal(meta.copiedBy, "admin@test.com");
  assert.ok(meta.copiedAt);
});

run("consumption: remaining qty defaults", () => {
  const consumption = {
    byLineId: new Map([
      [
        "line1",
        { quotedQty: 20, alreadyOrderedQty: 12, remainingQty: 8 },
      ],
    ]),
    byArticlePart: new Map(),
  };
  const lines = applyConsumptionToWorkingLines(
    [
      {
        sourceQuotationLineId: "line1",
        article: "BEARING",
        quotedQty: 20,
        orderedQty: 20,
        includeInOA: true,
      },
    ],
    consumption
  );
  assert.equal(lines[0].alreadyOrderedQty, 12);
  assert.equal(lines[0].remainingQty, 8);
  assert.equal(lines[0].orderedQty, 8);
});

run("consumption: over-order violations", () => {
  const consumption = {
    byLineId: new Map([
      ["line1", { quotedQty: 20, alreadyOrderedQty: 12, remainingQty: 8 }],
    ]),
    byArticlePart: new Map([
      [lineArticlePartKey("BEARING", "P1"), { quotedQty: 20, alreadyOrderedQty: 12, remainingQty: 8 }],
    ]),
  };
  const violations = findOverOrderViolations(
    [
      {
        sourceQuotationLineId: "line1",
        article: "BEARING",
        partNumber: "P1",
        orderedQty: 10,
        includeInOA: true,
      },
    ],
    consumption
  );
  assert.equal(violations.length, 1);
  assert.equal(violations[0].excessQty, 2);
});

run("normalizeOALinesFromWorkingCopy excludes unchecked lines", () => {
  const lines = normalizeOALinesFromWorkingCopy([
    {
      article: "A",
      description: "Item A",
      uom: "PCS",
      orderedQty: 5,
      orderedPrice: 10,
      includeInOA: true,
    },
    {
      article: "B",
      description: "Item B",
      uom: "PCS",
      orderedQty: 3,
      orderedPrice: 5,
      includeInOA: false,
    },
  ]);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].qty, 5);
  assert.equal(lines[0].price, 10);
});

run("isOaWorkingCopyPayload detects snapshot lines", () => {
  assert.equal(isOaWorkingCopyPayload({ oaSourceType: "FROM_QUOTATION" }), true);
  assert.equal(isOaWorkingCopyPayload({ lines: [{ orderedQty: 1, article: "X" }] }), true);
  assert.equal(isOaWorkingCopyPayload({ lines: [{ qty: 1, article: "X" }] }), false);
});

run("resolvePersistedSourceMetadata from working copy", () => {
  const meta = resolvePersistedSourceMetadata(
    {
      _sourceMetadata: {
        sourceDocumentType: "QUOTATION",
        sourceDocumentNumber: "MAR-QTN-0013",
        sourceCreatedBy: "deepak",
      },
    },
    { email: "copier@test.com" }
  );
  assert.equal(meta.sourceDocumentType, "QUOTATION");
  assert.equal(meta.sourceDocumentNumber, "MAR-QTN-0013");
  assert.equal(meta.copiedBy, "copier@test.com");
});

run("validateOaLineFields rejects duplicate article", () => {
  const errors = validateOaLineFields(
    [
      { article: "A1", description: "One", uom: "PCS", orderedQty: 1, orderedPrice: 10 },
      { article: "A1", description: "Dup", uom: "PCS", orderedQty: 2, orderedPrice: 5 },
    ],
    { fromWorkingCopy: true }
  );
  assert.ok(errors.some((e) => e.includes("duplicate")));
});

run("detectStaleConsumption when another OA created", () => {
  const baseline = buildConsumptionBaseline({
    linkedOaCount: 1,
    lines: [{ quotationLineId: "l1", remainingQty: 8, alreadyOrderedQty: 12 }],
  });
  const fresh = {
    linkedOaCount: 2,
    byLineId: new Map([["l1", { remainingQty: 3, alreadyOrderedQty: 17 }]]),
  };
  const { stale, reasons } = detectStaleConsumption(
    {
      consumptionBaseline: baseline,
      lines: [{ sourceQuotationLineId: "l1", article: "BEARING", includeInOA: true, orderedQty: 3 }],
    },
    fresh
  );
  assert.equal(stale, true);
  assert.ok(reasons.length >= 1);
});

console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
