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
import {
  createQuotationFromManRfq,
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

await run("Fabricated priceListId is ignored; client unit price and stale revision are rejected", async () => {
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

await run("EUR price list + EUR quotation succeeds; USD quotation is CURRENCY_MISMATCH and creates nothing", async () => {
  const usdMatch = await matchRfqLines(salesReq, {
    lines: [{ partNo: "EUR-459", uom: "PCS", qty: 5 }],
    headerMode: "SELECTED",
    headerModel: "21/31",
    currency: "USD",
  });
  assert.equal(usdMatch.lines[0].status, "CURRENCY_MISMATCH");
  assert.equal(usdMatch.lines[0].unitPrice, undefined);
  assert.equal(usdMatch.lines[0].priceCurrency, "EUR");
  assert.equal(usdMatch.lines[0].currencyMismatch, true);
  assert.notEqual(usdMatch.lines[0].unitPrice, 459.2);
  assert.match(usdMatch.lines[0].exclusionReason, /Quotation currency is USD, but this Article is priced in EUR/);
  assertNoForbiddenSalesPriceKeys(usdMatch, "usd mismatch match");

  const before = await Quotation.countDocuments({ companyId: company._id, sourceType: "MAN_RFQ" });
  let usdCreate = "";
  try {
    await createQuotationFromManRfq(salesReq, {
      idempotencyKey: "key-eur-as-usd",
      customerId: customer._id,
      customerName: customer.name,
      currency: "USD",
      header: selected21,
      lines: [
        {
          selectedArticle: "EUR459",
          qty: 5,
          uom: "PCS",
          priceTier: "SELL",
          priceListRevision: 1,
          unitPrice: 459.2,
          priceCurrency: "USD",
        },
      ],
    });
  } catch (e) {
    usdCreate = e.code;
    assert.equal(e.statusCode, 409);
    assert.equal(e.priceCurrency, "EUR");
    assert.equal(e.quotationCurrency, "USD");
  }
  assert.equal(usdCreate, "CURRENCY_MISMATCH");
  assert.equal(await Quotation.countDocuments({ companyId: company._id, sourceType: "MAN_RFQ" }), before);

  const rematch = await matchRfqLines(salesReq, {
    lines: [{ partNo: "EUR-459", uom: "PCS", qty: 5 }],
    headerMode: "SELECTED",
    headerModel: "21/31",
    currency: "EUR",
  });
  assert.equal(rematch.lines[0].status, "MATCHED");
  assert.equal(rematch.lines[0].unitPrice, 459.2);
  assert.equal(rematch.lines[0].priceCurrency, "EUR");

  const created = await createQuotationFromManRfq(salesReq, {
    idempotencyKey: "key-eur-ok",
    customerId: customer._id,
    customerName: customer.name,
    currency: "EUR",
    header: selected21,
    lines: [
      {
        selectedArticle: "EUR459",
        qty: 5,
        uom: "PCS",
        priceTier: "SELL",
        priceListRevision: 1,
      },
    ],
  });
  assert.equal(created.quotation.status, "DRAFT");
  assert.equal(created.quotation.currency, "EUR");
  assert.equal(created.quotation.lines[0].price, 459.2);
  assert.equal(created.quotation.lines[0].totalPrice, 2296);
  assert.equal(created.quotation.grandTotal, 2296);
  assertNoForbiddenSalesPriceKeys(created.quotation, "eur quotation");
});

await run("Mixed EUR/USD matched lines block creation; missing currency cannot bypass", async () => {
  const mixedMatch = await matchRfqLines(salesReq, {
    lines: [
      { partNo: "EUR-109", uom: "PCS", qty: 12 },
      { partNo: "051.001", uom: "PCS", qty: 1 },
    ],
    headerMode: "SELECTED",
    headerModel: "21/31",
    currency: "USD",
  });
  assert.equal(mixedMatch.lines[0].status, "CURRENCY_MISMATCH");
  assert.equal(mixedMatch.lines[0].priceCurrency, "EUR");
  assert.equal(mixedMatch.lines[1].status, "MATCHED");
  assert.equal(mixedMatch.lines[1].priceCurrency, "USD");

  const before = await Quotation.countDocuments({ companyId: company._id, sourceType: "MAN_RFQ" });
  let mixedCreate = "";
  try {
    await createQuotationFromManRfq(salesReq, {
      idempotencyKey: "key-mixed-currency",
      customerId: customer._id,
      customerName: customer.name,
      currency: "USD",
      header: selected21,
      lines: [
        { selectedArticle: "EUR109", qty: 12, uom: "PCS", priceTier: "SELL", priceListRevision: 1 },
        { selectedArticle: "A001", qty: 1, uom: "PCS", priceTier: "SELL", priceListRevision: 1 },
      ],
    });
  } catch (e) {
    mixedCreate = e.code;
  }
  assert.equal(mixedCreate, "CURRENCY_MISMATCH");
  assert.equal(await Quotation.countDocuments({ companyId: company._id, sourceType: "MAN_RFQ" }), before);

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

await mongoose.disconnect();
if (replset) await replset.stop();

if (failed) {
  console.error(`\nmanPriceList.integration.test.js failed: ${failed} failed, ${passed} passed`);
  process.exit(1);
}
console.log(`\nmanPriceList.integration.test.js passed: ${passed}`);
