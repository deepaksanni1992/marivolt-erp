/**
 * Item Master authority policy: RBAC, validator, import, no transaction auto-writes.
 * Isolated: source tests + MongoMemoryServer / MongoMemoryReplSet. Does not use a configured database.
 * Run: node scripts/articleTransactionPolicy.test.js
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import mongoose from "mongoose";
import XLSX from "xlsx";
import { MongoMemoryReplSet, MongoMemoryServer } from "mongodb-memory-server";
import {
  ARTICLE_INACTIVE,
  ARTICLE_NOT_IN_ITEM_MASTER,
  articleFromLine,
  assertActiveArticles,
  isArticleValidationError,
  linesRequiringArticleValidation,
  normalizeArticle,
} from "../src/services/articleTransactionValidator.js";
import {
  applyItemMasterImport,
  previewItemMasterImport,
} from "../src/services/itemMasterImportService.js";
import {
  computeEffectivePermissions,
  getDefaultPermissionsForRole,
  hasPermission,
} from "../src/services/roleService.js";
import { requireRole } from "../src/middleware/auth.js";
import { sanitiseRolePayload } from "../src/controllers/rolesController.js";
import { ITEM_MASTER_PROTECTED_WRITE_ACTIONS } from "../src/models/Role.js";
import ItemMaster from "../src/models/itemMasterModel.js";
import ItemTechnical from "../src/models/itemTechnicalModel.js";
import ItemSupplier from "../src/models/itemSupplierModel.js";
import Supplier from "../src/models/Supplier.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcRoot = path.join(__dirname, "..", "src");
const feRoot = path.join(__dirname, "..", "..", "src");
const scriptsRoot = path.join(__dirname);

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

function read(rel) {
  return fs.readFileSync(path.join(srcRoot, rel), "utf8");
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

function collectJsFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectJsFiles(full));
    else if (entry.name.endsWith(".js")) out.push(full);
  }
  return out;
}

console.log("\nItem Master transaction policy\n");

await run("Admin and Super Admin receive Item Master write actions", () => {
  for (const role of ["ADMIN", "SUPER_ADMIN"]) {
    const m = getDefaultPermissionsForRole(role);
    for (const action of ["view", "create", "edit", "approve", "cancel", "export", "delete"]) {
      assert.ok(m.ITEM_MASTER.includes(action), `${role} missing ITEM_MASTER.${action}`);
    }
  }
});

await run("Company Admin and commercial roles cannot write Item Master", () => {
  for (const role of [
    "COMPANY_ADMIN",
    "PURCHASE",
    "SALES",
    "PURCHASE_SALES",
    "STORE",
    "STORE_OPERATOR",
    "LOGISTICS",
    "ACCOUNTS",
    "VIEW_ONLY",
  ]) {
    const m = getDefaultPermissionsForRole(role);
    for (const action of ITEM_MASTER_PROTECTED_WRITE_ACTIONS) {
      assert.ok(!(m.ITEM_MASTER || []).includes(action), `${role} has ITEM_MASTER.${action}`);
    }
  }
  const companyAdmin = getDefaultPermissionsForRole("COMPANY_ADMIN");
  assert.ok(companyAdmin.ITEM_MASTER.includes("view"));
  assert.ok(companyAdmin.ITEM_MASTER.includes("export"));
});

await run("roleService does not hard-code usernames", () => {
  const src = read("services/roleService.js");
  assert.doesNotMatch(src, /deepak007|advitya/i);
  assert.doesNotMatch(read("routes/itemRoutes.js"), /deepak007|advitya/i);
});

await run("live super_admin and admin pass Item Master role guard", async () => {
  assert.equal((await invokeRoleGuard("super_admin")).next, true);
  assert.equal((await invokeRoleGuard("admin")).next, true);
});

await run("Company Admin, Purchase, Sales and Store are denied by live role", async () => {
  for (const role of ["company_admin", "purchase", "sales", "store", "purchase_sales", "view_only"]) {
    const result = await invokeRoleGuard(role);
    assert.equal(result.next, false, `${role} should be denied`);
    assert.equal(result.statusCode, 403);
  }
});

await run("forged custom-role ITEM_MASTER write matrix is still denied by live role", async () => {
  const forged = computeEffectivePermissions({
    role: "purchase",
    roleIds: ["64b000000000000000000001"],
    customRoleDocs: [
      {
        _id: "64b000000000000000000001",
        permissions: [{ module: "ITEM_MASTER", actions: ["view", "create", "edit", "delete"] }],
      },
    ],
  });
  assert.ok(forged.ITEM_MASTER.includes("create"));
  const req = { user: { role: "purchase" }, _permissions: forged };
  assert.equal(await hasPermission(req, "ITEM_MASTER", "create"), true);
  const gated = await invokeRoleGuard("purchase");
  assert.equal(gated.next, false);
  assert.equal(gated.statusCode, 403);
});

await run("custom Role Form cannot be assigned Item Master write actions", () => {
  const cleaned = sanitiseRolePayload({
    code: "FORGED_IM",
    name: "Forged IM",
    permissions: [
      { module: "ITEM_MASTER", actions: ["view", "create", "edit", "approve", "cancel", "delete", "export"] },
    ],
  });
  const im = cleaned.permissions.find((p) => p.module === "ITEM_MASTER");
  assert.deepEqual(im.actions.sort(), ["export", "view"]);
});

await run("mutation routes require live super_admin or admin", () => {
  const routes = read("routes/itemRoutes.js");
  assert.match(routes, /requireRole\("super_admin", "admin"\)/);
  assert.match(routes, /itemMasterAdmin, itemImport/);
  assert.match(routes, /itemMasterAdmin, itemCreate, c\.createItem/);
  assert.match(routes, /itemMasterAdmin, itemEdit, c\.updateItem/);
  assert.match(routes, /itemMasterAdmin, itemDelete, c\.deleteItem/);
  assert.match(routes, /itemMasterAdmin, itemCreate, c\.createItemTechnical/);
  assert.match(routes, /itemMasterAdmin, itemEdit, c\.updateItemTechnical/);
  assert.match(routes, /itemMasterAdmin, itemEdit, c\.addItemAlternate/);
  assert.match(routes, /itemMasterAdmin, itemCreate, c\.createItemSupplier/);
  assert.match(routes, /router\.get\("\/", itemView, c\.listItems\)/);
  assert.match(routes, /router\.post\("\/resolve\/bulk-import", itemView/);
});

await run("quotation auto-create helper is fully removed", () => {
  const src = read("controllers/quotationController.js");
  assert.doesNotMatch(src, /autoCreateItemsFromQuotation/);
  assert.doesNotMatch(src, /Item\.create/);
  assert.doesNotMatch(src, /ItemTechnical\.create/);
  const persist = src.slice(src.indexOf("export async function persistNewQuotation"));
  assert.match(persist, /assertActiveArticles/);
  assert.match(src, /skipAutoCreateItems = false/);
});

await run("PO create/update/import/duplicate validate and do not sync Item Master", () => {
  const src = read("controllers/purchaseController.js");
  assert.doesNotMatch(src, /syncPoLinesToItemMaster/);
  assert.doesNotMatch(src, /poItemMasterSyncService/);
  assert.match(src, /assertActiveArticles/);
  assert.match(src, /assertActiveArticlesForChangedLines/);
});

await run("GRN posting validates Active Article and does not sync Item Master", () => {
  const grn = read("controllers/grnController.js");
  const effects = read("services/grnPostingEffects.js");
  assert.match(grn, /ensureGrnArticlesActive/);
  assert.doesNotMatch(grn, /ensureGrnItemMaster/);
  assert.doesNotMatch(grn, /syncPoLinesToItemMaster/);
  assert.doesNotMatch(effects, /syncPoLinesToItemMaster/);
});

await run("live runtime does not import PO Item Master sync; repair is dry-run by default", () => {
  const syncSrc = read("services/poItemMasterSyncService.js");
  assert.match(syncSrc, /allowRepairWrite !== true/);
  const repair = fs.readFileSync(path.join(scriptsRoot, "repair-po-item-master-sync.js"), "utf8");
  assert.match(repair, /process\.argv\.includes\("--apply"\)/);
  assert.match(repair, /Dry-run only/);
  const liveRoots = ["controllers", "routes", "middleware"].map((d) => path.join(srcRoot, d));
  const liveFiles = liveRoots.flatMap((dir) => collectJsFiles(dir));
  liveFiles.push(path.join(srcRoot, "server.js"));
  for (const file of liveFiles) {
    const src = fs.readFileSync(file, "utf8");
    assert.doesNotMatch(src, /syncPoLinesToItemMaster/, `${file} still references syncPoLinesToItemMaster`);
    assert.doesNotMatch(src, /autoCreateItemsFromQuotation/, `${file} still references autoCreateItemsFromQuotation`);
  }
});

await run("only Item Master maintenance and import write ItemMaster/ItemTechnical/ItemSupplier", () => {
  const allowed = new Set([
    path.join(srcRoot, "controllers", "itemController.js"),
    path.join(srcRoot, "services", "itemMasterImportService.js"),
    path.join(srcRoot, "services", "itemTechnicalAliasService.js"),
    path.join(srcRoot, "services", "poItemMasterSyncService.js"),
  ]);
  const writeRe =
    /\b(ItemMaster|ItemTechnical|ItemSupplier)\.(create|insertMany|findOneAndUpdate|updateOne|updateMany|findOneAndDelete|deleteOne|deleteMany)\b/;
  const saveRe = /\.(save)\(/;
  for (const file of collectJsFiles(path.join(srcRoot, "controllers")).concat(
    collectJsFiles(path.join(srcRoot, "services"))
  )) {
    if (allowed.has(file)) continue;
    const src = fs.readFileSync(file, "utf8");
    if (file.endsWith("manPriceListService.js")) {
      assert.doesNotMatch(src, /ItemMaster\.(create|findOneAndUpdate|updateOne)/);
      assert.doesNotMatch(src, /ItemTechnical\.(create|findOneAndUpdate|updateOne)/);
      assert.doesNotMatch(src, /ItemSupplier\.(create|findOneAndUpdate|updateOne)/);
      continue;
    }
    assert.doesNotMatch(src, writeRe, `${path.relative(srcRoot, file)} still writes Item Master collections`);
    if (src.includes("new ItemMaster") || src.includes("new ItemTechnical") || src.includes("new ItemSupplier")) {
      assert.ok(!saveRe.test(src) || !/ItemMaster|ItemTechnical|ItemSupplier/.test(src));
    }
  }
});

await run("Item Master import requires create+edit and has preview/apply", () => {
  const routes = read("routes/itemRoutes.js");
  assert.match(routes, /requireAllPermissions\(\["ITEM_MASTER", "create"\], \["ITEM_MASTER", "edit"\]\)/);
  assert.match(routes, /\/import\/preview/);
  assert.match(routes, /\/import\/apply/);
  assert.match(routes, /\/import\/template/);
  const ctrl = read("controllers/itemController.js");
  assert.match(ctrl, /companyId: req\.companyId/);
  assert.doesNotMatch(ctrl, /companyId:\s*req\.body\.companyId/);
});

await run("Price list apply does not write Item Master", () => {
  const src = read("services/manPriceListService.js");
  assert.match(src, /Price List import never writes Item Master/);
  assert.doesNotMatch(src, /ItemMaster\.findOneAndUpdate/);
});

await run("Technical Lookup is search-only", () => {
  const ctrl = read("controllers/itemController.js");
  const bulk = ctrl.slice(ctrl.indexOf("export async function bulkResolveItemLookup"));
  const bulkBody = bulk.slice(0, bulk.indexOf("export async function recordResolutionOverride"));
  assert.match(bulkBody, /resolveLookupBatch/);
  assert.doesNotMatch(bulkBody, /ItemMaster\.create/);
  assert.doesNotMatch(bulkBody, /ItemTechnical\.create/);
  assert.doesNotMatch(bulkBody, /ItemSupplier\.create/);
  const resolveFn = ctrl.slice(ctrl.indexOf("export async function resolveItemByTechnicalLookup"));
  const resolveBody = resolveFn.slice(0, resolveFn.indexOf("export async function bulkResolveItemLookup"));
  assert.doesNotMatch(resolveBody, /ItemMaster\.create/);
  const im = fs.readFileSync(path.join(feRoot, "pages/ItemMaster.jsx"), "utf8");
  assert.match(im, /does not create or update Item Master/);
});

await run("transaction paths validate Active Articles server-side", () => {
  assert.match(read("controllers/quotationController.js"), /assertActiveArticles/);
  assert.match(read("controllers/quotationController.js"), /assertActiveArticlesForChangedLines/);
  assert.match(read("controllers/purchaseController.js"), /assertActiveArticles/);
  assert.match(read("controllers/salesFlowController.js"), /assertActiveArticles/);
  assert.match(read("controllers/inventoryController.js"), /assertActiveArticles/);
  assert.match(read("controllers/articleConversionController.js"), /assertActiveArticles/);
  assert.match(read("services/asnService.js"), /assertActiveArticles/);
  assert.match(read("controllers/grnController.js"), /assertActiveArticles/);
  const manPrice = read("services/manPriceListService.js");
  assert.match(manPrice, /ITEM_MISSING|ARTICLE_INACTIVE/);
  assert.match(manPrice, /cannot be used in Price List/);
  assert.match(manPrice, /classifyPriceListItemMaster/);
  assert.match(manPrice, /throwPriceListArticleIssues/);
});

await run("UI selector exists and Item Master hides unauthorized create", () => {
  const select = fs.readFileSync(path.join(feRoot, "components/items/ItemMasterArticleSelect.jsx"), "utf8");
  assert.match(select, /status: "Active"/);
  assert.match(select, /Ask an authorized Admin/);
  const im = fs.readFileSync(path.join(feRoot, "pages/ItemMaster.jsx"), "utf8");
  assert.match(im, /isItemMasterAdminRole/);
  assert.match(im, /import\/preview/);
  const sales = fs.readFileSync(path.join(feRoot, "pages/Sales.jsx"), "utf8");
  assert.match(sales, /ItemMasterArticleSelect/);
  const purchase = fs.readFileSync(path.join(feRoot, "pages/Purchase.jsx"), "utf8");
  assert.match(purchase, /ItemMasterArticleSelect/);
});

await run("Sales supplier prices are redacted without Item Master or Purchase edit", () => {
  const ctrl = read("controllers/itemController.js");
  assert.match(ctrl, /function redactSuppliers/);
  assert.match(ctrl, /ITEM_MASTER", "edit"/);
  assert.match(ctrl, /PURCHASE", "edit"/);
});

await run("normalizeArticle trims and uppercases without collapsing inner spaces", () => {
  assert.equal(normalizeArticle("  ab-1  "), "AB-1");
  assert.equal(normalizeArticle("ab  1"), "AB  1");
  assert.equal(articleFromLine({ articleNo: "x1" }), "X1");
});

await run("unchanged historical lines are skipped; new/changed lines are not", () => {
  const prev = [{ _id: "1", article: "OLD" }, { _id: "2", article: "KEEP" }];
  const next = [{ _id: "1", article: "OLD" }, { _id: "2", article: "NEW" }, { article: "ADDED" }];
  const changed = linesRequiringArticleValidation(prev, next);
  assert.equal(changed.length, 2);
  assert.equal(changed[0].article, "NEW");
  assert.equal(changed[1].article, "ADDED");
});

async function seedPolicyItems(companyA, companyB) {
  await ItemMaster.create({
    companyId: companyA,
    article: "ART-ACTIVE",
    itemName: "Active part",
    description: "Keep me",
    vertical: "Engine",
    brand: "MAN",
    engine: "MAN",
    model: "L27/38",
    uom: "PCS",
    status: "Active",
  });
  await ItemTechnical.create({ companyId: companyA, article: "ART-ACTIVE", spn: "OLD-SPN" });
  await ItemMaster.create({
    companyId: companyA,
    article: "ART-DEAD",
    itemName: "Inactive part",
    description: "Off",
    uom: "PCS",
    status: "Inactive",
  });
  await ItemMaster.create({
    companyId: companyB,
    article: "ART-OTHERCO",
    itemName: "Other company",
    uom: "PCS",
    status: "Active",
  });
}

const mongod = await MongoMemoryServer.create();
await mongoose.connect(mongod.getUri(), { serverSelectionTimeoutMS: 20000 });
const companyA = new mongoose.Types.ObjectId();
const companyB = new mongoose.Types.ObjectId();
await seedPolicyItems(companyA, companyB);

await run("unknown Article is rejected with ARTICLE_NOT_IN_ITEM_MASTER", async () => {
  try {
    await assertActiveArticles({ companyId: companyA, lines: [{ article: "MISSING" }, { article: "ART-ACTIVE" }] });
    assert.fail("expected throw");
  } catch (err) {
    assert.equal(isArticleValidationError(err), true);
    assert.equal(err.code, ARTICLE_NOT_IN_ITEM_MASTER);
    assert.equal(err.statusCode, 409);
    assert.ok(err.articles.includes("MISSING"));
    assert.match(err.message, /Ask an authorized administrator/);
  }
});

await run("inactive Article is rejected with ARTICLE_INACTIVE", async () => {
  try {
    await assertActiveArticles({ companyId: companyA, lines: [{ article: "ART-DEAD" }] });
    assert.fail("expected throw");
  } catch (err) {
    assert.equal(err.code, ARTICLE_INACTIVE);
  }
});

await run("Active company-scoped Article is accepted and other company is isolated", async () => {
  const map = await assertActiveArticles({ companyId: companyA, lines: [{ article: "art-active" }] });
  assert.equal(map.get("ART-ACTIVE").itemName, "Active part");
  try {
    await assertActiveArticles({ companyId: companyA, lines: [{ article: "ART-OTHERCO" }] });
    assert.fail("expected throw");
  } catch (err) {
    assert.equal(err.code, ARTICLE_NOT_IN_ITEM_MASTER);
  }
});

await run("import preview performs zero writes to master collections", async () => {
  const before = {
    items: await ItemMaster.countDocuments({}),
    tech: await ItemTechnical.countDocuments({}),
    suppliers: await ItemSupplier.countDocuments({}),
  };
  const preview = await previewItemMasterImport({
    companyId: companyA,
    buffer: xlsxBuffer([
      {
        Article: "ART-NEW-1",
        Status: "Active",
        Vertical: "Engine",
        Brand: "MAN",
        "Item Name": "New part",
        Description: "Created from import",
        UOM: "PCS",
        SPN: "NEW-SPN",
        "Supplier 1": "Ghost Supplier",
      },
    ]),
  });
  assert.equal(await ItemMaster.countDocuments({}), before.items);
  assert.equal(await ItemTechnical.countDocuments({}), before.tech);
  assert.equal(await ItemSupplier.countDocuments({}), before.suppliers);
  assert.equal(preview.canApply, false);
  assert.ok(preview.invalid.some((row) => (row.errors || []).some((e) => /Unknown supplier/i.test(e))));
});

await run("duplicate Articles in the file are rejected and stock columns are ignored", async () => {
  const preview = await previewItemMasterImport({
    companyId: companyA,
    buffer: xlsxBuffer([
      { Article: "DUP-1", "Item Name": "One", Qty: 99 },
      { Article: "DUP-1", "Item Name": "Two", Qty: 5 },
    ]),
  });
  assert.equal(preview.canApply, false);
  assert.ok(preview.invalid.length >= 1);
  assert.ok(preview.ignoredStockColumns.some((h) => /qty/i.test(h)));
});

await run("standalone Mongo apply fails closed with zero writes", async () => {
  const before = await ItemMaster.countDocuments({ companyId: companyA });
  let code = "";
  try {
    await applyItemMasterImport({
      companyId: companyA,
      buffer: xlsxBuffer([
        {
          Article: "ART-NEW-STANDALONE",
          Status: "Active",
          Vertical: "Engine",
          Brand: "MAN",
          "Item Name": "Should not persist",
          UOM: "PCS",
        },
      ]),
    });
  } catch (err) {
    code = err.code;
  }
  assert.equal(code, "ITEM_MASTER_IMPORT_ATOMICITY_UNAVAILABLE");
  assert.equal(await ItemMaster.countDocuments({ companyId: companyA }), before);
  assert.equal(await ItemMaster.countDocuments({ article: "ART-NEW-STANDALONE" }), 0);
});

await mongoose.disconnect();
await mongod.stop();

const replset = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
await mongoose.connect(replset.getUri(), { serverSelectionTimeoutMS: 30000 });
const applyCompanyA = new mongoose.Types.ObjectId();
const applyCompanyB = new mongoose.Types.ObjectId();
await seedPolicyItems(applyCompanyA, applyCompanyB);
await Supplier.create({
  companyId: applyCompanyA,
  supplierCode: "ACME1",
  supplierName: "Acme",
  name: "Acme",
});

await run("replica-set apply creates Article, preserves blanks, and ignores client company scope", async () => {
  const created = await applyItemMasterImport({
    companyId: applyCompanyA,
    buffer: xlsxBuffer([
      {
        Article: "ART-NEW-1",
        Status: "Active",
        Vertical: "Engine",
        Brand: "MAN",
        "Item Name": "New part",
        Description: "Created from import",
        UOM: "PCS",
        SPN: "051.001",
        companyId: String(applyCompanyB),
      },
    ]),
    userEmail: "admin@test",
  });
  assert.equal(created.apply.created, 1);
  const createdRow = await ItemMaster.findOne({ companyId: applyCompanyA, article: "ART-NEW-1" }).lean();
  assert.equal(createdRow.itemName, "New part");
  assert.equal(String(createdRow.companyId), String(applyCompanyA));
  const blank = await applyItemMasterImport({
    companyId: applyCompanyA,
    buffer: xlsxBuffer([
      {
        Article: "ART-ACTIVE",
        Description: "",
        "Item Name": "Renamed active",
      },
    ]),
  });
  assert.ok(blank.apply.updated >= 1);
  const row = await ItemMaster.findOne({ companyId: applyCompanyA, article: "ART-ACTIVE" }).lean();
  assert.equal(row.description, "Keep me");
  assert.equal(row.itemName, "Renamed active");
  assert.equal(row.article, "ART-ACTIVE");
  const tech = await ItemTechnical.findOne({ companyId: applyCompanyA, article: "ART-ACTIVE" }).lean();
  assert.equal(tech.spn, "OLD-SPN");
});

await run("blank cells do not erase; __CLEAR__ clears optional fields", async () => {
  await applyItemMasterImport({
    companyId: applyCompanyA,
    buffer: xlsxBuffer([{ Article: "ART-ACTIVE", SPN: "__CLEAR__" }]),
  });
  const tech = await ItemTechnical.findOne({ companyId: applyCompanyA, article: "ART-ACTIVE" }).lean();
  assert.equal(tech.spn, "");
});

await run("unknown supplier or invalid taxonomy blocks the entire apply", async () => {
  const before = await ItemMaster.countDocuments({ companyId: applyCompanyA });
  const preview = await previewItemMasterImport({
    companyId: applyCompanyA,
    buffer: xlsxBuffer([
      {
        Article: "ART-BAD-SUP",
        Vertical: "Engine",
        Brand: "MAN",
        "Item Name": "Bad",
        UOM: "PCS",
        "Supplier 1": "NoSuchVendor",
      },
    ]),
  });
  assert.equal(preview.canApply, false);
  let code = "";
  try {
    await applyItemMasterImport({
      companyId: applyCompanyA,
      buffer: xlsxBuffer([
        {
          Article: "ART-BAD-SUP",
          Vertical: "Engine",
          Brand: "MAN",
          "Item Name": "Bad",
          UOM: "PCS",
          "Supplier 1": "NoSuchVendor",
        },
      ]),
    });
  } catch (err) {
    code = err.code;
  }
  assert.equal(code, "ITEM_MASTER_IMPORT_INVALID");
  assert.equal(await ItemMaster.countDocuments({ companyId: applyCompanyA }), before);
});

await run("cross-company import cannot update the other company", async () => {
  const preview = await previewItemMasterImport({
    companyId: applyCompanyA,
    buffer: xlsxBuffer([{ Article: "ART-OTHERCO", "Item Name": "Hijack", Vertical: "Engine", Brand: "MAN" }]),
  });
  assert.ok(preview.newArticles.includes("ART-OTHERCO"));
  await applyItemMasterImport({
    companyId: applyCompanyA,
    buffer: xlsxBuffer([{ Article: "ART-OTHERCO", "Item Name": "Hijack", Vertical: "Engine", Brand: "MAN" }]),
  });
  const other = await ItemMaster.findOne({ companyId: applyCompanyB, article: "ART-OTHERCO" }).lean();
  assert.equal(other.itemName, "Other company");
  const cloned = await ItemMaster.findOne({ companyId: applyCompanyA, article: "ART-OTHERCO" }).lean();
  assert.equal(cloned.itemName, "Hijack");
});

await mongoose.disconnect();
await replset.stop();

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
