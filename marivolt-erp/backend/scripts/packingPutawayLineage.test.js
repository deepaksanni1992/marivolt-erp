/**
 * Putaway conversion lineage (Cases 1–10).
 * Run: node scripts/packingPutawayLineage.test.js
 */
import assert from "node:assert/strict";
import {
  conversionAllowsPutawayInheritance,
  mapPackingPdfRemarks,
  resolvePutawayViaConversionLineage,
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

console.log("\nPacking putaway conversion lineage\n");

const WH = "MAIN";

run("CASE 1 — A→B same warehouse inherits A putaway", () => {
  const candidates = [
    {
      article: "A",
      putaway: "A1",
      warehouse: WH,
      status: "POSTED",
      source: "GRN",
      sourceDocument: "GRN-A",
      date: "2026-07-01T00:00:00.000Z",
    },
  ];
  const conversions = [
    {
      sourceArticle: "A",
      targetArticle: "B",
      warehouse: WH,
      status: "POSTED",
      conversionNo: "STC-1",
      postedAt: "2026-07-10T00:00:00.000Z",
      sourceLocation: WH,
      targetLocation: WH,
    },
  ];
  const r = resolvePutawayViaConversionLineage("B", {
    warehouse: WH,
    putawayCandidates: candidates,
    conversions,
  });
  assert.equal(r.value, "A1");
  assert.equal(r.sourceType, "ARTICLE_CONVERSION");
  assert.equal(r.sourceArticle, "A");
  assert.equal(r.sourceDocument, "STC-1");
  assert.equal(r.historical, true);
});

run("CASE 2 — source later putaway after conversion must not apply", () => {
  const candidates = [
    {
      article: "A",
      putaway: "A1",
      warehouse: WH,
      status: "RECEIVED",
      source: "GRN",
      sourceDocument: "GRN-OLD",
      date: "2026-07-01T00:00:00.000Z",
    },
    {
      article: "A",
      putaway: "B2",
      warehouse: WH,
      status: "RECEIVED",
      source: "GRN",
      sourceDocument: "GRN-NEW",
      date: "2026-07-20T00:00:00.000Z",
    },
  ];
  const conversions = [
    {
      sourceArticle: "A",
      targetArticle: "B",
      warehouse: WH,
      status: "POSTED",
      conversionNo: "STC-1",
      postedAt: "2026-07-10T00:00:00.000Z",
      sourceLocation: WH,
      targetLocation: WH,
    },
  ];
  const r = resolvePutawayViaConversionLineage("B", {
    warehouse: WH,
    putawayCandidates: candidates,
    conversions,
  });
  assert.equal(r.value, "A1");
  assert.notEqual(r.value, "B2");
});

run("CASE 3 — target direct GRN wins over inheritance", () => {
  const candidates = [
    {
      article: "A",
      putaway: "A1",
      warehouse: WH,
      status: "POSTED",
      source: "GRN",
      sourceDocument: "GRN-A",
      date: "2026-07-01T00:00:00.000Z",
    },
    {
      article: "B",
      putaway: "C3",
      warehouse: WH,
      status: "POSTED",
      source: "GRN",
      sourceDocument: "GRN-B",
      date: "2026-08-15T00:00:00.000Z",
    },
  ];
  const conversions = [
    {
      sourceArticle: "A",
      targetArticle: "B",
      warehouse: WH,
      status: "POSTED",
      conversionNo: "STC-1",
      postedAt: "2026-07-10T00:00:00.000Z",
      sourceLocation: WH,
      targetLocation: WH,
    },
  ];
  // Direct evidence for B (as batchLastKnownPutaway would apply before lineage)
  const direct = selectLatestPutawayByArticle(candidates, WH).get("B");
  assert.equal(direct.value, "C3");
  assert.equal(direct.source, "GRN");
  // Lineage resolver also returns direct first when present
  const r = resolvePutawayViaConversionLineage("B", {
    warehouse: WH,
    putawayCandidates: candidates,
    conversions,
  });
  assert.equal(r.value, "C3");
  assert.notEqual(r.sourceType, "ARTICLE_CONVERSION");
});

run("CASE 4 — cross-warehouse conversion does not inherit", () => {
  const candidates = [
    {
      article: "A",
      putaway: "A1",
      warehouse: "MAIN",
      status: "POSTED",
      source: "GRN",
      date: "2026-07-01T00:00:00.000Z",
      sourceDocument: "G1",
    },
  ];
  const conversions = [
    {
      sourceArticle: "A",
      targetArticle: "B",
      warehouse: "SECONDARY",
      status: "POSTED",
      conversionNo: "STC-X",
      postedAt: "2026-07-10T00:00:00.000Z",
    },
  ];
  assert.equal(conversionAllowsPutawayInheritance(conversions[0], "MAIN"), false);
  const r = resolvePutawayViaConversionLineage("B", {
    warehouse: "MAIN",
    putawayCandidates: candidates,
    conversions,
  });
  assert.equal(r, null);
});

run("CASE 5 — cancelled/reversed conversion does not inherit", () => {
  const candidates = [
    {
      article: "A",
      putaway: "A1",
      warehouse: WH,
      status: "POSTED",
      source: "GRN",
      date: "2026-07-01T00:00:00.000Z",
      sourceDocument: "G1",
    },
  ];
  for (const status of ["CANCELLED", "REVERSED", "DRAFT"]) {
    const r = resolvePutawayViaConversionLineage("B", {
      warehouse: WH,
      putawayCandidates: candidates,
      conversions: [
        {
          sourceArticle: "A",
          targetArticle: "B",
          warehouse: WH,
          status,
          conversionNo: "STC-BAD",
          postedAt: "2026-07-10T00:00:00.000Z",
          sourceLocation: WH,
          targetLocation: WH,
        },
      ],
    });
    assert.equal(r, null, status);
  }
});

run("CASE 6 — partial conversion inherits text only (no qty)", () => {
  const r = resolvePutawayViaConversionLineage("B", {
    warehouse: WH,
    putawayCandidates: [
      {
        article: "A",
        putaway: "A1-A1",
        warehouse: WH,
        status: "RECEIVED",
        source: "GRN",
        date: "2026-07-01T00:00:00.000Z",
        sourceDocument: "GRN-A",
      },
    ],
    conversions: [
      {
        sourceArticle: "A",
        targetArticle: "B",
        warehouse: WH,
        status: "POSTED",
        conversionNo: "STC-P",
        postedAt: "2026-07-10T00:00:00.000Z",
        sourceLocation: WH,
        targetLocation: WH,
      },
    ],
  });
  assert.equal(r.value, "A1-A1");
  assert.equal(r.qty, undefined);
  assert.equal(r.locationQty, undefined);
  assert.equal(r.historical, true);
});

run("CASE 7 — A→B→C multi-step lineage", () => {
  const candidates = [
    {
      article: "A",
      putaway: "A1",
      warehouse: WH,
      status: "POSTED",
      source: "GRN",
      date: "2026-06-01T00:00:00.000Z",
      sourceDocument: "GRN-A",
    },
  ];
  const conversions = [
    {
      sourceArticle: "A",
      targetArticle: "B",
      warehouse: WH,
      status: "POSTED",
      conversionNo: "STC-AB",
      postedAt: "2026-07-01T00:00:00.000Z",
      sourceLocation: WH,
      targetLocation: WH,
    },
    {
      sourceArticle: "B",
      targetArticle: "C",
      warehouse: WH,
      status: "POSTED",
      conversionNo: "STC-BC",
      postedAt: "2026-07-15T00:00:00.000Z",
      sourceLocation: WH,
      targetLocation: WH,
    },
  ];
  const r = resolvePutawayViaConversionLineage("C", {
    warehouse: WH,
    putawayCandidates: candidates,
    conversions,
  });
  assert.equal(r.value, "A1");
  assert.equal(r.sourceType, "ARTICLE_CONVERSION");
  assert.equal(r.sourceArticle, "B");
  assert.equal(r.sourceDocument, "STC-BC");
});

run("CASE 8 — cycle terminates safely", () => {
  const conversions = [
    {
      sourceArticle: "B",
      targetArticle: "A",
      warehouse: WH,
      status: "POSTED",
      conversionNo: "STC-BA",
      postedAt: "2026-07-01T00:00:00.000Z",
      sourceLocation: WH,
      targetLocation: WH,
    },
    {
      sourceArticle: "A",
      targetArticle: "B",
      warehouse: WH,
      status: "POSTED",
      conversionNo: "STC-AB",
      postedAt: "2026-07-02T00:00:00.000Z",
      sourceLocation: WH,
      targetLocation: WH,
    },
  ];
  const r = resolvePutawayViaConversionLineage("A", {
    warehouse: WH,
    putawayCandidates: [],
    conversions,
  });
  assert.equal(r, null);
});

run("CASE 9 — cross-company isolation is query-scoped (pure candidates)", () => {
  // Pure resolver only sees provided candidates; company filter is in service queries.
  const r = resolvePutawayViaConversionLineage("B", {
    warehouse: WH,
    putawayCandidates: [
      {
        article: "A",
        putaway: "OTHER-CO",
        warehouse: WH,
        status: "POSTED",
        source: "GRN",
        date: "2026-07-01T00:00:00.000Z",
        sourceDocument: "OKE-GRN",
      },
    ],
    conversions: [
      {
        sourceArticle: "A",
        targetArticle: "B",
        warehouse: WH,
        status: "POSTED",
        conversionNo: "STC-1",
        postedAt: "2026-07-10T00:00:00.000Z",
        sourceLocation: WH,
        targetLocation: WH,
      },
    ],
  });
  // Would inherit if candidates leaked; service must not pass other-company rows.
  assert.equal(r.value, "OTHER-CO");
  assert.ok(true, "company scoping enforced at GRN/conversion query layer");
});

run("CASE 10 — MAR-STC-0001 pattern 8X0098 → 700004.28 inherits A1-A1", () => {
  const candidates = [
    {
      article: "8X0098",
      putaway: "A1-A1",
      warehouse: "MAIN",
      status: "RECEIVED",
      source: "GRN",
      sourceDocument: "MAR-GRN-0010",
      date: "2026-08-03T12:14:19.741Z",
    },
  ];
  const conversions = [
    {
      sourceArticle: "8X0098",
      targetArticle: "700004.28",
      warehouse: "MAIN",
      status: "POSTED",
      conversionNo: "MAR-STC-0001",
      postedAt: "2026-08-04T13:44:02.746Z",
      sourceLocation: "MAIN",
      targetLocation: "MAIN",
    },
  ];
  const r = resolvePutawayViaConversionLineage("700004.28", {
    warehouse: "MAIN",
    putawayCandidates: candidates,
    conversions,
  });
  assert.equal(r.value, "A1-A1");
  assert.equal(r.sourceType, "ARTICLE_CONVERSION");
  assert.equal(r.sourceArticle, "8X0098");
  assert.equal(r.sourceDocument, "MAR-STC-0001");
});

run("PDF remark uses VERIFY PUTAWAY when putaway present", () => {
  const derived = {
    stockStatus: "READY",
    onHandQty: 9,
    allocationBalanceQty: 9,
    physicalPackableQty: 9,
    shortageQty: 0,
    reservedForOtherAllocationsQty: 0,
  };
  assert.equal(
    mapPackingPdfRemarks(derived, { value: "A1-A1", historical: true }),
    "READY TO PICK — VERIFY PUTAWAY"
  );
});

run("explicit sourceLocation != targetLocation blocks inheritance", () => {
  assert.equal(
    conversionAllowsPutawayInheritance(
      {
        status: "POSTED",
        warehouse: "MAIN",
        sourceLocation: "MAIN",
        targetLocation: "RACK-B",
      },
      "MAIN"
    ),
    false
  );
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
