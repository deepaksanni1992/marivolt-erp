/**
 * Allocation document references / Customer Ref lineage (picking sheet).
 * Run: node scripts/allocationDocumentReferences.test.js
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildAllocationDocumentReferences,
  dashIfEmpty,
  resolveCustomerReferenceFromLineage,
  resolveLinkedOaIdFromAllocationLineage,
} from "../src/utils/allocationDocumentReferences.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcRoot = path.join(__dirname, "..", "src");

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

console.log("\nAllocation document references (picking sheet OA lineage)\n");

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

run("CASE 6 — MAR-ALLOC-0015 historical: empty alloc OA, resolve via PI → OA", () => {
  const oaId = "6873ab000000000000000018";
  const allocation = {
    allocationNo: "MAR-ALLOC-0015",
    customerName: "ALTAMAR OCEANIC MANAGEMENT - FZCO LLC",
    warehouse: "MAIN",
    linkedQuotationNo: "MAR-QTN-0028",
    linkedOAId: null,
    linkedOANo: "",
    linkedProformaId: "6873ab000000000000000014",
    linkedProformaNo: "MAR-PI-0014",
    allocationDate: "2026-07-15T00:00:00.000Z",
  };
  const pi = {
    _id: "6873ab000000000000000014",
    proformaNo: "MAR-PI-0014",
    linkedOAId: oaId,
    linkedOANo: "MAR-OA-0018",
    customerReference: undefined,
  };
  const oa = { _id: oaId, oaNo: "MAR-OA-0018", customerPORef: "" };
  const quotation = {
    quotationNo: "MAR-QTN-0028",
    customerReference: "21200174",
  };

  assert.equal(String(resolveLinkedOaIdFromAllocationLineage({ allocation, pi })), oaId);

  const refs = buildAllocationDocumentReferences({ allocation, oa, pi, quotation });
  assert.equal(refs.allocationNo, "MAR-ALLOC-0015");
  assert.equal(refs.customerName, "ALTAMAR OCEANIC MANAGEMENT - FZCO LLC");
  assert.equal(refs.customerReference, "21200174");
  assert.equal(refs.quotationNo, "MAR-QTN-0028");
  assert.equal(refs.orderAcknowledgementNo, "MAR-OA-0018");
  assert.notEqual(refs.orderAcknowledgementNo, oaId);
  assert.equal(refs.proformaNo, "MAR-PI-0014");
  assert.equal(refs.warehouse, "MAIN");
});

run("CASE 6b — historical: OA doc missing but PI.linkedOANo present", () => {
  const refs = buildAllocationDocumentReferences({
    allocation: {
      allocationNo: "MAR-ALLOC-0015",
      linkedQuotationNo: "MAR-QTN-0028",
      linkedOANo: "",
      linkedProformaNo: "MAR-PI-0014",
    },
    oa: null,
    pi: { proformaNo: "MAR-PI-0014", linkedOANo: "MAR-OA-0018" },
    quotation: { quotationNo: "MAR-QTN-0028" },
  });
  assert.equal(refs.orderAcknowledgementNo, "MAR-OA-0018");
});

run("QTN → OA → PI → Allocation (full denormalized on alloc)", () => {
  const refs = buildAllocationDocumentReferences({
    allocation: {
      allocationNo: "MAR-ALLOC-0020",
      linkedQuotationNo: "MAR-QTN-0030",
      linkedOANo: "MAR-OA-0020",
      linkedProformaNo: "MAR-PI-0020",
    },
    oa: { oaNo: "MAR-OA-0020" },
    pi: { proformaNo: "MAR-PI-0020", linkedOANo: "MAR-OA-0020" },
    quotation: { quotationNo: "MAR-QTN-0030" },
  });
  assert.equal(refs.quotationNo, "MAR-QTN-0030");
  assert.equal(refs.orderAcknowledgementNo, "MAR-OA-0020");
  assert.equal(refs.proformaNo, "MAR-PI-0020");
  assert.equal(refs.allocationNo, "MAR-ALLOC-0020");
});

run("QTN → OA → Allocation (no PI)", () => {
  const refs = buildAllocationDocumentReferences({
    allocation: {
      allocationNo: "MAR-ALLOC-0021",
      linkedQuotationNo: "MAR-QTN-0031",
      linkedOANo: "MAR-OA-0021",
      linkedProformaNo: "",
    },
    oa: { oaNo: "MAR-OA-0021", customerPORef: "PO-OA-21" },
    pi: null,
    quotation: { quotationNo: "MAR-QTN-0031", customerReference: "QT-ignored" },
  });
  assert.equal(refs.quotationNo, "MAR-QTN-0031");
  assert.equal(refs.orderAcknowledgementNo, "MAR-OA-0021");
  assert.equal(refs.proformaNo, "");
  assert.equal(refs.customerReference, "PO-OA-21");
  assert.equal(resolveLinkedOaIdFromAllocationLineage({ allocation: { linkedOAId: "oa21" }, pi: null }), "oa21");
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

run("Live sources — packing lineage loads OA via PI when alloc OA blank", () => {
  const store = fs.readFileSync(path.join(srcRoot, "controllers", "storeOutboundController.js"), "utf8");
  const idx = store.indexOf("async function loadAllocationLineageDocs");
  assert.ok(idx > 0);
  const block = store.slice(idx, idx + 1200);
  assert.ok(block.includes("resolveLinkedOaIdFromAllocationLineage"));
  assert.ok(block.includes("linkedProformaId"));
  // Must not only gate OA load on allocation.linkedOAId alone
  assert.ok(!/allocation\?\.linkedOAId\s*\?\s*OrderAcknowledgement\.findOne/.test(block));

  const sales = fs.readFileSync(path.join(srcRoot, "controllers", "salesFlowController.js"), "utf8");
  const convIdx = sales.indexOf("export async function convertProformaToOrderAllocation");
  const conv = sales.slice(convIdx, convIdx + 9000);
  assert.ok(conv.includes("linkedOAId"));
  assert.ok(conv.includes("linkedOANo"));
  assert.ok(
    /select\("oaNo(?:\s+paymentType)?"\)/.test(conv),
    "PI→ALLOC must resolve blank linkedOANo from OA"
  );
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
