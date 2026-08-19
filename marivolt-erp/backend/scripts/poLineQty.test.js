/**
 * Unit tests for PO line quantity merge + validation (no database).
 * Run: node backend/scripts/poLineQty.test.js
 */
import assert from "node:assert/strict";
import mongoose from "mongoose";
import PurchaseOrder from "../src/models/PurchaseOrder.js";
import {
  mergePoLineBases,
  poLineToPlain,
  resolveOrderedQty,
  validateIncomingPoLineQtys,
  validateReceivedQtyFloor,
} from "../src/utils/poLineQty.js";
import { calcPoDiscountTotal, calcPoGrandTotal } from "../src/utils/poTotals.js";

let passed = 0;
let failed = 0;
function run(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed += 1;
  } catch (e) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${e.message}`);
    failed += 1;
  }
}

/** Stored PO line as persisted by Mongoose (qty and orderedQty always in sync). */
function storedLine(overrides = {}) {
  return {
    _id: "line-1",
    itemCode: "ART-1",
    article: "ART-1",
    partNumber: "433598 AA",
    description: "Fuel pump",
    uom: "PCS",
    qty: 5,
    orderedQty: 5,
    receivedQty: 0,
    cancelledQty: 0,
    unitPrice: 25,
    lineAmount: 125,
    ...overrides,
  };
}

console.log("\nPO line quantity update\n");

run("edited qty wins over the stale orderedQty sent by the form", () => {
  const merged = mergePoLineBases([storedLine()], [{ _id: "line-1", qty: 10, orderedQty: 5 }]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].qty, 10);
  assert.equal(merged[0].orderedQty, 10);
  assert.equal(resolveOrderedQty(merged[0]), 10);
});

run("payload carrying only orderedQty still updates both fields", () => {
  const merged = mergePoLineBases([storedLine()], [{ _id: "line-1", orderedQty: 8 }]);
  assert.equal(merged[0].qty, 8);
  assert.equal(merged[0].orderedQty, 8);
});

run("decimal quantity is preserved", () => {
  const merged = mergePoLineBases([storedLine()], [{ _id: "line-1", qty: 2.5, orderedQty: 5 }]);
  assert.equal(merged[0].qty, 2.5);
});

run("unchanged line fields and line _id survive the merge", () => {
  const merged = mergePoLineBases([storedLine()], [{ _id: "line-1", qty: 10, orderedQty: 5 }]);
  const line = merged[0];
  assert.equal(String(line._id), "line-1");
  assert.equal(line.unitPrice, 25);
  assert.equal(line.description, "Fuel pump");
  assert.equal(line.partNumber, "433598 AA");
  assert.equal(line.uom, "PCS");
});

run("multi-line PO: only the edited line changes", () => {
  const stored = [
    storedLine(),
    storedLine({ _id: "line-2", itemCode: "ART-2", article: "ART-2", qty: 3, orderedQty: 3, unitPrice: 40 }),
    storedLine({ _id: "line-3", itemCode: "ART-3", article: "ART-3", qty: 7, orderedQty: 7, unitPrice: 10 }),
  ];
  const merged = mergePoLineBases(stored, [
    { _id: "line-1", qty: 5, orderedQty: 5 },
    { _id: "line-2", qty: 12, orderedQty: 3 },
    { _id: "line-3", qty: 7, orderedQty: 7 },
  ]);
  assert.deepEqual(merged.map((l) => l.qty), [5, 12, 7]);
  assert.deepEqual(merged.map((l) => String(l._id)), ["line-1", "line-2", "line-3"]);
});

run("multiple quantities changed in one update", () => {
  const stored = [storedLine(), storedLine({ _id: "line-2", qty: 3, orderedQty: 3 })];
  const merged = mergePoLineBases(stored, [
    { _id: "line-1", qty: 9, orderedQty: 5 },
    { _id: "line-2", qty: 1, orderedQty: 3 },
  ]);
  assert.deepEqual(merged.map((l) => l.qty), [9, 1]);
});

run("a new line does not inherit an existing line identity", () => {
  const stored = [storedLine()];
  const merged = mergePoLineBases(stored, [
    { _id: "line-1", qty: 5, orderedQty: 5 },
    { itemCode: "ART-NEW", article: "ART-NEW", qty: 4, unitPrice: 12 },
  ]);
  assert.equal(merged.length, 2);
  assert.equal(String(merged[0]._id), "line-1");
  assert.ok(!merged[1]._id, "new line must not reuse a stored line _id");
  assert.equal(merged[1].itemCode, "ART-NEW");
});

run("reordered payload matches by _id, not by index", () => {
  const stored = [storedLine(), storedLine({ _id: "line-2", itemCode: "ART-2", qty: 3, orderedQty: 3 })];
  const merged = mergePoLineBases(stored, [
    { _id: "line-2", qty: 6, orderedQty: 3 },
    { _id: "line-1", qty: 5, orderedQty: 5 },
  ]);
  assert.deepEqual(merged.map((l) => String(l._id)), ["line-2", "line-1"]);
  assert.deepEqual(merged.map((l) => l.qty), [6, 5]);
});

run("legacy payload without line ids still merges positionally", () => {
  const stored = [storedLine()];
  const merged = mergePoLineBases(stored, [{ qty: 11 }]);
  assert.equal(merged[0].qty, 11);
  assert.equal(merged[0].unitPrice, 25);
  assert.equal(String(merged[0]._id), "line-1");
});

run("received and cancelled quantities always come from the stored line", () => {
  const stored = [storedLine({ receivedQty: 4, cancelledQty: 1, rejectedQty: 2 })];
  const merged = mergePoLineBases(stored, [
    { _id: "line-1", qty: 10, orderedQty: 5, receivedQty: 0, cancelledQty: 0, rejectedQty: 0 },
  ]);
  assert.equal(merged[0].receivedQty, 4);
  assert.equal(merged[0].cancelledQty, 1);
  assert.equal(merged[0].rejectedQty, 2);
});

run("ASN reservation counter is preserved on PO line merge", () => {
  const stored = [storedLine({ asnActiveQty: 80 })];
  const merged = mergePoLineBases(stored, [{ _id: "line-1", qty: 90, asnActiveQty: 0 }]);
  assert.equal(merged[0].asnActiveQty, 80);
  assert.equal(merged[0].qty, 90);
});

run("new PO lines initialize asnActiveQty to 0 without an ASN", () => {
  const merged = mergePoLineBases([], [{ article: "ART-NEW", qty: 10, orderedQty: 10 }]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].asnActiveQty, 0);
});

run("empty payload keeps the stored lines untouched", () => {
  const merged = mergePoLineBases([storedLine()], []);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].qty, 5);
});

console.log("\nQuantity validation\n");

run("zero, negative and non-numeric quantities are rejected", () => {
  const errors = validateIncomingPoLineQtys([
    { itemCode: "ART-1", qty: 0 },
    { itemCode: "ART-2", qty: -3 },
    { itemCode: "ART-3", qty: "abc" },
  ]);
  assert.equal(errors.length, 3);
  assert.match(errors[0], /ART-1/);
  assert.match(errors[0], /greater than zero/);
});

run("blank grid rows and qty-less patches are not rejected", () => {
  const errors = validateIncomingPoLineQtys([{ itemCode: "", qty: 0 }, { itemCode: "ART-1", unitPrice: 5 }]);
  assert.deepEqual(errors, []);
});

run("valid quantities produce no errors", () => {
  assert.deepEqual(validateIncomingPoLineQtys([{ itemCode: "ART-1", qty: 2.5 }]), []);
});

console.log("\nGRN received-quantity protection\n");

run("quantity below the received quantity is rejected", () => {
  const stored = [storedLine({ qty: 10, orderedQty: 10, receivedQty: 6 })];
  const merged = mergePoLineBases(stored, [{ _id: "line-1", qty: 4, orderedQty: 10 }]);
  const errors = validateReceivedQtyFloor(stored, merged);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /cannot be less than the already received quantity of 6/);
});

run("quantity equal to or above the received quantity is allowed", () => {
  const stored = [storedLine({ qty: 10, orderedQty: 10, receivedQty: 6 })];
  assert.deepEqual(validateReceivedQtyFloor(stored, mergePoLineBases(stored, [{ _id: "line-1", qty: 6 }])), []);
  assert.deepEqual(validateReceivedQtyFloor(stored, mergePoLineBases(stored, [{ _id: "line-1", qty: 20 }])), []);
});

run("a line with receipts cannot be removed", () => {
  const stored = [storedLine({ receivedQty: 2 }), storedLine({ _id: "line-2", qty: 3, orderedQty: 3 })];
  const errors = validateReceivedQtyFloor(stored, mergePoLineBases(stored, [{ _id: "line-2", qty: 3 }]));
  assert.equal(errors.length, 1);
  assert.match(errors[0], /cannot be removed/);
});

run("PO without any receipts has no floor errors", () => {
  const stored = [storedLine()];
  assert.deepEqual(validateReceivedQtyFloor(stored, mergePoLineBases(stored, [{ _id: "line-1", qty: 1 }])), []);
});

console.log("\nMongoose subdocument handling\n");

/** Stored lines reach the merge as Mongoose subdocuments, whose fields are lost on a plain spread. */
function purchaseOrderWithLines() {
  return new PurchaseOrder({
    companyId: new mongoose.Types.ObjectId(),
    poNo: "PO-TEST-1",
    supplierName: "Test supplier",
    lines: [
      { itemCode: "ART-1", article: "ART-1", qty: 5, orderedQty: 5, unitPrice: 25, description: "Fuel pump" },
    ],
  });
}

run("plain copy of a subdocument keeps _id and field values", () => {
  const subdoc = purchaseOrderWithLines().lines[0];
  assert.equal({ ...subdoc }.qty, undefined, "raw spread must be the unsafe case this guards against");
  const plain = poLineToPlain(subdoc);
  assert.equal(plain.qty, 5);
  assert.equal(plain.unitPrice, 25);
  assert.equal(String(plain._id), String(subdoc._id));
});

run("merging onto stored subdocuments keeps the line _id and updates qty", () => {
  const doc = purchaseOrderWithLines();
  const lineId = String(doc.lines[0]._id);
  const merged = mergePoLineBases(doc.lines, [{ _id: lineId, qty: 10, orderedQty: 5 }]);
  assert.equal(merged[0].qty, 10);
  assert.equal(merged[0].orderedQty, 10);
  assert.equal(String(merged[0]._id), lineId);
  assert.equal(merged[0].description, "Fuel pump");
});

run("saving merged lines back onto the document preserves the line _id", () => {
  const doc = purchaseOrderWithLines();
  const lineId = String(doc.lines[0]._id);
  doc.lines = mergePoLineBases(doc.lines, [{ _id: lineId, qty: 10, orderedQty: 5 }]);
  assert.equal(String(doc.lines[0]._id), lineId);
  assert.equal(doc.lines[0].qty, 10);
});

console.log("\nTotals recalculated from the updated quantity\n");

run("subtotal, discount and grand total follow the edited quantity", () => {
  const stored = [storedLine(), storedLine({ _id: "line-2", qty: 3, orderedQty: 3, unitPrice: 40 })];
  const merged = mergePoLineBases(stored, [
    { _id: "line-1", qty: 10, orderedQty: 5 },
    { _id: "line-2", qty: 3, orderedQty: 3 },
  ]);
  const subTotal = merged.reduce((sum, l) => sum + resolveOrderedQty(l) * l.unitPrice, 0);
  assert.equal(subTotal, 370);
  const discountTotal = calcPoDiscountTotal(subTotal, "PERCENT", 10);
  assert.equal(discountTotal, 37);
  assert.equal(calcPoGrandTotal(subTotal, 10, 5, 0, discountTotal), 348);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
