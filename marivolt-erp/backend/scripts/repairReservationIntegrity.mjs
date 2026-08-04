/**
 * Generic reservation integrity repair CLI.
 *
 * Dry-run (default):
 *   node scripts/repairReservationIntegrity.mjs --company=MAR --warehouse=MAIN --article=8X0098
 *
 * Apply:
 *   node scripts/repairReservationIntegrity.mjs --company=MAR --warehouse=MAIN --article=8X0098 --apply
 *
 * Validate-all (read-only persist):
 *   node scripts/repairReservationIntegrity.mjs --company=MAR --validate-all
 */
import "../src/loadEnv.js";
import mongoose from "mongoose";
import Company from "../src/models/Company.js";
import {
  diagnoseReservationRepair,
  repairReservationIntegrity,
} from "../src/services/repairReservationIntegrity.js";
import { validateAllStock } from "../src/services/reservationIntegrityService.js";

function arg(name, fallback = "") {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3);
  if (process.argv.includes(`--${name}`)) return true;
  return fallback;
}

async function main() {
  const companyCode = String(arg("company", "MAR")).toUpperCase();
  const warehouse = String(arg("warehouse", "MAIN")).toUpperCase();
  const article = String(arg("article", "")).toUpperCase();
  const apply = Boolean(arg("apply", false));
  const validateAll = Boolean(arg("validate-all", false));

  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) throw new Error("MONGODB_URI missing");
  await mongoose.connect(uri);

  try {
    const company = await Company.findOne({
      $or: [{ code: companyCode }, { companyCode }],
    })
      .select("_id code companyCode")
      .lean();
    if (!company) throw new Error(`Company ${companyCode} not found`);

    if (validateAll) {
      console.log("=== VALIDATE ALL STOCK ===");
      const report = await validateAllStock({
        companyId: company._id,
        warehouse: warehouse || undefined,
        article: article || undefined,
        includeHealthy: false,
        persist: true,
      });
      console.log(JSON.stringify(report.summary, null, 2));
      console.log(`Mismatch rows: ${report.mismatchRows}`);
      return;
    }

    if (!article) throw new Error("--article=CODE is required (or use --validate-all)");

    console.log("=== TARGET ===");
    console.log({ companyCode, warehouse, article, apply });

    if (!apply) {
      const diagnosis = await diagnoseReservationRepair({
        companyId: company._id,
        companyCode,
        warehouse,
        article,
      });
      console.log("\n=== DIAGNOSIS (dry-run) ===");
      console.log(JSON.stringify(diagnosis, null, 2));
      if (diagnosis.repairable) {
        console.log("\nDRY-RUN OK — ready for --apply when explicitly approved.");
      } else if (diagnosis.alreadyRepaired) {
        console.log("\nAlready repaired (idempotent).");
      } else {
        console.log("\nRepair refused:", diagnosis.refusalReasons);
        process.exitCode = 2;
      }
      return;
    }

    console.log("\n=== APPLYING REPAIR ===");
    const result = await repairReservationIntegrity({
      companyId: company._id,
      companyCode,
      warehouse,
      article,
      apply: true,
      repairedBy: process.env.USER || process.env.USERNAME || "cli-repairReservationIntegrity",
    });
    console.log("\n=== RESULT ===");
    console.log(JSON.stringify(result, null, 2));
    if (!result.applied && !result.idempotent) process.exitCode = 2;
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
