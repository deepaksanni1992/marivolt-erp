/**
 * Allocation document references / Customer Ref lineage (P5 picking sheet).
 * Run: node scripts/allocationDocumentReferences.test.js
 */
import assert from "node:assert/strict";
import {
  buildAllocationDocumentReferences,
  dashIfEmpty,
  resolveCustomerReferenceFromLineage,
} from "../src/utils/allocationDocumentReferences.js";

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

console.log("\nAllocation document references (P5)\n");

run("CASE 1 — QT → PI → ALLOC, OA absent, QT customerReference present", () => {
  const refs = buildAllocationDocumentReferences({
    allocation: {
      allocationNo: "MAR-ALLOC-0009",
      customerName: "ACME LLC",
      warehouse: "MAIN",
      linkedQuotationNo: "MAR-QTN-0010",
      linkedOANo: "",
      linkedProformaNo: "MAR-PI-0005",
    },
    oa: null,
    pi: { proformaNo: "MAR-PI-0005", customerReference: "" },
    quotation: { quotationNo: "MAR-QTN-0010", customerReference: "PO-QT-99" },
  });
  assert.equal(refs.orderAcknowledgementNo, "");
  assert.equal(dashIfEmpty(refs.orderAcknowledgementNo), "—");
  assert.equal(refs.customerReference, "PO-QT-99");
  assert.equal(refs.quotationNo, "MAR-QTN-0010");
  assert.equal(refs.proformaNo, "MAR-PI-0005");
});

run("CASE 2 — QT → OA → PI → ALLOC, OA customerPORef wins over PI/QT", () => {
  const refs = buildAllocationDocumentReferences({
    allocation: {
      allocationNo: "MAR-ALLOC-0010",
      customerName: "BETA",
      warehouse: "MAIN",
      linkedQuotationNo: "MAR-QTN-0011",
      linkedOANo: "MAR-OA-0003",
      linkedProformaNo: "MAR-PI-0006",
    },
    oa: { oaNo: "MAR-OA-0003", customerPORef: "OA-PO-777" },
    pi: { proformaNo: "MAR-PI-0006", customerReference: "PI-REF-ignored" },
    quotation: { quotationNo: "MAR-QTN-0011", customerReference: "QT-REF-ignored" },
  });
  assert.equal(refs.customerReference, "OA-PO-777");
  assert.equal(refs.orderAcknowledgementNo, "MAR-OA-0003");
  assert.equal(
    resolveCustomerReferenceFromLineage({
      oa: { customerPORef: "OA-PO-777" },
      pi: { customerReference: "PI-REF" },
      quotation: { customerReference: "QT-REF" },
    }),
    "OA-PO-777"
  );
});

run("CASE 3 — PI customerReference, OA absent", () => {
  const refs = buildAllocationDocumentReferences({
    allocation: {
      allocationNo: "MAR-ALLOC-0011",
      customerName: "GAMMA",
      linkedQuotationNo: "MAR-QTN-0012",
      linkedOANo: "",
      linkedProformaNo: "MAR-PI-0007",
      warehouse: "MAIN",
    },
    oa: null,
    pi: { proformaNo: "MAR-PI-0007", customerReference: "PI-ONLY-55" },
    quotation: { quotationNo: "MAR-QTN-0012", customerReference: "QT-fallback" },
  });
  assert.equal(refs.customerReference, "PI-ONLY-55");
  assert.equal(refs.orderAcknowledgementNo, "");
});

run("CASE 4 — No reference anywhere", () => {
  const refs = buildAllocationDocumentReferences({
    allocation: {
      allocationNo: "MAR-ALLOC-0012",
      customerName: "DELTA",
      linkedQuotationNo: "MAR-QTN-0013",
      linkedOANo: "",
      linkedProformaNo: "",
      warehouse: "MAIN",
    },
    oa: null,
    pi: { customerReference: "" },
    quotation: { customerReference: "   " },
  });
  assert.equal(refs.customerReference, "");
  assert.equal(dashIfEmpty(refs.customerReference), "—");
});

run("CASE 5 — Cross-company: lineage docs not supplied → no customer ref invent", () => {
  // Controller uses withCompany; wrong-company OA/PI/QT resolve to null and are not passed in.
  // Denormalized allocation numbers remain (they belong to this company's allocation).
  // Customer Ref must NOT be invented from linkedOANo / linked numbers alone.
  const refs = buildAllocationDocumentReferences({
    allocation: {
      allocationNo: "MAR-ALLOC-0099",
      customerName: "OTHER CO SHARED NO",
      linkedQuotationNo: "SHARED-QTN-0001",
      linkedOANo: "SHARED-OA-0001",
      linkedProformaNo: "SHARED-PI-0001",
      warehouse: "MAIN",
    },
    oa: null,
    pi: null,
    quotation: null,
  });
  assert.equal(refs.allocationNo, "MAR-ALLOC-0099");
  assert.equal(refs.quotationNo, "SHARED-QTN-0001");
  assert.equal(refs.orderAcknowledgementNo, "SHARED-OA-0001");
  assert.equal(refs.proformaNo, "SHARED-PI-0001");
  assert.equal(refs.customerReference, "");
  assert.equal(dashIfEmpty(refs.customerReference), "—");
});

run("CASE 6 — MAR-ALLOC-0015 production shape (QT → PI → ALLOC)", () => {
  const refs = buildAllocationDocumentReferences({
    allocation: {
      allocationNo: "MAR-ALLOC-0015",
      customerName: "ALTAMAR OCEANIC MANAGEMENT - FZCO LLC",
      warehouse: "MAIN",
      linkedQuotationNo: "MAR-QTN-0028",
      linkedOANo: "",
      linkedProformaNo: "MAR-PI-0014",
      allocationDate: "2026-07-15T00:00:00.000Z",
    },
    oa: null,
    pi: { proformaNo: "MAR-PI-0014", customerReference: undefined },
    quotation: {
      quotationNo: "MAR-QTN-0028",
      customerReference: "21200174",
    },
  });
  assert.equal(refs.allocationNo, "MAR-ALLOC-0015");
  assert.equal(refs.customerName, "ALTAMAR OCEANIC MANAGEMENT - FZCO LLC");
  assert.equal(refs.customerReference, "21200174");
  assert.equal(refs.quotationNo, "MAR-QTN-0028");
  assert.equal(refs.orderAcknowledgementNo, "");
  assert.equal(dashIfEmpty(refs.orderAcknowledgementNo), "—");
  assert.equal(refs.proformaNo, "MAR-PI-0014");
  assert.equal(refs.warehouse, "MAIN");
});

run("CASE 2b — OA present but empty PORef → fall through to PI", () => {
  assert.equal(
    resolveCustomerReferenceFromLineage({
      oa: { customerPORef: "" },
      pi: { customerReference: "FROM-PI" },
      quotation: { customerReference: "FROM-QT" },
    }),
    "FROM-PI"
  );
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
