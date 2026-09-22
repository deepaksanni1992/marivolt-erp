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
import {
  previewImport,
  applyImport,
  getPriceListByArticle,
  listPriceList,
  upsertManualPrice,
} from "../src/services/manPriceListService.js";
import { persistNewQuotation } from "../src/controllers/quotationController.js";
import {
  createQuotationFromManRfq,
  getManItemSalesSnapshot,
  listManEngineModels,
  matchRfqLines as matchRfqLinesRaw,
} from "../src/services/manRfqService.js";
import { getDefaultPermissionsForRole } from "../src/services/roleService.js";
import {
  assertNoForbiddenSalesPriceKeys,
  displayedItemMasterSpn,
  displayedSupplier1,
  MAN_PRICE_LIST_HEADERS,
  redactQuotationForSalesApi,
  sanitizeCustomerQuotationPrint,
} from "../src/utils/manPriceList.js";
import { deriveAvailableQty } from "../src/services/stockExpectedBuckets.js";
import { getStockBalance } from "../src/services/stockService.js";

async function matchRfqLines(req, opts = {}) {
  return matchRfqLinesRaw(req, { currency: "USD", ...opts });
}

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
    brand: extras.brand || "MAN",
    engine: extras.engine || extras.brand || "MAN",
    model: extras.model || (extras.brand && extras.brand !== "MAN" ? "" : "21/31"),
    config: extras.config || "",
    uom: extras.uom || "PCS",
    status: extras.status || "Active",
    spn: extras.spn || "",
  });
  await ItemTechnical.create({
    companyId,
    article,
    spn: extras.techSpn || extras.spn || "",
    technicalSpecifications: extras.specs
      ? [{ specName: "SPECS", specValue: extras.specs }]
      : [],
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
const selected21 = { modelMode: "SELECTED", model: "21/31" };

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

await run("Successful apply writes prices only and does not overwrite Item Master", async () => {
  const result = await applyImport(req, okPreview.previewId);
  assert.equal(result.alreadyApplied, false);
  const item = await ItemMaster.findOne({ companyId: company._id, article: "A001" }).lean();
  const tech = await ItemTechnical.findOne({ companyId: company._id, article: "A001" }).lean();
  const suppliers = await ItemSupplier.find({ companyId: company._id, article: "A001" }).sort({ supplierName: 1 }).lean();
  const price = await ManPriceList.findOne({ companyId: company._id, article: "A001" }).lean();
  assert.equal(displayedItemMasterSpn(item, tech), "OLD1");
  assert.equal(tech.spn, "OLD1");
  assert.equal(item.spn, "OLD1");
  assert.equal(item.description, "Filter");
  assert.equal(suppliers.length, 0);
  assert.equal(Number(price.sellPrice), 15.5);
  assert.equal(price.leadTime, "8 Weeks");
});

await ItemMaster.updateOne(
  { companyId: company._id, article: "A001" },
  { $set: { spn: "051.001" } }
);
await ItemTechnical.updateOne(
  { companyId: company._id, article: "A001" },
  { $set: { spn: "051.001" } }
);

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
      esn: "ESN-EXISTING-1",
      vesselPlant: "",
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
  assert.equal(d1.esn, "ESN-EXISTING-1");
  assert.equal(d1.vesselPlant || "", "");
  assert.notEqual(d1.esn, d1.vesselPlant);
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
    header: selected21,
    lines: [line],
  });
  const second = await createQuotationFromManRfq(req, {
    idempotencyKey: "key-1",
    customerId: customer._id,
    customerName: customer.name,
    currency: "USD",
    header: selected21,
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
      header: selected21,
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
    header: selected21,
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
      header: selected21,
      lines: [line],
    }),
    createQuotationFromManRfq(req, {
      idempotencyKey: "key-concurrent",
      customerId: customer._id,
      customerName: customer.name,
      currency: "USD",
      header: selected21,
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
    headerMode: "SELECTED",
    headerModel: "21/31",
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
    header: selected21,
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

await run("Fabricated priceListId is ignored; client unit price is ignored; stale revision is rejected", async () => {
  const price = await ManPriceList.findOne({ companyId: company._id, article: "A001" }).lean();
  const base = {
    idempotencyKey: "key-fabricated-id",
    customerId: customer._id,
    customerName: customer.name,
    currency: "USD",
    header: selected21,
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

  const ignoredUnit = await createQuotationFromManRfq(salesReq, {
    ...base,
    idempotencyKey: "key-bad-unit",
    lines: [{ ...line, unitPrice: 99, totalPrice: 1 }],
  });
  assert.equal(ignoredUnit.quotation.lines[0].price, 15.5);
  assert.equal(ignoredUnit.quotation.lines[0].totalPrice, 15.5);

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
    modelMode: "SELECTED",
    model: "21/31",
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

await run("Distinct MAN models are company-scoped and exclude non-MAN brands", async () => {
  await seedArticle(company._id, "WART1", { brand: "Wärtsilä", engine: "Wärtsilä", model: "6L20", spn: "W-1", techSpn: "W-1" });
  await seedArticle(company._id, "MAKMOD", { brand: "MAK", engine: "MAK", model: "M32C", spn: "MK-1", techSpn: "MK-1" });
  await seedArticle(company._id, "M3240", { model: "32/40", spn: "M3240", techSpn: "M3240" });
  await ItemMaster.updateOne({ companyId: company._id, article: "M3240" }, { $set: { model: "  32/40  " } });
  const listed = await listManEngineModels(req);
  assert.ok(listed.models.includes("21/31"));
  assert.ok(listed.models.includes("32/40"));
  assert.equal(listed.models.includes("6L20"), false);
  assert.equal(listed.models.includes("M32C"), false);
  const otherCo = await listManEngineModels(reqB);
  assert.equal(otherCo.models.includes("32/40"), false);
});

async function seedPricedMan(article, extras = {}) {
  const item = await seedArticle(company._id, article, extras);
  await ManPriceList.create({
    companyId: company._id,
    itemMasterId: item._id,
    article,
    sellPrice: extras.sellPrice ?? 10,
    currency: extras.currency || "USD",
    revision: 1,
    isActive: true,
    leadTime: extras.leadTime || "8 Weeks",
  });
  return item;
}

await seedPricedMan("SP21", { spn: "SHARED-SPN", techSpn: "SHARED-SPN", model: "21/31", config: "Std", description: "Valve 21" });
await seedPricedMan("SP32", { spn: "SHARED-SPN", techSpn: "SHARED-SPN", model: "32/40", config: "DF", description: "Valve 32" });
await seedPricedMan("SP21B", { spn: "MULTI-ART", techSpn: "MULTI-ART", model: "21/31", description: "Alt A" });
await seedPricedMan("SP21C", { spn: "MULTI-ART", techSpn: "MULTI-ART", model: "21/31", description: "Alt B" });
await seedPricedMan("UOM21", { spn: "UOM-SPN", techSpn: "UOM-SPN", model: "21/31", uom: "SET", description: "Set item" });
await seedPricedMan("SPEC21", {
  spn: "SPEC-SPN",
  techSpn: "SPEC-SPN",
  model: "21/31",
  config: "Std",
  specs: "NBR",
  description: "Spec item",
});
await seedPricedMan("M4860", { spn: "ONLY-4860", techSpn: "ONLY-4860", model: "48/60", description: "48/60 only" });

await run("Header model fills blank RFQ lines; existing CSV without Engine Model still matches", async () => {
  const matched = await matchRfqLines(salesReq, {
    lines: [{ partNo: "SHARED-SPN", uom: "PCS", qty: 1 }],
    headerMode: "SELECTED",
    headerModel: "21/31",
  });
  assert.equal(matched.lines[0].status, "MATCHED");
  assert.equal(matched.lines[0].selectedArticle, "SP21");
  assert.equal(matched.lines[0].requestedModel, "");
  assert.equal(matched.lines[0].engineModel, "21/31");
  assert.equal(matched.lines[0].matchedEngineModel, "21/31");
});

await run("Header/line model conflict and mixed-model RFQ behaviour", async () => {
  const conflict = await matchRfqLines(salesReq, {
    lines: [{ partNo: "SHARED-SPN", uom: "PCS", qty: 1, engineModel: "32/40" }],
    headerMode: "SELECTED",
    headerModel: "21/31",
  });
  assert.equal(conflict.lines[0].status, "MODEL_CONFLICT");

  const mixedMissing = await matchRfqLines(salesReq, {
    lines: [{ partNo: "SHARED-SPN", uom: "PCS", qty: 1 }],
    headerMode: "MIXED",
  });
  assert.equal(mixedMissing.lines[0].status, "MODEL_REQUIRED");

  const mixedOk = await matchRfqLines(salesReq, {
    lines: [{ partNo: "SHARED-SPN", uom: "PCS", qty: 2, engineModel: "32/40" }],
    headerMode: "MIXED",
  });
  assert.equal(mixedOk.lines[0].status, "MATCHED");
  assert.equal(mixedOk.lines[0].selectedArticle, "SP32");
  assert.equal(mixedOk.lines[0].requestedModel, "32/40");
});

await run("Same SPN under different models; multiple Articles under one model; unspecified requires selection", async () => {
  let unknownHeader = "";
  try {
    await matchRfqLines(salesReq, {
      lines: [{ partNo: "SHARED-SPN", uom: "PCS", qty: 1 }],
      headerMode: "SELECTED",
      headerModel: "27/38",
    });
  } catch (e) {
    unknownHeader = e.code;
  }
  assert.equal(unknownHeader, "MAN_RFQ_MODEL_MISMATCH");

  const otherModel = await matchRfqLines(salesReq, {
    lines: [{ partNo: "SHARED-SPN", uom: "PCS", qty: 1 }],
    headerMode: "SELECTED",
    headerModel: "48/60",
  });
  assert.equal(otherModel.lines[0].status, "MODEL_MISMATCH");
  assert.ok(otherModel.lines[0].availableModels.includes("21/31"));
  assert.ok(otherModel.lines[0].availableModels.includes("32/40"));

  const multi = await matchRfqLines(salesReq, {
    lines: [{ partNo: "MULTI-ART", uom: "PCS", qty: 1 }],
    headerMode: "SELECTED",
    headerModel: "21/31",
  });
  assert.equal(multi.status || multi.lines[0].status, "MULTIPLE");
  assert.equal(multi.lines[0].selectedArticle, "");
  assert.equal(multi.lines[0].priceTier, undefined);
  assert.equal(multi.lines[0].unitPrice, undefined);
  assert.equal(multi.lines[0].candidates.length, 2);

  const unspecified = await matchRfqLines(salesReq, {
    lines: [{ partNo: "SHARED-SPN", uom: "PCS", qty: 1 }],
    headerMode: "UNSPECIFIED",
  });
  assert.equal(unspecified.lines[0].status, "MULTIPLE");
  assert.ok(unspecified.lines[0].availableModels.length >= 2);
});

await run("UOM conflict remains after model filtering", async () => {
  const uom = await matchRfqLines(salesReq, {
    lines: [{ partNo: "UOM-SPN", uom: "PCS", qty: 1 }],
    headerMode: "SELECTED",
    headerModel: "21/31",
  });
  assert.equal(uom.lines[0].status, "UOM_MISMATCH");
});

await run("Create revalidates model; snapshot survives later Item Master edits; sales snapshot has no purchase keys", async () => {
  let mismatch = "";
  try {
    await createQuotationFromManRfq(salesReq, {
      idempotencyKey: "key-model-revalidate",
      customerId: customer._id,
      customerName: customer.name,
      currency: "USD",
      header: { modelMode: "SELECTED", model: "21/31" },
      lines: [
        {
          selectedArticle: "SP32",
          requestedPartNo: "SHARED-SPN",
          requestedModel: "",
          qty: 1,
          uom: "PCS",
          priceTier: "SELL",
          priceListRevision: 1,
        },
      ],
    });
  } catch (e) {
    mismatch = e.code;
  }
  assert.equal(mismatch, "MAN_RFQ_MODEL_MISMATCH");

  const created = await createQuotationFromManRfq(salesReq, {
    idempotencyKey: "key-model-snapshot",
    customerId: customer._id,
    customerName: customer.name,
    currency: "USD",
    header: {
      modelMode: "SELECTED",
      model: "21/31",
      customerReference: "RFQ-99",
      vesselPlant: "MV Atlantic",
      esn: "ESN-7788",
      remarks: "Please quote",
    },
    lines: [
      {
        selectedArticle: "SP21",
        requestedPartNo: "SHARED-SPN",
        requestedModel: "21/31",
        customerEngineModel: "21/31",
        qty: 1,
        uom: "PCS",
        priceTier: "SELL",
        priceListRevision: 1,
      },
    ],
  });
  assert.equal(created.quotation.engine, "MAN");
  assert.equal(created.quotation.model, "21/31");
  assert.equal(created.quotation.vesselPlant, "MV Atlantic");
  assert.equal(created.quotation.esn, "ESN-7788");
  assert.notEqual(created.quotation.esn, created.quotation.vesselPlant);
  assert.equal(created.quotation.remarks, "Please quote");
  assert.equal(created.quotation.customerReference, "RFQ-99");
  assert.equal(created.quotation.lines[0].engineModel, "21/31");
  assert.equal(created.quotation.lines[0].customerEngineModel, "21/31");
  assert.equal(created.quotation.lines[0].config, "Std");
  assert.equal(created.quotation.lines[0].modelMatchStatus, "MATCHED");
  assertNoForbiddenSalesPriceKeys(created.quotation, "model snapshot quotation");

  await ItemMaster.updateOne({ companyId: company._id, article: "SP21" }, { $set: { model: "48/60", config: "Changed" } });
  const stored = await Quotation.findById(created.quotation._id).lean();
  assert.equal(stored.model, "21/31");
  assert.equal(stored.vesselPlant, "MV Atlantic");
  assert.equal(stored.esn, "ESN-7788");
  assert.notEqual(stored.esn, stored.vesselPlant);
  assert.equal(stored.lines[0].engineModel, "21/31");
  assert.equal(stored.lines[0].config, "Std");
  assert.equal(stored.lines[0].customerEngineModel, "21/31");
});

await run("SELECTED blank header is rejected on match and create; invalid mode is not defaulted", async () => {
  await ItemMaster.updateOne({ companyId: company._id, article: "SP21" }, { $set: { model: "21/31", config: "Std" } });
  let matchBlank = "";
  try {
    await matchRfqLines(salesReq, {
      lines: [{ partNo: "SHARED-SPN", uom: "PCS", qty: 1 }],
      headerMode: "SELECTED",
      headerModel: "",
    });
  } catch (e) {
    matchBlank = e.code;
  }
  assert.equal(matchBlank, "MAN_RFQ_MODEL_REQUIRED");

  let createBlank = "";
  try {
    await createQuotationFromManRfq(salesReq, {
      idempotencyKey: "key-selected-blank",
      customerId: customer._id,
      customerName: customer.name,
      currency: "USD",
      header: { modelMode: "SELECTED", model: "" },
      lines: [
        {
          selectedArticle: "SP21",
          requestedPartNo: "SHARED-SPN",
          qty: 1,
          uom: "PCS",
          priceTier: "SELL",
          priceListRevision: 1,
        },
      ],
    });
  } catch (e) {
    createBlank = e.code;
  }
  assert.equal(createBlank, "MAN_RFQ_MODEL_REQUIRED");

  let invalidMode = "";
  try {
    await matchRfqLines(salesReq, {
      lines: [{ partNo: "SHARED-SPN", uom: "PCS", qty: 1 }],
      headerMode: "ALL_MODELS",
      headerModel: "21/31",
    });
  } catch (e) {
    invalidMode = e.code;
  }
  assert.equal(invalidMode, "MAN_RFQ_MODEL_MODE_INVALID");

  let invalidCreate = "";
  try {
    await createQuotationFromManRfq(salesReq, {
      idempotencyKey: "key-invalid-mode",
      customerId: customer._id,
      customerName: customer.name,
      currency: "USD",
      header: { modelMode: "ALL_MODELS", model: "21/31" },
      lines: [
        {
          selectedArticle: "SP21",
          qty: 1,
          uom: "PCS",
          priceTier: "SELL",
          priceListRevision: 1,
        },
      ],
    });
  } catch (e) {
    invalidCreate = e.code;
  }
  assert.equal(invalidCreate, "MAN_RFQ_MODEL_MODE_INVALID");

  let missingBoth = "";
  try {
    await createQuotationFromManRfq(salesReq, {
      idempotencyKey: "key-missing-mode",
      customerId: customer._id,
      customerName: customer.name,
      currency: "USD",
      lines: [
        {
          selectedArticle: "SP21",
          qty: 1,
          uom: "PCS",
          priceTier: "SELL",
          priceListRevision: 1,
        },
      ],
    });
  } catch (e) {
    missingBoth = e.code;
  }
  assert.equal(missingBoth, "MAN_RFQ_MODEL_REQUIRED");

  const inferred = await matchRfqLines(salesReq, {
    lines: [{ partNo: "SHARED-SPN", uom: "PCS", qty: 1 }],
    headerModel: "21/31",
  });
  assert.equal(inferred.lines[0].status, "MATCHED");
  assert.equal(inferred.lines[0].selectedArticle, "SP21");
});

await run("SELECTED header/line and Article conflicts; MIXED and UNSPECIFIED create rules", async () => {
  let headerLine = "";
  try {
    await createQuotationFromManRfq(salesReq, {
      idempotencyKey: "key-header-line-conflict",
      customerId: customer._id,
      customerName: customer.name,
      currency: "USD",
      header: selected21,
      lines: [
        {
          selectedArticle: "SP21",
          requestedModel: "32/40",
          qty: 1,
          uom: "PCS",
          priceTier: "SELL",
          priceListRevision: 1,
        },
      ],
    });
  } catch (e) {
    headerLine = e.code;
  }
  assert.equal(headerLine, "MAN_RFQ_MODEL_CONFLICT");

  let mixedBlank = "";
  try {
    await createQuotationFromManRfq(salesReq, {
      idempotencyKey: "key-mixed-blank",
      customerId: customer._id,
      customerName: customer.name,
      currency: "USD",
      header: { modelMode: "MIXED", model: "" },
      lines: [
        {
          selectedArticle: "SP32",
          requestedModel: "",
          qty: 1,
          uom: "PCS",
          priceTier: "SELL",
          priceListRevision: 1,
        },
      ],
    });
  } catch (e) {
    mixedBlank = e.code;
  }
  assert.equal(mixedBlank, "MAN_RFQ_MODEL_REQUIRED");

  let mixedMismatch = "";
  try {
    await createQuotationFromManRfq(salesReq, {
      idempotencyKey: "key-mixed-mismatch",
      customerId: customer._id,
      customerName: customer.name,
      currency: "USD",
      header: { modelMode: "MIXED" },
      lines: [
        {
          selectedArticle: "SP21",
          requestedModel: "32/40",
          qty: 1,
          uom: "PCS",
          priceTier: "SELL",
          priceListRevision: 1,
        },
      ],
    });
  } catch (e) {
    mixedMismatch = e.code;
  }
  assert.equal(mixedMismatch, "MAN_RFQ_MODEL_MISMATCH");

  let unspecifiedNoArticle = "";
  try {
    await createQuotationFromManRfq(salesReq, {
      idempotencyKey: "key-unspecified-blank-article",
      customerId: customer._id,
      customerName: customer.name,
      currency: "USD",
      header: { modelMode: "UNSPECIFIED" },
      lines: [
        {
          selectedArticle: "",
          requestedPartNo: "SHARED-SPN",
          qty: 1,
          uom: "PCS",
          priceTier: "SELL",
          priceListRevision: 1,
        },
      ],
    });
  } catch (e) {
    unspecifiedNoArticle = e.code;
  }
  assert.equal(unspecifiedNoArticle, "MAN_RFQ_MODEL_REQUIRED");

  const mixedOk = await createQuotationFromManRfq(salesReq, {
    idempotencyKey: "key-mixed-ok",
    customerId: customer._id,
    customerName: customer.name,
    currency: "USD",
    header: { modelMode: "MIXED" },
    lines: [
      {
        selectedArticle: "SP32",
        requestedModel: "32/40",
        qty: 1,
        uom: "PCS",
        priceTier: "SELL",
        priceListRevision: 1,
      },
    ],
  });
  assert.equal(mixedOk.quotation.status, "DRAFT");
  assert.equal(mixedOk.quotation.model, "");
  assert.equal(mixedOk.quotation.manRfqModelMode, "MIXED");
  assert.equal(mixedOk.quotation.lines[0].engineModel, "32/40");
  assert.equal(mixedOk.quotation.sourceType, "MAN_RFQ");

  const unspecifiedOk = await createQuotationFromManRfq(salesReq, {
    idempotencyKey: "key-unspecified-ok",
    customerId: customer._id,
    customerName: customer.name,
    currency: "USD",
    header: { modelMode: "UNSPECIFIED" },
    lines: [
      {
        selectedArticle: "SP21",
        requestedPartNo: "SHARED-SPN",
        qty: 1,
        uom: "PCS",
        priceTier: "SELL",
        priceListRevision: 1,
      },
    ],
  });
  assert.equal(unspecifiedOk.quotation.status, "DRAFT");
  assert.equal(unspecifiedOk.quotation.model, "");
  assert.equal(unspecifiedOk.quotation.manRfqModelMode, "UNSPECIFIED");
  assert.equal(unspecifiedOk.quotation.lines[0].engineModel, "21/31");
  assert.equal(unspecifiedOk.quotation.lines[0].modelMatchStatus, "UNSPECIFIED");
});

await run("Create revalidates requested Configuration and Specifications independently", async () => {
  let cfg = "";
  try {
    await createQuotationFromManRfq(salesReq, {
      idempotencyKey: "key-config-conflict",
      customerId: customer._id,
      customerName: customer.name,
      currency: "USD",
      header: selected21,
      lines: [
        {
          selectedArticle: "SPEC21",
          configuration: "DF",
          qty: 1,
          uom: "PCS",
          priceTier: "SELL",
          priceListRevision: 1,
        },
      ],
    });
  } catch (e) {
    cfg = e.code;
  }
  assert.equal(cfg, "MAN_RFQ_CONFIG_CONFLICT");

  let spec = "";
  try {
    await createQuotationFromManRfq(salesReq, {
      idempotencyKey: "key-spec-conflict",
      customerId: customer._id,
      customerName: customer.name,
      currency: "USD",
      header: selected21,
      lines: [
        {
          selectedArticle: "SPEC21",
          specifications: "SS",
          qty: 1,
          uom: "PCS",
          priceTier: "SELL",
          priceListRevision: 1,
        },
      ],
    });
  } catch (e) {
    spec = e.code;
  }
  assert.equal(spec, "MAN_RFQ_SPEC_CONFLICT");

  const optionalOk = await createQuotationFromManRfq(salesReq, {
    idempotencyKey: "key-optional-cfg-spec",
    customerId: customer._id,
    customerName: customer.name,
    currency: "USD",
    header: selected21,
    lines: [
      {
        selectedArticle: "SPEC21",
        qty: 1,
        uom: "PCS",
        priceTier: "SELL",
        priceListRevision: 1,
      },
    ],
  });
  assert.equal(optionalOk.quotation.status, "DRAFT");
  assert.equal(optionalOk.quotation.lines[0].config, "Std");
  assert.equal(optionalOk.quotation.lines[0].specifications, "NBR");
  assert.equal(optionalOk.quotation.lines[0].engineModel, "21/31");
});

await seedPricedMan("MONEY76", {
  spn: "MONEY-76",
  techSpn: "MONEY-76",
  model: "21/31",
  description: "Float A",
  sellPrice: 109.76,
});
await seedPricedMan("MONEY20", {
  spn: "MONEY-20",
  techSpn: "MONEY-20",
  model: "21/31",
  description: "Float B",
  sellPrice: 459.2,
});

await run("RFQ and draft quotation money rounds 109.76×12 and 459.20×5 without float tails", async () => {
  const matched = await matchRfqLines(salesReq, {
    lines: [
      { partNo: "MONEY-76", uom: "PCS", qty: 12 },
      { partNo: "MONEY-20", uom: "PCS", qty: 5 },
    ],
    headerMode: "SELECTED",
    headerModel: "21/31",
  });
  assert.equal(matched.lines[0].unitPrice, 109.76);
  assert.equal(matched.lines[1].unitPrice, 459.2);
  assert.doesNotMatch(JSON.stringify(matched), /1317\.1200000000001/);

  const created = await createQuotationFromManRfq(salesReq, {
    idempotencyKey: "key-money-round",
    customerId: customer._id,
    customerName: customer.name,
    currency: "USD",
    header: selected21,
    lines: [
      {
        selectedArticle: "MONEY76",
        qty: 12,
        uom: "PCS",
        priceTier: "SELL",
        priceListRevision: 1,
        unitPrice: 109.76,
        totalPrice: 99999,
      },
      {
        selectedArticle: "MONEY20",
        qty: 5,
        uom: "PCS",
        priceTier: "SELL",
        priceListRevision: 1,
        unitPrice: 459.2,
        totalPrice: 1317.1200000000001,
      },
    ],
  });
  const quote = created.quotation;
  assert.equal(quote.status, "DRAFT");
  assert.equal(quote.lines[0].price, 109.76);
  assert.equal(quote.lines[0].totalPrice, 1317.12);
  assert.equal(quote.lines[1].price, 459.2);
  assert.equal(quote.lines[1].totalPrice, 2296);
  assert.equal(quote.subTotal, 3613.12);
  assert.equal(quote.discountTotal, 0);
  assert.equal(quote.taxTotal, 0);
  assert.equal(quote.grandTotal, 3613.12);
  assert.doesNotMatch(JSON.stringify(quote), /1317\.1200000000001/);

  const stored = await Quotation.findById(quote._id).lean();
  assert.equal(stored.status, "DRAFT");
  assert.equal(stored.lines[0].totalPrice, 1317.12);
  assert.equal(stored.lines[1].totalPrice, 2296);
  assert.equal(stored.subTotal, 3613.12);
  assert.equal(stored.grandTotal, 3613.12);
  assert.doesNotMatch(JSON.stringify(stored.lines.map((l) => l.totalPrice)), /1317\.1200000000001/);

  const retrieved = redactQuotationForSalesApi(stored);
  assert.equal(retrieved.lines[0].totalPrice, 1317.12);
  assert.equal(retrieved.grandTotal, 3613.12);
  assert.doesNotMatch(JSON.stringify(retrieved), /1317\.1200000000001/);

  const printed = sanitizeCustomerQuotationPrint(stored);
  assert.equal(printed.lines[0].totalPrice, 1317.12);
  assert.equal(printed.grandTotal, 3613.12);
  assert.doesNotMatch(JSON.stringify(printed), /1317\.1200000000001/);

  const ignoredClientTotal = await persistNewQuotation(
    req,
    {
      customerId: customer._id,
      customerName: customer.name,
      currency: "USD",
      engine: "MAN",
      lines: [
        {
          article: "MONEY76",
          description: "Float A",
          uom: "PCS",
          qty: 12,
          price: 109.76,
          totalPrice: 99999,
        },
      ],
    },
    { skipAutoCreateItems: true }
  );
  assert.equal(ignoredClientTotal.totalPrice ?? ignoredClientTotal.lines[0].totalPrice, 1317.12);
  assert.equal(ignoredClientTotal.subTotal, 1317.12);
  assert.equal(ignoredClientTotal.grandTotal, 1317.12);
});

await seedPricedMan("EUR459", {
  spn: "EUR-459",
  techSpn: "EUR-459",
  model: "21/31",
  description: "EUR priced A",
  sellPrice: 459.2,
  currency: "EUR",
});
await seedPricedMan("EUR109", {
  spn: "EUR-109",
  techSpn: "EUR-109",
  model: "21/31",
  description: "EUR priced B",
  sellPrice: 109.76,
  currency: "EUR",
});

async function manCreateCode(body) {
  try {
    const created = await createQuotationFromManRfq(salesReq, body);
    return { code: "", created };
  } catch (e) {
    return { code: e.code, statusCode: e.statusCode, created: null };
  }
}

const eurUsdLine = {
  selectedArticle: "EUR459",
  qty: 5,
  uom: "PCS",
  priceTier: "SELL",
  priceListRevision: 1,
};
const eurUsdFx = [
  {
    sourceCurrency: "EUR",
    targetCurrency: "USD",
    rate: 1.17,
    rateDate: "2026-09-20",
    note: "Management approved rate",
  },
];

await run("EUR price list + EUR quotation succeeds without a conversion rate", async () => {
  const eurMatch = await matchRfqLines(salesReq, {
    lines: [{ partNo: "EUR-459", uom: "PCS", qty: 5 }],
    headerMode: "SELECTED",
    headerModel: "21/31",
    currency: "EUR",
  });
  assert.equal(eurMatch.lines[0].status, "MATCHED");
  assert.equal(eurMatch.lines[0].unitPrice, 459.2);
  assert.equal(eurMatch.lines[0].sourceCurrency, "EUR");
  assert.equal(eurMatch.lines[0].conversionRate, 1);
  assertNoForbiddenSalesPriceKeys(eurMatch, "eur match");

  const created = await createQuotationFromManRfq(salesReq, {
    idempotencyKey: "key-eur-ok",
    customerId: customer._id,
    customerName: customer.name,
    currency: "EUR",
    header: selected21,
    lines: [{ selectedArticle: "EUR459", qty: 5, uom: "PCS", priceTier: "SELL", priceListRevision: 1 }],
  });
  assert.equal(created.quotation.currency, "EUR");
  assert.equal(created.quotation.lines[0].price, 459.2);
  assert.equal(created.quotation.lines[0].sourceUnitPrice, 459.2);
  assert.equal(created.quotation.lines[0].conversionRate, 1);
  assert.equal(created.quotation.grandTotal, 2296);
  assert.deepEqual(created.quotation.manRfqFxRates || [], []);
  assertNoForbiddenSalesPriceKeys(created.quotation, "eur quotation");
});

await run("Different currency with no rate is FX_RATE_REQUIRED on match", async () => {
  const usdMatch = await matchRfqLines(salesReq, {
    lines: [{ partNo: "EUR-459", uom: "PCS", qty: 5 }],
    headerMode: "SELECTED",
    headerModel: "21/31",
    currency: "USD",
  });
  assert.equal(usdMatch.lines[0].status, "FX_RATE_REQUIRED");
  assert.equal(usdMatch.lines[0].unitPrice, undefined);
  assert.equal(usdMatch.lines[0].sourceUnitPrice, 459.2);
  assert.equal(usdMatch.lines[0].sourceCurrency, "EUR");
  assert.match(usdMatch.lines[0].exclusionReason, /1 EUR = \[rate\] USD/);
  assertNoForbiddenSalesPriceKeys(usdMatch, "usd fx required match");
});

await run("Create without a required rate is CURRENCY_MISMATCH and inserts no quotation", async () => {
  const before = await Quotation.countDocuments({ companyId: company._id, sourceType: "MAN_RFQ" });
  const result = await manCreateCode({
    idempotencyKey: "key-eur-as-usd",
    customerId: customer._id,
    customerName: customer.name,
    currency: "USD",
    header: selected21,
    lines: [{ ...eurUsdLine, unitPrice: 459.2, totalPrice: 1, priceCurrency: "USD" }],
  });
  assert.equal(result.code, "CURRENCY_MISMATCH");
  assert.equal(result.statusCode, 409);
  assert.equal(await Quotation.countDocuments({ companyId: company._id, sourceType: "MAN_RFQ" }), before);
});

await run("Round converted unit price first then line total: EUR 459.20 × 1.1700 = USD 537.26 and × qty 5 = 2,686.30", async () => {
  const pricedMatch = await matchRfqLines(salesReq, {
    lines: [{ partNo: "EUR-459", uom: "PCS", qty: 5 }],
    headerMode: "SELECTED",
    headerModel: "21/31",
    currency: "USD",
    fxRates: eurUsdFx,
  });
  assert.equal(pricedMatch.lines[0].status, "MATCHED");
  assert.equal(pricedMatch.lines[0].sourceUnitPrice, 459.2);
  assert.equal(pricedMatch.lines[0].unitPrice, 537.26);
  assert.equal(pricedMatch.lines[0].conversionRate, 1.17);

  const stockBefore = await getStockBalance({
    companyId: company._id,
    article: "EUR459",
    warehouse: "MAIN",
  });
  const created = await createQuotationFromManRfq(salesReq, {
    idempotencyKey: "key-eur-usd-fx",
    customerId: customer._id,
    customerName: customer.name,
    currency: "USD",
    header: { ...selected21, quotationDate: "2026-09-20" },
    fxRates: [
      {
        ...eurUsdFx[0],
        enteredBy: "forged@evil.example",
        enteredAt: "2000-01-01T00:00:00.000Z",
      },
    ],
    lines: [
      {
        ...eurUsdLine,
        unitPrice: 1,
        totalPrice: 99999,
        price: 1,
        sourceUnitPrice: 99,
        convertedUnitPrice: 12,
        sourceCurrency: "AED",
        convertedCurrency: "GBP",
        conversionRate: 9,
        status: "MATCHED",
      },
    ],
  });
  const line = created.quotation.lines[0];
  assert.equal(created.quotation.currency, "USD");
  assert.equal(line.sourceCurrency, "EUR");
  assert.equal(line.sourceUnitPrice, 459.2);
  assert.equal(line.conversionRate, 1.17);
  assert.equal(line.convertedCurrency, "USD");
  assert.equal(line.convertedUnitPrice, 537.26);
  assert.equal(line.price, 537.26);
  assert.equal(line.totalPrice, 2686.3);
  assert.equal(created.quotation.grandTotal, 2686.3);
  const fx = created.quotation.manRfqFxRates[0];
  assert.equal(fx.sourceCurrency, "EUR");
  assert.equal(fx.targetCurrency, "USD");
  assert.equal(fx.rate, 1.17);
  assert.equal(fx.rateDate, "2026-09-20");
  assert.equal(fx.note, "Management approved rate");
  assert.equal(fx.enteredBy, "sales@test.local");
  assert.notEqual(fx.enteredBy, "forged@evil.example");
  assert.ok(fx.enteredAt);
  assert.notEqual(String(fx.enteredAt), "2000-01-01T00:00:00.000Z");
  assertNoForbiddenSalesPriceKeys(created.quotation, "converted quotation");
  const stockAfter = await getStockBalance({
    companyId: company._id,
    article: "EUR459",
    warehouse: "MAIN",
  });
  assert.equal(Number(stockAfter.availableQty) || 0, Number(stockBefore.availableQty) || 0);
});

await run("Customer print shows quotation-currency prices and strips FX audit, enteredBy and notes", async () => {
  const stored = await Quotation.findOne({ companyId: company._id, manRfqIdempotencyKey: "key-eur-usd-fx" }).lean();
  const sales = redactQuotationForSalesApi(stored);
  assert.equal(sales.lines[0].sourceUnitPrice, 459.2);
  assert.equal(sales.manRfqFxRates[0].enteredBy, "sales@test.local");
  assertNoForbiddenSalesPriceKeys(sales, "sales retrieval fx audit");
  const printed = sanitizeCustomerQuotationPrint(sales);
  assert.equal(printed.lines[0].price, 537.26);
  assert.equal(printed.lines[0].totalPrice, 2686.3);
  assert.equal(printed.lines[0].sourceUnitPrice, undefined);
  assert.equal(printed.lines[0].conversionRate, undefined);
  assert.equal(printed.lines[0].sourceCurrency, undefined);
  assert.deepEqual(printed.manRfqFxRates, []);
  assert.equal(printed.internalNotes, "");
  const blob = JSON.stringify(printed);
  assert.doesNotMatch(blob, /enteredBy/);
  assert.doesNotMatch(blob, /Management approved rate/);
  assert.doesNotMatch(blob, /"buy"/);
  assert.doesNotMatch(blob, /priceListId/);
});

await run("Saved quotation is unchanged after later price-list edits", async () => {
  const created = await Quotation.findOne({ companyId: company._id, manRfqIdempotencyKey: "key-eur-usd-fx" }).lean();
  await ManPriceList.updateOne({ companyId: company._id, article: "EUR459" }, { $set: { sellPrice: 999 } });
  const stored = await Quotation.findById(created._id).lean();
  assert.equal(stored.lines[0].price, 537.26);
  assert.equal(stored.lines[0].sourceUnitPrice, 459.2);
  await ManPriceList.updateOne({ companyId: company._id, article: "EUR459" }, { $set: { sellPrice: 459.2 } });
});

await run("Identical idempotency key and normalized rates reuse the same quotation", async () => {
  const created = await Quotation.findOne({ companyId: company._id, manRfqIdempotencyKey: "key-eur-usd-fx" }).lean();
  const reused = await createQuotationFromManRfq(salesReq, {
    idempotencyKey: "key-eur-usd-fx",
    customerId: customer._id,
    customerName: customer.name,
    currency: "USD",
    header: { ...selected21, quotationDate: "2026-09-20" },
    fxRates: eurUsdFx,
    lines: [eurUsdLine],
  });
  assert.equal(reused.reused, true);
  assert.equal(String(reused.quotation._id), String(created._id));
});

await run("Same idempotency key with a changed rate is IDEMPOTENCY_CONFLICT", async () => {
  const result = await manCreateCode({
    idempotencyKey: "key-eur-usd-fx",
    customerId: customer._id,
    customerName: customer.name,
    currency: "USD",
    header: selected21,
    fxRates: [{ sourceCurrency: "EUR", targetCurrency: "USD", rate: 1.2 }],
    lines: [eurUsdLine],
  });
  assert.equal(result.code, "IDEMPOTENCY_CONFLICT");
});

await run("Later RFQ with another FX rate does not mutate the saved quotation", async () => {
  const original = await Quotation.findOne({ companyId: company._id, manRfqIdempotencyKey: "key-eur-usd-fx" }).lean();
  const later = await createQuotationFromManRfq(salesReq, {
    idempotencyKey: "key-eur-usd-later-rate",
    customerId: customer._id,
    customerName: customer.name,
    currency: "USD",
    header: selected21,
    fxRates: [{ sourceCurrency: "EUR", targetCurrency: "USD", rate: 1.2 }],
    lines: [eurUsdLine],
  });
  assert.equal(later.quotation.lines[0].price, 551.04);
  const stored = await Quotation.findById(original._id).lean();
  assert.equal(stored.lines[0].price, 537.26);
  assert.equal(stored.manRfqFxRates[0].rate, 1.17);
});

await run("Same FX rates in a different array order do not create a false idempotency conflict", async () => {
  const a001 = await ManPriceList.findOne({ companyId: company._id, article: "A001" }).lean();
  const first = await createQuotationFromManRfq(salesReq, {
    idempotencyKey: "key-mixed-order",
    customerId: customer._id,
    customerName: customer.name,
    currency: "AED",
    header: selected21,
    fxRates: [
      { sourceCurrency: "EUR", targetCurrency: "AED", rate: 4.2 },
      { sourceCurrency: "USD", targetCurrency: "AED", rate: 3.67 },
    ],
    lines: [
      { selectedArticle: "EUR109", qty: 12, uom: "PCS", priceTier: "SELL", priceListRevision: 1 },
      { selectedArticle: "A001", qty: 1, uom: "PCS", priceTier: "SELL", priceListRevision: a001.revision },
    ],
  });
  const reused = await createQuotationFromManRfq(salesReq, {
    idempotencyKey: "key-mixed-order",
    customerId: customer._id,
    customerName: customer.name,
    currency: "AED",
    header: selected21,
    fxRates: [
      { sourceCurrency: "USD", targetCurrency: "AED", rate: 3.67 },
      { sourceCurrency: "EUR", targetCurrency: "AED", rate: 4.2 },
    ],
    lines: [
      { selectedArticle: "EUR109", qty: 12, uom: "PCS", priceTier: "SELL", priceListRevision: 1 },
      { selectedArticle: "A001", qty: 1, uom: "PCS", priceTier: "SELL", priceListRevision: a001.revision },
    ],
  });
  assert.equal(reused.reused, true);
  assert.equal(String(reused.quotation._id), String(first.quotation._id));
});

await run("Same idempotency key in another company remains company-scoped", async () => {
  const otherPrice = await ManPriceList.findOne({ companyId: companyB._id, article: "A001" }).lean();
  const otherCo = await createQuotationFromManRfq(reqB, {
    idempotencyKey: "key-eur-usd-fx",
    customerId: customerB._id,
    customerName: customerB.name,
    currency: "USD",
    header: selected21,
    lines: [
      {
        selectedArticle: "A001",
        qty: 1,
        uom: "PCS",
        priceTier: "SELL",
        priceListRevision: otherPrice.revision,
      },
    ],
  });
  const original = await Quotation.findOne({ companyId: company._id, manRfqIdempotencyKey: "key-eur-usd-fx" }).lean();
  assert.notEqual(String(otherCo.quotation._id), String(original._id));
  assert.equal(String(otherCo.quotation.companyId), String(companyB._id));
});

await run("Round converted unit price first then line total: EUR 109.76 × 1.1700 = USD 128.42 and multi-line subtotal", async () => {
  const multi = await createQuotationFromManRfq(salesReq, {
    idempotencyKey: "key-multi-eur",
    customerId: customer._id,
    customerName: customer.name,
    currency: "USD",
    header: selected21,
    fxRates: [{ sourceCurrency: "EUR", targetCurrency: "USD", rate: 1.17 }],
    lines: [
      { selectedArticle: "EUR459", qty: 5, uom: "PCS", priceTier: "SELL", priceListRevision: 1 },
      { selectedArticle: "EUR109", qty: 12, uom: "PCS", priceTier: "SELL", priceListRevision: 1 },
    ],
  });
  assert.equal(multi.quotation.lines[0].price, 537.26);
  assert.equal(multi.quotation.lines[0].totalPrice, 2686.3);
  assert.equal(multi.quotation.lines[1].price, 128.42);
  assert.equal(multi.quotation.lines[1].totalPrice, 1541.04);
  assert.equal(multi.quotation.lines[0].conversionRate, 1.17);
  assert.equal(multi.quotation.lines[1].conversionRate, 1.17);
  assert.equal(multi.quotation.subTotal, 4227.34);
});

await run("EUR → AED using a manually entered rate", async () => {
  const aed = await createQuotationFromManRfq(salesReq, {
    idempotencyKey: "key-eur-aed",
    customerId: customer._id,
    customerName: customer.name,
    currency: "AED",
    header: selected21,
    fxRates: [{ sourceCurrency: "EUR", targetCurrency: "AED", rate: 4.2, note: "desk rate" }],
    lines: [eurUsdLine],
  });
  assert.equal(aed.quotation.currency, "AED");
  assert.equal(aed.quotation.lines[0].price, 1928.64);
  assert.equal(aed.quotation.lines[0].totalPrice, 9643.2);
});

await run("Zero, negative, non-finite and malformed rates are rejected and create no quotation", async () => {
  const before = await Quotation.countDocuments({ companyId: company._id, sourceType: "MAN_RFQ" });
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, "nope", 1e8 + 1]) {
    const result = await manCreateCode({
      idempotencyKey: `key-bad-rate-${String(bad)}`,
      customerId: customer._id,
      customerName: customer.name,
      currency: "USD",
      header: selected21,
      fxRates: [{ sourceCurrency: "EUR", targetCurrency: "USD", rate: bad }],
      lines: [eurUsdLine],
    });
    assert.equal(result.code, "CURRENCY_MISMATCH", `expected reject for rate ${String(bad)}`);
  }
  assert.equal(await Quotation.countDocuments({ companyId: company._id, sourceType: "MAN_RFQ" }), before);
});

await run("Wrong target currency and inverted source→target pair are rejected", async () => {
  const wrongTarget = await manCreateCode({
    idempotencyKey: "key-wrong-target",
    customerId: customer._id,
    customerName: customer.name,
    currency: "USD",
    header: selected21,
    fxRates: [{ sourceCurrency: "EUR", targetCurrency: "AED", rate: 4.2 }],
    lines: [eurUsdLine],
  });
  assert.equal(wrongTarget.code, "CURRENCY_MISMATCH");
  const inverted = await manCreateCode({
    idempotencyKey: "key-wrong-pair",
    customerId: customer._id,
    customerName: customer.name,
    currency: "USD",
    header: selected21,
    fxRates: [{ sourceCurrency: "USD", targetCurrency: "EUR", rate: 1.17 }],
    lines: [eurUsdLine],
  });
  assert.equal(inverted.code, "CURRENCY_MISMATCH");
});

await run("Wrong unused source currency is rejected", async () => {
  const result = await manCreateCode({
    idempotencyKey: "key-wrong-source",
    customerId: customer._id,
    customerName: customer.name,
    currency: "USD",
    header: selected21,
    fxRates: [{ sourceCurrency: "AED", targetCurrency: "USD", rate: 0.27 }],
    lines: [eurUsdLine],
  });
  assert.equal(result.code, "CURRENCY_MISMATCH");
});

await run("Conflicting duplicate FX pairs are rejected; identical duplicates are first-wins", async () => {
  const conflict = await manCreateCode({
    idempotencyKey: "key-conflict-dup",
    customerId: customer._id,
    customerName: customer.name,
    currency: "USD",
    header: selected21,
    fxRates: [
      { sourceCurrency: "EUR", targetCurrency: "USD", rate: 1.17 },
      { sourceCurrency: "EUR", targetCurrency: "USD", rate: 1.2 },
    ],
    lines: [eurUsdLine],
  });
  assert.equal(conflict.code, "CURRENCY_MISMATCH");
  const ok = await createQuotationFromManRfq(salesReq, {
    idempotencyKey: "key-identical-dup",
    customerId: customer._id,
    customerName: customer.name,
    currency: "USD",
    header: selected21,
    fxRates: [
      { sourceCurrency: "EUR", targetCurrency: "USD", rate: 1.17 },
      { sourceCurrency: "eur", targetCurrency: "usd", rate: 1.17 },
    ],
    lines: [eurUsdLine],
  });
  assert.equal(ok.quotation.lines[0].conversionRate, 1.17);
  assert.equal(ok.quotation.manRfqFxRates.length, 1);
});

await run("One missing rate in mixed-source lines blocks the entire create", async () => {
  const a001 = await ManPriceList.findOne({ companyId: company._id, article: "A001" }).lean();
  const mixedMatch = await matchRfqLines(salesReq, {
    lines: [
      { partNo: "EUR-109", uom: "PCS", qty: 12 },
      { partNo: "051.001", uom: "PCS", qty: 1 },
    ],
    headerMode: "SELECTED",
    headerModel: "21/31",
    currency: "AED",
  });
  assert.equal(mixedMatch.lines[0].status, "FX_RATE_REQUIRED");
  assert.equal(mixedMatch.lines[0].sourceCurrency, "EUR");
  assert.equal(mixedMatch.lines[1].status, "FX_RATE_REQUIRED");
  assert.equal(mixedMatch.lines[1].sourceCurrency, "USD");

  const beforeMixed = await Quotation.countDocuments({ companyId: company._id, sourceType: "MAN_RFQ" });
  const mixedCreate = await manCreateCode({
    idempotencyKey: "key-mixed-aed-one-rate",
    customerId: customer._id,
    customerName: customer.name,
    currency: "AED",
    header: selected21,
    fxRates: [{ sourceCurrency: "EUR", targetCurrency: "AED", rate: 4.2 }],
    lines: [
      { selectedArticle: "EUR109", qty: 12, uom: "PCS", priceTier: "SELL", priceListRevision: 1 },
      { selectedArticle: "A001", qty: 1, uom: "PCS", priceTier: "SELL", priceListRevision: a001.revision },
    ],
  });
  assert.equal(mixedCreate.code, "CURRENCY_MISMATCH");
  assert.equal(await Quotation.countDocuments({ companyId: company._id, sourceType: "MAN_RFQ" }), beforeMixed);

  const mixedOk = await createQuotationFromManRfq(salesReq, {
    idempotencyKey: "key-mixed-aed-both-rates",
    customerId: customer._id,
    customerName: customer.name,
    currency: "AED",
    header: selected21,
    fxRates: [
      { sourceCurrency: "EUR", targetCurrency: "AED", rate: 4.2 },
      { sourceCurrency: "USD", targetCurrency: "AED", rate: 3.67 },
    ],
    lines: [
      { selectedArticle: "EUR109", qty: 12, uom: "PCS", priceTier: "SELL", priceListRevision: 1 },
      { selectedArticle: "A001", qty: 1, uom: "PCS", priceTier: "SELL", priceListRevision: a001.revision },
    ],
  });
  assert.equal(mixedOk.quotation.lines[0].convertedCurrency, "AED");
  assert.equal(mixedOk.quotation.lines[1].convertedCurrency, "AED");
  assert.equal(mixedOk.quotation.lines[0].conversionRate, 4.2);
  assert.equal(mixedOk.quotation.lines[1].conversionRate, 3.67);
  assert.equal(mixedOk.quotation.manRfqFxRates.length, 2);
});

await run("Excluded mismatched lines do not block create when remaining included lines are ready", async () => {
  const a001 = await ManPriceList.findOne({ companyId: company._id, article: "A001" }).lean();
  const created = await createQuotationFromManRfq(salesReq, {
    idempotencyKey: "key-exclude-usd-source",
    customerId: customer._id,
    customerName: customer.name,
    currency: "AED",
    header: selected21,
    fxRates: [{ sourceCurrency: "EUR", targetCurrency: "AED", rate: 4.2 }],
    lines: [
      { selectedArticle: "EUR109", qty: 12, uom: "PCS", priceTier: "SELL", priceListRevision: 1 },
      {
        selectedArticle: "A001",
        qty: 1,
        uom: "PCS",
        priceTier: "SELL",
        priceListRevision: a001.revision,
        exclude: true,
        exclusionReason: "currency",
      },
    ],
  });
  assert.equal(created.quotation.lines.length, 1);
  assert.equal(created.quotation.lines[0].article, "EUR109");
  assert.equal(created.quotation.currency, "AED");
});

await run("FX notes are clipped; 8-decimal rates persist; same-currency USD stays rate 1", async () => {
  const longNote = "n".repeat(240);
  const eight = await createQuotationFromManRfq(salesReq, {
    idempotencyKey: "key-8dp-note",
    customerId: customer._id,
    customerName: customer.name,
    currency: "USD",
    header: selected21,
    fxRates: [{ sourceCurrency: "EUR", targetCurrency: "USD", rate: 1.12345678, note: longNote }],
    lines: [eurUsdLine],
  });
  assert.equal(eight.quotation.manRfqFxRates[0].rate, 1.12345678);
  assert.equal(eight.quotation.manRfqFxRates[0].note.length, 200);
  const printed = sanitizeCustomerQuotationPrint(eight.quotation);
  assert.doesNotMatch(JSON.stringify(printed), /nnnn/);

  const usdLine = await matchRfqLines(salesReq, {
    lines: [{ partNo: "MONEY-76", uom: "PCS", qty: 12 }],
    headerMode: "SELECTED",
    headerModel: "21/31",
    currency: "USD",
  });
  assert.equal(usdLine.lines[0].unitPrice, 109.76);
  assert.equal(usdLine.lines[0].conversionRate, 1);
});

await run("Legacy/manual quotations without FX arrays still load and print", async () => {
  const manual = await persistNewQuotation(
    salesReq,
    {
      customerId: customer._id,
      customerName: customer.name,
      sourceType: "MANUAL",
      currency: "USD",
      lines: [{ article: "A001", description: "Filter-ok", uom: "PCS", qty: 2, price: 15.5 }],
    },
    { skipAutoCreateItems: true }
  );
  const row = manual.toObject ? manual.toObject() : manual;
  assert.equal(row.sourceType, "MANUAL");
  assert.deepEqual(row.manRfqFxRates || [], []);
  const printed = sanitizeCustomerQuotationPrint(row);
  assert.equal(printed.lines[0].price, 15.5);
  assert.equal(printed.lines[0].totalPrice, 31);
  assert.deepEqual(printed.manRfqFxRates, []);
});

await run("Sales snapshot omits purchase keys; match without currency is CURRENCY_REQUIRED", async () => {
  const snap = await getManItemSalesSnapshot(salesReq, "A001");
  assert.equal(snap.buy, undefined);
  assert.equal(snap.nextBuy, undefined);
  assert.equal(snap.prices?.buy, undefined);
  assertNoForbiddenSalesPriceKeys(snap, "sales item snapshot");
  let missing = "";
  try {
    await matchRfqLinesRaw(salesReq, {
      lines: [{ partNo: "EUR-459", uom: "PCS", qty: 1 }],
      headerMode: "SELECTED",
      headerModel: "21/31",
    });
  } catch (e) {
    missing = e.code;
  }
  assert.equal(missing, "CURRENCY_REQUIRED");
});

await run("Tier change reprices from the original tier source price and current rate", async () => {
  await ManPriceList.updateOne({ companyId: company._id, article: "EUR459" }, { $set: { sellIi: 400 } });
  const created = await createQuotationFromManRfq(salesReq, {
    idempotencyKey: "key-tier-sell-ii",
    customerId: customer._id,
    customerName: customer.name,
    currency: "USD",
    header: selected21,
    fxRates: [{ sourceCurrency: "EUR", targetCurrency: "USD", rate: 1.17 }],
    lines: [{ selectedArticle: "EUR459", qty: 5, uom: "PCS", priceTier: "SELL_II", priceListRevision: 1 }],
  });
  assert.equal(created.quotation.lines[0].sourceUnitPrice, 400);
  assert.equal(created.quotation.lines[0].convertedUnitPrice, 468);
  assert.equal(created.quotation.lines[0].price, 468);
  assert.equal(created.quotation.lines[0].totalPrice, 2340);
  await ManPriceList.updateOne({ companyId: company._id, article: "EUR459" }, { $unset: { sellIi: 1 } });
});

await seedArticle(company._id, "PL-ACT", { spn: "PL-ACT-SPN", techSpn: "PL-ACT-SPN", description: "Active import part" });
await seedArticle(company._id, "PL-DEAD", {
  spn: "PL-DEAD-SPN",
  techSpn: "PL-DEAD-SPN",
  description: "Inactive import part",
  status: "Inactive",
});
const histItem = await seedArticle(company._id, "PL-HIST", {
  spn: "PL-HIST-SPN",
  techSpn: "PL-HIST-SPN",
  description: "Historical inactive priced part",
  status: "Inactive",
});
await seedArticle(company._id, "PL-RACE", { spn: "PL-RACE-SPN", techSpn: "PL-RACE-SPN", description: "Race part" });
await seedArticle(companyB._id, "PL-OTHER", { spn: "PL-OTH-SPN", techSpn: "PL-OTH-SPN", description: "Other company" });
const historicalPrice = await ManPriceList.create({
  companyId: company._id,
  itemMasterId: histItem._id,
  article: "PL-HIST",
  sellPrice: 77,
  currency: "USD",
  source: "MANUAL",
  revision: 1,
  isActive: true,
});

async function masterSnapshot(article, companyId = company._id) {
  return {
    item: await ItemMaster.findOne({ companyId, article }).lean(),
    tech: await ItemTechnical.findOne({ companyId, article }).lean(),
    suppliers: await ItemSupplier.countDocuments({ companyId, article }),
    price: await ManPriceList.findOne({ companyId, article }).lean(),
  };
}

await run("Active Item Master Article passes Price List CSV preview", async () => {
  const before = await masterSnapshot("PL-ACT");
  const preview = await previewImport(req, {
    buffer: xlsxFor([{ Article: "pl-act", "Sell price": "12.5", Cur: "USD" }]),
    filename: "pl-active.xlsx",
  });
  assert.equal(preview.canApply, true);
  assert.equal((preview.errors || []).length, 0);
  assert.equal(preview.rows[0].article, "PL-ACT");
  assert.equal(preview.rows[0].inactiveArticle || false, false);
  const after = await masterSnapshot("PL-ACT");
  assert.equal(String(after.item.updatedAt), String(before.item.updatedAt));
  assert.equal(after.price, null);
});

await run("Inactive Article fails Price List preview with ARTICLE_INACTIVE and canApply false", async () => {
  const before = await masterSnapshot("PL-DEAD");
  const preview = await previewImport(req, {
    buffer: xlsxFor([{ Article: "PL-DEAD", "Sell price": "9", Cur: "USD" }]),
    filename: "pl-inactive.xlsx",
  });
  assert.equal(preview.canApply, false);
  const rowErr = (preview.errors || []).find((e) => e.article === "PL-DEAD");
  assert.equal(rowErr?.code, "ARTICLE_INACTIVE");
  assert.equal(rowErr?.message, "Article PL-DEAD is inactive in Item Master and cannot be used in Price List.");
  assert.equal(preview.rows[0].inactiveArticle, true);
  assert.equal(preview.rows[0].code, "ARTICLE_INACTIVE");
  const after = await masterSnapshot("PL-DEAD");
  assert.equal(after.price, null);
  assert.equal(String(after.item.status), "Inactive");
  assert.equal(after.suppliers, before.suppliers);
});

await run("Unknown Article still fails Price List preview", async () => {
  const preview = await previewImport(req, {
    buffer: xlsxFor([{ Article: "PL-MISSING", "Sell price": "3", Cur: "USD" }]),
    filename: "pl-missing.xlsx",
  });
  assert.equal(preview.canApply, false);
  assert.equal(preview.rows[0].unknownArticle, true);
  assert.equal(preview.errors[0].code, "ARTICLE_NOT_IN_ITEM_MASTER");
  assert.equal(await ManPriceList.countDocuments({ companyId: company._id, article: "PL-MISSING" }), 0);
  assert.equal(await ItemMaster.countDocuments({ companyId: company._id, article: "PL-MISSING" }), 0);
});

await run("Price List preview performs zero master and price writes", async () => {
  const before = {
    items: await ItemMaster.countDocuments({ companyId: company._id }),
    tech: await ItemTechnical.countDocuments({ companyId: company._id }),
    suppliers: await ItemSupplier.countDocuments({ companyId: company._id }),
    prices: await ManPriceList.countDocuments({ companyId: company._id }),
  };
  await previewImport(req, {
    buffer: xlsxFor([
      { Article: "PL-ACT", "Sell price": "100", Cur: "USD" },
      { Article: "PL-DEAD", "Sell price": "100", Cur: "USD" },
      { Article: "PL-MISSING", "Sell price": "100", Cur: "USD" },
    ]),
    filename: "pl-zero-writes.xlsx",
  });
  assert.equal(await ItemMaster.countDocuments({ companyId: company._id }), before.items);
  assert.equal(await ItemTechnical.countDocuments({ companyId: company._id }), before.tech);
  assert.equal(await ItemSupplier.countDocuments({ companyId: company._id }), before.suppliers);
  assert.equal(await ManPriceList.countDocuments({ companyId: company._id }), before.prices);
});

await run("Direct Apply cannot bypass preview for an inactive Article", async () => {
  const forged = await ManPriceListImport.create({
    companyId: company._id,
    filename: "forged-inactive.xlsx",
    status: "PREVIEW",
    canApply: true,
    importErrors: [],
    rows: [
      {
        rowNumber: 2,
        article: "PL-DEAD",
        proposedPrices: { sellPrice: 88 },
        proposedItem: {},
        itemChanges: {},
        priceChanges: { sellPrice: { from: null, to: 88 } },
      },
    ],
    itemFingerprints: {},
  });
  const beforePrice = await ManPriceList.countDocuments({ companyId: company._id, article: "PL-DEAD" });
  const beforeItem = await ItemMaster.findOne({ companyId: company._id, article: "PL-DEAD" }).lean();
  let caught;
  try {
    await applyImport(req, String(forged._id));
  } catch (e) {
    caught = e;
  }
  assert.equal(caught?.code, "ARTICLE_INACTIVE");
  assert.deepEqual(caught.articles, ["PL-DEAD"]);
  assert.equal(await ManPriceList.countDocuments({ companyId: company._id, article: "PL-DEAD" }), beforePrice);
  const afterItem = await ItemMaster.findOne({ companyId: company._id, article: "PL-DEAD" }).lean();
  assert.equal(String(afterItem.status), "Inactive");
  assert.equal(String(afterItem.updatedAt), String(beforeItem.updatedAt));
});

await run("Article active at preview but inactive before Apply is rejected with zero writes", async () => {
  const preview = await previewImport(req, {
    buffer: xlsxFor([{ Article: "PL-RACE", "Sell price": "41", Cur: "USD" }]),
    filename: "pl-race.xlsx",
  });
  assert.equal(preview.canApply, true);
  await ItemMaster.updateOne({ companyId: company._id, article: "PL-RACE" }, { $set: { status: "Inactive" } });
  let caught;
  try {
    await applyImport(req, preview.previewId);
  } catch (e) {
    caught = e;
  }
  assert.equal(caught?.code, "ARTICLE_INACTIVE");
  assert.ok(caught.articles.includes("PL-RACE"));
  assert.equal(await ManPriceList.countDocuments({ companyId: company._id, article: "PL-RACE" }), 0);
  const item = await ItemMaster.findOne({ companyId: company._id, article: "PL-RACE" }).lean();
  assert.equal(item.status, "Inactive");
  await ItemMaster.updateOne({ companyId: company._id, article: "PL-RACE" }, { $set: { status: "Active" } });
});

await run("Mixed active and inactive CSV applies zero Price List rows", async () => {
  const beforePrices = await ManPriceList.countDocuments({ companyId: company._id });
  const beforeAct = await masterSnapshot("PL-ACT");
  const preview = await previewImport(req, {
    buffer: xlsxFor([
      { Article: "PL-ACT", "Sell price": "55", Cur: "USD" },
      { Article: "PL-DEAD", "Sell price": "56", Cur: "USD" },
    ]),
    filename: "pl-mixed.xlsx",
  });
  assert.equal(preview.canApply, false);
  assert.ok((preview.errors || []).some((e) => e.code === "ARTICLE_INACTIVE" && e.article === "PL-DEAD"));
  let code = "";
  try {
    await applyImport(req, preview.previewId);
  } catch (e) {
    code = e.code;
  }
  assert.equal(code, "PREVIEW_INVALID");
  assert.equal(await ManPriceList.countDocuments({ companyId: company._id }), beforePrices);
  assert.equal(await ManPriceList.countDocuments({ companyId: company._id, article: "PL-ACT" }), beforeAct.price ? 1 : 0);
});

await run("Failed inactive apply does not write ItemMaster, ItemTechnical or ItemSupplier", async () => {
  const before = {
    items: await ItemMaster.countDocuments({ companyId: company._id }),
    tech: await ItemTechnical.countDocuments({ companyId: company._id }),
    suppliers: await ItemSupplier.countDocuments({ companyId: company._id }),
  };
  const preview = await previewImport(req, {
    buffer: xlsxFor([{ Article: "PL-DEAD", "Sell price": "19", Cur: "USD", "Part no": "SHOULD-NOT-WRITE" }]),
    filename: "pl-no-master-write.xlsx",
  });
  try {
    await applyImport(req, preview.previewId);
  } catch (e) {
    assert.ok(e.code === "PREVIEW_INVALID" || e.code === "ARTICLE_INACTIVE");
  }
  assert.equal(await ItemMaster.countDocuments({ companyId: company._id }), before.items);
  assert.equal(await ItemTechnical.countDocuments({ companyId: company._id }), before.tech);
  assert.equal(await ItemSupplier.countDocuments({ companyId: company._id }), before.suppliers);
  const tech = await ItemTechnical.findOne({ companyId: company._id, article: "PL-DEAD" }).lean();
  assert.equal(tech.spn, "PL-DEAD-SPN");
});

await run("Company isolation remains enforced on Price List CSV preview", async () => {
  const preview = await previewImport(req, {
    buffer: xlsxFor([{ Article: "PL-OTHER", "Sell price": "8", Cur: "USD" }]),
    filename: "pl-otherco.xlsx",
  });
  assert.equal(preview.canApply, false);
  assert.equal(preview.rows[0].unknownArticle, true);
  assert.equal(preview.errors[0].code, "ARTICLE_NOT_IN_ITEM_MASTER");
  assert.equal(await ManPriceList.countDocuments({ companyId: company._id, article: "PL-OTHER" }), 0);
  const other = await ItemMaster.findOne({ companyId: companyB._id, article: "PL-OTHER" }).lean();
  assert.equal(other.itemName, "PL-OTHER");
});

await run("Manual upsert still rejects inactive Article and does not delete historical Price List rows", async () => {
  let caught;
  try {
    await upsertManualPrice(req, "PL-DEAD", { sellPrice: 12 });
  } catch (e) {
    caught = e;
  }
  assert.equal(caught?.code, "ARTICLE_INACTIVE");
  assert.match(caught.message, /cannot be used on a new transaction/);
  const listed = await listPriceList(req, { includeInactive: true });
  const hist = listed.find((row) => row.article === "PL-HIST");
  assert.ok(hist);
  assert.equal(Number(hist.sellPrice), 77);
  const fetched = await getPriceListByArticle(req, "PL-HIST", { management: true });
  assert.equal(Number(fetched.sellPrice), 77);
  const unchanged = await ManPriceList.findById(historicalPrice._id).lean();
  assert.equal(Number(unchanged.sellPrice), 77);
  assert.equal(unchanged.revision, 1);
  const deadPreview = await previewImport(req, {
    buffer: xlsxFor([{ Article: "PL-HIST", "Sell price": "999", Cur: "USD" }]),
    filename: "pl-hist.xlsx",
  });
  assert.equal(deadPreview.canApply, false);
  try {
    await applyImport(req, deadPreview.previewId);
  } catch {
    /* expected */
  }
  const still = await ManPriceList.findById(historicalPrice._id).lean();
  assert.equal(Number(still.sellPrice), 77);
  assert.equal(still.revision, 1);
  assert.equal(String(still.updatedAt), String(unchanged.updatedAt));
});

await mongoose.disconnect();
if (replset) await replset.stop();

if (failed) {
  console.error(`\nmanPriceList.integration.test.js failed: ${failed} failed, ${passed} passed`);
  process.exit(1);
}
console.log(`\nmanPriceList.integration.test.js passed: ${passed}`);
