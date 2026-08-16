/**
 * Item Master taxonomy regression tests (no Mongo).
 */
import assert from "node:assert/strict";
import {
  assertValidTaxonomy,
  buildCascadingFacets,
  canonicalBrandSpelling,
  mapImportTaxonomyColumns,
  normalizeTaxonomyValue,
  resolveBrandValue,
  sanitizeIncomingTaxonomy,
  validateTaxonomyFields,
} from "../src/utils/itemMasterTaxonomy.js";

function run(name, fn) {
  fn();
  console.log(`  ✓ ${name}`);
}

console.log("itemMasterTaxonomy.test.js");

const sampleRows = [
  { vertical: "Engine", brand: "Wartsila", engine: "Wartsila", model: "W34SG", config: "20V" },
  { vertical: "Engine", brand: "MAN", engine: "MAN", model: "48/60", config: "12V" },
  { vertical: "Engine", brand: "Himsen", engine: "Himsen", model: "32/40", config: "9L" },
  { vertical: "Engine", brand: "MAK", engine: "MAK", model: "M32C", config: "8L" },
  { vertical: "Wartsila", brand: "Engine", engine: "Engine", model: "W38B", config: "8L" },
];

run("TEST 1: Engine/Wartsila/W34SG/20V does not put Wartsila in Vertical facets", () => {
  const facets = buildCascadingFacets(sampleRows);
  assert.ok(facets.verticals.includes("Engine"));
  assert.ok(!facets.verticals.includes("Wartsila"));
  assert.ok(facets.brands.includes("Wartsila"));
});

run("TEST 2: Engine does not appear as Brand", () => {
  const facets = buildCascadingFacets(sampleRows);
  assert.ok(!facets.brands.includes("Engine"));
  assert.deepEqual(facets.engines, facets.brands);
});

run("TEST 3: multiple brands under Engine remain valid", () => {
  const facets = buildCascadingFacets(sampleRows, { vertical: "Engine" });
  for (const b of ["Wartsila", "MAN", "Himsen", "MAK"]) {
    assert.ok(facets.brands.includes(b), `missing ${b}`);
  }
});

run("TEST 4: brand/model cascading", () => {
  const facets = buildCascadingFacets(sampleRows, { vertical: "Engine", brand: "Wartsila" });
  assert.ok(facets.models.includes("W34SG"));
  assert.ok(!facets.models.includes("48/60"));
  assert.ok(!facets.models.includes("M32C"));
});

run("TEST 5: config cascading", () => {
  const facets = buildCascadingFacets(sampleRows, {
    vertical: "Engine",
    brand: "Wartsila",
    model: "W34SG",
  });
  assert.deepEqual(facets.configs, ["20V"]);
});

run("TEST 6: CSV import maps Vertical and Brand independently", () => {
  const mapped = mapImportTaxonomyColumns({
    Vertical: "Engine",
    Brand: "Wartsila",
    Model: "W34SG",
    Config: "20V",
  });
  assert.equal(mapped.vertical, "Engine");
  assert.equal(mapped.brand, "Wartsila");
  const fields = assertValidTaxonomy(mapped);
  assert.equal(fields.engine, "Wartsila");
});

run("TEST 7: Excel-style Maker alias maps to Brand, Engine column does not", () => {
  const mapped = mapImportTaxonomyColumns({
    Vertical: "Engine",
    Maker: "MAN",
    Engine: "Engine",
    Model: "48/60",
    Config: "12V",
  });
  assert.equal(mapped.vertical, "Engine");
  assert.equal(mapped.brand, "MAN");
  assert.notEqual(mapped.brand, "Engine");
});

run("TEST 8: create payload Engine/Wartsila/W34SG/20V writes correct fields", () => {
  const fields = assertValidTaxonomy({
    vertical: "Engine",
    engine: "Wartsila",
    model: "W34SG",
    config: "20V",
  });
  assert.equal(fields.vertical, "Engine");
  assert.equal(fields.brand, "Wartsila");
  assert.equal(fields.engine, "Wartsila");
  assert.equal(fields.model, "W34SG");
  assert.equal(fields.config, "20V");
});

run("TEST 9: edit preserves taxonomy; brand preferred over engine when both set", () => {
  const fields = assertValidTaxonomy({
    vertical: "Engine",
    brand: "Himsen",
    engine: "Wartsila",
    model: "32/40",
    config: "9L",
  });
  assert.equal(fields.brand, "Himsen");
  assert.equal(fields.engine, "Himsen");
});

run("TEST 10: legacy fallback does not cross-populate Vertical from Brand", () => {
  const fields = resolveBrandValue({ vertical: "Engine", brand: "", engine: "Wartsila" });
  assert.equal(fields, "Wartsila");
  const noCross = resolveBrandValue({ vertical: "Engine", brand: "", engine: "" });
  assert.equal(noCross, "");
});

run("TEST 11: Himsen whitespace/case canonicalizes for facets", () => {
  assert.equal(normalizeTaxonomyValue(" Himsen "), "Himsen");
  assert.equal(canonicalBrandSpelling("HIMSEN"), "Himsen");
  const facets = buildCascadingFacets([
    { vertical: "Engine", engine: "Himsen", model: "32/40", config: "9L" },
    { vertical: "Engine", engine: "HIMSEN", model: "32/40", config: "9L" },
  ]);
  assert.equal(facets.brands.filter((b) => /^himsen$/i.test(b)).length, 1);
  assert.equal(facets.brands[0], "Himsen");
});

run("TEST 12: existing normal records unaffected by validation", () => {
  const check = validateTaxonomyFields({
    vertical: "Engine",
    brand: "MAK",
    model: "M32C",
    config: "8L",
  });
  assert.equal(check.ok, true);
});

run("swapped Vertical/Brand is rejected on create/import", () => {
  const check = validateTaxonomyFields({ vertical: "Wartsila", engine: "Engine" });
  assert.equal(check.ok, false);
});

run("PO sanitizer swaps inverted taxonomy", () => {
  const out = sanitizeIncomingTaxonomy({ vertical: "Wartsila", brand: "Engine", model: "W38B", config: "8L" });
  assert.equal(out.vertical, "Engine");
  assert.equal(out.brand, "Wartsila");
  assert.equal(out.engine, "Wartsila");
  assert.equal(out.model, "W38B");
});

run("Eng no / Engine headers are not Brand", () => {
  const mapped = mapImportTaxonomyColumns({
    Vertical: "Engine",
    "Eng no": "PAAE028882",
    Engine: "Wartsila",
    Brand: "MAK",
  });
  assert.equal(mapped.brand, "MAK");
});

console.log("itemMasterTaxonomy.test.js: all passed");
