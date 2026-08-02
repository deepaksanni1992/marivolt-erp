/**
 * GRN CSV Phase 2 — Customs-only template / import (no Mongo, no posting).
 */
import assert from "assert";
import {
  GRN_CSV_HEADERS,
  INVALID_GRN_TEMPLATE,
  buildGrnCsvRow,
  customsOverrideToLineEditFields,
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
    "Customs Unit Price": "12.5",
    "Total Price": "",
    Currency: "USD",
    "Exchange Rate": "3.67",
    "AED Value": "",
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
    "Customs Unit Price",
    "Total Price",
    "Currency",
    "Exchange Rate",
    "AED Value",
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

run("auto calculations when Weight / Total Price / AED Value blank", () => {
  const parsed = parseGrnCsvText(sampleCsv());
  assert.strictEqual(parsed.ok, true);
  const qty = readGrnQtyFromCsvRow(parsed.rows[0]);
  const { override, computed } = mapCsvRowToCustomsOverride(parsed.rows[0], qty);
  assert.strictEqual(computed.weight, 25);
  assert.strictEqual(override.totalWeightKg, 25);
  assert.strictEqual(computed.totalPrice, 125);
  assert.ok(Math.abs(computed.aedValue - 125 * 3.67) < 1e-9);
});

run("never overwrite user-entered Weight / Total Price / AED Value", () => {
  const parsed = parseGrnCsvText(
    sampleCsv({ Weight: "30", "Total Price": "999", "AED Value": "50" })
  );
  const { override } = mapCsvRowToCustomsOverride(parsed.rows[0], 10);
  assert.strictEqual(override.totalWeightKg, 30);
  assert.strictEqual(override.customsTotalPrice, 999);
  assert.strictEqual(override.customsValueAED, 50);
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
  const norm = normalizeCustomsLineOverride(override);
  const effective = resolveCustomsLineEffective({
    header: {},
    override: norm,
    quantity: qty,
  });
  const mandatory = validateCustomsMandatoryEffective(effective, { location: "BIN-A" });
  assert.deepStrictEqual(mandatory, []);
  assert.strictEqual(effective.boeNumber, "BOE1");
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

  const capture = validateCustomsCaptureForGrn({
    header: payload,
    lineOverrides: new Map([[SAMPLE_LINE_ID, normalizeCustomsLineOverride(override)]]),
    lines: [{ poLineId: SAMPLE_LINE_ID, article: "ART-1", location: "BIN-A", grnQty: qty }],
    poDate: "2026-01-01",
    allowances: {},
  });
  assert.strictEqual(capture.ok, true, JSON.stringify(capture.errors));
});

run("legacy template constants and detectGrnCsvFormat are gone", () => {
  const src = fs.readFileSync(path.join(repoRoot, "backend/src/utils/grnCsvImport.js"), "utf8");
  assert.ok(!src.includes("GRN_CSV_LEGACY_HEADERS"));
  assert.ok(!src.includes("detectGrnCsvFormat"));
  assert.ok(!/format:\s*[\"']legacy[\"']/.test(src));
  const ctrl = fs.readFileSync(path.join(repoRoot, "backend/src/controllers/grnController.js"), "utf8");
  assert.ok(!ctrl.includes("materialCode / article / spn"));
  assert.ok(ctrl.includes("INVALID_GRN_TEMPLATE"));
});

run("legacy CSV filename references removed from import util", () => {
  const src = fs.readFileSync(path.join(repoRoot, "backend/src/utils/grnCsvImport.js"), "utf8");
  assert.ok(!/still accepted/i.test(src));
  assert.ok(!/legacy template/i.test(src));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
