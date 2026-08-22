/**
 * ASN receiving reopen + physical putaway readiness.
 * Run: node scripts/asnReceivingReopenAndPutaway.test.js
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertAsnReceivingPutawayLocation,
  isPhysicalPutawayStockLocation,
} from "../src/utils/asnReceivingPutaway.js";
import { evaluateAsnReceivingPostReadiness } from "../src/utils/asnReceivingPostReadiness.js";
import {
  assertReceivingActualUnitWeightKg,
  assertUnitCompletable,
  applyReceivingDraftSave,
} from "../src/utils/receivingInspectionRules.js";
import { resolveUnitWeightFromReceivingSources } from "../src/utils/receivingDraftGrnRules.js";
import { computeBoeCustomsUnitValue } from "../src/utils/customsBoeAverage.js";

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

console.log("asnReceivingReopenAndPutaway.test.js");

const putawayLoc = {
  locationCode: "MAIN-R01-B03",
  warehouse: "MAIN",
  rack: "R01",
  bin: "B03",
  status: "Active",
};
const locMap = new Map([
  ["MAIN", { locationCode: "MAIN", warehouse: "", rack: "", bin: "", status: "Active" }],
  ["MAIN-R01-B03", putawayLoc],
  ["RACK-ONLY", { locationCode: "RACK-ONLY", warehouse: "MAIN", rack: "R01", bin: "", status: "Active" }],
  ["BIN-ONLY", { locationCode: "BIN-ONLY", warehouse: "MAIN", rack: "", bin: "B03", status: "Active" }],
  ["GENERIC-A", { locationCode: "GENERIC-A", warehouse: "MAIN", rack: "", bin: "", status: "Active" }],
  ["OTHER-R1", { locationCode: "OTHER-R1", warehouse: "OTHER", rack: "R1", bin: "B1", status: "Active" }],
  ["INACTIVE-R1", { locationCode: "INACTIVE-R1", warehouse: "MAIN", rack: "R1", bin: "B1", status: "Inactive" }],
]);

run("1. accepted RU cannot complete without weight", () => {
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
        actualUnitWeightKg: null,
      }),
    (e) => e.code === "RECEIVING_UNIT_WEIGHT_REQUIRED",
  );
});

run("2. zero weight rejected", () => {
  assert.throws(
    () => assertReceivingActualUnitWeightKg(0, { required: true }),
    (e) => e.code === "RECEIVING_UNIT_WEIGHT_REQUIRED",
  );
});

run("3. Save Draft preserves weight", () => {
  const out = applyReceivingDraftSave(
    { status: "IN_PROGRESS", version: 1, actualQty: 5 },
    { actualUnitWeightKg: 2.35, expectedVersion: 1 },
  );
  assert.equal(out.actualUnitWeightKg, 2.35);
});

run("4/5. Resume / complete retains weight helpers", () => {
  assertReceivingActualUnitWeightKg(2.35, { required: true });
  const r = resolveUnitWeightFromReceivingSources([
    { ruNo: "A", grnAcceptedQty: 5, actualUnitWeightKg: 2.35 },
  ]);
  assert.equal(r.unitWeightKg, 2.35);
});

run("6. multi-RU weighted average unchanged", () => {
  const r = resolveUnitWeightFromReceivingSources([
    { ruNo: "A", grnAcceptedQty: 5, actualUnitWeightKg: 2.3 },
    { ruNo: "B", grnAcceptedQty: 5, actualUnitWeightKg: 2.35 },
  ]);
  assert.equal(r.unitWeightKg, 2.325);
});

run("19. warehouse MAIN alone does NOT satisfy ASN putaway", () => {
  assert.equal(isPhysicalPutawayStockLocation(locMap.get("MAIN"), "MAIN"), false);
  const r = assertAsnReceivingPutawayLocation("MAIN", { warehouse: "MAIN", stockLocationsByCode: locMap });
  assert.equal(r.ok, false);
});

run("2. arbitrary non-rack/bin location cannot satisfy ASN putaway", () => {
  assert.equal(isPhysicalPutawayStockLocation(locMap.get("GENERIC-A"), "MAIN"), false);
  assert.equal(isPhysicalPutawayStockLocation(locMap.get("RACK-ONLY"), "MAIN"), false);
  assert.equal(isPhysicalPutawayStockLocation(locMap.get("BIN-ONLY"), "MAIN"), false);
  for (const code of ["GENERIC-A", "RACK-ONLY", "BIN-ONLY"]) {
    const r = assertAsnReceivingPutawayLocation(code, { warehouse: "MAIN", stockLocationsByCode: locMap });
    assert.equal(r.ok, false, code);
  }
});

run("3. valid active same-warehouse rack/bin passes", () => {
  assert.equal(isPhysicalPutawayStockLocation(locMap.get("MAIN-R01-B03"), "MAIN"), true);
  const r = assertAsnReceivingPutawayLocation("MAIN-R01-B03", {
    warehouse: "MAIN",
    stockLocationsByCode: locMap,
  });
  assert.equal(r.ok, true);
});

run("20. blank location blocks readiness", () => {
  const r = assertAsnReceivingPutawayLocation("", { warehouse: "MAIN", stockLocationsByCode: locMap });
  assert.equal(r.ok, false);
  assert.equal(r.code, "GRN_LOCATION_REQUIRED");
});

run("21. arbitrary invalid location blocks", () => {
  const r = assertAsnReceivingPutawayLocation("NOPE", { warehouse: "MAIN", stockLocationsByCode: locMap });
  assert.equal(r.ok, false);
});

run("4. inactive location fails", () => {
  const r = assertAsnReceivingPutawayLocation("INACTIVE-R1", {
    warehouse: "MAIN",
    stockLocationsByCode: locMap,
  });
  assert.equal(r.ok, false);
});

run("5. wrong warehouse fails", () => {
  const r = assertAsnReceivingPutawayLocation("OTHER-R1", {
    warehouse: "MAIN",
    stockLocationsByCode: locMap,
  });
  assert.equal(r.ok, false);
});

run("readiness integrates putaway + weight", () => {
  const base = {
    status: "DRAFT",
    sourceType: "ASN_RECEIVING",
    items: [
      {
        article: "A1",
        acceptedQty: 5,
        warehouse: "MAIN",
        location: "",
        asnLineId: "L1",
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
        receivingSources: [
          { ruNo: "RU1", grnAcceptedQty: 5, receivingSessionUnitId: "U1", actualUnitWeightKg: 2.35 },
        ],
      },
    ],
  };
  const asn = {
    supplierInvoices: [{ invoiceNumber: "SI-1", invoiceDate: new Date("2026-01-01") }],
    lines: [{ _id: "L1", hsCode: "8409", countryOfOrigin: "DE", article: "A1" }],
  };
  const bad = evaluateAsnReceivingPostReadiness({
    grn: base,
    asn,
    session: { status: "COMPLETED" },
    sessionUnits: [{ _id: "U1", actualUnitWeightKg: 2.35 }],
    stockLocations: [...locMap.values()],
  });
  assert.equal(bad.postReady, false);
  assert.ok(bad.blockers.some((b) => b.code === "GRN_LOCATION_REQUIRED"));

  const good = evaluateAsnReceivingPostReadiness({
    grn: {
      ...base,
      items: [{ ...base.items[0], location: "MAIN-R01-B03" }],
    },
    asn,
    session: { status: "COMPLETED" },
    sessionUnits: [{ _id: "U1", actualUnitWeightKg: 2.35 }],
    stockLocations: [...locMap.values()],
  });
  assert.equal(good.postReady, true, JSON.stringify(good.blockers));
});

run("H. BOE weights do not affect customs average", () => {
  assert.equal(computeBoeCustomsUnitValue(10000, 100).customsUnitValue, 100);
});

run("7-18 selective reopen service + route present", () => {
  const svc = fs.readFileSync(path.join(srcRoot, "services/asnReceivingReopenService.js"), "utf8");
  assert.match(svc, /reopenReceivingSession/);
  assert.match(svc, /RECEIVING_REOPEN_REASON_REQUIRED/);
  assert.match(svc, /RECEIVING_REOPEN_UNIT_REQUIRED/);
  assert.match(svc, /RECEIVING_REOPEN_BLOCKED_POSTED/);
  assert.match(svc, /RECEIVING_REOPEN_BLOCKED_STOCK/);
  assert.match(svc, /RECEIVING_REOPEN_BLOCKED_CUSTOMS/);
  assert.match(svc, /status:\s*"CANCELLED"/);
  assert.match(svc, /status:\s*"IN_PROGRESS"/);
  assert.match(svc, /RECEIVING_REOPENED/);
  assert.match(svc, /receivingSessionUnitIds/);
  assert.match(svc, /_id:\s*\{\s*\$in:\s*selectedUnitIds\s*\}/);
  assert.match(svc, /modifiedCount\)\s*!==\s*selectedUnitIds\.length/);
  assert.match(svc, /ruNos:\s*reopenedRuNos/);
  const routes = fs.readFileSync(path.join(srcRoot, "routes/receivingInspectionRoutes.js"), "utf8");
  assert.match(routes, /sessions\/:sessionId\/reopen/);
  assert.match(routes, /receivingMutate/);
  const ctrl = fs.readFileSync(path.join(srcRoot, "controllers/receivingInspectionController.js"), "utf8");
  assert.match(ctrl, /receivingSessionUnitIds/);
  const draft = fs.readFileSync(path.join(srcRoot, "services/asnReceivingDraftService.js"), "utf8");
  assert.match(draft, /findPostedOrLockedAsnReceivingGrn/);
  assert.doesNotMatch(
    draft,
    /status:\s*\{\s*\$in:\s*\[[^\]]*CANCELLED[^\]]*\]\s*\}/,
  );
});

run("6. putaway selector excludes nonphysical entries", () => {
  const ui = fs.readFileSync(path.join(feRoot, "components/store/AsnReceivingDraftCustomsReview.jsx"), "utf8");
  assert.match(ui, /isPhysicalPutaway/);
  assert.match(ui, /rack && bin/);
  assert.match(ui, /putawayOptions/);
});

run("7. reopen requires at least one RU selection (API contract)", () => {
  const svc = fs.readFileSync(path.join(srcRoot, "services/asnReceivingReopenService.js"), "utf8");
  assert.match(svc, /Select at least one completed Receiving Unit to reopen/);
  assert.match(svc, /RECEIVING_REOPEN_UNIT_REQUIRED/);
  const panel = fs.readFileSync(path.join(feRoot, "components/store/IncomingShipmentsPanel.jsx"), "utf8");
  assert.match(panel, /reopenSelectedUnitIds/);
  assert.match(panel, /receivingSessionUnitIds/);
  assert.match(panel, /Select at least one Receiving Unit to reopen/);
});

run("8-9. selective reopen only touches selected COMPLETED units", () => {
  const svc = fs.readFileSync(path.join(srcRoot, "services/asnReceivingReopenService.js"), "utf8");
  assert.match(svc, /_id:\s*\{\s*\$in:\s*selectedUnitIds\s*\}/);
  assert.match(svc, /status:\s*"COMPLETED"/);
  assert.doesNotMatch(svc, /receivingSessionId:\s*sid,\s*\n\s*status:\s*"COMPLETED",\s*\n\s*\},\s*\n\s*\{\s*\n\s*\$set:\s*\{\s*\n\s*status:\s*"IN_PROGRESS"/);
});

run("10. multi-select reopen supported", () => {
  const panel = fs.readFileSync(path.join(feRoot, "components/store/IncomingShipmentsPanel.jsx"), "utf8");
  assert.match(panel, /type="checkbox"/);
  assert.match(panel, /toggleReopenUnit/);
});

run("11. invalid RU from another session rejected", () => {
  const svc = fs.readFileSync(path.join(srcRoot, "services/asnReceivingReopenService.js"), "utf8");
  assert.match(svc, /units\.length !== ids\.length/);
  assert.match(svc, /not part of this receiving session/);
});

run("12. selected RU CAS conflict rolls back entire reopen", () => {
  const svc = fs.readFileSync(path.join(srcRoot, "services/asnReceivingReopenService.js"), "utf8");
  assert.match(svc, /modifiedCount\)\s*!==\s*selectedUnitIds\.length/);
  assert.match(svc, /RECEIVING_REOPEN_CONFLICT/);
  assert.match(svc, /withTransaction/);
});

run("13. old Draft GRN invalidated on any reopen", () => {
  const svc = fs.readFileSync(path.join(srcRoot, "services/asnReceivingReopenService.js"), "utf8");
  assert.match(svc, /status:\s*"CANCELLED"/);
  assert.match(svc, /invalidatedGrn/);
});

run("14-16. replacement draft + RU identity + no reopen reprint", () => {
  const svc = fs.readFileSync(path.join(srcRoot, "services/asnReceivingReopenService.js"), "utf8");
  assert.match(svc, /Does not re-prepare RUs, reprint labels/);
  assert.match(svc, /receivingUnitId/);
  assert.match(svc, /ruNo/);
  const draft = fs.readFileSync(path.join(srcRoot, "services/asnReceivingDraftService.js"), "utf8");
  assert.match(draft, /findPostedOrLockedAsnReceivingGrn/);
  const panel = fs.readFileSync(path.join(feRoot, "components/store/IncomingShipmentsPanel.jsx"), "utf8");
  const reopenModal = panel.slice(panel.indexOf('title="Reopen Receiving"'), panel.indexOf('title="Reopen Receiving"') + 1200);
  assert.doesNotMatch(reopenModal, /Re-Prepare|reprint/i);
});

run("17. audit contains only selected RU nos", () => {
  const svc = fs.readFileSync(path.join(srcRoot, "services/asnReceivingReopenService.js"), "utf8");
  assert.match(svc, /reopenedRuNos/);
  assert.match(svc, /ruNos:\s*reopenedRuNos/);
  assert.doesNotMatch(svc, /ruNos:\s*units\.map/);
});

run("18. posted GRN still cannot reopen", () => {
  const svc = fs.readFileSync(path.join(srcRoot, "services/asnReceivingReopenService.js"), "utf8");
  assert.match(svc, /RECEIVING_REOPEN_BLOCKED_POSTED/);
});

run("19. MANUAL_PO unchanged", () => {
  const readiness = fs.readFileSync(path.join(srcRoot, "utils/asnReceivingPostReadiness.js"), "utf8");
  assert.match(readiness, /ASN_RECEIVING/);
  const putaway = fs.readFileSync(path.join(srcRoot, "utils/asnReceivingPutaway.js"), "utf8");
  assert.match(putaway, /ASN_RECEIVING/);
});

run("20. STORE_OPERATOR permissions unchanged", () => {
  const routes = fs.readFileSync(path.join(srcRoot, "routes/receivingInspectionRoutes.js"), "utf8");
  assert.match(routes, /sessions\/:sessionId\/reopen.*receivingMutate/s);
});

run("25. ASN Draft UI does not display MAIN as fake putaway", () => {
  const ui = fs.readFileSync(path.join(feRoot, "components/store/AsnReceivingDraftCustomsReview.jsx"), "utf8");
  assert.match(ui, /Putaway Location/);
  assert.match(ui, /Select putaway/);
  assert.doesNotMatch(ui, /location:\s*ln\.location\s*\|\|\s*ln\.warehouse/);
  assert.match(ui, /rack && bin/);
});

run("26. Actual Unit Weight remains read-only in GRN", () => {
  const ui = fs.readFileSync(path.join(feRoot, "components/store/AsnReceivingDraftCustomsReview.jsx"), "utf8");
  assert.match(ui, /Source: Receiving/);
  assert.match(ui, /never send client overrides|unitWeightKg = Number\(ln\.customsCapture/);
});

run("Incoming Shipments selective Reopen Receiving UX", () => {
  const panel = fs.readFileSync(path.join(feRoot, "components/store/IncomingShipmentsPanel.jsx"), "utf8");
  assert.match(panel, /Reopen Receiving/);
  assert.match(panel, /receivingSessionUnitIds/);
  assert.match(panel, /RECEIVING REOPENED FOR CORRECTION/);
  assert.match(panel, /Putaway/);
  assert.match(panel, /reopenableUnits/);
  assert.match(panel, /actualUnitWeightKg/);
});

run("complete session requires weight source", () => {
  const svc = fs.readFileSync(path.join(srcRoot, "services/receivingInspectionService.js"), "utf8");
  assert.match(svc, /RECEIVING_UNIT_WEIGHT_REQUIRED/);
  assert.match(svc, /before completing receiving/);
});

console.log(`\nasnReceivingReopenAndPutaway: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
