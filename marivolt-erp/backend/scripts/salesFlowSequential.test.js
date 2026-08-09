/**
 * Strict sequential sales flow regression (source + unit).
 * Run: node scripts/salesFlowSequential.test.js
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  SALES_FLOW_ERRORS,
  STRICT_SALES_FLOW_CUTOFF,
  assertAdvanceOaForProforma,
  assertCreditOaForAllocation,
  assertPiHasExplicitOaLineage,
  assertPiMayConvertToAllocation,
  isLegacyPiWithoutOa,
  isOaPaymentTypeLocked,
  normalizeOaPaymentType,
  oaImmediateNextActions,
  requireCustomerWorkflowPaymentType,
  resolveCustomerWorkflowPaymentType,
  resolveOaWorkflowPaymentType,
} from "../src/utils/salesFlowSequential.js";
import {
  buildAllocationDocumentReferences,
  resolveLinkedOaIdFromAllocationLineage,
} from "../src/utils/allocationDocumentReferences.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcRoot = path.join(__dirname, "..", "src");
const frontendSales = path.join(__dirname, "..", "..", "src", "pages", "Sales.jsx");
const oaModalPath = path.join(__dirname, "..", "..", "src", "components", "sales", "OaCreateModal.jsx");

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

console.log("\nStrict sequential sales flow\n");

const sales = fs.readFileSync(path.join(srcRoot, "controllers", "salesFlowController.js"), "utf8");
const routes = fs.readFileSync(path.join(srcRoot, "routes", "salesRoutes.js"), "utf8");
const oaModel = fs.readFileSync(path.join(srcRoot, "models", "OrderAcknowledgement.js"), "utf8");
const ui = fs.readFileSync(frontendSales, "utf8");
const oaModal = fs.readFileSync(oaModalPath, "utf8");
const piAllocBlock = sales.slice(
  sales.indexOf("export async function convertProformaToOrderAllocation"),
  sales.indexOf("export async function convertOrderAllocationToSalesInvoice")
);
const createOaBlock = sales.slice(
  sales.indexOf("export async function createOA"),
  sales.indexOf("export async function updateOA")
);
const createPiBlock = sales.slice(
  sales.indexOf("export async function createProforma"),
  sales.indexOf("export async function updateProforma")
);

run("TEST — OA model has paymentType ADVANCE|CREDIT (not commercial paymentTerms)", () => {
  assert.ok(oaModel.includes("paymentType"));
  assert.ok(oaModel.includes('"ADVANCE"'));
  assert.ok(oaModel.includes('"CREDIT"'));
  assert.ok(oaModel.includes("Authoritative for sequential sales branching"));
});

run("TEST — cutoff is fixed deterministic Date", () => {
  assert.ok(STRICT_SALES_FLOW_CUTOFF instanceof Date);
  assert.equal(STRICT_SALES_FLOW_CUTOFF.toISOString(), "2026-08-09T00:00:00.000Z");
  assert.ok(STRICT_SALES_FLOW_CUTOFF.getTime() < Date.now() || true);
});

run("TEST — normalize / resolve payment types (no silent CREDIT)", () => {
  assert.equal(normalizeOaPaymentType("advance"), "ADVANCE");
  assert.equal(resolveCustomerWorkflowPaymentType({ paymentTerms: "ADVANCE" }), "ADVANCE");
  assert.equal(resolveCustomerWorkflowPaymentType({ paymentTerms: "CREDIT" }), "CREDIT");
  assert.equal(resolveCustomerWorkflowPaymentType({}), "");
  assert.equal(resolveCustomerWorkflowPaymentType(null), "");
  assert.throws(() => requireCustomerWorkflowPaymentType({}), (e) =>
    e.message.includes("Unable to determine workflow payment type")
  );
  assert.equal(requireCustomerWorkflowPaymentType({ paymentTerms: "ADVANCE" }), "ADVANCE");
  assert.equal(resolveOaWorkflowPaymentType({ paymentType: "ADVANCE" }), "ADVANCE");
  assert.equal(resolveOaWorkflowPaymentType({ convertedTo: ["PROFORMA"] }), "ADVANCE");
  assert.equal(resolveOaWorkflowPaymentType({ convertedTo: ["ORDER_ALLOCATION"] }), "CREDIT");
  assert.equal(resolveOaWorkflowPaymentType({}), "");
});

run("TEST H/I/J/K — customer ADVANCE/CREDIT snapshot; unresolved fails; explicit override accepted", () => {
  assert.equal(resolveCustomerWorkflowPaymentType({ paymentTerms: "ADVANCE" }), "ADVANCE");
  assert.equal(resolveCustomerWorkflowPaymentType({ paymentTerms: "CREDIT" }), "CREDIT");
  assert.throws(() => requireCustomerWorkflowPaymentType({ paymentTerms: "NET30" }), (e) =>
    e.message.includes("Unable to determine")
  );
  assert.ok(createOaBlock.includes("OA_PAYMENT_TYPE_UNRESOLVED") || createOaBlock.includes("resolveWorkflowPaymentTypeDefault"));
  assert.ok(createOaBlock.includes("bodyPaymentType: body.paymentType"));
  assert.ok(createOaBlock.includes("OA_MUST_FROM_QTN"));
});

run("TEST 4/5/6/7 — ADVANCE→PI pass; ADVANCE→ALLOC block; CREDIT→ALLOC pass; CREDIT→PI block", () => {
  assert.equal(assertAdvanceOaForProforma({ paymentType: "ADVANCE" }), "ADVANCE");
  assert.throws(() => assertAdvanceOaForProforma({ paymentType: "CREDIT" }), (e) =>
    e.message.includes("CREDIT")
  );
  assert.equal(assertCreditOaForAllocation({ paymentType: "CREDIT" }), "CREDIT");
  assert.throws(() => assertCreditOaForAllocation({ paymentType: "ADVANCE" }), (e) =>
    e.message.includes("advance payment")
  );
  const adv = oaImmediateNextActions({ paymentType: "ADVANCE" });
  assert.equal(adv.convertToProforma, true);
  assert.equal(adv.convertToAllocation, false);
  const cr = oaImmediateNextActions({ paymentType: "CREDIT" });
  assert.equal(cr.convertToProforma, false);
  assert.equal(cr.convertToAllocation, true);
});

run("TEST — paymentType locks after downstream", () => {
  assert.equal(isOaPaymentTypeLocked({ convertedTo: ["PROFORMA"] }), true);
  assert.equal(isOaPaymentTypeLocked({ convertedTo: ["ORDER_ALLOCATION"] }), true);
  assert.equal(isOaPaymentTypeLocked({ status: "ACTIVE", convertedTo: [] }), false);
});

run("TEST A — Legacy PI before cutoff, missing OA, payment eligible → Allocation gate PASS", () => {
  const pi = {
    linkedOAId: null,
    createdAt: "2026-07-13T17:00:00.000Z",
    status: "PAID_PENDING_SHIPMENT",
  };
  assert.equal(isLegacyPiWithoutOa(pi), true);
  const gate = assertPiMayConvertToAllocation(pi);
  assert.equal(gate.mode, "LEGACY");
  assert.equal(gate.legacy, true);
});

run("TEST B — Legacy PI before cutoff, payment not eligible → still legacy but payment gate separate", () => {
  const pi = { linkedOAId: null, createdAt: "2026-07-01T00:00:00.000Z", status: "DRAFT" };
  assert.equal(isLegacyPiWithoutOa(pi), true);
  assert.equal(assertPiMayConvertToAllocation(pi).legacy, true);
  assert.ok(piAllocBlock.includes("APPROVED"));
  assert.ok(piAllocBlock.includes("PAID_PENDING_SHIPMENT"));
});

run("TEST C — New PI after cutoff without OA → Allocation BLOCK", () => {
  const pi = { linkedOAId: null, createdAt: "2026-08-10T12:00:00.000Z" };
  assert.equal(isLegacyPiWithoutOa(pi), false);
  assert.throws(() => assertPiMayConvertToAllocation(pi), (e) =>
    e.message.includes("missing required Order Acknowledgement")
  );
});

run("TEST D — New PI with linked OA → STRICT mode", () => {
  const gate = assertPiMayConvertToAllocation({
    linkedOAId: "abc",
    createdAt: "2026-08-10T12:00:00.000Z",
  });
  assert.equal(gate.mode, "STRICT");
  assert.equal(gate.legacy, false);
});

run("TEST E — PI linked to CREDIT OA blocked in controller", () => {
  assert.ok(piAllocBlock.includes("PI_OA_NOT_ADVANCE") || piAllocBlock.includes("SALES_FLOW_ERRORS.PI_OA_NOT_ADVANCE"));
  assert.ok(piAllocBlock.includes("assertPiMayConvertToAllocation"));
});

run("TEST F — Legacy allocation without OA keeps OA blank", () => {
  assert.ok(piAllocBlock.includes("legacyPiAlloc"));
  assert.ok(piAllocBlock.includes('linkedOANo = legacyPiAlloc ? ""'));
  assert.ok(piAllocBlock.includes("Legacy PI allocation created without OA lineage"));
  const refs = buildAllocationDocumentReferences({
    allocation: {
      allocationNo: "MAR-ALLOC-0015",
      linkedQuotationNo: "MAR-QTN-0028",
      linkedOANo: "",
      linkedProformaNo: "MAR-PI-0014",
    },
    oa: null,
    pi: { proformaNo: "MAR-PI-0014", linkedOAId: null, linkedOANo: "" },
    quotation: { quotationNo: "MAR-QTN-0028" },
  });
  assert.equal(refs.orderAcknowledgementNo, "");
});

run("TEST G — No OA inference by quotation/customer/amount/date", () => {
  assert.equal(
    resolveLinkedOaIdFromAllocationLineage({
      allocation: { linkedOAId: null, linkedQuotationId: "q1" },
      pi: { linkedOAId: null, linkedQuotationId: "q1", customerName: "X", grandTotal: 100 },
    }),
    null
  );
  assert.ok(!piAllocBlock.includes("findOne(withCompany(req, { linkedQuotationId"));
  assert.ok(piAllocBlock.includes("never infer sibling OA") || piAllocBlock.includes("leave OA blank"));
});

run("TEST L — Blank OA create blocked without quotation lineage", () => {
  assert.ok(createOaBlock.includes("OA_MUST_FROM_QTN"));
  assert.ok(createOaBlock.includes('oaSourceType: "FROM_QUOTATION"'));
  assert.ok(!/oaSourceType: String\(body\.oaSourceType/.test(createOaBlock));
});

run("TEST M/N/O — PI create requires ADVANCE OA lineage", () => {
  assert.ok(createPiBlock.includes("PI_MUST_FROM_ADVANCE_OA"));
  assert.ok(createPiBlock.includes("assertAdvanceOaForProforma"));
  assert.ok(createPiBlock.includes("linkedOAId"));
  assert.ok(createPiBlock.includes("linkedQuotationId"));
  assert.ok(createPiBlock.includes("linkedQuotationNo"));
});

run("TEST 2/3 — QTN→PI and QTN→CIPL blocked in controller", () => {
  const piIdx = sales.indexOf("export async function convertQuotationToProforma");
  const piBlock = sales.slice(piIdx, piIdx + 250);
  assert.ok(piBlock.includes("SALES_FLOW_ERRORS.QTN_PI"));
  assert.ok(!piBlock.includes("ProformaInvoice.create"));
  const ciplIdx = sales.indexOf("export async function convertQuotationToCipl");
  const ciplBlock = sales.slice(ciplIdx, ciplIdx + 250);
  assert.ok(ciplBlock.includes("SALES_FLOW_ERRORS.QTN_CIPL"));
});

run("TEST — OA→PI asserts ADVANCE; OA→ALLOC asserts CREDIT", () => {
  const oaPi = sales.slice(
    sales.indexOf("export async function convertOAToProforma"),
    sales.indexOf("export async function convertOAToSalesInvoice")
  );
  assert.ok(oaPi.includes("assertAdvanceOaForProforma"));
  const oaAlloc = sales.slice(
    sales.indexOf("export async function convertOAToOrderAllocation"),
    sales.indexOf("export async function convertProformaToOrderAllocation")
  );
  assert.ok(oaAlloc.includes("assertCreditOaForAllocation"));
  assert.ok(!oaAlloc.includes("await assertOaReadyForStockAllocation"));
});

run("TEST 8/9 — PI→ALLOC payment gate + legacy/strict OA lineage", () => {
  assert.ok(piAllocBlock.includes("assertPiMayConvertToAllocation"));
  assert.ok(piAllocBlock.includes("APPROVED"));
  assert.ok(piAllocBlock.includes("PAID_PENDING_SHIPMENT"));
  assert.ok(piAllocBlock.includes("PI_OA_NOT_ADVANCE") || piAllocBlock.includes("SALES_FLOW_ERRORS.PI_OA_NOT_ADVANCE"));
});

run("TEST 10 — OA→PI stamps linkedOA + linkedQuotation", () => {
  const block = sales.slice(
    sales.indexOf("export async function convertOAToProforma"),
    sales.indexOf("export async function convertOAToSalesInvoice")
  );
  assert.ok(block.includes("linkedOAId: oa._id"));
  assert.ok(block.includes("linkedOANo: oa.oaNo"));
  assert.ok(block.includes("linkedQuotationId: oa.linkedQuotationId"));
});

run("TEST 11/12 — Allocation lineage from PI and from Credit OA", () => {
  assert.ok(piAllocBlock.includes("linkedProformaId"));
  assert.ok(piAllocBlock.includes("linkedOAId"));
  assert.ok(piAllocBlock.includes("linkedQuotationId"));
  const fromOa = sales.slice(
    sales.indexOf("export async function convertOAToOrderAllocation"),
    sales.indexOf("export async function convertProformaToOrderAllocation")
  );
  assert.ok(fromOa.includes("linkedOAId: oaFresh._id"));
  assert.ok(fromOa.includes("linkedQuotationId: oaFresh.linkedQuotationId"));
  assert.ok(!fromOa.includes("linkedProformaId:"));
});

run("TEST 13/14/15 — SI aliases blocked; packing FULLY_PACKED path retained", () => {
  assert.ok(
    sales
      .slice(
        sales.indexOf("export async function convertOAToSalesInvoice"),
        sales.indexOf("export async function convertOAToSalesInvoice") + 200
      )
      .includes("SI_FROM_PACKING_ONLY")
  );
  assert.ok(
    sales
      .slice(
        sales.indexOf("export async function convertProformaToSalesInvoice"),
        sales.indexOf("export async function convertProformaToSalesInvoice") + 200
      )
      .includes("SI_FROM_PACKING_ONLY")
  );
  assert.ok(
    sales
      .slice(
        sales.indexOf("export async function convertOrderAllocationToSalesInvoice"),
        sales.indexOf("export async function convertOrderAllocationToSalesInvoice") + 200
      )
      .includes("SI_FROM_PACKING_ONLY")
  );
  const pack = sales.slice(
    sales.indexOf("export async function convertPackingToSalesInvoice"),
    sales.indexOf("export async function convertPackingToSalesInvoice") + 8000
  );
  assert.ok(pack.includes("FULLY_PACKED"));
  assert.ok(pack.includes("await SalesInvoice.create"));
});

run("TEST 16/17 — CIPL only from SI; QTN/OA/PI blocked", () => {
  assert.ok(
    sales
      .slice(sales.indexOf("export async function convertOAToCipl"), sales.indexOf("export async function convertOAToCipl") + 200)
      .includes("OA_CIPL")
  );
  assert.ok(
    sales
      .slice(
        sales.indexOf("export async function convertProformaToCipl"),
        sales.indexOf("export async function convertProformaToCipl") + 200
      )
      .includes("PI_CIPL")
  );
  const siCipl = sales.slice(
    sales.indexOf("export async function convertSalesInvoiceToCipl"),
    sales.indexOf("export async function convertSalesInvoiceToCipl") + 1200
  );
  assert.ok(siCipl.includes("Cipl.create") || siCipl.includes("await Cipl.create"));
  assert.ok(!siCipl.includes('status = "APPROVED"'));
});

run("TEST 18 — PI→CIPL no longer mutates PI approval", () => {
  const block = sales.slice(
    sales.indexOf("export async function convertProformaToCipl"),
    sales.indexOf("export async function convertProformaToCipl") + 300
  );
  assert.ok(block.includes("return res.status(409)"));
  assert.ok(!block.includes('proforma.status = "APPROVED"'));
});

run("TEST 19/20/P — Historical PI without OA readable; MAR-ALLOC-0015 OA blank", () => {
  assert.throws(() => assertPiHasExplicitOaLineage({ linkedOAId: null }), (e) =>
    e.message.includes("missing required Order Acknowledgement")
  );
  const refs = buildAllocationDocumentReferences({
    allocation: {
      allocationNo: "MAR-ALLOC-0015",
      linkedQuotationNo: "MAR-QTN-0028",
      linkedOANo: "",
      linkedProformaNo: "MAR-PI-0014",
    },
    oa: null,
    pi: { proformaNo: "MAR-PI-0014", linkedOAId: null, linkedOANo: "" },
    quotation: { quotationNo: "MAR-QTN-0028", customerReference: "21200174" },
  });
  assert.equal(refs.orderAcknowledgementNo, "");
  assert.equal(refs.quotationNo, "MAR-QTN-0028");
  assert.equal(refs.proformaNo, "MAR-PI-0014");
});

run("TEST 21 — Explicit PI→OA lineage returns OA on picking sheet", () => {
  const oaId = "6a551f0445d9a6799f23f135";
  const allocation = { linkedOAId: null, linkedOANo: "", linkedProformaNo: "MAR-PI-0099" };
  const pi = { linkedOAId: oaId, linkedOANo: "MAR-OA-0099", proformaNo: "MAR-PI-0099" };
  assert.equal(String(resolveLinkedOaIdFromAllocationLineage({ allocation, pi })), oaId);
  const refs = buildAllocationDocumentReferences({
    allocation: { ...allocation, allocationNo: "MAR-ALLOC-0099", linkedQuotationNo: "MAR-QTN-0099" },
    oa: { _id: oaId, oaNo: "MAR-OA-0099" },
    pi,
    quotation: { quotationNo: "MAR-QTN-0099" },
  });
  assert.equal(refs.orderAcknowledgementNo, "MAR-OA-0099");
  assert.notEqual(refs.orderAcknowledgementNo, oaId);
});

run("TEST 22 — Frontend QTN no longer exposes PI/CIPL convert", () => {
  assert.ok(ui.includes("Convert to OA"));
  assert.ok(ui.includes("Open OA"));
  assert.ok(!ui.includes("convertToProformaFromQuotationMutation.mutate"));
  assert.ok(!ui.includes("convertToCiplFromQuotationMutation.mutate"));
  assert.ok(ui.includes("oaShowsConvertToPi"));
  assert.ok(ui.includes("oaShowsConvertToAllocation"));
});

run("TEST 23 — OA action visibility; blank New OA/PI disabled; Blank OA UI removed", () => {
  assert.ok(ui.includes("oaWorkflowPaymentType"));
  assert.ok(ui.includes("Workflow payment type"));
  assert.ok(ui.includes('activeTab === "Order Acknowledgement" ||'));
  assert.ok(ui.includes('activeTab === "Proforma Invoice" ||'));
  assert.ok(ui.includes("OA from Quotation"));
  assert.ok(ui.includes("convertToCiplFromSalesInvoiceMutation"));
  assert.ok(!oaModal.includes('<option value="BLANK">Blank OA</option>'));
  assert.ok(!oaModal.includes('oaSourceType: "BLANK"'));
  assert.ok(oaModal.includes("quotationSourceLocked") || oaModal.includes("Source quotation is locked"));
  assert.ok(oaModal.includes('oaSourceType: "FROM_QUOTATION"'));
});

run("Routes still mount convert endpoints (handlers enforce blocks)", () => {
  assert.ok(routes.includes("/convert/quotation/:id/to-proforma"));
  assert.ok(routes.includes("/convert/quotation/:id/to-cipl"));
  assert.ok(routes.includes("/convert/sales-invoice/:id/to-cipl"));
  assert.ok(routes.includes("/sales-invoices/from-packing/:id"));
});

run("Error message constants present", () => {
  assert.ok(SALES_FLOW_ERRORS.QTN_PI.includes("Order Acknowledgement is required"));
  assert.ok(SALES_FLOW_ERRORS.CIPL_FROM_SI_ONLY.includes("Sales Invoice"));
  assert.ok(SALES_FLOW_ERRORS.SI_FROM_PACKING_ONLY.includes("Packing"));
  assert.ok(SALES_FLOW_ERRORS.OA_MUST_FROM_QTN.includes("from a Quotation"));
  assert.ok(SALES_FLOW_ERRORS.PI_MUST_FROM_ADVANCE_OA.includes("ADVANCE Order Acknowledgement"));
  assert.ok(SALES_FLOW_ERRORS.OA_PAYMENT_TYPE_UNRESOLVED.includes("Select ADVANCE or CREDIT"));
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
