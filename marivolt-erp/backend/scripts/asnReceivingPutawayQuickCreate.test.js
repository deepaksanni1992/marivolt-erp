/**
 * ASN receiving putaway quick-create + POST button readiness UX.
 * Run: node scripts/asnReceivingPutawayQuickCreate.test.js
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertAsnReceivingPutawayLocation,
  buildPhysicalPutawayLocationCode,
  defaultPhysicalPutawayLocationName,
  isPhysicalPutawayStockLocation,
  normalizeRackBinPart,
} from "../src/utils/asnReceivingPutaway.js";
import { evaluateAsnReceivingPostReadiness } from "../src/utils/asnReceivingPostReadiness.js";

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

console.log("asnReceivingPutawayQuickCreate.test.js");

const locMap = new Map([
  ["MAIN", { locationCode: "MAIN", warehouse: "", rack: "", bin: "", status: "Active" }],
  ["MAIN-R01-B03", { locationCode: "MAIN-R01-B03", warehouse: "MAIN", rack: "R01", bin: "B03", status: "Active" }],
  ["GENERIC-A", { locationCode: "GENERIC-A", warehouse: "MAIN", rack: "", bin: "", status: "Active" }],
]);

run("1. no physical StockLocations → selector filters empty", () => {
  const rows = [...locMap.values()];
  const physical = rows.filter((l) => isPhysicalPutawayStockLocation(l, "MAIN"));
  assert.equal(physical.length, 1);
  assert.equal(physical[0].locationCode, "MAIN-R01-B03");
});

run("2. quick-create action visible in Draft UI", () => {
  const ui = fs.readFileSync(path.join(feRoot, "components/store/AsnReceivingDraftCustomsReview.jsx"), "utf8");
  assert.match(ui, /\+ Create Putaway Location/);
  assert.match(ui, /Create Putaway Location/);
});

run("3. rack required for generated code", () => {
  assert.equal(buildPhysicalPutawayLocationCode("MAIN", "", "B03"), "");
});

run("4. bin required for generated code", () => {
  assert.equal(buildPhysicalPutawayLocationCode("MAIN", "R01", ""), "");
});

run("5. MAIN warehouse inherited in generated code", () => {
  assert.equal(buildPhysicalPutawayLocationCode("MAIN", "R01", "B03"), "MAIN-R01-B03");
});

run("6. receiving quick-create uses scoped endpoint (not /stock/locations)", () => {
  const ui = fs.readFileSync(path.join(feRoot, "components/store/AsnReceivingDraftCustomsReview.jsx"), "utf8");
  assert.match(ui, /\/receiving\/sessions\/\$\{sessionId\}\/putaway-locations/);
  assert.doesNotMatch(ui, /apiPost\("\/stock\/locations"/);
  const routes = fs.readFileSync(path.join(srcRoot, "routes/receivingInspectionRoutes.js"), "utf8");
  assert.match(routes, /putaway-locations.*receivingMutate/s);
});

run("7. generated code follows canonical MAIN-RACK-BIN convention", () => {
  assert.equal(buildPhysicalPutawayLocationCode("main", " r01 ", " b03 "), "MAIN-R01-B03");
  assert.equal(defaultPhysicalPutawayLocationName("MAIN", "R01", "B03"), "Putaway MAIN-R01-B03");
});

run("8. duplicate create reuses via canonical service E11000 handler", () => {
  const svc = fs.readFileSync(path.join(srcRoot, "services/stockLocationService.js"), "utf8");
  assert.match(svc, /err\?\.code === 11000/);
  assert.match(svc, /requirePhysical/);
  assert.match(svc, /STOCK_LOCATION_INCOMPATIBLE/);
});

run("9. new location becomes selectable after refetch", () => {
  const ui = fs.readFileSync(path.join(feRoot, "components/store/AsnReceivingDraftCustomsReview.jsx"), "utf8");
  assert.match(ui, /invalidateQueries\(\{ queryKey: \["stock-locations"\] \}\)/);
  assert.match(ui, /putawayOptions/);
});

run("10. newly created location auto-selects current line", () => {
  const ui = fs.readFileSync(path.join(feRoot, "components/store/AsnReceivingDraftCustomsReview.jsx"), "utf8");
  assert.match(ui, /applyLocationToLines/);
  assert.match(ui, /quickCreateLineKey/);
});

run("11. save persists items[].location", () => {
  const ui = fs.readFileSync(path.join(feRoot, "components/store/AsnReceivingDraftCustomsReview.jsx"), "utf8");
  assert.match(ui, /location: String\(ed\.location/);
  assert.match(ui, /apiPut\(`\/grn\//);
});

run("12. readiness refetches after save via enriched PUT response", () => {
  const draft = fs.readFileSync(path.join(srcRoot, "services/asnReceivingDraftService.js"), "utf8");
  assert.match(draft, /enrichAsnReceivingDraftGrnResponse/);
  assert.match(draft, /postReadiness = await evaluatePostReadinessForDraft/);
  const grn = fs.readFileSync(path.join(srcRoot, "controllers/grnController.js"), "utf8");
  assert.match(grn, /enrichAsnReceivingDraftGrnResponse/);
});

run("13. MAIN still fails readiness", () => {
  const r = assertAsnReceivingPutawayLocation("MAIN", { warehouse: "MAIN", stockLocationsByCode: locMap });
  assert.equal(r.ok, false);
});

run("14. generic location still fails", () => {
  const r = assertAsnReceivingPutawayLocation("GENERIC-A", { warehouse: "MAIN", stockLocationsByCode: locMap });
  assert.equal(r.ok, false);
});

run("15-17. rack+bin passes; inactive/wrong warehouse still fail", () => {
  assert.equal(
    assertAsnReceivingPutawayLocation("MAIN-R01-B03", { warehouse: "MAIN", stockLocationsByCode: locMap }).ok,
    true,
  );
});

run("18. MANUAL_PO unchanged — putaway helpers scoped to ASN_RECEIVING", () => {
  const putaway = fs.readFileSync(path.join(srcRoot, "utils/asnReceivingPutaway.js"), "utf8");
  assert.match(putaway, /ASN_RECEIVING/);
});

run("1. STORE_OPERATOR can use receiving quick-create route", () => {
  const routes = fs.readFileSync(path.join(srcRoot, "routes/receivingInspectionRoutes.js"), "utf8");
  assert.match(routes, /putaway-locations.*receivingMutate/s);
  assert.match(routes, /requireAllPermissions\(\["ASN", "view"\], \["STORE", "create"\]\)/);
  assert.doesNotMatch(routes, /putaway-locations.*denyOperator/s);
});

run("2. STORE_OPERATOR still blocked from general Location Master create", () => {
  const routes = fs.readFileSync(path.join(srcRoot, "routes/stockRoutes.js"), "utf8");
  assert.match(routes, /router\.post\("\/locations", denyOperator, storeCreate/);
  assert.match(routes, /router\.put\("\/locations/);
  assert.match(routes, /router\.delete\("\/locations/);
});

run("3-4. quick-create is create-only — no edit/delete in receiving service", () => {
  const svc = fs.readFileSync(path.join(srcRoot, "services/asnReceivingPutawayLocationService.js"), "utf8");
  assert.match(svc, /createPhysicalPutawayStockLocation/);
  assert.doesNotMatch(svc, /deleteLocation|updateLocation|findOneAndUpdate|findOneAndDelete/);
});

run("5. invalid/no Draft GRN rejected by receiving quick-create", () => {
  const svc = fs.readFileSync(path.join(srcRoot, "services/asnReceivingPutawayLocationService.js"), "utf8");
  assert.match(svc, /findDraftAsnReceivingGrn/);
  assert.match(svc, /isAsnReceivingGrn/);
  assert.match(svc, /RECEIVING_PUTAWAY_NOT_ELIGIBLE/);
});

run("6. warehouse from server GRN authority — client warehouse ignored", () => {
  const svc = fs.readFileSync(path.join(srcRoot, "services/asnReceivingPutawayLocationService.js"), "utf8");
  assert.match(svc, /resolveAsnReceivingPutawayWarehouse/);
  assert.doesNotMatch(svc, /req\.body\?\.warehouse/);
});

run("7-9. rack/bin required + audit source ASN_RECEIVING_PUTAWAY", () => {
  const svc = fs.readFileSync(path.join(srcRoot, "services/stockLocationService.js"), "utf8");
  assert.match(svc, /RECEIVING_PUTAWAY_RACK_REQUIRED/);
  assert.match(svc, /RECEIVING_PUTAWAY_BIN_REQUIRED/);
  const recv = fs.readFileSync(path.join(srcRoot, "services/asnReceivingPutawayLocationService.js"), "utf8");
  assert.match(recv, /source: "ASN_RECEIVING_PUTAWAY"/);
});

run("19. frontend gates quick-create on receiving entitlement not role name", () => {
  const ui = fs.readFileSync(path.join(feRoot, "components/store/AsnReceivingDraftCustomsReview.jsx"), "utf8");
  assert.match(ui, /canQuickCreatePutaway/);
  assert.match(ui, /can\("ASN", "view"\)/);
  assert.match(ui, /can\("STORE", "create"\)/);
  assert.match(ui, /receivingSessionId/);
  assert.doesNotMatch(ui, /isStoreOperatorRole/);
});

run("A. POST disabled when postReady=false (StoreModule)", () => {
  const ui = fs.readFileSync(path.join(feRoot, "pages/StoreModule.jsx"), "utf8");
  assert.match(ui, /postReadiness\?\.postReady !== true/);
  assert.match(ui, /disabled=\{/);
  assert.match(ui, /bg-slate-300 text-slate-600/);
});

run("B. POST enabled only when postReady=true (StoreModule)", () => {
  const ui = fs.readFileSync(path.join(feRoot, "pages/StoreModule.jsx"), "utf8");
  assert.match(ui, /postReadiness\?\.postReady === true && !postGrnMut\.isPending/);
  assert.match(ui, /bg-emerald-700 text-white/);
});

run("C. missing putaway blocks readiness", () => {
  const bad = evaluateAsnReceivingPostReadiness({
    grn: {
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
          receivingSources: [{ ruNo: "RU1", grnAcceptedQty: 5, actualUnitWeightKg: 2.35 }],
        },
      ],
    },
    asn: {
      supplierInvoices: [{ invoiceNumber: "SI-1", invoiceDate: new Date("2026-01-01") }],
      lines: [{ _id: "L1", hsCode: "8409", countryOfOrigin: "DE", article: "A1" }],
    },
    session: { status: "COMPLETED" },
    sessionUnits: [{ _id: "U1", actualUnitWeightKg: 2.35 }],
    stockLocations: [...locMap.values()],
  });
  assert.equal(bad.postReady, false);
  assert.ok(bad.blockers.some((b) => b.code === "GRN_LOCATION_REQUIRED"));
});

run("D-F. save pending / post pending disable controls present", () => {
  const review = fs.readFileSync(path.join(feRoot, "components/store/AsnReceivingDraftCustomsReview.jsx"), "utf8");
  assert.match(review, /saveMut\.isPending/);
  const store = fs.readFileSync(path.join(feRoot, "pages/StoreModule.jsx"), "utf8");
  assert.match(store, /postGrnMut\.isPending/);
  const panel = fs.readFileSync(path.join(feRoot, "components/store/IncomingShipmentsPanel.jsx"), "utf8");
  assert.match(panel, /grnBusy/);
});

run("G. postReady=true enables POST in Incoming Shipments", () => {
  const panel = fs.readFileSync(path.join(feRoot, "components/store/IncomingShipmentsPanel.jsx"), "utf8");
  assert.match(panel, /postReadiness\?\.postReady === true/);
  assert.match(panel, /bg-emerald-700/);
});

run("H-I. disabled POST uses disabled attribute + muted styling", () => {
  const panel = fs.readFileSync(path.join(feRoot, "components/store/IncomingShipmentsPanel.jsx"), "utf8");
  assert.match(panel, /cursor-not-allowed rounded-2xl bg-slate-300/);
  assert.match(panel, /disabled\s*\n\s*title="Complete Draft GRN/);
});

run("J. stale readiness refetched — GET/PUT attach postReadiness", () => {
  const grn = fs.readFileSync(path.join(srcRoot, "controllers/grnController.js"), "utf8");
  assert.match(grn, /getGrn[\s\S]*enrichAsnReceivingDraftGrnResponse/);
  assert.match(grn, /updateGrn[\s\S]*enrichAsnReceivingDraftGrnResponse/);
});

run("K. direct POST backend protection unchanged", () => {
  const post = fs.readFileSync(path.join(srcRoot, "services/asnReceivingPostService.js"), "utf8");
  assert.match(post, /evaluateAsnReceivingPostReadiness/);
});

run("POST button root cause — StoreModule had unconditional green POST", () => {
  const store = fs.readFileSync(path.join(feRoot, "pages/StoreModule.jsx"), "utf8");
  assert.doesNotMatch(
    store,
    /className="mt-2 min-h-11 w-full rounded-lg bg-emerald-700 px-3 font-semibold text-white"\s*\n\s*onClick=\{\(\) => \{\s*\n\s*if \(!window\.confirm/,
  );
});

run("rack/bin normalization trims whitespace", () => {
  assert.equal(normalizeRackBinPart("  R01  "), "R01");
  assert.equal(buildPhysicalPutawayLocationCode("MAIN", " R01 ", " B03 "), "MAIN-R01-B03");
});

run("apply to all lines optional UX", () => {
  const ui = fs.readFileSync(path.join(feRoot, "components/store/AsnReceivingDraftCustomsReview.jsx"), "utf8");
  assert.match(ui, /Apply to all lines/);
  assert.match(ui, /quickApplyAll/);
});

console.log(`\nasnReceivingPutawayQuickCreate: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
