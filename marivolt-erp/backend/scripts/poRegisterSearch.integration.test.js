/**
 * Isolated Mongo tests for Purchase Order register PO-number / Article filters.
 * Run: node scripts/poRegisterSearch.integration.test.js
 */
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import PurchaseOrder from "../src/models/PurchaseOrder.js";
import { listPurchaseOrders } from "../src/controllers/purchaseController.js";

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

function invokeList(companyId, query = {}) {
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      json(body) {
        resolve({ status: this.statusCode, body });
      },
      status(code) {
        this.statusCode = code;
        return this;
      },
    };
    Promise.resolve(listPurchaseOrders({ companyId, query }, res)).catch(reject);
  });
}

console.log("\nPO register search (integration)\n");

const mongod = await MongoMemoryServer.create();
await mongoose.connect(mongod.getUri(), { serverSelectionTimeoutMS: 20000 });

const companyA = new mongoose.Types.ObjectId();
const companyB = new mongoose.Types.ObjectId();

async function seedPo(companyId, extras = {}) {
  const n = extras.poNumber || extras.poNo;
  const doc = await PurchaseOrder.create({
    companyId,
    poNo: extras.poNo || n,
    poNumber: extras.poNumber || n,
    supplierName: extras.supplierName || "Acme",
    status: extras.status || "DRAFT",
    currency: extras.currency || "USD",
    grandTotal: extras.grandTotal || 1,
    lines: extras.lines || [
      {
        article: extras.article || "A001",
        itemCode: extras.article || "A001",
        qty: 1,
        orderedQty: 1,
        unitPrice: 1,
      },
    ],
  });
  if (extras.createdAt) {
    await PurchaseOrder.collection.updateOne({ _id: doc._id }, { $set: { createdAt: extras.createdAt } });
  }
  return doc;
}

const po0201 = await seedPo(companyA, {
  poNumber: "MAR-PO-0201",
  poNo: "MAR-PO-0201",
  supplierName: "INX Novel",
  status: "DRAFT",
  article: "A001",
  createdAt: new Date("2026-09-20T10:00:00.000Z"),
});
const po0200 = await seedPo(companyA, {
  poNumber: "MAR-PO-0200",
  poNo: "MAR-PO-0200",
  supplierName: "NANJING GOLDEN INTERNATIONAL TRADE CO., LTD",
  status: "DRAFT",
  article: "EUR459",
  createdAt: new Date("2026-09-19T10:00:00.000Z"),
});
const po0199 = await seedPo(companyA, {
  poNumber: "MAR-PO-0199",
  poNo: "MAR-PO-0199",
  supplierName: "Sunjin Marine",
  status: "SENT",
  lines: [
    { article: "HEAD", itemCode: "HEAD", qty: 1, orderedQty: 1, unitPrice: 1 },
    { article: "BF-4488", itemCode: "BF-4488", qty: 2, orderedQty: 2, unitPrice: 10 },
  ],
  createdAt: new Date("2026-09-18T10:00:00.000Z"),
});
const otherCo = await seedPo(companyB, {
  poNumber: "MAR-PO-0201",
  poNo: "MAR-PO-0201",
  supplierName: "INX Novel",
  article: "A001",
  createdAt: new Date("2026-09-21T10:00:00.000Z"),
});
await seedPo(companyA, {
  poNumber: "MAR-PO-0301",
  poNo: "MAR-PO-0301",
  article: "800210",
  createdAt: new Date("2026-09-16T10:00:00.000Z"),
});
await seedPo(companyA, {
  poNumber: "MAR-PO-0302",
  poNo: "MAR-PO-0302",
  article: "1800210",
  createdAt: new Date("2026-09-15T10:00:00.000Z"),
});
await seedPo(companyA, {
  poNumber: "MAR-PO-0303",
  poNo: "MAR-PO-0303",
  article: "8002101",
  createdAt: new Date("2026-09-14T10:00:00.000Z"),
});
await seedPo(companyA, {
  poNumber: "MAR-PO-0304",
  poNo: "MAR-PO-0304",
  article: "800210-C",
  createdAt: new Date("2026-09-13T10:00:00.000Z"),
});
await seedPo(companyA, {
  poNumber: "MAR-PO-0305",
  poNo: "MAR-PO-0305",
  article: "911206822.C",
  createdAt: new Date("2026-09-12T10:00:00.000Z"),
});
await seedPo(companyA, {
  poNumber: "MAR-PO-0307",
  poNo: "MAR-PO-0307",
  article: "X800210",
  createdAt: new Date("2026-09-11T10:00:00.000Z"),
});
await PurchaseOrder.collection.insertOne({
  companyId: companyA,
  poNo: "MAR-PO-0306",
  poNumber: "MAR-PO-0306",
  supplierName: "Legacy Mixed Case",
  status: "DRAFT",
  currency: "USD",
  grandTotal: 1,
  createdAt: new Date("2026-09-17T10:00:00.000Z"),
  updatedAt: new Date("2026-09-17T10:00:00.000Z"),
  lines: [{ article: "legacy-art", itemCode: "legacy-art", qty: 1, orderedQty: 1, unitPrice: 1 }],
});

await run("Exact PO-number search finds one PO", async () => {
  const { body } = await invokeList(companyA, { poNumber: "MAR-PO-0201" });
  assert.equal(body.total, 1);
  assert.equal(body.items.length, 1);
  assert.equal(body.items[0].poNumber, "MAR-PO-0201");
  assert.equal(String(body.items[0]._id), String(po0201._id));
});

await run("Partial PO-number search finds the expected POs", async () => {
  const byTail = await invokeList(companyA, { poNumber: "0201" });
  assert.equal(byTail.body.total, 1);
  assert.equal(byTail.body.items[0].poNumber, "MAR-PO-0201");
  const byMid = await invokeList(companyA, { poNumber: "PO-020" });
  assert.equal(byMid.body.total, 2);
  assert.deepEqual(
    byMid.body.items.map((p) => p.poNumber).sort(),
    ["MAR-PO-0200", "MAR-PO-0201"]
  );
});

await run("PO-number search is case-insensitive", async () => {
  const { body } = await invokeList(companyA, { poNumber: "mar-po-0201" });
  assert.equal(body.total, 1);
  assert.equal(body.items[0].poNumber, "MAR-PO-0201");
});

await run("Leading/trailing spaces are normalized", async () => {
  const { body } = await invokeList(companyA, { poNumber: "  MAR-PO-0201  ", article: "  a001  " });
  assert.equal(body.total, 1);
  assert.equal(body.items[0].poNumber, "MAR-PO-0201");
});

await run("Exact Article search finds every PO containing that Article", async () => {
  const { body } = await invokeList(companyA, { article: "A001" });
  assert.equal(body.total, 1);
  assert.equal(body.items[0].poNumber, "MAR-PO-0201");
});

await run("Article in the second or later PO line is found", async () => {
  const { body } = await invokeList(companyA, { article: "BF-4488" });
  assert.equal(body.total, 1);
  assert.equal(body.items[0].poNumber, "MAR-PO-0199");
  assert.equal(body.items[0].lines[1].article, "BF-4488");
});

await run("An unrelated Article returns no records", async () => {
  const { body } = await invokeList(companyA, { article: "NO-SUCH-ART" });
  assert.equal(body.total, 0);
  assert.equal(body.items.length, 0);
});

await run("PO Number + Article requires both conditions", async () => {
  const miss = await invokeList(companyA, { poNumber: "0201", article: "EUR459" });
  assert.equal(miss.body.total, 0);
  const hit = await invokeList(companyA, { poNumber: "0201", article: "A001" });
  assert.equal(hit.body.total, 1);
  assert.equal(hit.body.items[0].poNumber, "MAR-PO-0201");
});

await run("New filters combine correctly with Supplier", async () => {
  const { body } = await invokeList(companyA, { poNumber: "020", supplierName: "Nanjing" });
  assert.equal(body.total, 1);
  assert.equal(body.items[0].poNumber, "MAR-PO-0200");
});

await run("New filters combine correctly with Status", async () => {
  const sent = await invokeList(companyA, { article: "BF-4488", status: "SENT" });
  assert.equal(sent.body.total, 1);
  const draft = await invokeList(companyA, { article: "BF-4488", status: "DRAFT" });
  assert.equal(draft.body.total, 0);
});

await run("Pagination total reflects filtered results and newest PO first", async () => {
  const page1 = await invokeList(companyA, { poNumber: "PO-020", page: "1", limit: "1" });
  assert.equal(page1.body.total, 2);
  assert.equal(page1.body.page, 1);
  assert.equal(page1.body.limit, 1);
  assert.equal(page1.body.items.length, 1);
  assert.equal(page1.body.items[0].poNumber, "MAR-PO-0201");
  const page2 = await invokeList(companyA, { poNumber: "PO-020", page: "2", limit: "1" });
  assert.equal(page2.body.total, 2);
  assert.equal(page2.body.items[0].poNumber, "MAR-PO-0200");
});

await run("Another company’s matching PO number/Article is never returned", async () => {
  const { body } = await invokeList(companyA, { poNumber: "MAR-PO-0201", article: "A001" });
  assert.equal(body.total, 1);
  assert.equal(String(body.items[0].companyId), String(companyA));
  assert.notEqual(String(body.items[0]._id), String(otherCo._id));
  const other = await invokeList(companyB, { poNumber: "MAR-PO-0201", article: "A001" });
  assert.equal(other.body.total, 1);
  assert.equal(String(other.body.items[0]._id), String(otherCo._id));
});

await run("Regex characters in input are treated safely and cannot broaden the query", async () => {
  const { body } = await invokeList(companyA, { poNumber: ".*", article: "A001|" });
  assert.equal(body.total, 0);
});

await run("Exact alphanumeric Article matches case-insensitively", async () => {
  const { body } = await invokeList(companyA, { article: "a001" });
  assert.equal(body.total, 1);
  assert.equal(body.items[0].poNumber, "MAR-PO-0201");
  const legacy = await invokeList(companyA, { article: "LEGACY-ART" });
  assert.equal(legacy.body.total, 1);
  assert.equal(legacy.body.items[0].poNumber, "MAR-PO-0306");
  assert.equal(legacy.body.items[0].lines[0].article, "legacy-art");
});

await run("Exact numeric Article 800210 matches only 800210", async () => {
  const hit = await invokeList(companyA, { article: "800210" });
  assert.equal(hit.body.total, 1);
  assert.equal(hit.body.items[0].lines[0].article, "800210");
  assert.equal((await invokeList(companyA, { article: "1800210" })).body.total, 1);
  assert.equal((await invokeList(companyA, { article: "8002101" })).body.total, 1);
  assert.equal((await invokeList(companyA, { article: "800210-C" })).body.total, 1);
  const onlyExact = hit.body.items[0].poNumber;
  assert.equal(onlyExact, "MAR-PO-0301");
  assert.notEqual((await invokeList(companyA, { article: "800210" })).body.items[0].poNumber, "MAR-PO-0302");
});

await run("800210 does not match 1800210, 8002101, 800210-C or X800210", async () => {
  const { body } = await invokeList(companyA, { article: "800210" });
  const numbers = body.items.map((p) => p.poNumber);
  assert.equal(numbers.includes("MAR-PO-0301"), true);
  assert.equal(numbers.includes("MAR-PO-0302"), false);
  assert.equal(numbers.includes("MAR-PO-0303"), false);
  assert.equal(numbers.includes("MAR-PO-0304"), false);
  assert.equal(numbers.includes("MAR-PO-0307"), false);
  assert.equal(body.total, 1);
});

await run("Client companyId in the query cannot cross company isolation", async () => {
  const { body, status } = await invokeList(companyA, {
    poNumber: "MAR-PO-0201",
    companyId: String(companyB),
  });
  assert.equal(status, 200);
  assert.equal(body.total, 1);
  assert.equal(String(body.items[0].companyId), String(companyA));
  assert.notEqual(String(body.items[0]._id), String(otherCo._id));
});

await run("Exact dotted Article 911206822.C matches", async () => {
  const { body } = await invokeList(companyA, { article: "911206822.C" });
  assert.equal(body.total, 1);
  assert.equal(body.items[0].poNumber, "MAR-PO-0305");
});

await run("Malformed object and array article/poNumber return INVALID_FILTER", async () => {
  const obj = await invokeList(companyA, { article: { $regex: ".*" } });
  assert.equal(obj.status, 400);
  assert.equal(obj.body.code, "INVALID_FILTER");
  const arr = await invokeList(companyA, { poNumber: ["0201", ".*"] });
  assert.equal(arr.status, 400);
  assert.equal(arr.body.code, "INVALID_FILTER");
});

await run("Empty filters preserve existing listing behavior", async () => {
  const { body } = await invokeList(companyA, {});
  assert.equal(body.total, 10);
  assert.equal(body.items[0].poNumber, "MAR-PO-0201");
  assert.equal(body.items[1].poNumber, "MAR-PO-0200");
  assert.equal(body.items[2].poNumber, "MAR-PO-0199");
});

await mongoose.disconnect();
await mongod.stop();

if (failed) {
  console.error(`\npoRegisterSearch.integration.test.js failed: ${failed} failed, ${passed} passed`);
  process.exit(1);
}
console.log(`\npoRegisterSearch.integration.test.js passed: ${passed}`);
