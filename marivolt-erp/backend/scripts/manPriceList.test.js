/**
 * MAN Price List + RFQ → quotation (no Mongo).
 * Run: node scripts/manPriceList.test.js
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  getDefaultPermissionsForRole,
  hasPermission,
} from "../src/services/roleService.js";
import { PERMISSION_ACTIONS, PERMISSION_MODULES } from "../src/models/Role.js";
import { toSalesDto, toManagementDto } from "../src/services/manPriceListService.js";
import {
  MAN_PRICE_LIST_HEADERS,
  MAN_PRICE_LIST_ADMIN_ROLES,
  buildCsv,
  canonicalCsvHeader,
  cellIsBlank,
  assertNoForbiddenSalesPriceKeys,
  applyManRfqCurrencyGate,
  applyManRfqCurrencyPricing,
  canonicalizeManFxRates,
  clipManFxNote,
  convertManSourceUnitPrice,
  findManFxSnapshot,
  manCurrenciesMatch,
  manRfqRequestHash,
  manRfqFxRateRequiredMessage,
  MAN_RFQ_CURRENCY_MISMATCH,
  MAN_RFQ_FX_NOTE_MAX,
  MAN_RFQ_FX_RATE_DECIMALS,
  MAN_RFQ_FX_RATE_MAX,
  MAN_RFQ_FX_RATE_REQUIRED,
  normalizeManCurrency,
  normalizeManFxRateList,
  parseManFxRate,
  SALES_ALLOWED_FX_AUDIT_KEYS,
  classifyManRfqCandidates,
  collectForbiddenSalesPriceKeys,
  displayedItemMasterSpn,
  displayedItemMasterSpecs,
  displayedSupplier1,
  escapeCsvCell,
  formatExportAvailability,
  formatManAvailability,
  isManEligibleItem,
  isManPriceListAdminRole,
  mapCsvRow,
  mergeBlankPreserving,
  modelsEquivalent,
  normalizeEngineModel,
  normalizePartNoForMatch,
  parseOptionalMoney,
  parseRfqCsvRow,
  permittedTiersForMatrix,
  preserveArticleCode,
  publicSellingPrices,
  redactManRfqMatchResponse,
  redactQuotationForSalesApi,
  resolveManRfqRequestMode,
  resolveRfqLineModel,
  selectedManRfqCandidate,
  uniqueManEngineModels,
  rowHasDuplicateArticle,
  quotationLineTotal,
  roundQuotationMoney,
  formatQuotationMoney,
  sanitizeCsvFormula,
  sanitizeCustomerQuotationPrint,
  shouldSkipUnchangedImport,
  stripPurchaseFields,
  tierIsSelectable,
  toSalesMatchPrices,
  uomsCompatible,
} from "../src/utils/manPriceList.js";

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

async function runAsync(name, fn) {
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

console.log("\nMAN Price List / RFQ\n");

run("PRICE_LIST module and tier actions exist", () => {
  assert.ok(PERMISSION_MODULES.includes("PRICE_LIST"));
  for (const a of ["price_tier_sell", "price_tier_sell_ii", "price_tier_minm", "price_tier_rock"]) {
    assert.ok(PERMISSION_ACTIONS.includes(a), a);
  }
});

run("Admin / Super Admin have PRICE_LIST management; sales and company_admin do not", () => {
  const admin = getDefaultPermissionsForRole("admin");
  const superAdmin = getDefaultPermissionsForRole("super_admin");
  const companyAdmin = getDefaultPermissionsForRole("company_admin");
  const sales = getDefaultPermissionsForRole("sales");
  for (const action of ["view", "create", "edit", "export"]) {
    assert.ok(admin.PRICE_LIST.includes(action), `admin ${action}`);
    assert.ok(superAdmin.PRICE_LIST.includes(action), `super_admin ${action}`);
  }
  assert.deepEqual(companyAdmin.PRICE_LIST || [], []);
  assert.deepEqual(sales.PRICE_LIST || [], []);
  assert.ok(sales.SALES.includes("price_tier_sell"));
  assert.ok(sales.SALES.includes("price_tier_sell_ii"));
  assert.ok(sales.SALES.includes("price_tier_minm"));
  assert.ok(!sales.SALES.includes("price_tier_rock"));
  assert.ok(admin.SALES.includes("price_tier_rock"));
});

await runAsync("hasPermission denies sales PRICE_LIST including export", async () => {
  const salesReq = { user: { role: "sales" } };
  const adminReq = { user: { role: "admin" } };
  assert.equal(await hasPermission(salesReq, "PRICE_LIST", "view"), false);
  assert.equal(await hasPermission(salesReq, "PRICE_LIST", "export"), false);
  assert.equal(await hasPermission({ user: { role: "company_admin" } }, "PRICE_LIST", "view"), false);
  assert.equal(await hasPermission({ user: { role: "company_admin" } }, "PRICE_LIST", "export"), false);
  assert.equal(await hasPermission(salesReq, "SALES", "create"), true);
  assert.equal(await hasPermission(salesReq, "SALES", "price_tier_rock"), false);
  assert.equal(await hasPermission(adminReq, "PRICE_LIST", "export"), true);
  assert.equal(await hasPermission(adminReq, "SALES", "price_tier_rock"), true);
});

run("Sales DTO never includes purchase fields", () => {
  const dto = toSalesDto(
    {
      _id: "pl1",
      itemMasterId: "im1",
      article: "A1",
      currency: "USD",
      sellPrice: 10,
      sellIi: 9,
      minm: 8,
      rock: 7,
      buy: 4,
      nextBuy: 3.5,
      leadTime: "8 Weeks",
      isActive: true,
      revision: 2,
      updatedAt: new Date("2026-01-01"),
    },
    { canRock: false, uom: "PCS" }
  );
  assert.equal(dto.buy, undefined);
  assert.equal(dto.nextBuy, undefined);
  assert.equal(dto.supplier, undefined);
  assert.equal(dto.id, undefined);
  assert.equal(dto.itemMasterId, undefined);
  assert.equal(dto.rock, null);
  assert.equal(dto.sellPrice, 10);
  assert.equal(dto.revision, 2);
  const mgmt = toManagementDto(
    { _id: "pl1", itemMasterId: "im1", article: "A1", buy: 4, nextBuy: 3.5, sellPrice: 10, revision: 1, isActive: true },
    { supplier: "ACME" }
  );
  assert.equal(mgmt.buy, 4);
  assert.equal(mgmt.nextBuy, 3.5);
  assert.equal(mgmt.id, "pl1");
  assert.equal(mgmt.itemMasterId, "im1");
});

run("stripPurchaseFields removes Buy / Next Buy / supplier purchasing", () => {
  const stripped = stripPurchaseFields({ article: "A1", sellPrice: 10, buy: 1, nextBuy: 2, supplierName: "X", supplierPartNumber: "Y" });
  assert.equal(stripped.buy, undefined);
  assert.equal(stripped.nextBuy, undefined);
  assert.equal(stripped.supplierName, undefined);
  assert.equal(stripped.sellPrice, 10);
});

run("MAN eligibility is canonical brand MAN only (not MAK / Wärtsilä / substring)", () => {
  assert.equal(isManEligibleItem({ brand: "MAN", engine: "MAN" }), true);
  assert.equal(isManEligibleItem({ engine: "MAN" }), true);
  assert.equal(isManEligibleItem({ brand: "MAK" }), false);
  assert.equal(isManEligibleItem({ brand: "Wartsila", engine: "Wartsila" }), false);
  assert.equal(isManEligibleItem({ brand: "Wärtsilä" }), false);
  assert.equal(isManEligibleItem({ brand: "Himsen" }), false);
  assert.equal(isManEligibleItem({ description: "MAN spare for Wartsila" }), false);
});

run("Part no maps to SPN; Supplier part No. maps to Supplier 1 P/N; Sell 2 alias", () => {
  const mapped = mapCsvRow({
    Article: "00012",
    "Part no": "051.001",
    "Sell 2": "12.5",
    "Supplier part No.": "SP-9",
    Description: "Filter",
  });
  assert.equal(mapped["Part no"], "051.001");
  assert.equal(mapped["Sell II"], "12.5");
  assert.equal(mapped["Supplier part No."], "SP-9");
  assert.equal(canonicalCsvHeader("Sell 2"), "Sell II");
  assert.equal(preserveArticleCode("00012"), "00012");
  assert.equal(displayedItemMasterSpn({ spn: "MASTER" }, { spn: "TECH-001" }), "TECH-001");
  assert.equal(displayedItemMasterSpn({ spn: "MASTER" }, {}), "MASTER");
  assert.equal(displayedSupplier1({ supplierName: "Acme", supplierPartNumber: "SP-9" }, { supplierPartNumber: "IGNORED" }).partNumber, "SP-9");
  assert.equal(displayedSupplier1(null, { supplier: "Acme" }).name, "Acme");
  assert.equal(displayedSupplier1(null, { supplierPartNumber: "SCALAR" }).partNumber, "");
});

run("Article / SPN string identity keeps leading zeros", () => {
  assert.equal(preserveArticleCode("0010"), "0010");
  assert.equal(normalizePartNoForMatch("  0123-AB  "), "0123-AB");
  assert.equal(normalizePartNoForMatch("12  34"), "12 34");
});

run("Blank cells are not zero and preserve existing values", () => {
  assert.equal(cellIsBlank(""), true);
  assert.equal(parseOptionalMoney("").present, false);
  assert.equal(parseOptionalMoney("0").present, true);
  assert.equal(parseOptionalMoney("0").value, 0);
  const merged = mergeBlankPreserving({ sellPrice: 10, minm: 8 }, { sellPrice: "", minm: 9, rock: "" }, ["sellPrice", "minm", "rock"]);
  assert.equal(merged.next.sellPrice, 10);
  assert.equal(merged.next.minm, 9);
  assert.equal(merged.next.rock, undefined);
});

run("Duplicate Article rows in an upload are detected", () => {
  assert.deepEqual(rowHasDuplicateArticle(["A1", "A2", "a1"]), ["A1"]);
});

run("Negative / invalid prices flagged; missing tier not selectable", () => {
  assert.ok(parseOptionalMoney("-1").error);
  assert.ok(parseOptionalMoney("abc").error);
  assert.equal(tierIsSelectable({ sellPrice: null, minm: 5 }, "SELL"), false);
  assert.equal(tierIsSelectable({ sellPrice: 0 }, "SELL"), true);
  assert.equal(tierIsSelectable({ sellIi: 9 }, "SELL_II"), true);
});

run("SET is not treated as PCS", () => {
  assert.equal(uomsCompatible("SET", "PCS"), false);
  assert.equal(uomsCompatible("PCS", "PCS"), true);
  assert.equal(uomsCompatible("", "PCS"), false);
});

run("CSV formula injection and UTF-8 template headers", () => {
  assert.equal(sanitizeCsvFormula("=CMD"), "'=CMD");
  assert.equal(sanitizeCsvFormula("+1+1"), "'+1+1");
  assert.equal(sanitizeCsvFormula("@SUM"), "'@SUM");
  assert.equal(escapeCsvCell("a,b"), '"a,b"');
  const csv = buildCsv(MAN_PRICE_LIST_HEADERS, [{ Article: "=1+1", "Part no": "001" }]);
  assert.ok(csv.startsWith("\uFEFF"));
  assert.ok(csv.includes("'=1+1"));
  assert.equal(MAN_PRICE_LIST_HEADERS[0], "Article");
  assert.equal(MAN_PRICE_LIST_HEADERS[16], "Next Buy");
});

run("Repeat unchanged import skips new revision; stale change does not skip", () => {
  assert.equal(shouldSkipUnchangedImport({ creating: false, hasItemChanges: false, beforeHash: "x", nextHash: "x" }), true);
  assert.equal(shouldSkipUnchangedImport({ creating: true, hasItemChanges: false, beforeHash: "x", nextHash: "x" }), false);
  assert.equal(shouldSkipUnchangedImport({ creating: false, hasItemChanges: true, beforeHash: "x", nextHash: "x" }), false);
  assert.equal(shouldSkipUnchangedImport({ creating: false, hasItemChanges: false, beforeHash: "old", nextHash: "new" }), false);
});

run("RFQ match: one, exactly two, none, UOM mismatch, missing price", () => {
  const priced = { sellPrice: 10, revision: 1 };
  const one = classifyManRfqCandidates([
    { article: "A1", uomOk: true, prices: priced, pricingOk: true, modelConflict: false },
  ]);
  assert.equal(one.status, "MATCHED");
  assert.equal(one.pick.article, "A1");

  const two = classifyManRfqCandidates([
    { article: "A1", uomOk: true, prices: priced, pricingOk: true, modelConflict: false, pricesSell: 50 },
    { article: "A2", uomOk: true, prices: { ...priced, sellPrice: 1 }, pricingOk: true, modelConflict: false },
  ]);
  assert.equal(two.status, "MULTIPLE");
  assert.equal(two.pick, null);

  const none = classifyManRfqCandidates([]);
  assert.equal(none.status, "NOT_FOUND");

  const uom = classifyManRfqCandidates([
    { article: "A1", uomOk: false, prices: priced, pricingOk: true, modelConflict: false },
  ]);
  assert.equal(uom.status, "REVIEW");

  const missing = classifyManRfqCandidates([
    { article: "A1", uomOk: true, prices: null, pricingOk: false, modelConflict: false },
  ]);
  assert.equal(missing.status, "PRICING_REQUIRED");
});

run("MAN engine models are distinct, display-preserving, and exclude other brands", () => {
  const models = uniqueManEngineModels([
    { brand: "MAN", engine: "MAN", model: "21/31" },
    { brand: "MAN", model: "  21/31  " },
    { brand: "MAN", model: "32/40" },
    { brand: "Wärtsilä", model: "6L20" },
    { brand: "MAK", engine: "MAK", model: "M32C" },
    { brand: "MAN", model: "" },
  ]);
  assert.deepEqual(models, ["21/31", "32/40"]);
  assert.equal(normalizeEngineModel("  21/31  "), "21/31");
  assert.equal(modelsEquivalent("21/31", "21 / 31"), false);
  assert.equal(modelsEquivalent("21/31", "21/31"), true);
});

run("Header model fills blank RFQ lines; mixed and conflict rules", () => {
  const filled = resolveRfqLineModel({ headerMode: "SELECTED", headerModel: "21/31", lineModel: "" });
  assert.equal(filled.resolvedModel, "21/31");
  assert.equal(filled.originalCustomerModel, "");
  assert.equal(filled.headerLineConflict, false);

  const conflict = resolveRfqLineModel({ headerMode: "SELECTED", headerModel: "21/31", lineModel: "32/40" });
  assert.equal(conflict.headerLineConflict, true);

  const mixed = resolveRfqLineModel({ headerMode: "MIXED", headerModel: "21/31", lineModel: "" });
  assert.equal(mixed.lineModelMissing, true);
  assert.equal(mixed.resolvedModel, "");

  const unspecified = resolveRfqLineModel({ headerMode: "UNSPECIFIED", headerModel: "", lineModel: "" });
  assert.equal(unspecified.resolvedModel, "");
});

run("Shared modelMode parser infers SELECTED only for legacy missing mode + header; rejects unknown values", () => {
  const inferred = resolveManRfqRequestMode({ headerModel: "21/31" });
  assert.equal(inferred.ok, true);
  assert.equal(inferred.mode, "SELECTED");
  assert.equal(inferred.inferred, true);

  const missing = resolveManRfqRequestMode({});
  assert.equal(missing.ok, false);
  assert.equal(missing.code, "MAN_RFQ_MODEL_REQUIRED");

  const invalid = resolveManRfqRequestMode({ modelMode: "ALL_MODELS", headerModel: "21/31" });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.code, "MAN_RFQ_MODEL_MODE_INVALID");

  const mixed = resolveManRfqRequestMode({ modelMode: "mixed" });
  assert.equal(mixed.ok, true);
  assert.equal(mixed.mode, "MIXED");
  assert.equal(mixed.inferred, false);
});

run("Multiple candidates never populate selectedArticle, tier, price or total from candidates[0]; order does not matter", () => {
  const pricedA = { sellPrice: 50, revision: 1 };
  const pricedB = { sellPrice: 1, revision: 1 };
  const aFirst = classifyManRfqCandidates(
    [
      { article: "A21", model: "21/31", uomOk: true, prices: pricedA, pricingOk: true, modelConflict: false },
      { article: "A32", model: "21/31", uomOk: true, prices: pricedB, pricingOk: true, modelConflict: false },
    ],
    { headerMode: "SELECTED", resolvedModel: "21/31", modelAware: true }
  );
  const bFirst = classifyManRfqCandidates(
    [
      { article: "A32", model: "21/31", uomOk: true, prices: pricedB, pricingOk: true, modelConflict: false },
      { article: "A21", model: "21/31", uomOk: true, prices: pricedA, pricingOk: true, modelConflict: false },
    ],
    { headerMode: "SELECTED", resolvedModel: "21/31", modelAware: true }
  );
  assert.equal(aFirst.status, "MULTIPLE");
  assert.equal(bFirst.status, "MULTIPLE");
  assert.equal(aFirst.pick, null);
  assert.equal(bFirst.pick, null);
  const line = {
    status: aFirst.status,
    selectedArticle: "",
    candidates: aFirst.compatible,
    priceTier: "",
    unitPrice: undefined,
  };
  assert.equal(selectedManRfqCandidate(line), null);
  assert.equal(line.selectedArticle, "");
  assert.equal(line.priceTier, "");
  assert.equal(line.unitPrice, undefined);
});

run("Model-aware classify: mismatch, UOM after model filter, unspecified multiple, mixed required", () => {
  const priced = { sellPrice: 10, revision: 1 };
  const mismatch = classifyManRfqCandidates(
    [
      {
        article: "A32",
        model: "32/40",
        uomOk: true,
        prices: priced,
        pricingOk: true,
        modelConflict: true,
      },
    ],
    { headerMode: "SELECTED", resolvedModel: "21/31", modelAware: true }
  );
  assert.equal(mismatch.status, "MODEL_MISMATCH");
  assert.deepEqual(mismatch.availableModels, ["32/40"]);

  const uom = classifyManRfqCandidates(
    [
      {
        article: "A21",
        model: "21/31",
        uomOk: false,
        prices: priced,
        pricingOk: true,
        modelConflict: false,
      },
    ],
    { headerMode: "SELECTED", resolvedModel: "21/31", modelAware: true }
  );
  assert.equal(uom.status, "UOM_MISMATCH");

  const unspecified = classifyManRfqCandidates(
    [
      { article: "A21", model: "21/31", uomOk: true, prices: priced, pricingOk: true, modelConflict: false },
      { article: "A32", model: "32/40", uomOk: true, prices: priced, pricingOk: true, modelConflict: false },
    ],
    { headerMode: "UNSPECIFIED", resolvedModel: "", modelAware: true }
  );
  assert.equal(unspecified.status, "MULTIPLE");

  const mixed = classifyManRfqCandidates(
    [{ article: "A21", model: "21/31", uomOk: true, prices: priced, pricingOk: true, modelConflict: false }],
    { headerMode: "MIXED", lineModelMissing: true, modelAware: true }
  );
  assert.equal(mixed.status, "MODEL_REQUIRED");

  const one = classifyManRfqCandidates(
    [
      { article: "A21", model: "21/31", uomOk: true, prices: priced, pricingOk: true, modelConflict: false },
      { article: "A32", model: "32/40", uomOk: true, prices: priced, pricingOk: true, modelConflict: true },
    ],
    { headerMode: "SELECTED", resolvedModel: "21/31", modelAware: true }
  );
  assert.equal(one.status, "MATCHED");
  assert.equal(one.pick.article, "A21");
});

run("Live availability strings: full, partial, zero, missing lead time", () => {
  assert.equal(formatManAvailability({ availableQty: 10, requestedQty: 4, uom: "PCS", leadTime: "8 Weeks" }), "Ex-Stock");
  assert.equal(
    formatManAvailability({ availableQty: 4, requestedQty: 10, uom: "PCS", leadTime: "8 Weeks" }),
    "4 PCS Ex-Stock; balance 6 PCS: 8 Weeks"
  );
  assert.equal(formatManAvailability({ availableQty: 0, requestedQty: 10, uom: "PCS", leadTime: "8 Weeks" }), "8 Weeks");
  assert.equal(formatManAvailability({ availableQty: 0, requestedQty: 10, uom: "PCS", leadTime: "" }), "Lead time to be confirmed");
  assert.equal(formatExportAvailability({ availableQty: 2, leadTime: "8 Weeks" }), "Ex-Stock");
  assert.equal(formatExportAvailability({ availableQty: 0, leadTime: "" }), "Lead time to be confirmed");
});

run("Tier authorization helpers and sales cannot select Rock by default", () => {
  const salesTiers = permittedTiersForMatrix({ SALES: ["price_tier_sell", "price_tier_sell_ii", "price_tier_minm"] });
  assert.deepEqual(salesTiers, ["SELL", "SELL_II", "MINM"]);
  const adminTiers = permittedTiersForMatrix({}, { isAdmin: true });
  assert.ok(adminTiers.includes("ROCK"));
});

run("Customer print snapshot omits purchase, tier, price-list revision, and audit notes", () => {
  const printed = sanitizeCustomerQuotationPrint({
    quotationNo: "QT-1",
    internalNotes: "Buy 4 / floor Minm",
    manRfqIdempotencyKey: "abc",
    manRfqRequestHash: "hash",
    manRfqModelMode: "SELECTED",
    vesselPlant: "MV Atlantic",
    esn: "ESN-99",
    lines: [
      {
        article: "A1",
        description: "Filter",
        partNumber: "051.001",
        customerPartNo: "051.001",
        qty: 2,
        uom: "PCS",
        price: 10,
        totalPrice: 20,
        availability: "Ex-Stock",
        priceTier: "MINM",
        priceListId: "pl1",
        priceListRevision: 9,
        buy: 4,
        nextBuy: 5,
        sourceCurrency: "EUR",
        sourceUnitPrice: 8.55,
        conversionRate: 1.17,
        convertedCurrency: "USD",
        convertedUnitPrice: 10,
      },
    ],
    manRfqFxRates: [{ sourceCurrency: "EUR", targetCurrency: "USD", rate: 1.17, note: "internal" }],
  });
  assert.equal(printed.internalNotes, "");
  assert.equal(printed.manRfqModelMode, "");
  assert.equal(printed.manRfqRequestHash, "");
  assert.deepEqual(printed.manRfqFxRates, []);
  assert.equal(printed.vesselPlant, "MV Atlantic");
  assert.equal(printed.esn, "ESN-99");
  assert.equal(printed.lines[0].price, 10);
  assert.equal(printed.lines[0].customerPartNo, "051.001");
  assert.equal(printed.lines[0].priceTier, undefined);
  assert.equal(printed.lines[0].priceListId, undefined);
  assert.equal(printed.lines[0].buy, undefined);
  assert.equal(printed.lines[0].nextBuy, undefined);
  assert.equal(printed.lines[0].sourceCurrency, undefined);
  assert.equal(printed.lines[0].sourceUnitPrice, undefined);
  assert.equal(printed.lines[0].conversionRate, undefined);
  assert.equal(printed.lines[0].convertedUnitPrice, undefined);
});

run("Sales quotation API redaction strips purchase and price-list ids", () => {
  const createdAt = new Date("2026-01-02T00:00:00.000Z");
  const redacted = redactQuotationForSalesApi({
    _id: "q1",
    quotationNo: "QT-1",
    createdAt,
    lines: [{ _id: "ln1", article: "A1", price: 10, buy: 4, nextBuy: 5, priceListId: "pl", priceListRevision: 3 }],
  });
  assert.equal(redacted._id, "q1");
  assert.equal(redacted.createdAt, createdAt);
  assert.equal(redacted.lines[0]._id, "ln1");
  assert.equal(redacted.lines[0].price, 10);
  assert.equal(redacted.lines[0].buy, undefined);
  assert.equal(redacted.lines[0].priceListId, undefined);
  assert.equal(redacted.lines[0].priceListRevision, undefined);
  assert.deepEqual(collectForbiddenSalesPriceKeys(redacted), []);
});

run("Sales match payloads keep numeric revision and drop nested price-list ids", () => {
  const leaked = {
    lines: [
      {
        selectedArticle: "A1",
        priceListRevision: 4,
        priceListId: "should-drop",
        buy: 1,
        nextBuy: 2,
        candidates: [
          {
            article: "A1",
            prices: {
              id: "pl-mongo",
              _id: "pl-mongo",
              revision: 4,
              sellPrice: 10,
              buy: 3,
              supplierName: "Acme",
            },
          },
        ],
      },
    ],
  };
  assert.ok(collectForbiddenSalesPriceKeys(leaked).includes("lines[0].priceListId"));
  assert.ok(collectForbiddenSalesPriceKeys(leaked).includes("lines[0].candidates[0].prices.id"));
  const clean = redactManRfqMatchResponse(leaked);
  assert.equal(clean.lines[0].priceListRevision, 4);
  assert.equal(clean.lines[0].priceListId, undefined);
  assert.equal(clean.lines[0].buy, undefined);
  assert.equal(clean.lines[0].candidates[0].prices.id, undefined);
  assert.equal(clean.lines[0].candidates[0].prices.sellPrice, 10);
  assertNoForbiddenSalesPriceKeys(clean, "match");
  const salesPrices = toSalesMatchPrices(
    { _id: "mongo-id", revision: 4, sellPrice: 10, rock: 1, buy: 9, currency: "USD" },
    { canRock: false }
  );
  assert.equal(salesPrices.id, undefined);
  assert.equal(salesPrices._id, undefined);
  assert.equal(salesPrices.revision, 4);
  assert.equal(salesPrices.rock, null);
  assert.equal(salesPrices.buy, undefined);
  assertNoForbiddenSalesPriceKeys({ candidates: [{ prices: salesPrices }] }, "sales prices");
});

run("Quotation money rounding uses 2 dp; source precision parse preserved", () => {
  assert.equal(roundQuotationMoney(10.126), 10.13);
  assert.equal(parseOptionalMoney("10.125").value, 10.125);
  assert.equal(quotationLineTotal(109.76, 12), 1317.12);
  assert.equal(quotationLineTotal(459.2, 5), 2296);
  assert.equal(roundQuotationMoney(quotationLineTotal(109.76, 12) + quotationLineTotal(459.2, 5)), 3613.12);
  assert.equal(formatQuotationMoney(109.76 * 12), "1,317.12");
  assert.equal(formatQuotationMoney(459.2), "459.20");
  assert.equal(formatQuotationMoney(2296), "2,296.00");
  assert.equal(formatQuotationMoney(109.76), "109.76");
  const visible = JSON.stringify({
    price: roundQuotationMoney(109.76),
    totalPrice: quotationLineTotal(109.76, 12),
    subTotal: 3613.12,
    grandTotal: quotationLineTotal(109.76, 12),
  });
  assert.doesNotMatch(visible, /1317\.1200000000001/);
  assert.match(visible, /1317\.12/);
});

run("Currency codes are trim/uppercase normalized", () => {
  assert.equal(normalizeManCurrency(" eur "), "EUR");
  assert.equal(manCurrenciesMatch("eur", "EUR"), true);
  assert.equal(manCurrenciesMatch("EUR", "USD"), false);
});

run("FX rates reject missing, zero, negative, NaN, Infinity, string garbage and excessive values", () => {
  assert.equal(parseManFxRate("").ok, false);
  assert.equal(parseManFxRate(null).ok, false);
  assert.equal(parseManFxRate(0).ok, false);
  assert.equal(parseManFxRate(-1).ok, false);
  assert.equal(parseManFxRate(Number.NaN).ok, false);
  assert.equal(parseManFxRate(Number.POSITIVE_INFINITY).ok, false);
  assert.equal(parseManFxRate("nope").ok, false);
  assert.equal(parseManFxRate(MAN_RFQ_FX_RATE_MAX + 1).ok, false);
  assert.equal(parseManFxRate("1.1700").rate, 1.17);
  assert.equal(parseManFxRate(1.123456789).rate, 1.12345679);
  assert.equal(MAN_RFQ_FX_RATE_DECIMALS, 8);
});

run("Round converted unit price first then line total: EUR 459.20 × 1.1700 = USD 537.26", () => {
  assert.equal(convertManSourceUnitPrice(459.2, 1.17), 537.26);
  const converted = applyManRfqCurrencyPricing({
    quotationCurrency: "USD",
    sourceCurrency: "EUR",
    sourceUnitPrice: 459.2,
    fxRates: [{ sourceCurrency: "EUR", targetCurrency: "USD", rate: 1.17 }],
  });
  assert.equal(converted.ok, true);
  assert.equal(converted.convertedUnitPrice, 537.26);
  assert.equal(converted.unitPrice, 537.26);
  assert.equal(converted.conversionRate, 1.17);
  assert.equal(converted.sourceUnitPrice, 459.2);
});

run("Round converted unit price first then line total: USD 537.26 × qty 5 = USD 2,686.30", () => {
  assert.equal(quotationLineTotal(537.26, 5), 2686.3);
  assert.equal(formatQuotationMoney(2686.3), "2,686.30");
});

run("Round converted unit price first then line total: EUR 109.76 × 1.1700 = USD 128.42", () => {
  assert.equal(convertManSourceUnitPrice(109.76, 1.17), 128.42);
});

run("Round converted unit price first then line total: USD 128.42 × qty 12 = USD 1,541.04", () => {
  assert.equal(quotationLineTotal(128.42, 12), 1541.04);
  assert.equal(formatQuotationMoney(1541.04), "1,541.04");
});

run("Multi-line converted subtotal uses rounded unit prices then qty", () => {
  assert.equal(roundQuotationMoney(quotationLineTotal(537.26, 5) + quotationLineTotal(128.42, 12)), 4227.34);
});

run("EUR → AED converts from original source using a manually entered rate", () => {
  const aed = applyManRfqCurrencyPricing({
    quotationCurrency: "AED",
    sourceCurrency: "EUR",
    sourceUnitPrice: 459.2,
    fxRates: [{ sourceCurrency: "EUR", targetCurrency: "AED", rate: 4.2 }],
  });
  assert.equal(aed.convertedUnitPrice, 1928.64);
  assert.equal(quotationLineTotal(aed.convertedUnitPrice, 5), 9643.2);
});

run("EUR → EUR uses rate 1 with no conversion input", () => {
  const same = applyManRfqCurrencyPricing({
    quotationCurrency: "EUR",
    sourceCurrency: "eur",
    sourceUnitPrice: 459.2,
    fxRates: [{ sourceCurrency: "EUR", targetCurrency: "EUR", rate: 9 }],
  });
  assert.equal(same.ok, true);
  assert.equal(same.unitPrice, 459.2);
  assert.equal(same.conversionRate, 1);
  assert.equal(same.convertedUnitPrice, 459.2);
});

run("Changing the rate reprices from original EUR and never from previously converted USD", () => {
  const first = applyManRfqCurrencyPricing({
    quotationCurrency: "USD",
    sourceCurrency: "EUR",
    sourceUnitPrice: 459.2,
    fxRates: [{ sourceCurrency: "EUR", targetCurrency: "USD", rate: 1.17 }],
  });
  const second = applyManRfqCurrencyPricing({
    quotationCurrency: "USD",
    sourceCurrency: "EUR",
    sourceUnitPrice: 459.2,
    unitPrice: first.convertedUnitPrice,
    fxRates: [{ sourceCurrency: "EUR", targetCurrency: "USD", rate: 1.2 }],
  });
  assert.equal(first.convertedUnitPrice, 537.26);
  assert.equal(second.convertedUnitPrice, 551.04);
  assert.notEqual(second.convertedUnitPrice, roundQuotationMoney(537.26 * 1.2));
});

run("Different currency with no rate is FX_RATE_REQUIRED and never relabels the source amount", () => {
  const needed = applyManRfqCurrencyGate({
    quotationCurrency: "USD",
    priceCurrency: "EUR",
    unitPrice: 459.2,
  });
  assert.equal(needed.ok, false);
  assert.equal(needed.status, MAN_RFQ_FX_RATE_REQUIRED);
  assert.equal(needed.unitPrice, undefined);
  assert.equal(needed.sourceUnitPrice, 459.2);
  assert.equal(needed.sourceCurrency, "EUR");
  assert.match(needed.reason, /1 EUR = \[rate\] USD/);
  assert.equal(manRfqFxRateRequiredMessage("EUR", "USD"), "A conversion rate is required (1 EUR = [rate] USD).");
});

run("Exact source→target pair is required; inverted USD→EUR is not used", () => {
  const inverted = findManFxSnapshot(
    [{ sourceCurrency: "USD", targetCurrency: "EUR", rate: 1.17 }],
    "EUR",
    "USD"
  );
  assert.equal(inverted, null);
  const priced = applyManRfqCurrencyPricing({
    quotationCurrency: "USD",
    sourceCurrency: "EUR",
    sourceUnitPrice: 459.2,
    fxRates: [{ sourceCurrency: "USD", targetCurrency: "EUR", rate: 1.17 }],
  });
  assert.equal(priced.status, MAN_RFQ_FX_RATE_REQUIRED);
});

run("Duplicate FX pairs first-win when identical and conflict when rates differ", () => {
  const same = canonicalizeManFxRates([
    { sourceCurrency: "eur", targetCurrency: "usd", rate: 1.17 },
    { sourceCurrency: "EUR", targetCurrency: "USD", rate: 1.17 },
  ]);
  assert.equal(same.ok, true);
  assert.equal(same.snapshots.length, 1);
  assert.equal(same.snapshots[0].rate, 1.17);
  const conflict = canonicalizeManFxRates([
    { sourceCurrency: "EUR", targetCurrency: "USD", rate: 1.17 },
    { sourceCurrency: "EUR", targetCurrency: "USD", rate: 1.2 },
  ]);
  assert.equal(conflict.ok, false);
  assert.equal(conflict.code, MAN_RFQ_CURRENCY_MISMATCH);
  const firstWins = normalizeManFxRateList([
    { sourceCurrency: "EUR", targetCurrency: "USD", rate: 1.17 },
    { sourceCurrency: "EUR", targetCurrency: "USD", rate: 1.2 },
  ]);
  assert.equal(firstWins.length, 1);
  assert.equal(firstWins[0].rate, 1.17);
});

run("Idempotency hash includes quotation currency, canonical FX order, articles, qty and tier", () => {
  const lines = [{ article: "EUR459", qty: 5, uom: "PCS", price: 537.26, priceTier: "SELL", sourceCurrency: "EUR", conversionRate: 1.17 }];
  const hashA = manRfqRequestHash({
    customerId: "c1",
    currency: "USD",
    lines,
    fxRates: [
      { sourceCurrency: "USD", targetCurrency: "AED", rate: 3.67 },
      { sourceCurrency: "EUR", targetCurrency: "USD", rate: 1.17 },
    ],
  });
  const hashB = manRfqRequestHash({
    customerId: "c1",
    currency: "USD",
    lines,
    fxRates: [
      { sourceCurrency: "EUR", targetCurrency: "USD", rate: 1.17 },
      { sourceCurrency: "USD", targetCurrency: "AED", rate: 3.67 },
    ],
  });
  const hashC = manRfqRequestHash({
    customerId: "c1",
    currency: "USD",
    lines,
    fxRates: [{ sourceCurrency: "EUR", targetCurrency: "USD", rate: 1.2 }],
  });
  const hashD = manRfqRequestHash({
    customerId: "c1",
    currency: "EUR",
    lines,
    fxRates: [{ sourceCurrency: "EUR", targetCurrency: "USD", rate: 1.17 }],
  });
  assert.equal(hashA, hashB);
  assert.notEqual(hashA, hashC);
  assert.notEqual(hashA, hashD);
  assert.match(hashA, /"currency":"USD"/);
  assert.match(hashA, /"sourceCurrency":"EUR"/);
  assert.match(hashA, /"targetCurrency":"USD"/);
  assert.match(hashA, /"article":"EUR459"/);
  assert.match(hashA, /"priceTier":"SELL"/);
});

run("FX notes are clipped to 200 characters and customer print never shows them", () => {
  assert.equal(clipManFxNote("  keep  ").length, 4);
  assert.equal(clipManFxNote("x".repeat(500)).length, MAN_RFQ_FX_NOTE_MAX);
  const printed = sanitizeCustomerQuotationPrint({
    currency: "USD",
    internalNotes: "desk rate",
    manRfqFxRates: [{ sourceCurrency: "EUR", targetCurrency: "USD", rate: 1.17, note: "internal", enteredBy: "u1" }],
    lines: [{ article: "A1", description: "Filter", qty: 1, uom: "PCS", price: 10, totalPrice: 10, sourceUnitPrice: 8 }],
  });
  assert.deepEqual(printed.manRfqFxRates, []);
  assert.equal(printed.internalNotes, "");
  assert.equal(printed.lines[0].sourceUnitPrice, undefined);
  assert.equal(printed.lines[0].price, 10);
});

run("Sales may keep selling-side FX audit and must never leak Buy / price-list ids", () => {
  assert.ok(SALES_ALLOWED_FX_AUDIT_KEYS.includes("sourceUnitPrice"));
  assert.ok(SALES_ALLOWED_FX_AUDIT_KEYS.includes("manRfqFxRates"));
  const sales = redactQuotationForSalesApi({
    quotationNo: "QT-1",
    manRfqFxRates: [{ sourceCurrency: "EUR", targetCurrency: "USD", rate: 1.17, note: "desk", enteredBy: "sales@test.local" }],
    lines: [
      {
        article: "A1",
        price: 537.26,
        sourceCurrency: "EUR",
        sourceUnitPrice: 459.2,
        conversionRate: 1.17,
        convertedCurrency: "USD",
        convertedUnitPrice: 537.26,
        buy: 4,
        nextBuy: 5,
        priceListId: "pl1",
      },
    ],
  });
  assert.equal(sales.lines[0].sourceUnitPrice, 459.2);
  assert.equal(sales.lines[0].conversionRate, 1.17);
  assert.equal(sales.manRfqFxRates[0].enteredBy, "sales@test.local");
  assert.equal(sales.lines[0].buy, undefined);
  assert.equal(sales.lines[0].priceListId, undefined);
  assertNoForbiddenSalesPriceKeys(sales, "sales fx audit");
});

run("Public selling prices do not include Buy", () => {
  const pub = publicSellingPrices({ sellPrice: 1, buy: 9, nextBuy: 8 });
  assert.equal(pub.buy, undefined);
  assert.equal(pub.sellPrice, 1);
});

run("RFQ CSV required fields parse Part no / UOM / Qty", () => {
  const row = parseRfqCsvRow({ "Part no": "051.001", UOM: "PCS", Qty: "10", Description: "x" });
  assert.equal(row.partNo, "051.001");
  assert.equal(row.uom, "PCS");
  assert.equal(row.qty, "10");
});

run("RFQ CSV optional Engine Model, Configuration, Specifications, Customer Line and Customer Reference", () => {
  const row = parseRfqCsvRow({
    "Part no": "051.001",
    UOM: "PCS",
    Qty: "2",
    "Engine Model": "32/40",
    Configuration: "Std",
    Specifications: "Coated",
    "Customer Line": "10",
    "Customer Reference": "RFQ-1",
  });
  assert.equal(row.engineModel, "32/40");
  assert.equal(row.configuration, "Std");
  assert.equal(row.specifications, "Coated");
  assert.equal(row.customerLine, "10");
  assert.equal(row.customerReference, "RFQ-1");
  assert.equal(displayedItemMasterSpecs({ technicalSpecifications: [{ specName: "SPECS", specValue: "Coated" }] }), "Coated");
});

run("Server routes enforce PRICE_LIST on management/export and SALES.create on RFQ", () => {
  const plRoutes = fs.readFileSync(path.join(srcRoot, "routes", "manPriceListRoutes.js"), "utf8");
  const rfqRoutes = fs.readFileSync(path.join(srcRoot, "routes", "manRfqRoutes.js"), "utf8");
  const rfqService = fs.readFileSync(path.join(srcRoot, "services", "manRfqService.js"), "utf8");
  const plService = fs.readFileSync(path.join(srcRoot, "services", "manPriceListService.js"), "utf8");
  const quotation = fs.readFileSync(path.join(srcRoot, "controllers", "quotationController.js"), "utf8");
  const itemModel = fs.readFileSync(path.join(srcRoot, "models", "itemMasterModel.js"), "utf8");
  assert.match(plRoutes, /requirePermission\("PRICE_LIST", "view"\)/);
  assert.match(plRoutes, /requirePermission\("PRICE_LIST", "export"\)/);
  assert.match(plRoutes, /requireRole\(\.\.\.MAN_PRICE_LIST_ADMIN_ROLES\)/);
  assert.match(plRoutes, /\/export/);
  assert.deepEqual([...MAN_PRICE_LIST_ADMIN_ROLES], ["super_admin", "admin"]);
  assert.equal(isManPriceListAdminRole("company_admin"), false);
  assert.equal(isManPriceListAdminRole("admin"), true);
  const qModel = fs.readFileSync(path.join(srcRoot, "models", "Quotation.js"), "utf8");
  const migrate = fs.readFileSync(path.join(srcRoot, "..", "scripts", "migrate-man-rfq-quotation-index.mjs"), "utf8");
  assert.match(qModel, /uniq_company_manRfqIdempotencyKey_manRfq/);
  assert.match(qModel, /sourceType: "MAN_RFQ"/);
  assert.doesNotMatch(qModel, /sparse:\s*true/);
  assert.match(migrate, /const apply = process\.argv\.includes\("--apply"\)/);
  assert.match(migrate, /duplicate qualifying MAN_RFQ keys/);
  assert.match(migrate, /ABORT:/);
  assert.match(migrate, /dry-run only\. No indexes were dropped or created/);
  assert.match(migrate, /sourceType: "MAN_RFQ"/);
  assert.match(plService, /runMongoTransaction/);
  assert.match(plService, /injectFailureAfter/);
  assert.match(plService, /Price List import never writes Item Master/);
  assert.match(plService, /cannot be used in Price List/);
  assert.match(plService, /classifyPriceListItemMaster/);
  assert.match(plService, /throwPriceListArticleIssues/);
  assert.match(plService, /inactiveArticle/);
  assert.match(plService, /cannot be used on a new transaction/);
  assert.doesNotMatch(plService, /techSet\.spn = proposed\.spn/);
  assert.match(plService, /ItemSupplier\[0\]\.supplierPartNumber \(Supplier 1 P\/N\)/);
  assert.match(rfqRoutes, /requireAllPermissions\(\["SALES", "create"\], \["MAN_ENGINE", "create"\]\)/);
  assert.match(rfqRoutes, /\/models/);
  assert.match(rfqRoutes, /\/items\/:article/);
  assert.doesNotMatch(rfqRoutes, /PRICE_LIST/);
  assert.match(rfqService, /TIER_DENIED/);
  assert.match(rfqService, /STALE_PRICE/);
  assert.match(rfqService, /skipAutoCreateItems: true/);
  assert.doesNotMatch(rfqService, /priceListId:\s*pick\.prices/);
  assert.doesNotMatch(rfqService, /findById\(/);
  assert.doesNotMatch(rfqService, /line\.priceListId/);
  assert.match(rfqService, /redactManRfqMatchResponse/);
  assert.match(rfqService, /CURRENCY_MISMATCH/);
  assert.match(rfqService, /CURRENCY_REQUIRED/);
  assert.match(rfqService, /applyManRfqCurrencyPricing/);
  assert.match(rfqService, /priceCurrency/);
  assert.match(rfqService, /manRfqFxRates/);
  assert.match(rfqService, /sourceUnitPrice/);
  assert.doesNotMatch(rfqService, /exchangeRate/);
  assert.match(qModel, /vesselPlant/);
  assert.match(rfqService, /vesselPlant: String\(headerFromBody\.vesselPlant/);
  assert.match(rfqService, /esn: String\(headerFromBody\.esn/);
  assert.doesNotMatch(rfqService, /esn: headerFromBody\.vesselPlant/);
  const rfqPage = fs.readFileSync(path.join(feRoot, "pages", "ManRfqQuotation.jsx"), "utf8");
  assert.doesNotMatch(rfqPage, /priceListId/);
  assert.doesNotMatch(rfqPage, /return \{\s*\.\.\.ln/);
  assert.doesNotMatch(rfqPage, /console\.(log|debug|info|warn)/);
  assert.match(rfqPage, /STALE_PRICE/);
  assert.match(rfqPage, /priceListRevision/);
  assert.match(rfqPage, /selectedArticle/);
  assert.match(rfqPage, /Quotation Details/);
  assert.match(rfqPage, /Create Draft Quotation/);
  assert.match(rfqPage, /Refresh Stock & Lead Time/);
  assert.match(rfqPage, /Apply Price Level/);
  assert.match(rfqPage, /vesselPlant/);
  assert.match(rfqPage, /Engine Serial Number \(ESN\)/);
  assert.doesNotMatch(rfqPage, /ESN \/ vessel \/ plant/);
  assert.doesNotMatch(rfqPage, /candidates\?\.\[0\]/);
  assert.doesNotMatch(rfqPage, /r\.candidates\?\.\[0\]/);
  assert.match(rfqPage, /formatQuotationMoney/);
  assert.match(rfqPage, /quotationLineTotal/);
  assert.doesNotMatch(rfqPage, /Number\(unit\) \* Number\(ln\.qty/);
  const manUtil = fs.readFileSync(path.join(srcRoot, "utils", "manPriceList.js"), "utf8");
  assert.match(manUtil, /MAN_RFQ_MODEL_REQUIRED/);
  assert.match(manUtil, /MAN_RFQ_MODEL_MODE_INVALID/);
  assert.match(manUtil, /MAN_RFQ_CONFIG_CONFLICT/);
  assert.match(manUtil, /MAN_RFQ_SPEC_CONFLICT/);
  assert.match(manUtil, /applyManRfqCurrencyPricing/);
  assert.match(manUtil, /MAN_RFQ_CURRENCY_MISMATCH/);
  assert.match(manUtil, /MAN_RFQ_FX_RATE_REQUIRED/);
  assert.match(manUtil, /convertManSourceUnitPrice/);
  assert.doesNotMatch(manUtil, /exchangeRate/);
  assert.doesNotMatch(rfqPage, /exchangeRate/);
  assert.match(rfqPage, /CURRENCY_MISMATCH/);
  assert.match(rfqPage, /FX_RATE_REQUIRED/);
  assert.match(rfqPage, /Currency Conversion/);
  assert.match(rfqPage, /Apply conversion and reprice/);
  assert.match(rfqPage, /Use source currency \{singleSourceCurrency\} instead/);
  assert.match(rfqPage, /1 \{sourceCurrency\} =/);
  assert.match(rfqPage, /Source currency: \{sourceCurrency\} · Quotation currency: \{header\.currency\}/);
  assert.match(rfqPage, /needsConversion/);
  assert.match(rfqPage, /conversionSources/);
  assert.match(rfqPage, /lineIsReady/);
  assert.match(rfqPage, /setFxInputs\(\{\}\)/);
  assert.match(rfqPage, /tierUnit\(prices, ln\.priceTier/);
  assert.match(rfqPage, /Source Price/);
  assert.match(rfqPage, /Quotation Unit Price/);
  assert.match(rfqPage, /lineConversion/);
  assert.match(rfqPage, /Create Draft Quotation/);
  assert.match(rfqPage, /included\.every\(\(l\) => lineIsReady/);
  assert.doesNotMatch(rfqPage, /nextBuy/);
  assert.doesNotMatch(rfqPage, /priceListId/);
  assert.doesNotMatch(rfqPage, /\bbuy\b/);
  assert.doesNotMatch(rfqPage, /enteredBy/);
  assert.match(rfqService, /resolveManRfqRequestMode/);
  assert.match(rfqService, /MAN_RFQ_MODEL_ERROR_CODES\.REQUIRED/);
  assert.match(rfqService, /MAN_RFQ_MODEL_ERROR_CODES\.CONFIG_CONFLICT/);
  assert.match(rfqService, /MAN_RFQ_MODEL_ERROR_CODES\.SPEC_CONFLICT/);
  assert.match(plService, /companyId: req\.companyId/);
  assert.match(plService, /Unknown Article/);
  assert.match(plService, /STALE_PREVIEW/);
  assert.match(plService, /supplierPartNumber/);
  assert.match(quotation, /persistNewQuotation/);
  assert.match(quotation, /sanitizeCustomerQuotationPrint/);
  assert.match(quotation, /redactQuotationForSalesApi/);
  assert.match(quotation, /quotationLineTotal/);
  assert.match(quotation, /roundQuotationMoney/);
  assert.doesNotMatch(quotation, /const totalPrice = qty \* price/);
  assert.match(quotation, /delete body\.manRfqIdempotencyKey/);
  assert.match(itemModel, /partNumber/);
  assert.match(plService, /spn: cellIsBlank\(data\["Part no"\]\)/);
});

run("UI routes and Item Master MAN tab exist; stock is not written by this module", () => {
  const app = fs.readFileSync(path.join(feRoot, "App.jsx"), "utf8");
  const sidebar = fs.readFileSync(path.join(feRoot, "components", "Sidebar.jsx"), "utf8");
  const rbacAccess = fs.readFileSync(path.join(feRoot, "lib", "rbacAccess.js"), "utf8");
  const itemMaster = fs.readFileSync(path.join(feRoot, "pages", "ItemMaster.jsx"), "utf8");
  const plService = fs.readFileSync(path.join(srcRoot, "services", "manPriceListService.js"), "utf8");
  const rfqService = fs.readFileSync(path.join(srcRoot, "services", "manRfqService.js"), "utf8");
  const stockService = fs.readFileSync(path.join(srcRoot, "services", "manRfqService.js"), "utf8");
  assert.match(app, /path="price-list"/);
  assert.match(app, /path="sales\/man-rfq"/);
  assert.match(rbacAccess, /Price List/);
  assert.match(rbacAccess, /MAN RFQ \/ Quotation/);
  assert.match(sidebar, /filterSidebarNav/);
  assert.match(itemMaster, /MAN Price List/);
  assert.match(itemMaster, /Engine Model/);
  const priceListPage = fs.readFileSync(path.join(feRoot, "pages", "PriceList.jsx"), "utf8");
  const salesPage = fs.readFileSync(path.join(feRoot, "pages", "Sales.jsx"), "utf8");
  assert.match(priceListPage, /Available Stock/);
  assert.match(priceListPage, /Engine Model/);
  assert.match(salesPage, /vesselPlant/);
  assert.match(salesPage, /Vessel \/ Plant/);
  assert.match(plService, /getStockBalance/);
  assert.doesNotMatch(plService, /adjustStock|createStockMovement|postStock/);
  assert.doesNotMatch(rfqService, /allocateStock|createReservation/);
  assert.match(stockService, /getStockBalance/);
});

run("Existing manual quotation path remains on persistNewQuotation without MAN gating", () => {
  const quotation = fs.readFileSync(path.join(srcRoot, "controllers", "quotationController.js"), "utf8");
  const salesFlow = fs.readFileSync(path.join(srcRoot, "controllers", "salesFlowController.js"), "utf8");
  assert.match(quotation, /export async function persistNewQuotation/);
  assert.match(quotation, /skipAutoCreateItems = false/);
  assert.match(quotation, /export async function createQuotation/);
  assert.doesNotMatch(quotation, /isManEligibleItem/);
  assert.match(salesFlow, /convertQuotationToOA/);
});

if (failed) {
  console.error(`\nmanPriceList.test.js failed: ${failed} failed, ${passed} passed`);
  process.exit(1);
}
console.log(`\nmanPriceList.test.js passed: ${passed}`);
