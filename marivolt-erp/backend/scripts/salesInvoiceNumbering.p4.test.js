/**
 * P4 — Sales Invoice number safety + controlled renaming.
 * Final AR policy: AR existence BLOCKS rename (Customer Statement uses documentNo snapshot).
 * Run: node scripts/salesInvoiceNumbering.p4.test.js
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "path";
import { fileURLToPath } from "node:url";
import {
  applyManualSalesDocumentNumber,
  bumpSalesDocumentCounterToAtLeast,
  generateSalesDocumentNumber,
  validateManualSalesDocumentNumber,
} from "../src/utils/salesDocNumber.js";
import { assertSalesDocumentNumberChangeAllowed } from "../src/utils/salesDocumentNumberChangeGuard.js";
import { evaluateSalesInvoiceNumberEditability } from "../src/utils/salesInvoiceNumberEdit.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcRoot = path.join(__dirname, "..", "src");

let passed = 0;
let failed = 0;

async function run(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed += 1;
    console.error(`  ✗ ${name}`);
    console.error(`    ${e.message}`);
  }
}

function createMemoryCounter() {
  const map = new Map();
  let chain = Promise.resolve();
  const keyOf = (filter) => `${String(filter.companyId)}::${String(filter.key)}`;
  function applyUpdate(filter, update) {
    const k = keyOf(filter);
    let seq = map.has(k) ? map.get(k) : null;
    if (seq == null) seq = 0;
    if (update?.$inc?.seq != null) seq += Number(update.$inc.seq) || 0;
    if (update?.$max?.seq != null) seq = Math.max(seq, Number(update.$max.seq) || 0);
    map.set(k, seq);
    return { companyId: filter.companyId, key: filter.key, seq };
  }
  return {
    findOne(filter) {
      const k = keyOf(filter);
      const seq = map.has(k) ? map.get(k) : null;
      const doc = seq == null ? null : { companyId: filter.companyId, key: filter.key, seq };
      return {
        lean: async () => doc,
        then: (resolve, reject) => Promise.resolve(doc).then(resolve, reject),
      };
    },
    findOneAndUpdate(filter, update) {
      const job = chain.then(async () => {
        await new Promise((r) => setImmediate(r));
        return applyUpdate(filter, update);
      });
      chain = job.then(
        () => undefined,
        () => undefined
      );
      return job;
    },
    async getSeq(companyId, key) {
      return map.get(`${String(companyId)}::${String(key)}`) ?? 0;
    },
  };
}

function createModelStore() {
  const rows = [];
  return {
    rows,
    async exists(filter) {
      return rows.some((r) => {
        if (String(r.companyId) !== String(filter.companyId)) return false;
        for (const [k, v] of Object.entries(filter)) {
          if (k === "companyId") continue;
          if (k === "_id" && v && typeof v === "object" && v.$ne) {
            if (String(r._id) === String(v.$ne)) return false;
            continue;
          }
          if (String(r[k]) !== String(v)) return false;
        }
        return true;
      });
    },
    add(row) {
      rows.push(row);
    },
  };
}

/** No blocking dependencies including AR. */
const noneDeps = {
  ar: async () => false,
  payment: async () => false,
  salesReturn: async () => false,
  salesDispatch: async () => false,
  storeDispatch: async () => false,
  cipl: async () => false,
  customs: async () => false,
  shipment: async () => false,
};

function baseInvoice(overrides = {}) {
  return {
    _id: "si1",
    invoiceNo: "SI/260809.01",
    documentStatus: "ISSUED",
    paymentStatus: "UNPAID",
    dispatchStatus: "NOT_DISPATCHED",
    totalReceivedAmount: 0,
    ...overrides,
  };
}

console.log("\nSales Invoice numbering (P4 — controlled rename, AR blocks)\n");

await run("CASE A — ISSUED + UNPAID + AR only → rename blocked", async () => {
  const r = await evaluateSalesInvoiceNumberEditability({
    companyId: "c",
    salesInvoice: baseInvoice(),
    existsFns: { ...noneDeps, ar: async () => true },
  });
  assert.equal(r.allowed, false);
  assert.equal(r.dependencySummary.arExists, true);
  assert.match(r.reason, /Accounts Receivable entry already exists/i);
  assert.equal(r.numberEditability.allowed, false);
});

await run("Safe rename — no AR and no downstream", async () => {
  const r = await evaluateSalesInvoiceNumberEditability({
    companyId: "c",
    salesInvoice: baseInvoice({ documentStatus: "DRAFT" }),
    existsFns: noneDeps,
  });
  assert.equal(r.allowed, true);
  assert.equal(r.dependencySummary.arExists, false);
  assert.equal(r.requiresReason, true);
});

await run("CASE B — AR reversal lookup uses linkedInvoiceId (not invoiceNo)", () => {
  const ar = fs.readFileSync(path.join(srcRoot, "services", "customerReceivableService.js"), "utf8");
  assert.ok(ar.includes("linkedInvoiceId: invoice._id"));
  assert.ok(ar.includes('movementType: "SALES_INVOICE"'));
  // reverse finds original by ID
  const reverseIdx = ar.indexOf("export async function reverseSalesInvoiceReceivable");
  const reverseBlock = ar.slice(reverseIdx, reverseIdx + 800);
  assert.ok(reverseBlock.includes("linkedInvoiceId: invoice._id"));
  assert.ok(!reverseBlock.includes("documentNo: invoice.invoiceNo,\n    movementType: \"SALES_INVOICE\""));
  // Find query must not use invoiceNo
  assert.ok(reverseBlock.includes("CustomerLedger.findOne"));
  assert.ok(!/findOne\(\{[^}]*invoiceNo/s.test(reverseBlock));
});

await run("CASE C — Customer Statement displays CustomerLedger.documentNo snapshot", () => {
  const ui = fs.readFileSync(
    path.join(srcRoot, "..", "..", "src", "components", "accounts", "CustomerStatementTab.jsx"),
    "utf8"
  );
  assert.ok(ui.includes("r.documentNo"));
  const accounts = fs.readFileSync(path.join(srcRoot, "..", "..", "src", "pages", "Accounts.jsx"), "utf8");
  assert.ok(accounts.includes("r.documentNo") || accounts.includes("documentNo"));
  // Posting writes snapshot at create time
  const ar = fs.readFileSync(path.join(srcRoot, "services", "customerReceivableService.js"), "utf8");
  assert.ok(ar.includes("documentNo: invoice.invoiceNo || \"\""));
});

await run("CASE D — payment already exists → rename rejected", async () => {
  let r = await evaluateSalesInvoiceNumberEditability({
    companyId: "c",
    salesInvoice: baseInvoice({ paymentStatus: "PARTIALLY_PAID", totalReceivedAmount: 10 }),
    existsFns: noneDeps,
  });
  assert.equal(r.allowed, false);
  assert.match(r.reason, /payment/i);

  r = await evaluateSalesInvoiceNumberEditability({
    companyId: "c",
    salesInvoice: baseInvoice(),
    existsFns: { ...noneDeps, payment: async () => true },
  });
  assert.equal(r.allowed, false);
  assert.match(r.reason, /payment receipt/i);
});

await run("CASE E — same-number unchanged, no counter bump", async () => {
  const CounterModel = createMemoryCounter();
  const companyId = "company-mar";
  await bumpSalesDocumentCounterToAtLeast({
    companyId,
    documentType: "SI",
    dateToken: "260809",
    sequence: 5,
    CounterModel,
  });
  const model = createModelStore();
  model.add({ companyId, invoiceNo: "SI/260809.05", _id: "si1" });
  const prepared = await applyManualSalesDocumentNumber({
    companyId,
    documentType: "SI",
    value: "  si/260809.05  ",
    model,
    field: "invoiceNo",
    excludeId: "si1",
    previousNumber: "SI/260809.05",
    CounterModel,
  });
  assert.equal(prepared.unchanged, true);
  assert.equal(await CounterModel.getSeq(companyId, "salesdoc:SI:260809"), 5);
});

await run("CASE F — legacy MAR-SI with AR follows same block", async () => {
  const r = await evaluateSalesInvoiceNumberEditability({
    companyId: "c",
    salesInvoice: baseInvoice({ invoiceNo: "MAR-SI-0012" }),
    existsFns: { ...noneDeps, ar: async () => true },
  });
  assert.equal(r.allowed, false);
  assert.match(r.reason, /Accounts Receivable/i);
});

await run("Legacy MAR-SI without AR may rename", async () => {
  const r = await evaluateSalesInvoiceNumberEditability({
    companyId: "c",
    salesInvoice: baseInvoice({ invoiceNo: "MAR-SI-0012", documentStatus: "DRAFT" }),
    existsFns: noneDeps,
  });
  assert.equal(r.allowed, true);
});

await run("Sales return / dispatch / CIPL / customs / shipment / cancelled block", async () => {
  let r = await evaluateSalesInvoiceNumberEditability({
    companyId: "c",
    salesInvoice: baseInvoice(),
    existsFns: { ...noneDeps, salesReturn: async () => true },
  });
  assert.equal(r.allowed, false);

  r = await evaluateSalesInvoiceNumberEditability({
    companyId: "c",
    salesInvoice: baseInvoice(),
    existsFns: { ...noneDeps, salesDispatch: async () => true },
  });
  assert.equal(r.allowed, false);

  r = await evaluateSalesInvoiceNumberEditability({
    companyId: "c",
    salesInvoice: baseInvoice({ dispatchStatus: "PARTIALLY_DISPATCHED" }),
    existsFns: noneDeps,
  });
  assert.equal(r.allowed, false);

  r = await evaluateSalesInvoiceNumberEditability({
    companyId: "c",
    salesInvoice: baseInvoice(),
    existsFns: { ...noneDeps, cipl: async () => true },
  });
  assert.equal(r.allowed, false);

  r = await evaluateSalesInvoiceNumberEditability({
    companyId: "c",
    salesInvoice: baseInvoice(),
    existsFns: { ...noneDeps, customs: async () => true },
  });
  assert.equal(r.allowed, false);

  r = await evaluateSalesInvoiceNumberEditability({
    companyId: "c",
    salesInvoice: baseInvoice(),
    existsFns: { ...noneDeps, shipment: async () => true },
  });
  assert.equal(r.allowed, false);

  r = await evaluateSalesInvoiceNumberEditability({
    companyId: "c",
    salesInvoice: baseInvoice({ documentStatus: "CANCELLED" }),
    existsFns: noneDeps,
  });
  assert.equal(r.allowed, false);
});

await run("Safe rename + counter catch-up when no AR; rejected AR rename no bump", async () => {
  const CounterModel = createMemoryCounter();
  const companyId = "company-mar";
  await bumpSalesDocumentCounterToAtLeast({
    companyId,
    documentType: "SI",
    dateToken: "260809",
    sequence: 4,
    CounterModel,
  });
  const model = createModelStore();
  model.add({ companyId, invoiceNo: "SI/260809.01", _id: "si1" });

  await assertSalesDocumentNumberChangeAllowed({
    companyId,
    documentType: "SI",
    documentId: "si1",
    document: baseInvoice({ documentStatus: "DRAFT" }),
    existsFns: noneDeps,
  });

  const prepared = await applyManualSalesDocumentNumber({
    companyId,
    documentType: "SI",
    value: "SI/260809.20",
    model,
    field: "invoiceNo",
    excludeId: "si1",
    previousNumber: "SI/260809.01",
    CounterModel,
  });
  assert.equal(prepared.number, "SI/260809.20");
  assert.equal(await CounterModel.getSeq(companyId, "salesdoc:SI:260809"), 20);

  await assert.rejects(
    () =>
      assertSalesDocumentNumberChangeAllowed({
        companyId,
        documentType: "SI",
        documentId: "si2",
        document: baseInvoice({ _id: "si2" }),
        existsFns: { ...noneDeps, ar: async () => true },
      }),
    /Accounts Receivable/
  );
  assert.equal(await CounterModel.getSeq(companyId, "salesdoc:SI:260809"), 20);

  const next = await generateSalesDocumentNumber({
    companyId,
    documentType: "SI",
    referenceDate: new Date("2026-08-09T08:00:00.000Z"),
    CounterModel,
  });
  assert.equal(next, "SI/260809.21");
});

await run("Duplicate + company isolation + wrong prefix", async () => {
  const CounterModel = createMemoryCounter();
  const mar = createModelStore();
  mar.add({ companyId: "mar", invoiceNo: "SI/260809.10", _id: "si1" });
  await assert.rejects(
    () =>
      applyManualSalesDocumentNumber({
        companyId: "mar",
        documentType: "SI",
        value: "SI/260809.10",
        model: mar,
        field: "invoiceNo",
        excludeId: "si2",
        previousNumber: "SI/260809.01",
        CounterModel,
      }),
    /Sales Invoice number SI\/260809\.10 already exists/
  );

  const oke = createModelStore();
  const prepared = await applyManualSalesDocumentNumber({
    companyId: "oke",
    documentType: "SI",
    value: "SI/260809.10",
    model: oke,
    field: "invoiceNo",
    previousNumber: "SI/260809.01",
    CounterModel,
  });
  assert.equal(prepared.number, "SI/260809.10");

  assert.throws(
    () => validateManualSalesDocumentNumber({ value: "PI/260809.20", expectedDocumentType: "SI" }),
    /cannot use the PI prefix/i
  );
});

await run("Cancel path — stock referenceNo is write-only; payment cancel uses invoice _id", () => {
  const sales = fs.readFileSync(path.join(srcRoot, "controllers", "salesFlowController.js"), "utf8");
  const cancelIdx = sales.indexOf("export async function cancelSalesInvoice");
  const cancelBlock = sales.slice(cancelIdx, cancelIdx + 9000);
  // Payment aggregation uses allocations.targetId = inv._id
  assert.ok(cancelBlock.includes('"allocations.targetId": new mongoose.Types.ObjectId(inv._id)'));
  // AR reverse by service (ID-based)
  assert.ok(cancelBlock.includes("reverseSalesInvoiceReceivable"));
  // Legacy stock cancel writes referenceNo = current invoiceNo (assignment only, not lookup)
  assert.ok(cancelBlock.includes("referenceNo: inv.invoiceNo"));
  const stock = fs.readFileSync(path.join(srcRoot, "services", "stockService.js"), "utf8");
  const cancelInvoiceIdx = stock.indexOf("export async function cancelInvoice");
  const cancelInvoiceBlock = stock.slice(cancelInvoiceIdx, cancelInvoiceIdx + 1200);
  assert.ok(!cancelInvoiceBlock.includes("findOne"));
  assert.ok(cancelInvoiceBlock.includes("referenceNo"));
});

await run("Payment selection uses live SalesInvoice.invoiceNo by document prop", () => {
  const modal = fs.readFileSync(
    path.join(srcRoot, "..", "..", "src", "components", "accounts", "ReceivePaymentModal.jsx"),
    "utf8"
  );
  assert.ok(modal.includes("document?.invoiceNo"));
});

await run("Live sources — AR block reason + dedicated endpoint + no ledger cascade", () => {
  const sales = fs.readFileSync(path.join(srcRoot, "controllers", "salesFlowController.js"), "utf8");
  const routes = fs.readFileSync(path.join(srcRoot, "routes", "salesRoutes.js"), "utf8");
  const helper = fs.readFileSync(path.join(srcRoot, "utils", "salesInvoiceNumberEdit.js"), "utf8");

  assert.ok(sales.includes("updateSalesInvoiceNumber"));
  assert.ok(sales.includes("A reason is required to change the Sales Invoice number"));
  assert.ok(sales.includes("financialStateAtChange"));
  assert.ok(routes.includes("/sales-invoices/:id/invoice-no"));
  assert.ok(helper.includes("Accounts Receivable entry already exists"));
  assert.ok(helper.includes("AR existence BLOCKS rename"));
  assert.ok(helper.includes("CustomerLedger.exists"));

  assert.equal(sales.includes("CustomerLedger.updateMany"), false);
  assert.equal(sales.includes("PaymentReceipt.updateMany"), false);
  assert.ok(!/allowed = \[[^\]]*["']invoiceNo["']/s.test(sales));
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
