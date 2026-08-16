/**
 * Deterministic Item Master Vertical/Brand swap repair.
 * Default is dry-run. Pass --apply to mutate.
 *
 * Never changes Article, SPN, material, drawing, pricing, or inventory.
 * Mutates only vertical, brand, and engine via $set.
 *
 * Run: node scripts/repairItemMasterTaxonomy.mjs
 * Apply: node scripts/repairItemMasterTaxonomy.mjs --apply
 */
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import mongoose from "mongoose";
import ItemMaster from "../src/models/itemMasterModel.js";
import {
  isDeterministicVerticalBrandSwap,
  swappedTaxonomy,
} from "../src/utils/itemMasterTaxonomy.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APPLY = process.argv.includes("--apply");

const TAXONOMY_FIELDS = ["vertical", "brand", "engine"];
const FROZEN_FIELDS = [
  "article",
  "description",
  "itemName",
  "spn",
  "materialCode",
  "drawingNo",
  "model",
  "config",
  "esn",
  "uom",
  "status",
  "partNumber",
  "supplierPartNumber",
  "companyCode",
  "source",
  "sourcePoNo",
];

function snapshot(row) {
  return {
    _id: String(row._id),
    article: row.article,
    description: row.description,
    itemName: row.itemName,
    oldVertical: row.vertical,
    oldBrand: row.brand,
    oldEngine: row.engine,
    model: row.model,
    config: row.config,
    esn: row.esn,
    spn: row.spn,
    materialCode: row.materialCode,
    drawingNo: row.drawingNo,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    source: row.source,
    sourcePoNo: row.sourcePoNo,
    intendedVertical: swappedTaxonomy(row).vertical,
    intendedBrand: swappedTaxonomy(row).brand,
    intendedEngine: swappedTaxonomy(row).engine,
  };
}

function frozenSlice(row) {
  const out = {};
  for (const key of FROZEN_FIELDS) out[key] = row[key] ?? "";
  return out;
}

async function main() {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) {
    console.error("No MONGODB_URI/MONGO_URI");
    process.exit(2);
  }
  await mongoose.connect(uri);

  const rows = await ItemMaster.find({}).lean();
  const targets = rows.filter((r) => isDeterministicVerticalBrandSwap(r));

  const evidence = {
    generatedAt: new Date().toISOString(),
    apply: APPLY,
    candidateCount: targets.length,
    mutatedFields: TAXONOMY_FIELDS,
    frozenFields: FROZEN_FIELDS,
    records: targets.map((r) => {
      const next = swappedTaxonomy(r);
      return {
        ...snapshot(r),
        before: { vertical: r.vertical, brand: r.brand, engine: r.engine, model: r.model, config: r.config },
        after: { vertical: next.vertical, brand: next.brand, engine: next.engine, model: r.model, config: r.config },
        frozenBefore: frozenSlice(r),
      };
    }),
  };

  const outDir = path.join(__dirname, "repair-evidence");
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outPath = path.join(
    outDir,
    `item-master-taxonomy-repair-${APPLY ? "apply" : "dry-run"}-${stamp}.json`
  );
  fs.writeFileSync(outPath, JSON.stringify(evidence, null, 2));
  console.log(`${APPLY ? "APPLY" : "DRY-RUN"} candidates: ${targets.length}`);
  for (const rec of evidence.records) {
    console.log(
      `${rec.article}: ${rec.before.vertical}/${rec.before.engine} → ${rec.after.vertical}/${rec.after.engine}`
    );
  }
  console.log(`Evidence: ${outPath}`);

  if (!APPLY) {
    console.log("No data mutated. Re-run with --apply to write swaps.");
    await mongoose.disconnect();
    return;
  }

  if (targets.length !== 12) {
    console.error(`Refusing to apply: expected 12 deterministic records, found ${targets.length}.`);
    await mongoose.disconnect();
    process.exit(3);
  }

  let updated = 0;
  const postChecks = [];
  for (const row of targets) {
    const next = swappedTaxonomy(row);
    const result = await ItemMaster.updateOne(
      { _id: row._id },
      { $set: { vertical: next.vertical, brand: next.brand, engine: next.engine } }
    );
    if (result.modifiedCount !== 1 && result.matchedCount !== 1) {
      throw new Error(`Failed to update ${row.article} (${row._id})`);
    }
    const after = await ItemMaster.findById(row._id).lean();
    for (const key of FROZEN_FIELDS) {
      const beforeVal = row[key] ?? "";
      const afterVal = after[key] ?? "";
      if (String(beforeVal) !== String(afterVal)) {
        throw new Error(`Frozen field changed on ${row.article}: ${key}`);
      }
    }
    if (after.vertical !== next.vertical || after.brand !== next.brand || after.engine !== next.engine) {
      throw new Error(`Taxonomy not applied as intended on ${row.article}`);
    }
    updated += 1;
    postChecks.push({
      _id: String(row._id),
      article: row.article,
      vertical: after.vertical,
      brand: after.brand,
      engine: after.engine,
    });
  }

  evidence.updated = updated;
  evidence.postChecks = postChecks;
  fs.writeFileSync(outPath, JSON.stringify(evidence, null, 2));
  console.log(`Updated ${updated} Item Master records (taxonomy fields only).`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
