/**
 * READ-ONLY Phase 3B production audit: receiving sessions/units and
 * COMPLETED rows lacking disposition buckets.
 * Does not mutate MongoDB.
 *
 * Run from backend: node scripts/auditReceivingDisposition.readonly.mjs
 */
import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import mongoose from "mongoose";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "../.env") });
if (!process.env.MONGO_URI && !process.env.MONGODB_URI) {
  dotenv.config({ path: path.join(__dirname, "../../.env") });
}

function hasBuckets(unit) {
  return unit.acceptedQty != null || unit.damagedQty != null || unit.rejectedQty != null;
}

async function main() {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) {
    console.error("No MONGO_URI/MONGODB_URI");
    process.exit(2);
  }
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 20000 });
  const db = mongoose.connection.db;
  console.log("=== READ-ONLY receiving disposition audit ===");
  console.log("connected:", mongoose.connection.host, mongoose.connection.name);

  const companies = await db.collection("companies").find({}, { projection: { name: 1, code: 1 } }).toArray();
  const collNames = (await db.listCollections().toArray()).map((c) => c.name);
  const sessionColl = collNames.includes("receivingSessions") ? "receivingSessions" : "receivingsessions";
  const unitColl = collNames.includes("receivingSessionUnits") ? "receivingSessionUnits" : "receivingsessionunits";
  const sessionExists = collNames.includes(sessionColl);
  const unitExists = collNames.includes(unitColl);

  const sessionDocs = sessionExists ? await db.collection(sessionColl).find({}).toArray() : [];
  const unitDocs = unitExists ? await db.collection(unitColl).find({}).toArray() : [];

  const completedUnits = unitDocs.filter((u) => String(u.status || "").toUpperCase() === "COMPLETED");
  const completedWithoutDisposition = completedUnits.filter((u) => !hasBuckets(u));
  const byCondition = {};
  for (const u of completedUnits) {
    const c = String(u.condition || "(blank)").toUpperCase();
    byCondition[c] = (byCondition[c] || 0) + 1;
  }
  const completedWithoutByCondition = {};
  for (const u of completedWithoutDisposition) {
    const c = String(u.condition || "(blank)").toUpperCase();
    completedWithoutByCondition[c] = (completedWithoutByCondition[c] || 0) + 1;
  }

  const companyById = new Map(companies.map((c) => [String(c._id), c]));
  const completedSessions = sessionDocs.filter((s) => String(s.status || "").toUpperCase() === "COMPLETED");
  const completedSessionsWithMissingDisposition = [];
  for (const session of completedSessions) {
    const units = unitDocs.filter((u) => String(u.receivingSessionId) === String(session._id));
    const missing = units.filter((u) => String(u.status || "").toUpperCase() === "COMPLETED" && !hasBuckets(u));
    if (missing.length) {
      completedSessionsWithMissingDisposition.push({
        sessionId: String(session._id),
        sessionNo: session.sessionNo,
        companyId: String(session.companyId || ""),
        companyCode: companyById.get(String(session.companyId))?.code || "",
        missingCount: missing.length,
      });
    }
  }

  const byCompany = {};
  for (const u of unitDocs) {
    const id = String(u.companyId || "");
    const code = companyById.get(id)?.code || id || "(unknown)";
    if (!byCompany[code]) {
      byCompany[code] = {
        companyId: id,
        companyCode: code,
        companyName: companyById.get(id)?.name || "",
        units: 0,
        completedUnits: 0,
        completedWithoutDisposition: 0,
        sessions: new Set(),
      };
    }
    byCompany[code].units += 1;
    byCompany[code].sessions.add(String(u.receivingSessionId || ""));
    if (String(u.status || "").toUpperCase() === "COMPLETED") byCompany[code].completedUnits += 1;
    if (String(u.status || "").toUpperCase() === "COMPLETED" && !hasBuckets(u)) {
      byCompany[code].completedWithoutDisposition += 1;
    }
  }

  const report = {
    capturedAt: new Date().toISOString(),
    mode: "READ_ONLY",
    collections: { sessionColl, unitColl, sessionExists, unitExists },
    companiesInspected: companies.length,
    companyCodes: companies.map((c) => c.code).sort(),
    receivingSessionsCount: sessionDocs.length,
    receivingSessionUnitsCount: unitDocs.length,
    completedUnits: completedUnits.length,
    completedUnitsWithoutDisposition: completedWithoutDisposition.length,
    completedUnitsByCondition: byCondition,
    completedWithoutDispositionByCondition: completedWithoutByCondition,
    completedSessions: completedSessions.length,
    completedSessionsWithMissingDisposition: completedSessionsWithMissingDisposition.length,
    completedSessionsWithMissingDispositionRows: completedSessionsWithMissingDisposition,
    byCompany: Object.values(byCompany).map((row) => ({
      ...row,
      sessions: row.sessions.size,
    })),
  };

  console.log(JSON.stringify(report, null, 2));
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
