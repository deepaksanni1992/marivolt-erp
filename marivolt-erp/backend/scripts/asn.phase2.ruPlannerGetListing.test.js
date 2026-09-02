/**
 * GET /asn/:id/receiving-units integration regression.
 * Calls the real controller + listReceivingUnitsForAsn against stubbed reads.
 * Never opens Mongo. Never writes.
 *
 * Run: node scripts/asn.phase2.ruPlannerGetListing.test.js
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import mongoose from "mongoose";
import AdvanceShipmentNotice from "../src/models/AdvanceShipmentNotice.js";
import ReceivingUnit from "../src/models/ReceivingUnit.js";
import GRN from "../src/models/GRN.js";
import ReceivingSession from "../src/models/ReceivingSession.js";
import ReceivingSessionUnit from "../src/models/ReceivingSessionUnit.js";
import ReceivingUnitPhoto from "../src/models/ReceivingUnitPhoto.js";
import { listReceivingUnitsForAsn } from "../src/services/receivingUnitService.js";
import { listForAsn } from "../src/controllers/receivingUnitController.js";
import { hasPermission } from "../src/services/roleService.js";
import { requirePermission } from "../src/middleware/permissions.js";
import {
  buildRuPlannerViewState,
  extractReceivingUnitsListing,
  isReceivingUnitsListingAuthoritative,
  RU_PLAN_LISTING_LOAD_ERROR,
} from "../../src/lib/receivingUnitLabels.js";
import { REPRINT_REASONS } from "../../src/lib/labelPrinting.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serviceSrc = fs.readFileSync(path.join(__dirname, "..", "src", "services", "receivingUnitService.js"), "utf8");
const controllerSrc = fs.readFileSync(path.join(__dirname, "..", "src", "controllers", "receivingUnitController.js"), "utf8");
const routesSrc = fs.readFileSync(path.join(__dirname, "..", "src", "routes", "asnRoutes.js"), "utf8");
const plannerSrc = fs.readFileSync(
  path.join(__dirname, "..", "..", "src", "components", "store", "AsnReceivingLabelPlanner.jsx"),
  "utf8"
);

const MAR = "aaaaaaaaaaaaaaaaaaaaaaaa";
const OKE = "bbbbbbbbbbbbbbbbbbbbbbbb";
const ASN_ID = "6a9573251250989c1676265e";
const LINE_IDS = ["6a9573251250989c1676265f", "6a9573251250989c16762660", "6a9573251250989c16762661"];
const ARTICLES = ["911268022", "911438822", "911313222"];
const QTYS = [4, 1, 2];

let passed = 0;
let failed = 0;
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

function sameId(a, b) {
  return String(a || "") === String(b || "");
}

function leanQuery(value) {
  return {
    select() {
      return this;
    },
    sort() {
      return this;
    },
    lean() {
      return Promise.resolve(value);
    },
    then(resolve, reject) {
      return Promise.resolve(value).then(resolve, reject);
    },
  };
}

function untouchedLines() {
  return LINE_IDS.map((id, i) => ({
    _id: id,
    article: ARTICLES[i],
    partNumber: "",
    description: `Line ${ARTICLES[i]}`,
    asnQty: QTYS[i],
    uom: "PCS",
    hsCode: "840999",
    countryOfOrigin: "SG",
    remainingAvailableQty: 0,
    ruPlanVersion: 0,
    ruActivePlanBatchId: null,
  }));
}

function untouchedAsn() {
  return {
    _id: ASN_ID,
    companyId: MAR,
    asnNo: "MAR-ASN-0009",
    status: "ARRIVED",
    sourcePoId: "cccccccccccccccccccccccc",
    supplierInvoices: [{ invoiceNumber: "SI-0009", invoiceDate: new Date("2026-08-01") }],
    lines: untouchedLines(),
  };
}

function establishedAsn() {
  return {
    ...untouchedAsn(),
    lines: untouchedLines().map((line, i) => ({
      ...line,
      ruPlanVersion: 1,
      ruActivePlanBatchId: `ddddddddddddddddddddddd${i}`,
    })),
  };
}

function establishedRus() {
  return LINE_IDS.map((lineId, i) => ({
    _id: `eeeeeeeeeeeeeeeeeeeeeee${i}`,
    companyId: MAR,
    ruNo: `MAR-RU-00000${i + 1}`,
    barcodeValue: `MAR-RU-00000${i + 1}`,
    asnId: ASN_ID,
    asnNo: "MAR-ASN-0009",
    asnLineId: lineId,
    article: ARTICLES[i],
    plannedQty: QTYS[i],
    uom: "PCS",
    status: "PLANNED",
    planBatchId: `ddddddddddddddddddddddd${i}`,
    createdBy: "op",
    createdAt: new Date("2026-08-31T15:42:50.000Z"),
    updatedAt: new Date("2026-08-31T15:42:50.000Z"),
  }));
}

function mockRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(data) {
      this.body = data;
      return this;
    },
  };
}

const writes = [];
const WRITE_NAMES = [
  "create",
  "insertMany",
  "updateOne",
  "updateMany",
  "deleteOne",
  "deleteMany",
  "findOneAndUpdate",
  "findOneAndDelete",
  "findOneAndReplace",
  "replaceOne",
  "bulkWrite",
];

let currentAsn = untouchedAsn();
let currentRus = [];
const originals = [];

function stubMethod(model, name, impl) {
  originals.push([model, name, model[name]]);
  model[name] = impl;
}

function denyWrite(model, name) {
  if (typeof model[name] !== "function") return;
  stubMethod(model, name, function deniedWrite() {
    writes.push(`${model.modelName}.${name}`);
    throw new Error(`${model.modelName}.${name} is not allowed in GET listing test`);
  });
}

function installStubs() {
  stubMethod(AdvanceShipmentNotice, "findOne", function findOne(filter = {}) {
    if (sameId(filter._id, ASN_ID) && sameId(filter.companyId, MAR)) return leanQuery(currentAsn);
    return leanQuery(null);
  });
  stubMethod(ReceivingUnit, "find", function find(filter = {}) {
    if (filter.companyId != null && !sameId(filter.companyId, MAR)) return leanQuery([]);
    if (filter.asnId != null && !sameId(filter.asnId, ASN_ID)) return leanQuery([]);
    return leanQuery(currentRus);
  });
  stubMethod(GRN, "findOne", function findOne() {
    return leanQuery(null);
  });
  stubMethod(ReceivingSession, "findOne", function findOne() {
    return leanQuery(null);
  });
  stubMethod(ReceivingSessionUnit, "countDocuments", async function countDocuments() {
    return 0;
  });
  stubMethod(ReceivingUnitPhoto, "countDocuments", async function countDocuments() {
    return 0;
  });
  for (const model of [
    AdvanceShipmentNotice,
    ReceivingUnit,
    GRN,
    ReceivingSession,
    ReceivingSessionUnit,
    ReceivingUnitPhoto,
  ]) {
    for (const name of WRITE_NAMES) denyWrite(model, name);
  }
}

function restoreStubs() {
  for (const [model, name, orig] of originals.splice(0)) {
    model[name] = orig;
  }
}

function asHttpJson(value) {
  return JSON.parse(JSON.stringify(value));
}

async function getListing(companyId = MAR, asnId = ASN_ID) {
  const req = { companyId, params: { id: asnId }, user: { role: "store_operator" } };
  const res = mockRes();
  await listForAsn(req, res);
  return res;
}

console.log("\nASN RU planner GET listing integration\n");

void (async () => {
assert.equal(mongoose.connection.readyState, 0, "test must not open Mongo");
mongoose.set("bufferCommands", false);
installStubs();

await runAsync("1. untouched ARRIVED ASN GET is HTTP 200, eligible, three lines, zero writes", async () => {
  currentAsn = untouchedAsn();
  currentRus = [];
  writes.length = 0;
  const res = await getListing();
  assert.equal(res.statusCode, 200);
  const body = asHttpJson(res.body);
  assert.equal(body.eligible, true);
  assert.equal(body.status, "ARRIVED");
  assert.equal(body.asnNo, "MAR-ASN-0009");
  assert.equal(Array.isArray(body.lines), true);
  assert.equal(body.lines.length, 3);
  assert.deepEqual(
    body.lines.map((ln) => String(ln.asnLineId)),
    LINE_IDS
  );
  assert.deepEqual(
    body.lines.map((ln) => ln.article),
    ARTICLES
  );
  assert.deepEqual(
    body.lines.map((ln) => ln.asnQty),
    QTYS
  );
  assert.ok(body.lines.every((ln) => ln.uom === "PCS"));
  assert.ok(body.lines.every((ln) => (Number(ln.ruPlanVersion) || 0) === 0));
  assert.equal(body.receivingCompleteness.complete, true);
  assert.equal(body.receivingUnits.length, 0);
  assert.equal(writes.length, 0);
  assert.equal(mongoose.connection.readyState, 0);
});

await runAsync("2. service listing matches controller JSON contract", async () => {
  currentAsn = untouchedAsn();
  currentRus = [];
  const fromService = asHttpJson(await listReceivingUnitsForAsn(MAR, ASN_ID));
  const res = await getListing();
  const fromController = asHttpJson(res.body);
  assert.deepEqual(fromController.lines.map((ln) => ln.asnLineId), fromService.lines.map((ln) => ln.asnLineId));
  assert.equal(fromController.eligible, fromService.eligible);
  assert.equal(fromController.status, fromService.status);
  assert.ok(!("data" in fromController));
  assert.ok(!("listing" in fromController));
});

await runAsync("3. STORE_OPERATOR with ASN.view is allowed; GET route is view-only", async () => {
  const req = { user: { role: "store_operator" } };
  assert.equal(await hasPermission(req, "ASN", "view"), true);
  assert.equal(await hasPermission(req, "ASN", "edit"), false);
  let nextCalled = false;
  const res = mockRes();
  await requirePermission("ASN", "view")(req, res, () => {
    nextCalled = true;
  });
  assert.equal(nextCalled, true);
  assert.match(routesSrc, /router\.get\("\/:id\/receiving-units", asnView, ru\.listForAsn\)/);
  assert.match(controllerSrc, /listReceivingUnitsForAsn\(req\.companyId, req\.params\.id\)/);
});

await runAsync("4. wrong-company access is rejected", async () => {
  currentAsn = untouchedAsn();
  currentRus = [];
  const res = await getListing(OKE, ASN_ID);
  assert.equal(res.statusCode, 404);
  assert.equal(res.body.code, "RU_ASN_NOT_FOUND");
  assert.equal(res.body.lines, undefined);
  let threw = null;
  try {
    await listReceivingUnitsForAsn(OKE, ASN_ID);
  } catch (err) {
    threw = err;
  }
  assert.equal(threw?.code, "RU_ASN_NOT_FOUND");
  assert.equal(threw?.status || threw?.statusCode, 404);
});

await runAsync("5. established-plan listing remains authoritative", async () => {
  currentAsn = establishedAsn();
  currentRus = establishedRus();
  writes.length = 0;
  const res = await getListing();
  assert.equal(res.statusCode, 200);
  const body = asHttpJson(res.body);
  assert.equal(isReceivingUnitsListingAuthoritative(body), true);
  assert.equal(body.lines.length, 3);
  assert.ok(body.lines.every((ln) => Number(ln.ruPlanVersion) === 1));
  assert.ok(body.lines.every((ln) => Number(ln.activeRuCount) === 1));
  assert.equal(body.receivingUnits.length, 3);
  const staleDetail = {
    ...untouchedAsn(),
    receivingCompleteness: { complete: true, missing: [], summary: "ASN is complete for receiving." },
    lines: untouchedLines().map((ln) => ({ ...ln, asnQty: 99 })),
  };
  const view = buildRuPlannerViewState({
    asn: staleDetail,
    listing: body,
    listingFailed: false,
    canPrint: true,
    canReprint: true,
    intent: "review",
  });
  assert.equal(view.listingBlocked, false);
  assert.equal(view.lines.length, 3);
  assert.deepEqual(
    view.lines.map((ln) => ln.asnQty),
    QTYS
  );
  assert.ok(view.lines.every((ln) => (ln.receivingUnits || []).length === 1));
  assert.equal(view.showReprintReason, false);
  assert.equal(writes.length, 0);
});

await runAsync("6. frontend consumes the production wrapper; first-prep Save/Print/Damaged Label", async () => {
  currentAsn = untouchedAsn();
  currentRus = [];
  const res = await getListing();
  const body = asHttpJson(res.body);
  const extracted = extractReceivingUnitsListing(body);
  assert.equal(extracted.eligible, true);
  assert.equal(extracted.lines.length, 3);
  const nested = extractReceivingUnitsListing({ data: body });
  assert.equal(nested.lines.length, 3);
  const detail = {
    ...untouchedAsn(),
    receivingCompleteness: body.receivingCompleteness,
  };
  const view = buildRuPlannerViewState({
    asn: detail,
    listing: extracted,
    listingFailed: false,
    canPrint: true,
    canReprint: true,
    intent: "review",
  });
  assert.equal(view.eligible, true);
  assert.equal(view.listingBlocked, false);
  assert.equal(view.listingLoadError, "");
  assert.equal(view.lines.length, 3);
  assert.deepEqual(
    view.lines.map((ln) => String(ln.asnLineId)),
    LINE_IDS
  );
  assert.equal(view.saveLabel, "Save Receiving Units");
  assert.equal(view.canSavePlan, true);
  assert.equal(view.canPrintPlan, false);
  assert.equal(view.showReprintReason, false);
  assert.equal(view.reprintMode, false);
  assert.equal(REPRINT_REASONS[0], "Damaged Label");
  assert.match(plannerSrc, /\{saveLabel\}/);
  assert.doesNotMatch(plannerSrc, /useState\(REPRINT_REASONS\[0\]\)/);
});

await runAsync("7. GET remains read-only and does not throw ReferenceError", async () => {
  currentAsn = untouchedAsn();
  currentRus = [];
  writes.length = 0;
  const res = await getListing();
  assert.equal(res.statusCode, 200);
  assert.equal(writes.length, 0);
  assert.doesNotMatch(String(res.body?.message || ""), /validateAsnReceivingCompleteness is not defined/);
  assert.match(
    serviceSrc,
    /import \{ assertAsnReceivingComplete, validateAsnReceivingCompleteness \} from "\.\.\/utils\/asnReceivingCompleteness\.js"/
  );
  assert.match(serviceSrc, /const receivingCompleteness = validateAsnReceivingCompleteness\(asn\)/);
  assert.equal(mongoose.connection.readyState, 0);
});

await runAsync("8. established plan + failed listing still blocks unsafe fallback", async () => {
  const establishedDetail = {
    ...establishedAsn(),
    receivingCompleteness: { complete: true, missing: [], summary: "ASN is complete for receiving." },
  };
  const view = buildRuPlannerViewState({
    asn: establishedDetail,
    listing: undefined,
    listingFailed: true,
    canPrint: true,
    canReprint: true,
    intent: "review",
  });
  assert.equal(view.listingBlocked, true);
  assert.equal(view.listingLoadError, RU_PLAN_LISTING_LOAD_ERROR);
  assert.equal(view.lines.length, 0);
  assert.equal(view.canSavePlan, false);
  assert.equal(view.canPrintPlan, false);
});

restoreStubs();
assert.equal(mongoose.connection.readyState, 0);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
})();
