/**
 * Isolated replica-set integration tests for MAN price-list apply + quotation indexes.
 * Run: node scripts/manPriceList.integration.test.js
 */
import assert from "node:assert/strict";
import mongoose from "mongoose";
import XLSX from "xlsx";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import Company from "../src/models/Company.js";
import Customer from "../src/models/Customer.js";
import ItemMaster from "../src/models/itemMasterModel.js";
import ItemTechnical from "../src/models/itemTechnicalModel.js";
import ItemSupplier from "../src/models/itemSupplierModel.js";
import Supplier from "../src/models/Supplier.js";
import Quotation from "../src/models/Quotation.js";
import ManPriceList from "../src/models/ManPriceList.js";
import ManPriceListImport from "../src/models/ManPriceListImport.js";
import { previewImport, applyImport, getPriceListByArticle } from "../src/services/manPriceListService.js";
import { persistNewQuotation } from "../src/controllers/quotationController.js";
import { createQuotationFromManRfq, matchRfqLines } from "../src/services/manRfqService.js";
import { getDefaultPermissionsForRole } from "../src/services/roleService.js";
import {
  assertNoForbiddenSalesPriceKeys,
  displayedItemMasterSpn,
  displayedSupplier1,
  MAN_PRICE_LIST_HEADERS,
} from "../src/utils/manPriceList.js";
import { deriveAvailableQty } from "../src/services/stockExpectedBuckets.js";
import { getStockBalance } from "../src/services/stockService.js";

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

function xlsxFor(rows) {
  const headers = [...MAN_PRICE_LIST_HEADERS];
  const aoa = [headers, ...rows.map((row) => headers.map((h) => row[h] ?? ""))];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const force = new Set(["Article", "Part no", "Supplier part No.", "Supplier"]);
  for (let c = 0; c < headers.length; c += 1) {
    if (!force.has(headers[c])) continue;
    for (let r = 1; r < aoa.length; r += 1) {
      const addr = XLSX.utils.encode_cell({ r, c });
      if (!ws[addr]) continue;
      const text = String(aoa[r][c] ?? "");
      ws[addr].t = "s";
      ws[addr].v = text;
      ws[addr].w = text;
    }
  }
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
  return Buffer.from(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));
}

async function seedArticle(companyId, article, extras = {}) {
  const item = await ItemMaster.create({
    companyId,
    article,
    itemName: extras.itemName || article,
    description: extras.description || "desc",
    brand: "MAN",
    engine: "MAN",
    uom: "PCS",
    status: "Active",
    spn: extras.spn || "",
  });
  await ItemTechnical.create({
    companyId,
    article,
    spn: extras.techSpn || extras.spn || "",
  });
  return item;
}

console.log("\nMAN Price List integration (replica-set)\n");

let replset;
try {
  replset = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  await mongoose.connect(replset.getUri(), { serverSelectionTimeoutMS: 30000 });
  await Quotation.syncIndexes();
} catch (e) {
  console.error("Could not start isolated replica-set MongoDB:", e.message);
  process.exit(1);
}

const stamp = `${Date.now()}`;
const company = await Company.create({ name: `Man Test ${stamp}`, code: `MT${stamp.slice(-6)}`, isActive: true });
const companyB = await Company.create({ name: `Man Test B ${stamp}`, code: `MB${stamp.slice(-6)}`, isActive: true });
const req = {
  companyId: company._id,
  companyCode: company.code,
  user: { role: "admin", email: "admin@test.local", name: "Admin" },
};
const reqB = { ...req, companyId: companyB._id, companyCode: companyB.code };

await seedArticle(company._id, "A001", { spn: "OLD1", techSpn: "OLD1", description: "Filter" });
await seedArticle(company._id, "A002", { spn: "OLD2", techSpn: "OLD2", description: "Gasket" });
await Supplier.create({
  companyId: company._id,
  supplierCode: "ACME1",
  supplierName: "Acme",
  name: "Acme",
});

await run("Authoritative availability is getStockBalance.availableQty via deriveAvailableQty(onHand − max(allocated,reserved) − packed)", async () => {
  assert.equal(deriveAvailableQty({ onHandQty: 10, allocatedQty: 2, reservedQty: 3, packedQty: 1 }), 6);
  const empty = await getStockBalance({ companyId: company._id, article: "A001", warehouse: "MAIN" });
  assert.equal(empty.availableQty, 0);
  assert.equal(empty.warehouse, "MAIN");
});

await run("company_admin default matrix has no PRICE_LIST", () => {
  assert.deepEqual(getDefaultPermissionsForRole("company_admin").PRICE_LIST || [], []);
  assert.ok((getDefaultPermissionsForRole("admin").PRICE_LIST || []).includes("view"));
});

const failBuffer = xlsxFor([
  {
    Article: "A001",
    Description: "Filter-new",
    "Part no": "051.001",
    "Sell price": "10",
    "Supplier part No.": "SP-9",
    Supplier: "Acme",
    Cur: "USD",
  },
  {
    Article: "A002",
    Description: "Gasket-new",
    "Part no": "051.002",
    "Sell price": "11",
    Cur: "USD",
  },
]);
const failPreview = await previewImport(req, { buffer: failBuffer, filename: "fail.xlsx" });
if (!failPreview.canApply) {
  throw new Error(`fail preview not applyable: ${JSON.stringify(failPreview.errors)}`);
}

await run("Injected failure halfway through import rolls back Item Master, technical, price list, and import status", async () => {
  let threw = false;
  try {
    await applyImport(req, failPreview.previewId, { injectFailureAfter: 1 });
  } catch (e) {
    threw = true;
    assert.equal(e.code, "INJECTED_FAILURE");
  }
  assert.equal(threw, true);
  const item = await ItemMaster.findOne({ companyId: company._id, article: "A001" }).lean();
  const tech = await ItemTechnical.findOne({ companyId: company._id, article: "A001" }).lean();
  const item2 = await ItemMaster.findOne({ companyId: company._id, article: "A002" }).lean();
  const prices = await ManPriceList.countDocuments({ companyId: company._id });
  const preview = await ManPriceListImport.findById(failPreview.previewId).lean();
  assert.equal(item.description, "Filter");
  assert.equal(displayedItemMasterSpn(item, tech), "OLD1");
  assert.equal(item2.description, "Gasket");
  assert.equal(prices, 0);
  assert.equal(preview.status, "PREVIEW");
});

const staleBuffer = xlsxFor([
  {
    Article: "A001",
    Description: "Filter-stale",
    "Part no": "051.001",
    "Sell price": "22",
    "Supplier part No.": "SP-9",
    Supplier: "Acme",
    Cur: "USD",
  },
]);
const stalePreview = await previewImport(req, { buffer: staleBuffer, filename: "stale.xlsx" });
await ItemMaster.updateOne({ companyId: company._id, article: "A001" }, { $set: { description: "concurrent-edit" } });

await run("Concurrent edit invalidates preview without applying price or Supplier 1 P/N", async () => {
  let code = "";
  try {
    await applyImport(req, stalePreview.previewId);
  } catch (e) {
    code = e.code;
  }
  assert.equal(code, "STALE_PREVIEW");
  const item = await ItemMaster.findOne({ companyId: company._id, article: "A001" }).lean();
  const tech = await ItemTechnical.findOne({ companyId: company._id, article: "A001" }).lean();
  const supplier = await ItemSupplier.findOne({ companyId: company._id, article: "A001" }).lean();
  const price = await ManPriceList.findOne({ companyId: company._id, article: "A001" }).lean();
  assert.equal(item.description, "concurrent-edit");
  assert.equal(displayedItemMasterSpn(item, tech), "OLD1");
  assert.equal(supplier, null);
  assert.equal(price, null);
});

await ItemMaster.updateOne({ companyId: company._id, article: "A001" }, { $set: { description: "Filter" } });
const okBuffer = xlsxFor([
  {
    Article: "A001",
    Description: "Filter-ok",
    "Part no": "051.001",
    "Sell price": "15.5",
    "Supplier part No.": "SP-9",
    Supplier: "Acme",
    Cur: "USD",
    "Lead time": "8 Weeks",
  },
]);
const okPreview = await previewImport(req, { buffer: okBuffer, filename: "ok.xlsx" });
if (!okPreview.canApply) {
  throw new Error(`ok preview not applyable: ${JSON.stringify(okPreview.errors)}`);
}

await run("Successful apply writes ItemTechnical.spn and ItemSupplier Supplier 1 P/N", async () => {
  const result = await applyImport(req, okPreview.previewId);
  assert.equal(result.alreadyApplied, false);
  const item = await ItemMaster.findOne({ companyId: company._id, article: "A001" }).lean();
  const tech = await ItemTechnical.findOne({ companyId: company._id, article: "A001" }).lean();
  const suppliers = await ItemSupplier.find({ companyId: company._id, article: "A001" }).sort({ supplierName: 1 }).lean();
  assert.equal(displayedItemMasterSpn(item, tech), "051.001");
  assert.equal(tech.spn, "051.001");
  assert.equal(item.spn, "051.001");
  assert.equal(displayedSupplier1(suppliers[0], item).partNumber, "SP-9");
  assert.equal(displayedSupplier1(suppliers[0], item).name, "Acme");
  assert.equal(suppliers[0].supplierPartNumber, "SP-9");
});

await run("Concurrent apply of the same preview does not apply twice", async () => {
  const [a, b] = await Promise.allSettled([
    applyImport(req, okPreview.previewId),
    applyImport(req, okPreview.previewId),
  ]);
  const ok = [a, b].filter((x) => x.status === "fulfilled");
  assert.ok(ok.length >= 1);
  assert.ok(ok.every((x) => x.value?.alreadyApplied === true || Array.isArray(x.value?.applied)));
  assert.equal(await ManPriceList.countDocuments({ companyId: company._id, article: "A001" }), 1);
  const preview = await ManPriceListImport.findById(okPreview.previewId).lean();
  assert.equal(preview.status, "APPLIED");
});

const customer = await Customer.create({ companyId: company._id, name: "Cust One" });
const customerB = await Customer.create({ companyId: companyB._id, name: "Cust B" });

await run("Multiple ordinary quotations for the same company succeed and omit MAN key", async () => {
  const q1 = await persistNewQuotation(
    req,
    {
      customerId: customer._id,
      customerName: customer.name,
      sourceType: "MANUAL",
      lines: [{ article: "A001", description: "Filter-ok", uom: "PCS", qty: 1, price: 1 }],
    },
    { skipAutoCreateItems: true }
  );
  const q2 = await persistNewQuotation(
    req,
    {
      customerId: customer._id,
      customerName: customer.name,
      sourceType: "MANUAL",
      lines: [{ article: "A001", description: "Filter-ok", uom: "PCS", qty: 2, price: 1 }],
    },
    { skipAutoCreateItems: true }
  );
  const d1 = q1.toObject ? q1.toObject() : q1;
  const d2 = q2.toObject ? q2.toObject() : q2;
  assert.notEqual(String(d1._id), String(d2._id));
  assert.equal(d1.manRfqIdempotencyKey, undefined);
  assert.equal(d2.sourceType, "MANUAL");
  const indexed = await Quotation.collection.indexes();
  const manIdx = indexed.find((i) => i.name === "uniq_company_manRfqIdempotencyKey_manRfq");
  assert.ok(manIdx);
  assert.equal(manIdx.unique, true);
  assert.equal(manIdx.partialFilterExpression.sourceType, "MAN_RFQ");
  assert.equal(manIdx.sparse, undefined);
});

await run("Duplicate MAN requests reuse the same quotation; different payload is rejected; company scope is preserved", async () => {
  const price = await ManPriceList.findOne({ companyId: company._id, article: "A001" }).lean();
  const line = {
    selectedArticle: "A001",
    requestedPartNo: "051.001",
    qty: 1,
    uom: "PCS",
    priceTier: "SELL",
    unitPrice: 15.5,
    priceListRevision: price.revision,
    priceListUpdatedAt: price.updatedAt,
    exclude: false,
  };
  const first = await createQuotationFromManRfq(req, {
    idempotencyKey: "key-1",
    customerId: customer._id,
    customerName: customer.name,
    currency: "USD",
    lines: [line],
  });
  const second = await createQuotationFromManRfq(req, {
    idempotencyKey: "key-1",
    customerId: customer._id,
    customerName: customer.name,
    currency: "USD",
    lines: [line],
  });
  assert.equal(second.reused, true);
  assert.equal(String(first.quotation._id), String(second.quotation._id));
  assert.equal(second.quotation.lines[0].buy, undefined);
  assert.equal(second.quotation.lines[0].priceListId, undefined);

  let conflict = "";
  try {
    await createQuotationFromManRfq(req, {
      idempotencyKey: "key-1",
      customerId: customer._id,
      customerName: customer.name,
      currency: "USD",
      lines: [{ ...line, qty: 9 }],
    });
  } catch (e) {
    conflict = e.code;
  }
  assert.equal(conflict, "IDEMPOTENCY_CONFLICT");

  const otherItem = await seedArticle(companyB._id, "A001", { spn: "051.001", techSpn: "051.001" });
  await ManPriceList.create({
    companyId: companyB._id,
    itemMasterId: otherItem._id,
    article: "A001",
    sellPrice: 15.5,
    currency: "USD",
    revision: 1,
    isActive: true,
  });
  const otherPrice = await ManPriceList.findOne({ companyId: companyB._id, article: "A001" }).lean();
  const otherCo = await createQuotationFromManRfq(reqB, {
    idempotencyKey: "key-1",
    customerId: customerB._id,
    customerName: customerB.name,
    currency: "USD",
    lines: [{ ...line, priceListRevision: otherPrice.revision, priceListUpdatedAt: otherPrice.updatedAt }],
  });
  assert.notEqual(String(otherCo.quotation._id), String(first.quotation._id));
  assert.equal(String(otherCo.quotation.companyId), String(companyB._id));
});

await run("Concurrent duplicate MAN requests do not create two quotations", async () => {
  const price = await ManPriceList.findOne({ companyId: company._id, article: "A001" }).lean();
  const line = {
    selectedArticle: "A001",
    requestedPartNo: "051.001",
    qty: 3,
    uom: "PCS",
    priceTier: "SELL",
    unitPrice: 15.5,
    priceListRevision: price.revision,
    priceListUpdatedAt: price.updatedAt,
  };
  const results = await Promise.allSettled([
    createQuotationFromManRfq(req, {
      idempotencyKey: "key-concurrent",
      customerId: customer._id,
      customerName: customer.name,
      currency: "USD",
      lines: [line],
    }),
    createQuotationFromManRfq(req, {
      idempotencyKey: "key-concurrent",
      customerId: customer._id,
      customerName: customer.name,
      currency: "USD",
      lines: [line],
    }),
  ]);
  const ok = results.filter((r) => r.status === "fulfilled").map((r) => r.value);
  if (ok.length < 1) {
    throw new Error(results.map((r) => r.reason?.message || r.reason?.code).join("; "));
  }
  const ids = new Set(ok.map((r) => String(r.quotation._id)));
  assert.equal(ids.size, 1);
  assert.equal(
    await Quotation.countDocuments({ companyId: company._id, manRfqIdempotencyKey: "key-concurrent" }),
    1
  );
});

const salesReq = {
  companyId: company._id,
  companyCode: company.code,
  user: { role: "sales", email: "sales@test.local", name: "Sales" },
};

await ManPriceList.updateOne(
  { companyId: company._id, article: "A001" },
  { $set: { sellIi: 14, minm: 12, rock: 9, buy: 4, nextBuy: 3.2, supplierName: "Acme Hidden" } }
);
await seedArticle(company._id, "MAK1", {
  spn: "MAK-SPN",
  techSpn: "MAK-SPN",
  description: "Mak part",
});
await ItemMaster.updateOne(
  { companyId: company._id, article: "MAK1" },
  { $set: { brand: "MAK", engine: "MAK" } }
);
const bOnly = await seedArticle(companyB._id, "BONLY", { spn: "B-ONLY", techSpn: "B-ONLY" });
await ManPriceList.create({
  companyId: companyB._id,
  itemMasterId: bOnly._id,
  article: "BONLY",
  sellPrice: 40,
  currency: "USD",
  revision: 1,
  isActive: true,
});

await run("Admin Price List management still returns management ids; Sales match/create omit them", async () => {
  const mgmt = await getPriceListByArticle(req, "A001", { management: true });
  assert.ok(mgmt.id);
  assert.ok(mgmt.itemMasterId);
  assert.equal(mgmt.buy, 4);
  assert.equal(mgmt.nextBuy, 3.2);

  const matched = await matchRfqLines(salesReq, {
    lines: [{ partNo: "051.001", uom: "PCS", qty: 1 }],
    defaultTier: "SELL",
  });
  assert.equal(matched.lines[0].status, "MATCHED");
  assert.equal(matched.lines[0].selectedArticle, "A001");
  assert.equal(matched.lines[0].priceListId, undefined);
  assert.ok(Number(matched.lines[0].priceListRevision) > 0);
  assert.equal(matched.lines[0].candidates[0].prices.id, undefined);
  assert.equal(matched.lines[0].candidates[0].prices._id, undefined);
  assert.equal(matched.lines[0].candidates[0].prices.rock, null);
  assert.equal(matched.lines[0].buy, undefined);
  assert.equal(matched.lines[0].nextBuy, undefined);
  assertNoForbiddenSalesPriceKeys(matched, "sales match");

  const price = await ManPriceList.findOne({ companyId: company._id, article: "A001" }).lean();
  const created = await createQuotationFromManRfq(salesReq, {
    idempotencyKey: "key-no-pricelist-id",
    customerId: customer._id,
    customerName: customer.name,
    currency: "USD",
    lines: [
      {
        selectedArticle: "A001",
        requestedPartNo: "051.001",
        qty: 2,
        uom: "PCS",
        priceTier: "SELL",
        priceListRevision: price.revision,
      },
    ],
  });
  assert.equal(created.quotation.lines[0].price, 15.5);
  assert.equal(created.quotation.lines[0].priceListId, undefined);
  assert.equal(created.quotation.lines[0].buy, undefined);
  assertNoForbiddenSalesPriceKeys(created.quotation, "sales quotation");
  const stored = await Quotation.findById(created.quotation._id).lean();
  assert.ok(stored.lines[0].priceListId);
  assert.equal(Number(stored.lines[0].price), 15.5);
});

await run("Fabricated priceListId is ignored; client unit price and stale revision are rejected", async () => {
  const price = await ManPriceList.findOne({ companyId: company._id, article: "A001" }).lean();
  const base = {
    idempotencyKey: "key-fabricated-id",
    customerId: customer._id,
    customerName: customer.name,
    currency: "USD",
  };
  const line = {
    selectedArticle: "A001",
    requestedPartNo: "051.001",
    qty: 1,
    uom: "PCS",
    priceTier: "SELL",
    priceListRevision: price.revision,
    priceListId: "ffffffffffffffffffffffff",
  };
  const created = await createQuotationFromManRfq(salesReq, { ...base, lines: [line] });
  assert.equal(created.quotation.lines[0].price, 15.5);
  assertNoForbiddenSalesPriceKeys(created.quotation, "fabricated id quotation");
  const stored = await Quotation.findById(created.quotation._id).lean();
  assert.notEqual(String(stored.lines[0].priceListId), "ffffffffffffffffffffffff");
  assert.equal(String(stored.lines[0].priceListId), String(price._id));

  let unitCode = "";
  try {
    await createQuotationFromManRfq(salesReq, {
      ...base,
      idempotencyKey: "key-bad-unit",
      lines: [{ ...line, unitPrice: 99 }],
    });
  } catch (e) {
    unitCode = e.code;
    assert.equal(e.article, "A001");
  }
  assert.equal(unitCode, "STALE_PRICE");

  let staleCode = "";
  try {
    await createQuotationFromManRfq(salesReq, {
      ...base,
      idempotencyKey: "key-stale-rev",
      lines: [{ ...line, priceListRevision: 999 }],
    });
  } catch (e) {
    staleCode = e.code;
    assert.equal(e.article, "A001");
  }
  assert.equal(staleCode, "STALE_PRICE");
});

await run("Cross-company, non-MAN, and Rock remain unavailable to Sales", async () => {
  const price = await ManPriceList.findOne({ companyId: company._id, article: "A001" }).lean();
  const header = {
    customerId: customer._id,
    customerName: customer.name,
    currency: "USD",
  };

  let cross = "";
  try {
    await createQuotationFromManRfq(salesReq, {
      ...header,
      idempotencyKey: "key-cross-company",
      lines: [{ selectedArticle: "BONLY", qty: 1, uom: "PCS", priceTier: "SELL", priceListRevision: 1 }],
    });
  } catch (e) {
    cross = e.message;
  }
  assert.match(cross, /not found/i);

  let nonMan = "";
  try {
    await createQuotationFromManRfq(salesReq, {
      ...header,
      idempotencyKey: "key-non-man",
      lines: [{ selectedArticle: "MAK1", qty: 1, uom: "PCS", priceTier: "SELL", priceListRevision: 1 }],
    });
  } catch (e) {
    nonMan = e.message;
  }
  assert.match(nonMan, /not MAN-eligible/i);

  let rock = "";
  try {
    await createQuotationFromManRfq(salesReq, {
      ...header,
      idempotencyKey: "key-rock-denied",
      lines: [
        {
          selectedArticle: "A001",
          qty: 1,
          uom: "PCS",
          priceTier: "ROCK",
          priceListRevision: price.revision,
        },
      ],
    });
  } catch (e) {
    rock = e.code;
  }
  assert.equal(rock, "TIER_DENIED");

  const sellIi = await createQuotationFromManRfq(salesReq, {
    ...header,
    idempotencyKey: "key-sell-ii",
    lines: [
      {
        selectedArticle: "A001",
        qty: 1,
        uom: "PCS",
        priceTier: "SELL_II",
        priceListRevision: price.revision,
      },
    ],
  });
  assert.equal(sellIi.quotation.lines[0].price, 14);
  assertNoForbiddenSalesPriceKeys(sellIi.quotation, "sell ii quotation");
});

await mongoose.disconnect();
if (replset) await replset.stop();

if (failed) {
  console.error(`\nmanPriceList.integration.test.js failed: ${failed} failed, ${passed} passed`);
  process.exit(1);
}
console.log(`\nmanPriceList.integration.test.js passed: ${passed}`);
