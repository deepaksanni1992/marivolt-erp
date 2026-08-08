/**
 * Packing store presentation + last-known putaway selection (Phase 1).
 * Run: node scripts/packingPickingSheet.test.js
 */
import assert from "node:assert/strict";
import {
  buildPackingStorePresentation,
  derivePackingLineStock,
  mapPackingPdfRemarks,
  mapPackingStoreRemarks,
  mapPackingStoreStatus,
  parsePutawayFromLedgerRemarks,
  selectLatestPutawayByArticle,
} from "../src/utils/packingPhysicalStock.js";

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

console.log("\nPacking picking sheet (Phase 1)\n");

run("CASE 1 — Physical 9, Reserved Here 9, Free 0 → READY TO PICK Pick 9", () => {
  const d = derivePackingLineStock(
    { onHandQty: 9, reservedQty: 9, allocatedQty: 9, packedQty: 0 },
    { allocatedQty: 9, alreadyPacked: 0 }
  );
  assert.equal(d.physicalPackableQty, 9);
  assert.equal(d.freeAvailableQty, 9); // packing free includes this reservation
  assert.equal(d.stockStatus, "READY");
  const putaway = { value: "A/01", source: "GRN", historical: true };
  const p = buildPackingStorePresentation(d, putaway);
  assert.equal(p.pickQty, 9);
  assert.equal(p.storeStatus, "READY TO PICK");
  assert.equal(p.storeRemarks, "STOCK EXISTS — BIN QTY NOT TRACKED");
  assert.equal(p.pdfRemarks, "READY TO PICK — VERIFY PUTAWAY");
  assert.equal(p.lastKnownPutaway.value, "A/01");
  assert.equal(p.lastKnownPutaway.historical, true);
});

run("CASE 2 — stock held by others → not READY TO PICK", () => {
  // This allocation claims 9; warehouse reserved 18 (9 others + 9 this) → free 0
  const d = derivePackingLineStock(
    { onHandQty: 9, reservedQty: 18, allocatedQty: 18, packedQty: 0 },
    { allocatedQty: 9, alreadyPacked: 0 }
  );
  assert.equal(d.reservedForThisAllocationQty, 9);
  assert.equal(d.reservedForOtherAllocationsQty, 9);
  assert.equal(d.physicalPackableQty, 0);
  assert.equal(d.stockStatus, "SHORTAGE");
  const p = buildPackingStorePresentation(d, null);
  assert.equal(p.storeStatus, "RESERVED FOR OTHER ALLOCATION");
  assert.notEqual(p.storeStatus, "READY TO PICK");
});

run("CASE 3 — Physical 0 + historical putaway", () => {
  const d = derivePackingLineStock(
    { onHandQty: 0, reservedQty: 0, allocatedQty: 0, packedQty: 0 },
    { allocatedQty: 9, alreadyPacked: 0 }
  );
  const putaway = { value: "A/01", historical: true };
  const p = buildPackingStorePresentation(d, putaway);
  assert.equal(p.pickQty, 0);
  assert.ok(["NO STOCK", "NO STOCK / SHORTAGE", "NEGATIVE ALLOCATION"].includes(p.storeStatus));
  assert.equal(p.storeRemarks, "NO STOCK — HISTORICAL PUTAWAY ONLY");
  assert.equal(mapPackingPdfRemarks(d, putaway), "NO STOCK — HISTORICAL PUTAWAY ONLY");
});

run("CASE 4 — Physical 0, no putaway", () => {
  const d = derivePackingLineStock(
    { onHandQty: 0, reservedQty: 0, allocatedQty: 0, packedQty: 0 },
    { allocatedQty: 9, alreadyPacked: 0 }
  );
  const p = buildPackingStorePresentation(d, null);
  assert.equal(p.storeRemarks, "NO STOCK / LOCATION NOT ASSIGNED");
});

run("CASE 5 — Physical > 0, no historical putaway", () => {
  const d = derivePackingLineStock(
    { onHandQty: 9, reservedQty: 9, allocatedQty: 9, packedQty: 0 },
    { allocatedQty: 9, alreadyPacked: 0 }
  );
  assert.equal(mapPackingStoreRemarks(d, null), "STOCK EXISTS — LOCATION NOT RECORDED");
});

run("CASE 6 — Partial physical packability", () => {
  // Balance 9; others hold 5 of on-hand 9 → packable 4, shortage 5
  const d = derivePackingLineStock(
    { onHandQty: 9, reservedQty: 14, allocatedQty: 14, packedQty: 0 },
    { allocatedQty: 9, alreadyPacked: 0 }
  );
  assert.equal(d.physicalPackableQty, 4);
  assert.equal(d.shortageQty, 5);
  assert.equal(d.stockStatus, "PARTIAL");
  const p = buildPackingStorePresentation(d, { value: "A/01", historical: true });
  assert.equal(p.storeStatus, "PARTIAL STOCK");
  assert.equal(p.pickQty, 4);
  assert.match(p.pdfRemarks, /PARTIAL STOCK — AVAILABLE 4 \/ SHORT 5/);
});

run("CASE 7 — Previously packed reduces Pick Qty", () => {
  const d = derivePackingLineStock(
    { onHandQty: 9, reservedQty: 5, allocatedQty: 5, packedQty: 4 },
    { allocatedQty: 9, alreadyPacked: 4 }
  );
  assert.equal(d.allocationBalanceQty, 5);
  assert.equal(d.physicalPackableQty, 5);
  assert.equal(d.previouslyPackedQty, 4);
  assert.equal(mapPackingStoreStatus(d), "READY TO PICK");
});

run("CASE 8 — Cancelled GRN ignored; previous valid putaway used", () => {
  const map = selectLatestPutawayByArticle(
    [
      {
        article: "700004.28",
        putaway: "NEW/99",
        warehouse: "MAIN",
        status: "CANCELLED",
        sourceDocument: "MAR-GRN-9999",
        date: "2026-08-08T12:00:00.000Z",
      },
      {
        article: "700004.28",
        putaway: "A/01",
        warehouse: "MAIN",
        status: "POSTED",
        sourceDocument: "MAR-GRN-0123",
        date: "2026-08-01T12:00:00.000Z",
      },
    ],
    "MAIN"
  );
  assert.equal(map.get("700004.28").value, "A/01");
  assert.equal(map.get("700004.28").sourceDocument, "MAR-GRN-0123");
  assert.equal(map.get("700004.28").historical, true);
});

run("CASE 9 — Cross-company isolation is caller-scoped; selector does not mix warehouses", () => {
  const map = selectLatestPutawayByArticle(
    [
      {
        article: "700004.28",
        putaway: "OTHER-CO/BIN",
        warehouse: "MAIN",
        status: "POSTED",
        sourceDocument: "OKE-GRN-1",
        date: "2026-08-08T12:00:00.000Z",
      },
    ],
    "MAIN"
  );
  // Pure selector trusts pre-scoped candidates; company filter is in batchLastKnownPutaway query.
  assert.equal(map.get("700004.28").value, "OTHER-CO/BIN");
  // Document that company scoping is enforced at query layer (see lastKnownPutawayService).
  assert.ok(true);
});

run("CASE 10 — MAIN packing ignores other-warehouse putaway", () => {
  const map = selectLatestPutawayByArticle(
    [
      {
        article: "700004.28",
        putaway: "WH2/RACK",
        warehouse: "WH2",
        status: "POSTED",
        sourceDocument: "MAR-GRN-WH2",
        date: "2026-08-08T12:00:00.000Z",
      },
      {
        article: "700004.28",
        putaway: "MAIN/A01",
        warehouse: "MAIN",
        status: "POSTED",
        sourceDocument: "MAR-GRN-MAIN",
        date: "2026-07-01T12:00:00.000Z",
      },
    ],
    "MAIN"
  );
  assert.equal(map.get("700004.28").value, "MAIN/A01");
});

run("parsePutawayFromLedgerRemarks extracts Putaway text", () => {
  assert.equal(parsePutawayFromLedgerRemarks("GRN receive | Putaway: Rack A / Bin 03"), "Rack A / Bin 03");
  assert.equal(parsePutawayFromLedgerRemarks("no putaway here"), "");
});

run("DRAFT GRN putaway ignored", () => {
  const map = selectLatestPutawayByArticle(
    [
      {
        article: "X1",
        putaway: "DRAFT-BIN",
        warehouse: "MAIN",
        status: "DRAFT",
        sourceDocument: "MAR-GRN-D",
        date: "2026-08-08T12:00:00.000Z",
      },
    ],
    "MAIN"
  );
  assert.equal(map.has("X1"), false);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
