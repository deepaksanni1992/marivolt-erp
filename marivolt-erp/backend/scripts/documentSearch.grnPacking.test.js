/**
 * Document searchability — GRN eligible PO + Packing eligible allocation + register filters.
 * Run: node scripts/documentSearch.grnPacking.test.js
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  clampLimit,
  escapeRegex,
  paginateArray,
  rankDocumentMatch,
  safeSearchTerm,
} from "../src/utils/documentSearch.js";
import {
  GRN_ELIGIBLE_PO_EXCLUDED_STATUSES,
  PACKING_ELIGIBLE_ALLOC_EXCLUDED_STATUSES,
  buildEligibleAllocationMongoFilter,
  buildEligiblePoMongoFilter,
  computePoLinePendingReceivable,
  parseListPaging,
  rankEligibleAllocation,
  rankEligiblePo,
  sortEligibleAllocations,
  sortEligiblePos,
  summarizeAllocationPendingPack,
  summarizePoPendingReceivable,
  toEligibleAllocationItem,
  toEligiblePoItem,
} from "../src/utils/eligibleDocumentSearch.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcRoot = path.join(__dirname, "..", "src");
const frontRoot = path.join(__dirname, "..", "..", "src");

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

console.log("\nDocument search (GRN / Packing)\n");

run("1. Exact PO-number rank beats supplier contains", () => {
  const exact = { poNo: "MAR-PO-0077", supplierName: "Other", lines: [] };
  const supplier = { poNo: "MAR-PO-0001", supplierName: "MAR-PO-0077 Supplies", lines: [] };
  assert.ok(rankEligiblePo("MAR-PO-0077", exact) < rankEligiblePo("MAR-PO-0077", supplier));
});

run("2. Supplier-name search ranks prefix ahead of contains", () => {
  const prefix = { poNo: "PO-1", supplierName: "Belman Flexibles", lines: [] };
  const contains = { poNo: "PO-2", supplierName: "Acme Belman Parts", lines: [] };
  assert.ok(rankEligiblePo("Belman", prefix) <= rankEligiblePo("Belman", contains));
});

run("3. Article/part-number match is discoverable via ranking", () => {
  const po = {
    poNo: "PO-9",
    supplierName: "X",
    lines: [{ article: "BF-4488", partNumber: "PN-1" }],
  };
  assert.ok(rankEligiblePo("BF-4488", po) < 90);
});

run("4. Only lines with pending receivable count", () => {
  const posted = new Map([
    ["l1", 10],
    ["l2", 0],
  ]);
  const po = {
    lines: [
      { _id: "l1", orderedQty: 10, cancelledQty: 0 },
      { _id: "l2", orderedQty: 5, cancelledQty: 0 },
      { _id: "l3", orderedQty: 4, cancelledQty: 4 },
    ],
  };
  const s = summarizePoPendingReceivable(po, posted);
  assert.equal(s.pendingLineCount, 1);
  assert.equal(s.pendingQty, 5);
});

run("5. Fully received / cancelled-status exclusion helpers", () => {
  assert.ok(GRN_ELIGIBLE_PO_EXCLUDED_STATUSES.includes("CANCELLED"));
  assert.ok(GRN_ELIGIBLE_PO_EXCLUDED_STATUSES.includes("CLOSED"));
  const full = summarizePoPendingReceivable(
    { lines: [{ _id: "a", orderedQty: 3, cancelledQty: 0 }] },
    new Map([["a", 3]])
  );
  assert.equal(full.pendingLineCount, 0);
  const filter = buildEligiblePoMongoFilter({
    companyFilter: { companyId: "c1" },
    q: "",
  });
  assert.deepEqual(filter.status?.$nin || filter.$and?.find((x) => x.status)?.status?.$nin, [
    "CANCELLED",
    "CLOSED",
    "REJECTED",
  ]);
});

run("6. Company filter always composed into eligible PO query", () => {
  const f = buildEligiblePoMongoFilter({
    companyFilter: { companyId: "COMPANY_A" },
    q: "PO-1",
  });
  const blob = JSON.stringify(f);
  assert.match(blob, /COMPANY_A/);
  assert.match(blob, /poNo/);
});

run("7. Pagination works", () => {
  const items = Array.from({ length: 30 }, (_, i) => ({ id: String(i) }));
  const p1 = paginateArray(items, 1, 10);
  const p2 = paginateArray(items, 2, 10);
  assert.equal(p1.items.length, 10);
  assert.equal(p1.hasMore, true);
  assert.equal(p2.items[0].id, "10");
  assert.equal(p2.total, 30);
});

run("8. Query limit is capped", () => {
  assert.equal(clampLimit(999, { fallback: 25, max: 50 }), 50);
  assert.equal(parseListPaging({ limit: "500" }).limit, 50);
});

run("9. Pending receivable uses posted accepted qty (not stale line receivedQty)", () => {
  const { pending } = computePoLinePendingReceivable(
    { orderedQty: 20, receivedQty: 20, cancelledQty: 0 },
    5
  );
  assert.equal(pending, 15);
});

run("10. toEligiblePoItem shape for selector", () => {
  const item = toEligiblePoItem(
    {
      _id: "000000000000000000000011",
      poNo: "MAR-PO-0077",
      supplierName: "Belman",
      orderDate: "2026-07-28",
      status: "SENT",
    },
    { pendingLineCount: 4, pendingQty: 18 }
  );
  assert.equal(item.poNo, "MAR-PO-0077");
  assert.equal(item.pendingLineCount, 4);
  assert.match(item.secondaryLabel, /Belman/);
  assert.match(item.secondaryLabel, /4 pending lines/);
});

run("11. Exact allocation number ranks first", () => {
  const exact = { allocationNo: "ALLOC-100", customerName: "Z", linkedOANo: "" };
  const other = { allocationNo: "ALLOC-200", customerName: "ALLOC-100 Corp", linkedOANo: "" };
  assert.ok(rankEligibleAllocation("ALLOC-100", exact) < rankEligibleAllocation("ALLOC-100", other));
});

run("12. Customer-name search ranks", () => {
  assert.ok(rankEligibleAllocation("Acme", { allocationNo: "A1", customerName: "Acme Marine" }) < 90);
});

run("13. OA/PI/SI reference search ranking", () => {
  const row = {
    allocationNo: "A9",
    linkedOANo: "OA-55",
    linkedProformaNo: "PI-77",
    linkedSalesInvoiceNo: "SI-88",
    customerName: "X",
  };
  assert.ok(rankEligibleAllocation("OA-55", row) < 90);
  assert.ok(rankEligibleAllocation("PI-77", row) < 90);
  assert.ok(rankEligibleAllocation("SI-88", row) < 90);
});

run("14. Allocation article fields included in mongo $or", () => {
  const f = buildEligibleAllocationMongoFilter({
    companyFilter: { companyId: "c1" },
    q: "ART-1",
  });
  const blob = JSON.stringify(f);
  assert.match(blob, /lines\.article/);
  assert.match(blob, /linkedOANo/);
});

run("15. Fully packed / cancelled sources excluded", () => {
  assert.ok(PACKING_ELIGIBLE_ALLOC_EXCLUDED_STATUSES.includes("CANCELLED"));
  assert.ok(PACKING_ELIGIBLE_ALLOC_EXCLUDED_STATUSES.includes("CLOSED"));
  const packed = summarizeAllocationPendingPack(
    { lines: [{ _id: "1", qty: 10 }] },
    new Map([["1", 10]])
  );
  assert.equal(packed.pendingPackQty, 0);
});

run("16. Company scope in allocation filter", () => {
  const f = buildEligibleAllocationMongoFilter({
    companyFilter: { companyId: "COMP_B" },
    q: "",
  });
  assert.match(JSON.stringify(f), /COMP_B/);
});

run("17. Remaining packable quantities remain correct", () => {
  const s = summarizeAllocationPendingPack(
    {
      lines: [
        { _id: "a", qty: 8 },
        { _id: "b", qty: 2 },
      ],
    },
    new Map([["a", 3]])
  );
  assert.equal(s.pendingPackQty, 7);
  assert.equal(s.pendingLineCount, 2);
  const item = toEligibleAllocationItem(
    {
      _id: "000000000000000000000022",
      allocationNo: "ALL-1",
      customerName: "Cust",
      linkedOANo: "OA-1",
      status: "OPEN",
    },
    s
  );
  assert.equal(item.pendingPackQty, 7);
});

run("18. Search input escaping / safe term", () => {
  assert.equal(escapeRegex("a+b"), "a\\+b");
  assert.equal(safeSearchTerm("  x".repeat(100)).length <= 80, true);
  assert.doesNotThrow(() => new RegExp(escapeRegex("(evil)"), "i"));
});

run("19. GRN register search fields wired in controller", () => {
  const src = fs.readFileSync(path.join(srcRoot, "controllers/grnController.js"), "utf8");
  assert.match(src, /listEligiblePurchaseOrdersForGrn/);
  assert.match(src, /blAwbNo/);
  assert.match(src, /items\.article/);
  assert.match(src, /dateFrom/);
  assert.doesNotMatch(src, /moveAllocationToRTS/);
});

run("20. Packing register search fields wired", () => {
  const src = fs.readFileSync(path.join(srcRoot, "controllers/storeOutboundController.js"), "utf8");
  assert.match(src, /listEligibleAllocationsForPacking/);
  assert.match(src, /sumPostedPackQtyByAllocationIds/);
  assert.match(src, /customerReference/);
  assert.match(src, /linkedOANo/);
});

run("21. Filter clear/reset + routes + reusable selector present", () => {
  const routesGrn = fs.readFileSync(path.join(srcRoot, "routes/grnRoutes.js"), "utf8");
  const routesPack = fs.readFileSync(path.join(srcRoot, "routes/packingRoutes.js"), "utf8");
  const store = fs.readFileSync(path.join(frontRoot, "pages/StoreModule.jsx"), "utf8");
  const sel = fs.readFileSync(path.join(frontRoot, "components/erp/SearchableDocumentSelect.jsx"), "utf8");
  assert.match(routesGrn, /eligible-purchase-orders/);
  assert.match(routesPack, /allocations\/eligible/);
  assert.match(store, /SearchableDocumentSelect/);
  assert.match(store, /Clear filters/);
  assert.match(store, /grn\/eligible-purchase-orders/);
  assert.match(store, /packing\/allocations\/eligible/);
  assert.doesNotMatch(store, /purchase-orders\",\s*\{\s*limit:\s*150/);
  assert.doesNotMatch(store, /allocations\/pending\",\s*\{\s*limit:\s*200/);
  assert.match(sel, /role=\"combobox\"/);
  assert.match(sel, /Escape/);
  assert.match(sel, /ArrowDown/);
});

run("22. Keyboard selection behaviours in selector", () => {
  const sel = fs.readFileSync(path.join(frontRoot, "components/erp/SearchableDocumentSelect.jsx"), "utf8");
  assert.match(sel, /ArrowUp/);
  assert.match(sel, /Enter/);
  assert.match(sel, /aria-expanded/);
  assert.match(sel, /listbox/);
});

run("23. Empty/loading/error states render", () => {
  const sel = fs.readFileSync(path.join(frontRoot, "components/erp/SearchableDocumentSelect.jsx"), "utf8");
  assert.match(sel, /Searching/);
  assert.match(sel, /emptyMessage/);
  assert.match(sel, /setError/);
});

run("24. GRN posting path unchanged (from-po + post still present)", () => {
  const src = fs.readFileSync(path.join(srcRoot, "controllers/grnController.js"), "utf8");
  assert.match(src, /export async function getGrnFromPo/);
  assert.match(src, /export async function postGrnFromPo|\/grn\/post/);
  assert.match(src, /GRN_POSTED_FOR_RECEIPT_QTY/);
});

run("25. Packing idempotency / serialization imports unchanged", () => {
  const src = fs.readFileSync(path.join(srcRoot, "controllers/storeOutboundController.js"), "utf8");
  assert.match(src, /buildPackingEffectKey/);
  assert.match(src, /claimAllocationLinePackQty/);
  assert.match(src, /quantitySerialization/);
});

run("26. Dispatch idempotency still imported", () => {
  const src = fs.readFileSync(path.join(srcRoot, "controllers/storeOutboundController.js"), "utf8");
  assert.match(src, /buildDispatchEffectKey/);
  assert.match(src, /dispatchIdempotency/);
});

run("27. Customs service still used by GRN controller", () => {
  const src = fs.readFileSync(path.join(srcRoot, "controllers/grnController.js"), "utf8");
  assert.match(src, /createCustomsLotFromGrn/);
  assert.match(src, /customsService/);
});

run("28. Eligible endpoints use STORE view permission", () => {
  const grn = fs.readFileSync(path.join(srcRoot, "routes/grnRoutes.js"), "utf8");
  const pack = fs.readFileSync(path.join(srcRoot, "routes/packingRoutes.js"), "utf8");
  assert.match(grn, /eligible-purchase-orders\",\s*storeView/);
  assert.match(pack, /allocations\/eligible\",\s*storeView/);
});

run("29. Sort prefers exact then recent date", () => {
  const sorted = sortEligiblePos(
    [
      { poNo: "PO-B", supplierName: "Z", orderDate: "2026-01-01", lines: [] },
      { poNo: "HIT", supplierName: "Z", orderDate: "2025-01-01", lines: [] },
      { poNo: "HIT-2", supplierName: "HIT", orderDate: "2026-06-01", lines: [] },
    ],
    "HIT"
  );
  assert.equal(sorted[0].poNo, "HIT");
});

run("30. RTS remains absent", () => {
  const store = fs.readFileSync(path.join(frontRoot, "pages/StoreModule.jsx"), "utf8");
  const util = fs.readFileSync(path.join(srcRoot, "utils/eligibleDocumentSearch.js"), "utf8");
  assert.doesNotMatch(store, /\bRTS\b/);
  assert.doesNotMatch(util, /\bRTS\b/);
  assert.doesNotMatch(util, /Ready.?To.?Ship/i);
});

run("sortEligibleAllocations stable on exact", () => {
  const sorted = sortEligibleAllocations(
    [
      { allocationNo: "B", customerName: "X" },
      { allocationNo: "EXACT", customerName: "X" },
    ],
    "EXACT"
  );
  assert.equal(sorted[0].allocationNo, "EXACT");
});

run("rankDocumentMatch exact vs startsWith", () => {
  assert.ok(rankDocumentMatch("ABC", ["ABC"]) < rankDocumentMatch("ABC", ["ABCDEF"]));
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
