/**
 * Purchase Order register search by PO number and line Article (no Mongo).
 * Run: node scripts/poRegisterSearch.test.js
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import mongoose from "mongoose";
import { escapeRegex } from "../src/utils/documentSearch.js";
import {
  articleLineClause,
  buildPurchaseOrderListFilter,
  firstQueryString,
  normalizeArticleQuery,
  normalizePoNumberQuery,
  poNumberClause,
} from "../src/utils/purchaseOrderListFilter.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcRoot = path.join(__dirname, "..", "src");
const feRoot = path.join(__dirname, "..", "..", "src");

let passed = 0;
let failed = 0;
function run(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed += 1;
    console.error(`  ✗ ${name}`);
    console.error(`    ${e.message}`);
  }
}

console.log("\nPO register search (unit)\n");

const companyId = new mongoose.Types.ObjectId();

run("Empty filters preserve company-only listing filter", () => {
  const filter = buildPurchaseOrderListFilter(companyId, {});
  assert.deepEqual(filter, { companyId });
});

run("Missing companyId is rejected", () => {
  let code = "";
  try {
    buildPurchaseOrderListFilter("", { poNumber: "0201" });
  } catch (e) {
    code = e.code;
    assert.equal(e.statusCode, 400);
  }
  assert.equal(code, "COMPANY_REQUIRED");
});

run("PO-number query is trimmed, length-capped, and case-insensitive", () => {
  assert.equal(normalizePoNumberQuery("  MAR-PO-0201  "), "MAR-PO-0201");
  assert.equal(normalizePoNumberQuery("x".repeat(200)).length, 80);
  const clause = poNumberClause("  po-0201  ");
  assert.equal(clause.$or.length, 2);
  assert.equal(clause.$or[0].poNo.ignoreCase, true);
  assert.equal(clause.$or[0].poNo.source, escapeRegex("po-0201"));
});

run("Article search is exact, anchored, case-insensitive, and not uppercased", () => {
  assert.equal(normalizeArticleQuery("  a001  "), "a001");
  assert.equal(normalizeArticleQuery("800210"), "800210");
  assert.equal(normalizeArticleQuery("911206822.C"), "911206822.C");
  const clause = articleLineClause(" a001 ");
  assert.equal(clause["lines.article"] instanceof RegExp, true);
  assert.equal(clause["lines.article"].source, `^${escapeRegex("a001")}$`);
  assert.equal(clause["lines.article"].ignoreCase, true);
  assert.equal(clause["lines.article"].test("A001"), true);
  assert.equal(clause["lines.article"].test("a001"), true);
});

run("Numeric Article 800210 is exact and does not match longer or prefixed codes", () => {
  const re = articleLineClause("  800210  ")["lines.article"];
  assert.equal(re.test("800210"), true);
  assert.equal(re.test("1800210"), false);
  assert.equal(re.test("8002101"), false);
  assert.equal(re.test("800210-C"), false);
  assert.equal(re.test("X800210"), false);
});

run("Hyphenated Article BF-4488 is exact", () => {
  const re = articleLineClause("BF-4488")["lines.article"];
  assert.equal(re.test("BF-4488"), true);
  assert.equal(re.test("bf-4488"), true);
  assert.equal(re.test("XBF-4488"), false);
  assert.equal(re.test("BF-4488-C"), false);
});

run("Dotted Article is exact because the dot is escaped", () => {
  const re = articleLineClause("911206822.C")["lines.article"];
  assert.equal(re.source, `^${escapeRegex("911206822.C")}$`);
  assert.equal(re.test("911206822.C"), true);
  assert.equal(re.test("911206822XC"), false);
});

run("Regex characters in PO number and Article cannot broaden the query", () => {
  const po = poNumberClause("PO-0201.*");
  assert.equal(po.$or[0].poNo.source, escapeRegex("PO-0201.*"));
  assert.notEqual(po.$or[0].poNo.source, "PO-0201.*");
  const art = articleLineClause("A001(.*)");
  assert.equal(art["lines.article"].source, `^${escapeRegex("A001(.*)")}$`);
  assert.equal(art["lines.article"].test("A001XX"), false);
});

run("PO Number + Article are ANDed on the same company-scoped filter", () => {
  const filter = buildPurchaseOrderListFilter(companyId, {
    poNumber: "0201",
    article: "A001",
  });
  assert.equal(String(filter.companyId), String(companyId));
  assert.ok(Array.isArray(filter.$and));
  assert.equal(filter.$and.length, 2);
  assert.ok(filter.$and[0].$or);
  assert.equal(filter.$and[1]["lines.article"].source, "^A001$");
  assert.equal(filter.$and[1]["lines.article"].ignoreCase, true);
});

run("New filters combine with Supplier and Status", () => {
  const filter = buildPurchaseOrderListFilter(companyId, {
    poNumber: "0201",
    article: "A001",
    supplierName: "Sunjin.*",
    status: "draft",
  });
  assert.equal(filter.status, "DRAFT");
  assert.equal(filter.supplierName.source, escapeRegex("Sunjin.*"));
  assert.equal(filter.supplierName.ignoreCase, true);
  assert.equal(filter.$and.length, 2);
});

run("Non-scalar poNumber or article is INVALID_FILTER; empty string is no filter", () => {
  let poCode = "";
  try {
    buildPurchaseOrderListFilter(companyId, { poNumber: { $gt: "" } });
  } catch (e) {
    poCode = e.code;
    assert.equal(e.statusCode, 400);
  }
  assert.equal(poCode, "INVALID_FILTER");
  let artCode = "";
  try {
    buildPurchaseOrderListFilter(companyId, { article: ["A001", { $ne: null }] });
  } catch (e) {
    artCode = e.code;
    assert.equal(e.statusCode, 400);
  }
  assert.equal(artCode, "INVALID_FILTER");
  const empty = buildPurchaseOrderListFilter(companyId, { poNumber: "", article: "   " });
  assert.deepEqual(empty, { companyId });
  assert.equal(firstQueryString({ $gt: "" }), "");
});

run("Existing q search remains escaped and does not replace companyId", () => {
  const filter = buildPurchaseOrderListFilter(companyId, { q: "foo.*bar" });
  assert.equal(String(filter.companyId), String(companyId));
  assert.equal(filter.$or[0].poNo.source, escapeRegex("foo.*bar"));
});

run("Client companyId in the query cannot replace request companyId", () => {
  const other = new mongoose.Types.ObjectId();
  const filter = buildPurchaseOrderListFilter(companyId, {
    companyId: String(other),
    poNumber: "0201",
    article: "A001",
  });
  assert.equal(String(filter.companyId), String(companyId));
  assert.notEqual(String(filter.companyId), String(other));
});

run("List endpoint still uses PURCHASE.view and the shared filter helper", () => {
  const routes = fs.readFileSync(path.join(srcRoot, "routes", "purchaseRoutes.js"), "utf8");
  const controller = fs.readFileSync(path.join(srcRoot, "controllers", "purchaseController.js"), "utf8");
  assert.match(routes, /requirePermission\("PURCHASE", "view"\)/);
  assert.match(routes, /router\.get\("\/", purchaseView, c\.listPurchaseOrders\)/);
  assert.match(controller, /buildPurchaseOrderListFilter\(req\.companyId, req\.query\)/);
  assert.match(controller, /PurchaseOrder\.find\(filter\)\.sort\(\{ createdAt: -1 \}\)/);
  assert.match(controller, /PurchaseOrder\.countDocuments\(filter\)/);
  assert.doesNotMatch(controller, /filter = \{ \.\.\.req\.query/);
});

run("Register UI sends poNumber and article, Enter applies, Clear resets", () => {
  const page = fs.readFileSync(path.join(feRoot, "pages", "Purchase.jsx"), "utf8");
  assert.match(page, /label="PO Number"/);
  assert.match(page, /label="Article"/);
  assert.match(page, /label="Supplier"/);
  assert.match(page, /<FormField label="Status">/);
  assert.match(page, /placeholder="Exact Article code…"/);
  assert.match(page, /poNumber: poFilterPoNumber\.trim\(\) \|\| undefined/);
  assert.match(page, /article: poFilterArticle\.trim\(\) \|\| undefined/);
  assert.match(page, /Clear filters/);
  assert.match(page, /Apply filters/);
  assert.match(page, /onPoFilterKeyDown/);
  assert.match(page, /function applyPoRegisterFilters\(\) \{[\s\S]*setPage\(1\)/);
  assert.match(page, /function clearPoRegisterFilters\(\) \{[\s\S]*setPoFilterPoNumber\(""\)[\s\S]*setPoFilterArticle\(""\)[\s\S]*setPoFilterSupplier\(""\)[\s\S]*setPoFilterStatus\(""\)[\s\S]*setPage\(1\)/);
  assert.match(page, /No purchase orders found for the selected filters\./);
  assert.match(page, /queryKey: \[/);
  assert.match(page, /poFilterPoNumber/);
  assert.match(page, /poFilterArticle/);
  assert.doesNotMatch(page, /data\?\.items\?\.filter/);
  assert.match(page, /Exports the current page of filtered results/);
  assert.match(page, /Export CSV \(this page\)/);
  assert.match(page, /Export PDF \(this page\)/);
  assert.match(page, /New PO/);
  assert.match(page, /Open/);
  assert.match(page, /View PO/);
  assert.match(page, /Duplicate/);
  assert.match(page, /Modify/);
  assert.match(page, /Delete/);
  assert.match(page, /Upload invoice \/ PI/);
});

if (failed) {
  console.error(`\npoRegisterSearch.test.js failed: ${failed} failed, ${passed} passed`);
  process.exit(1);
}
console.log(`\npoRegisterSearch.test.js passed: ${passed}`);
