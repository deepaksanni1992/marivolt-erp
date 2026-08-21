/**
 * READ-ONLY: CustomsBoe legal-identity audit.
 * Does NOT mutate data. Does NOT create/drop indexes.
 * Never repairs BOE-AUDIT-001. Never mutates CustomsLot.
 *
 * Run: node scripts/customsBoeIdentityAudit.readonly.mjs
 *
 * Collision rule matches the proposed unique index:
 *   companyId + normalizedBoeNumber (CANCELLED included — number never freed)
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import mongoose from "mongoose";
import dotenv from "dotenv";
import { normalizeBoeNumber } from "../src/utils/asnCustomsFieldOwnership.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "../.env") });
if (!process.env.MONGO_URI && !process.env.MONGODB_URI) {
  dotenv.config({ path: path.join(__dirname, "../../.env") });
}

async function main() {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) {
    console.error("No MONGODB_URI/MONGO_URI — cannot audit");
    process.exit(2);
  }
  await mongoose.connect(uri, { readPreference: "secondaryPreferred" }).catch(async () => {
    await mongoose.connect(uri);
  });
  const db = mongoose.connection.db;
  const buildInfo = await db.admin().command({ buildInfo: 1 }).catch(() => ({ version: "unknown" }));

  const companies = await db.collection("companies").find({}, { projection: { code: 1, name: 1 } }).toArray();
  console.log("=== CustomsBoe identity audit (READ-ONLY) ===");
  console.log("Server version:", buildInfo.version);
  console.log("CANCELLED parents ARE included in identity collisions.\n");

  const allBoes = await db
    .collection("customsboes")
    .find({}, { projection: { companyId: 1, boeNumber: 1, normalizedBoeNumber: 1, customsBoeRef: 1, status: 1 } })
    .toArray();

  const total = allBoes.length;
  let missingNormalized = 0;
  let emptyNormalized = 0;
  const byCompanyNorm = new Map();
  const crossCompany = new Map();
  const needingBackfill = [];

  for (const b of allBoes) {
    const hasField = Object.prototype.hasOwnProperty.call(b, "normalizedBoeNumber");
    const current = String(b.normalizedBoeNumber ?? "").trim();
    if (!hasField || b.normalizedBoeNumber == null) missingNormalized += 1;
    else if (!current) emptyNormalized += 1;

    const expected = normalizeBoeNumber(b.boeNumber);
    if (!current || current !== expected) {
      needingBackfill.push({
        _id: String(b._id),
        customsBoeRef: b.customsBoeRef || "",
        boeNumber: b.boeNumber || "",
        currentNormalized: current,
        expectedNormalized: expected,
        status: b.status || "",
      });
    }
    if (!expected) continue;
    const companyKey = String(b.companyId);
    const mapKey = `${companyKey}::${expected}`;
    const list = byCompanyNorm.get(mapKey) || [];
    list.push(b);
    byCompanyNorm.set(mapKey, list);

    const cross = crossCompany.get(expected) || new Set();
    cross.add(companyKey);
    crossCompany.set(expected, cross);
  }

  const collisions = [];
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

  const crossCompanySameNumber = [...crossCompany.entries()]
    .filter(([, companiesSet]) => companiesSet.size > 1)
    .map(([normalizedBoeNumber, companiesSet]) => ({
      normalizedBoeNumber,
      companies: [...companiesSet],
      note: "ALLOWED — unique index is company-scoped",
    }));

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

  const byCompany = [];
  for (const c of companies) {
    const code = String(c.code || "").toUpperCase();
    const companyId = String(c._id);
    const boeCount = allBoes.filter((b) => String(b.companyId) === companyId).length;
    byCompany.push({ code, companyId, customsBoeParents: boeCount });
    console.log(`Company ${code}: CustomsBoe parents = ${boeCount}`);
  }

  console.log("\n--- CustomsBoe collection ---");
  console.log(`total docs: ${total}`);
  console.log(`missing normalizedBoeNumber: ${missingNormalized}`);
  console.log(`empty normalizedBoeNumber: ${emptyNormalized}`);
  console.log(`needing backfill: ${needingBackfill.length}`);
  console.log(`same-company normalized collisions (incl. CANCELLED): ${collisions.length}`);
  console.log(`cross-company same-number (allowed): ${crossCompanySameNumber.length}`);
  console.log(`legacy CustomsLot boeNumber duplicate groups: ${legacyLotBoeDuplicates.length}`);
  console.log(`safe to create unique index: ${collisions.length === 0}`);

  if (collisions.length) {
    console.log("\nCOLLISIONS:");
    for (const c of collisions) {
      console.log(`  company=${c.companyId} normalized=${c.normalizedBoeNumber} count=${c.count}`);
      for (const r of c.refs) console.log(`    ${r.customsBoeRef} status=${r.status} id=${r._id}`);
    }
  }

  const evidenceDir = path.join(__dirname, "repair-evidence");
  fs.mkdirSync(evidenceDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const evidencePath = path.join(evidenceDir, `customs-boe-identity-audit-readonly-${stamp}.json`);
  const evidence = {
    capturedAt: new Date().toISOString(),
    mode: "READ_ONLY",
    serverVersion: buildInfo.version,
    byCompany,
    total,
    missingNormalized,
    emptyNormalized,
    needingBackfillCount: needingBackfill.length,
    needingBackfill: needingBackfill.slice(0, 50),
    collisions,
    crossCompanySameNumber,
    legacyLotBoeDuplicates: legacyLotBoeDuplicates.map((r) => ({
      companyId: String(r._id.companyId),
      boeNumber: r._id.boe,
      lotCount: r.n,
      withParent: r.withParent,
      note: "NOT a CustomsBoe index collision",
    })),
    safeToCreateUniqueIndex: collisions.length === 0,
    proposedIndex: {
      name: "customsBoe_company_normalizedBoeNumber_unique",
      key: { companyId: 1, normalizedBoeNumber: 1 },
      unique: true,
      partialFilterExpression: { normalizedBoeNumber: { $type: "string", $gt: "" } },
      statusFilter: "NONE — CANCELLED included",
    },
  };
  fs.writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
  console.log("\nEvidence:", evidencePath);

  await mongoose.disconnect();
  process.exit(collisions.length ? 2 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
