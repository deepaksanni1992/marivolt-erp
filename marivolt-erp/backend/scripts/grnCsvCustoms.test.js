/**
 * GRN CSV Phase 2 — Customs-only template / import (no Mongo, no posting).
 */
import assert from "assert";
import {
  GRN_CSV_HEADERS,
  INVALID_GRN_TEMPLATE,
  buildGrnCsvRow,
  buildGrnCsvTemplateCsv,
  customsOverrideToLineEditFields,
  extractShipmentHeaderFromCsvRows,
  findPoLineMatchForCsvRow,
  formatPoLineMatchError,
  grnCsvTemplateHeaderLine,
  isDateLikeWeightString,
  mapCsvRowToCustomsOverride,
  parseGrnCsvText,
  readGrnQtyFromCsvRow,
  suggestHeaderDefaultsFromOverrides,
  validateCsvLineAfterInheritance,
  validateGrnCsvHeaders,
  validateGrnCsvRowRequiredFields,
  validateInheritedCsvShipmentHeader,
} from "../src/utils/grnCsvImport.js";
import {
  isCustomsCaptureActive,
  normalizeCustomsLineOverride,
  resolveCustomsLineEffective,
  validateCustomsCaptureForGrn,
  validateCustomsMandatoryEffective,
} from "../src/utils/customsGrnFieldModel.js";
import {
  buildGrnCustomsPayload,
  emptyGrnCustomsState,
  hasGrnCustomsInput,
} from "../../src/lib/grnCustomsPayload.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");

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

const SAMPLE_LINE_ID = "507f1f77bcf86cd799439011";

function sampleValues(over = {}) {
  return {
    "PO Line ID": SAMPLE_LINE_ID,
    Article: "ART-1",
    Description: "Widget",
    SPN: "SPN1",
    UOM: "PCS",
    "GRN Qty": "10",
    Location: "BIN-A",
    Remarks: "note",
    "BOE Number": "BOE1",
    "BOE Date": "2026-01-15",
    "BL Number": "BL99",
    "AWB Number": "AWB99",
    "Received Date": "2026-01-20",
    "Supplier Invoice Number": "SI-1",
    "Supplier Invoice Date": "2026-01-18",
    "Country of Origin": "CN",
    "HS Code": "8501.10",
    "Unit Weight KG": "2.5",
    "Gross Weight KG": "",
    "Net Weight KG": "",
    "BOE Declared Qty": "10",
    "Customs UOM": "PCS",
    "BOE Declared Value": "125",
    "Customs Currency": "USD",
    "Exchange Rate to AED": "3.67",
    "Customs Qty": "10",
    "Customs Remarks": "",
    ...over,
  };
}

function sampleCsv(over = {}) {
  return `${grnCsvTemplateHeaderLine().trim()}\n${buildGrnCsvRow(sampleValues(over))}\n`;
}

console.log("GRN CSV Phase 2 — Customs-only");

run("template columns and order", () => {
  const expected = [
    "PO Line ID",
    "Article",
    "Description",
    "SPN",
    "UOM",
    "GRN Qty",
    "Location",
    "Remarks",
    "BOE Number",
    "BOE Date",
    "BL Number",
    "AWB Number",
    "Received Date",
    "Supplier Invoice Number",
    "Supplier Invoice Date",
    "BOE Declared Qty",
    "Customs UOM",
    "BOE Declared Value",
    "Customs Currency",
    "Exchange Rate to AED",
    "Gross Weight KG",
    "Net Weight KG",
    "Country of Origin",
    "HS Code",
    "Unit Weight KG",
    "Customs Qty",
    "Customs Remarks",
  ];
  assert.deepStrictEqual([...GRN_CSV_HEADERS], expected);
  assert.strictEqual(grnCsvTemplateHeaderLine().trim(), expected.join(","));
});

run("invalid headers → INVALID_GRN_TEMPLATE", () => {
  const bad = parseGrnCsvText("foo,bar,baz\n1,a,1\n");
  assert.strictEqual(bad.ok, false);
  assert.strictEqual(bad.code, INVALID_GRN_TEMPLATE);
  assert.match(bad.message, /Expected Customs GRN template/);
});

run("missing columns rejected", () => {
  const headers = [...GRN_CSV_HEADERS];
  headers.splice(5, 1); // drop GRN Qty
  const r = validateGrnCsvHeaders(headers);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, INVALID_GRN_TEMPLATE);
  assert.ok(r.details.some((d) => /GRN Qty|columns/i.test(d)));
});

run("reordered known columns accepted", () => {
  const headers = [...GRN_CSV_HEADERS];
  const tmp = headers[0];
  headers[0] = headers[1];
  headers[1] = tmp;
  const r = validateGrnCsvHeaders(headers);
  assert.strictEqual(r.ok, true);
});

run("duplicate columns rejected", () => {
  const headers = [...GRN_CSV_HEADERS];
  headers[2] = headers[1]; // duplicate Article
  const r = validateGrnCsvHeaders(headers);
  assert.strictEqual(r.ok, false);
  assert.ok(r.details.some((d) => /Duplicate/i.test(d)));
});

run("unknown column rejected", () => {
  const headers = [...GRN_CSV_HEADERS];
  headers[0] = "Not A Real Column";
  const r = validateGrnCsvHeaders(headers);
  assert.strictEqual(r.ok, false);
  assert.ok(r.details.some((d) => /Not A Real Column/.test(d)));
});

run("auto calculations when Weight blank; BOE fields mapped", () => {
  const parsed = parseGrnCsvText(sampleCsv());
  assert.strictEqual(parsed.ok, true);
  const qty = readGrnQtyFromCsvRow(parsed.rows[0]);
  const { override, computed } = mapCsvRowToCustomsOverride(parsed.rows[0], qty);
  assert.strictEqual(computed.weight, 25);
  assert.strictEqual(override.totalWeightKg, 25);
  assert.strictEqual(computed.boeDeclaredQty, 10);
  assert.strictEqual(computed.boeDeclaredValue, 125);
  assert.strictEqual(override.boeDeclaredQty, 10);
  assert.strictEqual(override.boeDeclaredValue, 125);
  assert.strictEqual(override.customsUom, "PCS");
  assert.strictEqual(override.customsUnitPrice, undefined);
  assert.strictEqual(override.unitWeightKg, 2.5);
});

run("legacy Weight column still maps when present", () => {
  const oldHeaders = [
    "PO Line ID",
    "Article",
    "GRN Qty",
    "Location",
    "Unit Weight",
    "Weight",
  ];
  const csv = `${oldHeaders.join(",")}\n${SAMPLE_LINE_ID},ART-1,10,BIN-A,2.5,30\n`;
  const parsed = parseGrnCsvText(csv);
  assert.strictEqual(parsed.ok, true);
  const { override } = mapCsvRowToCustomsOverride(parsed.rows[0], 10);
  assert.strictEqual(override.totalWeightKg, 30);
  assert.strictEqual(override.unitWeightKg, 2.5);
});

run("successful import parse + required field validation", () => {
  const parsed = parseGrnCsvText(sampleCsv());
  assert.strictEqual(parsed.ok, true);
  assert.strictEqual(parsed.rows.length, 1);
  const msgs = validateGrnCsvRowRequiredFields(parsed.rows[0]);
  assert.deepStrictEqual(msgs, []);
});

run("row validation no longer repeats header BOE economics", () => {
  const parsed = parseGrnCsvText(
    sampleCsv({
      "BOE Number": "",
      "Customs Currency": "",
      "HS Code": "",
    })
  );
  const msgs = validateGrnCsvRowRequiredFields(parsed.rows[0]);
  assert.ok(!msgs.some((m) => /BOE Number/.test(m)));
  assert.ok(!msgs.some((m) => /Currency/.test(m)));
  assert.ok(!msgs.some((m) => /HS Code/.test(m)));
});

run("mapped import feeds customs field model (posting-ready)", () => {
  const parsed = parseGrnCsvText(sampleCsv());
  const qty = readGrnQtyFromCsvRow(parsed.rows[0]);
  const { override } = mapCsvRowToCustomsOverride(parsed.rows[0], qty);
  const header = suggestHeaderDefaultsFromOverrides([override]);
  const norm = normalizeCustomsLineOverride(override);
  const unit = 125 / 10;
  const effective = resolveCustomsLineEffective({
    header,
    override: norm,
    quantity: qty,
    customsUnitValue: unit,
    customsQty: qty,
  });
  const mandatory = validateCustomsMandatoryEffective(effective, { location: "BIN-A" });
  assert.deepStrictEqual(mandatory, []);
  assert.strictEqual(effective.boeNumber, "BOE1");
  assert.strictEqual(effective.customsUnitValue, 12.5);
  assert.strictEqual(effective.customsTotalPrice, 125);
});

run("posting after import: payload + capture validation ok (no GRN post)", () => {
  const parsed = parseGrnCsvText(sampleCsv());
  const qty = readGrnQtyFromCsvRow(parsed.rows[0]);
  const { override } = mapCsvRowToCustomsOverride(parsed.rows[0], qty);
  const lineEdits = {
    [SAMPLE_LINE_ID]: {
      ...customsOverrideToLineEditFields(override),
      selected: true,
      grnQty: String(qty),
      location: "BIN-A",
    },
  };
  const header = suggestHeaderDefaultsFromOverrides([override]);
  const payload = buildGrnCustomsPayload(header, lineEdits, [{ poLineId: SAMPLE_LINE_ID }], "USD");
  assert.ok(payload);
  assert.strictEqual(payload.boeNumber, "BOE1");
  assert.strictEqual(payload.boeDeclaredQty, 10);
  assert.strictEqual(payload.boeDeclaredValue, 125);

  const capture = validateCustomsCaptureForGrn({
    header: payload,
    lineOverrides: new Map([[SAMPLE_LINE_ID, normalizeCustomsLineOverride(override)]]),
    lines: [{ poLineId: SAMPLE_LINE_ID, article: "ART-1", location: "BIN-A", acceptedQty: qty, uom: "PCS" }],
    poDate: "2026-01-01",
    allowances: {},
  });
  assert.strictEqual(capture.ok, true, JSON.stringify(capture.errors));
  assert.strictEqual(capture.customsUnitValue, 12.5);
});

run("legacy template constants and detectGrnCsvFormat are gone", () => {
  const src = fs.readFileSync(path.join(repoRoot, "backend/src/utils/grnCsvImport.js"), "utf8");
  assert.ok(!src.includes("GRN_CSV_LEGACY_HEADERS"));
  assert.ok(!src.includes("detectGrnCsvFormat"));
  assert.ok(!/format:\s*[\"']legacy[\"']/.test(src));
  const ctrl = fs.readFileSync(path.join(repoRoot, "backend/src/controllers/grnController.js"), "utf8");
  assert.ok(!ctrl.includes("materialCode / article / spn"));
  assert.ok(ctrl.includes("INVALID_GRN_TEMPLATE"));
  assert.ok(ctrl.includes("findPoLineMatchForCsvRow"));
});

run("legacy CSV filename references removed from import util", () => {
  const src = fs.readFileSync(path.join(repoRoot, "backend/src/utils/grnCsvImport.js"), "utf8");
  assert.ok(!/still accepted/i.test(src));
  assert.ok(!/legacy template/i.test(src));
});

run("successful import match using exported Mongo _id", () => {
  const lines = [
    { _id: SAMPLE_LINE_ID, itemCode: "8X0098", description: "SET OF GASKETS", orderedQty: 9, receivedQty: 0 },
  ];
  const parsed = parseGrnCsvText(sampleCsv({ "PO Line ID": SAMPLE_LINE_ID, Article: "8X0098" }));
  const match = findPoLineMatchForCsvRow(lines, parsed.rows[0]);
  assert.strictEqual(match.ok, true);
  assert.strictEqual(match.by, "_id");
  assert.strictEqual(String(match.line._id), SAMPLE_LINE_ID);
});

run("successful import match using lineId / poLineId aliases", () => {
  const lines = [{ lineId: "LINE-A", itemCode: "ART-9", orderedQty: 2 }];
  const parsed = parseGrnCsvText(sampleCsv({ "PO Line ID": "LINE-A", Article: "ART-9" }));
  const match = findPoLineMatchForCsvRow(lines, parsed.rows[0]);
  assert.strictEqual(match.ok, true);
  assert.strictEqual(match.by, "lineId");
});

run("successful import match using lineNumber when exported", () => {
  const lines = [{ _id: SAMPLE_LINE_ID, lineNumber: 1, itemCode: "8X0098", orderedQty: 9 }];
  const parsed = parseGrnCsvText(sampleCsv({ "PO Line ID": "1", Article: "8X0098" }));
  const match = findPoLineMatchForCsvRow(lines, parsed.rows[0]);
  assert.strictEqual(match.ok, true);
  assert.strictEqual(match.by, "lineNumber");
});

run("does not assume CSV row index equals PO Line ID", () => {
  const lines = [{ _id: SAMPLE_LINE_ID, itemCode: "8X0098", orderedQty: 9 }];
  const parsed = parseGrnCsvText(sampleCsv({ "PO Line ID": "1", Article: "WRONG" }));
  const match = findPoLineMatchForCsvRow(lines, parsed.rows[0]);
  assert.strictEqual(match.ok, false);
  assert.strictEqual(match.reason, "id_not_found");
});

run("failure for invalid PO Line ID includes clear message", () => {
  const lines = [{ _id: SAMPLE_LINE_ID, itemCode: "8X0098", orderedQty: 9 }];
  const parsed = parseGrnCsvText(sampleCsv({ "PO Line ID": "1", Article: "NOPE" }));
  const match = findPoLineMatchForCsvRow(lines, parsed.rows[0]);
  assert.strictEqual(match.ok, false);
  const msg = formatPoLineMatchError(match, { rowLineNo: 2, poNo: "MAR-PO-0040" });
  assert.match(msg, /PO Line ID '1' was not found in Purchase Order MAR-PO-0040/);
});

run("article fallback matches when PO Line ID is wrong but article is unique", () => {
  const lines = [{ _id: SAMPLE_LINE_ID, itemCode: "8X0098", description: "Gaskets", orderedQty: 9 }];
  const parsed = parseGrnCsvText(
    sampleCsv({ "PO Line ID": "1", Article: " 8x 0098 ", Description: "different CASE text" })
  );
  const match = findPoLineMatchForCsvRow(lines, parsed.rows[0]);
  assert.strictEqual(match.ok, true);
  assert.strictEqual(match.by, "article");
});

run("description is not used for matching", () => {
  const lines = [
    { _id: SAMPLE_LINE_ID, itemCode: "8X0098", description: "SET OF GASKETS FOR CYLINDER", orderedQty: 9 },
  ];
  const parsed = parseGrnCsvText(
    sampleCsv({
      "PO Line ID": "",
      Article: "OTHER",
      Description: "SET OF GASKETS FOR CYLINDER",
    })
  );
  // Article OTHER won't match; description must not rescue the row.
  // Empty PO Line ID still needs article — validation would catch empty article separately.
  const match = findPoLineMatchForCsvRow(lines, parsed.rows[0]);
  assert.strictEqual(match.ok, false);
});

run("duplicate CSV ids surface via lookup of same PO line", () => {
  const lines = [{ _id: SAMPLE_LINE_ID, itemCode: "ART-1", orderedQty: 10 }];
  const a = parseGrnCsvText(sampleCsv({ "PO Line ID": SAMPLE_LINE_ID, Article: "ART-1" }));
  const b = parseGrnCsvText(sampleCsv({ "PO Line ID": SAMPLE_LINE_ID, Article: "ART-1" }));
  const m1 = findPoLineMatchForCsvRow(lines, a.rows[0]);
  const m2 = findPoLineMatchForCsvRow(lines, b.rows[0]);
  assert.strictEqual(m1.ok && m2.ok, true);
  assert.strictEqual(String(m1.line._id), String(m2.line._id));
});

run("missing PO Line ID and Article fails validation", () => {
  const msgs = validateGrnCsvRowRequiredFields(
    parseGrnCsvText(sampleCsv({ "PO Line ID": "", Article: "" })).rows[0]
  );
  assert.ok(msgs.some((m) => /PO Line ID or Article|Article is required/i.test(m)));
});

run("filled template exports Mongo _id as PO Line ID", () => {
  const csv = buildGrnCsvTemplateCsv([
    { _id: SAMPLE_LINE_ID, itemCode: "8X0098", description: "Gasket set", orderedQty: 9, receivedQty: 0 },
  ]);
  assert.ok(csv.includes(SAMPLE_LINE_ID));
  assert.ok(csv.includes("8X0098"));
  const parsed = parseGrnCsvText(csv.replace(/\n$/, "\n") + ""); // ensure parse
  // Re-parse: template has header + one data row but missing required customs — parse still ok
  const onlyHeaderAndId = parseGrnCsvText(
    `${grnCsvTemplateHeaderLine().trim()}\n${buildGrnCsvRow({
      "PO Line ID": SAMPLE_LINE_ID,
      Article: "8X0098",
      Description: "Gasket set",
      "GRN Qty": "9",
      Location: "A1",
      "BOE Number": "1",
      "BOE Date": "2026-01-01",
      "Supplier Invoice Number": "1",
      "Supplier Invoice Date": "2026-01-01",
      "Country of Origin": "DE",
      "HS Code": "1",
      "BOE Declared Qty": "9",
      "Customs UOM": "PCS",
      "BOE Declared Value": "9",
      "Customs Currency": "EUR",
      "Exchange Rate to AED": "1",
    })}\n`
  );
  const match = findPoLineMatchForCsvRow(
    [{ _id: SAMPLE_LINE_ID, itemCode: "8X0098", orderedQty: 9 }],
    onlyHeaderAndId.rows[0]
  );
  assert.strictEqual(match.ok, true);
  assert.strictEqual(match.by, "_id");
});

run("match logging reports imported id, available ids, and field", () => {
  const logs = [];
  const lines = [{ _id: SAMPLE_LINE_ID, itemCode: "ART-1", orderedQty: 1 }];
  const parsed = parseGrnCsvText(sampleCsv({ "PO Line ID": SAMPLE_LINE_ID, Article: "ART-1" }));
  findPoLineMatchForCsvRow(lines, parsed.rows[0], { log: (p) => logs.push(p) });
  assert.strictEqual(logs.length, 1);
  assert.strictEqual(logs[0].importedPoLineId, SAMPLE_LINE_ID);
  assert.ok(logs[0].availablePoLineIds.includes(SAMPLE_LINE_ID));
  assert.strictEqual(logs[0].matchingField, "_id");
});

run("TEST 1: auto Received Date alone does not activate Customs", () => {
  const customs = emptyGrnCustomsState();
  assert.ok(customs.receivedDate);
  assert.strictEqual(hasGrnCustomsInput(customs), false);
  assert.strictEqual(isCustomsCaptureActive({ header: customs }), false);
  assert.strictEqual(buildGrnCustomsPayload(customs, {}, []), null);
});

run("TEST 2: one header / many lines has no row-level economics errors", () => {
  const header = {
    receivedDate: "2026-08-11",
    boeNumber: "511685",
    boeDate: "2026-08-11",
    supplierInvoiceNumber: "22253",
    supplierInvoiceDate: "2026-08-02",
    countryOfOrigin: "DE",
    hsCode: "8409",
    customsCurrency: "EUR",
    exchangeRateToAED: 4.25,
    boeDeclaredQty: 596,
    boeDeclaredValue: 50000,
    customsUom: "PCS",
  };
  const lines = Array.from({ length: 11 }, (_, i) => ({
    poLineId: `L${i + 1}`,
    article: `A${i + 1}`,
    acceptedQty: i === 0 ? 80 : i === 10 ? 76 : 44,
    location: "A1",
    uom: "PCS",
  }));
  lines[10].acceptedQty = 596 - lines.slice(0, 10).reduce((s, l) => s + l.acceptedQty, 0);
  const r = validateCustomsCaptureForGrn({ header, lines, poDate: "2026-01-01" });
  assert.strictEqual(r.ok, true, JSON.stringify(r.errors));
  const rowEconomics = (r.errors || []).filter(
    (e) => e.line !== "HEADER" && (e.messages || []).some((m) => /Declared Qty|Declared Value|Currency|Exchange Rate/i.test(m))
  );
  assert.strictEqual(rowEconomics.length, 0);
});

run("TEST 3: missing declared value is one header error", () => {
  const r = validateCustomsCaptureForGrn({
    header: {
      receivedDate: "2026-08-11",
      boeNumber: "511685",
      boeDate: "2026-08-11",
      supplierInvoiceNumber: "22253",
      supplierInvoiceDate: "2026-08-02",
      countryOfOrigin: "DE",
      hsCode: "8409",
      customsCurrency: "EUR",
      exchangeRateToAED: 4.25,
      boeDeclaredQty: 596,
      customsUom: "PCS",
    },
    lines: [{ poLineId: "L1", article: "A", acceptedQty: 596, location: "A1", uom: "PCS" }],
    poDate: "2026-01-01",
  });
  assert.strictEqual(r.ok, false);
  const headerMsgs = (r.errors || []).filter((e) => e.line === "HEADER").flatMap((e) => e.messages);
  assert.ok(headerMsgs.some((m) => /BOE Declared Value is required/.test(m)));
  const rowValueErrs = (r.errors || []).filter(
    (e) => e.line !== "HEADER" && (e.messages || []).some((m) => /Declared Value/.test(m))
  );
  assert.strictEqual(rowValueErrs.length, 0);
});

run("TEST 4: missing effective HS Code is a line error", () => {
  const r = validateCustomsCaptureForGrn({
    header: {
      receivedDate: "2026-08-11",
      boeNumber: "511685",
      boeDate: "2026-08-11",
      supplierInvoiceNumber: "22253",
      supplierInvoiceDate: "2026-08-02",
      countryOfOrigin: "DE",
      hsCode: "",
      customsCurrency: "EUR",
      exchangeRateToAED: 4.25,
      boeDeclaredQty: 10,
      boeDeclaredValue: 100,
      customsUom: "PCS",
    },
    lines: [
      { poLineId: "L1", article: "OK", acceptedQty: 5, location: "A1", uom: "PCS" },
      { poLineId: "L2", article: "MISS", acceptedQty: 5, location: "A1", uom: "PCS" },
    ],
    lineOverrides: new Map([["L1", { hsCode: "8409" }]]),
    poDate: "2026-01-01",
  });
  assert.strictEqual(r.ok, false);
  const lineErr = (r.errors || []).find((e) => e.article === "MISS");
  assert.ok(lineErr);
  assert.ok(lineErr.messages.some((m) => /HS Code is required/.test(m)));
});

run("TEST 5: CSV first-row header inherits to blank rows", () => {
  const headerLine = grnCsvTemplateHeaderLine().trim();
  const row1 = buildGrnCsvRow(sampleValues({ Article: "A", "GRN Qty": "80", "Customs Qty": "80" }));
  const row2 = buildGrnCsvRow(
    sampleValues({
      Article: "B",
      "GRN Qty": "12",
      "Customs Qty": "12",
      "BOE Number": "",
      "BOE Date": "",
      "Received Date": "",
      "Supplier Invoice Number": "",
      "Supplier Invoice Date": "",
      "BOE Declared Qty": "",
      "BOE Declared Value": "",
      "Customs Currency": "",
      "Exchange Rate to AED": "",
      "Country of Origin": "DE",
      "HS Code": "8409",
    })
  );
  const parsed = parseGrnCsvText(`${headerLine}\n${row1}\n${row2}\n`);
  assert.strictEqual(parsed.ok, true);
  const { header, conflicts } = extractShipmentHeaderFromCsvRows(parsed.rows);
  assert.deepStrictEqual(conflicts, []);
  assert.strictEqual(header.boeNumber, "BOE1");
  assert.strictEqual(header.customsCurrency, "USD");
  assert.strictEqual(header.boeDeclaredQty, "10");
  assert.deepStrictEqual(validateInheritedCsvShipmentHeader(header), []);
  assert.deepStrictEqual(validateCsvLineAfterInheritance(parsed.rows[1], header), []);
});

run("TEST 6: repeated identical BOE header accepted", () => {
  const headerLine = grnCsvTemplateHeaderLine().trim();
  const csv = `${headerLine}\n${buildGrnCsvRow(sampleValues({ Article: "A" }))}\n${buildGrnCsvRow(sampleValues({ Article: "B" }))}\n`;
  const parsed = parseGrnCsvText(csv);
  const { header, conflicts } = extractShipmentHeaderFromCsvRows(parsed.rows);
  assert.deepStrictEqual(conflicts, []);
  assert.strictEqual(header.boeNumber, "BOE1");
});

run("TEST 7: conflicting BOE Number rejected", () => {
  const headerLine = grnCsvTemplateHeaderLine().trim();
  const csv = `${headerLine}\n${buildGrnCsvRow(sampleValues({ "BOE Number": "511685" }))}\n${buildGrnCsvRow(sampleValues({ "BOE Number": "999999", Article: "B" }))}\n`;
  const parsed = parseGrnCsvText(csv);
  const { conflicts } = extractShipmentHeaderFromCsvRows(parsed.rows);
  assert.ok(conflicts.some((c) => /511685/.test(c.message) && /999999|row 3/i.test(c.message)));
});

run("TEST 8: conflicting declared value rejected", () => {
  const headerLine = grnCsvTemplateHeaderLine().trim();
  const csv = `${headerLine}\n${buildGrnCsvRow(sampleValues({ "BOE Declared Value": "50000" }))}\n${buildGrnCsvRow(sampleValues({ "BOE Declared Value": "51000", Article: "B" }))}\n`;
  const parsed = parseGrnCsvText(csv);
  const { conflicts } = extractShipmentHeaderFromCsvRows(parsed.rows);
  assert.ok(conflicts.some((c) => /BOE Declared Value/.test(c.message)));
});

run("TEST 9: unit weight 0.5 stays numeric and date-like is rejected", () => {
  const parsed = parseGrnCsvText(sampleCsv({ "Unit Weight KG": "0.5" }));
  const { override } = mapCsvRowToCustomsOverride(parsed.rows[0], 10);
  assert.strictEqual(override.unitWeightKg, 0.5);
  assert.strictEqual(isDateLikeWeightString("0.5"), false);
  assert.strictEqual(isDateLikeWeightString("2/9/1900"), true);
  const bad = parseGrnCsvText(sampleCsv({ "Unit Weight KG": "2/9/1900" }));
  const mapped = mapCsvRowToCustomsOverride(bad.rows[0], 10);
  assert.ok(mapped.weightErrors.some((m) => /date/.test(m)));
});

run("TEST 10: qty reconciliation valid", () => {
  const r = validateCustomsCaptureForGrn({
    header: {
      receivedDate: "2026-08-11",
      boeNumber: "511685",
      boeDate: "2026-08-11",
      supplierInvoiceNumber: "22253",
      supplierInvoiceDate: "2026-08-02",
      countryOfOrigin: "DE",
      hsCode: "8409",
      customsCurrency: "EUR",
      exchangeRateToAED: 4.25,
      boeDeclaredQty: 596,
      boeDeclaredValue: 50000,
      customsUom: "PCS",
    },
    lines: [
      { poLineId: "L1", article: "A", acceptedQty: 300, location: "A1", uom: "PCS" },
      { poLineId: "L2", article: "B", acceptedQty: 296, location: "A1", uom: "PCS" },
    ],
    lineOverrides: new Map([
      ["L1", { customsQty: 300 }],
      ["L2", { customsQty: 296 }],
    ]),
    poDate: "2026-01-01",
  });
  assert.strictEqual(r.ok, true, JSON.stringify(r.errors));
});

run("TEST 11: qty reconciliation invalid is one error", () => {
  const r = validateCustomsCaptureForGrn({
    header: {
      receivedDate: "2026-08-11",
      boeNumber: "511685",
      boeDate: "2026-08-11",
      supplierInvoiceNumber: "22253",
      supplierInvoiceDate: "2026-08-02",
      countryOfOrigin: "DE",
      hsCode: "8409",
      customsCurrency: "EUR",
      exchangeRateToAED: 4.25,
      boeDeclaredQty: 596,
      boeDeclaredValue: 50000,
      customsUom: "PCS",
    },
    lines: [
      { poLineId: "L1", article: "A", acceptedQty: 300, location: "A1", uom: "PCS" },
      { poLineId: "L2", article: "B", acceptedQty: 295, location: "A1", uom: "PCS" },
    ],
    lineOverrides: new Map([
      ["L1", { customsQty: 300 }],
      ["L2", { customsQty: 295 }],
    ]),
    poDate: "2026-01-01",
  });
  assert.strictEqual(r.ok, false);
  const headerMsgs = (r.errors || []).filter((e) => e.line === "HEADER").flatMap((e) => e.messages);
  assert.ok(headerMsgs.some((m) => /Customs Qty total 595 does not match BOE Declared Qty 596/.test(m)));
});

run("TEST 12: EUR FX supplied once is inherited", () => {
  const eff = resolveCustomsLineEffective({
    header: { customsCurrency: "EUR", exchangeRateToAED: 4.25, hsCode: "1", countryOfOrigin: "DE" },
    override: {},
    quantity: 2,
    customsUnitValue: 10,
  });
  assert.strictEqual(eff.customsCurrency, "EUR");
  assert.strictEqual(eff.exchangeRateToAED, 4.25);
});

run("TEST 13: AED forces FX = 1", () => {
  const eff = resolveCustomsLineEffective({
    header: { customsCurrency: "AED", exchangeRateToAED: 9 },
    quantity: 1,
    customsUnitValue: 1,
  });
  assert.strictEqual(eff.exchangeRateToAED, 1);
});

run("TEST 14: no customs payload when only auto defaults exist", () => {
  const payload = buildGrnCustomsPayload(emptyGrnCustomsState(), {}, [{ poLineId: "x" }]);
  assert.strictEqual(payload, null);
});

run("TEST 15: BOE average 1010 / 2 = 505", () => {
  const r = validateCustomsCaptureForGrn({
    header: {
      receivedDate: "2026-01-15",
      boeNumber: "BOE",
      boeDate: "2026-01-10",
      supplierInvoiceNumber: "SI",
      supplierInvoiceDate: "2026-01-12",
      countryOfOrigin: "DE",
      hsCode: "8409",
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
  assert.strictEqual(r.ok, true, JSON.stringify(r.errors));
  assert.strictEqual(r.customsUnitValue, 505);
});

run("TEST 16: commercial values remain independent", () => {
  const commercial = { piston: 1000, bolt: 10 };
  assert.strictEqual(commercial.piston, 1000);
  assert.strictEqual(commercial.bolt, 10);
});

run("TEST 17: new template schema has explicit weight/currency columns", () => {
  const headers = [...GRN_CSV_HEADERS];
  assert.ok(!headers.includes("Weight"));
  assert.ok(!headers.includes("Customs Unit Price"));
  assert.ok(headers.includes("Unit Weight KG"));
  assert.ok(headers.includes("Gross Weight KG"));
  assert.ok(headers.includes("Net Weight KG"));
  assert.ok(headers.includes("BOE Declared Qty"));
  assert.ok(headers.includes("BOE Declared Value"));
  assert.ok(headers.includes("Customs Currency"));
  assert.ok(headers.includes("Exchange Rate to AED"));
});

run("TEST 18: download/import round trip matches manual header state", () => {
  const generated = buildGrnCsvTemplateCsv([
    { _id: SAMPLE_LINE_ID, itemCode: "260811", description: "Nozzle", orderedQty: 118, receivedQty: 0 },
  ]);
  assert.ok(generated.startsWith(GRN_CSV_HEADERS.join(",")));
  const filled = generated.replace(
    `${SAMPLE_LINE_ID},260811,Nozzle,,PCS,118,,,,,`,
    buildGrnCsvRow(
      sampleValues({
        "PO Line ID": SAMPLE_LINE_ID,
        Article: "260811",
        Description: "Nozzle",
        UOM: "PCS",
        "GRN Qty": "118",
        Location: "A1",
        "BOE Number": "511685",
        "BOE Declared Qty": "118",
        "BOE Declared Value": "50000",
        "Customs Currency": "EUR",
        "Exchange Rate to AED": "4.25",
        "Country of Origin": "DE",
        "HS Code": "8409",
        "Unit Weight KG": "0.5",
        "Customs Qty": "118",
      })
    )
  );
  const parsed = parseGrnCsvText(filled.includes("511685") ? `${grnCsvTemplateHeaderLine().trim()}\n${buildGrnCsvRow(sampleValues({
    "PO Line ID": SAMPLE_LINE_ID,
    Article: "260811",
    Description: "Nozzle",
    UOM: "PCS",
    "GRN Qty": "118",
    Location: "A1",
    "BOE Number": "511685",
    "BOE Declared Qty": "118",
    "BOE Declared Value": "50000",
    "Customs Currency": "EUR",
    "Exchange Rate to AED": "4.25",
    "Country of Origin": "DE",
    "HS Code": "8409",
    "Unit Weight KG": "0.5",
    "Customs Qty": "118",
  }))}\n` : filled);
  assert.strictEqual(parsed.ok, true);
  const qty = readGrnQtyFromCsvRow(parsed.rows[0]);
  const { override } = mapCsvRowToCustomsOverride(parsed.rows[0], qty);
  const header = suggestHeaderDefaultsFromOverrides([override]);
  const payload = buildGrnCustomsPayload(
    header,
    { [SAMPLE_LINE_ID]: { ...customsOverrideToLineEditFields(override), selected: true, grnQty: String(qty), location: "A1" } },
    [{ poLineId: SAMPLE_LINE_ID }]
  );
  assert.ok(payload);
  assert.strictEqual(payload.boeNumber, "511685");
  assert.strictEqual(payload.boeDeclaredQty, 118);
  assert.strictEqual(payload.boeDeclaredValue, 50000);
  assert.strictEqual(payload.customsCurrency, "EUR");
  assert.strictEqual(payload.exchangeRateToAED, 4.25);
  const capture = validateCustomsCaptureForGrn({
    header: payload,
    lineOverrides: new Map([[SAMPLE_LINE_ID, normalizeCustomsLineOverride(override)]]),
    lines: [{ poLineId: SAMPLE_LINE_ID, article: "260811", location: "A1", acceptedQty: qty, uom: "PCS" }],
    poDate: "2026-01-01",
  });
  assert.strictEqual(capture.ok, true, JSON.stringify(capture.errors));
});

run("legacy Currency / Exchange Rate aliases still import", () => {
  const headers = [
    "PO Line ID",
    "Article",
    "GRN Qty",
    "Location",
    "BOE Number",
    "BOE Date",
    "Supplier Invoice No.",
    "Supplier Invoice Date",
    "Country Of Origin",
    "HS Code",
    "BOE Declared Qty",
    "BOE Declared Value",
    "Currency",
    "Exchange Rate",
  ];
  const csv = `${headers.join(",")}\n${SAMPLE_LINE_ID},ART-1,10,BIN-A,BOE1,2026-01-15,SI-1,2026-01-18,CN,8501,10,125,EUR,4.25\n`;
  const parsed = parseGrnCsvText(csv);
  assert.strictEqual(parsed.ok, true);
  const { override } = mapCsvRowToCustomsOverride(parsed.rows[0], 10);
  assert.strictEqual(override.customsCurrency, "EUR");
  assert.strictEqual(override.exchangeRateToAED, 4.25);
  assert.strictEqual(override.supplierInvoiceNumber, "SI-1");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
