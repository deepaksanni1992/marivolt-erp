/**
 * P0.3 — Create company-scoped partial unique indexes for active Order Allocations.
 *
 * Default: dry-run. Execute: node scripts/migrate-active-allocation-unique-indexes.mjs --execute
 *
 * Indexes:
 *   uniq_active_allocation_per_oa        { companyId: 1, linkedOAId: 1 }
 *   uniq_active_allocation_per_proforma  { companyId: 1, linkedProformaId: 1 }
 *
 * Partial filter (MongoDB 6+ / 8 Atlas): link is ObjectId AND status in active list.
 * Cancelled allocations are excluded so reallocation after cancel remains possible.
 *
 * Aborts if active duplicates exist. Does not drop unrelated indexes.
 * Rollback: db.orderallocations.dropIndex("uniq_active_allocation_per_oa")
 *           db.orderallocations.dropIndex("uniq_active_allocation_per_proforma")
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import mongoose from "mongoose";
import dotenv from "dotenv";
import {
  ACTIVE_ALLOCATION_INDEX_SPECS,
  ACTIVE_ALLOCATION_STATUSES,
} from "../src/utils/allocationUniqueness.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "../.env") });
if (!process.env.MONGO_URI) dotenv.config({ path: path.join(__dirname, "../../.env") });

const EXECUTE = process.argv.includes("--execute");

async function duplicateGroups(coll, linkField) {
  return coll
    .aggregate([
      {
        $match: {
          status: { $in: [...ACTIVE_ALLOCATION_STATUSES] },
          [linkField]: { $type: "objectId" },
        },
      },
      {
        $group: {
          _id: { companyId: "$companyId", link: `$${linkField}` },
          n: { $sum: 1 },
          ids: { $push: "$_id" },
        },
      },
      { $match: { n: { $gt: 1 } } },
    ])
    .toArray();
}

async function main() {
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI missing");
  console.log("=== P0.3 active allocation unique indexes ===");
  console.log("Mode:", EXECUTE ? "EXECUTE" : "DRY RUN");
  console.log("MongoDB $in partial filters require MongoDB 6+ (this env is expected Atlas 8.x)");

  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 20000 });
  const db = mongoose.connection.db;
  const coll = db.collection("orderallocations");
  const buildInfo = await db.admin().command({ buildInfo: 1 });
  console.log("Server version:", buildInfo.version);

  const dupOA = await duplicateGroups(coll, "linkedOAId");
  const dupPI = await duplicateGroups(coll, "linkedProformaId");
  const existing = await coll.indexes();

  const evidenceDir = path.join(__dirname, "repair-evidence");
  fs.mkdirSync(evidenceDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const evidence = {
    capturedAt: new Date().toISOString(),
    mode: EXECUTE ? "EXECUTE" : "DRY_RUN",
    serverVersion: buildInfo.version,
    activeStatuses: [...ACTIVE_ALLOCATION_STATUSES],
    indexSpecs: ACTIVE_ALLOCATION_INDEX_SPECS,
    preIndexDuplicates: {
      linkedOAIdGroups: dupOA.length,
      linkedProformaIdGroups: dupPI.length,
      oaSamples: dupOA.slice(0, 5).map((g) => ({
        companyId: String(g._id.companyId),
        linkedOAId: String(g._id.link),
        n: g.n,
        ids: g.ids.map(String),
      })),
      piSamples: dupPI.slice(0, 5).map((g) => ({
        companyId: String(g._id.companyId),
        linkedProformaId: String(g._id.link),
        n: g.n,
        ids: g.ids.map(String),
      })),
    },
    existingIndexes: existing.map((i) => ({
      name: i.name,
      key: i.key,
      unique: !!i.unique,
      partialFilterExpression: i.partialFilterExpression || null,
    })),
  };
  const evidencePath = path.join(evidenceDir, `p03-allocation-indexes-${stamp}.json`);
  fs.writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
  console.log("Evidence:", evidencePath);
  console.log(JSON.stringify({ preIndexDuplicates: evidence.preIndexDuplicates, proposedIndexes: ACTIVE_ALLOCATION_INDEX_SPECS }, null, 2));

  if (dupOA.length || dupPI.length) {
    console.error("ABORT: active duplicate allocations exist — resolve before creating unique indexes");
    await mongoose.disconnect();
    process.exit(2);
  }

  if (!EXECUTE) {
    console.log("Dry run complete — no indexes created.");
    await mongoose.disconnect();
    return;
  }

  const results = [];
  for (const spec of ACTIVE_ALLOCATION_INDEX_SPECS) {
    const already = existing.find((i) => i.name === spec.name);
    if (already) {
      console.log(`Index already exists: ${spec.name} — skipping create`);
      results.push({ name: spec.name, action: "exists" });
      continue;
    }
    await coll.createIndex(spec.key, {
      name: spec.name,
      unique: true,
      partialFilterExpression: spec.partialFilterExpression,
    });
    console.log(`Created index: ${spec.name}`);
    results.push({ name: spec.name, action: "created" });
  }

  const afterIndexes = await coll.indexes();
  const afterDupOA = await duplicateGroups(coll, "linkedOAId");
  const afterDupPI = await duplicateGroups(coll, "linkedProformaId");
  const verify = {
    verifiedAt: new Date().toISOString(),
    results,
    afterDuplicates: { linkedOAIdGroups: afterDupOA.length, linkedProformaIdGroups: afterDupPI.length },
    indexes: afterIndexes
      .filter((i) => String(i.name).startsWith("uniq_active_allocation"))
      .map((i) => ({
        name: i.name,
        key: i.key,
        unique: !!i.unique,
        partialFilterExpression: i.partialFilterExpression || null,
      })),
  };
  const verifyPath = path.join(evidenceDir, `p03-allocation-indexes-post-${stamp}.json`);
  fs.writeFileSync(verifyPath, JSON.stringify(verify, null, 2));
  console.log("Post-verify:", JSON.stringify(verify, null, 2));

  if (verify.indexes.length < 2) {
    console.error("ABORT: expected both unique indexes present after execute");
    await mongoose.disconnect();
    process.exit(3);
  }

  // Re-run safety: execute again should skip.
  console.log("Re-run check (idempotent)...");
  for (const spec of ACTIVE_ALLOCATION_INDEX_SPECS) {
    const names = (await coll.indexes()).map((i) => i.name);
    if (!names.includes(spec.name)) throw new Error(`Missing index after create: ${spec.name}`);
  }
  console.log("OK — indexes present; re-run is safe (exists → skip).");
  console.log("Rollback: db.orderallocations.dropIndex(\"uniq_active_allocation_per_oa\")");
  console.log("         db.orderallocations.dropIndex(\"uniq_active_allocation_per_proforma\")");
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
