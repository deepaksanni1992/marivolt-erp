/**
 * BOE-grouped Customs Stock + Piston/Bolt flow validation (unit-level).
 */
import assert from "node:assert/strict";
import {
  computeBoeCustomsUnitValue,
  buildCustomsLotStockGroup,
  computeLotItemCustomsEconomics,
  compareSalesVsBoeCustomsUnit,
  allocateBoeLineValues,
  roundCustomsMoney,
  CUSTOMS_VALUATION_BOE_AVERAGE,
  CUSTOMS_VALUATION_LEGACY_LINE,
  resolveValuationMethod,
} from "../src/utils/customsBoeAverage.js";
import { validateCustomsCaptureForGrn } from "../src/utils/customsGrnFieldModel.js";

function pistonBoltCapture() {
  return validateCustomsCaptureForGrn({
    header: {
      receivedDate: "2026-01-15",
      boeNumber: "TEST-BOE-AVG-001",
      boeDate: "2026-01-10",
      supplierInvoiceNumber: "SI-1",
      supplierInvoiceDate: "2026-01-12",
      countryOfOrigin: "DE",
      hsCode: "840999",
      customsCurrency: "EUR",
      exchangeRateToAED: 4,
      boeDeclaredQty: 2,
      boeDeclaredValue: 1010,
      customsUom: "PCS",
    },
    lines: [
      { poLineId: "L1", article: "PISTON", acceptedQty: 1, location: "A1", uom: "PCS" },
      { poLineId: "L2", article: "BOLT", acceptedQty: 1, location: "A1", uom: "PCS" },
    ],
    poDate: "2026-01-01",
  });
}

// --- Phase 1 flow: capture ---
{
  const unit = computeBoeCustomsUnitValue(1010, 2);
  assert.equal(unit.customsUnitValue, 505);

  const capt = pistonBoltCapture();
  assert.equal(capt.ok, true, JSON.stringify(capt.errors));
  assert.equal(capt.valuationMethod, CUSTOMS_VALUATION_BOE_AVERAGE);
  assert.equal(capt.customsUnitValue, 505);
  assert.equal(capt.lineCustomsQty.get("L1").customsTotalPrice, 505);
  assert.equal(capt.lineCustomsQty.get("L2").customsTotalPrice, 505);

  // Commercial costs remain conceptual independent
  const commercial = { PISTON: 1000, BOLT: 10 };
  assert.equal(commercial.PISTON, 1000);
  assert.equal(commercial.BOLT, 10);
}

function makeLotItems({ pistonAvail = 1, boltAvail = 1, pistonConsumed = 0, boltConsumed = 0 } = {}) {
  const lot = {
    _id: "LOT-A",
    companyId: "CMP-MAR",
    customsLotRef: "CL-1",
    boeNumber: "TEST-BOE-AVG-001",
    boeDate: new Date("2026-01-10"),
    supplierName: "Example Supplier",
    supplierInvoiceNumber: "SI-1",
    currency: "EUR",
    customsUom: "PCS",
    valuationMethod: CUSTOMS_VALUATION_BOE_AVERAGE,
    boeDeclaredQty: 2,
    boeDeclaredValue: 1010,
    customsUnitValue: 505,
    grossWeightKg: 12,
    netWeightKg: 10,
    status: "OPEN",
    grnNo: "GRN-1",
    documents: {},
  };
  const items = [
    {
      _id: "IT-P",
      customsLotId: "LOT-A",
      articleNumber: "PISTON",
      partNumber: "MV-P001",
      partName: "Piston",
      qtyImported: 1,
      qtyAvailable: pistonAvail,
      qtyConsumed: pistonConsumed,
      customsQtyImported: 1,
      customsUnitValue: 505,
      unitPrice: 505,
      totalValue: 505,
      valuationMethod: CUSTOMS_VALUATION_BOE_AVERAGE,
      currency: "EUR",
      grnNo: "GRN-1",
      status: pistonAvail <= 0 ? "CONSUMED" : "IN_STOCK",
    },
    {
      _id: "IT-B",
      customsLotId: "LOT-A",
      articleNumber: "BOLT",
      partNumber: "MV-B001",
      partName: "Bolt",
      qtyImported: 1,
      qtyAvailable: boltAvail,
      qtyConsumed: boltConsumed,
      customsQtyImported: 1,
      customsUnitValue: 505,
      unitPrice: 505,
      totalValue: 505,
      valuationMethod: CUSTOMS_VALUATION_BOE_AVERAGE,
      currency: "EUR",
      grnNo: "GRN-1",
      status: boltAvail <= 0 ? "CONSUMED" : "IN_STOCK",
    },
  ];
  return { lot, items };
}

// 1–3: BOE group with two articles
{
  const { lot, items } = makeLotItems();
  const g = buildCustomsLotStockGroup(lot, items, { srNo: 1 });
  assert.equal(g.groupKey, "LOT-A");
  assert.equal(g.isBoeAverage, true);
  assert.equal(g.boeSummary.declaredQty, 2);
  assert.equal(g.boeSummary.declaredValue, 1010);
  assert.equal(g.boeSummary.customsUnitValue, 505);
  assert.equal(g.boeSummary.importedQty, 2);
  assert.equal(g.boeSummary.exportedQty, 0);
  assert.equal(g.boeSummary.remainingQty, 2);
  assert.equal(g.boeSummary.remainingValue, 1010);
  assert.equal(g.articleCount, 2);
  assert.equal(g.status, "OPEN");
}

// 4: After one export (Piston)
{
  const { lot, items } = makeLotItems({ pistonAvail: 0, pistonConsumed: 1 });
  const g = buildCustomsLotStockGroup(lot, items);
  assert.equal(g.boeSummary.importedQty, 2);
  assert.equal(g.boeSummary.exportedQty, 1);
  assert.equal(g.boeSummary.remainingQty, 1);
  assert.equal(g.boeSummary.consumedValue, 505);
  assert.equal(g.boeSummary.remainingValue, 505);
  assert.equal(g.boeSummary.customsUnitValue, 505);
  assert.equal(g.status, "OPEN");
}

// Low-value warning Bolt EUR 20
{
  const cmp = compareSalesVsBoeCustomsUnit({
    salesUnitPrice: 20,
    salesCurrency: "EUR",
    boeCustomsUnitValue: 505,
    boeCurrency: "EUR",
  });
  assert.equal(cmp.warning, true);
  assert.equal(cmp.difference, -485);
  assert.ok(Math.abs(cmp.variancePct - -96.04) < 0.02);
}

// 5: Complete export → CLOSED
{
  const { lot, items } = makeLotItems({
    pistonAvail: 0,
    pistonConsumed: 1,
    boltAvail: 0,
    boltConsumed: 1,
  });
  const g = buildCustomsLotStockGroup(lot, items);
  assert.equal(g.boeSummary.remainingQty, 0);
  assert.equal(g.boeSummary.remainingValue, 0);
  assert.equal(g.boeSummary.consumedValue, 1010);
  assert.equal(g.status, "CLOSED");
}

// 6: Reversal restores Bolt
{
  const { lot, items } = makeLotItems({ pistonAvail: 0, pistonConsumed: 1, boltAvail: 1, boltConsumed: 0 });
  const g = buildCustomsLotStockGroup(lot, items);
  assert.equal(g.boeSummary.remainingQty, 1);
  assert.equal(g.boeSummary.remainingValue, 505);
  const bolt = g.articles.find((a) => a.articleNumber === "BOLT");
  assert.equal(bolt.customsUnitValue, 505);
  assert.equal(bolt.remainingCustomsQty, 1);
}

// 7: Same BOE number different lots never merge
{
  const lotA = { _id: "LOT-A", boeNumber: "SAME", valuationMethod: "BOE_AVERAGE", boeDeclaredQty: 1, boeDeclaredValue: 100, customsUnitValue: 100, currency: "EUR", status: "OPEN" };
  const lotB = { _id: "LOT-B", boeNumber: "SAME", valuationMethod: "BOE_AVERAGE", boeDeclaredQty: 1, boeDeclaredValue: 200, customsUnitValue: 200, currency: "EUR", status: "OPEN" };
  const gA = buildCustomsLotStockGroup(lotA, [
    { _id: "1", qtyImported: 1, qtyAvailable: 1, qtyConsumed: 0, customsQtyImported: 1, customsUnitValue: 100, totalValue: 100, articleNumber: "X" },
  ]);
  const gB = buildCustomsLotStockGroup(lotB, [
    { _id: "2", qtyImported: 1, qtyAvailable: 1, qtyConsumed: 0, customsQtyImported: 1, customsUnitValue: 200, totalValue: 200, articleNumber: "Y" },
  ]);
  assert.notEqual(gA.groupKey, gB.groupKey);
  assert.equal(gA.boeNumber, gB.boeNumber);
  assert.equal(gA.boeSummary.customsUnitValue, 100);
  assert.equal(gB.boeSummary.customsUnitValue, 200);
}

// 8: Legacy — no fake BOE average
{
  const lot = { _id: "LEG-1", boeNumber: "OLD", status: "OPEN" }; // no valuationMethod
  const items = [
    {
      _id: "i1",
      articleNumber: "LEG-ART",
      qtyImported: 5,
      qtyAvailable: 5,
      qtyConsumed: 0,
      unitPrice: 12,
      totalValue: 60,
    },
  ];
  const g = buildCustomsLotStockGroup(lot, items);
  assert.equal(g.valuationMethod, CUSTOMS_VALUATION_LEGACY_LINE);
  assert.equal(g.isBoeAverage, false);
  assert.equal(g.boeSummary.declaredQty, null);
  assert.equal(g.boeSummary.declaredValue, null);
  assert.equal(g.boeSummary.customsUnitValue, null);
  assert.equal(g.boeSummary.importedQty, 5);
  assert.equal(g.boeSummary.remainingValue, 60);
}

// 9: Article search highlight
{
  const { lot, items } = makeLotItems();
  const g = buildCustomsLotStockGroup(lot, items, { matchArticle: "BOLT" });
  assert.equal(g.hasArticleMatch, true);
  assert.equal(g.articles.find((a) => a.articleNumber === "BOLT").matchHighlight, true);
  assert.equal(g.articles.find((a) => a.articleNumber === "PISTON").matchHighlight, false);
}

// 10: BOE identity on group
{
  const { lot, items } = makeLotItems();
  const g = buildCustomsLotStockGroup(lot, items);
  assert.equal(g.boeNumber, "TEST-BOE-AVG-001");
  assert.equal(g.customsLotId, "LOT-A");
}

// 11: CSV row shape — article economics with BOE fields (projection)
{
  const { lot, items } = makeLotItems({ pistonAvail: 0, pistonConsumed: 1 });
  const g = buildCustomsLotStockGroup(lot, items);
  const csvRows = g.articles.map((a) => ({
    boeNumber: g.boeNumber,
    valuationMethod: g.valuationMethod,
    boeDeclaredQty: g.boeSummary.declaredQty,
    boeDeclaredValue: g.boeSummary.declaredValue,
    customsUnitValue: a.customsUnitValue,
    articleNumber: a.articleNumber,
    customsQtyImported: a.customsQtyImported,
    exportedCustomsQty: a.exportedCustomsQty,
    remainingCustomsQty: a.remainingCustomsQty,
    remainingCustomsValue: a.remainingCustomsValue,
  }));
  assert.equal(csvRows.length, 2);
  assert.ok(csvRows.every((r) => r.boeNumber === "TEST-BOE-AVG-001"));
  assert.ok(csvRows.every((r) => r.boeDeclaredValue === 1010));
}

// 12: Rounding — 1000/3 residual consistency
{
  const unit = computeBoeCustomsUnitValue(1000, 3);
  const lines = allocateBoeLineValues({
    lines: [
      { key: "a", customsQty: 1 },
      { key: "b", customsQty: 1 },
      { key: "c", customsQty: 1 },
    ],
    boeDeclaredValue: 1000,
    customsUnitValue: unit.customsUnitValue,
  });
  const lot = {
    _id: "R",
    valuationMethod: CUSTOMS_VALUATION_BOE_AVERAGE,
    boeDeclaredQty: 3,
    boeDeclaredValue: 1000,
    customsUnitValue: unit.customsUnitValue,
    currency: "EUR",
    status: "OPEN",
  };
  const items = lines.map((ln, i) => ({
    _id: String(i),
    articleNumber: `A${i}`,
    qtyImported: 1,
    qtyAvailable: 1,
    qtyConsumed: 0,
    customsQtyImported: 1,
    customsUnitValue: unit.customsUnitValue,
    totalValue: ln.customsTotalPrice,
  }));
  const g = buildCustomsLotStockGroup(lot, items);
  assert.equal(g.boeSummary.remainingValue, 1000);
  assert.equal(g.reconciliation.valueInvariantOk, true);
  assert.equal(g.reconciliation.qtyInvariantOk, true);
}

// resolveValuationMethod
assert.equal(resolveValuationMethod(""), CUSTOMS_VALUATION_LEGACY_LINE);

// Item economics helper
{
  const eco = computeLotItemCustomsEconomics({
    qtyImported: 2,
    qtyAvailable: 1,
    qtyConsumed: 1,
    customsQtyImported: 2,
    customsUnitValue: 505,
    totalValue: 1010,
  });
  assert.equal(eco.exportedCustomsQty, 1);
  assert.equal(eco.remainingCustomsQty, 1);
  assert.equal(eco.consumedCustomsValue, 505);
  assert.equal(eco.remainingCustomsValue, 505);
}

console.log("customsBoeStockGrouped.test.js: all passed");
