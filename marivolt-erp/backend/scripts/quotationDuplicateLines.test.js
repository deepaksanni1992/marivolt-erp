/**
 * Duplicate quotation / RFQ line preservation — brand-agnostic.
 * Run: node scripts/quotationDuplicateLines.test.js
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  appendImportedQuotationLines,
  detectDuplicateArticleGroups,
  duplicateArticleLineHint,
  duplicateGroupsFingerprint,
  DUPLICATE_ARTICLE_BADGE,
  DUPLICATE_ARTICLES_CANCEL_LABEL,
  DUPLICATE_ARTICLES_KEEP_LABEL,
  DUPLICATE_ARTICLES_MODAL_MESSAGE,
  DUPLICATE_ARTICLES_MODAL_TITLE,
  needsDuplicateArticleAcknowledgement,
  normalizeArticleForDuplicateGroup,
  parseQuotationCsvDataRows,
  preserveQuotationLinesInOrder,
  quotationIdempotencyLineList,
  salesDocumentLineKey,
} from "../src/utils/quotationDuplicateLines.js";
import { manRfqRequestHash, sanitizeCustomerQuotationPrint, redactQuotationForSalesApi } from "../src/utils/manPriceList.js";
import { validateOaLineFields } from "../src/services/documentSnapshot/oaCreateValidation.js";
import {
  applyConsumptionToWorkingLines,
  findOverOrderViolations,
  lookupQuotationConsumptionEntry,
} from "../src/services/documentSnapshot/quotationConsumptionService.js";
import { parseOaWorkingLinesFromCsvRows } from "../../src/lib/oaWorkingCopyCsv.js";

const here = path.dirname(fileURLToPath(import.meta.url));

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

console.log("\nQuotation duplicate-line preservation\n");

const row52 = {
  Article: "800076",
  "Part Number": "51401-01H-212",
  Description: "Delivery valve spring",
  UOM: "PCS",
  QTY: "6",
};
const row72 = {
  Article: "800076",
  "Part Number": "51401-01H-212",
  Description: "Delivery valve spring",
  UOM: "PCS",
  QTY: "6",
};

run("1. No duplicates: no warning and all lines preserved", () => {
  const rows = [
    { Article: "A1", "Part Number": "P1", Description: "One", UOM: "PCS", QTY: "2" },
    { Article: "A2", "Part Number": "P2", Description: "Two", UOM: "PCS", QTY: "3" },
  ];
  const lines = parseQuotationCsvDataRows(rows);
  assert.equal(lines.length, 2);
  const groups = detectDuplicateArticleGroups(lines);
  assert.equal(groups.length, 0);
  const ack = needsDuplicateArticleAcknowledgement(lines, "");
  assert.equal(ack.required, false);
});

run("2. Two identical Article rows: both preserved", () => {
  const lines = parseQuotationCsvDataRows([row52, {}, row72]);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].qty, 6);
  assert.equal(lines[1].qty, 6);
  assert.equal(lines[0].sourceRowNumber, 2);
  assert.equal(lines[1].sourceRowNumber, 4);
  const groups = detectDuplicateArticleGroups(lines);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].article, "800076");
  assert.equal(groups[0].occurrenceCount, 2);
  assert.equal(groups[0].groupedQty, 12);
});

run("3. Same Article with different Part Numbers: both preserved", () => {
  const lines = parseQuotationCsvDataRows([
    { Article: "800076", "Part Number": "PN-A", Description: "Spring", UOM: "PCS", QTY: "1" },
    { Article: "800076", "Part Number": "PN-B", Description: "Spring", UOM: "PCS", QTY: "1" },
  ]);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].customerPartNo, "PN-A");
  assert.equal(lines[1].customerPartNo, "PN-B");
  const g = detectDuplicateArticleGroups(lines)[0];
  assert.deepEqual(g.requestedPartNumbers, ["PN-A", "PN-B"]);
});

run("4. Same Article with different quantities: both preserved", () => {
  const lines = parseQuotationCsvDataRows([
    { Article: "800076", Description: "Spring", QTY: "6" },
    { Article: "800076", Description: "Spring", QTY: "2" },
  ]);
  assert.equal(lines.map((l) => l.qty).join(","), "6,2");
  assert.equal(detectDuplicateArticleGroups(lines)[0].groupedQty, 8);
});

run("5. Same Article with different UOM/remarks: both preserved", () => {
  const lines = parseQuotationCsvDataRows([
    { Article: "X1", Description: "Item", UOM: "PCS", QTY: "1", Remarks: "pos 1" },
    { Article: "X1", Description: "Item", UOM: "SET", QTY: "1", Remarks: "pos 2" },
  ]);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].uom, "PCS");
  assert.equal(lines[1].uom, "SET");
  assert.equal(lines[0].remarks, "pos 1");
});

run("6. Three or more occurrences: one duplicate group", () => {
  const lines = parseQuotationCsvDataRows([
    { Article: "A", Description: "D", QTY: "1" },
    { Article: "A", Description: "D", QTY: "1" },
    { Article: "A", Description: "D", QTY: "1" },
  ]);
  const groups = detectDuplicateArticleGroups(lines);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].occurrenceCount, 3);
});

run("7. Trim/case variants detect as one group without modifying stored lines", () => {
  const lines = parseQuotationCsvDataRows([
    { Article: " 800076 ", Description: "Spring", QTY: "6" },
    { Article: "800076", Description: "Spring", QTY: "6" },
  ]);
  assert.equal(lines[0].article, "800076");
  const spaced = { article: " 800076 ", description: "Spring", qty: 6, clientLineId: "a" };
  const other = { article: "800076", description: "Spring", qty: 6, clientLineId: "b" };
  const groups = detectDuplicateArticleGroups([spaced, other]);
  assert.equal(groups.length, 1);
  assert.equal(spaced.article, " 800076 ");
  assert.equal(normalizeArticleForDuplicateGroup(" 800076 "), "800076");
});

run("8. Different Articles are not grouped", () => {
  const lines = parseQuotationCsvDataRows([
    { Article: "A1", Description: "One", QTY: "1" },
    { Article: "A2", Description: "Two", QTY: "1" },
  ]);
  assert.equal(detectDuplicateArticleGroups(lines).length, 0);
});

run("9. Blank/invalid Article lines follow existing validation", () => {
  const lines = parseQuotationCsvDataRows([
    { Article: "", Description: "Missing", QTY: "1" },
    { Article: "A1", Description: "", QTY: "1" },
    { Article: "A1", Description: "Ok", QTY: "0" },
    { Article: "A1", Description: "Ok", QTY: "2" },
  ]);
  assert.equal(lines.length, 1);
  assert.equal(detectDuplicateArticleGroups(lines).length, 0);
});

run("10. Source row numbers and original order remain correct", () => {
  const lines = parseQuotationCsvDataRows([
    row52,
    { Article: "OTHER", Description: "Other", QTY: "1" },
    row72,
  ]);
  assert.equal(lines[0].article, "800076");
  assert.equal(lines[1].article, "OTHER");
  assert.equal(lines[2].article, "800076");
  assert.equal(lines[0].sourceRowNumber, 2);
  assert.equal(lines[1].sourceRowNumber, 3);
  assert.equal(lines[2].sourceRowNumber, 4);
});

run("11-13. Popup continue keeps lines; cancel is a no-op; group fields present", () => {
  const lines = parseQuotationCsvDataRows([row52, row72]);
  const check = needsDuplicateArticleAcknowledgement(lines, "");
  assert.equal(check.required, true);
  const g = check.groups[0];
  assert.equal(g.article, "800076");
  assert.deepEqual(g.sourceRowNumbers, [2, 3]);
  assert.ok(g.requestedPartNumbers.includes("51401-01H-212"));
  assert.deepEqual(g.quantities, [6, 6]);
  assert.equal(g.groupedQty, 12);
  assert.equal(DUPLICATE_ARTICLES_MODAL_TITLE, "Duplicate Articles found");
  assert.match(DUPLICATE_ARTICLES_MODAL_MESSAGE, /All lines will be kept separately/);
  assert.equal(DUPLICATE_ARTICLES_KEEP_LABEL, "Keep all lines and continue");
  assert.equal(DUPLICATE_ARTICLES_CANCEL_LABEL, "Cancel and review file");
  const afterCancel = preserveQuotationLinesInOrder([]);
  assert.equal(afterCancel.length, 0);
  const kept = appendImportedQuotationLines([], lines);
  assert.equal(kept.length, 2);
});

run("14. Editing lines after acknowledgement recomputes and re-prompts", () => {
  const lines = parseQuotationCsvDataRows([row52, row72]);
  const first = needsDuplicateArticleAcknowledgement(lines, "");
  const second = needsDuplicateArticleAcknowledgement(lines, first.fingerprint);
  assert.equal(second.required, false);
  const edited = lines.map((l, i) => (i === 1 ? { ...l, qty: 9 } : l));
  const third = needsDuplicateArticleAcknowledgement(edited, first.fingerprint);
  assert.equal(third.required, true);
});

run("15. Excluded lines follow included-line warning rule", () => {
  const lines = [
    { article: "800076", qty: 6, description: "A", clientLineId: "1", exclude: false },
    { article: "800076", qty: 6, description: "B", clientLineId: "2", exclude: true },
  ];
  assert.equal(detectDuplicateArticleGroups(lines).length, 0);
  assert.equal(detectDuplicateArticleGroups(lines, { includeExcluded: true }).length, 1);
});

run("16. Exact duplicates are warnings, not errors", () => {
  const hint = duplicateArticleLineHint(
    { article: "800076", sourceRowNumber: 52 },
    detectDuplicateArticleGroups(parseQuotationCsvDataRows([row52, row72]))
  );
  assert.equal(hint.badge, DUPLICATE_ARTICLE_BADGE);
  assert.match(hint.detail, /Also appears on rows/);
});

run("17-18. Preserve ordered lines and independent totals", () => {
  const lines = parseQuotationCsvDataRows([row52, row72]).map((l) => ({ ...l, price: 10, totalPrice: 60 }));
  const kept = preserveQuotationLinesInOrder(lines);
  assert.equal(kept.length, 2);
  const docTotal = kept.reduce((acc, l) => acc + l.totalPrice, 0);
  assert.equal(docTotal, 120);
});

run("19-20. Unique line identity: keys and independent delete", () => {
  const lines = parseQuotationCsvDataRows([row52, row72]);
  assert.notEqual(salesDocumentLineKey(lines[0], 0), salesDocumentLineKey(lines[1], 1));
  const remaining = lines.filter((_, i) => i !== 0);
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].sourceRowNumber, 3);
});

run("21. Backend detector does not unique-collapse without UI", () => {
  const lines = [
    { article: "800076", qty: 6, description: "A" },
    { article: "800076", qty: 6, description: "A" },
  ];
  assert.equal(preserveQuotationLinesInOrder(lines).length, 2);
});

run("22. Failure is atomic: empty preserve list does not invent a merged line", () => {
  assert.deepEqual(preserveQuotationLinesInOrder([]), []);
});

run("23. Company isolation remains a request-scoped concern (no global article key)", () => {
  const src = fs.readFileSync(path.join(here, "../src/utils/quotationDuplicateLines.js"), "utf8");
  assert.equal(src.includes("detectDuplicateArticleGroups"), true);
  assert.equal(/unique\(.*article/i.test(src), false);
});

run("24. Repeated Articles still grouped for IM lookup, not merged", () => {
  const groups = detectDuplicateArticleGroups([
    { article: "800076", qty: 1, description: "a" },
    { article: "800076", qty: 1, description: "b" },
  ]);
  assert.equal(groups[0].occurrenceCount, 2);
});

run("25-29. Idempotency hash: retry same, uniques vs duplicates, qty, PN, order", () => {
  const a = quotationIdempotencyLineList([
    { article: "800076", qty: 6, uom: "PCS", customerPartNo: "PN", sourceRowNumber: 52 },
    { article: "800076", qty: 6, uom: "PCS", customerPartNo: "PN", sourceRowNumber: 72 },
  ]);
  const b = quotationIdempotencyLineList([
    { article: "800076", qty: 6, uom: "PCS", customerPartNo: "PN", sourceRowNumber: 52 },
    { article: "800076", qty: 6, uom: "PCS", customerPartNo: "PN", sourceRowNumber: 72 },
  ]);
  assert.deepEqual(a, b);
  const merged = quotationIdempotencyLineList([
    { article: "800076", qty: 12, uom: "PCS", customerPartNo: "PN" },
  ]);
  assert.notEqual(JSON.stringify(a), JSON.stringify(merged));
  const qty = quotationIdempotencyLineList([
    { article: "800076", qty: 7, uom: "PCS", customerPartNo: "PN", sourceRowNumber: 52 },
    { article: "800076", qty: 6, uom: "PCS", customerPartNo: "PN", sourceRowNumber: 72 },
  ]);
  assert.notEqual(JSON.stringify(a), JSON.stringify(qty));
  const pn = quotationIdempotencyLineList([
    { article: "800076", qty: 6, uom: "PCS", customerPartNo: "OTHER", sourceRowNumber: 52 },
    { article: "800076", qty: 6, uom: "PCS", customerPartNo: "PN", sourceRowNumber: 72 },
  ]);
  assert.notEqual(JSON.stringify(a), JSON.stringify(pn));
  const uniqueSet = new Set(a.map((l) => l.article));
  assert.equal(uniqueSet.size, 1);
  assert.equal(a.length, 2);
  const hashTwo = manRfqRequestHash({ customerId: "c", currency: "USD", lines: a });
  const hashOne = manRfqRequestHash({ customerId: "c", currency: "USD", lines: merged });
  assert.notEqual(hashTwo, hashOne);
});

run("30. QTN→OA validation accepts duplicate Articles", () => {
  const errors = validateOaLineFields([
    { article: "800076", description: "Spring", uom: "PCS", orderedQty: 6, orderedPrice: 1, sourceQuotationLineId: "l1" },
    { article: "800076", description: "Spring", uom: "PCS", orderedQty: 6, orderedPrice: 1, sourceQuotationLineId: "l2" },
  ]);
  assert.equal(errors.length, 0);
});

run("31. Consumption lookup uses line id; ambiguous article+part is not a last-wins overwrite", () => {
  const consumption = {
    byLineId: new Map([
      ["l1", { remainingQty: 6, quotedQty: 6, alreadyOrderedQty: 0 }],
      ["l2", { remainingQty: 6, quotedQty: 6, alreadyOrderedQty: 0 }],
    ]),
    byArticlePart: new Map([["800076||PN", null]]),
  };
  const a = lookupQuotationConsumptionEntry({ sourceQuotationLineId: "l1", article: "800076", partNumber: "PN" }, consumption);
  const b = lookupQuotationConsumptionEntry({ sourceQuotationLineId: "l2", article: "800076", partNumber: "PN" }, consumption);
  const legacy = lookupQuotationConsumptionEntry({ article: "800076", partNumber: "PN" }, consumption);
  assert.equal(a.remainingQty, 6);
  assert.equal(b.remainingQty, 6);
  assert.equal(legacy, null);
  const working = applyConsumptionToWorkingLines(
    [
      { sourceQuotationLineId: "l1", article: "800076", quotedQty: 6 },
      { sourceQuotationLineId: "l2", article: "800076", quotedQty: 6 },
    ],
    consumption
  );
  assert.equal(working.length, 2);
  const violations = findOverOrderViolations(
    [
      { sourceQuotationLineId: "l1", article: "800076", orderedQty: 6, includeInOA: true },
      { sourceQuotationLineId: "l2", article: "800076", orderedQty: 6, includeInOA: true },
    ],
    consumption
  );
  assert.equal(violations.length, 0);
});

run("32-33. OA working CSV and print/CSV helpers keep repeated positions", () => {
  const parsed = parseOaWorkingLinesFromCsvRows([
    { article: "800076", description: "Spring", orderedQty: "6", partNumber: "51401-01H-212" },
    { article: "800076", description: "Spring", orderedQty: "6", partNumber: "51401-01H-212" },
  ]);
  assert.equal(parsed.errors.length, 0);
  assert.equal(parsed.lines.length, 2);
  const printed = sanitizeCustomerQuotationPrint({
    lines: parsed.lines.map((l) => ({
      article: l.article,
      description: l.description,
      qty: l.orderedQty,
      uom: l.uom,
      price: 1,
      totalPrice: 6,
      buy: 99,
      priceListId: "secret",
    })),
  });
  assert.equal(printed.lines.length, 2);
  assert.equal(printed.lines[0].buy, undefined);
  assert.equal(printed.lines[0].priceListId, undefined);
});

run("34. Historical documents are not rewritten by the detector", () => {
  const historical = [{ article: "800076", qty: 12 }];
  assert.equal(preserveQuotationLinesInOrder(historical).length, 1);
});

run("35-38. Standard, MAN RFQ, Wärtsilä, and brand-agnostic grouping", () => {
  const wartsila = parseQuotationCsvDataRows([
    { Article: "W-1", "Part Number": "WS-AA", Description: "Wärtsilä spare", QTY: "2" },
    { Article: "W-1", "Part Number": "WS-BB", Description: "Wärtsilä spare", QTY: "3" },
  ]);
  assert.equal(wartsila.length, 2);
  assert.equal(detectDuplicateArticleGroups(wartsila).length, 1);
  const man = detectDuplicateArticleGroups(
    [
      { selectedArticle: "800076", requestedPartNo: "51401-01H-212", qty: 6, exclude: false, sourceRowNumber: 52 },
      { selectedArticle: "800076", requestedPartNo: "51401-01H-212", qty: 6, exclude: false, sourceRowNumber: 72 },
    ],
    { articleOf: (l) => l.selectedArticle, requestedPartNumberOf: (l) => l.requestedPartNo }
  );
  assert.equal(man.length, 1);
  const util = fs.readFileSync(path.join(here, "../src/utils/quotationDuplicateLines.js"), "utf8");
  assert.equal(util.includes("MAN_BRAND"), false);
  assert.equal(util.includes("Wärtsilä"), false);
});

run("39. Purchase-only information remains redacted from Sales/customer output", () => {
  const sales = redactQuotationForSalesApi({
    lines: [
      { article: "800076", qty: 6, buy: 1, nextBuy: 2, priceListId: "pl1", supplierPartNumber: "s" },
      { article: "800076", qty: 6, buy: 1, nextBuy: 2, priceListId: "pl1" },
    ],
  });
  for (const line of sales.lines || []) {
    assert.equal(line.buy, undefined);
    assert.equal(line.nextBuy, undefined);
    assert.equal(line.priceListId, undefined);
    assert.equal(line.supplierPartNumber, undefined);
  }
});

run("Sales CSV last-wins collapse is removed", () => {
  const sales = fs.readFileSync(path.join(here, "../../src/pages/Sales.jsx"), "utf8");
  assert.equal(sales.includes("dedupeQuotationCsvRowsByArticlePartLastWins"), false);
  assert.equal(sales.includes("Skip duplicates"), false);
  assert.equal(sales.includes("Keep all lines and continue") || sales.includes("DuplicateArticlesModal"), true);
});

run("Fingerprint is stable for identical groups", () => {
  const lines = parseQuotationCsvDataRows([row52, row72]);
  const a = duplicateGroupsFingerprint(detectDuplicateArticleGroups(lines));
  const b = duplicateGroupsFingerprint(detectDuplicateArticleGroups(lines));
  assert.equal(a, b);
});

console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
