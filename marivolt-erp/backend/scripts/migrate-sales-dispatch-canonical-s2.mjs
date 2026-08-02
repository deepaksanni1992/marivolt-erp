/**
 * S2 — Mark historical logistics-only SalesDispatch documents.
 * Default dry-run. Execute: node scripts/migrate-sales-dispatch-canonical-s2.mjs --execute
 *
 * Does NOT create StoreDispatch, DISPATCH_OUT, or change SI dispatchStatus.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import mongoose from "mongoose";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "../.env") });
if (!process.env.MONGO_URI) dotenv.config({ path: path.join(__dirname, "../../.env") });

const EXECUTE = process.argv.includes("--execute");

function maskNo(no) {
  const s = String(no || "");
  if (s.length <= 4) return "***";
  return `${s.slice(0, 3)}***${s.slice(-2)}`;
}

async function main() {
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI missing");
  console.log("=== S2 Sales Dispatch canonical migration ===");
  console.log("Mode:", EXECUTE ? "EXECUTE" : "DRY RUN");
  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 20000 });
  const db = mongoose.connection.db;
  const salesDisp = db.collection("salesdispatches");
  const storeDisp = db.collection("storedispatches");

  const all = await salesDisp.find({}).toArray();
  const plan = [];
  let wouldUpdate = 0;
  let unchanged = 0;

  for (const d of all) {
    const storeCount = d.linkedStoreDispatchId
      ? await storeDisp.countDocuments({ _id: d.linkedStoreDispatchId })
      : 0;
    const linkedStoreByCanon = await storeDisp.countDocuments({ canonicalSalesDispatchId: d._id });
    const hasPhysical = storeCount > 0 || linkedStoreByCanon > 0;

    const next = {
      postingStatus: hasPhysical
        ? String(d.postingStatus || "POSTED").toUpperCase() === "CANCELLED"
          ? "CANCELLED"
          : "POSTED"
        : d.postingStatus || "NOT_POSTED",
      isLegacyLogisticsOnly: !hasPhysical,
      linkedStorePackingId: d.linkedStorePackingId || null,
      linkedStorePackingNo: d.linkedStorePackingNo || "",
    };

    // Prefer NOT_POSTED + legacy flag when no physical evidence (production case).
    if (!hasPhysical) {
      next.postingStatus = "NOT_POSTED";
      next.isLegacyLogisticsOnly = true;
    }

    const same =
      Boolean(d.isLegacyLogisticsOnly) === next.isLegacyLogisticsOnly &&
      String(d.postingStatus || "NOT_POSTED") === next.postingStatus;

    if (same) {
      unchanged += 1;
      continue;
    }
    wouldUpdate += 1;
    plan.push({
      id: String(d._id),
      no: maskNo(d.dispatchNo),
      before: {
        status: d.status,
        postingStatus: d.postingStatus || null,
        isLegacyLogisticsOnly: d.isLegacyLogisticsOnly ?? null,
      },
      after: next,
      hasPhysical,
    });
    if (EXECUTE) {
      await salesDisp.updateOne(
        { _id: d._id },
        {
          $set: {
            postingStatus: next.postingStatus,
            isLegacyLogisticsOnly: next.isLegacyLogisticsOnly,
          },
        }
      );
    }
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const evidenceDir = path.join(__dirname, "repair-evidence");
  fs.mkdirSync(evidenceDir, { recursive: true });
  const evidence = {
    capturedAt: new Date().toISOString(),
    mode: EXECUTE ? "EXECUTE" : "DRY_RUN",
    totals: { salesDispatches: all.length, wouldUpdate, unchanged },
    samples: plan.slice(0, 30),
    note: "Does not create StoreDispatch or DISPATCH_OUT. Legacy logistics-only docs remain NOT_DISPATCHED physically.",
  };
  const p = path.join(evidenceDir, `s2-sales-dispatch-canonical-${stamp}.json`);
  fs.writeFileSync(p, JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ evidencePath: p, ...evidence.totals }, null, 2));
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
