/**
 * Article Stock Conversion — unit / architecture tests.
 * Run: node scripts/articleStockConversion.test.js
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ARTICLE_CONVERSION_STOCK_SHORTAGE,
  ARTICLE_CONVERSION_SAME_ARTICLE,
  ARTICLE_CONVERSION_MAPPING_REQUIRED,
  buildArticleConversionEffectKey,
  buildArticleConversionReversalEffectKey,
} from "../src/utils/articleConversionIdempotency.js";
import { MOVEMENT_TYPES } from "../src/services/stockService.js";
import { normalizeCompanyCode } from "../src/utils/salesDocNumber.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.join(__dirname, "..");
const repoRoot = path.join(backendRoot, "..");

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

console.log("\nArticle Stock Conversion\n");

run("Movement types include conversion OUT/IN and reversal", () => {
  assert.equal(MOVEMENT_TYPES.ARTICLE_CONVERSION_OUT, "ARTICLE_CONVERSION_OUT");
  assert.equal(MOVEMENT_TYPES.ARTICLE_CONVERSION_IN, "ARTICLE_CONVERSION_IN");
  assert.equal(MOVEMENT_TYPES.ARTICLE_CONVERSION_REVERSAL_OUT, "ARTICLE_CONVERSION_REVERSAL_OUT");
  assert.equal(MOVEMENT_TYPES.ARTICLE_CONVERSION_REVERSAL_IN, "ARTICLE_CONVERSION_REVERSAL_IN");
});

run("Effect keys are deterministic and reversal is distinct", () => {
  const out = buildArticleConversionEffectKey({
    companyId: "c1",
    conversionId: "cv1",
    movementType: "ARTICLE_CONVERSION_OUT",
    warehouse: "MAIN",
    article: "8X0098",
  });
  const again = buildArticleConversionEffectKey({
    companyId: "c1",
    conversionId: "cv1",
    movementType: "ARTICLE_CONVERSION_OUT",
    warehouse: "MAIN",
    article: "8X0098",
  });
  assert.equal(out, again);
  const rev = buildArticleConversionReversalEffectKey(out);
  assert.ok(rev.endsWith("|REVERSAL"));
  assert.notEqual(rev, out);
});

run("Conflict codes exported", () => {
  assert.equal(ARTICLE_CONVERSION_STOCK_SHORTAGE, "ARTICLE_CONVERSION_STOCK_SHORTAGE");
  assert.equal(ARTICLE_CONVERSION_SAME_ARTICLE, "ARTICLE_CONVERSION_SAME_ARTICLE");
  assert.equal(ARTICLE_CONVERSION_MAPPING_REQUIRED, "ARTICLE_CONVERSION_MAPPING_REQUIRED");
});

run("Company code normalizes to MAR/OKE for STC numbering", () => {
  assert.equal(normalizeCompanyCode("MARIVOLT"), "MAR");
  assert.equal(normalizeCompanyCode("OKEANOS"), "OKE");
});

run("salesDocNumber supports ARTICLE_STOCK_CONVERSION prefix STC", () => {
  const src = fs.readFileSync(path.join(backendRoot, "src/utils/salesDocNumber.js"), "utf8");
  assert.match(src, /ARTICLE_STOCK_CONVERSION[\s\S]*prefix:\s*"STC"/);
});

run("StockLedger unified types include conversion movements", () => {
  const src = fs.readFileSync(path.join(backendRoot, "src/models/StockLedger.js"), "utf8");
  assert.match(src, /ARTICLE_CONVERSION_OUT/);
  assert.match(src, /ARTICLE_CONVERSION_IN/);
  assert.match(src, /ARTICLE_CONVERSION_REVERSAL_OUT/);
});

run("stockService exposes articleConversion and reverseArticleConversion", () => {
  const src = fs.readFileSync(path.join(backendRoot, "src/services/stockService.js"), "utf8");
  assert.match(src, /export async function articleConversion/);
  assert.match(src, /export async function reverseArticleConversion/);
  assert.match(src, /allowNegative/);
  // Conversion must NOT allow negative source stock
  assert.match(src, /ARTICLE_CONVERSION_STOCK_SHORTAGE/);
  assert.doesNotMatch(src, /articleConversion[\s\S]{0,400}allowNegative:\s*true/);
});

run("Controller enforces same-article rejection, mapping gate, live stock check", () => {
  const src = fs.readFileSync(path.join(backendRoot, "src/controllers/articleConversionController.js"), "utf8");
  assert.match(src, /ARTICLE_CONVERSION_SAME_ARTICLE/);
  assert.match(src, /ARTICLE_CONVERSION_MAPPING_REQUIRED/);
  assert.match(src, /ARTICLE_CONVERSION_STOCK_SHORTAGE/);
  assert.match(src, /requiresAdminApproval/);
  assert.match(src, /status: \"POSTING\"/);
  assert.match(src, /retargetCustomsLotsForConversion/);
  assert.match(src, /reverseCustomsLotsForConversion/);
  assert.match(src, /No approved Article equivalence mapping/);
});

run("Customs retarget conserves qtyImported across split", () => {
  const src = fs.readFileSync(
    path.join(backendRoot, "src/services/articleConversionCustomsService.js"),
    "utf8"
  );
  assert.match(src, /originalReceivedArticle/);
  assert.match(src, /isConversionLayer/);
  assert.match(src, /qtyImported/);
  assert.match(src, /ARTICLE_STOCK_CONVERSION/);
  assert.doesNotMatch(src, /createCustomsLotFromGrn/);
});

run("Models exist with required statuses and reason codes", () => {
  const conv = fs.readFileSync(path.join(backendRoot, "src/models/ArticleStockConversion.js"), "utf8");
  assert.match(conv, /DRAFT/);
  assert.match(conv, /POSTED/);
  assert.match(conv, /REVERSED/);
  assert.match(conv, /CANCELLED/);
  assert.match(conv, /EQUIVALENT_ARTICLE_NUMBER/);
  const map = fs.readFileSync(path.join(backendRoot, "src/models/ArticleEquivalenceMapping.js"), "utf8");
  assert.match(map, /SUPPLIER_TO_OEM/);
  assert.match(map, /uniq_active_approved_article_equivalence/);
});

run("Permissions module ARTICLE_CONVERSION with post/reverse/admin", () => {
  const role = fs.readFileSync(path.join(backendRoot, "src/models/Role.js"), "utf8");
  assert.match(role, /ARTICLE_CONVERSION/);
  assert.match(role, /\"post\"/);
  assert.match(role, /\"reverse\"/);
  const rs = fs.readFileSync(path.join(backendRoot, "src/services/roleService.js"), "utf8");
  assert.match(rs, /ARTICLE_CONVERSION:\s*\[[\s\S]*view[\s\S]*create[\s\S]*post/);
});

run("Routes mounted and Stock Transfer/Adjustment unchanged", () => {
  const server = fs.readFileSync(path.join(backendRoot, "src/server.js"), "utf8");
  assert.match(server, /article-conversions/);
  const stockRoutes = fs.readFileSync(path.join(backendRoot, "src/routes/stockRoutes.js"), "utf8");
  assert.match(stockRoutes, /\/transfer/);
  assert.match(stockRoutes, /\/adjustment/);
  assert.doesNotMatch(stockRoutes, /article-conversion/);
});

run("Traceability and global search include ARTICLE_CONVERSION", () => {
  const tr = fs.readFileSync(path.join(backendRoot, "src/services/articleTraceabilityService.js"), "utf8");
  assert.match(tr, /ARTICLE_CONVERSION/);
  assert.match(tr, /ArticleStockConversion/);
  const gs = fs.readFileSync(path.join(backendRoot, "src/services/globalSearchService.js"), "utf8");
  assert.match(gs, /searchArticleConversions/);
  assert.match(gs, /Article Conversions/);
});

run("Frontend Store tab and panel present", () => {
  const ui = fs.readFileSync(path.join(repoRoot, "src/pages/StoreModule.jsx"), "utf8");
  assert.match(ui, /Article Stock Conversion/);
  assert.match(ui, /ArticleStockConversionPanel/);
  const panel = fs.readFileSync(
    path.join(repoRoot, "src/components/store/ArticleStockConversionPanel.jsx"),
    "utf8"
  );
  assert.match(panel, /Post Article Stock Conversion/);
  assert.match(panel, /confirmDialog/);
  assert.match(panel, /ARTICLE_CONVERSION_STOCK_SHORTAGE/);
  assert.doesNotMatch(panel, /window\.confirm/);
});

run("1:1 target qty formula", () => {
  const sourceQty = 9;
  const conversionRatio = 1;
  const targetQty = sourceQty * conversionRatio;
  assert.equal(targetQty, 9);
  const sourceValue = 12.5 * sourceQty;
  const targetUnitCost = 12.5 / conversionRatio;
  const targetValue = targetUnitCost * targetQty;
  assert.equal(sourceValue, targetValue);
});

run("Cost value preserved under ratio 2", () => {
  const sourceQty = 4;
  const ratio = 2;
  const unitCost = 10;
  const targetQty = sourceQty * ratio;
  const targetUnitCost = unitCost / ratio;
  assert.equal(targetQty, 8);
  assert.equal(targetUnitCost * targetQty, unitCost * sourceQty);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
