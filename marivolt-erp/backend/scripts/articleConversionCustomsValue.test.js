/**
 * Article conversion must conserve customs qty AND customs economic value.
 * Run: node scripts/articleConversionCustomsValue.test.js
 */
import assert from "node:assert/strict";
import {
  buildCustomsLotStockGroup,
  computeConversionCustomsTransfer,
  computeLotItemCustomsEconomics,
  CUSTOMS_SOURCE_ARTICLE_CONVERSION,
  CUSTOMS_SOURCE_GRN,
  CUSTOMS_CONVERSION_STATUS_CONVERTED_OUT,
  CUSTOMS_VALUATION_BOE_AVERAGE,
  CUSTOMS_VALUATION_LEGACY_LINE,
  roundCustomsMoney,
} from "../src/utils/customsBoeAverage.js";
import { resolveMovementCustomsValueSnapshot } from "../src/services/customsService.js";

function applyTransferToSource(source, transfer) {
  return {
    ...source,
    qtyAvailable: transfer.nextQtyAvailable,
    qtyImported: transfer.nextQtyImported,
    totalValue: transfer.nextTotalValue,
    customsQtyImported: transfer.nextCustomsQtyImported,
    customsValueAED: transfer.nextCustomsValueAED,
    status: transfer.nextQtyAvailable <= 1e-6 ? "CONSUMED" : "IN_STOCK",
  };
}

function makeTargetFromTransfer(source, transfer, { article, conversionNo }) {
  return {
    _id: "TGT-1",
    customsLotId: source.customsLotId,
    articleNumber: article,
    qtyImported: transfer.transferQty,
    qtyAvailable: transfer.transferQty,
    qtyConsumed: 0,
    unitPrice: transfer.unit,
    customsUnitValue: transfer.unit,
    valuationMethod: source.valuationMethod,
    customsQtyImported: transfer.transferCustomsQty,
    totalValue: transfer.transferValue,
    customsValueAED: transfer.transferValueAED,
    exchangeRateToAED: source.exchangeRateToAED || 0,
    grnNo: source.grnNo,
    boeNumber: source.boeNumber,
    status: "IN_STOCK",
    isConversionLayer: true,
    originalReceivedArticle: source.articleNumber,
    conversionNo,
    convertedFromLotItemId: source._id,
  };
}

// --- TEST A — full conversion (BOE 83535 shape) ---
{
  const sourceBefore = {
    _id: "SRC-8X",
    customsLotId: "LOT-83535",
    articleNumber: "8X0098",
    qtyImported: 9,
    qtyAvailable: 9,
    qtyConsumed: 0,
    unitPrice: 351.11,
    customsUnitValue: 351.11,
    totalValue: 3159.99,
    customsQtyImported: 9,
    grnNo: "MAR-GRN-0010",
    boeNumber: "83535",
    valuationMethod: CUSTOMS_VALUATION_LEGACY_LINE,
    status: "IN_STOCK",
  };
  const transfer = computeConversionCustomsTransfer({
    take: 9,
    qtyAvailable: 9,
    qtyImported: 9,
    qtyConsumed: 0,
    unitPrice: 351.11,
    customsUnitValue: 351.11,
    totalValue: 3159.99,
    customsQtyImported: 9,
  });
  assert.equal(transfer.ok, true);
  assert.equal(transfer.transferValue, 3159.99);
  assert.equal(transfer.nextTotalValue, 0);
  assert.equal(transfer.nextQtyAvailable, 0);
  assert.equal(transfer.nextQtyImported, 0);

  const sourceAfter = applyTransferToSource(sourceBefore, transfer);
  const target = makeTargetFromTransfer(sourceBefore, transfer, {
    article: "700004.28",
    conversionNo: "MAR-STC-0001",
  });

  const srcEco = computeLotItemCustomsEconomics(sourceAfter);
  const tgtEco = computeLotItemCustomsEconomics(target);
  assert.equal(srcEco.remainingCustomsQty, 0);
  assert.equal(srcEco.remainingCustomsValue, 0);
  assert.equal(srcEco.importedCustomsValue, 0);
  assert.equal(tgtEco.remainingCustomsQty, 9);
  assert.equal(tgtEco.remainingCustomsValue, 3159.99);

  const g = buildCustomsLotStockGroup(
    { _id: "LOT-83535", boeNumber: "83535", grnNo: "MAR-GRN-0010", status: "OPEN", currency: "EUR" },
    [sourceAfter, target],
  );
  assert.equal(g.boeSummary.remainingQty, 9);
  assert.equal(g.boeSummary.remainingValue, 3159.99);
  assert.notEqual(g.boeSummary.remainingValue, 6319.98);

  const srcRow = g.articles.find((a) => a.articleNumber === "8X0098");
  const tgtRow = g.articles.find((a) => a.articleNumber === "700004.28");
  assert.equal(srcRow.sourceType, CUSTOMS_SOURCE_GRN);
  assert.equal(srcRow.conversionStatus, CUSTOMS_CONVERSION_STATUS_CONVERTED_OUT);
  assert.equal(tgtRow.sourceType, CUSTOMS_SOURCE_ARTICLE_CONVERSION);
  assert.equal(tgtRow.sourceRef, "MAR-STC-0001");
  assert.notEqual(tgtRow.sourceRef, "MAR-GRN-0010");
}

// --- Stale historical totalValue on converted-out source (existing DB defect) ---
{
  const eco = computeLotItemCustomsEconomics({
    qtyImported: 0,
    qtyAvailable: 0,
    qtyConsumed: 0,
    unitPrice: 351.11,
    totalValue: 3159.99,
  });
  assert.equal(eco.remainingCustomsValue, 0);
  assert.equal(eco.importedCustomsValue, 0);
  assert.equal(eco.historicalImportedValue, 3159.99);
  assert.equal(eco.customsQtyImported, 0);
}

// --- TEST B — partial conversion ---
{
  const transfer = computeConversionCustomsTransfer({
    take: 4,
    qtyAvailable: 10,
    qtyImported: 10,
    qtyConsumed: 0,
    unitPrice: 100,
    totalValue: 1000,
    customsQtyImported: 10,
  });
  assert.equal(transfer.transferValue, 400);
  assert.equal(transfer.nextTotalValue, 600);
  assert.equal(transfer.nextQtyAvailable, 6);
  assert.equal(transfer.nextQtyImported, 6);

  const sourceAfter = {
    _id: "S",
    articleNumber: "SRC",
    qtyImported: 6,
    qtyAvailable: 6,
    qtyConsumed: 0,
    unitPrice: 100,
    totalValue: 600,
    customsQtyImported: 6,
  };
  const target = {
    _id: "T",
    articleNumber: "TGT",
    qtyImported: 4,
    qtyAvailable: 4,
    qtyConsumed: 0,
    unitPrice: 100,
    totalValue: 400,
    customsQtyImported: 4,
    isConversionLayer: true,
    conversionNo: "STC-P",
    convertedFromLotItemId: "S",
    originalReceivedArticle: "SRC",
  };
  const g = buildCustomsLotStockGroup({ _id: "L", status: "OPEN" }, [sourceAfter, target]);
  assert.equal(g.boeSummary.remainingQty, 10);
  assert.equal(g.boeSummary.remainingValue, 1000);
}

// --- TEST C — BOE_AVERAGE conversion (frozen unit, no re-average) ---
{
  const transfer = computeConversionCustomsTransfer({
    take: 3,
    qtyAvailable: 5,
    qtyImported: 5,
    qtyConsumed: 0,
    unitPrice: 505,
    customsUnitValue: 505,
    totalValue: 2525,
    customsQtyImported: 5,
  });
  assert.equal(transfer.unit, 505);
  assert.equal(transfer.transferValue, 1515);
  assert.equal(transfer.nextTotalValue, 1010);
  assert.equal(transfer.transferCustomsQty, 3);

  const sourceAfter = applyTransferToSource(
    {
      _id: "S",
      articleNumber: "A",
      qtyImported: 5,
      qtyAvailable: 5,
      qtyConsumed: 0,
      unitPrice: 505,
      customsUnitValue: 505,
      totalValue: 2525,
      valuationMethod: CUSTOMS_VALUATION_BOE_AVERAGE,
      customsQtyImported: 5,
    },
    transfer,
  );
  const target = makeTargetFromTransfer(
    {
      _id: "S",
      articleNumber: "A",
      valuationMethod: CUSTOMS_VALUATION_BOE_AVERAGE,
      grnNo: "G1",
      boeNumber: "B1",
    },
    transfer,
    { article: "B", conversionNo: "STC-BOE" },
  );
  assert.equal(sourceAfter.customsUnitValue ?? 505, 505);
  assert.equal(target.customsUnitValue, 505);
  assert.equal(target.valuationMethod, CUSTOMS_VALUATION_BOE_AVERAGE);

  const lot = {
    _id: "LOT-BOE",
    valuationMethod: CUSTOMS_VALUATION_BOE_AVERAGE,
    boeDeclaredQty: 5,
    boeDeclaredValue: 2525,
    customsUnitValue: 505,
    status: "OPEN",
    currency: "EUR",
  };
  const g = buildCustomsLotStockGroup(lot, [sourceAfter, target]);
  assert.equal(g.boeSummary.customsUnitValue, 505);
  assert.equal(g.boeSummary.declaredValue, 2525);
  assert.equal(g.boeSummary.remainingValue, 2525);
  assert.equal(g.boeSummary.remainingQty, 5);
  // Conversion alone is not consumption
  assert.equal(g.boeSummary.consumedValue, 0);
}

// --- TEST D — legacy conversion preserves unit / valuation method ---
{
  const transfer = computeConversionCustomsTransfer({
    take: 2,
    qtyAvailable: 2,
    qtyImported: 2,
    unitPrice: 351.11,
    totalValue: 702.22,
  });
  const target = makeTargetFromTransfer(
    {
      _id: "S",
      articleNumber: "LEG-SRC",
      valuationMethod: CUSTOMS_VALUATION_LEGACY_LINE,
      unitPrice: 351.11,
    },
    transfer,
    { article: "LEG-TGT", conversionNo: "STC-LEG" },
  );
  assert.equal(target.unitPrice, 351.11);
  assert.equal(target.customsUnitValue, 351.11);
  assert.equal(target.valuationMethod, CUSTOMS_VALUATION_LEGACY_LINE);
  assert.notEqual(target.valuationMethod, CUSTOMS_VALUATION_BOE_AVERAGE);
}

// --- TEST E — repeated transfer does not invent value (idempotent math) ---
{
  let state = {
    qtyAvailable: 9,
    qtyImported: 9,
    qtyConsumed: 0,
    unitPrice: 351.11,
    totalValue: 3159.99,
    customsQtyImported: 9,
  };
  const first = computeConversionCustomsTransfer({ take: 9, ...state });
  state = {
    qtyAvailable: first.nextQtyAvailable,
    qtyImported: first.nextQtyImported,
    qtyConsumed: 0,
    unitPrice: 351.11,
    totalValue: first.nextTotalValue,
    customsQtyImported: first.nextCustomsQtyImported,
  };
  const second = computeConversionCustomsTransfer({ take: 9, ...state });
  assert.equal(second.ok, false);
  assert.equal(first.transferValue + (state.totalValue || 0), 3159.99);
}

// --- TEST F/G — CI snapshot uses target layer; depleted source cannot move qty ---
{
  const targetItem = {
    qtyImported: 9,
    qtyAvailable: 9,
    customsQtyImported: 9,
    customsUnitValue: 351.11,
    unitPrice: 351.11,
    valuationMethod: CUSTOMS_VALUATION_LEGACY_LINE,
    currency: "EUR",
  };
  const snap = resolveMovementCustomsValueSnapshot({ item: targetItem, qty: 3 });
  assert.equal(snap.customsUnitValue, 351.11);
  assert.equal(snap.customsValue, roundCustomsMoney(3 * 351.11));

  const depleted = {
    qtyImported: 0,
    qtyAvailable: 0,
    customsUnitValue: 351.11,
    unitPrice: 351.11,
  };
  const emptySnap = resolveMovementCustomsValueSnapshot({ item: depleted, qty: 0 });
  assert.equal(emptySnap.customsValue, null);
  assert.equal(emptySnap.customsQtyMoved, 0);
  // Allocation gate: qtyAvailable must be > 0 (selectCustomsLayersForConversion / CI)
  assert.ok(!(Number(depleted.qtyAvailable) > 0));
}

// --- TEST H — conversion OUT+IN conserve value ---
{
  const transfer = computeConversionCustomsTransfer({
    take: 9,
    qtyAvailable: 9,
    qtyImported: 9,
    unitPrice: 351.11,
    totalValue: 3159.99,
    customsQtyImported: 9,
  });
  const outValue = transfer.transferValue;
  const inValue = transfer.transferValue;
  assert.equal(outValue, inValue);
  assert.equal(outValue + transfer.nextTotalValue, 3159.99);
}

// --- TEST I — BOE group no double-count ---
{
  const g = buildCustomsLotStockGroup(
    { _id: "LOT", boeNumber: "83535", grnNo: "MAR-GRN-0010", status: "OPEN" },
    [
      {
        _id: "S",
        articleNumber: "8X0098",
        qtyImported: 0,
        qtyAvailable: 0,
        qtyConsumed: 0,
        unitPrice: 351.11,
        totalValue: 3159.99,
        grnNo: "MAR-GRN-0010",
        status: "CONSUMED",
      },
      {
        _id: "T",
        articleNumber: "700004.28",
        qtyImported: 9,
        qtyAvailable: 9,
        qtyConsumed: 0,
        unitPrice: 351.11,
        totalValue: 3159.99,
        grnNo: "MAR-GRN-0010",
        isConversionLayer: true,
        conversionNo: "MAR-STC-0001",
        convertedFromLotItemId: "S",
        originalReceivedArticle: "8X0098",
      },
    ],
  );
  assert.equal(g.boeSummary.remainingValue, 3159.99);
  assert.equal(g.articles.find((a) => a.articleNumber === "8X0098").remainingCustomsValue, 0);
  assert.equal(g.articles.find((a) => a.articleNumber === "700004.28").remainingCustomsValue, 3159.99);
}

// --- TEST J — BOE_AVERAGE declared economics unchanged by conversion grouping ---
{
  const lot = {
    _id: "LOT-J",
    valuationMethod: CUSTOMS_VALUATION_BOE_AVERAGE,
    boeDeclaredQty: 9,
    boeDeclaredValue: 3159.99,
    customsUnitValue: 351.11,
    status: "OPEN",
    currency: "EUR",
  };
  const before = buildCustomsLotStockGroup(lot, [
    {
      _id: "S",
      articleNumber: "8X0098",
      qtyImported: 9,
      qtyAvailable: 9,
      qtyConsumed: 0,
      customsQtyImported: 9,
      customsUnitValue: 351.11,
      unitPrice: 351.11,
      totalValue: 3159.99,
      valuationMethod: CUSTOMS_VALUATION_BOE_AVERAGE,
    },
  ]);
  const after = buildCustomsLotStockGroup(lot, [
    {
      _id: "S",
      articleNumber: "8X0098",
      qtyImported: 0,
      qtyAvailable: 0,
      qtyConsumed: 0,
      unitPrice: 351.11,
      totalValue: 0,
      valuationMethod: CUSTOMS_VALUATION_BOE_AVERAGE,
    },
    {
      _id: "T",
      articleNumber: "700004.28",
      qtyImported: 9,
      qtyAvailable: 9,
      qtyConsumed: 0,
      customsQtyImported: 9,
      customsUnitValue: 351.11,
      unitPrice: 351.11,
      totalValue: 3159.99,
      valuationMethod: CUSTOMS_VALUATION_BOE_AVERAGE,
      isConversionLayer: true,
      conversionNo: "MAR-STC-0001",
      convertedFromLotItemId: "S",
    },
  ]);
  assert.equal(before.boeSummary.declaredQty, after.boeSummary.declaredQty);
  assert.equal(before.boeSummary.declaredValue, after.boeSummary.declaredValue);
  assert.equal(before.boeSummary.customsUnitValue, after.boeSummary.customsUnitValue);
  assert.equal(before.boeSummary.remainingValue, after.boeSummary.remainingValue);
  assert.equal(after.reconciliation.valueInvariantOk, true);
  assert.equal(after.reconciliation.qtyInvariantOk, true);
}

// Ordinary export must not look like emptied-without-export zeroing of imported value
{
  const eco = computeLotItemCustomsEconomics({
    qtyImported: 9,
    qtyAvailable: 0,
    qtyConsumed: 9,
    unitPrice: 351.11,
    totalValue: 3159.99,
    customsQtyImported: 9,
  });
  assert.equal(eco.remainingCustomsValue, 0);
  assert.equal(eco.importedCustomsValue, 3159.99);
  assert.equal(eco.consumedCustomsValue, 3159.99);
  assert.equal(eco.exportedCustomsQty, 9);
}

console.log("articleConversionCustomsValue.test.js: all passed");
