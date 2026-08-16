/**
 * Item Master taxonomy: Vertical → Brand → Model → Config.
 *
 * `engine` is a legacy alias for Brand (same hierarchy level). It must never
 * be mixed with Vertical. Do not fall back across taxonomy levels.
 */

export const CANONICAL_VERTICALS = Object.freeze([
  "Engine",
  "Turbocharger",
  "Compressor",
  "Pump",
  "Separator",
  "Generator",
  "Gearbox",
  "Auxiliary",
]);

export const CANONICAL_BRANDS = Object.freeze([
  "Wärtsilä",
  "Wartsila",
  "MAN",
  "MAK",
  "Himsen",
  "Caterpillar",
  "Yanmar",
  "Daihatsu",
  "Sulzer",
  "Bergen",
  "Hyundai Heavy Industries",
  "Rolls-Royce",
]);

const EMPTY_STRINGS = new Set(["", "undefined", "null", "n/a", "na", "-"]);

function fold(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

const VERTICAL_FOLD = new Map(CANONICAL_VERTICALS.map((v) => [fold(v), v]));
const BRAND_FOLD = new Map();
for (const b of CANONICAL_BRANDS) {
  const k = fold(b);
  if (!BRAND_FOLD.has(k)) BRAND_FOLD.set(k, b);
}
// ASCII Wartsila stays Wartsila — do not auto-merge to Wärtsilä.
BRAND_FOLD.set("wartsila", "Wartsila");
BRAND_FOLD.set("himsen", "Himsen");
BRAND_FOLD.set("man", "MAN");
BRAND_FOLD.set("mak", "MAK");

export function normalizeTaxonomyValue(value) {
  if (value == null) return "";
  const raw = String(value).trim().replace(/\s+/g, " ");
  if (!raw) return "";
  if (EMPTY_STRINGS.has(raw.toLowerCase())) return "";
  return raw;
}

export function isLikelyVerticalName(value) {
  const k = fold(value);
  return Boolean(k) && VERTICAL_FOLD.has(k);
}

export function isLikelyBrandName(value) {
  const k = fold(value);
  return Boolean(k) && BRAND_FOLD.has(k);
}

export function canonicalVerticalSpelling(value) {
  const n = normalizeTaxonomyValue(value);
  if (!n) return "";
  return VERTICAL_FOLD.get(fold(n)) || n;
}

export function canonicalBrandSpelling(value) {
  const n = normalizeTaxonomyValue(value);
  if (!n) return "";
  const k = fold(n);
  if (k === "wartsila") return /[äÄ]/.test(n) ? "Wärtsilä" : "Wartsila";
  return BRAND_FOLD.get(k) || n;
}

/**
 * Brand is stored historically on `engine`. Prefer explicit `brand` when present;
 * otherwise use `engine`. Never fall back to vertical/model/config.
 */
export function resolveBrandValue({ brand, engine } = {}) {
  const fromBrand = normalizeTaxonomyValue(brand);
  if (fromBrand) return fromBrand;
  return normalizeTaxonomyValue(engine);
}

export function buildTaxonomyFields(input = {}) {
  const vertical = normalizeTaxonomyValue(input.vertical);
  const brand = resolveBrandValue(input);
  const model = normalizeTaxonomyValue(input.model);
  const config = normalizeTaxonomyValue(input.config);
  return {
    vertical,
    brand,
    engine: brand,
    model,
    config,
  };
}

/**
 * Reject obvious Vertical/Brand inversion. Does not restrict unknown future brands.
 */
export function validateTaxonomyFields({ vertical, brand, engine } = {}) {
  const v = normalizeTaxonomyValue(vertical);
  const b = resolveBrandValue({ brand, engine });
  const errors = [];

  if (v && b && fold(v) === fold(b) && isLikelyBrandName(v) && isLikelyVerticalName(b)) {
    errors.push("Vertical and Brand appear swapped (manufacturer in Vertical, category in Brand)");
  } else {
    if (v && isLikelyBrandName(v) && !isLikelyVerticalName(v)) {
      errors.push(`"${v}" is a manufacturer/brand and cannot be stored as Vertical`);
    }
    if (b && isLikelyVerticalName(b) && !isLikelyBrandName(b)) {
      errors.push(`"${b}" is a category/vertical and cannot be stored as Brand`);
    }
  }

  if (v && b && fold(v) === fold(b) && isLikelyVerticalName(v)) {
    errors.push(`Brand cannot repeat Vertical category "${v}"`);
  }

  return { ok: errors.length === 0, errors, vertical: v, brand: b };
}

export function assertValidTaxonomy(input = {}) {
  const fields = buildTaxonomyFields(input);
  const check = validateTaxonomyFields(fields);
  if (!check.ok) {
    const err = new Error(check.errors.join("; "));
    err.code = "ITEM_TAXONOMY_INVALID";
    err.statusCode = 400;
    throw err;
  }
  return fields;
}

function headerKey(name) {
  return String(name || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

const VERTICAL_HEADERS = new Set(
  ["vertical", "verticle", "category"].map(headerKey)
);
const BRAND_HEADERS = new Set(
  ["brand", "maker", "manufacturer", "enginemake", "enginebrand"].map(headerKey)
);
const MODEL_HEADERS = new Set(["model", "enginemodel"].map(headerKey));
const CONFIG_HEADERS = new Set(["config", "configuration"].map(headerKey));

/**
 * Explicit import mapping. "Engine" / "Eng no" are NOT Brand aliases.
 */
export function mapImportTaxonomyColumns(row = {}) {
  const entries = Object.entries(row || {}).map(([k, v]) => [headerKey(k), v]);
  const pickFrom = (allowed) => {
    for (const [k, v] of entries) {
      if (allowed.has(k)) {
        const n = normalizeTaxonomyValue(v);
        if (n) return n;
      }
    }
    return "";
  };
  return {
    vertical: pickFrom(VERTICAL_HEADERS),
    brand: pickFrom(BRAND_HEADERS),
    model: pickFrom(MODEL_HEADERS),
    config: pickFrom(CONFIG_HEADERS),
  };
}

export function uniqueFacetValues(values = [], { canonicalizer = (x) => x } = {}) {
  const seen = new Map();
  for (const raw of values) {
    const n = normalizeTaxonomyValue(raw);
    if (!n) continue;
    const key = fold(n);
    if (!seen.has(key)) seen.set(key, canonicalizer(n));
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
}

/**
 * Cascading facet lists from in-memory rows (tests) or pre-filtered DB values.
 */
export function buildCascadingFacets(rows = [], { vertical = "", brand = "", model = "" } = {}) {
  const vSel = fold(vertical);
  const bSel = fold(brand);
  const mSel = fold(model);

  const verticals = uniqueFacetValues(
    rows.map((r) => r.vertical).filter((v) => !isLikelyBrandName(v) || isLikelyVerticalName(v)),
    { canonicalizer: canonicalVerticalSpelling }
  );

  const brandRows = vSel ? rows.filter((r) => fold(r.vertical) === vSel) : rows;
  const brands = uniqueFacetValues(
    brandRows
      .map((r) => resolveBrandValue(r))
      .filter((b) => !isLikelyVerticalName(b) || isLikelyBrandName(b)),
    { canonicalizer: canonicalBrandSpelling }
  );

  const modelRows = brandRows.filter((r) => {
    if (!bSel) return true;
    return fold(resolveBrandValue(r)) === bSel;
  });
  const models = uniqueFacetValues(modelRows.map((r) => r.model));

  const configRows = modelRows.filter((r) => {
    if (!mSel) return true;
    return fold(r.model) === mSel;
  });
  const configs = uniqueFacetValues(configRows.map((r) => r.config));

  return { verticals, brands, engines: brands, models, configs };
}

export function sanitizeIncomingTaxonomy(input = {}) {
  const taxonomy = buildTaxonomyFields(input);
  if (isDeterministicVerticalBrandSwap(taxonomy)) {
    return swappedTaxonomy(taxonomy);
  }
  const check = validateTaxonomyFields(taxonomy);
  if (!check.ok) {
    if (isLikelyBrandName(taxonomy.vertical) && !isLikelyVerticalName(taxonomy.vertical)) {
      taxonomy.vertical = "";
    }
    if (isLikelyVerticalName(taxonomy.brand) && !isLikelyBrandName(taxonomy.brand)) {
      taxonomy.brand = "";
      taxonomy.engine = "";
    }
  }
  return taxonomy;
}

export function isDeterministicVerticalBrandSwap(record = {}) {
  const vertical = normalizeTaxonomyValue(record.vertical);
  const brand = resolveBrandValue(record);
  if (!vertical || !brand) return false;
  return isLikelyBrandName(vertical) && isLikelyVerticalName(brand) && !isLikelyVerticalName(vertical);
}

export function swappedTaxonomy(record = {}) {
  const vertical = normalizeTaxonomyValue(record.vertical);
  const brand = resolveBrandValue(record);
  return buildTaxonomyFields({
    vertical: brand,
    brand: vertical,
    model: record.model,
    config: record.config,
  });
}
