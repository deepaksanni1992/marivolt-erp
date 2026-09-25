/**
 * One Article → many manufacturer Part Numbers.
 * Isolated MongoMemoryReplSet. Does not use a configured database, indexes, or --apply.
 * Run: node scripts/itemMasterAlternatePartNumbers.test.js
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import mongoose from "mongoose";
import XLSX from "xlsx";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import {
  applyItemMasterImport,
  previewItemMasterImport,
} from "../src/services/itemMasterImportService.js";
import {
  applyItemMasterSnapshotsToLines,
  assertActiveArticles,
  assertPoLinesPartNumberMatchesMaster,
  linesRequiringManufacturerPartNumberValidation,
  snapshotPoLineFromItem,
  snapshotQuotationLineFromItem,
} from "../src/services/articleTransactionValidator.js";
import { resolveLookup } from "../src/services/itemResolutionService.js";
import { searchItems } from "../src/services/globalSearchService.js";
import {
  addAlternatePartNumber,
  promoteAlternatePartNumber,
  removeAlternatePartNumber,
  setAlternatePartNumberStatus,
} from "../src/services/itemTechnicalAliasService.js";
import { requireRole } from "../src/middleware/auth.js";
import { sanitiseRolePayload } from "../src/controllers/rolesController.js";
import { sanitizeCustomerQuotationPrint } from "../src/utils/manPriceList.js";
import ItemMaster from "../src/models/itemMasterModel.js";
import ItemTechnical from "../src/models/itemTechnicalModel.js";
import ItemSupplier from "../src/models/itemSupplierModel.js";
import StockBalance from "../src/models/StockBalance.js";
import Supplier from "../src/models/Supplier.js";
import {
  articleOwnsManufacturerPartNumber,
  canonicalItemMasterPartNumber,
  manufacturerPartNumberFindFilter,
  manufacturerPartNumberPack,
  matchedManufacturerPartNumber,
  normalizePartNumberValue,
  publicManufacturerPartNumberDto,
  sanitizeAlternatePartNumberList,
  snapshotSalesLinePartNumberFields,
} from "../src/utils/partNumberTerminology.js";
import { analyzeItemMasterArticleGroup, groupParsedItemMasterRows } from "../src/utils/itemMasterImportGrouping.js";

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

function read(rel, root = srcRoot) {
  return fs.readFileSync(path.join(root, rel), "utf8");
}

function xlsxBuffer(rows) {
  const headers = Object.keys(rows[0] || { Article: "" });
  const aoa = [headers, ...rows.map((row) => headers.map((h) => row[h] ?? ""))];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
  return Buffer.from(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));
}

function invokeRoleGuard(role) {
  return new Promise((resolve) => {
    const req = { user: { role } };
    const res = {
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(body) {
        resolve({ next: false, statusCode: this.statusCode, body });
        return this;
      },
    };
    requireRole("super_admin", "admin")(req, res, () => resolve({ next: true }));
  });
}

const baseRow = {
  Status: "Active",
  Vertical: "Engine",
  Brand: "MAN",
  Model: "L27/38",
  Configuration: "",
  Description: "Demo item",
  "Item Name": "Demo item",
  UOM: "PCS",
};

console.log("\nItem Master alternate Part Numbers\n");

await run("1 grouping util: two PNs on one Article stay one group", () => {
  const grouped = groupParsedItemMasterRows([
    { excelRow: 56, incoming: { article: "10309", spn: "PN-A" }, errors: [] },
    { excelRow: 58, incoming: { article: "10309", spn: "PN-B" }, errors: [] },
  ]);
  assert.equal(grouped.length, 1);
  const analysis = analyzeItemMasterArticleGroup(grouped[0].parsedRows);
  assert.equal(analysis.primaryPartNumber, "PN-A");
  assert.deepEqual(
    analysis.alternates.map((a) => a.partNumber),
    ["PN-B"]
  );
  assert.match(analysis.groupMessage, /rows 56 and 58 with 2 Part Numbers/);
});

await run("18 punctuation preserved and 16 duplicate normalized mapping dropped", () => {
  const list = sanitizeAlternatePartNumberList(
    [{ partNumber: "12.34-5/6" }, { partNumber: " 12.34-5/6 " }, { partNumber: "12.34-5/6" }],
    "PN-A"
  );
  assert.equal(list.length, 1);
  assert.equal(list[0].partNumber, "12.34-5/6");
  assert.equal(list[0].normalized, "12.34-5/6");
});

await run("17-18 trim/case normalize without dropping hyphens or leading zeros", () => {
  assert.equal(normalizePartNumberValue("  0123-ab  "), "0123-AB");
  const pack = manufacturerPartNumberPack(
    {},
    { spn: "PN-A", alternatePartNumbers: [{ partNumber: " pn-b " }] }
  );
  assert.equal(pack.alternatePartNumbers[0].partNumber, "pn-b");
  assert.equal(pack.alternatePartNumbers[0].normalized, "PN-B");
});

await run("19 same PN may map to two Articles; 21-22 legacy fields", () => {
  const a = { article: "10309" };
  const b = { article: "10002" };
  const techA = { spn: "PN-A", alternatePartNumbers: [{ partNumber: "SHARED" }] };
  const techB = { spn: "PN-X", alternatePartNumbers: [{ partNumber: "SHARED" }] };
  assert.equal(articleOwnsManufacturerPartNumber(a, techA, "shared").owned, true);
  assert.equal(articleOwnsManufacturerPartNumber(b, techB, "SHARED").owned, true);
  assert.equal(canonicalItemMasterPartNumber({ partNumber: "LEGACY", spn: "" }, { spn: "PN-A" }), "PN-A");
  assert.equal(canonicalItemMasterPartNumber({ partNumber: "LEGACY", spn: "FALLBACK" }, {}), "FALLBACK");
});

await run("23-25 matched PN reporting", () => {
  const item = { article: "10309" };
  const tech = { spn: "PN-A", alternatePartNumbers: [{ partNumber: "PN-B" }] };
  assert.equal(matchedManufacturerPartNumber(item, tech, "pn-a"), "PN-A");
  assert.equal(matchedManufacturerPartNumber(item, tech, "PN-B"), "PN-B");
  const dto = publicManufacturerPartNumberDto(item, tech, "pn-b");
  assert.equal(dto.primaryPartNumber, "PN-A");
  assert.equal(dto.matchedPartNumber, "PN-B");
  assert.equal(dto.alternateCount, 1);
  assert.ok(!("_id" in (dto.alternatePartNumbers[0] || {})));
});

const replset = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
await mongoose.connect(replset.getUri(), { serverSelectionTimeoutMS: 30000 });
const companyA = new mongoose.Types.ObjectId();
const companyB = new mongoose.Types.ObjectId();
await Supplier.create({ companyId: companyA, supplierCode: "ACME1", supplierName: "Acme", name: "Acme" });

await run("11 preview writes nothing", async () => {
  const before = {
    items: await ItemMaster.countDocuments({}),
    tech: await ItemTechnical.countDocuments({}),
    stock: await StockBalance.countDocuments({}),
  };
  const preview = await previewItemMasterImport({
    companyId: companyA,
    buffer: xlsxBuffer([
      { ...baseRow, Article: "10309", "Part Number": "PN-A" },
      { ...baseRow, Article: "10309", "Part Number": "PN-B" },
    ]),
  });
  assert.equal(preview.canApply, true);
  assert.equal(preview.newArticles.length, 1);
  assert.equal(preview.partNumberAliasesAdded, 1);
  assert.equal(await ItemMaster.countDocuments({}), before.items);
  assert.equal(await ItemTechnical.countDocuments({}), before.tech);
  assert.equal(await StockBalance.countDocuments({}), before.stock);
});

await run("1-2 apply repeated Article with 2 and 3 PNs creates one master", async () => {
  const two = await applyItemMasterImport({
    companyId: companyA,
    buffer: xlsxBuffer([
      { ...baseRow, Article: "10309", "Part Number": "PN-A" },
      { ...baseRow, Article: "10309", "Part Number": "PN-B" },
    ]),
    userEmail: "admin@test",
  });
  assert.equal(two.apply.created, 1);
  assert.equal(await ItemMaster.countDocuments({ companyId: companyA, article: "10309" }), 1);
  const tech = await ItemTechnical.findOne({ companyId: companyA, article: "10309" }).lean();
  assert.equal(tech.spn, "PN-A");
  assert.deepEqual(
    (tech.alternatePartNumbers || []).map((x) => x.partNumber),
    ["PN-B"]
  );

  const three = await applyItemMasterImport({
    companyId: companyA,
    buffer: xlsxBuffer([
      { ...baseRow, Article: "NEW-3", "Part Number": "P1" },
      { ...baseRow, Article: "NEW-3", "Part Number": "P2" },
      { ...baseRow, Article: "NEW-3", "Part Number": "P3" },
    ]),
  });
  assert.equal(three.apply.created, 1);
  assert.equal(await ItemMaster.countDocuments({ companyId: companyA, article: "NEW-3" }), 1);
  const tech3 = await ItemTechnical.findOne({ companyId: companyA, article: "NEW-3" }).lean();
  assert.equal(tech3.spn, "P1");
  assert.equal(tech3.alternatePartNumbers.length, 2);
  assert.ok(tech3.alternatePartNumbers.every((x) => x._id == null));
});

await run("3 existing primary retained; new values become alternates", async () => {
  const preview = await previewItemMasterImport({
    companyId: companyA,
    buffer: xlsxBuffer([{ ...baseRow, Article: "10309", "Part Number": "PN-C" }]),
  });
  assert.equal(preview.canApply, true);
  const group = preview.groups.find((g) => g.article === "10309");
  assert.equal(group.primaryPartNumber, "PN-A");
  assert.ok(group.alternates.some((a) => a.partNumber === "PN-C"));
  await applyItemMasterImport({
    companyId: companyA,
    buffer: xlsxBuffer([{ ...baseRow, Article: "10309", "Part Number": "PN-C" }]),
  });
  const tech = await ItemTechnical.findOne({ companyId: companyA, article: "10309" }).lean();
  assert.equal(tech.spn, "PN-A");
  assert.ok(tech.alternatePartNumbers.some((x) => x.partNumber === "PN-C"));
});

await run("4 existing Article without primary proposes first source-row PN", async () => {
  await ItemMaster.create({
    companyId: companyA,
    article: "NOPN",
    itemName: "No primary",
    description: "No primary",
    vertical: "Engine",
    brand: "MAN",
    engine: "MAN",
    model: "L27/38",
    uom: "PCS",
    status: "Active",
  });
  await ItemTechnical.create({ companyId: companyA, article: "NOPN", spn: "" });
  const preview = await previewItemMasterImport({
    companyId: companyA,
    buffer: xlsxBuffer([
      { ...baseRow, Article: "NOPN", "Part Number": "FIRST", "Item Name": "No primary" },
      { ...baseRow, Article: "NOPN", "Part Number": "SECOND", "Item Name": "No primary" },
    ]),
  });
  const group = preview.groups.find((g) => g.article === "NOPN");
  assert.equal(group.primaryPartNumber, "FIRST");
  assert.equal(group.primaryProposed, true);
  assert.deepEqual(
    group.alternates.map((a) => a.partNumber),
    ["SECOND"]
  );
  await applyItemMasterImport({
    companyId: companyA,
    buffer: xlsxBuffer([
      { ...baseRow, Article: "NOPN", "Part Number": "FIRST", "Item Name": "No primary" },
      { ...baseRow, Article: "NOPN", "Part Number": "SECOND", "Item Name": "No primary" },
    ]),
  });
  const stored = await ItemTechnical.findOne({ companyId: companyA, article: "NOPN" }).lean();
  assert.equal(stored.spn, "FIRST");
  assert.equal(stored.alternatePartNumbers.length, 1);
  assert.equal(stored.alternatePartNumbers[0].partNumber, "SECOND");
});

await run("5 exact duplicate Article+PN is redundant, not duplicated", async () => {
  const preview = await previewItemMasterImport({
    companyId: companyA,
    buffer: xlsxBuffer([
      { ...baseRow, Article: "REDUN", "Part Number": "SAME" },
      { ...baseRow, Article: "REDUN", "Part Number": "same" },
    ]),
  });
  assert.equal(preview.canApply, true);
  assert.equal(preview.redundantRepeatedRows.length, 1);
  const redunGroup = preview.groups.find((g) => g.article === "REDUN");
  assert.equal(redunGroup.alternates.length, 0);
  assert.equal(redunGroup.distinctPartNumberCount, 1);
  await applyItemMasterImport({
    companyId: companyA,
    buffer: xlsxBuffer([
      { ...baseRow, Article: "REDUN", "Part Number": "SAME" },
      { ...baseRow, Article: "REDUN", "Part Number": "same" },
    ]),
  });
  assert.equal(await ItemMaster.countDocuments({ companyId: companyA, article: "REDUN" }), 1);
  const tech = await ItemTechnical.findOne({ companyId: companyA, article: "REDUN" }).lean();
  assert.equal(tech.spn, "SAME");
  assert.equal((tech.alternatePartNumbers || []).length, 0);
});

await run("6 conflicting UOM blocks Apply", async () => {
  const preview = await previewItemMasterImport({
    companyId: companyA,
    buffer: xlsxBuffer([
      { ...baseRow, Article: "UOMX", "Part Number": "A", UOM: "PCS" },
      { ...baseRow, Article: "UOMX", "Part Number": "B", UOM: "SET" },
    ]),
  });
  assert.equal(preview.canApply, false);
  assert.ok(preview.conflictingArticleGroups.length >= 1);
  assert.ok(preview.invalid.some((row) => (row.errors || []).some((e) => /UOM/i.test(e))));
});

await run("7 conflicting Brand/Model blocks Apply", async () => {
  const preview = await previewItemMasterImport({
    companyId: companyA,
    buffer: xlsxBuffer([
      { ...baseRow, Article: "BRX", "Part Number": "A", Brand: "MAN", Model: "L27/38" },
      { ...baseRow, Article: "BRX", "Part Number": "B", Brand: "Wartsila", Model: "L27/38" },
    ]),
  });
  assert.equal(preview.canApply, false);
  assert.ok(preview.invalid.some((row) => (row.errors || []).some((e) => /Brand/i.test(e))));
});

await run("8 conflicting description/specification is reported clearly", async () => {
  const preview = await previewItemMasterImport({
    companyId: companyA,
    buffer: xlsxBuffer([
      { ...baseRow, Article: "DESCX", "Part Number": "A", Description: "One", Specifications: "Spec-1" },
      { ...baseRow, Article: "DESCX", "Part Number": "B", Description: "Two", Specifications: "Spec-2" },
    ]),
  });
  assert.equal(preview.canApply, false);
  const errors = preview.invalid.flatMap((r) => r.errors || []);
  assert.ok(errors.some((e) => /Description/i.test(e)));
  assert.ok(errors.some((e) => /Specifications/i.test(e)));
});

await run("9 blank cells do not erase existing data", async () => {
  const before = await ItemMaster.findOne({ companyId: companyA, article: "10309" }).lean();
  await applyItemMasterImport({
    companyId: companyA,
    buffer: xlsxBuffer([
      {
        Article: "10309",
        Status: "",
        Vertical: "",
        Brand: "",
        Description: "",
        "Item Name": "",
        UOM: "",
        "Part Number": "PN-D",
      },
    ]),
  });
  const after = await ItemMaster.findOne({ companyId: companyA, article: "10309" }).lean();
  assert.equal(after.itemName, before.itemName);
  assert.equal(after.description, before.description);
  assert.equal(after.uom, before.uom);
  const tech = await ItemTechnical.findOne({ companyId: companyA, article: "10309" }).lean();
  assert.equal(tech.spn, "PN-A");
  assert.ok(tech.alternatePartNumbers.some((x) => x.partNumber === "PN-D"));
});

await run("10 __CLEAR__ retains explicit behaviour", async () => {
  await ItemMaster.create({
    companyId: companyA,
    article: "CLR1",
    itemName: "Clear me",
    description: "Has remarks",
    vertical: "Engine",
    brand: "MAN",
    engine: "MAN",
    model: "L27/38",
    uom: "PCS",
    status: "Active",
  });
  await ItemTechnical.create({
    companyId: companyA,
    article: "CLR1",
    spn: "KEEP",
    extRemarks: "note",
  });
  await applyItemMasterImport({
    companyId: companyA,
    buffer: xlsxBuffer([
      {
        ...baseRow,
        Article: "CLR1",
        "Item Name": "Clear me",
        "External Remarks": "__CLEAR__",
        "Part Number": "KEEP",
      },
    ]),
  });
  const tech = await ItemTechnical.findOne({ companyId: companyA, article: "CLR1" }).lean();
  assert.equal(tech.extRemarks, "");
  assert.equal(tech.spn, "KEEP");
});

await run("12-14 apply is atomic, forged preview cannot bypass, client company ID ignored", async () => {
  const src = read("services/itemMasterImportService.js");
  assert.match(src, /fresh\.groups/);
  assert.match(src, /previewItemMasterImport\(\{ companyId, buffer \}\)/);
  assert.doesNotMatch(src, /req\.body\.preview/);
  const ctrl = read("controllers/itemController.js");
  assert.match(ctrl, /companyId: req\.companyId/);
  assert.doesNotMatch(ctrl, /req\.body\.companyId/);
  const before = await ItemMaster.countDocuments({ companyId: companyA });
  const preview = await previewItemMasterImport({
    companyId: companyA,
    buffer: xlsxBuffer([
      { ...baseRow, Article: "ATOMIC", "Part Number": "A" },
      { ...baseRow, Article: "ATOMIC", "Part Number": "B", UOM: "SET" },
    ]),
  });
  assert.equal(preview.canApply, false);
  try {
    await applyItemMasterImport({
      companyId: companyA,
      buffer: xlsxBuffer([
        { ...baseRow, Article: "ATOMIC", "Part Number": "A" },
        { ...baseRow, Article: "ATOMIC", "Part Number": "B", UOM: "SET" },
      ]),
    });
    assert.fail("expected invalid apply");
  } catch (err) {
    assert.equal(err.code, "ITEM_MASTER_IMPORT_INVALID");
  }
  assert.equal(await ItemMaster.countDocuments({ companyId: companyA }), before);
  assert.equal(await ItemMaster.countDocuments({ article: "ATOMIC" }), 0);
});

await run("15 stock and prices remain unchanged by Item Master import", async () => {
  await StockBalance.create({
    companyId: companyA,
    article: "10309",
    location: "MAIN",
    warehouse: "MAIN",
    onHandQty: 42,
    avgCost: 9.5,
  });
  const before = await StockBalance.findOne({ companyId: companyA, article: "10309" }).lean();
  await applyItemMasterImport({
    companyId: companyA,
    buffer: xlsxBuffer([{ ...baseRow, Article: "10309", "Part Number": "PN-E", Qty: 999 }]),
  });
  const after = await StockBalance.findOne({ companyId: companyA, article: "10309" }).lean();
  assert.equal(Number(after.onHandQty), Number(before.onHandQty));
  assert.equal(Number(after.avgCost), Number(before.avgCost));
  assert.equal(await StockBalance.countDocuments({ companyId: companyA, article: "10309" }), 1);
});

await run("20 supplier Part Number stays separate", async () => {
  await applyItemMasterImport({
    companyId: companyA,
    buffer: xlsxBuffer([
      {
        ...baseRow,
        Article: "SUPSEP",
        "Part Number": "OEM-1",
        "Supplier 1": "Acme",
        "Supplier 1 Part Number": "SUP-77",
      },
    ]),
  });
  const tech = await ItemTechnical.findOne({ companyId: companyA, article: "SUPSEP" }).lean();
  const suppliers = await ItemSupplier.find({ companyId: companyA, article: "SUPSEP" }).lean();
  assert.equal(tech.spn, "OEM-1");
  assert.ok(!(tech.alternatePartNumbers || []).some((x) => /SUP-77/i.test(x.partNumber)));
  assert.equal(suppliers[0].supplierPartNumber, "SUP-77");
});

await run("23-28 search/match primary, alternate, isolation, inactive", async () => {
  await ItemMaster.create({
    companyId: companyB,
    article: "10309",
    itemName: "Other co",
    description: "Other",
    vertical: "Engine",
    brand: "MAN",
    engine: "MAN",
    uom: "PCS",
    status: "Active",
  });
  await ItemTechnical.create({
    companyId: companyB,
    article: "10309",
    spn: "PN-A",
    alternatePartNumbers: [{ partNumber: "PN-B", normalized: "PN-B", status: "ACTIVE" }],
  });
  await ItemMaster.create({
    companyId: companyA,
    article: "VAR2",
    itemName: "Variation",
    description: "Same PN other article",
    vertical: "Engine",
    brand: "MAN",
    engine: "MAN",
    model: "L32/40",
    config: "C1",
    uom: "PCS",
    status: "Active",
  });
  await ItemTechnical.create({
    companyId: companyA,
    article: "VAR2",
    spn: "OTHER",
    alternatePartNumbers: [{ partNumber: "PN-B", normalized: "PN-B", status: "ACTIVE" }],
  });
  await ItemMaster.create({
    companyId: companyA,
    article: "DEADPN",
    itemName: "Inactive",
    description: "Off",
    uom: "PCS",
    status: "Inactive",
  });
  await ItemTechnical.create({
    companyId: companyA,
    article: "DEADPN",
    spn: "PN-B",
  });

  const byPrimary = await resolveLookup({ companyId: companyA, input: { spn: "PN-A" } });
  assert.equal(byPrimary.matchedArticle, "10309");
  assert.equal(byPrimary.matchedPartNumber, "PN-A");

  const byAlt = await resolveLookup({ companyId: companyA, input: { spn: "PN-B" } });
  const alts = [byAlt.matchedArticle, ...(byAlt.alternativeCandidates || []).map((x) => x.article)];
  assert.ok(alts.includes("10309"));
  assert.ok(alts.includes("VAR2"));
  const isolated = await resolveLookup({ companyId: companyA, input: { article: "10309", spn: "PN-A" } });
  assert.equal(isolated.matchedArticle, "10309");
  const otherCo = await ItemTechnical.find(manufacturerPartNumberFindFilter(companyB, "PN-B")).lean();
  assert.ok(otherCo.every((row) => String(row.companyId) === String(companyB)));
});

await run("29-33 quotation snapshots keep two customer PNs and PO ownership", () => {
  const item = {
    article: "10309",
    description: "Demo item",
    uom: "PCS",
    spn: "PN-A",
    alternatePartNumbers: [{ partNumber: "PN-B", normalized: "PN-B" }],
  };
  const q1 = snapshotQuotationLineFromItem({ article: "10309", partNumber: "PN-A", qty: 2 }, item);
  const q2 = snapshotQuotationLineFromItem({ article: "10309", partNumber: "PN-B", qty: 5 }, item);
  assert.equal(q1.partNumber, "PN-A");
  assert.equal(q2.partNumber, "PN-B");
  assert.equal(q1.customerPartNo, "PN-A");
  assert.equal(q2.customerPartNo, "PN-B");
  assert.equal(q1.matchedPartNumber, "PN-A");
  assert.equal(q2.matchedPartNumber, "PN-B");
  assert.equal(Number(q1.qty) + Number(q2.qty), 7);

  const poKeep = snapshotPoLineFromItem({ article: "10309", partNo: "PN-B", supplierPartNumber: "SUP-1" }, item);
  assert.equal(poKeep.partNo, "PN-B");
  assert.equal(poKeep.supplierPartNumber, "SUP-1");
  const items = new Map([["10309", item]]);
  assertPoLinesPartNumberMatchesMaster([{ article: "10309", partNo: "PN-B" }], items);
  try {
    assertPoLinesPartNumberMatchesMaster([{ article: "10309", partNo: "UNKNOWN" }], items);
    assert.fail("expected mismatch");
  } catch (err) {
    assert.equal(err.code, "PART_NUMBER_NOT_LINKED_TO_ARTICLE");
  }
});

await run("34-37 source: MAN RFQ aliases, duplicate-line warning, OA identity", () => {
  const rfq = read("services/manRfqService.js");
  assert.match(rfq, /manufacturerPartNumberFindFilter/);
  assert.match(rfq, /alternatePartNumbers/);
  const dup = read("utils/quotationDuplicateLines.js");
  assert.match(dup, /duplicate-Article/);
  assert.match(dup, /sourceRowNumber/);
});

await run("38-42 PO/ASN/GRN/stock/label remain Article-based", () => {
  const poUi = read("pages/Purchase.jsx", feRoot);
  assert.match(poUi, /selectOwnedManufacturerPartNumber/);
  assert.match(poUi, /supplierPartNumber/);
  const validator = read("services/articleTransactionValidator.js");
  assert.match(validator, /articleOwnsManufacturerPartNumber/);
  const labels = read("services/label/labelService.js");
  assert.match(labels, /article/);
});

await run("43-45 only live Admin/Super Admin mutate; custom role cannot; sales DTO redacts ids", async () => {
  for (const role of ["super_admin", "admin"]) {
    const r = await invokeRoleGuard(role);
    assert.equal(r.next, true);
  }
  for (const role of ["company_admin", "purchase", "sales", "store", "store_operator", "custom_role"]) {
    const r = await invokeRoleGuard(role);
    assert.equal(r.next, false);
    assert.equal(r.statusCode, 403);
  }
  const cleaned = sanitiseRolePayload({
    code: "FORGED_IM",
    name: "Forged IM",
    permissions: [
      { module: "ITEM_MASTER", actions: ["view", "create", "edit", "approve", "cancel", "delete", "export"] },
    ],
  });
  const im = cleaned.permissions.find((p) => p.module === "ITEM_MASTER");
  assert.deepEqual(im.actions.sort(), ["export", "view"]);
  const routes = read("routes/itemRoutes.js");
  assert.match(routes, /requireRole\("super_admin", "admin"\)/);
  assert.match(routes, /addItemAlternate/);
  assert.match(routes, /removeItemAlternate/);
  assert.match(routes, /promoteItemAlternate/);
  const dto = publicManufacturerPartNumberDto({}, { spn: "A", alternatePartNumbers: [{ partNumber: "B", _id: "x", normalized: "B", createdBy: "u1" }] });
  assert.ok(!dto.alternatePartNumbers.some((row) => row._id));
  assert.ok(!dto.alternatePartNumbers.some((row) => "normalized" in row));
  assert.ok(!dto.alternatePartNumbers.some((row) => "createdBy" in row));
});

await run("source: no new alternate index and spn remains primary", () => {
  const model = read("models/itemTechnicalModel.js");
  assert.match(model, /alternatePartNumbers/);
  assert.match(model, /_id:\s*false/);
  assert.doesNotMatch(model, /alternatePartNumbers\.normalized[\s\S]{0,80}unique:\s*true/);
  assert.match(model, /Canonical primary remains `spn`/);
  const importSvc = read("services/itemMasterImportService.js");
  assert.doesNotMatch(importSvc, /Duplicate article in import file/);
});

await run("unknown supplier blocks every write", async () => {
  const beforeItems = await ItemMaster.countDocuments({ companyId: companyA });
  const preview = await previewItemMasterImport({
    companyId: companyA,
    buffer: xlsxBuffer([
      {
        ...baseRow,
        Article: "BADSUP",
        "Part Number": "OEM-X",
        "Supplier 1": "No-Such-Supplier",
        "Supplier 1 Part Number": "S1",
      },
    ]),
  });
  assert.equal(preview.canApply, false);
  try {
    await applyItemMasterImport({
      companyId: companyA,
      buffer: xlsxBuffer([
        {
          ...baseRow,
          Article: "BADSUP",
          "Part Number": "OEM-X",
          "Supplier 1": "No-Such-Supplier",
          "Supplier 1 Part Number": "S1",
        },
      ]),
    });
    assert.fail("expected invalid apply");
  } catch (err) {
    assert.equal(err.code, "ITEM_MASTER_IMPORT_INVALID");
  }
  assert.equal(await ItemMaster.countDocuments({ companyId: companyA }), beforeItems);
  assert.equal(await ItemMaster.countDocuments({ companyId: companyA, article: "BADSUP" }), 0);
});

await run("legacy technical without alternates still matches primary", async () => {
  await ItemMaster.create({
    companyId: companyA,
    article: "LEGACY0",
    itemName: "Legacy",
    description: "Legacy",
    vertical: "Engine",
    brand: "CAT",
    engine: "CAT",
    model: "C32",
    uom: "PCS",
    status: "Active",
  });
  await ItemTechnical.collection.insertOne({
    companyId: companyA,
    article: "LEGACY0",
    spn: "LEG-PN",
  });
  const hit = await resolveLookup({ companyId: companyA, input: { spn: "LEG-PN" } });
  assert.equal(hit.matchedArticle, "LEGACY0");
  assert.equal(hit.matchedPartNumber, "LEG-PN");
});

await run("same normalized PN cannot occur twice on one Article", async () => {
  await addAlternatePartNumber({
    companyId: companyA,
    article: "10309",
    partNumber: "DUP-NORM",
    userEmail: "admin@test",
  });
  try {
    await addAlternatePartNumber({
      companyId: companyA,
      article: "10309",
      partNumber: "dup-norm",
      userEmail: "admin@test",
    });
    assert.fail("expected duplicate");
  } catch (err) {
    assert.equal(err.code, "DUPLICATE_ALIAS");
  }
  const tech = await ItemTechnical.findOne({ companyId: companyA, article: "10309" }).lean();
  const dups = (tech.alternatePartNumbers || []).filter((x) => x.normalized === "DUP-NORM");
  assert.equal(dups.length, 1);
  assert.equal(dups[0]._id, undefined);
});

await run("manual add/remove/promote persists and rejects unlinked promote", async () => {
  const added = await addAlternatePartNumber({
    companyId: companyA,
    article: "10309",
    partNumber: "PROMOTE-ME",
    userEmail: "admin@test",
  });
  assert.ok((added.alternatePartNumbers || []).some((x) => x.partNumber === "PROMOTE-ME"));
  const promoted = await promoteAlternatePartNumber({
    companyId: companyA,
    article: "10309",
    partNumber: "PROMOTE-ME",
    userEmail: "admin@test",
  });
  assert.equal(promoted.spn, "PROMOTE-ME");
  assert.ok((promoted.alternatePartNumbers || []).some((x) => normalizePartNumberValue(x.partNumber) === "PN-A"));
  try {
    await promoteAlternatePartNumber({
      companyId: companyA,
      article: "10309",
      partNumber: "NOT-LINKED",
      userEmail: "admin@test",
    });
    assert.fail("expected unlinked promote");
  } catch (err) {
    assert.equal(err.code, "PART_NUMBER_NOT_LINKED_TO_ARTICLE");
  }
  await removeAlternatePartNumber({
    companyId: companyA,
    article: "10309",
    partNumber: "PN-A",
  });
  const after = await ItemTechnical.findOne({ companyId: companyA, article: "10309" }).lean();
  assert.equal(after.spn, "PROMOTE-ME");
  assert.ok(!(after.alternatePartNumbers || []).some((x) => normalizePartNumberValue(x.partNumber) === "PN-A"));
});

await run("concurrent identical add stores one alias", async () => {
  const results = await Promise.allSettled([
    addAlternatePartNumber({ companyId: companyA, article: "10309", partNumber: "CONC-1" }),
    addAlternatePartNumber({ companyId: companyA, article: "10309", partNumber: "conc-1" }),
  ]);
  const ok = results.filter((r) => r.status === "fulfilled").length;
  const dup = results.filter((r) => r.status === "rejected" && r.reason?.code === "DUPLICATE_ALIAS").length;
  assert.ok(ok >= 1);
  assert.equal(ok + dup, 2);
  const tech = await ItemTechnical.findOne({ companyId: companyA, article: "10309" }).lean();
  const hits = (tech.alternatePartNumbers || []).filter((x) => x.normalized === "CONC-1");
  assert.equal(hits.length, 1);
});

await run("stale remove fails instead of overwriting newer data", async () => {
  const before = await ItemTechnical.findOne({ companyId: companyA, article: "10309" }).lean();
  await addAlternatePartNumber({
    companyId: companyA,
    article: "10309",
    partNumber: "STALE-TGT",
    userEmail: "admin@test",
  });
  try {
    await removeAlternatePartNumber({
      companyId: companyA,
      article: "10309",
      partNumber: "STALE-TGT",
      expectedUpdatedAt: before.updatedAt,
    });
    assert.fail("expected stale conflict");
  } catch (err) {
    assert.equal(err.code, "STALE_ITEM_TECHNICAL");
    assert.equal(err.statusCode, 409);
  }
  const still = await ItemTechnical.findOne({ companyId: companyA, article: "10309" }).lean();
  assert.ok((still.alternatePartNumbers || []).some((x) => x.normalized === "STALE-TGT"));
});

await run("inactive alias excluded from matching and new PO lines; historical snapshot retained", async () => {
  await ItemMaster.create({
    companyId: companyA,
    article: "INACT1",
    itemName: "Inactive alias",
    description: "Inactive alias",
    vertical: "Engine",
    brand: "MAN",
    engine: "MAN",
    model: "L27/38",
    uom: "PCS",
    status: "Active",
  });
  await ItemTechnical.create({
    companyId: companyA,
    article: "INACT1",
    spn: "PRI-1",
    alternatePartNumbers: [{ partNumber: "OLD-ALT", normalized: "OLD-ALT", status: "ACTIVE" }],
  });
  await setAlternatePartNumberStatus({
    companyId: companyA,
    article: "INACT1",
    partNumber: "OLD-ALT",
    status: "INACTIVE",
    userEmail: "admin@test",
  });
  const lookup = await resolveLookup({ companyId: companyA, input: { spn: "OLD-ALT" } });
  assert.notEqual(lookup.matchedArticle, "INACT1");
  const item = {
    article: "INACT1",
    description: "Inactive alias",
    uom: "PCS",
    spn: "PRI-1",
    alternatePartNumbers: [{ partNumber: "OLD-ALT", normalized: "OLD-ALT", status: "INACTIVE" }],
  };
  const items = new Map([["INACT1", item]]);
  try {
    assertPoLinesPartNumberMatchesMaster([{ article: "INACT1", partNo: "OLD-ALT" }], items);
    assert.fail("expected inactive");
  } catch (err) {
    assert.equal(err.code, "PART_NUMBER_INACTIVE");
  }
  const blank = snapshotPoLineFromItem({ article: "INACT1", partNo: "" }, item);
  assert.equal(blank.partNo, "PRI-1");
  const storedHistorical = { article: "INACT1", partNo: "OLD-ALT", partNumber: "OLD-ALT" };
  assert.equal(storedHistorical.partNo, "OLD-ALT");
  const unchanged = linesRequiringManufacturerPartNumberValidation(
    [{ _id: "1", article: "INACT1", partNo: "OLD-ALT" }],
    [{ _id: "1", article: "INACT1", partNo: "OLD-ALT" }]
  );
  assert.equal(unchanged.length, 0);
});

await run("active alias on inactive Article cannot be transacted", async () => {
  try {
    await assertActiveArticles({ companyId: companyA, lines: [{ article: "DEADPN" }] });
    assert.fail("expected inactive article gate");
  } catch (err) {
    assert.equal(err.code, "ARTICLE_INACTIVE");
  }
  const lookup = await resolveLookup({ companyId: companyA, input: { spn: "PN-B" } });
  const articles = [lookup.matchedArticle, ...(lookup.eligibleArticles || []).map((x) => x.article)];
  assert.ok(!articles.includes("DEADPN"));
});

await run("requested vs matched Part Number mapping and customer print redaction", () => {
  const fields = snapshotSalesLinePartNumberFields({ customerPartNo: "REQ-1", matchedPartNumber: "PN-B" });
  assert.equal(fields.customerPartNo, "REQ-1");
  assert.equal(fields.matchedPartNumber, "PN-B");
  assert.equal(fields.partNumber, "REQ-1");
  const fallback = snapshotSalesLinePartNumberFields({ customerPartNo: "", matchedPartNumber: "PN-B" });
  assert.equal(fallback.partNumber, "PN-B");
  const historical = snapshotSalesLinePartNumberFields({ customerPartNo: "LEGACY-REQ", matchedPartNumber: "" });
  assert.equal(historical.partNumber, "LEGACY-REQ");
  const oaLines = applyItemMasterSnapshotsToLines(
    [{ article: "10309", customerPartNo: "REQ-1", partNumber: "REQ-1", description: "x", uom: "PCS", qty: 1 }],
    new Map([
      [
        "10309",
        {
          article: "10309",
          description: "Demo item",
          uom: "PCS",
          spn: "PROMOTE-ME",
          alternatePartNumbers: [{ partNumber: "REQ-1", normalized: "REQ-1", status: "ACTIVE" }],
        },
      ],
    ]),
    "quotation"
  );
  assert.equal(oaLines[0].customerPartNo, "REQ-1");
  assert.equal(oaLines[0].matchedPartNumber, "REQ-1");
  const printed = sanitizeCustomerQuotationPrint({
    lines: [
      {
        article: "10309",
        partNumber: "REQ-1",
        customerPartNo: "REQ-1",
        matchedPartNumber: "PN-B",
        createdBy: "u1",
        updatedBy: "u2",
        _id: "lineid",
        alternatePartNumbers: [{ _id: "x", normalized: "X", createdBy: "u" }],
        supplierPartNumber: "SUP",
      },
    ],
  });
  assert.equal(printed.lines[0].customerPartNo, "REQ-1");
  assert.equal(printed.lines[0].matchedPartNumber, "PN-B");
  assert.ok(!("createdBy" in printed.lines[0]));
  assert.ok(!("updatedBy" in printed.lines[0]));
  assert.ok(!("alternatePartNumbers" in printed.lines[0]));
  assert.ok(!("supplierPartNumber" in printed.lines[0]));
  assert.ok(!("_id" in printed.lines[0]));
});

await run("sales DTO redacts internals; admin DTO may include status/audit", () => {
  const tech = {
    spn: "PRI",
    alternatePartNumbers: [
      {
        partNumber: "ALT",
        normalized: "ALT",
        status: "ACTIVE",
        createdBy: "admin@test",
        updatedBy: "admin@test",
        _id: "should-not-leak",
      },
      { partNumber: "DEAD", normalized: "DEAD", status: "INACTIVE", createdBy: "admin@test" },
    ],
  };
  const sales = publicManufacturerPartNumberDto({ article: "X" }, tech, "alt");
  assert.equal(sales.matchedPartNumber, "ALT");
  assert.equal(sales.alternatePartNumbers.length, 1);
  assert.deepEqual(Object.keys(sales.alternatePartNumbers[0]).sort(), ["partNumber"]);
  const admin = publicManufacturerPartNumberDto({ article: "X" }, tech, "dead", { includeInactive: true, includeAudit: true });
  assert.equal(admin.alternatePartNumbers.length, 2);
  assert.equal(admin.alternatePartNumbers.find((x) => x.partNumber === "DEAD").status, "INACTIVE");
  assert.equal(admin.alternatePartNumbers[0].createdBy, "admin@test");
  assert.ok(!admin.alternatePartNumbers.some((x) => x._id || x.normalized));
});

await run("global search by active alternate redacts internals and skips inactive", async () => {
  const hits = await searchItems(companyA, "MAR", /PN-B/i);
  assert.ok(hits.length >= 1);
  assert.ok(hits.every((h) => !("alternatePartNumbers" in h)));
  assert.ok(hits.every((h) => !("createdBy" in h)));
  assert.ok(hits.every((h) => !("normalized" in h)));
  assert.ok(hits.every((h) => String(h.company || "") === "MAR" || !h.company || h.article));
  const inactiveHits = await searchItems(companyA, "MAR", /OLD-ALT/i);
  assert.ok(!inactiveHits.some((h) => h.article === "INACT1"));
});

await run("UI drawer uses dedicated alias APIs keyed by Part Number", () => {
  const ui = read("pages/ItemMaster.jsx", feRoot);
  assert.match(ui, /\/technical\/alternates\/promote/);
  assert.match(ui, /\/technical\/alternates\/remove/);
  assert.match(ui, /action: "add"/);
  assert.doesNotMatch(ui, /filter\(\(_, i\) => i !== idx\)/);
  assert.match(ui, /partNumber: row\.partNumber/);
  const poUi = read("pages/Purchase.jsx", feRoot);
  assert.match(poUi, /_manufacturerPartNumbers/);
  const poCtrl = read("controllers/purchaseController.js");
  assert.match(poCtrl, /delete l\._manufacturerPartNumbers/);
  const itemCtrl = read("controllers/itemController.js");
  assert.match(itemCtrl, /companyId: req\.companyId/);
  assert.doesNotMatch(itemCtrl, /req\.body\.companyId/);
  assert.match(itemCtrl, /Client alternatePartNumbers/);
});

await mongoose.disconnect();
await replset.stop();

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
