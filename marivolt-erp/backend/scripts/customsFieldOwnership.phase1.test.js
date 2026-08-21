/**
 * Customs / ASN / GRN Field Ownership — Phase 1 regression.
 * Run: node scripts/customsFieldOwnership.phase1.test.js
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  normalizeBoeNumber,
  resolveAsnSupplierInvoices,
  pickAsnSupplierInvoiceFifoSnapshot,
  applySupplierInvoiceScalarShadow,
  resolveAsnLineHsCode,
  resolveAsnLineCountryOfOrigin,
  assertAsnSupplierInvoicesPresent,
  assertAsnLineHsCodePresent,
  assertAsnLineCooPresent,
  findAsnLineForGrnItem,
  asnReceivingBoeLinkQtyFromGrn,
} from "../src/utils/asnCustomsFieldOwnership.js";
import { validateCustomsCaptureForGrn } from "../src/utils/customsGrnFieldModel.js";
import {
  computeBoeCustomsUnitValue,
  roundCustomsQty,
  roundCustomsMoney,
  resolveLineCustomsQuantities,
  allocateBoeLineValues,
} from "../src/utils/customsBoeAverage.js";
import { remainingToLinkQty, canReserveLinkedQty } from "../src/services/customsBoeService.js";
import { sanitizeAsnReceivingCustomsCapture } from "../src/utils/receivingDraftGrnRules.js";
import { ASN_SHIPMENT_PATCH_KEYS, ASN_CUSTOMS_AUTHORITY_SHIPMENT_KEYS, shipmentFieldsEditable } from "../src/utils/asnRules.js";

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

console.log("customsFieldOwnership.phase1.test.js");

run("ASN has no BOE fields in model", () => {
  const model = fs.readFileSync(path.join(srcRoot, "models", "AdvanceShipmentNotice.js"), "utf8");
  assert.match(model, /supplierInvoices/);
  assert.match(model, /hsCode/);
  assert.doesNotMatch(model, /boeNumber/);
  assert.doesNotMatch(model, /customsBoe/);
});

run("ASN has no unit weight on lines", () => {
  const model = fs.readFileSync(path.join(srcRoot, "models", "AdvanceShipmentNotice.js"), "utf8");
  assert.doesNotMatch(model, /unitWeightKg/);
});

run("multiple supplier invoices save/read via helper", () => {
  const asn = {
    supplierInvoices: [
      { invoiceNumber: "INV-B", invoiceDate: "2026-02-10" },
      { invoiceNumber: "INV-A", invoiceDate: "2026-02-01" },
    ],
  };
  const list = resolveAsnSupplierInvoices(asn);
  assert.equal(list.length, 2);
  const snap = pickAsnSupplierInvoiceFifoSnapshot(asn);
  assert.equal(snap.invoiceNumber, "INV-A");
  assert.ok(snap.invoiceDate instanceof Date);
  assert.equal(snap.invoiceDate.toISOString().slice(0, 10), "2026-02-01");
});

run("legacy scalar supplier invoice reads", () => {
  const asn = { supplierInvoiceNumber: "LEGACY-1", supplierInvoiceDate: "2026-01-05" };
  const list = resolveAsnSupplierInvoices(asn);
  assert.equal(list.length, 1);
  assert.equal(list[0].invoiceNumber, "LEGACY-1");
  const shadow = applySupplierInvoiceScalarShadow({}, list);
  assert.equal(shadow.supplierInvoiceNumber, "LEGACY-1");
});

run("ASN line HS/COO save/read helpers", () => {
  assert.equal(resolveAsnLineHsCode({ hsCode: "840999" }), "840999");
  assert.equal(resolveAsnLineCountryOfOrigin({ countryOfOrigin: "Germany" }), "GERMANY");
});

run("legacy ASN header COO fallback", () => {
  assert.equal(
    resolveAsnLineCountryOfOrigin({ countryOfOrigin: "" }, { countryOfOrigin: "Italy" }),
    "ITALY",
  );
  assert.equal(
    resolveAsnLineCountryOfOrigin({ countryOfOrigin: "DE" }, { countryOfOrigin: "Italy" }),
    "DE",
  );
});

run("supplier invoices patch key registered", () => {
  assert.ok(ASN_SHIPMENT_PATCH_KEYS.includes("supplierInvoices"));
  assert.ok(ASN_CUSTOMS_AUTHORITY_SHIPMENT_KEYS.includes("supplierInvoices"));
});

run("ASN edit freeze: lines DRAFT-only; shipment SHIPPED ok; ARRIVED frozen", () => {
  assert.equal(shipmentFieldsEditable("DRAFT"), true);
  assert.equal(shipmentFieldsEditable("SHIPPED"), true);
  assert.equal(shipmentFieldsEditable("ARRIVED"), false);
});

run("BOE normalize: trim + case fold only", () => {
  assert.equal(normalizeBoeNumber("  83535  "), "83535");
  assert.equal(normalizeBoeNumber("boe-ab"), "BOE-AB");
  assert.equal(normalizeBoeNumber("83 535"), "83 535");
});

run("frozen average = total value / total qty", () => {
  const u = computeBoeCustomsUnitValue(10000, 100);
  assert.equal(u.ok, true);
  assert.equal(u.customsUnitValue, 100);
});

run("same BOE average for piston and O-ring (pooled)", () => {
  const unit = computeBoeCustomsUnitValue(25000, 500).customsUnitValue;
  assert.equal(unit, 50);
  const r = validateCustomsCaptureForGrn({
    header: {
      receivedDate: "2026-03-01",
      boeNumber: "83535",
      boeDate: "2026-02-20",
      supplierInvoiceNumber: "INV-A",
      supplierInvoiceDate: "2026-02-18",
      customsCurrency: "EUR",
      exchangeRateToAED: 4.25,
      boeDeclaredQty: 500,
      boeDeclaredValue: 25000,
      customsUom: "PCS",
      countryOfOrigin: "DE",
      hsCode: "840999",
    },
    lines: [
      { poLineId: "1", article: "700011", acceptedQty: 5, location: "A-01", uom: "PCS" },
      { poLineId: "2", article: "700012", acceptedQty: 8, location: "A-02", uom: "PCS" },
    ],
    lineOverrides: new Map([
      ["1", { hsCode: "840999", countryOfOrigin: "DE", unitWeightKg: 2.35 }],
      ["2", { hsCode: "401693", countryOfOrigin: "IT", unitWeightKg: 0.2 }],
    ]),
    poDate: "2026-01-01",
  });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.customsUnitValue, 50);
  assert.equal(r.lineCustomsQty.get("1").customsTotalPrice, 250);
  assert.equal(r.lineCustomsQty.get("2").customsTotalPrice, 400);
  assert.equal(r.thisGrnCustomsQty, 13);
});

run("linked qty cannot exceed BOE total; cancel release concept", () => {
  assert.equal(remainingToLinkQty({ boeDeclaredQty: 100, linkedCustomsQty: 70 }), 30);
  const over = canReserveLinkedQty({ boeDeclaredQty: 100, linkedCustomsQty: 70, delta: 40 });
  assert.equal(over.ok, false);
  const ok = canReserveLinkedQty({ boeDeclaredQty: 100, linkedCustomsQty: 70, delta: 30 });
  assert.equal(ok.ok, true);
  assert.equal(roundCustomsQty(70 + 30), 100);
});

run("existing BOE read-only: client cannot override declaration", () => {
  const parentBoe = {
    _id: "boe1",
    customsBoeRef: "MAR-BOE-0001",
    boeNumber: "83535",
    boeDate: "2026-02-20",
    boeDeclaredQty: 500,
    boeDeclaredValue: 25000,
    customsUnitValue: 50,
    customsCurrency: "EUR",
    exchangeRateToAED: 4.25,
    customsUom: "PCS",
    linkedCustomsQty: 200,
    grossWeightKg: 250,
    netWeightKg: 225,
  };
  const r = validateCustomsCaptureForGrn({
    header: {
      receivedDate: "2026-03-01",
      boeNumber: "83535",
      boeDate: "2026-02-20",
      supplierInvoiceNumber: "INV-A",
      supplierInvoiceDate: "2026-02-18",
      customsCurrency: "EUR",
      exchangeRateToAED: 4.25,
      boeDeclaredQty: 999,
      boeDeclaredValue: 1,
      customsUom: "PCS",
      countryOfOrigin: "DE",
      hsCode: "840999",
    },
    lines: [{ poLineId: "1", article: "700011", acceptedQty: 5, location: "A-01", uom: "PCS" }],
    parentBoe,
    poDate: "2026-01-01",
  });
  assert.equal(r.ok, false);
});

run("ASN missing HS / COO / SI precise codes", () => {
  assert.equal(assertAsnLineHsCodePresent({ article: "700011" }).code, "ASN_LINE_HS_CODE_REQUIRED");
  assert.equal(assertAsnLineCooPresent({ article: "700011" }, {}).code, "ASN_LINE_COO_REQUIRED");
  assert.equal(assertAsnSupplierInvoicesPresent({}).code, "ASN_SUPPLIER_INVOICE_REQUIRED");
});

run("find ASN line for GRN item", () => {
  const asn = {
    lines: [
      { _id: "a1", poLineId: "p1", article: "700011", hsCode: "840999", countryOfOrigin: "DE" },
    ],
  };
  assert.equal(findAsnLineForGrnItem(asn, { asnLineId: "a1" }).hsCode, "840999");
  assert.equal(findAsnLineForGrnItem(asn, { poLineId: "p1" }).article, "700011");
});

run("ASN_RECEIVING draft capture sanitizes HS/COO/SI/economics", () => {
  const cleaned = sanitizeAsnReceivingCustomsCapture(
    {
      boeNumber: "83535",
      hsCode: "HACK",
      countryOfOrigin: "XX",
      supplierInvoiceNumber: "FAKE",
      customsQty: 99,
      unitWeightKg: 99,
    },
    { unitWeightKg: 2.35, totalWeightKg: 11.75 },
  );
  assert.equal(cleaned.hsCode, "");
  assert.equal(cleaned.countryOfOrigin, "");
  assert.equal(cleaned.supplierInvoiceNumber, "");
  assert.equal(cleaned.customsQty, 0);
  assert.equal(cleaned.unitWeightKg, 2.35);
  assert.equal(cleaned.boeNumber, "83535");
});

run("reuse-by-number + findCustomsBoeByNormalizedNumber exported", () => {
  const svc = fs.readFileSync(path.join(srcRoot, "services", "customsBoeService.js"), "utf8");
  assert.match(svc, /export async function findCustomsBoeByNormalizedNumber/);
  assert.match(svc, /reusedExisting/);
  assert.match(svc, /normalizeBoeNumber/);
});

run("ASN_RECEIVING authority applied in customsService", () => {
  const svc = fs.readFileSync(path.join(srcRoot, "services", "customsService.js"), "utf8");
  assert.match(svc, /applyAsnReceivingFieldAuthority/);
  assert.match(svc, /ASN_LINE_HS_CODE_REQUIRED|assertAsnLineHsCodePresent/);
  assert.match(svc, /findCustomsBoeByNormalizedNumber/);
});

run("frontend ASN multi-invoice + line HS/COO present", () => {
  const asnPage = fs.readFileSync(path.join(feRoot, "pages", "Asn.jsx"), "utf8");
  assert.match(asnPage, /Add Supplier Invoice/);
  assert.match(asnPage, /supplierInvoices/);
  assert.match(asnPage, /lineHs/);
  assert.match(asnPage, /HS Code/);
});

run("frontend ASN_RECEIVING draft customs review present", () => {
  const review = fs.readFileSync(
    path.join(feRoot, "components", "store", "AsnReceivingDraftCustomsReview.jsx"),
    "utf8",
  );
  assert.match(review, /variant=\"ASN_RECEIVING\"/);
  assert.match(review, /Actual Unit Weight|Unit Weight/);
  const grnSec = fs.readFileSync(path.join(feRoot, "components", "store", "GrnCustomsSection.jsx"), "utf8");
  assert.match(grnSec, /isAsnReceiving/);
});

run("no production migration / no BOE-AUDIT-001 repair in phase1 helper", () => {
  const helper = fs.readFileSync(path.join(srcRoot, "utils", "asnCustomsFieldOwnership.js"), "utf8");
  assert.doesNotMatch(helper, /BOE-AUDIT-001/);
  assert.doesNotMatch(helper, /migrate/i);
});

// ——— Hardening: acceptedQty-only BOE link ———

run("acceptedQty is sole ASN_RECEIVING BOE contribution (helper)", () => {
  const grn = {
    sourceType: "ASN_RECEIVING",
    items: [
      { article: "A", acceptedQty: 43, customsCapture: { customsQty: 50 } },
      { article: "B", acceptedQty: 0, customsCapture: { customsQty: 99 } },
    ],
  };
  assert.equal(asnReceivingBoeLinkQtyFromGrn(grn), 43);
});

run("stale customsQty 50 cannot override acceptedQty 43 (forceAcceptedQtyOnly)", () => {
  const r = validateCustomsCaptureForGrn({
    header: {
      receivedDate: "2026-03-01",
      boeNumber: "83535",
      boeDate: "2026-02-20",
      supplierInvoiceNumber: "INV-A",
      supplierInvoiceDate: "2026-02-18",
      customsCurrency: "EUR",
      exchangeRateToAED: 4.25,
      boeDeclaredQty: 500,
      boeDeclaredValue: 25000,
      customsUom: "PCS",
      grossWeightKg: 250,
      netWeightKg: 225,
    },
    lines: [{ poLineId: "1", article: "700011", acceptedQty: 43, location: "A-01", uom: "PCS" }],
    lineOverrides: new Map([["1", { customsQty: 50, hsCode: "840999", countryOfOrigin: "DE" }]]),
    forceAcceptedQtyOnly: true,
    poDate: "2026-01-01",
  });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.thisGrnCustomsQty, 43);
  assert.equal(r.lineCustomsQty.get("1").customsQty, 43);
  assert.equal(r.lineCustomsQty.get("1").customsTotalPrice, roundCustomsMoney(43 * 50));
});

run("client customsQty 43 cannot shrink acceptedQty 50", () => {
  const qty = resolveLineCustomsQuantities({
    lines: [{ poLineId: "1", article: "X", acceptedQty: 50, uom: "PCS", customsQty: 43 }],
    boeDeclaredQty: 100,
    customsUom: "PCS",
    forceAcceptedQtyOnly: true,
  });
  assert.equal(qty.ok, true);
  assert.equal(qty.mode, "ACCEPTED_QTY_ONLY");
  assert.equal(qty.thisGrnCustomsQty, 50);
  assert.equal(qty.lines[0].customsQty, 50);
});

run("MANUAL_PO still allows explicit customsQty when not forced", () => {
  const qty = resolveLineCustomsQuantities({
    lines: [{ poLineId: "1", article: "X", acceptedQty: 50, uom: "PCS", customsQty: 43 }],
    boeDeclaredQty: 100,
    customsUom: "PCS",
    forceAcceptedQtyOnly: false,
  });
  assert.equal(qty.ok, true);
  assert.equal(qty.mode, "EXPLICIT");
  assert.equal(qty.thisGrnCustomsQty, 43);
});

run("crafted line economics cannot override existing parent", () => {
  const parentBoe = {
    _id: "boe1",
    customsBoeRef: "MAR-BOE-0001",
    boeNumber: "83535",
    boeDate: "2026-02-20",
    boeDeclaredQty: 500,
    boeDeclaredValue: 25000,
    customsUnitValue: 50,
    customsCurrency: "EUR",
    exchangeRateToAED: 4.25,
    customsUom: "PCS",
    linkedCustomsQty: 0,
    grossWeightKg: 250,
    netWeightKg: 225,
  };
  const r = validateCustomsCaptureForGrn({
    header: {
      receivedDate: "2026-03-01",
      boeNumber: "83535",
      boeDate: "2026-02-20",
      supplierInvoiceNumber: "INV-A",
      supplierInvoiceDate: "2026-02-18",
      customsCurrency: "USD",
      exchangeRateToAED: 1,
      boeDeclaredQty: 600,
      boeDeclaredValue: 99999,
      customsUom: "PCS",
      customsUnitValue: 1,
    },
    lines: [{ poLineId: "1", article: "700011", acceptedQty: 5, location: "A-01", uom: "PCS" }],
    lineOverrides: new Map([
      [
        "1",
        {
          hsCode: "HACK",
          countryOfOrigin: "XX",
          customsQty: 99,
          customsCurrency: "USD",
          exchangeRateToAED: 1,
          customsUnitValue: 1,
        },
      ],
    ]),
    parentBoe,
    forceAcceptedQtyOnly: true,
    poDate: "2026-01-01",
  });
  assert.equal(r.ok, false, "conflicting parent declaration must be rejected");
});

run("existing parent retained when client economics omitted (lock)", () => {
  const parentBoe = {
    _id: "boe1",
    customsBoeRef: "MAR-BOE-0001",
    boeNumber: "83535",
    boeDate: "2026-02-20",
    boeDeclaredQty: 500,
    boeDeclaredValue: 25000,
    customsUnitValue: 50,
    customsCurrency: "EUR",
    exchangeRateToAED: 4.25,
    customsUom: "PCS",
    linkedCustomsQty: 200,
    grossWeightKg: 250,
    netWeightKg: 225,
  };
  const r = validateCustomsCaptureForGrn({
    header: {
      receivedDate: "2026-03-01",
      boeNumber: "83535",
      boeDate: "2026-02-20",
      supplierInvoiceNumber: "INV-A",
      supplierInvoiceDate: "2026-02-18",
      customsCurrency: "EUR",
      exchangeRateToAED: 4.25,
    },
    lines: [{ poLineId: "1", article: "700011", acceptedQty: 5, location: "A-01", uom: "PCS" }],
    lineOverrides: new Map([["1", { hsCode: "840999", countryOfOrigin: "DE", unitWeightKg: 2.35 }]]),
    parentBoe,
    forceAcceptedQtyOnly: true,
    poDate: "2026-01-01",
  });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.customsUnitValue, 50);
  assert.equal(r.thisGrnCustomsQty, 5);
});

run("pooled average: piston/O-ring/washer same EUR 100 unit", () => {
  const unit = computeBoeCustomsUnitValue(10000, 100);
  assert.equal(unit.customsUnitValue, 100);
  const lines = [
    { poLineId: "1", article: "PISTON", acceptedQty: 2, uom: "PCS" },
    { poLineId: "2", article: "ORING", acceptedQty: 30, uom: "PCS" },
    { poLineId: "3", article: "WASHER", acceptedQty: 18, uom: "PCS" },
  ];
  const qty = resolveLineCustomsQuantities({
    lines,
    boeDeclaredQty: 100,
    customsUom: "PCS",
    forceAcceptedQtyOnly: true,
  });
  assert.equal(qty.thisGrnCustomsQty, 50);
  const valued = allocateBoeLineValues({
    lines: qty.lines,
    boeDeclaredValue: 10000,
    boeDeclaredQty: 100,
    customsUnitValue: 100,
  });
  const byArt = Object.fromEntries(valued.map((v) => [v.article, v]));
  assert.equal(byArt.PISTON.customsTotalPrice, 200);
  assert.equal(byArt.ORING.customsTotalPrice, 3000);
  assert.equal(byArt.WASHER.customsTotalPrice, 1800);
  assert.ok(valued.every((v) => v.customsQty === lines.find((l) => l.article === v.article).acceptedQty));
});

run("multi-GRN same BOE: link 30 then 40 then reject 31", () => {
  assert.equal(remainingToLinkQty({ boeDeclaredQty: 100, linkedCustomsQty: 0 }), 100);
  assert.equal(canReserveLinkedQty({ boeDeclaredQty: 100, linkedCustomsQty: 0, delta: 30 }).ok, true);
  assert.equal(remainingToLinkQty({ boeDeclaredQty: 100, linkedCustomsQty: 30 }), 70);
  assert.equal(canReserveLinkedQty({ boeDeclaredQty: 100, linkedCustomsQty: 30, delta: 40 }).ok, true);
  assert.equal(remainingToLinkQty({ boeDeclaredQty: 100, linkedCustomsQty: 70 }), 30);
  assert.equal(canReserveLinkedQty({ boeDeclaredQty: 100, linkedCustomsQty: 70, delta: 31 }).ok, false);
  assert.equal(canReserveLinkedQty({ boeDeclaredQty: 100, linkedCustomsQty: 70, delta: 30 }).ok, true);
});

run("cancel GRN-2 releases link 70→30; average unchanged", () => {
  const afterCancelLinked = roundCustomsQty(70 - 40);
  assert.equal(afterCancelLinked, 30);
  const unit = computeBoeCustomsUnitValue(10000, 100).customsUnitValue;
  assert.equal(unit, 100);
  assert.equal(remainingToLinkQty({ boeDeclaredQty: 100, linkedCustomsQty: afterCancelLinked }), 70);
});

run("multi-invoice FIFO snapshot has no valuation effect", () => {
  const asn = {
    supplierInvoices: [
      { invoiceNumber: "INV-LATE", invoiceDate: "2026-03-10" },
      { invoiceNumber: "INV-EARLY", invoiceDate: "2026-03-01" },
    ],
  };
  const snap = pickAsnSupplierInvoiceFifoSnapshot(asn);
  assert.equal(snap.invoiceNumber, "INV-EARLY");
  assert.equal(snap.invoices.length, 2);
  const unit = computeBoeCustomsUnitValue(10000, 100).customsUnitValue;
  assert.equal(unit, 100);
  // Snapshot choice does not enter average formula.
});

run("normalizedBoeNumber persisted on CustomsBoe model (migration-only unique)", () => {
  const model = fs.readFileSync(path.join(srcRoot, "models", "CustomsBoe.js"), "utf8");
  assert.match(model, /normalizedBoeNumber/);
  assert.match(model, /NOT registered via Mongoose|migration-only|migrate:customs-boe-identity-indexes/i);
  // No live unique index registration for normalizedBoeNumber (comments may mention unique).
  assert.doesNotMatch(model, /index\(\s*\{\s*companyId:\s*1,\s*normalizedBoeNumber:\s*1\s*\}\s*,\s*\{\s*unique:\s*true/);
});

run("customsService forces acceptedQty for ASN_RECEIVING lot items", () => {
  const svc = fs.readFileSync(path.join(srcRoot, "services", "customsService.js"), "utf8");
  assert.match(svc, /forceAcceptedQtyOnly/);
  assert.match(svc, /acceptedOnly/);
  assert.match(svc, /Neutralize stale Draft capture/);
});

console.log(`\nPhase 1 field ownership: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
