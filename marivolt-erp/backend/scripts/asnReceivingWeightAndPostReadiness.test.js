/**
 * Receiving Actual Unit Weight vs BOE Customs Declared Weight + post readiness.
 * Run: node scripts/asnReceivingWeightAndPostReadiness.test.js
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeBoeNumber } from "../src/utils/asnCustomsFieldOwnership.js";
import {
  evaluateAsnReceivingPostReadiness,
  resolveReceivingUnitWeightForGrnLine,
} from "../src/utils/asnReceivingPostReadiness.js";
import {
  resolveUnitWeightFromReceivingSources,
  sanitizeAsnReceivingCustomsCapture,
  buildDraftGrnLinesFromReceiving,
  groupReceivingUnitsForDraftGrn,
} from "../src/utils/receivingDraftGrnRules.js";
import {
  assertReceivingActualUnitWeightKg,
  assertUnitCompletable,
  applyReceivingDraftSave,
} from "../src/utils/receivingInspectionRules.js";
import { computeBoeCustomsUnitValue } from "../src/utils/customsBoeAverage.js";
import { assertCustomsBoeDeclarationCompatible } from "../src/services/customsBoeService.js";

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
    console.error(e);
  }
}

console.log("asnReceivingWeightAndPostReadiness.test.js");

run("A. two RUs same weight → weighted result unchanged", () => {
  const r = resolveUnitWeightFromReceivingSources([
    { ruNo: "A", grnAcceptedQty: 5, actualUnitWeightKg: 2.3 },
    { ruNo: "B", grnAcceptedQty: 5, actualUnitWeightKg: 2.3 },
  ]);
  assert.equal(r.ok, true);
  assert.equal(r.unitWeightKg, 2.3);
  assert.equal(r.conflict, false);
});

run("B. 5×2.30 + 5×2.35 → 2.325", () => {
  const r = resolveUnitWeightFromReceivingSources([
    { ruNo: "A", grnAcceptedQty: 5, actualUnitWeightKg: 2.3 },
    { ruNo: "B", grnAcceptedQty: 5, actualUnitWeightKg: 2.35 },
  ]);
  assert.equal(r.ok, true);
  assert.equal(r.unitWeightKg, 2.325);
});

run("C. unequal 2×5.0 + 8×2.0 → 2.6", () => {
  const r = resolveUnitWeightFromReceivingSources([
    { ruNo: "A", grnAcceptedQty: 2, actualUnitWeightKg: 5 },
    { ruNo: "B", grnAcceptedQty: 8, actualUnitWeightKg: 2 },
  ]);
  assert.equal(r.ok, true);
  assert.equal(r.unitWeightKg, 2.6);
});

run("D. one accepted RU missing weight → blocked", () => {
  const r = resolveUnitWeightFromReceivingSources([
    { ruNo: "A", grnAcceptedQty: 5, actualUnitWeightKg: 2.3 },
    { ruNo: "B", grnAcceptedQty: 5, actualUnitWeightKg: null },
  ]);
  assert.equal(r.missing, true);
  assert.equal(r.ok, false);
});

run("E. zero-accepted / excess sources do not distort denominator", () => {
  const r = resolveUnitWeightFromReceivingSources([
    { ruNo: "A", grnAcceptedQty: 5, acceptedQty: 5, actualUnitWeightKg: 2.3 },
    { ruNo: "B", grnAcceptedQty: 0, acceptedQty: 3, actualUnitWeightKg: 9.9 },
  ]);
  assert.equal(r.ok, true);
  assert.equal(r.unitWeightKg, 2.3);
});

run("F. provenance contributions retained on resolve", () => {
  const r = resolveUnitWeightFromReceivingSources([
    { ruNo: "RU-1", receivingUnitId: "u1", grnAcceptedQty: 5, actualUnitWeightKg: 2.3 },
    { ruNo: "RU-2", receivingUnitId: "u2", grnAcceptedQty: 5, actualUnitWeightKg: 2.35 },
  ]);
  assert.equal(r.contributions.length, 2);
  assert.equal(r.contributions[0].actualUnitWeightKg, 2.3);
  assert.equal(r.contributions[1].ruNo, "RU-2");
});

run("G. Draft GRN line gets weighted unitWeight; sources keep RU weights", () => {
  const groups = groupReceivingUnitsForDraftGrn([
    {
      poLineId: "po1",
      asnLineId: "asn1",
      uom: "PCS",
      acceptedQty: 5,
      damagedQty: 0,
      rejectedQty: 0,
      shortQty: 0,
      receivingUnitId: "ru1",
      receivingSessionUnitId: "su1",
      ruNo: "RU-1",
      actualUnitWeightKg: 2.3,
    },
    {
      poLineId: "po1",
      asnLineId: "asn1",
      uom: "PCS",
      acceptedQty: 5,
      damagedQty: 0,
      rejectedQty: 0,
      shortQty: 0,
      receivingUnitId: "ru2",
      receivingSessionUnitId: "su2",
      ruNo: "RU-2",
      actualUnitWeightKg: 2.35,
    },
  ]);
  const poLine = {
    _id: "po1",
    orderedQty: 20,
    itemCode: "700011",
    uom: "PCS",
    unitPrice: 1,
  };
  const built = buildDraftGrnLinesFromReceiving({
    groups,
    poLineByAsnLineId: new Map([["asn1", poLine]]),
    poLineIdByAsnLineId: new Map([["asn1", "po1"]]),
    poIdByAsnLineId: new Map([["asn1", "POID"]]),
  });
  assert.equal(built.items.length, 1);
  assert.equal(built.items[0].customsCapture.unitWeightKg, 2.325);
  assert.equal(built.items[0].acceptedQty, 10);
  const srcW = built.items[0].receivingSources.map((s) => s.actualUnitWeightKg).sort();
  assert.deepEqual(srcW, [2.3, 2.35]);
});

run("H. different RU weights do NOT affect BOE customsUnitValue", () => {
  const unit = computeBoeCustomsUnitValue(10000, 100).customsUnitValue;
  assert.equal(unit, 100);
  const w = resolveUnitWeightFromReceivingSources([
    { ruNo: "A", grnAcceptedQty: 5, actualUnitWeightKg: 2.3 },
    { ruNo: "B", grnAcceptedQty: 5, actualUnitWeightKg: 2.35 },
  ]).unitWeightKg;
  assert.equal(w, 2.325);
  assert.equal(computeBoeCustomsUnitValue(10000, 100).customsUnitValue, 100);
});

run("I. different RU weights do NOT change accepted quantity", () => {
  const groups = groupReceivingUnitsForDraftGrn([
    {
      poLineId: "po1",
      asnLineId: "asn1",
      uom: "PCS",
      acceptedQty: 2,
      damagedQty: 0,
      rejectedQty: 0,
      shortQty: 0,
      receivingUnitId: "ru1",
      receivingSessionUnitId: "su1",
      ruNo: "RU-1",
      actualUnitWeightKg: 5,
    },
    {
      poLineId: "po1",
      asnLineId: "asn1",
      uom: "PCS",
      acceptedQty: 8,
      damagedQty: 0,
      rejectedQty: 0,
      shortQty: 0,
      receivingUnitId: "ru2",
      receivingSessionUnitId: "su2",
      ruNo: "RU-2",
      actualUnitWeightKg: 2,
    },
  ]);
  const poLine = { _id: "po1", orderedQty: 20, itemCode: "X", uom: "PCS", unitPrice: 1 };
  const built = buildDraftGrnLinesFromReceiving({
    groups,
    poLineByAsnLineId: new Map([["asn1", poLine]]),
    poLineIdByAsnLineId: new Map([["asn1", "po1"]]),
    poIdByAsnLineId: new Map([["asn1", "POID"]]),
  });
  assert.equal(built.items[0].acceptedQty, 10);
  assert.equal(built.items[0].customsCapture.unitWeightKg, 2.6);
});

run("J. client cannot override receiving-derived unit weight", () => {
  const out = sanitizeAsnReceivingCustomsCapture(
    { unitWeightKg: 99, boeNumber: "83535" },
    { unitWeightKg: 2.325, totalWeightKg: 23.25 },
  );
  assert.equal(out.unitWeightKg, 2.325);
});

run("K. Gross/Net BOTH mandatory with net≤gross blockers", () => {
  const readiness = fs.readFileSync(path.join(srcRoot, "utils/asnReceivingPostReadiness.js"), "utf8");
  assert.match(readiness, /BOE_GROSS_WEIGHT_REQUIRED/);
  assert.match(readiness, /BOE_NET_WEIGHT_REQUIRED/);
  assert.match(readiness, /BOE_NET_WEIGHT_EXCEEDS_GROSS/);
  const model = fs.readFileSync(path.join(srcRoot, "utils/customsGrnFieldModel.js"), "utf8");
  assert.match(model, /requireDeclaredWeights:\s*forceAcceptedQtyOnly/);
});

run("L. readiness blocks missing RU weight, not different weights", () => {
  const line = {
    article: "A",
    acceptedQty: 10,
    location: "A-01",
    receivingSources: [
      { ruNo: "1", grnAcceptedQty: 5, receivingSessionUnitId: "U1" },
      { ruNo: "2", grnAcceptedQty: 5, receivingSessionUnitId: "U2" },
    ],
    customsCapture: {},
  };
  const ok = resolveReceivingUnitWeightForGrnLine(
    line,
    new Map([
      ["U1", { actualUnitWeightKg: 2.3 }],
      ["U2", { actualUnitWeightKg: 2.35 }],
    ]),
  );
  assert.equal(ok.ok, true);
  assert.equal(ok.unitWeightKg, 2.325);
  const missing = resolveReceivingUnitWeightForGrnLine(
    line,
    new Map([
      ["U1", { actualUnitWeightKg: 2.3 }],
      ["U2", { actualUnitWeightKg: null }],
    ]),
  );
  assert.equal(missing.missing, true);
});

run("M. CREATE readiness requires Gross+Net and rejects net>gross", () => {
  const putawayLocations = [
    { locationCode: "A-01", warehouse: "MAIN", rack: "A", bin: "01", status: "Active" },
  ];
  const baseItem = {
    article: "700011",
    acceptedQty: 5,
    location: "A-01",
    warehouse: "MAIN",
    asnLineId: "L1",
    receivingSources: [
      { ruNo: "RU1", grnAcceptedQty: 5, receivingSessionUnitId: "U1", actualUnitWeightKg: 2.35 },
    ],
  };
  const asn = {
    supplierInvoices: [{ invoiceNumber: "SI-1", invoiceDate: new Date("2026-01-01") }],
    lines: [{ _id: "L1", hsCode: "8409", countryOfOrigin: "DE", article: "700011" }],
  };
  const session = { status: "COMPLETED" };
  const sessionUnits = [{ _id: "U1", actualUnitWeightKg: 2.35 }];

  const missing = evaluateAsnReceivingPostReadiness({
    grn: {
      status: "DRAFT",
      sourceType: "ASN_RECEIVING",
      items: [
        {
          ...baseItem,
          customsCapture: {
            boeNumber: "83535",
            boeDate: "2026-01-10",
            boeDeclaredQty: 100,
            boeDeclaredValue: 10000,
            customsCurrency: "EUR",
            exchangeRateToAED: 4.25,
            customsUom: "PCS",
            unitWeightKg: 2.35,
            receivedDate: "2026-01-15",
          },
        },
      ],
    },
    asn,
    session,
    sessionUnits,
    stockLocations: putawayLocations,
  });
  assert.equal(missing.postReady, false);
  assert.ok(missing.blockers.some((b) => b.code === "BOE_GROSS_WEIGHT_REQUIRED"));
  assert.ok(missing.blockers.some((b) => b.code === "BOE_NET_WEIGHT_REQUIRED"));

  const exceeds = evaluateAsnReceivingPostReadiness({
    grn: {
      status: "DRAFT",
      sourceType: "ASN_RECEIVING",
      items: [
        {
          ...baseItem,
          customsCapture: {
            boeNumber: "83535",
            boeDate: "2026-01-10",
            boeDeclaredQty: 100,
            boeDeclaredValue: 10000,
            customsCurrency: "EUR",
            exchangeRateToAED: 4.25,
            customsUom: "PCS",
            unitWeightKg: 2.35,
            receivedDate: "2026-01-15",
            grossWeightKg: 100,
            netWeightKg: 120,
          },
        },
      ],
    },
    asn,
    session,
    sessionUnits,
    stockLocations: putawayLocations,
  });
  assert.equal(exceeds.postReady, false);
  assert.ok(exceeds.blockers.some((b) => b.code === "BOE_NET_WEIGHT_EXCEEDS_GROSS"));

  const ok = evaluateAsnReceivingPostReadiness({
    grn: {
      status: "DRAFT",
      sourceType: "ASN_RECEIVING",
      items: [
        {
          ...baseItem,
          customsCapture: {
            boeNumber: "83535",
            boeDate: "2026-01-10",
            boeDeclaredQty: 100,
            boeDeclaredValue: 10000,
            customsCurrency: "EUR",
            exchangeRateToAED: 4.25,
            customsUom: "PCS",
            unitWeightKg: 2.35,
            receivedDate: "2026-01-15",
            grossWeightKg: 250,
            netWeightKg: 225,
          },
        },
      ],
    },
    asn,
    session,
    sessionUnits,
    stockLocations: putawayLocations,
  });
  assert.equal(ok.postReady, true, JSON.stringify(ok.blockers));
});

run("N. CustomsBoe still persists gross/net; lock on reuse", () => {
  const model = fs.readFileSync(path.join(srcRoot, "models", "CustomsBoe.js"), "utf8");
  assert.match(model, /grossWeightKg/);
  assert.match(model, /netWeightKg/);
  const parent = {
    customsBoeRef: "MAR-BOE-1",
    boeDeclaredQty: 100,
    boeDeclaredValue: 10000,
    customsUnitValue: 100,
    customsCurrency: "EUR",
    exchangeRateToAED: 4.25,
    customsUom: "PCS",
    grossWeightKg: 250,
    netWeightKg: 225,
  };
  assert.equal(assertCustomsBoeDeclarationCompatible(parent, { grossWeightKg: 999 }).ok, false);
  assert.equal(assertCustomsBoeDeclarationCompatible(parent, { netWeightKg: 999 }).ok, false);
});

run("O. receiving Actual Unit Weight still required when accepted > 0", () => {
  assert.throws(
    () =>
      assertUnitCompletable({
        actualQty: 5,
        condition: "GOOD",
        photoCount: 1,
        qtyConfirmed: true,
        plannedQty: 5,
        acceptedQty: 5,
        damagedQty: 0,
        rejectedQty: 0,
        photos: [{ category: "OVERALL" }],
      }),
    (e) => e.code === "RECEIVING_UNIT_WEIGHT_REQUIRED",
  );
  applyReceivingDraftSave(
    { status: "IN_PROGRESS", version: 1, actualQty: 5 },
    { actualUnitWeightKg: 2.35, expectedVersion: 1 },
  );
  assertReceivingActualUnitWeightKg(2.35, { required: true });
});

run("P. frontend marks Gross/Net required on ASN CREATE; concepts separated", () => {
  const sec = fs.readFileSync(path.join(feRoot, "components/store/GrnCustomsSection.jsx"), "utf8");
  assert.match(sec, /Customs Declared Gross Weight/);
  assert.match(sec, /required=\{isAsnReceiving && !isSelect\}/);
  assert.match(sec, /not article Actual Unit Weight/);
  const inspect = fs.readFileSync(path.join(feRoot, "components/store/ReceivingUnitInspectScreen.jsx"), "utf8");
  assert.match(inspect, /Actual Unit Weight/);
});

run("Q. normalize BOE unchanged", () => {
  assert.equal(normalizeBoeNumber(" 83535 "), "83535");
});

run("R. SELECT/reuse loads parent Gross/Net into readiness (not client invent)", () => {
  const putawayLocations = [
    { locationCode: "A-01", warehouse: "MAIN", rack: "A", bin: "01", status: "Active" },
  ];
  const grn = {
    status: "DRAFT",
    sourceType: "ASN_RECEIVING",
    items: [
      {
        article: "700011",
        acceptedQty: 5,
        location: "A-01",
        warehouse: "MAIN",
        asnLineId: "L1",
        customsCapture: {
          customsBoeId: "BOEID",
          customsBoeRef: "MAR-BOE-1",
          boeNumber: "83535",
          boeDate: "2026-01-10",
          unitWeightKg: 2.35,
          receivedDate: "2026-01-15",
        },
        receivingSources: [
          { ruNo: "RU1", grnAcceptedQty: 5, receivingSessionUnitId: "U1", actualUnitWeightKg: 2.35 },
        ],
      },
    ],
  };
  const asn = {
    supplierInvoices: [{ invoiceNumber: "SI-1", invoiceDate: new Date("2026-01-01") }],
    lines: [{ _id: "L1", hsCode: "8409", countryOfOrigin: "DE", article: "700011" }],
  };
  const parentBoe = {
    _id: "BOEID",
    status: "OPEN",
    boeNumber: "83535",
    boeDate: "2026-01-10",
    boeDeclaredQty: 100,
    boeDeclaredValue: 10000,
    customsUnitValue: 100,
    customsCurrency: "EUR",
    exchangeRateToAED: 4.25,
    customsUom: "PCS",
    grossWeightKg: 250,
    netWeightKg: 225,
    linkedCustomsQty: 0,
  };
  const r = evaluateAsnReceivingPostReadiness({
    grn,
    asn,
    session: { status: "COMPLETED" },
    parentBoe,
    sessionUnits: [{ _id: "U1", actualUnitWeightKg: 2.35 }],
    stockLocations: putawayLocations,
  });
  assert.equal(r.postReady, true, JSON.stringify(r.blockers));
  assert.equal(r.summary.declaredGrossWeightKg, 250);
  assert.equal(r.summary.declaredNetWeightKg, 225);
});

console.log(`\nasnReceivingWeightAndPostReadiness: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
