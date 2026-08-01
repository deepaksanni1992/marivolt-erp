/**
 * P0.5B — Verify StockLedger effectKey uniqueness covers Dispatch effects.
 *
 * P0.5A already created a partial unique index on non-empty effectKey
 * (`uniq_stockledger_packing_effect_key`). That index is generic despite the
 * packing-oriented name — Dispatch effectKeys are protected by the same index.
 *
 * Default: dry-run (audit + ensure index exists).
 * Execute:
 *   node scripts/migrate-dispatch-ledger-effect-unique-index.mjs --execute
 *
 * --execute only creates the index if it is missing (idempotent / safe re-run).
 * It does not drop or rename the existing index.
 *
 * Rollback (only if you intentionally remove the shared index — also removes Packing protection):
 *   db.stockledgers.dropIndex("uniq_stockledger_packing_effect_key")
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import mongoose from "mongoose";
import dotenv from "dotenv";
import { DISPATCH_EFFECT_INDEX_SPEC } from "../src/utils/dispatchIdempotency.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "../.env") });
if (!process.env.MONGO_URI) dotenv.config({ path: path.join(__dirname, "../../.env") });

const EXECUTE = process.argv.includes("--execute");

async function main() {
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI missing");
  console.log("=== P0.5B dispatch ledger effect unique index (reuse P0.5A) ===");
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
  const dispatchOut = await coll.countDocuments({
    $or: [{ movementType: "DISPATCH_OUT" }, { transactionType: "DISPATCH_OUT" }],
  });
  const dispatchOutWithSource = await coll.countDocuments({
    movementType: "DISPATCH_OUT",
    sourceDocumentType: "STORE_DISPATCH",
    sourceDocumentId: { $type: "objectId" },
  });
  const existing = await coll.indexes();
  const haveIndex = existing.some((i) => i.name === DISPATCH_EFFECT_INDEX_SPEC.name);

  const evidenceDir = path.join(__dirname, "repair-evidence");
  fs.mkdirSync(evidenceDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const evidence = {
    capturedAt: new Date().toISOString(),
    mode: EXECUTE ? "EXECUTE" : "DRY_RUN",
    serverVersion: version,
    decision: "REUSE_EXISTING_EFFECTKEY_INDEX",
    indexSpec: DISPATCH_EFFECT_INDEX_SPEC,
    counts: {
      withEffectKey: withKey,
      dispatchOut,
      dispatchOutWithSource,
      duplicateEffectKeyGroups: dupGroups.length,
      indexPresent: haveIndex,
    },
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
  const evidencePath = path.join(evidenceDir, `p05b-dispatch-effect-index-${stamp}.json`);
  fs.writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
  console.log("Evidence:", evidencePath);
  console.log(JSON.stringify({ counts: evidence.counts, decision: evidence.decision }, null, 2));

  if (dupGroups.length) {
    console.error("ABORT: duplicate effectKey values exist — do not create/rely on unique index");
    process.exitCode = 2;
    await mongoose.disconnect();
    return;
  }

  if (!EXECUTE) {
    console.log("Dry-run complete. Re-run with --execute to ensure index exists.");
    await mongoose.disconnect();
    return;
  }

  if (haveIndex) {
    console.log("Index already present — no change:", DISPATCH_EFFECT_INDEX_SPEC.name);
  } else {
    console.log("Creating missing shared effectKey unique index…");
    await coll.createIndex(DISPATCH_EFFECT_INDEX_SPEC.key, {
      name: DISPATCH_EFFECT_INDEX_SPEC.name,
      unique: true,
      partialFilterExpression: DISPATCH_EFFECT_INDEX_SPEC.partialFilterExpression,
    });
    console.log("Created:", DISPATCH_EFFECT_INDEX_SPEC.name);
  }

  const postIndexes = await coll.indexes();
  const postPath = path.join(evidenceDir, `p05b-dispatch-effect-index-post-${stamp}.json`);
  fs.writeFileSync(
    postPath,
    JSON.stringify(
      {
        capturedAt: new Date().toISOString(),
        indexPresent: postIndexes.some((i) => i.name === DISPATCH_EFFECT_INDEX_SPEC.name),
        indexes: postIndexes
          .filter((i) => i.name.includes("effect") || i.name.includes("packing"))
          .map((i) => ({ name: i.name, key: i.key, unique: !!i.unique })),
      },
      null,
      2
    )
  );
  console.log("Post evidence:", postPath);
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
