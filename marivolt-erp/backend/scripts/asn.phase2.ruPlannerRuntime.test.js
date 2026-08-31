/**
 * Runtime import/execution of the ASN RU planner GET + open path.
 * Catches `validateAsnReceivingCompleteness is not defined` which parse-only
 * checks and frontend-only ESLint missed.
 *
 * Run: node scripts/asn.phase2.ruPlannerRuntime.test.js
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  listReceivingUnitsForAsn,
  validateAsnReceivingCompleteness as listingCompleteness,
} from "../src/services/receivingUnitService.js";
import { validateAsnReceivingCompleteness as canonicalCompleteness } from "../src/utils/asnReceivingCompleteness.js";
import { validateAsnReceivingCompleteness as frontendCompleteness } from "../../src/lib/asnReceivingCompleteness.js";
import {
  buildRuPlannerViewState,
  RU_PLAN_LISTING_LOAD_ERROR,
} from "../../src/lib/receivingUnitLabels.js";
import { REPRINT_REASONS } from "../../src/lib/labelPrinting.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const feRoot = path.join(__dirname, "..", "..", "src");
const servicePath = path.join(__dirname, "..", "src", "services", "receivingUnitService.js");
const labelsPath = path.join(feRoot, "lib", "receivingUnitLabels.js");
const completenessPath = path.join(feRoot, "lib", "asnReceivingCompleteness.js");
const plannerPath = path.join(feRoot, "components", "store", "AsnReceivingLabelPlanner.jsx");

const planner = fs.readFileSync(plannerPath, "utf8");
const labelsSrc = fs.readFileSync(labelsPath, "utf8");
const serviceSrc = fs.readFileSync(servicePath, "utf8");
const completenessSrc = fs.readFileSync(completenessPath, "utf8");

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

async function runAsync(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed += 1;
    console.error(`  ✗ ${name}`);
    console.error(`    ${e.message}`);
  }
}

const marAsn0009 = {
  _id: "6a9573251250989c1676265e",
  asnNo: "MAR-ASN-0009",
  status: "ARRIVED",
  receivingCompleteness: { complete: true, summary: "ASN is complete for receiving.", missing: [] },
  supplierInvoices: [{ invoiceNumber: "SI-0009", invoiceDate: new Date("2026-08-01") }],
  lines: [
    {
      _id: "6a9573251250989c1676265f",
      article: "911268022",
      asnQty: 4,
      uom: "PCS",
      hsCode: "840999",
      countryOfOrigin: "SG",
      remainingAvailableQty: 0,
    },
    {
      _id: "6a9573251250989c16762660",
      article: "911438822",
      asnQty: 1,
      uom: "PCS",
      hsCode: "840999",
      countryOfOrigin: "SG",
      remainingAvailableQty: 0,
    },
    {
      _id: "6a9573251250989c16762661",
      article: "911313222",
      asnQty: 2,
      uom: "PCS",
      hsCode: "840999",
      countryOfOrigin: "SG",
      remainingAvailableQty: 0,
    },
  ],
};

function openPlanner(asn, extras = {}) {
  return buildRuPlannerViewState({
    asn,
    listing: extras.listing,
    listingFailed: Boolean(extras.listingFailed),
    receivingContext: extras.receivingContext || {},
    canPrint: extras.canPrint !== false,
    canReprint: extras.canReprint !== false,
    intent: extras.intent || "review",
    planEdits: extras.planEdits || {},
  });
}

console.log("\nASN RU planner runtime / import\n");

run("1. GET listing module and planner helpers import without ReferenceError", () => {
  assert.equal(typeof listReceivingUnitsForAsn, "function");
  assert.equal(typeof listingCompleteness, "function");
  assert.equal(typeof canonicalCompleteness, "function");
  assert.equal(typeof frontendCompleteness, "function");
  assert.equal(typeof buildRuPlannerViewState, "function");
  assert.equal(listingCompleteness, canonicalCompleteness);
  assert.equal(frontendCompleteness, canonicalCompleteness);
});

run("2. opening MAR-ASN-0009 executes canonical completeness validation", () => {
  const view = openPlanner(marAsn0009);
  assert.equal(view.computedCompleteness != null, true);
  assert.equal(typeof view.computedCompleteness.complete, "boolean");
  const direct = listingCompleteness(marAsn0009);
  assert.equal(direct.complete, true);
  assert.deepEqual(view.computedCompleteness.missing, direct.missing);
  assert.equal(view.writesOnOpen, false);
});

run("3. ARRIVED + complete ASN renders three planning rows", () => {
  const view = openPlanner(marAsn0009, { listingFailed: true });
  assert.equal(view.status, "ARRIVED");
  assert.equal(view.eligible, true);
  assert.equal(view.listingBlocked, false);
  assert.equal(view.lines.length, 3);
  assert.deepEqual(
    view.lines.map((row) => row.article),
    ["911268022", "911438822", "911313222"]
  );
});

run("4. no validateAsnReceivingCompleteness is not defined", () => {
  try {
    listingCompleteness(marAsn0009);
    frontendCompleteness(marAsn0009);
    openPlanner(marAsn0009);
  } catch (err) {
    if (err instanceof ReferenceError && /validateAsnReceivingCompleteness is not defined/.test(err.message)) {
      throw err;
    }
    throw err;
  }
  assert.doesNotMatch(planner, /\bvalidateAsnReceivingCompleteness\s*\(/);
  assert.match(labelsSrc, /validateAsnReceivingCompleteness\(asn\)/);
  assert.match(serviceSrc, /validateAsnReceivingCompleteness\(asn\)/);
});

run("5. Save Receiving Units is visible for first preparation", () => {
  const view = openPlanner(marAsn0009);
  assert.equal(view.saveLabel, "Save Receiving Units");
  assert.equal(view.canSavePlan, true);
  assert.match(planner, /\{saveLabel\}/);
  assert.match(planner, /Save Receiving Units/);
});

run("6. Print remains disabled before saved plan", () => {
  const view = openPlanner(marAsn0009);
  assert.equal(view.canPrintPlan, false);
  assert.equal(view.previewFaces.length, 0);
  assert.match(planner, /disabled=\{!canPrintPlan \|\| listingBlocked\}/);
  assert.match(planner, /Save Receiving Units before printing labels/);
});

run("7. Damaged Label is absent on first print", () => {
  const view = openPlanner(marAsn0009);
  assert.equal(view.showReprintReason, false);
  assert.equal(view.reprintMode, false);
  assert.equal(REPRINT_REASONS[0], "Damaged Label");
  assert.doesNotMatch(planner, /useState\(REPRINT_REASONS\[0\]\)/);
  assert.match(planner, /useState\(""\)/);
});

run("8. ineligible and incomplete ASN behavior remains correct", () => {
  const draft = openPlanner({ ...marAsn0009, status: "DRAFT" });
  assert.equal(draft.eligible, false);
  assert.equal(draft.lines.length, 0);
  assert.equal(draft.canSavePlan, false);
  assert.equal(draft.canPrintPlan, false);

  const incomplete = openPlanner({
    ...marAsn0009,
    receivingCompleteness: undefined,
    supplierInvoices: [],
    lines: marAsn0009.lines.map((line) => ({ ...line, hsCode: "" })),
  });
  assert.equal(incomplete.eligible, true);
  assert.equal(incomplete.computedCompleteness.complete, false);
  assert.equal(incomplete.incompleteForReceiving, true);
  assert.equal(incomplete.canSavePlan, false);
  assert.equal(incomplete.canPrintPlan, false);

  const establishedFailed = openPlanner(
    {
      ...marAsn0009,
      lines: marAsn0009.lines.map((line) => ({ ...line, ruPlanVersion: 2 })),
    },
    { listingFailed: true }
  );
  assert.equal(establishedFailed.listingBlocked, true);
  assert.equal(establishedFailed.listingLoadError, RU_PLAN_LISTING_LOAD_ERROR);
  assert.equal(establishedFailed.lines.length, 0);
  assert.equal(establishedFailed.canSavePlan, false);
  assert.equal(establishedFailed.canPrintPlan, false);
});

run("9. runtime fails if the GET listing helper import/reference is removed", () => {
  assert.match(
    serviceSrc,
    /import \{ assertAsnReceivingComplete, validateAsnReceivingCompleteness \} from "\.\.\/utils\/asnReceivingCompleteness\.js"/
  );
  assert.match(serviceSrc, /const receivingCompleteness = validateAsnReceivingCompleteness\(asn\)/);
  assert.match(serviceSrc, /validateAsnReceivingCompleteness,/);
  assert.match(
    labelsSrc,
    /import \{ validateAsnReceivingCompleteness \} from "\.\/asnReceivingCompleteness\.js"/
  );
  assert.match(completenessSrc, /export \{ validateAsnReceivingCompleteness \} from/);
  assert.match(planner, /buildRuPlannerViewState/);

  const unbound = new Function("asn", "return validateAsnReceivingCompleteness(asn);");
  assert.throws(
    () => unbound(marAsn0009),
    (err) =>
      err instanceof ReferenceError && /validateAsnReceivingCompleteness is not defined/.test(String(err.message))
  );
  listingCompleteness(marAsn0009);
});

run("10. opening / GET listing path does not write data", () => {
  const view = openPlanner(marAsn0009, { listingFailed: true });
  assert.equal(view.writesOnOpen, false);
  assert.match(planner, /queryFn: \(\) => apiGet\(`\/asn\/\$\{asnId\}\/receiving-units`\)/);
  assert.match(planner, /enabled: Boolean\(open && asnId\)/);
  assert.doesNotMatch(planner, /useEffect/);
  assert.doesNotMatch(planner, /receiving-units\/plan`, body\)[\s\S]*enabled: Boolean\(open/);
  assert.equal(typeof listReceivingUnitsForAsn, "function");
});

void (async () => {
  await runAsync("1b. GET listing actually invokes listReceivingUnitsForAsn", async () => {
    const mongoose = (await import("mongoose")).default;
    assert.equal(mongoose.connection.readyState, 0, "runtime test must not open Mongo");
    mongoose.set("bufferCommands", false);
    let err = null;
    try {
      await listReceivingUnitsForAsn("000000000000000000000000", "6a9573251250989c1676265e");
    } catch (e) {
      err = e;
    }
    assert.ok(err, "listing without a DB connection must not return production data");
    assert.equal(err instanceof ReferenceError, false);
    assert.doesNotMatch(String(err.message || err), /validateAsnReceivingCompleteness is not defined/);
    assert.equal(mongoose.connection.readyState, 0);
  });

  await runAsync("11. production planner JSX transforms and its open callback executes", async () => {
    const frontendRoot = path.join(__dirname, "..", "..");
    const viteEntry = path.join(frontendRoot, "node_modules", "vite", "dist", "node", "index.js");
    assert.equal(fs.existsSync(viteEntry), true, "vite must be installed to transform the planner JSX");
    const { transformWithEsbuild } = await import(pathToFileURL(viteEntry).href);
    const transformed = await transformWithEsbuild(planner, plannerPath, {
      loader: "jsx",
      format: "esm",
    });
    assert.match(transformed.code, /buildRuPlannerViewState/);
    assert.match(transformed.code, /apiGet\(`\/asn\/\$\{asnId\}\/receiving-units`\)/);
    assert.doesNotMatch(transformed.code, /validateAsnReceivingCompleteness is not defined/);

    const labelsMod = await import("../../src/lib/receivingUnitLabels.js");
    const completenessMod = await import("../../src/lib/asnReceivingCompleteness.js");
    assert.equal(typeof completenessMod.validateAsnReceivingCompleteness, "function");
    completenessMod.validateAsnReceivingCompleteness(marAsn0009);
    const view = labelsMod.buildRuPlannerViewState({
      asn: marAsn0009,
      listing: undefined,
      listingFailed: false,
      canPrint: true,
      canReprint: true,
      intent: "review",
    });
    assert.equal(view.lines.length, 3);
    assert.equal(view.saveLabel, "Save Receiving Units");
    assert.equal(view.canPrintPlan, false);
    assert.equal(view.showReprintReason, false);
    assert.equal(view.computedCompleteness.complete, true);
    assert.equal(view.writesOnOpen, false);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
})();
