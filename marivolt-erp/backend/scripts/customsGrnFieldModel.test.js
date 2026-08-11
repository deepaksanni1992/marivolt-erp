/**
 * Customs GRN field model (revised) — resolution, mandatory, date rules.
 * Run: node scripts/customsGrnFieldModel.test.js
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CUSTOMS_GRN_MANDATORY_EFFECTIVE,
  isCustomsCaptureActive,
  resolveCustomsAllowances,
  resolveCustomsLineEffective,
  validateCustomsDates,
  validateCustomsMandatoryEffective,
  validateCustomsCaptureForGrn,
  buildLineOverrideMap,
  normalizeCustomsHeaderDefaults,
  toPersistedGrnLineCustoms,
} from "../src/utils/customsGrnFieldModel.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcRoot = path.join(__dirname, "..", "src");
const frontRoot = path.join(__dirname, "..", "..", "src");

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

console.log("\nCustoms GRN field model (revised)\n");

const today = new Date();
const yyyy = today.getFullYear();
const mm = String(today.getMonth() + 1).padStart(2, "0");
const dd = String(today.getDate()).padStart(2, "0");
const todayStr = `${yyyy}-${mm}-${dd}`;
const yesterday = new Date(today);
yesterday.setDate(yesterday.getDate() - 1);
const yStr = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, "0")}-${String(yesterday.getDate()).padStart(2, "0")}`;
const tomorrow = new Date(today);
tomorrow.setDate(tomorrow.getDate() + 1);
const tmrStr = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, "0")}-${String(tomorrow.getDate()).padStart(2, "0")}`;

run("Line override wins over header", () => {
  const eff = resolveCustomsLineEffective({
    header: { hsCode: "HDR", countryOfOrigin: "IN", customsCurrency: "USD", exchangeRateToAED: 3.67 },
    override: { hsCode: "LINE" },
    quantity: 2,
    customsUnitValue: 10,
  });
  assert.equal(eff.hsCode, "LINE");
  assert.equal(eff.countryOfOrigin, "IN");
  assert.equal(eff.customsTotalPrice, 20);
  assert.ok(Math.abs(eff.customsValueAED - 73.4) < 0.001);
});

run("Server ignores client-imported totals (always recalculates)", () => {
  const eff = resolveCustomsLineEffective({
    header: { customsCurrency: "USD", exchangeRateToAED: 2, unitWeightKg: 1 },
    override: { customsTotalPrice: 999, customsValueAED: 999, totalWeightKg: 999 },
    quantity: 3,
    customsUnitValue: 10,
  });
  assert.equal(eff.customsTotalPrice, 30);
  assert.equal(eff.customsValueAED, 60);
  assert.equal(eff.totalWeightKg, 3);
});

run("AED currency forces FX = 1", () => {
  const eff = resolveCustomsLineEffective({
    header: { customsCurrency: "AED", exchangeRateToAED: 3.67 },
    quantity: 2,
    customsUnitValue: 5,
  });
  assert.equal(eff.exchangeRateToAED, 1);
  assert.equal(eff.customsValueAED, 10);
});

run("Client checkbox alone does not grant date override", () => {
  const denied = resolveCustomsAllowances({
    requested: { allowBoeBeforePoDate: true, allowFutureReceivedDate: true },
    permissionGranted: false,
  });
  assert.equal(denied.allowBoeBeforePoDate, false);
  assert.equal(denied.allowFutureReceivedDate, false);
  const granted = resolveCustomsAllowances({
    requested: { allowBoeBeforePoDate: true },
    permissionGranted: true,
  });
  assert.equal(granted.allowBoeBeforePoDate, true);
});

run("No commercial unitCost fallback for customs price", () => {
  const eff = resolveCustomsLineEffective({
    header: {},
    override: {},
    quantity: 5,
  });
  assert.equal(eff.customsUnitPrice, 0);
});

run("Total weight = qty × unit weight when not overridden", () => {
  const eff = resolveCustomsLineEffective({
    header: { unitWeightKg: 1.5 },
    override: {},
    quantity: 4,
  });
  assert.equal(eff.totalWeightKg, 6);
});

run("Mandatory set includes required keys", () => {
  assert.ok(CUSTOMS_GRN_MANDATORY_EFFECTIVE.includes("boeNumber"));
  assert.ok(CUSTOMS_GRN_MANDATORY_EFFECTIVE.includes("exchangeRateToAED"));
  assert.ok(!CUSTOMS_GRN_MANDATORY_EFFECTIVE.includes("blNumber"));
  assert.ok(!CUSTOMS_GRN_MANDATORY_EFFECTIVE.includes("awbNumber"));
});

run("Mandatory validation fails when incomplete", () => {
  const errs = validateCustomsMandatoryEffective(
    resolveCustomsLineEffective({ header: { boeNumber: "B1" }, quantity: 1 }),
    { location: "" }
  );
  assert.ok(errs.length > 3);
  assert.ok(errs.some((e) => /Location/i.test(e)));
});

run("Mandatory validation passes when complete", () => {
  const eff = resolveCustomsLineEffective({
    header: {
      receivedDate: todayStr,
      boeNumber: "BOE-1",
      boeDate: yStr,
      supplierInvoiceNumber: "SI-1",
      supplierInvoiceDate: yStr,
      countryOfOrigin: "IN",
      hsCode: "8481",
      customsCurrency: "USD",
      exchangeRateToAED: 3.67,
    },
    quantity: 2,
    customsUnitValue: 12,
  });
  const errs = validateCustomsMandatoryEffective(eff, { location: "RACK-A" });
  assert.deepEqual(errs, []);
});

run("BL and AWB optional (neither / either / both)", () => {
  const base = {
    receivedDate: todayStr,
    boeNumber: "BOE-1",
    boeDate: yStr,
    supplierInvoiceNumber: "SI-1",
    supplierInvoiceDate: yStr,
    countryOfOrigin: "IN",
    hsCode: "8481",
    customsCurrency: "USD",
    exchangeRateToAED: 3.67,
  };
  for (const extra of [{}, { blNumber: "BL1" }, { awbNumber: "AWB1" }, { blNumber: "BL1", awbNumber: "AWB1" }]) {
    const eff = resolveCustomsLineEffective({
      header: { ...base, ...extra },
      quantity: 1,
      customsUnitValue: 1,
    });
    assert.deepEqual(validateCustomsMandatoryEffective(eff, { location: "L1" }), []);
  }
});

run("BOEDate cannot be in the future", () => {
  const eff = resolveCustomsLineEffective({
    header: { boeDate: tmrStr, receivedDate: todayStr, supplierInvoiceDate: yStr },
    quantity: 1,
  });
  const errs = validateCustomsDates(eff, { poDate: yStr });
  assert.ok(errs.some((e) => /BOE Date cannot be in the future/i.test(e)));
});

run("BOEDate before PO requires authorisation", () => {
  const eff = resolveCustomsLineEffective({
    header: { boeDate: "2020-01-01", receivedDate: todayStr, supplierInvoiceDate: yStr },
    quantity: 1,
  });
  const blocked = validateCustomsDates(eff, { poDate: "2024-01-01", allowances: {} });
  assert.ok(blocked.some((e) => /earlier than PO/i.test(e)));
  const allowed = validateCustomsDates(eff, {
    poDate: "2024-01-01",
    allowances: { allowBoeBeforePoDate: true },
  });
  assert.ok(!allowed.some((e) => /earlier than PO/i.test(e)));
});

run("Supplier invoice after received requires override", () => {
  const eff = resolveCustomsLineEffective({
    header: {
      receivedDate: yStr,
      supplierInvoiceDate: todayStr,
      boeDate: yStr,
    },
    quantity: 1,
  });
  const blocked = validateCustomsDates(eff, {});
  assert.ok(blocked.some((e) => /later than Received Date/i.test(e)));
});

run("ReceivedDate before PO rejected; future needs support flag", () => {
  const early = resolveCustomsLineEffective({
    header: { receivedDate: "2020-01-01" },
    quantity: 1,
  });
  assert.ok(validateCustomsDates(early, { poDate: "2024-06-01" }).some((e) => /earlier than PO/i.test(e)));
  const future = resolveCustomsLineEffective({
    header: { receivedDate: tmrStr },
    quantity: 1,
  });
  assert.ok(validateCustomsDates(future, {}).some((e) => /future/i.test(e)));
});

run("Dates are not silently mutated (parse preserves calendar day)", () => {
  const eff = resolveCustomsLineEffective({
    header: { boeDate: "2026-07-28", supplierInvoiceDate: "2026-07-15", receivedDate: "2026-07-30" },
    quantity: 1,
  });
  assert.equal(eff.boeDate.getFullYear(), 2026);
  assert.equal(eff.boeDate.getMonth(), 6);
  assert.equal(eff.boeDate.getDate(), 28);
});

run("Received Date alone does not activate capture", () => {
  assert.equal(isCustomsCaptureActive({ header: { receivedDate: todayStr, customsUom: "PCS" } }), false);
  assert.equal(isCustomsCaptureActive({ header: { receivedDate: todayStr, boeNumber: "511685" } }), true);
});

run("Header missing declared value is one HEADER error not per line", () => {
  const header = normalizeCustomsHeaderDefaults({
    receivedDate: todayStr,
    boeNumber: "BOE",
    boeDate: yStr,
    supplierInvoiceNumber: "SI",
    supplierInvoiceDate: yStr,
    countryOfOrigin: "IN",
    hsCode: "1",
    customsCurrency: "USD",
    exchangeRateToAED: 3.67,
    boeDeclaredQty: 2,
    customsUom: "PCS",
  });
  const r = validateCustomsCaptureForGrn({
    header,
    lines: [
      { poLineId: "a", article: "ART-1", acceptedQty: 1, location: "BIN-1", uom: "PCS" },
      { poLineId: "b", article: "ART-2", acceptedQty: 1, location: "BIN-1", uom: "PCS" },
    ],
    poDate: yStr,
  });
  assert.equal(r.ok, false);
  const headerHits = r.errors.filter((e) => e.line === "HEADER");
  const lineValueHits = r.errors.filter((e) => e.line !== "HEADER" && e.messages.some((m) => /Declared Value/.test(m)));
  assert.ok(headerHits.some((e) => e.messages.some((m) => /BOE Declared Value is required/.test(m))));
  assert.equal(lineValueHits.length, 0);
});

run("Capture validation aggregates per line", () => {
  const header = normalizeCustomsHeaderDefaults({
    receivedDate: todayStr,
    boeNumber: "BOE",
    boeDate: yStr,
    supplierInvoiceNumber: "SI",
    supplierInvoiceDate: yStr,
    countryOfOrigin: "IN",
    hsCode: "1",
    customsCurrency: "USD",
    boeDeclaredQty: 2,
    boeDeclaredValue: 10,
    customsUom: "PCS",
    exchangeRateToAED: 3.67,
  });
  const r = validateCustomsCaptureForGrn({
    header,
    lineOverrides: buildLineOverrideMap({ lineOverrides: [] }),
    lines: [{ poLineId: "a", article: "ART-1", acceptedQty: 2, location: "BIN-1", uom: "PCS" }],
    poDate: yStr,
  });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.customsUnitValue, 5);
});

run("Persisted snapshot shape", () => {
  const snap = toPersistedGrnLineCustoms(
    resolveCustomsLineEffective({
      header: {
        receivedDate: todayStr,
        boeNumber: "B",
        boeDate: yStr,
        supplierInvoiceNumber: "S",
        supplierInvoiceDate: yStr,
        countryOfOrigin: "ae",
        hsCode: "x",
        customsCurrency: "usd",
        exchangeRateToAED: 3.67,
        unitWeightKg: 1,
        boeDeclaredQty: 3,
        boeDeclaredValue: 6,
      },
      quantity: 3,
      customsUnitValue: 2,
      customsQty: 3,
    })
  );
  assert.equal(snap.countryOfOrigin, "AE");
  assert.equal(snap.totalWeightKg, 3);
  assert.equal(snap.customsTotalPrice, 6);
  assert.equal(snap.customsUnitValue, 2);
});

run("GRN model has customsCapture; lot/item have new fields", () => {
  const grn = fs.readFileSync(path.join(srcRoot, "models/GRN.js"), "utf8");
  const lot = fs.readFileSync(path.join(srcRoot, "models/CustomsLot.js"), "utf8");
  const item = fs.readFileSync(path.join(srcRoot, "models/CustomsLotItem.js"), "utf8");
  assert.match(grn, /customsCapture/);
  assert.match(lot, /boeDate/);
  assert.match(lot, /exchangeRateToAED/);
  assert.match(lot, /valuationMethod/);
  assert.match(lot, /boeDeclaredValue/);
  assert.match(item, /customsValueAED/);
  assert.match(item, /unitWeightKg/);
  assert.match(item, /receivedDate/);
  assert.match(item, /customsUnitValue/);
});

run("Service uses permission-gated allowances / no unitCost customs fallback", () => {
  const svc = fs.readFileSync(path.join(srcRoot, "services/customsService.js"), "utf8");
  assert.match(svc, /applyResolvedCustomsToGrnLines/);
  assert.match(svc, /resolveCustomsAllowances/);
  assert.match(svc, /hasPermission\(req,\s*"STORE",\s*"approve"\)/);
  assert.match(svc, /customsCapture/);
  assert.match(svc, /BOE_AVERAGE|customsBoeAverage/);
  assert.doesNotMatch(svc, /override\.unitPrice \?\? \(payload\.unitPrice \|\| undefined\) \?\? line\.unitCost/);
});

run("Customs lot unique on company+grnId; BOE not globally unique", () => {
  const lot = fs.readFileSync(path.join(srcRoot, "models/CustomsLot.js"), "utf8");
  assert.match(lot, /companyId: 1, grnId: 1/);
  assert.doesNotMatch(lot, /boeNumber: 1 \}, \{ unique: true \}/);
  assert.doesNotMatch(lot, /unique: true[\s\S]*boeNumber/);
});

run("Frontend header includes BOE Declared Qty/Value and FX", () => {
  const ui = fs.readFileSync(path.join(frontRoot, "components/store/GrnCustomsSection.jsx"), "utf8");
  const payload = fs.readFileSync(path.join(frontRoot, "lib/grnCustomsPayload.js"), "utf8");
  assert.match(ui, /Received Date/);
  assert.match(ui, /BOE Date/);
  assert.match(ui, /BOE Declared Customs Qty/);
  assert.match(ui, /BOE Declared Value/);
  assert.match(ui, /Exchange Rate to AED/);
  assert.match(ui, /STORE approve permission/);
  assert.match(payload, /exchangeRateToAED/);
  assert.match(payload, /boeDeclaredQty/);
  assert.match(payload, /boeDeclaredValue/);
  assert.doesNotMatch(payload, /customsUnitPrice:\s*trim/);
});

run("FIFO sort helper uses CG2 customsFifo util", () => {
  const svc = fs.readFileSync(path.join(srcRoot, "services/customsService.js"), "utf8");
  assert.match(svc, /sortCustomsLotsForFifo/);
  assert.match(svc, /allocateCustomsStockFIFO/);
  assert.match(svc, /customsFifo\.js/);
  assert.match(svc, /allocateQtyAcrossLotsFifo/);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
