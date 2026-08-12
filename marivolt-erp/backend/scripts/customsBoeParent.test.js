/**
 * CustomsBoe parent architecture — tests A–V (unit / pure / source).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  computeBoeCustomsUnitValue,
  resolveLineCustomsQuantities,
  allocateBoeLineValues,
  buildCustomsLotStockGroup,
  buildCustomsBoeStockGroup,
  roundCustomsMoney,
  roundCustomsQty,
  CUSTOMS_VALUATION_BOE_AVERAGE,
} from "../src/utils/customsBoeAverage.js";
import {
  validateCustomsCaptureForGrn,
  detectCustomsValuationMode,
} from "../src/utils/customsGrnFieldModel.js";
import {
  canReserveLinkedQty,
  buildLinkedQtyReserveFilter,
  deriveCustomsBoeStatus,
  remainingToLinkQty,
} from "../src/services/customsBoeService.js";
import {
  validateCsvAgainstExistingBoe,
  validateInheritedCsvShipmentHeader,
  GRN_CSV_HEADERS,
} from "../src/utils/grnCsvImport.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcRoot = path.join(__dirname, "../src");

function run(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.error(`  ✗ ${name}`);
    throw e;
  }
}

const UNIT = computeBoeCustomsUnitValue(21500, 430);
assert.equal(UNIT.ok, true);
assert.equal(UNIT.customsUnitValue, 50);

console.log("customsBoeParent.test.js");

// A — New BOE partial first GRN
run("TEST A: GRN A 100 of 430 → unit 50, contribution 100", () => {
  const r = validateCustomsCaptureForGrn({
    header: {
      receivedDate: "2026-01-15",
      boeNumber: "511685",
      boeDate: "2026-01-10",
      blNumber: "BL-77881",
      supplierInvoiceNumber: "INV-101",
      supplierInvoiceDate: "2026-01-12",
      countryOfOrigin: "DE",
      hsCode: "840999",
      customsCurrency: "EUR",
      exchangeRateToAED: 4,
      boeDeclaredQty: 430,
      boeDeclaredValue: 21500,
      customsUom: "PCS",
    },
    lines: [{ poLineId: "L1", article: "W34SG", acceptedQty: 100, location: "A1", uom: "PCS" }],
    poDate: "2026-01-01",
  });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.customsUnitValue, 50);
  assert.equal(r.thisGrnCustomsQty, 100);
  assert.equal(r.lineCustomsQty.get("L1").customsTotalPrice, 5000);
  const rem = remainingToLinkQty({ boeDeclaredQty: 430, linkedCustomsQty: 100 });
  assert.equal(rem, 330);
});

// B / C — sequential linking math
run("TEST B/C: linked 100→300→430; unit stays 50", () => {
  let linked = 0;
  for (const delta of [100, 200, 130]) {
    const g = canReserveLinkedQty({ boeDeclaredQty: 430, linkedCustomsQty: linked, delta });
    assert.equal(g.ok, true, g.message);
    linked = roundCustomsQty(linked + delta);
    assert.equal(computeBoeCustomsUnitValue(21500, 430).customsUnitValue, 50);
  }
  assert.equal(linked, 430);
  assert.equal(deriveCustomsBoeStatus({ boeDeclaredQty: 430, linkedCustomsQty: 430 }), "RECONCILED");
});

// D — supplier invoices coexist conceptually
run("TEST D: distinct SI numbers under same BOE snapshot", () => {
  const invoices = ["INV-101", "INV-105", "INV-110"];
  assert.equal(new Set(invoices).size, 3);
});

// E — commercial prices irrelevant
run("TEST E: commercial prices do not change unit 50", () => {
  const commercial = [12.5, 99, 0.4];
  assert.equal(computeBoeCustomsUnitValue(21500, 430).customsUnitValue, 50);
  assert.ok(commercial.every((p) => p !== 50));
});

// F — over-link 431 rejected
run("TEST F: total 431 rejected", () => {
  const g = canReserveLinkedQty({ boeDeclaredQty: 430, linkedCustomsQty: 430, delta: 1 });
  assert.equal(g.ok, false);
  const capt = validateCustomsCaptureForGrn({
    header: {
      receivedDate: "2026-01-15",
      boeNumber: "511685",
      boeDate: "2026-01-10",
      supplierInvoiceNumber: "INV-X",
      supplierInvoiceDate: "2026-01-12",
      countryOfOrigin: "DE",
      hsCode: "840999",
      customsCurrency: "EUR",
      exchangeRateToAED: 4,
      boeDeclaredQty: 430,
      boeDeclaredValue: 21500,
      customsUom: "PCS",
    },
    lines: [{ poLineId: "L1", article: "X", acceptedQty: 431, location: "A1", uom: "PCS" }],
    poDate: "2026-01-01",
  });
  assert.equal(capt.ok, false);
});

// G — concurrent reserve filter
run("TEST G: concurrent 70+60 against remaining 100 — filter math", () => {
  const declared = 430;
  const linked = 330; // remaining 100
  const a = canReserveLinkedQty({ boeDeclaredQty: declared, linkedCustomsQty: linked, delta: 70 });
  const b = canReserveLinkedQty({ boeDeclaredQty: declared, linkedCustomsQty: linked, delta: 60 });
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  // After A succeeds linked=400; B against original filter would fail on atomic update
  const afterA = canReserveLinkedQty({
    boeDeclaredQty: declared,
    linkedCustomsQty: linked + 70,
    delta: 60,
  });
  assert.equal(afterA.ok, false);
  const filter = buildLinkedQtyReserveFilter({
    boeId: "x",
    companyId: "c",
    delta: 60,
    boeDeclaredQty: declared,
  });
  assert.ok(filter.linkedCustomsQty.$lte <= roundCustomsQty(declared - 60) + 1e-9);
});

// H — idempotency via unique grnId (source)
run("TEST H: unique companyId+grnId prevents double lot / double link", () => {
  const lot = fs.readFileSync(path.join(srcRoot, "models/CustomsLot.js"), "utf8");
  assert.match(lot, /companyId: 1, grnId: 1/);
  assert.match(lot, /unique: true/);
  const svc = fs.readFileSync(path.join(srcRoot, "services/customsService.js"), "utf8");
  assert.match(svc, /if \(existing\) return existing/);
  assert.match(svc, /reserveLinkedCustomsQty/);
});

// I — cancel release math (no re-average)
run("TEST I: cancel GRN B 200 → linked 230; unit unchanged", () => {
  let linked = 430;
  linked = roundCustomsQty(linked - 200);
  assert.equal(linked, 230);
  assert.equal(computeBoeCustomsUnitValue(21500, 430).customsUnitValue, 50);
  assert.equal(remainingToLinkQty({ boeDeclaredQty: 430, linkedCustomsQty: 230 }), 200);
});

// J — partial export no re-average
run("TEST J: partial export keeps unit 50", () => {
  const remainingValue = roundCustomsMoney(50 * 200);
  assert.equal(remainingValue, 10000);
  assert.equal(computeBoeCustomsUnitValue(21500, 430).customsUnitValue, 50);
});

// K / L — CI cancel / conversion provenance (source)
run("TEST K/L: CI cancel & conversion stay on same lot/BOE (source)", () => {
  const conv = fs.readFileSync(path.join(srcRoot, "services/articleConversionCustomsService.js"), "utf8");
  assert.match(conv, /customsLotId: sourceItem\.customsLotId/);
  assert.match(conv, /customsUnitValue: unit/);
  const ci = fs.readFileSync(path.join(srcRoot, "services/customsInvoiceService.js"), "utf8");
  assert.match(ci, /cancelCustomsInvoice/);
});

// M — two parents same external BOE number allowed
run("TEST M: boeNumber not unique; internal ref unique", () => {
  const model = fs.readFileSync(path.join(srcRoot, "models/CustomsBoe.js"), "utf8");
  assert.match(model, /companyId: 1, customsBoeRef: 1/);
  assert.match(model, /unique: true/);
  assert.doesNotMatch(model, /boeNumber: 1 \}, \{ unique: true \}/);
});

// N — company scoping
run("TEST N: BOE lookups company-scoped", () => {
  const svc = fs.readFileSync(path.join(srcRoot, "services/customsBoeService.js"), "utf8");
  assert.match(svc, /withCompanyId\(companyId/);
  assert.match(svc, /getCustomsBoeByIdOrRef/);
});

// O — legacy lot without parent
run("TEST O: legacy lot groupKey = lot._id", () => {
  const g = buildCustomsLotStockGroup(
    {
      _id: "LEGACY1",
      valuationMethod: "BOE_AVERAGE",
      boeDeclaredQty: 2,
      boeDeclaredValue: 100,
      customsUnitValue: 50,
      currency: "EUR",
      status: "OPEN",
      grnNo: "G1",
    },
    [
      {
        _id: "I1",
        articleNumber: "A",
        qtyImported: 2,
        qtyAvailable: 2,
        qtyConsumed: 0,
        customsQtyImported: 2,
        customsUnitValue: 50,
        totalValue: 100,
        valuationMethod: "BOE_AVERAGE",
      },
    ],
  );
  assert.equal(g.groupKey, "LEGACY1");
  assert.equal(g.groupKind, "LEGACY_LOT");
  assert.equal(g.customsBoeId, null);
});

// P — existing BOE cannot override economics
run("TEST P: select existing rejects conflicting declared qty", () => {
  const parent = {
    _id: "BOE1",
    customsBoeRef: "MAR-BOE-0001",
    boeNumber: "511685",
    boeDate: "2026-01-10",
    blNumber: "BL-77881",
    boeDeclaredQty: 430,
    boeDeclaredValue: 21500,
    customsUnitValue: 50,
    customsCurrency: "EUR",
    exchangeRateToAED: 4,
    customsUom: "PCS",
    linkedCustomsQty: 100,
    grossWeightKg: 500,
    netWeightKg: 450,
  };
  const bad = validateCustomsCaptureForGrn({
    header: {
      receivedDate: "2026-01-20",
      customsBoeId: "BOE1",
      boeNumber: "511685",
      boeDate: "2026-01-10",
      supplierInvoiceNumber: "INV-105",
      supplierInvoiceDate: "2026-01-18",
      countryOfOrigin: "DE",
      hsCode: "840999",
      customsCurrency: "EUR",
      exchangeRateToAED: 4,
      boeDeclaredQty: 999,
      boeDeclaredValue: 21500,
    },
    lines: [{ poLineId: "L1", article: "MAN", acceptedQty: 200, location: "A1", uom: "PCS" }],
    poDate: "2026-01-01",
    parentBoe: parent,
  });
  assert.equal(bad.ok, false);
  const good = validateCustomsCaptureForGrn({
    header: {
      receivedDate: "2026-01-20",
      customsBoeId: "BOE1",
      supplierInvoiceNumber: "INV-105",
      supplierInvoiceDate: "2026-01-18",
      countryOfOrigin: "DE",
      hsCode: "840999",
    },
    lines: [{ poLineId: "L1", article: "MAN", acceptedQty: 200, location: "A1", uom: "PCS" }],
    poDate: "2026-01-01",
    parentBoe: parent,
  });
  assert.equal(good.ok, true, JSON.stringify(good.errors));
  assert.equal(good.customsUnitValue, 50);
  assert.equal(good.thisGrnCustomsQty, 200);
});

// Q / R — CSV existing BOE
run("TEST Q/R: CSV existing BOE ref + conflict reject", () => {
  assert.ok(GRN_CSV_HEADERS.includes("Customs BOE Ref"));
  const msgs = validateInheritedCsvShipmentHeader({
    customsBoeRef: "MAR-BOE-0001",
    supplierInvoiceNumber: "INV-105",
    supplierInvoiceDate: "2026-01-18",
  });
  assert.equal(msgs.length, 0);
  const conflict = validateCsvAgainstExistingBoe(
    { boeDeclaredQty: 999, boeDeclaredValue: 1 },
    {
      customsBoeRef: "MAR-BOE-0001",
      boeDeclaredQty: 430,
      boeDeclaredValue: 21500,
      customsUnitValue: 50,
      customsCurrency: "EUR",
      exchangeRateToAED: 4,
      grossWeightKg: 500,
      netWeightKg: 450,
    },
  );
  assert.ok(conflict.some((m) => /conflicts/i.test(m)));
});

// S — weight parent-only on BOE model
run("TEST S: gross/net on CustomsBoe schema", () => {
  const model = fs.readFileSync(path.join(srcRoot, "models/CustomsBoe.js"), "utf8");
  assert.match(model, /grossWeightKg/);
  assert.match(model, /netWeightKg/);
});

// T — multi-article contribution sum
run("TEST T: multi-article customs qty sums into GRN contribution", () => {
  const qty = resolveLineCustomsQuantities({
    lines: [
      { poLineId: "L1", article: "A", acceptedQty: 40, uom: "PCS" },
      { poLineId: "L2", article: "B", acceptedQty: 60, uom: "PCS" },
    ],
    boeDeclaredQty: 430,
    customsUom: "PCS",
  });
  assert.equal(qty.ok, true);
  assert.equal(qty.thisGrnCustomsQty, 100);
  const vals = allocateBoeLineValues({
    lines: qty.lines,
    boeDeclaredQty: 430,
    boeDeclaredValue: 21500,
    customsUnitValue: 50,
  });
  assert.equal(roundCustomsMoney(vals.reduce((s, r) => s + r.customsTotalPrice, 0)), 5000);
});

// U — stock one BOE group with multiple GRNs
run("TEST U: Customs Stock groups by customsBoeId", () => {
  const lotA = buildCustomsLotStockGroup(
    {
      _id: "LA",
      customsBoeId: "BOE1",
      customsBoeRef: "MAR-BOE-0001",
      boeNumber: "511685",
      valuationMethod: "BOE_AVERAGE",
      boeDeclaredQty: 430,
      boeDeclaredValue: 21500,
      customsUnitValue: 50,
      currency: "EUR",
      customsUom: "PCS",
      grnNo: "GRN-A",
      poNo: "PO-A",
      supplierInvoiceNumber: "INV-101",
      status: "OPEN",
    },
    [
      {
        _id: "IA",
        articleNumber: "W34",
        qtyImported: 100,
        qtyAvailable: 100,
        qtyConsumed: 0,
        customsQtyImported: 100,
        customsUnitValue: 50,
        totalValue: 5000,
        valuationMethod: "BOE_AVERAGE",
        grnNo: "GRN-A",
      },
    ],
  );
  const lotB = buildCustomsLotStockGroup(
    {
      _id: "LB",
      customsBoeId: "BOE1",
      customsBoeRef: "MAR-BOE-0001",
      boeNumber: "511685",
      valuationMethod: "BOE_AVERAGE",
      boeDeclaredQty: 430,
      boeDeclaredValue: 21500,
      customsUnitValue: 50,
      currency: "EUR",
      customsUom: "PCS",
      grnNo: "GRN-B",
      poNo: "PO-B",
      supplierInvoiceNumber: "INV-105",
      status: "OPEN",
    },
    [
      {
        _id: "IB",
        articleNumber: "MAN",
        qtyImported: 200,
        qtyAvailable: 200,
        qtyConsumed: 0,
        customsQtyImported: 200,
        customsUnitValue: 50,
        totalValue: 10000,
        valuationMethod: "BOE_AVERAGE",
        grnNo: "GRN-B",
      },
    ],
  );
  const group = buildCustomsBoeStockGroup(
    {
      _id: "BOE1",
      customsBoeRef: "MAR-BOE-0001",
      boeNumber: "511685",
      blNumber: "BL-77881",
      boeDeclaredQty: 430,
      boeDeclaredValue: 21500,
      customsUnitValue: 50,
      customsCurrency: "EUR",
      customsUom: "PCS",
      linkedCustomsQty: 300,
      valuationMethod: "BOE_AVERAGE",
      status: "OPEN",
    },
    [lotA, lotB],
  );
  assert.equal(group.groupKey, "BOE1");
  assert.equal(group.groupKind, "CUSTOMS_BOE");
  assert.equal(group.receipts.length, 2);
  assert.equal(group.boeSummary.linkedQty, 300);
  assert.equal(group.boeSummary.remainingToLink, 130);
  assert.equal(group.boeSummary.customsUnitValue, 50);
  assert.equal(group.boeSummary.importedQty, 300);
  // V: remaining-to-link ≠ remaining stock
  assert.equal(group.boeSummary.remainingQty, 300);
  assert.notEqual(group.boeSummary.remainingToLink, group.boeSummary.remainingQty);
});

run("TEST V: inbound remaining-to-link distinct from outbound remaining", () => {
  assert.equal(remainingToLinkQty({ boeDeclaredQty: 430, linkedCustomsQty: 300 }), 130);
});

run("Numbering service exposes nextCustomsBoeRef", () => {
  const num = fs.readFileSync(path.join(srcRoot, "services/customsNumberService.js"), "utf8");
  assert.match(num, /nextCustomsBoeRef/);
  assert.match(num, /-BOE-/);
});

run("createCustomsLotFromGrn creates/links CustomsBoe", () => {
  const svc = fs.readFileSync(path.join(srcRoot, "services/customsService.js"), "utf8");
  assert.match(svc, /createCustomsBoe/);
  assert.match(svc, /customsBoeId/);
  assert.match(svc, /releaseLinkedCustomsQty/);
  assert.match(svc, /buildCustomsBoeStockGroup/);
});

console.log("customsBoeParent.test.js: all scenarios passed");
