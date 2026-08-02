/**
 * GRN CSV Customs template / import mapping tests (no Mongo).
 */
import assert from "assert";
import {
  GRN_CSV_CUSTOMS_HEADERS,
  GRN_CSV_LEGACY_HEADERS,
  customsOverrideToLineEditFields,
  detectGrnCsvFormat,
  grnCsvTemplateHeaderLine,
  mapCsvRowToCustomsOverride,
  normalizeCsvHeaderKey,
  parseGrnCsvText,
  readGrnQtyFromCsvRow,
  suggestHeaderDefaultsFromOverrides,
} from "../src/utils/grnCsvImport.js";
import {
  normalizeCustomsLineOverride,
  resolveCustomsLineEffective,
} from "../src/utils/customsGrnFieldModel.js";

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

console.log("GRN CSV Customs template / import");

run("Export template has exact canonical columns in order", () => {
  const line = grnCsvTemplateHeaderLine().trim();
  assert.strictEqual(line, GRN_CSV_CUSTOMS_HEADERS.join(","));
  const expected = [
    "poLineId",
    "Article",
    "Description",
    "SPN",
    "UOM",
    "GRN Qty",
    "Location",
    "Remarks",
    "BOE Number",
    "BOE Date",
    "AWB No. / BL No.",
    "Received Date",
    "Supplier Invoice No.",
    "Supplier Invoice Date",
    "Country Of Origin",
    "HS Code",
    "Unit Weight",
    "Weight",
    "Customs Unit Price",
    "Total Price",
    "Currency",
    "Exchange Rate",
    "AED Value",
  ];
  assert.deepStrictEqual([...GRN_CSV_CUSTOMS_HEADERS], expected);
});

run("Detect customs vs legacy format", () => {
  assert.strictEqual(
    detectGrnCsvFormat(GRN_CSV_CUSTOMS_HEADERS.map(normalizeCsvHeaderKey)),
    "customs"
  );
  assert.strictEqual(
    detectGrnCsvFormat(GRN_CSV_LEGACY_HEADERS.map(normalizeCsvHeaderKey)),
    "legacy"
  );
});

run("Parse customs CSV and auto-calculate Weight / Total Price / AED Value", () => {
  const csv = `${GRN_CSV_CUSTOMS_HEADERS.join(",")}
abc123,ART-1,Desc,SPN1,PCS,10,BIN-A,note,BOE1,2026-01-15,AWB99,2026-01-20,SI-1,2026-01-18,CN,8501.10,2.5,,12.5,,USD,3.67,
`;
  const { rows, format } = parseGrnCsvText(csv);
  assert.strictEqual(format, "customs");
  assert.strictEqual(rows.length, 1);
  const qty = readGrnQtyFromCsvRow(rows[0]);
  assert.strictEqual(qty, 10);
  const { override, computed } = mapCsvRowToCustomsOverride(rows[0], qty);
  assert.strictEqual(override.boeNumber, "BOE1");
  assert.strictEqual(override.awbNumber, "AWB99");
  assert.strictEqual(override.blNumber, "AWB99");
  assert.strictEqual(override.hsCode, "8501.10");
  assert.strictEqual(override.unitWeightKg, 2.5);
  assert.strictEqual(computed.weight, 25);
  assert.strictEqual(override.totalWeightKg, 25);
  assert.strictEqual(override.customsUnitPrice, 12.5);
  assert.strictEqual(computed.totalPrice, 125);
  assert.strictEqual(override.customsTotalPrice, 125);
  assert.strictEqual(override.exchangeRateToAED, 3.67);
  assert.ok(Math.abs(computed.aedValue - 125 * 3.67) < 1e-9);
  assert.ok(Math.abs(override.customsValueAED - 125 * 3.67) < 1e-9);
});

run("Mapped override feeds existing customs field model resolution", () => {
  const csv = `${GRN_CSV_CUSTOMS_HEADERS.join(",")}
id1,A1,,S1,PCS,4,LOC1,,BOE9,2026-02-01,BL1,2026-02-05,INV9,2026-02-03,IN,8471,1,,100,,EUR,4,
`;
  const { rows } = parseGrnCsvText(csv);
  const { override } = mapCsvRowToCustomsOverride(rows[0], 4);
  const norm = normalizeCustomsLineOverride(override);
  const effective = resolveCustomsLineEffective({
    header: {},
    override: norm,
    quantity: 4,
  });
  assert.strictEqual(effective.boeNumber, "BOE9");
  assert.strictEqual(effective.customsCurrency, "EUR");
  assert.strictEqual(effective.customsUnitPrice, 100);
  assert.strictEqual(effective.customsTotalPrice, 400);
  assert.strictEqual(effective.customsValueAED, 1600);
  assert.strictEqual(effective.totalWeightKg, 4);
});

run("Legacy CSV still parses without customs mapping", () => {
  const csv = `${GRN_CSV_LEGACY_HEADERS.join(",")}
507f1f77bcf86cd799439011,ART,MC1,SPN,5,BIN-1,ok
`;
  const { rows, format } = parseGrnCsvText(csv);
  assert.strictEqual(format, "legacy");
  assert.strictEqual(readGrnQtyFromCsvRow(rows[0]), 5);
  assert.strictEqual(rows[0].location, "BIN-1");
  assert.strictEqual(rows[0].materialcode, "MC1");
});

run("Line edit field bridge covers UI customs keys", () => {
  const edits = customsOverrideToLineEditFields({
    boeNumber: "B1",
    hsCode: "1234",
    customsUnitPrice: 9,
    unitWeightKg: 1.2,
    exchangeRateToAED: 3.67,
    customsCurrency: "USD",
  });
  assert.strictEqual(edits.customsBoeNumber, "B1");
  assert.strictEqual(edits.customsHsCode, "1234");
  assert.strictEqual(edits.customsUnitPrice, "9");
  assert.strictEqual(edits.customsUnitWeightKg, "1.2");
  assert.strictEqual(edits.customsExchangeRateToAED, "3.67");
});

run("Header defaults suggested from first override", () => {
  const hd = suggestHeaderDefaultsFromOverrides([
    { boeNumber: "X", receivedDate: "2026-01-01", customsCurrency: "AED", exchangeRateToAED: 1 },
  ]);
  assert.strictEqual(hd.boeNumber, "X");
  assert.strictEqual(hd.customsCurrency, "AED");
});

run("Explicit Weight / Total Price / AED Value are preserved when provided", () => {
  const row = {
    unitweight: "2",
    weight: "30",
    customsunitprice: "10",
    totalprice: "999",
    exchangerate: "3",
    aedvalue: "50",
  };
  const { override } = mapCsvRowToCustomsOverride(row, 10);
  assert.strictEqual(override.totalWeightKg, 30);
  assert.strictEqual(override.customsTotalPrice, 999);
  assert.strictEqual(override.customsValueAED, 50);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
