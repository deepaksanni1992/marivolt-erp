/**
 * P0.2 — Controlled orphan RTS status reconciliation (single hard-coded target).
 *
 * Default: dry-run (no writes).
 * Execute: node scripts/repair-orphan-rts-status-p02.mjs --execute
 *
 * Status-only:
 *   RTS APPROVED → DRAFT
 *   Allocation RTS_COMPLETE → OPEN
 *
 * Does NOT touch stock, ledger, packing, invoice, dispatch, or document lines.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import mongoose from "mongoose";
import dotenv from "dotenv";
import Rts from "../src/models/Rts.js";
import OrderAllocation from "../src/models/OrderAllocation.js";
import StockLedger from "../src/models/StockLedger.js";
import StockBalance from "../src/models/StockBalance.js";
import StorePacking from "../src/models/StorePacking.js";
import SalesInvoice from "../src/models/SalesInvoice.js";
import StoreDispatch from "../src/models/StoreDispatch.js";
import SalesDispatch from "../src/models/SalesDispatch.js";
import { writeAudit } from "../src/services/auditService.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "../.env") });
if (!process.env.MONGO_URI) dotenv.config({ path: path.join(__dirname, "../../.env") });

/** Hard-coded single-target repair — refuse any other IDs. */
const TARGET = Object.freeze({
  rtsId: "69f4b9fb47c2dd7dcac1749a",
  allocationId: "69f4b9b547c2dd7dcac1748a",
  companyId: "69e9f1791bcc5763ef869447",
  expectedRtsStatus: "APPROVED",
  expectedAllocationStatus: "RTS_COMPLETE",
  commitRef: "a01fddf",
  maintenanceIdentity: "p0.2-orphan-rts-status-reconciliation",
});

const EXECUTE = process.argv.includes("--execute");

function oid(id) {
  return new mongoose.Types.ObjectId(String(id));
}

function lineFingerprint(lines = []) {
  return (lines || []).map((l) => ({
    allocationLineId: String(l.allocationLineId || ""),
    article: String(l.article || "").trim().toUpperCase(),
    qty: Number(l.qty) || 0,
  }));
}

async function gatherEvidence(rts, allocation) {
  const companyId = oid(TARGET.companyId);
  const rtsId = oid(TARGET.rtsId);
  const allocationId = oid(TARGET.allocationId);
  const rtsNo = String(rts.rtsNo || "").trim();
  const articles = [...new Set((rts.lines || []).map((l) => String(l.article || "").trim().toUpperCase()).filter(Boolean))];

  const [
    rtsTransferCount,
    articleLedgerCount,
    articleBalanceCount,
    packingCount,
    invoiceCount,
    storeDispatchCount,
    salesDispatchCount,
  ] = await Promise.all([
    StockLedger.countDocuments({
      companyId,
      referenceNo: rtsNo,
      $or: [{ movementType: "RTS_TRANSFER" }, { transactionType: "RTS" }],
    }),
    articles.length
      ? StockLedger.countDocuments({ companyId, article: { $in: articles } })
      : Promise.resolve(0),
    articles.length
      ? StockBalance.countDocuments({
          companyId,
          $or: [{ article: { $in: articles } }, { itemCode: { $in: articles } }],
        })
      : Promise.resolve(0),
    StorePacking.countDocuments({ companyId, allocationId }),
    SalesInvoice.countDocuments({
      companyId,
      $or: [{ linkedOrderAllocationId: allocationId }, { linkedRtsId: rtsId }],
    }),
    StoreDispatch.countDocuments({ companyId, allocationId }),
    SalesDispatch.countDocuments({
      companyId,
      $or: [{ linkedRtsId: rtsId }],
    }),
  ]);

  return {
    rtsId: String(rts._id),
    rtsStatus: String(rts.status || ""),
    rtsUpdatedAt: rts.updatedAt ? new Date(rts.updatedAt).toISOString() : null,
    rtsLinkedAllocationId: String(rts.linkedOrderAllocationId || ""),
    rtsLineFingerprint: lineFingerprint(rts.lines),
    allocationId: String(allocation._id),
    allocationStatus: String(allocation.status || ""),
    allocationUpdatedAt: allocation.updatedAt ? new Date(allocation.updatedAt).toISOString() : null,
    allocationLineFingerprint: lineFingerprint(allocation.lines),
    articleCount: articles.length,
    ledgerCounts: {
      rtsTransferForRtsNo: rtsTransferCount,
      stockLedgerForArticles: articleLedgerCount,
    },
    stockBalanceCountForArticles: articleBalanceCount,
    packingCount,
    invoiceCount,
    storeDispatchCount,
    salesDispatchCount,
  };
}

function assertPreconditions(evidence) {
  const failures = [];
  if (evidence.rtsStatus !== TARGET.expectedRtsStatus) {
    failures.push(`RTS status is ${evidence.rtsStatus}, expected ${TARGET.expectedRtsStatus}`);
  }
  if (evidence.allocationStatus !== TARGET.expectedAllocationStatus) {
    failures.push(
      `Allocation status is ${evidence.allocationStatus}, expected ${TARGET.expectedAllocationStatus}`
    );
  }
  if (evidence.rtsLinkedAllocationId !== TARGET.allocationId) {
    failures.push(
      `RTS linked allocation ${evidence.rtsLinkedAllocationId} != target ${TARGET.allocationId}`
    );
  }
  if (evidence.ledgerCounts.rtsTransferForRtsNo !== 0) {
    failures.push(`RTS_TRANSFER ledger count is ${evidence.ledgerCounts.rtsTransferForRtsNo}, expected 0`);
  }
  if (evidence.ledgerCounts.stockLedgerForArticles !== 0) {
    failures.push(
      `Article StockLedger count is ${evidence.ledgerCounts.stockLedgerForArticles}, expected 0`
    );
  }
  if (evidence.stockBalanceCountForArticles !== 0) {
    failures.push(`StockBalance count is ${evidence.stockBalanceCountForArticles}, expected 0`);
  }
  if (evidence.packingCount !== 0) failures.push(`Packing count is ${evidence.packingCount}, expected 0`);
  if (evidence.invoiceCount !== 0) failures.push(`Invoice count is ${evidence.invoiceCount}, expected 0`);
  if (evidence.storeDispatchCount !== 0) {
    failures.push(`StoreDispatch count is ${evidence.storeDispatchCount}, expected 0`);
  }
  if (evidence.salesDispatchCount !== 0) {
    failures.push(`SalesDispatch count is ${evidence.salesDispatchCount}, expected 0`);
  }
  return failures;
}

async function main() {
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI missing in .env");

  console.log("=== P0.2 orphan RTS status reconciliation ===");
  console.log("Mode:", EXECUTE ? "EXECUTE" : "DRY RUN (no writes)");
  console.log("Target RTS:", TARGET.rtsId);
  console.log("Target allocation:", TARGET.allocationId);
  console.log("Company:", TARGET.companyId);

  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 20000 });

  const companyId = oid(TARGET.companyId);
  const rtsId = oid(TARGET.rtsId);
  const allocationId = oid(TARGET.allocationId);

  const rts = await Rts.findOne({ _id: rtsId, companyId }).lean();
  if (!rts) {
    throw new Error("ABORT: target RTS not found for company (no data modified)");
  }
  const allocation = await OrderAllocation.findOne({ _id: allocationId, companyId }).lean();
  if (!allocation) {
    throw new Error("ABORT: target allocation not found for company (no data modified)");
  }

  const evidence = await gatherEvidence(rts, allocation);
  const failures = assertPreconditions(evidence);
  if (failures.length) {
    console.error("ABORT: pre-repair conditions failed:");
    for (const f of failures) console.error(" -", f);
    console.error("Evidence snapshot:", JSON.stringify(evidence, null, 2));
    await mongoose.disconnect();
    process.exit(2);
  }

  const proposed = {
    rts: {
      filter: {
        _id: TARGET.rtsId,
        companyId: TARGET.companyId,
        status: "APPROVED",
        linkedOrderAllocationId: TARGET.allocationId,
      },
      $set: {
        status: "DRAFT",
        updatedBy: TARGET.maintenanceIdentity,
      },
    },
    allocation: {
      filter: {
        _id: TARGET.allocationId,
        companyId: TARGET.companyId,
        status: "RTS_COMPLETE",
      },
      $set: {
        status: "OPEN",
        updatedBy: TARGET.maintenanceIdentity,
      },
    },
  };

  console.log("\nPre-repair conditions: OK");
  console.log(JSON.stringify(evidence, null, 2));
  console.log("\nProposed updates (status fields only):");
  console.log(JSON.stringify(proposed, null, 2));

  const evidenceDir = path.join(__dirname, "repair-evidence");
  fs.mkdirSync(evidenceDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = path.join(evidenceDir, `p02-orphan-rts-pre-${stamp}.json`);
  const backup = {
    repairType: "ORPHAN_RTS_STATUS_RECONCILIATION",
    mode: EXECUTE ? "EXECUTE" : "DRY_RUN",
    capturedAt: new Date().toISOString(),
    commitReference: TARGET.commitRef,
    target: {
      rtsId: TARGET.rtsId,
      allocationId: TARGET.allocationId,
      companyId: TARGET.companyId,
    },
    evidence,
    proposed,
  };
  fs.writeFileSync(backupPath, JSON.stringify(backup, null, 2), "utf8");
  console.log("\nBackup evidence written:", backupPath);

  if (!EXECUTE) {
    console.log("\nDry run complete — no database writes performed.");
    await mongoose.disconnect();
    return;
  }

  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const now = new Date();
    const rtsUpdate = await Rts.updateOne(
      {
        _id: rtsId,
        companyId,
        status: "APPROVED",
        linkedOrderAllocationId: allocationId,
      },
      {
        $set: {
          status: "DRAFT",
          updatedBy: TARGET.maintenanceIdentity,
          updatedAt: now,
        },
      },
      { session }
    );
    if (rtsUpdate.matchedCount !== 1 || rtsUpdate.modifiedCount !== 1) {
      throw new Error(
        `ABORT: RTS conditional update failed (matched=${rtsUpdate.matchedCount}, modified=${rtsUpdate.modifiedCount})`
      );
    }

    const allocUpdate = await OrderAllocation.updateOne(
      {
        _id: allocationId,
        companyId,
        status: "RTS_COMPLETE",
      },
      {
        $set: {
          status: "OPEN",
          updatedBy: TARGET.maintenanceIdentity,
          updatedAt: now,
        },
      },
      { session }
    );
    if (allocUpdate.matchedCount !== 1 || allocUpdate.modifiedCount !== 1) {
      throw new Error(
        `ABORT: Allocation conditional update failed (matched=${allocUpdate.matchedCount}, modified=${allocUpdate.modifiedCount})`
      );
    }

    await session.commitTransaction();
    console.log("\nTransaction committed.");
    console.log("RTS update:", rtsUpdate);
    console.log("Allocation update:", allocUpdate);
  } catch (err) {
    await session.abortTransaction();
    throw err;
  } finally {
    session.endSession();
  }

  await writeAudit(null, {
    companyId,
    userName: TARGET.maintenanceIdentity,
    userEmail: TARGET.maintenanceIdentity,
    action: "STATUS_CHANGE",
    module: "SALES",
    entityType: "RTS",
    entityId: TARGET.rtsId,
    documentNo: String(rts.rtsNo || TARGET.rtsId),
    fromStatus: "APPROVED",
    toStatus: "DRAFT",
    description:
      "ORPHAN_RTS_STATUS_RECONCILIATION: RTS APPROVED→DRAFT and allocation RTS_COMPLETE→OPEN; APPROVED existed without RTS stock-posting evidence",
    beforeData: {
      rtsStatus: "APPROVED",
      allocationId: TARGET.allocationId,
      allocationStatus: "RTS_COMPLETE",
    },
    afterData: {
      rtsStatus: "DRAFT",
      allocationId: TARGET.allocationId,
      allocationStatus: "OPEN",
    },
    metadata: {
      repairType: "ORPHAN_RTS_STATUS_RECONCILIATION",
      rtsId: TARGET.rtsId,
      allocationId: TARGET.allocationId,
      rtsOldStatus: "APPROVED",
      rtsNewStatus: "DRAFT",
      allocationOldStatus: "RTS_COMPLETE",
      allocationNewStatus: "OPEN",
      reason: "APPROVED status existed without RTS stock-posting evidence",
      stockImpact: "NONE",
      ledgerImpact: "NONE",
      commitReference: TARGET.commitRef,
      actingUser: TARGET.maintenanceIdentity,
      timestamp: new Date().toISOString(),
    },
  });

  const rtsAfter = await Rts.findOne({ _id: rtsId, companyId }).lean();
  const allocAfter = await OrderAllocation.findOne({ _id: allocationId, companyId }).lean();
  const post = await gatherEvidence(rtsAfter, allocAfter);

  const postFailures = [];
  if (post.rtsStatus !== "DRAFT") postFailures.push(`RTS status is ${post.rtsStatus}, expected DRAFT`);
  if (post.allocationStatus !== "OPEN") {
    postFailures.push(`Allocation status is ${post.allocationStatus}, expected OPEN`);
  }
  if (post.rtsLinkedAllocationId !== TARGET.allocationId) {
    postFailures.push("RTS allocation link changed");
  }
  if (JSON.stringify(post.rtsLineFingerprint) !== JSON.stringify(evidence.rtsLineFingerprint)) {
    postFailures.push("RTS lines/quantities changed");
  }
  if (
    JSON.stringify(post.allocationLineFingerprint) !==
    JSON.stringify(evidence.allocationLineFingerprint)
  ) {
    postFailures.push("Allocation lines/quantities changed");
  }
  if (post.ledgerCounts.rtsTransferForRtsNo !== 0) postFailures.push("RTS_TRANSFER ledger appeared");
  if (post.ledgerCounts.stockLedgerForArticles !== 0) postFailures.push("StockLedger appeared");
  if (post.stockBalanceCountForArticles !== 0) postFailures.push("StockBalance appeared/changed count");
  if (post.packingCount !== 0) postFailures.push("Packing appeared");
  if (post.invoiceCount !== 0) postFailures.push("Invoice appeared");
  if (post.storeDispatchCount !== 0 || post.salesDispatchCount !== 0) {
    postFailures.push("Dispatch appeared");
  }

  const postPath = path.join(evidenceDir, `p02-orphan-rts-post-${stamp}.json`);
  fs.writeFileSync(
    postPath,
    JSON.stringify(
      {
        repairType: "ORPHAN_RTS_STATUS_RECONCILIATION",
        verifiedAt: new Date().toISOString(),
        pre: evidence,
        post,
        postFailures,
      },
      null,
      2
    ),
    "utf8"
  );

  if (postFailures.length) {
    console.error("\nPOST-REPAIR VERIFICATION FAILED:");
    for (const f of postFailures) console.error(" -", f);
    await mongoose.disconnect();
    process.exit(3);
  }

  console.log("\nPost-repair verification: OK");
  console.log(JSON.stringify(post, null, 2));
  console.log("Post evidence written:", postPath);

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
