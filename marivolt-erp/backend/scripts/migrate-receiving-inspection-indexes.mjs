/**
 * Phase 3A — create/verify receiving inspection Mongo indexes.
 *
 * Default: dry-run / verify. Execute: --execute
 * Verify-only (no create): default, or --verify
 *
 * Does not drop unrelated indexes. Does not rename Phase 2 barcode indexes.
 *
 *   npm run migrate:receiving-inspection-indexes
 *   npm run migrate:receiving-inspection-indexes -- --execute
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import mongoose from "mongoose";
import dotenv from "dotenv";
import {
  RECEIVING_INSPECTION_INDEX_SPECS,
  RECEIVING_UNIT_BARCODE_INDEX_SPEC,
  evaluateIndexInventory,
  ensureReceivingInspectionIndexes,
  findMatchingIndex,
  indexSatisfiesSpec,
} from "../src/utils/receivingInspectionIndexes.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "../.env") });
if (!process.env.MONGO_URI) dotenv.config({ path: path.join(__dirname, "../../.env") });

const EXECUTE = process.argv.includes("--execute");

async function collectionIndexes(db, name) {
  try {
    return await db.collection(name).indexes();
  } catch (err) {
    if (err?.codeName === "NamespaceNotFound" || Number(err?.code) === 26) return [];
    throw err;
  }
}

async function collectionExists(db, name) {
  const rows = await db.listCollections({ name }, { nameOnly: true }).toArray();
  return rows.length > 0;
}

async function main() {
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI missing");
  console.log("=== Phase 3A receiving inspection indexes ===");
  console.log("Mode:", EXECUTE ? "EXECUTE" : "DRY RUN / VERIFY");
  console.log("MongoDB $in partial filters require MongoDB 6+ (this env is expected Atlas 8.x)");

  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 20000 });
  const db = mongoose.connection.db;
  const buildInfo = await db.admin().command({ buildInfo: 1 }).catch(() => ({ version: "unknown" }));
  console.log("Server version:", buildInfo.version);

  const collections = [
    ...new Set(
      [...RECEIVING_INSPECTION_INDEX_SPECS, RECEIVING_UNIT_BARCODE_INDEX_SPEC].map((s) => s.collection)
    ),
  ];
  const indexesByCollection = {};
  const existence = {};
  for (const name of collections) {
    existence[name] = await collectionExists(db, name);
    indexesByCollection[name] = await collectionIndexes(db, name);
  }

  const inventory = evaluateIndexInventory(indexesByCollection);
  const evidenceDir = path.join(__dirname, "repair-evidence");
  fs.mkdirSync(evidenceDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const evidence = {
    capturedAt: new Date().toISOString(),
    mode: EXECUTE ? "EXECUTE" : "DRY_RUN",
    serverVersion: buildInfo.version,
    collections: existence,
    inventory,
    existingIndexes: Object.fromEntries(
      Object.entries(indexesByCollection).map(([name, rows]) => [
        name,
        rows.map((i) => ({
          name: i.name,
          key: i.key,
          unique: !!i.unique,
          partialFilterExpression: i.partialFilterExpression || null,
        })),
      ])
    ),
  };
  const evidencePath = path.join(evidenceDir, `receiving-inspection-indexes-${stamp}.json`);
  fs.writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
  console.log("Evidence:", evidencePath);
  console.log(JSON.stringify({ collections: existence, missing: inventory.missing }, null, 2));

  if (!EXECUTE) {
    if (!inventory.ok) {
      console.error("VERIFY FAILED — required unique indexes are missing or mismatched:");
      for (const row of inventory.missing) {
        console.error(`  ${row.collection}.${row.name} unique=${row.unique} present=${row.present} mismatch=${row.mismatch}`);
      }
      console.error("Create them with: npm run migrate:receiving-inspection-indexes -- --execute");
      await mongoose.disconnect();
      process.exit(2);
    }
    console.log("Verify OK — required Phase 3A unique indexes are present.");
    await mongoose.disconnect();
    return;
  }

  const created = await ensureReceivingInspectionIndexes(db, { create: true });
  console.log("Ensure results:", JSON.stringify(created, null, 2));

  const after = {};
  for (const name of collections) after[name] = await collectionIndexes(db, name);
  const afterInventory = evaluateIndexInventory(after);
  const verifyPath = path.join(evidenceDir, `receiving-inspection-indexes-post-${stamp}.json`);
  fs.writeFileSync(verifyPath, JSON.stringify({ verifiedAt: new Date().toISOString(), created, afterInventory }, null, 2));
  console.log("Post-verify:", verifyPath);

  if (!afterInventory.ok) {
    console.error("ABORT: required indexes still missing after execute");
    await mongoose.disconnect();
    process.exit(3);
  }

  for (const spec of RECEIVING_INSPECTION_INDEX_SPECS) {
    const found = findMatchingIndex(after[spec.collection], spec);
    if (!indexSatisfiesSpec(found, spec)) throw new Error(`Missing index after create: ${spec.name}`);
  }
  console.log("OK — indexes present; re-run is safe (exists → skip).");
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error("FATAL:", err.message || err);
  try {
    await mongoose.disconnect();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
