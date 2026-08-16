/**
 * READ-ONLY Item Master taxonomy audit.
 * Does not mutate MongoDB.
 *
 * Run from backend: node scripts/auditItemMasterTaxonomy.readonly.mjs
 */
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import mongoose from "mongoose";
import ItemMaster from "../src/models/itemMasterModel.js";
import {
  isLikelyBrandName,
  isLikelyVerticalName,
  isDeterministicVerticalBrandSwap,
  normalizeTaxonomyValue,
  resolveBrandValue,
} from "../src/utils/itemMasterTaxonomy.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function fold(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function countBy(rows, pick) {
  const map = new Map();
  for (const row of rows) {
    const key = normalizeTaxonomyValue(pick(row)) || "(empty)";
    map.set(key, (map.get(key) || 0) + 1);
  }
  return [...map.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function printCounts(title, entries) {
  console.log(`\n=== ${title} ===`);
  for (const [k, n] of entries) {
    console.log(`${String(k).padEnd(32)} ${n}`);
  }
}

async function main() {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) {
    console.error("No MONGODB_URI/MONGO_URI — cannot query live data");
    process.exit(2);
  }
  await mongoose.connect(uri);

  const rows = await ItemMaster.find({})
    .select(
      "_id companyId article itemName description vertical brand engine model config esn source sourcePoNo createdAt updatedAt"
    )
    .lean();

  console.log(`Item Master records: ${rows.length}`);

  const verticalCounts = countBy(rows, (r) => r.vertical);
  const brandCounts = countBy(rows, (r) => resolveBrandValue(r));
  const engineFieldCounts = countBy(rows, (r) => r.engine);
  const brandFieldCounts = countBy(rows, (r) => r.brand);
  const modelCounts = countBy(rows, (r) => r.model);
  const configCounts = countBy(rows, (r) => r.config);

  printCounts("Vertical values", verticalCounts);
  printCounts("Brand (resolved brand||engine)", brandCounts);
  printCounts("Raw engine field", engineFieldCounts);
  printCounts("Raw brand field", brandFieldCounts);
  printCounts("Model values", modelCounts);
  printCounts("Config values", configCounts);

  const suspiciousVertical = rows.filter(
    (r) => normalizeTaxonomyValue(r.vertical) && isLikelyBrandName(r.vertical) && !isLikelyVerticalName(r.vertical)
  );
  const suspiciousBrand = rows.filter((r) => {
    const b = resolveBrandValue(r);
    return b && isLikelyVerticalName(b) && !isLikelyBrandName(b);
  });
  const swaps = rows.filter((r) => isDeterministicVerticalBrandSwap(r));

  const verticalSet = new Set(verticalCounts.map(([k]) => fold(k)).filter((k) => k && k !== "(empty)"));
  const brandSet = new Set(brandCounts.map(([k]) => fold(k)).filter((k) => k && k !== "(empty)"));
  const overlap = [...verticalSet].filter((k) => brandSet.has(k));

  const caseDupes = (entries) => {
    const groups = new Map();
    for (const [k, n] of entries) {
      if (k === "(empty)") continue;
      const f = fold(k);
      if (!groups.has(f)) groups.set(f, []);
      groups.get(f).push({ value: k, count: n });
    }
    return [...groups.values()].filter((g) => g.length > 1);
  };

  const brandCaseDupes = caseDupes(brandCounts);
  const verticalCaseDupes = caseDupes(verticalCounts);

  console.log("\n=== Suspicious Vertical (looks like manufacturer) ===");
  console.log(`count: ${suspiciousVertical.length}`);
  console.log("\n=== Suspicious Brand (looks like category) ===");
  console.log(`count: ${suspiciousBrand.length}`);
  console.log("\n=== Deterministic Vertical/Brand swaps ===");
  console.log(`count: ${swaps.length}`);
  console.log("\n=== Distinct Vertical ∩ Brand overlap (folded) ===");
  console.log(overlap.join(", ") || "(none)");
  console.log("\n=== Brand case/whitespace duplicates ===");
  console.log(JSON.stringify(brandCaseDupes, null, 2));
  console.log("\n=== Vertical case/whitespace duplicates ===");
  console.log(JSON.stringify(verticalCaseDupes, null, 2));

  const sample = (list, n = 25) =>
    list.slice(0, n).map((r) => ({
      _id: String(r._id),
      article: r.article,
      description: r.description || r.itemName,
      vertical: r.vertical,
      brand: r.brand,
      engine: r.engine,
      model: r.model,
      config: r.config,
      esn: r.esn,
      source: r.source,
      sourcePoNo: r.sourcePoNo,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    }));

  const report = {
    generatedAt: new Date().toISOString(),
    total: rows.length,
    verticalCounts,
    brandCounts,
    engineFieldCounts,
    brandFieldCounts,
    modelCounts,
    configCounts,
    suspiciousVerticalCount: suspiciousVertical.length,
    suspiciousBrandCount: suspiciousBrand.length,
    deterministicSwapCount: swaps.length,
    overlapFolded: overlap,
    brandCaseDuplicates: brandCaseDupes,
    verticalCaseDuplicates: verticalCaseDupes,
    suspiciousVerticalSamples: sample(suspiciousVertical),
    suspiciousBrandSamples: sample(suspiciousBrand),
    swapSamples: sample(swaps),
  };

  const outDir = path.join(__dirname, "repair-evidence");
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `item-master-taxonomy-audit-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`\nWrote ${outPath}`);

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
