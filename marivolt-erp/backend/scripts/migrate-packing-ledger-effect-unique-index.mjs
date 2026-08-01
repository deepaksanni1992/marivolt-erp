/**
 * P0.5A — Unique index on StockLedger.effectKey for Packing stock effects.
 *
 * Default: dry-run. Execute:
 *   node scripts/migrate-packing-ledger-effect-unique-index.mjs --execute
 *
 * Partial unique index excludes empty/missing effectKey so legacy ledger rows
 * without source identity never collide.
 *
 * Rollback:
 *   db.stockledgers.dropIndex("uniq_stockledger_packing_effect_key")
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import mongoose from "mongoose";
import dotenv from "dotenv";
import { PACKING_EFFECT_INDEX_SPEC } from "../src/utils/packingIdempotency.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "../.env") });
if (!process.env.MONGO_URI) dotenv.config({ path: path.join(__dirname, "../../.env") });

const EXECUTE = process.argv.includes("--execute");

async function main() {
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI missing");
  console.log("=== P0.5A packing ledger effect unique index ===");
  console.log("Mode:", EXECUTE ? "EXECUTE" : "DRY RUN");

  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 20000 });
  const db = mongoose.connection.db;
  const coll = db.collection("stockledgers");
  const version = (await db.admin().command({ buildInfo: 1 })).version;

  const withKey = await coll.countDocuments({ effectKey: { $type: "string", $gt: "" } });
  const dupGroups = await coll
    .aggregate([
      { $match: { effectKey: { $type: "string", $gt: "" } } },
      { $group: { _id: "$effectKey", n: { $sum: 1 }, ids: { $push: "$_id" } } },
      { $match: { n: { $gt: 1 } } },
      { $limit: 20 },
    ])
    .toArray();
  const packed = await coll.countDocuments({
    $or: [{ movementType: "PACKED" }, { transactionType: "PACKED" }],
  });
  const packedWithSource = await coll.countDocuments({
    movementType: "PACKED",
    sourceDocumentType: "STORE_PACKING",
    sourceDocumentId: { $type: "objectId" },
  });
  const existing = await coll.indexes();

  const evidenceDir = path.join(__dirname, "repair-evidence");
  fs.mkdirSync(evidenceDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const evidence = {
    capturedAt: new Date().toISOString(),
    mode: EXECUTE ? "EXECUTE" : "DRY_RUN",
    serverVersion: version,
    indexSpec: PACKING_EFFECT_INDEX_SPEC,
    counts: { withEffectKey: withKey, packed, packedWithSource, duplicateEffectKeyGroups: dupGroups.length },
    duplicateSamples: dupGroups.map((g) => ({
      effectKey: String(g._id).slice(0, 80),
      n: g.n,
      ids: g.ids.slice(0, 5).map(String),
    })),
    existingIndexes: existing.map((i) => ({
      name: i.name,
      key: i.key,
      unique: !!i.unique,
      partialFilterExpression: i.partialFilterExpression || null,
    })),
  };
  const evidencePath = path.join(evidenceDir, `p05a-packing-effect-index-${stamp}.json`);
  fs.writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
  console.log("Evidence:", evidencePath);
  console.log(JSON.stringify({ counts: evidence.counts, indexSpec: PACKING_EFFECT_INDEX_SPEC }, null, 2));

  if (dupGroups.length) {
    console.error("ABORT: duplicate effectKey values exist — resolve before creating unique index");
    await mongoose.disconnect();
    process.exit(2);
  }

  if (!EXECUTE) {
    console.log("Dry run complete — no index created.");
    await mongoose.disconnect();
    return;
  }

  const already = existing.find((i) => i.name === PACKING_EFFECT_INDEX_SPEC.name);
  if (already) {
    console.log("Index already exists — skip create");
  } else {
    await coll.createIndex(PACKING_EFFECT_INDEX_SPEC.key, {
      name: PACKING_EFFECT_INDEX_SPEC.name,
      unique: true,
      partialFilterExpression: PACKING_EFFECT_INDEX_SPEC.partialFilterExpression,
    });
    console.log("Created index:", PACKING_EFFECT_INDEX_SPEC.name);
  }

  const after = await coll.indexes();
  const found = after.find((i) => i.name === PACKING_EFFECT_INDEX_SPEC.name);
  if (!found?.unique) {
    console.error("ABORT: index missing or not unique after execute");
    await mongoose.disconnect();
    process.exit(3);
  }
  const postPath = path.join(evidenceDir, `p05a-packing-effect-index-post-${stamp}.json`);
  fs.writeFileSync(
    postPath,
    JSON.stringify(
      {
        verifiedAt: new Date().toISOString(),
        index: {
          name: found.name,
          key: found.key,
          unique: !!found.unique,
          partialFilterExpression: found.partialFilterExpression || null,
        },
      },
      null,
      2
    )
  );
  console.log("Verified:", found.name);
  console.log("Rollback: db.stockledgers.dropIndex(\"uniq_stockledger_packing_effect_key\")");
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
