/**
 * CustomsBoe legal identity — migration / verify.
 *
 * Default: DRY RUN (audit + index verify only). Never touches CustomsLot.
 * Never repairs BOE-AUDIT-001.
 *
 *   npm run migrate:customs-boe-identity-indexes
 *   npm run migrate:customs-boe-identity-indexes -- --execute
 *
 * --execute (only when safe):
 *   1. backfill normalizedBoeNumber on CustomsBoe parents
 *   2. create unique { companyId, normalizedBoeNumber } if no collisions
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import mongoose from "mongoose";
import dotenv from "dotenv";
import { normalizeBoeNumber } from "../src/utils/asnCustomsFieldOwnership.js";
import {
  CUSTOMS_BOE_COLLECTION,
  CUSTOMS_BOE_IDENTITY_INDEX_SPECS,
  evaluateCustomsBoeIdentityIndexInventory,
  ensureCustomsBoeIdentityIndexes,
} from "../src/utils/customsBoeIdentityIndexes.js";

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

async function auditCustomsBoeIdentity(db) {
  const coll = db.collection(CUSTOMS_BOE_COLLECTION);
  const total = await coll.countDocuments({});
  const missingNorm = await coll.countDocuments({
    $or: [{ normalizedBoeNumber: { $exists: false } }, { normalizedBoeNumber: null }, { normalizedBoeNumber: "" }],
  });
  const docs = await coll
    .find({}, { projection: { companyId: 1, boeNumber: 1, normalizedBoeNumber: 1, customsBoeRef: 1, status: 1 } })
    .toArray();

  const byCompanyNorm = new Map();
  const needingBackfill = [];
  const collisions = [];
  const crossCompanySameNumber = new Map();

  for (const doc of docs) {
    // Expected always from legal boeNumber — never trust a stale normalized value.
    const expected = normalizeBoeNumber(doc.boeNumber);
    const current = String(doc.normalizedBoeNumber || "").trim();
    if (!current || current !== expected) {
      needingBackfill.push({
        _id: String(doc._id),
        customsBoeRef: doc.customsBoeRef || "",
        boeNumber: doc.boeNumber || "",
        currentNormalized: current,
        expectedNormalized: expected,
        status: doc.status || "",
      });
    }
    if (!expected) continue;
    const companyKey = String(doc.companyId);
    const mapKey = `${companyKey}::${expected}`;
    const list = byCompanyNorm.get(mapKey) || [];
    list.push(doc);
    byCompanyNorm.set(mapKey, list);

    const cross = crossCompanySameNumber.get(expected) || new Set();
    cross.add(companyKey);
    crossCompanySameNumber.set(expected, cross);
  }

  for (const [mapKey, rows] of byCompanyNorm.entries()) {
    if (rows.length < 2) continue;
    const [, normalizedBoeNumber] = mapKey.split("::");
    collisions.push({
      companyId: String(rows[0].companyId),
      normalizedBoeNumber,
      count: rows.length,
      refs: rows.map((r) => ({
        _id: String(r._id),
        customsBoeRef: r.customsBoeRef || "",
        boeNumber: r.boeNumber || "",
        status: r.status || "",
      })),
    });
  }

  const crossCompany = [...crossCompanySameNumber.entries()]
    .filter(([, companies]) => companies.size > 1)
    .map(([normalizedBoeNumber, companies]) => ({
      normalizedBoeNumber,
      companies: [...companies],
      note: "ALLOWED — unique index is company-scoped",
    }));

  // Separate: lot-level boeNumber dups (not CustomsBoe collisions)
  let legacyLotBoeDuplicates = [];
  try {
    legacyLotBoeDuplicates = await db
      .collection("customslots")
      .aggregate([
        { $match: { boeNumber: { $nin: [null, ""] } } },
        {
          $group: {
            _id: {
              companyId: "$companyId",
              boe: { $toUpper: { $trim: { input: "$boeNumber" } } },
            },
            n: { $sum: 1 },
            withParent: { $sum: { $cond: [{ $ifNull: ["$customsBoeId", false] }, 1, 0] } },
          },
        },
        { $match: { n: { $gt: 1 } } },
        { $sort: { n: -1 } },
        { $limit: 20 },
      ])
      .toArray();
  } catch {
    legacyLotBoeDuplicates = [];
  }

  return {
    total,
    missingOrEmptyNormalized: missingNorm,
    needingBackfillCount: needingBackfill.length,
    needingBackfill: needingBackfill.slice(0, 50),
    collisions,
    crossCompanySameNumber: crossCompany,
    legacyLotBoeDuplicates: legacyLotBoeDuplicates.map((r) => ({
      companyId: String(r._id.companyId),
      boeNumber: r._id.boe,
      lotCount: r.n,
      withParent: r.withParent,
      note: "NOT a CustomsBoe index collision",
    })),
    safeToCreateUniqueIndex: collisions.length === 0,
  };
}

async function backfillNormalizedBoeNumber(db) {
  const coll = db.collection(CUSTOMS_BOE_COLLECTION);
  const docs = await coll.find({}).toArray();
  let updated = 0;
  let skipped = 0;
  for (const doc of docs) {
    const expected = normalizeBoeNumber(doc.boeNumber);
    if (!expected) {
      skipped += 1;
      continue;
    }
    if (String(doc.normalizedBoeNumber || "") === expected) {
      skipped += 1;
      continue;
    }
    await coll.updateOne({ _id: doc._id }, { $set: { normalizedBoeNumber: expected } });
    updated += 1;
  }
  return { updated, skipped, scanned: docs.length };
}

async function main() {
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI missing");
  console.log("=== CustomsBoe legal identity indexes ===");
  console.log("Mode:", EXECUTE ? "EXECUTE" : "DRY RUN / VERIFY");
  console.log("Unique identity includes CANCELLED parents (number never freed).");
  console.log("Partial filter: normalizedBoeNumber { $type: 'string', $gt: '' } (MongoDB 6+ / Atlas)");

  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 20000 });
  const db = mongoose.connection.db;
  const buildInfo = await db.admin().command({ buildInfo: 1 }).catch(() => ({ version: "unknown" }));
  console.log("Server version:", buildInfo.version);

  const exists = await collectionExists(db, CUSTOMS_BOE_COLLECTION);
  const indexes = exists ? await collectionIndexes(db, CUSTOMS_BOE_COLLECTION) : [];
  const inventory = evaluateCustomsBoeIdentityIndexInventory({ [CUSTOMS_BOE_COLLECTION]: indexes });
  const audit = exists
    ? await auditCustomsBoeIdentity(db)
    : {
        total: 0,
        missingOrEmptyNormalized: 0,
        needingBackfillCount: 0,
        needingBackfill: [],
        collisions: [],
        crossCompanySameNumber: [],
        legacyLotBoeDuplicates: [],
        safeToCreateUniqueIndex: true,
      };

  const evidenceDir = path.join(__dirname, "repair-evidence");
  fs.mkdirSync(evidenceDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const evidence = {
    capturedAt: new Date().toISOString(),
    mode: EXECUTE ? "EXECUTE" : "DRY_RUN",
    serverVersion: buildInfo.version,
    indexSpecs: CUSTOMS_BOE_IDENTITY_INDEX_SPECS,
    inventory,
    audit,
    existingIndexes: indexes.map((i) => ({
      name: i.name,
      key: i.key,
      unique: !!i.unique,
      partialFilterExpression: i.partialFilterExpression || null,
    })),
  };
  const evidencePath = path.join(evidenceDir, `customs-boe-identity-${stamp}.json`);
  fs.writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
  console.log("Evidence:", evidencePath);
  console.log(
    JSON.stringify(
      {
        totalBoe: audit.total,
        missingNorm: audit.missingOrEmptyNormalized,
        collisions: audit.collisions.length,
        safeToCreateUniqueIndex: audit.safeToCreateUniqueIndex,
        indexOk: inventory.ok,
      },
      null,
      2,
    ),
  );

  if (audit.collisions.length) {
    console.error("COLLISIONS — unique index must NOT be created until resolved:");
    for (const c of audit.collisions) {
      console.error(`  company=${c.companyId} normalized=${c.normalizedBoeNumber} count=${c.count}`);
      for (const r of c.refs) console.error(`    ${r.customsBoeRef} status=${r.status} id=${r._id}`);
    }
  }

  if (!EXECUTE) {
    if (!audit.safeToCreateUniqueIndex) {
      console.error("VERIFY FAILED — collisions block migration.");
      await mongoose.disconnect();
      process.exit(2);
    }
    if (!inventory.ok) {
      console.error("VERIFY — unique index not present yet (expected before --execute).");
      console.error("When ready: npm run migrate:customs-boe-identity-indexes -- --execute");
      await mongoose.disconnect();
      // Dry-run with no collisions and missing index is informative exit 0 (not yet deployed).
      process.exit(0);
    }
    console.log("Verify OK — unique identity index present; no CustomsBoe collisions.");
    await mongoose.disconnect();
    return;
  }

  if (!audit.safeToCreateUniqueIndex) {
    console.error("EXECUTE REFUSED — resolve CustomsBoe collisions first.");
    await mongoose.disconnect();
    process.exit(2);
  }

  const backfill = await backfillNormalizedBoeNumber(db);
  console.log("Backfill:", backfill);

  const postAudit = await auditCustomsBoeIdentity(db);
  if (!postAudit.safeToCreateUniqueIndex) {
    console.error("EXECUTE REFUSED after backfill — collisions detected.");
    await mongoose.disconnect();
    process.exit(2);
  }

  const created = await ensureCustomsBoeIdentityIndexes(db, { create: true });
  console.log("Ensure results:", JSON.stringify(created, null, 2));

  const afterIndexes = await collectionIndexes(db, CUSTOMS_BOE_COLLECTION);
  const afterInventory = evaluateCustomsBoeIdentityIndexInventory({
    [CUSTOMS_BOE_COLLECTION]: afterIndexes,
  });
  const verifyPath = path.join(evidenceDir, `customs-boe-identity-post-${stamp}.json`);
  fs.writeFileSync(
    verifyPath,
    JSON.stringify({ verifiedAt: new Date().toISOString(), backfill, created, afterInventory, postAudit }, null, 2),
  );
  console.log("Post-verify:", verifyPath);

  if (!afterInventory.ok) {
    console.error("POST-VERIFY FAILED");
    await mongoose.disconnect();
    process.exit(2);
  }
  console.log("Execute + verify OK. CustomsLot untouched. BOE-AUDIT-001 untouched.");
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
