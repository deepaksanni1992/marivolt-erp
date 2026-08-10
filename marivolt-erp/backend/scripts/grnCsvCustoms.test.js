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
  findPoLineMatchForCsvRow,
  formatPoLineMatchError,
  grnCsvTemplateHeaderLine,
  mapCsvRowToCustomsOverride,
  parseGrnCsvText,
  readGrnQtyFromCsvRow,
  suggestHeaderDefaultsFromOverrides,
  validateGrnCsvHeaders,
  validateGrnCsvRowRequiredFields,
} from "../src/utils/grnCsvImport.js";
import {
  normalizeCustomsLineOverride,
  resolveCustomsLineEffective,
  validateCustomsCaptureForGrn,
  validateCustomsMandatoryEffective,
} from "../src/utils/customsGrnFieldModel.js";
import { buildGrnCustomsPayload } from "../../src/lib/grnCustomsPayload.js";
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
    "AWB No. / BL No.": "AWB99",
    "Received Date": "2026-01-20",
    "Supplier Invoice No.": "SI-1",
    "Supplier Invoice Date": "2026-01-18",
    "Country Of Origin": "CN",
    "HS Code": "8501.10",
    "Unit Weight": "2.5",
    Weight: "",
    "BOE Declared Qty": "10",
    "Customs UOM": "PCS",
    "BOE Declared Value": "125",
    Currency: "USD",
    "Exchange Rate": "3.67",
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
    "AWB No. / BL No.",
    "Received Date",
    "Supplier Invoice No.",
    "Supplier Invoice Date",
    "Country Of Origin",
    "HS Code",
    "Unit Weight",
    "Weight",
    "BOE Declared Qty",
    "Customs UOM",
    "BOE Declared Value",
    "Currency",
    "Exchange Rate",
  ];
  assert.deepStrictEqual([...GRN_CSV_HEADERS], expected);
  assert.strictEqual(grnCsvTemplateHeaderLine().trim(), expected.join(","));
});

run("invalid headers → INVALID_GRN_TEMPLATE", () => {
  const bad = parseGrnCsvText("poLineId,article,grnQty,location\n1,a,1,x\n");
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

run("reordered columns rejected", () => {
  const headers = [...GRN_CSV_HEADERS];
  const tmp = headers[0];
  headers[0] = headers[1];
  headers[1] = tmp;
  const r = validateGrnCsvHeaders(headers);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, INVALID_GRN_TEMPLATE);
});

run("duplicate columns rejected", () => {
  const headers = [...GRN_CSV_HEADERS];
  headers[2] = headers[1]; // duplicate Article
  const r = validateGrnCsvHeaders(headers);
  assert.strictEqual(r.ok, false);
  assert.ok(r.details.some((d) => /Duplicate/i.test(d)));
});

run("renamed column rejected", () => {
  const headers = [...GRN_CSV_HEADERS];
  headers[0] = "poLineId";
  const r = validateGrnCsvHeaders(headers);
  assert.strictEqual(r.ok, false);
  assert.ok(r.details.some((d) => /PO Line ID/.test(d)));
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
});

run("never overwrite user-entered Weight", () => {
  const parsed = parseGrnCsvText(sampleCsv({ Weight: "30" }));
  const { override } = mapCsvRowToCustomsOverride(parsed.rows[0], 10);
  assert.strictEqual(override.totalWeightKg, 30);
});

run("successful import parse + required field validation", () => {
  const parsed = parseGrnCsvText(sampleCsv());
  assert.strictEqual(parsed.ok, true);
  assert.strictEqual(parsed.rows.length, 1);
  const msgs = validateGrnCsvRowRequiredFields(parsed.rows[0]);
  assert.deepStrictEqual(msgs, []);
});

run("row validation returns messages for missing required customs fields", () => {
  const parsed = parseGrnCsvText(
    sampleCsv({
      "BOE Number": "",
      Currency: "",
      "HS Code": "",
    })
  );
  const msgs = validateGrnCsvRowRequiredFields(parsed.rows[0]);
  assert.ok(msgs.some((m) => /BOE Number/.test(m)));
  assert.ok(msgs.some((m) => /Currency/.test(m)));
  assert.ok(msgs.some((m) => /HS Code/.test(m)));
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
      "Supplier Invoice No.": "1",
      "Supplier Invoice Date": "2026-01-01",
      "Country Of Origin": "DE",
      "HS Code": "1",
      "BOE Declared Qty": "9",
      "Customs UOM": "PCS",
      "BOE Declared Value": "9",
      Currency: "EUR",
      "Exchange Rate": "1",
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

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
