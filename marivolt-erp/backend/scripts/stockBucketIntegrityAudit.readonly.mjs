/**
 * READ-ONLY global stock bucket integrity audit.
 * Does not mutate StockBalance, StockLedger, allocations, packing, GRN, or customs.
 *
 * Run: node scripts/stockBucketIntegrityAudit.readonly.mjs
 * Optional: --company=MAR --warehouse=MAIN --article=8X0098 --include-healthy
 */
import "../src/loadEnv.js";
import path from "path";
import { fileURLToPath } from "url";
import mongoose from "mongoose";
import {
  runStockBucketIntegrityAudit,
  writeAuditEvidence,
} from "../src/services/stockBucketIntegrityService.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function arg(name, fallback = "") {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

function flag(name) {
  return process.argv.includes(`--${name}`);
}

async function main() {
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI missing");

  const companyCode = arg("company", "");
  const warehouse = arg("warehouse", "");
  const article = arg("article", "");
  const includeHealthy = flag("include-healthy");
  const outDir =
    arg("out") ||
    path.join(__dirname, "..", "audit-evidence", "stock-bucket-integrity");

  console.log("=== Stock Bucket Integrity Audit (READ-ONLY) ===");
  console.log("Connecting…");
  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 20000 });
  console.log("Connected. Scanning (no writes)…");

  const report = await runStockBucketIntegrityAudit({
    companyCode: companyCode || undefined,
    warehouse: warehouse || undefined,
    article: article || undefined,
    includeHealthy,
    limit: 5000,
    page: 1,
  });

  const { jsonPath, csvPath } = await writeAuditEvidence(report, outDir);

  const s = report.summary;
  console.log("\n--- SUMMARY ---");
  console.log("scannedAt:", report.scannedAt);
  console.log("mutated:", report.mutated, "| readOnly:", report.readOnly);
  console.log("totalStockBalanceRowsScanned:", s.totalStockBalanceRowsScanned);
  console.log("healthyRows:", s.healthyRows);
  console.log("mismatchRows:", s.mismatchRows);
  console.log("totalOrphanedReservedQty:", s.totalOrphanedReservedQty);
  console.log("totalOrphanedPackedQty:", s.totalOrphanedPackedQty);
  console.log("totalOnHandLedgerMismatchQty:", s.totalOnHandLedgerMismatchQty);
  console.log("countsByCompany:", JSON.stringify(s.countsByCompany));
  console.log("countsByWarehouse:", JSON.stringify(s.countsByWarehouse));
  console.log("countsByMismatchType:", JSON.stringify(s.countsByMismatchType));
  console.log("countsBySeverity:", JSON.stringify(s.countsBySeverity));
  console.log("safeRepairCandidateCount:", s.safeRepairCandidateCount);
  console.log("blockedRepairCount:", s.blockedRepairCount);
  console.log("duplicateEffectKeyCount:", s.duplicateEffectKeyCount);
  console.log("\nEvidence:");
  console.log(" JSON:", jsonPath);
  console.log(" CSV:", csvPath);

  const known = (report.rows || []).find(
    (r) =>
      String(r.article).toUpperCase() === "8X0098" &&
      String(r.companyCode).toUpperCase() === "MAR"
  );
  if (known) {
    console.log("\n--- Known case 8X0098 / MAR ---");
    console.log(
      JSON.stringify(
        {
          warehouse: known.warehouseCode,
          onHandQty: known.onHandQty,
          storedReservedQty: known.storedReservedQty,
          expectedReservedQty: known.expectedReservedQty,
          orphanedReservedQty: known.orphanedReservedQty,
          storedPackedQty: known.storedPackedQty,
          expectedPackedQty: known.expectedPackedQty,
          mismatchTypes: known.mismatchTypes,
          severity: known.severity,
          safeRepairCandidate: known.safeRepairCandidate,
          ghostAllocationLedgerRefs: known.ghostAllocationLedgerRefs,
        },
        null,
        2
      )
    );
  } else {
    console.log("\n(No mismatch row for MAR / 8X0098 in filtered results — check healthy or filters.)");
  }

  console.log("\nCONFIRMATION: production data was NOT mutated by this script.");
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error(err);
  try {
    await mongoose.disconnect();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
