/**
 * P0.4 — Remove RTS module data (documents + collection).
 *
 * Default: dry-run. Execute: node scripts/migrate-remove-rts-module.mjs --execute
 *
 * Aborts if any RTS stock ledger, non-zero rtsQty, or RTS-linked packing/invoice/dispatch exists.
 * Preserves AuditLog. Does not create/reverse StockLedger rows or change stock buckets
 * other than $unset of zero/unused rtsQty fields.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import mongoose from "mongoose";
import dotenv from "dotenv";
import { writeAudit } from "../src/services/auditService.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "../.env") });
if (!process.env.MONGO_URI) dotenv.config({ path: path.join(__dirname, "../../.env") });

const EXECUTE = process.argv.includes("--execute");
const SOURCE_COMMITS = ["a01fddf", "20cc999"];

function maskNo(s) {
  const t = String(s || "").trim();
  if (!t) return "";
  if (t.length <= 6) return "***";
  return `${t.slice(0, 3)}-…${t.slice(-3)}`;
}

async function gather(db) {
  const collNames = (await db.listCollections().toArray()).map((c) => c.name);
  const rtsColl = collNames.includes("rts") ? "rts" : null;
  const rtsDocs = rtsColl ? await db.collection(rtsColl).find({}).toArray() : [];
  const byStatus = {};
  for (const d of rtsDocs) {
    const st = String(d.status || "UNKNOWN").toUpperCase();
    byStatus[st] = (byStatus[st] || 0) + 1;
  }

  const ledgerTransfer = await db.collection("stockledgers").countDocuments({
    $or: [{ movementType: "RTS_TRANSFER" }, { transactionType: "RTS" }],
  });
  const ledgerCancel = await db.collection("stockledgers").countDocuments({
    $or: [{ movementType: "RTS_CANCEL" }, { transactionType: "RTS_CANCEL" }],
  });
  const ledgerAny = await db.collection("stockledgers").countDocuments({
    $or: [
      { movementType: /RTS/i },
      { transactionType: /RTS/i },
      { referenceType: /RTS/i },
    ],
  });
  const balRtsNonZero = await db.collection("stockbalances").countDocuments({
    $expr: { $ne: [{ $ifNull: ["$rtsQty", 0] }, 0] },
  });
  const balRtsExists = await db.collection("stockbalances").countDocuments({ rtsQty: { $exists: true } });

  const allocPartial = await db.collection("orderallocations").countDocuments({ status: "PARTIALLY_RTS" });
  const allocComplete = await db.collection("orderallocations").countDocuments({ status: "RTS_COMPLETE" });
  const allocLegacy = await db
    .collection("orderallocations")
    .find({ status: { $in: ["PARTIALLY_RTS", "RTS_COMPLETE"] } })
    .project({ status: 1, companyId: 1, packingStatus: 1 })
    .toArray();

  const packingLinked = await db.collection("storepackings").countDocuments({
    $or: [{ linkedRtsId: { $ne: null } }, { rtsId: { $ne: null } }],
  });
  const invLinked = await db.collection("salesinvoices").countDocuments({ linkedRtsId: { $ne: null } });
  const storeDispLinked = await db.collection("storedispatches").countDocuments({
    $or: [{ linkedRtsId: { $ne: null } }, { rtsId: { $ne: null } }],
  });
  const salesDispLinked = await db.collection("salesdispatches").countDocuments({ linkedRtsId: { $ne: null } });
  const auditRts = await db.collection("auditlogs").countDocuments({
    $or: [{ entityType: /RTS/i }, { "metadata.repairType": /RTS/i }, { "metadata.migrationType": /RTS/i }],
  });

  const masked = rtsDocs.map((d) => ({
    rtsId: String(d._id),
    companyId: String(d.companyId || ""),
    rtsNo: maskNo(d.rtsNo),
    status: d.status || "",
    linkedOrderAllocationId: d.linkedOrderAllocationId ? String(d.linkedOrderAllocationId) : null,
    lines: (d.lines || []).map((l) => ({
      lineId: String(l._id || ""),
      allocationLineId: l.allocationLineId ? String(l.allocationLineId) : "",
      article: String(l.article || "").toUpperCase(),
      qty: Number(l.qty) || 0,
    })),
    createdAt: d.createdAt || null,
    updatedAt: d.updatedAt || null,
  }));

  return {
    rtsCollection: rtsColl,
    rtsDocumentsTotal: rtsDocs.length,
    rtsByStatus: byStatus,
    maskedRtsDocuments: masked,
    ledger: { transfer: ledgerTransfer, cancel: ledgerCancel, any: ledgerAny },
    stockBalance: { rtsQtyExists: balRtsExists, rtsQtyNonZero: balRtsNonZero },
    allocations: {
      PARTIALLY_RTS: allocPartial,
      RTS_COMPLETE: allocComplete,
      legacyDocs: allocLegacy.map((a) => ({
        id: String(a._id),
        companyId: String(a.companyId || ""),
        status: a.status,
        packingStatus: a.packingStatus || "",
      })),
    },
    links: { packingLinked, invLinked, storeDispLinked, salesDispLinked },
    auditLogsLinkedToRts: auditRts,
  };
}

function abortReasons(g) {
  const reasons = [];
  if (g.ledger.transfer > 0) reasons.push(`RTS_TRANSFER/RTS ledger rows: ${g.ledger.transfer}`);
  if (g.ledger.cancel > 0) reasons.push(`RTS_CANCEL ledger rows: ${g.ledger.cancel}`);
  if (g.ledger.any > 0) reasons.push(`RTS-like ledger rows: ${g.ledger.any}`);
  if (g.stockBalance.rtsQtyNonZero > 0) reasons.push(`Non-zero rtsQty balances: ${g.stockBalance.rtsQtyNonZero}`);
  if (g.links.packingLinked > 0) reasons.push(`Packing linked to RTS: ${g.links.packingLinked}`);
  if (g.links.invLinked > 0) reasons.push(`Sales invoices linked to RTS: ${g.links.invLinked}`);
  if (g.links.storeDispLinked + g.links.salesDispLinked > 0) {
    reasons.push(`Dispatch linked to RTS: ${g.links.storeDispLinked + g.links.salesDispLinked}`);
  }
  return reasons;
}

function targetAllocationStatus(doc) {
  const pack = String(doc.packingStatus || "").toUpperCase();
  if (pack === "FULLY_PACKED") return "FULLY_PACKED";
  if (pack === "PARTIALLY_PACKED") return "PARTIALLY_PACKED";
  return "OPEN";
}

async function main() {
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI missing");
  console.log("=== P0.4 RTS module removal ===");
  console.log("Mode:", EXECUTE ? "EXECUTE" : "DRY RUN");

  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 20000 });
  const db = mongoose.connection.db;
  const before = await gather(db);
  const reasons = abortReasons(before);
  if (reasons.length) {
    console.error("ABORT: unexpected RTS stock/downstream dependency:");
    for (const r of reasons) console.error(" -", r);
    await mongoose.disconnect();
    process.exit(2);
  }

  const evidenceDir = path.join(__dirname, "repair-evidence");
  fs.mkdirSync(evidenceDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = path.join(evidenceDir, `p04-rts-module-removal-backup-${stamp}.json`);
  const backup = {
    migrationType: "RTS_MODULE_REMOVAL",
    mode: EXECUTE ? "EXECUTE" : "DRY_RUN",
    capturedAt: new Date().toISOString(),
    sourceCommits: SOURCE_COMMITS,
    before,
    proposed: {
      deleteRtsDocuments: before.rtsDocumentsTotal,
      dropCollection: before.rtsCollection,
      reconcileAllocations: before.allocations.legacyDocs.map((a) => ({
        id: a.id,
        from: a.status,
        to: targetAllocationStatus(a),
      })),
      unsetStockBalanceRtsQty: before.stockBalance.rtsQtyExists,
      unsetNullLinkedRtsFields: true,
      stockImpact: "NONE",
      ledgerImpact: "NONE",
      preserveAuditLog: true,
    },
  };
  fs.writeFileSync(backupPath, JSON.stringify(backup, null, 2));
  console.log("Backup written:", backupPath);
  console.log(JSON.stringify({ beforeSummary: {
    rtsDocumentsTotal: before.rtsDocumentsTotal,
    rtsByStatus: before.rtsByStatus,
    ledger: before.ledger,
    allocations: {
      PARTIALLY_RTS: before.allocations.PARTIALLY_RTS,
      RTS_COMPLETE: before.allocations.RTS_COMPLETE,
    },
    links: before.links,
    stockBalance: before.stockBalance,
    auditLogsLinkedToRts: before.auditLogsLinkedToRts,
  }, proposed: backup.proposed }, null, 2));

  if (!EXECUTE) {
    console.log("Dry run complete — no writes.");
    await mongoose.disconnect();
    return;
  }

  // Re-run safety: if already cleaned, no-op success.
  if (!before.rtsCollection && before.rtsDocumentsTotal === 0 && before.allocations.PARTIALLY_RTS === 0 && before.allocations.RTS_COMPLETE === 0) {
    console.log("Already migrated — nothing to do.");
    await mongoose.disconnect();
    return;
  }

  const session = await mongoose.startSession();
  session.startTransaction();
  let documentsDeleted = 0;
  let allocationsReconciled = 0;
  let balancesUnset = 0;
  try {
    const rtsColl = db.collection("rts");
    if (before.rtsCollection) {
      // Conditional delete: only docs that still have no RTS ledger for their number.
      for (const doc of before.maskedRtsDocuments) {
        const full = await rtsColl.findOne({ _id: new mongoose.Types.ObjectId(doc.rtsId) }, { session });
        if (!full) continue;
        const led = await db.collection("stockledgers").countDocuments(
          {
            companyId: full.companyId,
            referenceNo: String(full.rtsNo || ""),
            $or: [{ movementType: "RTS_TRANSFER" }, { transactionType: "RTS" }, { movementType: "RTS_CANCEL" }],
          },
          { session }
        );
        if (led > 0) throw new Error(`ABORT: ledger appeared for RTS ${doc.rtsId}`);
        const del = await rtsColl.deleteOne({ _id: full._id }, { session });
        if (del.deletedCount !== 1) throw new Error(`ABORT: failed deleting RTS ${doc.rtsId}`);
        documentsDeleted += 1;
      }
    }

    for (const a of before.allocations.legacyDocs) {
      const to = targetAllocationStatus(a);
      const res = await db.collection("orderallocations").updateOne(
        {
          _id: new mongoose.Types.ObjectId(a.id),
          companyId: new mongoose.Types.ObjectId(a.companyId),
          status: a.status,
        },
        {
          $set: { status: to, updatedBy: "p0.4-rts-module-removal", updatedAt: new Date() },
          $unset: { linkedRtsId: "", rtsIds: "", rtsQty: "", rtsCompletedQty: "" },
        },
        { session }
      );
      if (res.matchedCount !== 1) throw new Error(`ABORT: allocation reconcile mismatch ${a.id}`);
      allocationsReconciled += 1;
    }

    // Also unset RTS link fields on any allocation (no status change).
    await db.collection("orderallocations").updateMany(
      {
        $or: [
          { linkedRtsId: { $exists: true } },
          { rtsIds: { $exists: true } },
          { rtsQty: { $exists: true } },
          { rtsCompletedQty: { $exists: true } },
        ],
      },
      { $unset: { linkedRtsId: "", rtsIds: "", rtsQty: "", rtsCompletedQty: "" } },
      { session }
    );

    const balUnset = await db.collection("stockbalances").updateMany(
      { rtsQty: { $exists: true }, $expr: { $eq: [{ $ifNull: ["$rtsQty", 0] }, 0] } },
      { $unset: { rtsQty: "" } },
      { session }
    );
    balancesUnset = balUnset.modifiedCount || 0;

    await db.collection("salesinvoices").updateMany(
      { $or: [{ linkedRtsId: null }, { linkedRtsId: { $exists: true } }] },
      { $unset: { linkedRtsId: "", linkedRtsNo: "", convertedFromRtsAt: "", convertedFromRtsBy: "" } },
      { session }
    );
    await db.collection("salesdispatches").updateMany(
      {},
      { $unset: { linkedRtsId: "", linkedRtsNo: "" } },
      { session }
    );
    if ((await db.listCollections({ name: "shipments" }).toArray()).length) {
      await db.collection("shipments").updateMany({}, { $unset: { linkedRtsId: "", linkedRtsNo: "" } }, { session });
    }

    await session.commitTransaction();
  } catch (e) {
    await session.abortTransaction();
    throw e;
  } finally {
    session.endSession();
  }

  // Drop collection outside the multi-doc transaction (Mongo restriction).
  const still = (await db.listCollections({ name: "rts" }).toArray()).length;
  if (still) {
    const remaining = await db.collection("rts").countDocuments();
    if (remaining !== 0) throw new Error(`ABORT: rts collection still has ${remaining} docs after delete`);
    await db.collection("rts").drop();
    console.log("Dropped collection: rts");
  }

  await writeAudit(null, {
    companyId: null,
    userName: "p0.4-rts-module-removal",
    userEmail: "p0.4-rts-module-removal",
    action: "OTHER",
    module: "SALES",
    entityType: "RTS_MODULE",
    entityId: "RTS_MODULE_REMOVAL",
    documentNo: "RTS_MODULE_REMOVAL",
    description: "RTS_MODULE_REMOVAL: deleted RTS documents and dropped rts collection; reconciled legacy allocation statuses; no stock/ledger impact",
    metadata: {
      migrationType: "RTS_MODULE_REMOVAL",
      documentsDeleted,
      allocationsReconciled,
      balancesUnsetRtsQty: balancesUnset,
      stockImpact: "NONE",
      ledgerImpact: "NONE",
      sourceCommits: SOURCE_COMMITS,
      timestamp: new Date().toISOString(),
    },
  });

  const after = await gather(db);
  const postPath = path.join(evidenceDir, `p04-rts-module-removal-post-${stamp}.json`);
  fs.writeFileSync(
    postPath,
    JSON.stringify({ migrationType: "RTS_MODULE_REMOVAL", verifiedAt: new Date().toISOString(), documentsDeleted, allocationsReconciled, balancesUnset, after }, null, 2)
  );

  const postFail = [];
  if (after.rtsDocumentsTotal !== 0) postFail.push("RTS docs remain");
  if (after.rtsCollection) postFail.push("rts collection still present");
  if (after.allocations.PARTIALLY_RTS || after.allocations.RTS_COMPLETE) postFail.push("legacy allocation statuses remain");
  if (after.ledger.transfer || after.ledger.cancel || after.ledger.any) postFail.push("RTS ledger rows present");
  if (after.links.packingLinked || after.links.invLinked || after.links.storeDispLinked || after.links.salesDispLinked) {
    postFail.push("RTS-linked commercial docs present");
  }
  if (postFail.length) {
    console.error("POST verification failed:", postFail);
    await mongoose.disconnect();
    process.exit(3);
  }

  console.log("Post-migration OK");
  console.log(JSON.stringify({ documentsDeleted, allocationsReconciled, balancesUnset, after: {
    rtsDocumentsTotal: after.rtsDocumentsTotal,
    rtsCollection: after.rtsCollection,
    allocations: { PARTIALLY_RTS: after.allocations.PARTIALLY_RTS, RTS_COMPLETE: after.allocations.RTS_COMPLETE },
    auditLogsLinkedToRts: after.auditLogsLinkedToRts,
  } }, null, 2));
  console.log("Post evidence:", postPath);
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error("FATAL:", err.message || err);
  try { await mongoose.disconnect(); } catch { /* ignore */ }
  process.exit(1);
});
