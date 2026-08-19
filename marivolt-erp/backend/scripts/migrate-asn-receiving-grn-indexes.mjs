/**
 * Phase 4B — unique GRN index: one active ASN receiving Draft GRN per session.
 *
 * Default: dry-run / verify. Execute: --execute
 *
 *   npm run migrate:asn-receiving-grn-indexes
 *   npm run migrate:asn-receiving-grn-indexes -- --execute
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import mongoose from "mongoose";
import dotenv from "dotenv";
import {
  ASN_RECEIVING_GRN_INDEX_SPECS,
  evaluateAsnReceivingGrnIndexInventory,
  ensureAsnReceivingGrnIndexes,
} from "../src/utils/receivingDraftGrnIndexes.js";

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
  console.log("=== Phase 4B ASN receiving GRN indexes ===");
  console.log("Mode:", EXECUTE ? "EXECUTE" : "DRY RUN / VERIFY");

  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 20000 });
  const db = mongoose.connection.db;
  const buildInfo = await db.admin().command({ buildInfo: 1 }).catch(() => ({ version: "unknown" }));
  console.log("Server version:", buildInfo.version);

  const collections = [...new Set(ASN_RECEIVING_GRN_INDEX_SPECS.map((s) => s.collection))];
  const indexesByCollection = {};
  const existence = {};
  for (const name of collections) {
    existence[name] = await collectionExists(db, name);
    indexesByCollection[name] = await collectionIndexes(db, name);
  }

  const inventory = evaluateAsnReceivingGrnIndexInventory(indexesByCollection);
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
  const evidencePath = path.join(evidenceDir, `asn-receiving-grn-indexes-${stamp}.json`);
  fs.writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
  console.log("Evidence:", evidencePath);
  console.log(JSON.stringify({ collections: existence, missing: inventory.missing }, null, 2));

  if (!EXECUTE) {
    if (!inventory.ok) {
      console.error("VERIFY FAILED — required unique indexes are missing or mismatched:");
      for (const row of inventory.missing) {
        console.error(`  ${row.collection}.${row.name} unique=${row.unique} present=${row.present} mismatch=${row.mismatch}`);
      }
      console.error("Create them with: npm run migrate:asn-receiving-grn-indexes -- --execute");
      await mongoose.disconnect();
      process.exit(2);
    }
    console.log("Verify OK — required Phase 4B unique indexes are present.");
    await mongoose.disconnect();
    return;
  }

  const created = await ensureAsnReceivingGrnIndexes(db, { create: true });
  console.log("Ensure results:", JSON.stringify(created, null, 2));

  const after = {};
  for (const name of collections) after[name] = await collectionIndexes(db, name);
  const afterInventory = evaluateAsnReceivingGrnIndexInventory(after);
  const verifyPath = path.join(evidenceDir, `asn-receiving-grn-indexes-post-${stamp}.json`);
  fs.writeFileSync(verifyPath, JSON.stringify({ verifiedAt: new Date().toISOString(), created, afterInventory }, null, 2));
  console.log("Post-verify:", verifyPath);

  if (!afterInventory.ok) {
    console.error("POST-VERIFY FAILED");
    await mongoose.disconnect();
    process.exit(2);
  }
  console.log("Execute + verify OK.");
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
