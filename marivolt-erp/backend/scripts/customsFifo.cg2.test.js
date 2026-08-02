/**
 * CG2 — Customs FIFO BOE allocation unit tests (no DB).
 * Run: node scripts/customsFifo.cg2.test.js
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CUSTOMS_FIFO_ORDER_KEYS,
  allocateQtyAcrossLotsFifo,
  compareCustomsFifoOrder,
  sortCustomsLotsForFifo,
} from "../src/utils/customsFifo.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcRoot = path.join(__dirname, "../src");

let passed = 0;
let failed = 0;

function run(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`PASS  ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`FAIL  ${name}`);
    console.error(`      ${err.message}`);
  }
}

function lot(partial) {
  return {
    _id: partial._id || partial.id,
    customsLotId: partial.customsLotId || `lot-${partial._id || partial.id}`,
    qtyAvailable: partial.qtyAvailable ?? 0,
    boeDate: partial.boeDate || null,
    supplierInvoiceDate: partial.supplierInvoiceDate || null,
    receivedDate: partial.receivedDate || null,
    grnCreatedAt: partial.grnCreatedAt || null,
    boeNumber: partial.boeNumber || "",
    ...partial,
  };
}

run("FIFO order keys documented", () => {
  assert.deepEqual(CUSTOMS_FIFO_ORDER_KEYS, [
    "boeDate",
    "supplierInvoiceDate",
    "receivedDate",
    "grnCreatedAt",
    "customsLotId",
    "customsLotItemId",
  ]);
});

run("Example: allocate 18 across BOE 5+8+12 → 5,8,5", () => {
  const sorted = sortCustomsLotsForFifo([
    lot({
      _id: "i3",
      boeNumber: "BOE003",
      qtyAvailable: 12,
      boeDate: "2024-03-01",
      supplierInvoiceDate: "2024-02-20",
      receivedDate: "2024-03-02",
      grnCreatedAt: "2024-03-02T10:00:00Z",
      customsLotId: "L3",
    }),
    lot({
      _id: "i1",
      boeNumber: "BOE001",
      qtyAvailable: 5,
      boeDate: "2024-01-01",
      supplierInvoiceDate: "2023-12-20",
      receivedDate: "2024-01-02",
      grnCreatedAt: "2024-01-02T10:00:00Z",
      customsLotId: "L1",
    }),
    lot({
      _id: "i2",
      boeNumber: "BOE002",
      qtyAvailable: 8,
      boeDate: "2024-02-01",
      supplierInvoiceDate: "2024-01-20",
      receivedDate: "2024-02-02",
      grnCreatedAt: "2024-02-02T10:00:00Z",
      customsLotId: "L2",
    }),
  ]);
  assert.deepEqual(
    sorted.map((r) => r.boeNumber),
    ["BOE001", "BOE002", "BOE003"],
  );
  const { allocations, shortfall } = allocateQtyAcrossLotsFifo(sorted, 18);
  assert.equal(shortfall, 0);
  assert.equal(allocations.length, 3);
  assert.equal(allocations[0].qty, 5);
  assert.equal(allocations[0].remainingAfter, 0);
  assert.equal(allocations[1].qty, 8);
  assert.equal(allocations[1].remainingAfter, 0);
  assert.equal(allocations[2].qty, 5);
  assert.equal(allocations[2].remainingAfter, 7);
});

run("Single BOE exact allocation", () => {
  const rows = [lot({ _id: "a", qtyAvailable: 10, boeDate: "2024-01-01", customsLotId: "L" })];
  const { allocations, shortfall } = allocateQtyAcrossLotsFifo(rows, 10);
  assert.equal(shortfall, 0);
  assert.equal(allocations.length, 1);
  assert.equal(allocations[0].qty, 10);
  assert.equal(allocations[0].remainingAfter, 0);
});

run("Partial allocation leaves remaining", () => {
  const rows = [lot({ _id: "a", qtyAvailable: 10, boeDate: "2024-01-01", customsLotId: "L" })];
  const { allocations, shortfall } = allocateQtyAcrossLotsFifo(rows, 4);
  assert.equal(shortfall, 0);
  assert.equal(allocations[0].qty, 4);
  assert.equal(allocations[0].remainingAfter, 6);
});

run("Over-allocation reports shortfall", () => {
  const rows = [
    lot({ _id: "a", qtyAvailable: 5, boeDate: "2024-01-01", customsLotId: "L1" }),
    lot({ _id: "b", qtyAvailable: 3, boeDate: "2024-02-01", customsLotId: "L2" }),
  ];
  const { allocations, shortfall } = allocateQtyAcrossLotsFifo(rows, 20);
  assert.equal(allocations.reduce((s, a) => s + a.qty, 0), 8);
  assert.ok(shortfall > 11.9);
});

run("FIFO: supplier invoice date breaks BOE date ties", () => {
  const a = lot({
    _id: "late-si",
    boeDate: "2024-01-01",
    supplierInvoiceDate: "2024-01-15",
    customsLotId: "L2",
  });
  const b = lot({
    _id: "early-si",
    boeDate: "2024-01-01",
    supplierInvoiceDate: "2024-01-05",
    customsLotId: "L1",
  });
  assert.ok(compareCustomsFifoOrder(b, a) < 0);
  assert.equal(sortCustomsLotsForFifo([a, b])[0]._id, "early-si");
});

run("FIFO: received date then GRN created then lot id", () => {
  const base = { boeDate: "2024-01-01", supplierInvoiceDate: "2024-01-01" };
  const rows = sortCustomsLotsForFifo([
    lot({ ...base, _id: "c", receivedDate: "2024-01-10", grnCreatedAt: "2024-01-10", customsLotId: "Z" }),
    lot({ ...base, _id: "a", receivedDate: "2024-01-05", grnCreatedAt: "2024-01-08", customsLotId: "B" }),
    lot({ ...base, _id: "b", receivedDate: "2024-01-05", grnCreatedAt: "2024-01-06", customsLotId: "A" }),
  ]);
  assert.deepEqual(
    rows.map((r) => r._id),
    ["b", "a", "c"],
  );
});

run("Missing dates sort last", () => {
  const dated = lot({ _id: "d", boeDate: "2024-01-01", customsLotId: "L1" });
  const undated = lot({ _id: "u", boeDate: null, customsLotId: "L0" });
  assert.ok(compareCustomsFifoOrder(dated, undated) < 0);
});

run("customsService imports CG2 FIFO util (no hardcoded old order)", () => {
  const svc = fs.readFileSync(path.join(srcRoot, "services/customsService.js"), "utf8");
  assert.match(svc, /from ["'].*customsFifo\.js["']/);
  assert.match(svc, /sortCustomsLotsForFifo/);
  assert.match(svc, /allocateQtyAcrossLotsFifo/);
  assert.doesNotMatch(svc, /FIFO: dated lots first/);
});

run("Invoice service uses snapshots on cancel and preview", () => {
  const inv = fs.readFileSync(path.join(srcRoot, "services/customsInvoiceService.js"), "utf8");
  assert.match(inv, /previewCustomsAllocationFromSalesInvoice/);
  assert.match(inv, /do not recalculate FIFO/);
  assert.match(inv, /Cannot allocate from a closed customs lot/);
  assert.match(inv, /Cannot allocate customs stock from another company/);
  assert.match(inv, /Allocated qty cannot exceed remaining qty/);
  assert.match(inv, /CUSTOMS\.override/);
  assert.match(inv, /Idempotent: already posted/);
});

run("Reports service exposes BOE / lot / consumption / traceability", () => {
  const rep = fs.readFileSync(path.join(srcRoot, "services/customsAllocationReportsService.js"), "utf8");
  assert.match(rep, /reportBoeBalance/);
  assert.match(rep, /reportLotBalance/);
  assert.match(rep, /reportCustomsConsumption/);
  assert.match(rep, /reportCustomsTraceability/);
  assert.match(rep, /articleToBoe/);
  assert.match(rep, /boeToCustomer/);
});

run("Routes wire preview + allocation reports", () => {
  const routes = fs.readFileSync(path.join(srcRoot, "routes/customsRoutes.js"), "utf8");
  assert.match(routes, /preview-from-sales-invoice/);
  assert.match(routes, /reports\/boe-balance/);
  assert.match(routes, /reports\/lot-balance/);
  assert.match(routes, /reports\/consumption/);
  assert.match(routes, /reports\/traceability/);
});

run("Print HTML includes BOE Date and Supplier Invoice Date", () => {
  const printPath = path.join(__dirname, "../../src/lib/customsInvoicePrint.js");
  const print = fs.readFileSync(printPath, "utf8");
  assert.match(print, /BOE Date/);
  assert.match(print, /Supplier Invoice Date/);
  assert.match(print, /Allocated Qty/);
  assert.match(print, /HS Code/);
});

run("GRN / Packing / Dispatch / StockLedger not modified by CG2 FIFO util", () => {
  const fifo = fs.readFileSync(path.join(srcRoot, "utils/customsFifo.js"), "utf8");
  assert.doesNotMatch(fifo, /StockLedger|StorePacking|StoreDispatch|PurchaseInvoice|SupplierProforma/);
  assert.match(fifo, /CG2/);
});

run("RTS module remains absent", () => {
  const rtsCandidates = [
    path.join(srcRoot, "models/RTS.js"),
    path.join(srcRoot, "routes/rtsRoutes.js"),
    path.join(srcRoot, "controllers/rtsController.js"),
  ];
  for (const p of rtsCandidates) {
    assert.equal(fs.existsSync(p), false, `RTS file should not exist: ${p}`);
  }
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
