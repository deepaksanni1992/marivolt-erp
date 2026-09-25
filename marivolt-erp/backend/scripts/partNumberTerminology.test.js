/**
 * Part Number terminology: ItemTechnical.spn remains canonical storage.
 * Isolated source + MongoMemoryServer / MongoMemoryReplSet. No configured database.
 * Run: node scripts/partNumberTerminology.test.js
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import mongoose from "mongoose";
import XLSX from "xlsx";
import { MongoMemoryReplSet, MongoMemoryServer } from "mongodb-memory-server";
import {
  PART_NUMBER_CONFLICT,
  PART_NUMBER_NOT_LINKED_TO_ARTICLE,
  canonicalItemMasterPartNumber,
  incomingDocumentPartNumber,
  normalizePartNumberValue,
  resolveImportedPartNumber,
  snapshotPartNumberFields,
} from "../src/utils/partNumberTerminology.js";
import {
  classifyManRfqCandidates,
  convertManSourceUnitPrice,
  displayedItemMasterSpn,
  parseRfqCsvRow,
  redactManRfqMatchResponse,
} from "../src/utils/manPriceList.js";
import {
  applyItemMasterImport,
  ITEM_MASTER_TEMPLATE_HEADERS,
  itemMasterImportTemplateCsv,
  previewItemMasterImport,
} from "../src/services/itemMasterImportService.js";
import {
  assertPoLinesPartNumberMatchesMaster,
  loadActiveArticlesByCode,
  snapshotPoLineFromItem,
  snapshotQuotationLineFromItem,
  linesRequiringArticleValidation,
} from "../src/services/articleTransactionValidator.js";
import { getDefaultPermissionsForRole } from "../src/services/roleService.js";
import { ITEM_MASTER_PROTECTED_WRITE_ACTIONS } from "../src/models/Role.js";
import { GRN_CSV_HEADERS, validateGrnCsvHeaders } from "../src/utils/grnCsvImport.js";
import { buildSingleLabelTspl } from "../src/services/label/tsplGenerator.js";
import { buildSingleLabelZpl } from "../src/services/label/zplGenerator.js";
import {
  createPurchaseOrder,
  duplicatePurchaseOrder,
  importPurchaseOrders,
  updatePurchaseOrder,
} from "../src/controllers/purchaseController.js";
import { matchRfqLines } from "../src/services/manRfqService.js";
import ItemMaster from "../src/models/itemMasterModel.js";
import ItemTechnical from "../src/models/itemTechnicalModel.js";
import ItemSupplier from "../src/models/itemSupplierModel.js";
import Supplier from "../src/models/Supplier.js";
import Company from "../src/models/Company.js";
import PurchaseOrder from "../src/models/PurchaseOrder.js";
import ManPriceList from "../src/models/ManPriceList.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcRoot = path.join(__dirname, "..", "src");
const feRoot = path.join(__dirname, "..", "..", "src");

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

function readSrc(rel) {
  return fs.readFileSync(path.join(srcRoot, rel), "utf8");
}
function readFe(rel) {
  return fs.readFileSync(path.join(feRoot, rel), "utf8");
}

function xlsxBuffer(rows) {
  const headers = Object.keys(rows[0] || { Article: "" });
  const aoa = [headers, ...rows.map((row) => headers.map((h) => row[h] ?? ""))];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
  return Buffer.from(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));
}

function mockRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

await run("canonical Part Number is technical.spn then item.spn, never a second stored field", () => {
  assert.equal(canonicalItemMasterPartNumber({ spn: "MASTER" }, { spn: "TECH-001" }), "TECH-001");
  assert.equal(canonicalItemMasterPartNumber({ spn: "MASTER", partNumber: "OTHER" }, {}), "MASTER");
  assert.equal(canonicalItemMasterPartNumber({ partNumber: "LEGACY-ONLY" }, {}), "");
  assert.equal(displayedItemMasterSpn({ spn: "MASTER" }, { spn: "TECH-001" }), "TECH-001");
  const snap = snapshotPartNumberFields("051.001");
  assert.equal(snap.partNo, "051.001");
  assert.equal(snap.partNumber, "051.001");
  assert.equal(snap.spn, "051.001");
});

await run("CSV Part Number and legacy SPN resolve to the same value", () => {
  assert.equal(resolveImportedPartNumber({ "Part Number": "AA-1" }).value, "AA-1");
  assert.equal(resolveImportedPartNumber({ SPN: "AA-1" }).value, "AA-1");
  const same = resolveImportedPartNumber({ "Part Number": "aa-1", SPN: "AA-1" });
  assert.equal(same.error, "");
  assert.equal(normalizePartNumberValue(same.value), "AA-1");
});

await run("conflicting Part Number and SPN is rejected", () => {
  const conflict = resolveImportedPartNumber({ "Part Number": "AA-1", SPN: "BB-2" });
  assert.equal(conflict.code, PART_NUMBER_CONFLICT);
  assert.match(conflict.error, /PART_NUMBER_CONFLICT/);
});

await run("Item Master template/export prefer Part Number and still mention SPN only as legacy", () => {
  assert.ok(ITEM_MASTER_TEMPLATE_HEADERS.includes("Part Number"));
  assert.ok(!ITEM_MASTER_TEMPLATE_HEADERS.includes("SPN"));
  const csv = itemMasterImportTemplateCsv();
  assert.match(csv, /"Part Number"/);
  assert.doesNotMatch(csv, /,"SPN"/);
  const importSvc = readSrc("services/itemMasterImportService.js");
  assert.match(importSvc, /Part Number/);
  assert.match(importSvc, /resolveImportedPartNumber/);
  const exportCtrl = readSrc("controllers/itemController.js");
  assert.match(exportCtrl, /"Part Number": tech\?\.spn/);
  assert.doesNotMatch(exportCtrl, /SPN: tech\?\.spn/);
  assert.match(exportCtrl, /companyId: req\.companyId/);
  assert.doesNotMatch(exportCtrl, /applyItemMasterImport\(\{[\s\S]*companyId: req\.body/);
});

await run("Item Master UI labels Part Number and keeps internal spn", () => {
  const im = readFe("pages/ItemMaster.jsx");
  assert.match(im, /placeholder="Article, Primary or Alternate Part Number, Material Code/);
  assert.match(im, /<th className="px-3 py-3">Primary Part Number<\/th>/);
  assert.match(im, /Field label="Primary Part Number"/);
  assert.match(im, /value=\{technical\.spn\}/);
  assert.doesNotMatch(im, />SPN</);
  assert.match(im, /Supplier Part No\./);
  assert.match(im, /Alternate Part Numbers/);
});

await run("Purchase compact column is Part No. and remains read-only", () => {
  const purchase = readFe("pages/Purchase.jsx");
  assert.match(purchase, /Part No\./);
  assert.doesNotMatch(purchase, /Internal part \/ SPN/);
  assert.match(purchase, /selectOwnedManufacturerPartNumber/);
  assert.match(purchase, /readOnly/);
  assert.match(purchase, /placeholder=\{line\.articleNo \? "—" : "Part No\. from Item Master"\}/);
  assert.match(purchase, /Admin or Super Admin must update Item Master/);
  assert.match(readSrc("controllers/purchaseController.js"), /assertPoLinesPartNumberMatchesMaster/);
});

await run("PO snapshot copies master Part Number, ignores leftover identity field, keeps Supplier Part Number", () => {
  const item = {
    article: "ART-1",
    itemName: "Liner",
    description: "Liner",
    spn: "OEM-9",
    partNumber: "LEGACY-IDENTITY",
    uom: "PCS",
  };
  const snapped = snapshotPoLineFromItem(
    { article: "ART-1", qty: 2, supplierPartNumber: "SUP-99", partNo: "WRONG" },
    item
  );
  assert.equal(snapped.partNo, "OEM-9");
  assert.equal(snapped.partNumber, "OEM-9");
  assert.equal(snapped.spn, "OEM-9");
  assert.equal(snapped.supplierPartNumber, "SUP-99");
  const quote = snapshotQuotationLineFromItem({ article: "ART-1" }, item);
  assert.equal(quote.partNumber, "OEM-9");
});

await run("PO mismatching Part Number is rejected and blank incoming is allowed", () => {
  const items = new Map([["ART-1", { article: "ART-1", spn: "OEM-9", partNumber: "LEGACY-IDENTITY" }]]);
  assert.equal(incomingDocumentPartNumber({ partNo: "OEM-9" }), "OEM-9");
  assertPoLinesPartNumberMatchesMaster([{ article: "ART-1", partNo: "oem-9" }], items);
  assertPoLinesPartNumberMatchesMaster([{ article: "ART-1", partNo: "" }], items);
  try {
    assertPoLinesPartNumberMatchesMaster([{ article: "ART-1", partNo: "OTHER" }], items);
    assert.fail("expected mismatch");
  } catch (err) {
    assert.equal(err.code, PART_NUMBER_NOT_LINKED_TO_ARTICLE);
  }
});

await run("unchanged historical PO lines are not re-snapshotted", () => {
  const prev = [{ _id: "abc", article: "ART-1", partNo: "OLD" }];
  const next = [{ _id: "abc", article: "ART-1", partNo: "OLD", qty: 2 }];
  const changed = linesRequiringArticleValidation(prev, next);
  assert.equal(changed.length, 0);
  const added = linesRequiringArticleValidation(prev, [
    ...next,
    { article: "ART-2", partNo: "FORGED", qty: 1 },
  ]);
  assert.equal(added.length, 1);
  assert.equal(added[0].reason, "NEW");
});

await run("MAN RFQ still matches the canonical stored spn and accepts Part Number CSV", () => {
  const rfq = readSrc("services/manRfqService.js");
  assert.match(rfq, /displayedItemMasterSpn/);
  assert.match(rfq, /raw\.partNo \?\? raw\.partNumber \?\? raw\.spn/);
  assert.match(rfq, /requestedPartNo: partNoOriginal/);
  const parsedPreferred = parseRfqCsvRow({ "Part Number": "051.001", UOM: "PCS", Qty: 1 });
  assert.equal(String(parsedPreferred.partNo), "051.001");
  const parsedLegacySpn = parseRfqCsvRow({ SPN: "051.001", UOM: "PCS", Qty: 1 });
  assert.equal(String(parsedLegacySpn.partNo), "051.001");
  const parsedPartNo = parseRfqCsvRow({ "Part no": "051.001", UOM: "PCS", Qty: 1 });
  assert.equal(String(parsedPartNo.partNo), "051.001");
  const sales = readFe("pages/ManRfqQuotation.jsx");
  assert.match(sales, /Part Number/);
  assert.match(sales, /Legacy header SPN is still accepted/);
  assert.doesNotMatch(sales, />SPN</);
  const mismatch = classifyManRfqCandidates(
    [{ article: "A32", model: "32/40", uomOk: true, prices: { sellPrice: 1 }, pricingOk: true, modelConflict: false }],
    { headerMode: "SELECTED", resolvedModel: "21/31", modelAware: true }
  );
  assert.equal(mismatch.status, "MODEL_MISMATCH");
  assert.match(mismatch.reason, /Part Number exists under other MAN models/);
  const multiple = classifyManRfqCandidates(
    [
      { article: "A21", model: "21/31", uomOk: true, prices: { sellPrice: 1 }, pricingOk: true, modelConflict: false },
      { article: "A32", model: "32/40", uomOk: true, prices: { sellPrice: 1 }, pricingOk: true, modelConflict: false },
    ],
    { headerMode: "UNSPECIFIED", resolvedModel: "", modelAware: true }
  );
  assert.equal(multiple.status, "MULTIPLE");
  assert.match(multiple.reason, /Part Number exists across multiple MAN models/);
  assert.equal(convertManSourceUnitPrice(10, 3.67), 36.7);
});

await run("search and technical lookup remain compatible with spn and Part Number", () => {
  const ctrl = readSrc("controllers/itemController.js");
  assert.match(ctrl, /req\.query\.spn \|\| req\.query\.partNumber/);
  assert.match(ctrl, /canonicalItemMasterPartNumber/);
  const resolve = readSrc("services/itemResolutionService.js");
  assert.match(resolve, /input\.spn \|\| input\.partNumber/);
  assert.match(resolve, /Exact Part Number/);
  assert.doesNotMatch(resolve, /Exact SPN/);
  const manPl = readSrc("utils/manPriceList.js");
  assert.match(manPl, /\["part number", "Part no"\]/);
  assert.match(manPl, /\["spn", "Part no"\]/);
});

await run("non-admin roles cannot mutate Item Master", () => {
  for (const role of ["purchase", "sales", "store", "store_operator", "company_admin"]) {
    const perms = getDefaultPermissionsForRole(role);
    for (const action of ITEM_MASTER_PROTECTED_WRITE_ACTIONS) {
      assert.ok(!(perms.ITEM_MASTER || []).includes(action), `${role} ${action}`);
    }
  }
  const admin = getDefaultPermissionsForRole("admin");
  const superAdmin = getDefaultPermissionsForRole("super_admin");
  assert.ok((admin.ITEM_MASTER || []).includes("create"));
  assert.ok((superAdmin.ITEM_MASTER || []).includes("edit"));
  const im = readFe("pages/ItemMaster.jsx");
  assert.doesNotMatch(im, /deepak007|advitya/i);
  assert.match(im, /isItemMasterAdminRole/);
});

await run("customer/supplier documents do not print both SPN and Part Number columns", () => {
  const poPrint = readFe("lib/purchaseOrderDocumentPrint.js");
  assert.doesNotMatch(poPrint, /SPN/);
  const purchase = readFe("pages/Purchase.jsx");
  assert.match(purchase, /Supplier Part No\./);
  assert.match(purchase, />Part No\.</);
  const sales = readFe("pages/Sales.jsx");
  assert.doesNotMatch(sales, />SPN</);
  assert.match(sales, />Part No\.</);
  const layout = readFe("lib/reportTableLayout.js");
  assert.doesNotMatch(layout, />SPN</);
  assert.match(layout, />Part No\.</);
});

await run("GRN CSV, Store GRN table, and warehouse labels use Part No. captions", () => {
  assert.ok(GRN_CSV_HEADERS.includes("Part No."));
  assert.ok(!GRN_CSV_HEADERS.includes("SPN"));
  const legacy = [...GRN_CSV_HEADERS];
  legacy[legacy.indexOf("Part No.")] = "SPN";
  assert.equal(validateGrnCsvHeaders(legacy).ok, true);
  const store = readFe("pages/StoreModule.jsx");
  assert.match(store, /<th className="px-2 py-2">Part No\.<\/th>/);
  assert.doesNotMatch(store, /<th[^>]*>SPN<\/th>/);
  const tspl = buildSingleLabelTspl({
    article: "ART1",
    description: "Widget",
    spn: "OEM-1",
    qty: 1,
    uom: "PCS",
    poNo: "PO1",
    grnNo: "GRN1",
  });
  assert.match(tspl, /Part No\.: OEM-1/);
  assert.doesNotMatch(tspl, /\bSPN:/);
  const zpl = buildSingleLabelZpl({
    article: "ART1",
    description: "Widget",
    spn: "OEM-1",
    qty: 1,
    uom: "PCS",
    poNo: "PO1",
    grnNo: "GRN1",
  });
  assert.match(zpl, /Part No\.: OEM-1/);
  assert.doesNotMatch(zpl, /\bSPN:/);
});

const mongod = await MongoMemoryServer.create();
await mongoose.connect(mongod.getUri());
const companyA = new mongoose.Types.ObjectId();

await ItemMaster.create({
  companyId: companyA,
  article: "ART-ACTIVE",
  itemName: "Active part",
  description: "Keep me",
  vertical: "Engine",
  brand: "MAN",
  engine: "MAN",
  model: "23/30H",
  uom: "PCS",
  status: "Active",
});
await ItemTechnical.create({ companyId: companyA, article: "ART-ACTIVE", spn: "OLD-SPN" });

await run("import preview writes nothing and new Part Number header is classified", async () => {
  const before = {
    items: await ItemMaster.countDocuments({}),
    tech: await ItemTechnical.countDocuments({}),
  };
  const preview = await previewItemMasterImport({
    companyId: companyA,
    buffer: xlsxBuffer([{ Article: "ART-ACTIVE", "Part Number": "NEW-PN" }]),
  });
  assert.equal(await ItemMaster.countDocuments({}), before.items);
  assert.equal(await ItemTechnical.countDocuments({}), before.tech);
  assert.equal(preview.canApply, true);
  assert.ok(preview.existingWillChange.includes("ART-ACTIVE"));
  assert.equal(preview.rows[0].technical.existingSpn, "OLD-SPN");
  assert.equal(preview.rows[0].primaryPartNumber, "OLD-SPN");
  assert.ok((preview.rows[0].alternatePartNumbers || []).includes("NEW-PN"));
});

await run("preview rejects conflicting Part Number and SPN", async () => {
  const preview = await previewItemMasterImport({
    companyId: companyA,
    buffer: xlsxBuffer([{ Article: "ART-ACTIVE", "Part Number": "AA-1", SPN: "BB-2" }]),
  });
  assert.equal(preview.canApply, false);
  assert.ok(preview.invalid.some((row) => (row.errors || []).some((e) => /PART_NUMBER_CONFLICT/.test(e))));
});

await run("preview accepts both headers when normalized values match", async () => {
  const preview = await previewItemMasterImport({
    companyId: companyA,
    buffer: xlsxBuffer([{ Article: "ART-ACTIVE", "Part Number": "aa-1", SPN: "AA-1" }]),
  });
  assert.equal(preview.canApply, true);
  assert.equal(preview.rows[0].primaryPartNumber, "OLD-SPN");
  assert.ok((preview.rows[0].alternatePartNumbers || []).some((pn) => normalizePartNumberValue(pn) === "AA-1"));
});

await mongoose.disconnect();
await mongod.stop();

const replset = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
await mongoose.connect(replset.getUri(), { serverSelectionTimeoutMS: 30000 });
const applyCompany = new mongoose.Types.ObjectId();
const otherCompany = new mongoose.Types.ObjectId();
await ItemMaster.create({
  companyId: applyCompany,
  article: "ART-ACTIVE",
  itemName: "Active part",
  description: "Keep me",
  vertical: "Engine",
  brand: "Wartsila",
  engine: "Wartsila",
  model: "26",
  uom: "PCS",
  status: "Active",
  partNumber: "LEGACY-ID",
});
await ItemTechnical.create({ companyId: applyCompany, article: "ART-ACTIVE", spn: "OLD-SPN" });
await ItemMaster.create({
  companyId: otherCompany,
  article: "ART-ACTIVE",
  itemName: "Other company part",
  description: "Stay on other company",
  vertical: "Engine",
  brand: "Wartsila",
  engine: "Wartsila",
  model: "26",
  uom: "PCS",
  status: "Active",
});
await ItemTechnical.create({ companyId: otherCompany, article: "ART-ACTIVE", spn: "OTHER-CO" });

await run("apply Part Number header updates existing Article and does not create a duplicate", async () => {
  const before = await ItemMaster.countDocuments({ companyId: applyCompany, article: "ART-ACTIVE" });
  const result = await applyItemMasterImport({
    companyId: applyCompany,
    buffer: xlsxBuffer([{ Article: "ART-ACTIVE", "Part Number": "051.001" }]),
  });
  assert.equal(result.apply.created, 0);
  assert.ok(result.apply.updated >= 1);
  assert.equal(await ItemMaster.countDocuments({ companyId: applyCompany, article: "ART-ACTIVE" }), before);
  const tech = await ItemTechnical.findOne({ companyId: applyCompany, article: "ART-ACTIVE" }).lean();
  assert.equal(tech.spn, "OLD-SPN");
  assert.ok((tech.alternatePartNumbers || []).some((x) => x.partNumber === "051.001"));
  const master = await ItemMaster.findOne({ companyId: applyCompany, article: "ART-ACTIVE" }).lean();
  assert.equal(master.partNumber, "LEGACY-ID");
  assert.notEqual(master.partNumber, "051.001");
});

await run("legacy SPN header still applies to the same canonical field", async () => {
  await applyItemMasterImport({
    companyId: applyCompany,
    buffer: xlsxBuffer([{ Article: "ART-ACTIVE", SPN: "LEGACY-1" }]),
  });
  const tech = await ItemTechnical.findOne({ companyId: applyCompany, article: "ART-ACTIVE" }).lean();
  assert.equal(tech.spn, "OLD-SPN");
  assert.ok((tech.alternatePartNumbers || []).some((x) => x.partNumber === "LEGACY-1"));
});

await run("identical Part Number and SPN headers apply once to the canonical field", async () => {
  await applyItemMasterImport({
    companyId: applyCompany,
    buffer: xlsxBuffer([{ Article: "ART-ACTIVE", "Part Number": "dual-1", SPN: "DUAL-1" }]),
  });
  const tech = await ItemTechnical.findOne({ companyId: applyCompany, article: "ART-ACTIVE" }).lean();
  assert.equal(tech.spn, "OLD-SPN");
  assert.ok((tech.alternatePartNumbers || []).some((x) => normalizePartNumberValue(x.partNumber) === "DUAL-1"));
});

await run("blank update cells preserve the current Part Number", async () => {
  await applyItemMasterImport({
    companyId: applyCompany,
    buffer: xlsxBuffer([{ Article: "ART-ACTIVE", "Part Number": "", Description: "" }]),
  });
  const tech = await ItemTechnical.findOne({ companyId: applyCompany, article: "ART-ACTIVE" }).lean();
  assert.equal(tech.spn, "OLD-SPN");
  const row = await ItemMaster.findOne({ companyId: applyCompany, article: "ART-ACTIVE" }).lean();
  assert.equal(row.description, "Keep me");
});

await run("apply uses authenticated companyId, not a client company value", async () => {
  await applyItemMasterImport({
    companyId: applyCompany,
    buffer: xlsxBuffer([
      { Article: "ART-ACTIVE", "Part Number": "AUTH-PN", Company: String(otherCompany), companyId: String(otherCompany) },
    ]),
  });
  const mine = await ItemTechnical.findOne({ companyId: applyCompany, article: "ART-ACTIVE" }).lean();
  const other = await ItemTechnical.findOne({ companyId: otherCompany, article: "ART-ACTIVE" }).lean();
  assert.equal(mine.spn, "OLD-SPN");
  assert.ok((mine.alternatePartNumbers || []).some((x) => x.partNumber === "AUTH-PN"));
  assert.equal(other.spn, "OTHER-CO");
});

await run("unknown supplier prevents every write", async () => {
  const before = {
    items: await ItemMaster.countDocuments({}),
    tech: await ItemTechnical.countDocuments({}),
    suppliers: await ItemSupplier.countDocuments({}),
    authPn: (await ItemTechnical.findOne({ companyId: applyCompany, article: "ART-ACTIVE" }).lean()).spn,
  };
  const preview = await previewItemMasterImport({
    companyId: applyCompany,
    buffer: xlsxBuffer([
      { Article: "ART-ACTIVE", "Part Number": "SHOULD-NOT-WRITE", "Supplier 1": "NO-SUCH-SUPPLIER" },
    ]),
  });
  assert.equal(preview.canApply, false);
  let threw = false;
  try {
    await applyItemMasterImport({
      companyId: applyCompany,
      buffer: xlsxBuffer([
        { Article: "ART-ACTIVE", "Part Number": "SHOULD-NOT-WRITE", "Supplier 1": "NO-SUCH-SUPPLIER" },
      ]),
    });
  } catch (err) {
    threw = true;
    assert.equal(err.code, "ITEM_MASTER_IMPORT_INVALID");
  }
  assert.equal(threw, true);
  assert.equal(await ItemMaster.countDocuments({}), before.items);
  assert.equal(await ItemTechnical.countDocuments({}), before.tech);
  assert.equal(await ItemSupplier.countDocuments({}), before.suppliers);
  const tech = await ItemTechnical.findOne({ companyId: applyCompany, article: "ART-ACTIVE" }).lean();
  assert.equal(tech.spn, before.authPn);
});

await run("__CLEAR__ explicitly clears the optional canonical Part Number", async () => {
  await applyItemMasterImport({
    companyId: applyCompany,
    buffer: xlsxBuffer([{ Article: "ART-ACTIVE", "Part Number": "__CLEAR__" }]),
  });
  const tech = await ItemTechnical.findOne({ companyId: applyCompany, article: "ART-ACTIVE" }).lean();
  assert.equal(tech.spn, "");
  const master = await ItemMaster.findOne({ companyId: applyCompany, article: "ART-ACTIVE" }).lean();
  assert.equal(master.partNumber, "LEGACY-ID");
});

const poCompany = await Company.create({ name: "Part Number Test Co", code: "PNTERM" });
const supplier = await Supplier.create({
  companyId: poCompany._id,
  supplierCode: "SUP-PN",
  supplierName: "Acme Parts",
  name: "Acme Parts",
  currency: "USD",
});
await ItemMaster.create({
  companyId: poCompany._id,
  article: "ART-PO",
  itemName: "PO article",
  description: "PO article",
  vertical: "Engine",
  brand: "Wartsila",
  engine: "Wartsila",
  model: "26",
  uom: "PCS",
  status: "Active",
  partNumber: "LEGACY-PO-ID",
  spn: "FALLBACK-SPN",
});
await ItemTechnical.create({ companyId: poCompany._id, article: "ART-PO", spn: "OEM-CANON" });
await ItemMaster.create({
  companyId: poCompany._id,
  article: "ART-BLANK",
  itemName: "Blank PN article",
  description: "Blank PN article",
  vertical: "Engine",
  brand: "Wartsila",
  engine: "Wartsila",
  model: "26",
  uom: "PCS",
  status: "Active",
});
await ItemTechnical.create({ companyId: poCompany._id, article: "ART-BLANK", spn: "" });
await ItemMaster.create({
  companyId: poCompany._id,
  article: "ART-NEW",
  itemName: "New line article",
  description: "New line article",
  vertical: "Engine",
  brand: "Wartsila",
  engine: "Wartsila",
  model: "26",
  uom: "PCS",
  status: "Active",
});
await ItemTechnical.create({ companyId: poCompany._id, article: "ART-NEW", spn: "NEW-OEM" });

function purchaseReq(body = {}, extra = {}) {
  return {
    companyId: poCompany._id,
    companyCode: poCompany.code,
    user: { role: "purchase", email: "purchase@test.local", name: "Purchase" },
    body,
    params: extra.params || {},
  };
}

await run("loadActiveArticlesByCode uses merged canonical spn, not leftover ItemMaster.partNumber", async () => {
  const items = await loadActiveArticlesByCode({ companyId: poCompany._id, articles: ["ART-PO"] });
  const item = items.get("ART-PO");
  assert.equal(item.spn, "OEM-CANON");
  assert.equal(canonicalItemMasterPartNumber(item), "OEM-CANON");
  assert.equal(item.partNumber, "LEGACY-PO-ID");
});

await run("PO create snapshots canonical master Part Number and never updates Item Master", async () => {
  const beforeMaster = await ItemMaster.findOne({ companyId: poCompany._id, article: "ART-PO" }).lean();
  const beforeTech = await ItemTechnical.findOne({ companyId: poCompany._id, article: "ART-PO" }).lean();
  const beforePos = await PurchaseOrder.countDocuments({ companyId: poCompany._id });
  const forged = mockRes();
  await createPurchaseOrder(
    purchaseReq({
      supplierName: supplier.supplierName,
      supplierId: supplier._id,
      lines: [{ article: "ART-PO", qty: 2, unitPrice: 10, partNo: "CLIENT-FORGED", supplierPartNumber: "SUP-99" }],
    }),
    forged
  );
  assert.equal(forged.statusCode, 409);
  assert.equal(forged.body.code, PART_NUMBER_NOT_LINKED_TO_ARTICLE);
  assert.equal(await PurchaseOrder.countDocuments({ companyId: poCompany._id }), beforePos);

  const res = mockRes();
  await createPurchaseOrder(
    purchaseReq({
      supplierName: supplier.supplierName,
      supplierId: supplier._id,
      lines: [{ article: "ART-PO", qty: 2, unitPrice: 10, partNo: "", supplierPartNumber: "SUP-99" }],
    }),
    res
  );
  assert.equal(res.statusCode, 201, res.body?.message || "");
  const line = res.body.lines[0];
  assert.equal(line.partNo, "OEM-CANON");
  assert.equal(line.partNumber, "OEM-CANON");
  assert.equal(line.spn, "OEM-CANON");
  assert.equal(line.supplierPartNumber, "SUP-99");
  const afterMaster = await ItemMaster.findOne({ companyId: poCompany._id, article: "ART-PO" }).lean();
  const afterTech = await ItemTechnical.findOne({ companyId: poCompany._id, article: "ART-PO" }).lean();
  assert.equal(afterMaster.partNumber, beforeMaster.partNumber);
  assert.equal(afterMaster.spn, beforeMaster.spn);
  assert.equal(afterTech.spn, beforeTech.spn);
  assert.equal(afterTech.spn, "OEM-CANON");
});

await run("blank master Part Number does not block PO creation", async () => {
  const res = mockRes();
  await createPurchaseOrder(
    purchaseReq({
      supplierName: supplier.supplierName,
      lines: [{ article: "ART-BLANK", qty: 1, unitPrice: 1, partNo: "" }],
    }),
    res
  );
  assert.equal(res.statusCode, 201, res.body?.message || "");
  assert.equal(String(res.body.lines[0].partNo || ""), "");
});

await run("PO update keeps historical Part No. and snapshots only new/changed lines", async () => {
  const created = mockRes();
  await createPurchaseOrder(
    purchaseReq({
      supplierName: supplier.supplierName,
      lines: [{ article: "ART-PO", qty: 1, unitPrice: 5, partNo: "OEM-CANON", supplierPartNumber: "SUP-99" }],
    }),
    created
  );
  assert.equal(created.statusCode, 201, created.body?.message || "");
  const poId = created.body._id;
  const storedLineId = created.body.lines[0]._id;
  await ItemTechnical.updateOne(
    { companyId: poCompany._id, article: "ART-PO" },
    { $set: { spn: "OEM-CURRENT" } }
  );

  const qtyOnly = mockRes();
  await updatePurchaseOrder(
    purchaseReq(
      {
        lines: [
          {
            _id: storedLineId,
            article: "ART-PO",
            qty: 4,
            unitPrice: 5,
            partNo: "OEM-CANON",
            supplierPartNumber: "SUP-99",
          },
        ],
      },
      { params: { id: String(poId) } }
    ),
    qtyOnly
  );
  assert.ok(qtyOnly.statusCode < 400, qtyOnly.body?.message || "");
  const kept = qtyOnly.body.lines.find((l) => String(l._id) === String(storedLineId));
  assert.equal(kept.partNo, "OEM-CANON");
  assert.equal(kept.qty, 4);

  const forgedNew = mockRes();
  await updatePurchaseOrder(
    purchaseReq(
      {
        lines: [
          {
            _id: storedLineId,
            article: "ART-PO",
            qty: 4,
            unitPrice: 5,
            partNo: "OEM-CANON",
            supplierPartNumber: "SUP-99",
          },
          { article: "ART-NEW", qty: 2, unitPrice: 8, partNo: "CLIENT-FORGED-NEW" },
        ],
      },
      { params: { id: String(poId) } }
    ),
    forgedNew
  );
  assert.equal(forgedNew.statusCode, 409);
  assert.equal(forgedNew.body.code, PART_NUMBER_NOT_LINKED_TO_ARTICLE);

  const added = mockRes();
  await updatePurchaseOrder(
    purchaseReq(
      {
        lines: [
          {
            _id: storedLineId,
            article: "ART-PO",
            qty: 4,
            unitPrice: 5,
            partNo: "OEM-CANON",
            supplierPartNumber: "SUP-99",
          },
          { article: "ART-NEW", qty: 2, unitPrice: 8, partNo: "" },
        ],
      },
      { params: { id: String(poId) } }
    ),
    added
  );
  assert.ok(added.statusCode < 400, added.body?.message || JSON.stringify(added.body));
  const historical = added.body.lines.find((l) => String(l._id) === String(storedLineId));
  const fresh = added.body.lines.find((l) => l.article === "ART-NEW");
  assert.equal(historical.partNo, "OEM-CANON");
  assert.equal(fresh.partNo, "NEW-OEM");
  assert.equal(fresh.partNumber, "NEW-OEM");
});

await run("PO CSV import validates Article, snapshots or rejects Part Number, and fails without partial persist", async () => {
  const poCount = await PurchaseOrder.countDocuments({ companyId: poCompany._id });
  const missingArticle = mockRes();
  await importPurchaseOrders(
    purchaseReq({
      orders: [
        {
          supplierName: supplier.supplierName,
          lines: [{ description: "no article", qty: 1, partNo: "OEM-CURRENT" }],
        },
      ],
    }),
    missingArticle
  );
  assert.equal(missingArticle.statusCode, 409);
  assert.equal(await PurchaseOrder.countDocuments({ companyId: poCompany._id }), poCount);

  const blankUsesMaster = mockRes();
  await importPurchaseOrders(
    purchaseReq({
      orders: [
        {
          supplierName: supplier.supplierName,
          lines: [{ article: "ART-NEW", qty: 1, partNo: "", supplierPartNumber: "VENDOR-1" }],
        },
      ],
    }),
    blankUsesMaster
  );
  assert.equal(blankUsesMaster.statusCode, 200, blankUsesMaster.body?.message || "");
  assert.equal(blankUsesMaster.body.createdCount, 1);
  assert.equal(blankUsesMaster.body.errors.length, 0);
  const imported = await PurchaseOrder.findOne({ companyId: poCompany._id }).sort({ createdAt: -1 }).lean();
  assert.equal(imported.lines[0].partNo, "NEW-OEM");
  assert.equal(imported.lines[0].supplierPartNumber, "VENDOR-1");

  const matching = mockRes();
  await importPurchaseOrders(
    purchaseReq({
      orders: [
        {
          supplierName: supplier.supplierName,
          lines: [{ article: "ART-NEW", qty: 1, partNo: "new-oem" }],
        },
      ],
    }),
    matching
  );
  assert.equal(matching.body.createdCount, 1);

  const afterOk = await PurchaseOrder.countDocuments({ companyId: poCompany._id });
  const mismatch = mockRes();
  await importPurchaseOrders(
    purchaseReq({
      orders: [
        {
          supplierName: supplier.supplierName,
          lines: [{ article: "ART-NEW", qty: 1, partNo: "NEW-OEM" }],
        },
        {
          supplierName: supplier.supplierName,
          lines: [{ article: "ART-NEW", qty: 1, partNo: "WRONG-PN" }],
        },
      ],
    }),
    mismatch
  );
  assert.equal(mismatch.statusCode, 409);
  assert.equal(mismatch.body.createdCount, 0);
  assert.equal(mismatch.body.code, PART_NUMBER_NOT_LINKED_TO_ARTICLE);
  assert.ok(mismatch.body.errors.some((row) => row.code === PART_NUMBER_NOT_LINKED_TO_ARTICLE));
  assert.equal(await PurchaseOrder.countDocuments({ companyId: poCompany._id }), afterOk);
});

await run("PO duplicate revalidates Articles and snapshots current Item Master Part Number", async () => {
  const sourceRes = mockRes();
  await createPurchaseOrder(
    purchaseReq({
      supplierName: supplier.supplierName,
      lines: [{ article: "ART-PO", qty: 3, unitPrice: 7, partNo: "OEM-CURRENT", supplierPartNumber: "SUP-99" }],
    }),
    sourceRes
  );
  assert.equal(sourceRes.statusCode, 201, sourceRes.body?.message || "");
  const sourceId = sourceRes.body._id;
  const sourcePartNo = sourceRes.body.lines[0].partNo;
  await ItemTechnical.updateOne(
    { companyId: poCompany._id, article: "ART-PO" },
    { $set: { spn: "OEM-AFTER-DUP" } }
  );
  const dup = mockRes();
  await duplicatePurchaseOrder(purchaseReq({}, { params: { id: String(sourceId) } }), dup);
  assert.equal(dup.statusCode, 201, dup.body?.message || "");
  assert.notEqual(String(dup.body._id), String(sourceId));
  assert.equal(dup.body.lines[0].partNo, "OEM-AFTER-DUP");
  const source = await PurchaseOrder.findById(sourceId).lean();
  assert.equal(source.lines[0].partNo, sourcePartNo);
  assert.notEqual(source.lines[0].partNo, "OEM-AFTER-DUP");
});

const manItem = await ItemMaster.create({
  companyId: poCompany._id,
  article: "ART-MAN-RFQ",
  itemName: "MAN valve",
  description: "MAN valve",
  vertical: "Engine",
  brand: "MAN",
  engine: "MAN",
  model: "21/31",
  uom: "PCS",
  status: "Active",
  partNumber: "LEGACY-MAN-ID",
  spn: "",
});
await ItemTechnical.create({ companyId: poCompany._id, article: "ART-MAN-RFQ", spn: "MAN-OEM-1" });
await ManPriceList.create({
  companyId: poCompany._id,
  itemMasterId: manItem._id,
  article: "ART-MAN-RFQ",
  sellPrice: 12.5,
  buy: 4,
  nextBuy: 3,
  currency: "USD",
  revision: 1,
  isActive: true,
});

await run("MAN RFQ match uses canonical ItemTechnical.spn and redacts purchase fields", async () => {
  const salesReq = {
    companyId: poCompany._id,
    companyCode: poCompany.code,
    user: { role: "sales", email: "sales@test.local", name: "Sales" },
  };
  const matched = await matchRfqLines(salesReq, {
    lines: [{ partNo: "MAN-OEM-1", uom: "PCS", qty: 2 }],
    defaultTier: "SELL",
    headerMode: "SELECTED",
    headerModel: "21/31",
    currency: "USD",
  });
  const line = matched.lines[0];
  assert.equal(line.status, "MATCHED");
  assert.equal(line.selectedArticle, "ART-MAN-RFQ");
  assert.equal(line.requestedPartNo, "MAN-OEM-1");
  assert.equal(line.spn || line.partNumber || line.candidates?.[0]?.spn, "MAN-OEM-1");
  const redacted = redactManRfqMatchResponse(matched);
  assert.equal(redacted.lines[0].buy, undefined);
  assert.equal(redacted.lines[0].nextBuy, undefined);
  assert.equal(redacted.lines[0].priceListId, undefined);
  assert.equal(convertManSourceUnitPrice(10, 3.67), 36.7);
});

await mongoose.disconnect();
await replset.stop();

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
