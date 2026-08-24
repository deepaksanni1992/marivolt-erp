/**
 * ASN receiving-completeness gates — unit + wiring regression.
 * Run: node scripts/asnReceivingCompleteness.test.js
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertAsnReceivingComplete,
  groupAsnCompletenessMissingByArticle,
  validateAsnReceivingCompleteness,
} from "../src/utils/asnReceivingCompleteness.js";
import { ReceivingUnitError } from "../src/utils/receivingUnitRules.js";
import { ReceivingInspectionError } from "../src/utils/receivingInspectionRules.js";
import { assertValidTransition } from "../src/utils/asnRules.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcRoot = path.join(__dirname, "../src");
const feRoot = path.join(__dirname, "../../src");

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

function completeAsn(overrides = {}) {
  return {
    status: "ARRIVED",
    supplierInvoices: [{ invoiceNumber: "SI-100", invoiceDate: new Date("2026-01-15") }],
    countryOfOrigin: "",
    lines: [
      {
        _id: "L1",
        article: "91158622",
        asnQty: 10,
        uom: "PCS",
        hsCode: "840999",
        countryOfOrigin: "SG",
      },
    ],
    ...overrides,
  };
}

console.log("\nASN Receiving Completeness\n");

run("1. incomplete DRAFT ASN validates as incomplete but is not a lifecycle block (save allowed by design)", () => {
  const draft = completeAsn({
    status: "DRAFT",
    lines: [{ _id: "L1", article: "A1", asnQty: 5, uom: "PCS", hsCode: "", countryOfOrigin: "DE" }],
  });
  const r = validateAsnReceivingCompleteness(draft);
  assert.equal(r.complete, false);
  assert.ok(r.missing.some((m) => m.field === "hsCode"));
  // Ship transition DRAFT→SHIPPED remains allowed by lifecycle rules (soft warning only).
  assert.equal(assertValidTransition("DRAFT", "SHIPPED"), true);
});

run("2. missing HS blocks via assertAsnReceivingComplete (RU ErrorClass)", () => {
  const asn = completeAsn({
    lines: [{ _id: "L1", article: "91158622", asnQty: 10, uom: "PCS", hsCode: "", countryOfOrigin: "SG" }],
  });
  assert.throws(
    () => assertAsnReceivingComplete(asn, { ErrorClass: ReceivingUnitError }),
    (err) =>
      err instanceof ReceivingUnitError &&
      err.code === "ASN_INCOMPLETE" &&
      Array.isArray(err.details?.missing) &&
      err.details.missing.some((m) => m.field === "hsCode")
  );
});

run("3. missing HS blocks new receiving-session start (Inspection ErrorClass)", () => {
  const asn = completeAsn({
    lines: [{ _id: "L1", article: "91158622", asnQty: 10, uom: "PCS", hsCode: "", countryOfOrigin: "SG" }],
  });
  assert.throws(
    () => assertAsnReceivingComplete(asn, { ErrorClass: ReceivingInspectionError }),
    (err) => err instanceof ReceivingInspectionError && err.code === "ASN_INCOMPLETE"
  );
});

run("4. missing COO blocks when neither line nor header fallback exists", () => {
  const asn = completeAsn({
    countryOfOrigin: "",
    lines: [{ _id: "L1", article: "A1", asnQty: 1, uom: "PCS", hsCode: "8409", countryOfOrigin: "" }],
  });
  const r = validateAsnReceivingCompleteness(asn);
  assert.equal(r.complete, false);
  assert.ok(r.missing.some((m) => m.field === "countryOfOrigin" && m.code === "ASN_COO_REQUIRED"));
});

run("5. header COO fallback satisfies line COO rule", () => {
  const asn = completeAsn({
    countryOfOrigin: "Singapore",
    lines: [{ _id: "L1", article: "A1", asnQty: 1, uom: "PCS", hsCode: "8409", countryOfOrigin: "" }],
  });
  const r = validateAsnReceivingCompleteness(asn);
  assert.equal(r.complete, true);
  assert.equal(r.missing.length, 0);
});

run("6. missing supplier invoice number blocks", () => {
  const asn = completeAsn({
    supplierInvoices: [{ invoiceNumber: "", invoiceDate: new Date("2026-01-01") }],
  });
  const r = validateAsnReceivingCompleteness(asn);
  assert.equal(r.complete, false);
  assert.ok(r.missing.some((m) => m.field === "supplierInvoiceNumber" || m.code === "ASN_SUPPLIER_INVOICE_REQUIRED"));
});

run("7. missing supplier invoice date blocks", () => {
  const asn = completeAsn({
    supplierInvoices: [{ invoiceNumber: "SI-9", invoiceDate: null }],
  });
  const r = validateAsnReceivingCompleteness(asn);
  assert.equal(r.complete, false);
  assert.ok(
    r.missing.some(
      (m) => m.field === "supplierInvoiceDate" || m.code === "ASN_SUPPLIER_INVOICE_DATE_REQUIRED"
    )
  );
});

run("8. multiple lines return ALL missing fields in one response", () => {
  const asn = completeAsn({
    supplierInvoices: [],
    supplierInvoiceNumber: "",
    supplierInvoiceDate: null,
    countryOfOrigin: "",
    lines: [
      { _id: "L1", article: "91158622", asnQty: 1, uom: "PCS", hsCode: "", countryOfOrigin: "" },
      { _id: "L2", article: "91099622", asnQty: 2, uom: "PCS", hsCode: "", countryOfOrigin: "" },
      { _id: "L3", article: "911206822", asnQty: 3, uom: "PCS", hsCode: "", countryOfOrigin: "" },
    ],
  });
  const r = validateAsnReceivingCompleteness(asn);
  assert.equal(r.complete, false);
  const hs = r.missing.filter((m) => m.field === "hsCode");
  const coo = r.missing.filter((m) => m.field === "countryOfOrigin");
  assert.equal(hs.length, 3);
  assert.equal(coo.length, 3);
  assert.ok(r.missing.some((m) => String(m.field).startsWith("supplierInvoice") || m.field === "supplierInvoice"));
  assert.match(r.summary, /ASN cannot proceed to receiving/);
  assert.match(r.summary, /across 3 lines/);
  const grouped = groupAsnCompletenessMissingByArticle(r.missing);
  assert.equal(grouped.lines.length, 3);
});

run("9. complete ASN passes assert", () => {
  const r = assertAsnReceivingComplete(completeAsn(), { ErrorClass: ReceivingUnitError });
  assert.equal(r.complete, true);
});

run("10. gate wiring present on RU plan + print + receiving start (direct API bypass blocked)", () => {
  const ruSvc = fs.readFileSync(path.join(srcRoot, "services/receivingUnitService.js"), "utf8");
  const labelSvc = fs.readFileSync(path.join(srcRoot, "services/label/asnLabelService.js"), "utf8");
  const recvSvc = fs.readFileSync(path.join(srcRoot, "services/receivingInspectionService.js"), "utf8");
  assert.match(ruSvc, /assertAsnReceivingComplete/);
  assert.match(ruSvc, /planReceivingUnits[\s\S]*assertAsnReceivingComplete/);
  assert.match(labelSvc, /createJobsFromAsn[\s\S]*assertAsnReceivingComplete/);
  assert.match(labelSvc, /previewJobsFromAsn[\s\S]*assertAsnReceivingComplete/);
  assert.match(recvSvc, /assertAsnReceivingComplete/);
  // New session only — assert after existing-session resume branch
  const startIdx = recvSvc.indexOf("export async function startOrResumeReceivingSession");
  const slice = recvSvc.slice(startIdx, startIdx + 2500);
  const existingIdx = slice.indexOf("if (existing)");
  const assertIdx = slice.indexOf("assertAsnReceivingComplete");
  assert.ok(existingIdx >= 0 && assertIdx > existingIdx, "completeness gate must run only after existing-session check");
});

run("11–12. failed gate throws before mutation (no session/RU side effects from assert)", () => {
  let mutated = false;
  try {
    assertAsnReceivingComplete(
      completeAsn({
        lines: [{ _id: "L1", article: "X", asnQty: 1, uom: "PCS", hsCode: "", countryOfOrigin: "DE" }],
      }),
      { ErrorClass: ReceivingUnitError }
    );
    mutated = true;
  } catch (err) {
    assert.equal(err.code, "ASN_INCOMPLETE");
    assert.ok(Array.isArray(err.missing) || Array.isArray(err.details?.missing));
  }
  assert.equal(mutated, false);
});

run("13. existing already-started session resume path is not gated in source order", () => {
  const recvSvc = fs.readFileSync(path.join(srcRoot, "services/receivingInspectionService.js"), "utf8");
  const startIdx = recvSvc.indexOf("export async function startOrResumeReceivingSession");
  const slice = recvSvc.slice(startIdx, startIdx + 2500);
  assert.match(slice, /if \(existing\)[\s\S]*return \{ created: false, resumed: true/);
  const existingReturn = slice.indexOf("resumed: true");
  const assertIdx = slice.indexOf("assertAsnReceivingComplete");
  assert.ok(existingReturn < assertIdx);
});

run("14. GRN post-readiness validation remains separate / unchanged import surface", () => {
  const post = fs.readFileSync(path.join(srcRoot, "utils/asnReceivingPostReadiness.js"), "utf8");
  assert.doesNotMatch(post, /asnReceivingCompleteness/);
  assert.match(post, /resolveAsnLineCountryOfOrigin/);
  assert.match(post, /ASN_HS_CODE_REQUIRED/);
  const draft = fs.readFileSync(path.join(srcRoot, "services/asnReceivingDraftService.js"), "utf8");
  assert.doesNotMatch(draft, /asnReceivingCompleteness/);
});

run("15. ASN lifecycle Ship/Arrive remain allowed without completeness hard-block", () => {
  const asnSvc = fs.readFileSync(path.join(srcRoot, "services/asnService.js"), "utf8");
  const shipMatch = asnSvc.match(/export (?:async )?function shipAsn[\s\S]{0,1500}/);
  const arriveMatch = asnSvc.match(/export (?:async )?function arriveAsn[\s\S]{0,1500}/);
  assert.ok(shipMatch, "shipAsn export missing");
  assert.ok(arriveMatch, "arriveAsn export missing");
  assert.doesNotMatch(shipMatch[0], /assertAsnReceivingComplete/);
  assert.doesNotMatch(arriveMatch[0], /assertAsnReceivingComplete/);
  assert.equal(assertValidTransition("SHIPPED", "ARRIVED"), true);
});

run("error contract exposes ASN_INCOMPLETE + missing[] + multi-field message", () => {
  try {
    assertAsnReceivingComplete(
      completeAsn({
        lines: [
          { _id: "L1", article: "A", asnQty: 1, uom: "PCS", hsCode: "", countryOfOrigin: "DE" },
          { _id: "L2", article: "B", asnQty: 1, uom: "PCS", hsCode: "", countryOfOrigin: "DE" },
        ],
      }),
      { ErrorClass: ReceivingUnitError }
    );
    assert.fail("expected throw");
  } catch (err) {
    assert.equal(err.code, "ASN_INCOMPLETE");
    assert.ok(err.details.missing.length >= 2);
    assert.match(err.message, /required field/);
    assert.doesNotMatch(err.message, /^HS code missing$/i);
  }
});

run("legacy scalar supplier invoice fields satisfy document rule", () => {
  const asn = completeAsn({
    supplierInvoices: [],
    supplierInvoiceNumber: "LEGACY-SI",
    supplierInvoiceDate: new Date("2026-02-01"),
  });
  assert.equal(validateAsnReceivingCompleteness(asn).complete, true);
});

run("frontend completeness helpers and panel exist", () => {
  assert.ok(fs.existsSync(path.join(feRoot, "lib/asnReceivingCompleteness.js")));
  assert.ok(fs.existsSync(path.join(feRoot, "components/asn/AsnReceivingCompletenessPanel.jsx")));
  const asnPage = fs.readFileSync(path.join(feRoot, "pages/Asn.jsx"), "utf8");
  assert.match(asnPage, /AsnReceivingCompletenessPanel/);
  assert.match(asnPage, /shipArriveCompletenessWarning|confirmShipOrArrive/);
});

run("controllers return structured missing for ASN_INCOMPLETE", () => {
  const ruC = fs.readFileSync(path.join(srcRoot, "controllers/receivingUnitController.js"), "utf8");
  const riC = fs.readFileSync(path.join(srcRoot, "controllers/receivingInspectionController.js"), "utf8");
  const labelC = fs.readFileSync(path.join(srcRoot, "controllers/labelController.js"), "utf8");
  assert.match(ruC, /err\.missing/);
  assert.match(riC, /err\.missing/);
  assert.match(riC, /err\.details/);
  assert.match(labelC, /err\.details/);
  assert.match(labelC, /err\.missing/);
});

run("SI: one valid invoice among malformed rows is complete", () => {
  const asn = completeAsn({
    supplierInvoices: [
      { invoiceNumber: "", invoiceDate: null },
      { invoiceNumber: "GOOD-1", invoiceDate: new Date("2026-03-01") },
      { invoiceNumber: "BAD-DATE-ONLY", invoiceDate: null },
    ],
  });
  assert.equal(validateAsnReceivingCompleteness(asn).complete, true);
});

run("SI: blank invoice objects alone are incomplete (legacy fallback empty)", () => {
  const asn = completeAsn({
    supplierInvoices: [{}, { invoiceNumber: "  ", invoiceDate: "" }],
    supplierInvoiceNumber: "",
    supplierInvoiceDate: null,
  });
  const r = validateAsnReceivingCompleteness(asn);
  assert.equal(r.complete, false);
  assert.ok(r.missing.some((m) => String(m.field).startsWith("supplierInvoice") || m.field === "supplierInvoice"));
});

run("SI: number without date across all rows blocks date", () => {
  const asn = completeAsn({
    supplierInvoices: [
      { invoiceNumber: "A", invoiceDate: null },
      { invoiceNumber: "B", invoiceDate: "" },
    ],
  });
  const r = validateAsnReceivingCompleteness(asn);
  assert.equal(r.complete, false);
  assert.ok(r.missing.some((m) => m.field === "supplierInvoiceDate"));
});

run("does not require BOE / weights / putaway / disposition / valuation", () => {
  const asn = completeAsn({
    boeNumber: "",
    unitWeightKg: null,
    putawayLocation: "",
    acceptedQty: null,
    customsUnitValue: null,
    disposition: null,
  });
  assert.equal(validateAsnReceivingCompleteness(asn).complete, true);
  const fields = validateAsnReceivingCompleteness(
    completeAsn({
      lines: [
        {
          _id: "L1",
          article: "A1",
          asnQty: 1,
          uom: "PCS",
          hsCode: "",
          countryOfOrigin: "DE",
        },
      ],
    })
  ).missing.map((m) => m.field);
  assert.deepEqual(fields, ["hsCode"]);
});

run("16. reprint paths are not completeness-gated (existing printed RUs remain reprintable)", () => {
  const labelSvc = fs.readFileSync(path.join(srcRoot, "services/label/asnLabelService.js"), "utf8");
  const reprintOne = labelSvc.match(/export async function reprintReceivingUnit[\s\S]*?(?=export async function)/);
  const reprintAll = labelSvc.match(/export async function reprintAllReceivingUnits[\s\S]*$/);
  assert.ok(reprintOne, "reprintReceivingUnit missing");
  assert.ok(reprintAll, "reprintAllReceivingUnits missing");
  assert.doesNotMatch(reprintOne[0], /assertAsnReceivingComplete/);
  assert.doesNotMatch(reprintAll[0], /assertAsnReceivingComplete/);
});

run("15b. completed-session path does not auto-create when incomplete (gate before create)", () => {
  const recvSvc = fs.readFileSync(path.join(srcRoot, "services/receivingInspectionService.js"), "utf8");
  const startIdx = recvSvc.indexOf("export async function startOrResumeReceivingSession");
  const slice = recvSvc.slice(startIdx, startIdx + 2800);
  assert.match(slice, /findActiveSession/);
  assert.match(recvSvc, /status: \{ \$in: \["DRAFT", "IN_PROGRESS"\] \}/);
  const assertIdx = slice.indexOf("assertAsnReceivingComplete");
  const createIdx = slice.indexOf("ReceivingSession.create");
  assert.ok(assertIdx >= 0 && createIdx > assertIdx);
});

run("alternate ASN label endpoints share gated createJobsFromAsn/previewJobsFromAsn", () => {
  const routes = fs.readFileSync(path.join(srcRoot, "routes/labelRoutes.js"), "utf8");
  const labelC = fs.readFileSync(path.join(srcRoot, "controllers/labelController.js"), "utf8");
  const asnRoutes = fs.readFileSync(path.join(srcRoot, "routes/asnRoutes.js"), "utf8");
  const ruSvc = fs.readFileSync(path.join(srcRoot, "services/receivingUnitService.js"), "utf8");
  assert.match(routes, /jobs\/from-asn/);
  assert.match(labelC, /createJobsFromAsn/);
  assert.match(labelC, /previewJobsFromAsn/);
  assert.match(asnRoutes, /receiving-units\/plan/);
  assert.match(asnRoutes, /receiving-units\/print/);
  const planSlice = ruSvc.slice(ruSvc.indexOf("export async function planReceivingUnits"));
  assert.match(planSlice, /assertAsnReceivingComplete/);
  assert.ok(ruSvc.includes("ReceivingUnit.insertMany"));
});

run("no production repair / MAR-ASN-0006 mutation in completeness change", () => {
  const util = fs.readFileSync(path.join(srcRoot, "utils/asnReceivingCompleteness.js"), "utf8");
  assert.doesNotMatch(util, /MAR-ASN-0006|updateOne|findOneAndUpdate|\$set/);
  const asnSvc = fs.readFileSync(path.join(srcRoot, "services/asnService.js"), "utf8");
  // getAsn only attaches receivingCompleteness read model
  const getAsn = asnSvc.match(/export async function getAsn[\s\S]*?(?=export |async function |$)/);
  assert.ok(getAsn);
  assert.match(getAsn[0], /receivingCompleteness/);
  assert.doesNotMatch(getAsn[0], /\.save\(|updateOne|findOneAndUpdate/);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
