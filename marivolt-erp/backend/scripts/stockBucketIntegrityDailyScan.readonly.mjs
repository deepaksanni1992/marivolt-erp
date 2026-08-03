/**
 * Daily company-scoped stock bucket integrity check (READ-ONLY).
 * No automatic repair. Exit code 1 when mismatches exist (for schedulers/alerts).
 *
 * Run: node scripts/stockBucketIntegrityDailyScan.readonly.mjs --company=MAR
 */
import "../src/loadEnv.js";
import mongoose from "mongoose";
import { runStockBucketIntegrityAudit } from "../src/services/stockBucketIntegrityService.js";

function arg(name, fallback = "") {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

async function main() {
  const companyCode = arg("company", "");
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI missing");
  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 20000 });
  const report = await runStockBucketIntegrityAudit({
    companyCode: companyCode || undefined,
    includeHealthy: false,
    limit: 500,
    page: 1,
  });
  const s = report.summary;
  console.log(
    JSON.stringify(
      {
        scannedAt: report.scannedAt,
        readOnly: true,
        mutated: false,
        companyCode: companyCode || "ALL",
        mismatchRows: s.mismatchRows,
        healthyRows: s.healthyRows,
        totalOrphanedReservedQty: s.totalOrphanedReservedQty,
        totalOrphanedPackedQty: s.totalOrphanedPackedQty,
        countsByMismatchType: s.countsByMismatchType,
        countsBySeverity: s.countsBySeverity,
        adminNotify: s.mismatchRows > 0,
      },
      null,
      2
    )
  );
  await mongoose.disconnect();
  if (s.mismatchRows > 0) process.exit(1);
}

main().catch(async (err) => {
  console.error(err);
  try {
    await mongoose.disconnect();
  } catch {
    /* ignore */
  }
  process.exit(2);
});
