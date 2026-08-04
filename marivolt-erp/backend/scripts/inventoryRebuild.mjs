/**
 * Inventory rebuild CLI — dry-run by default.
 *
 *   node scripts/inventoryRebuild.mjs --company=MAR
 *   node scripts/inventoryRebuild.mjs --company=MAR --article=X --warehouse=MAIN
 *   node scripts/inventoryRebuild.mjs --company=MAR --article=X --apply
 *   node scripts/inventoryRebuild.mjs --company=MAR --validate-ri --apply
 *   node scripts/inventoryRebuild.mjs --company=MAR --health-cache --apply
 */
import "../src/loadEnv.js";
import mongoose from "mongoose";
import Company from "../src/models/Company.js";
import {
  diagnoseInventoryRebuild,
  diagnoseCompanyInventoryRebuild,
  rebuildInventoryBuckets,
  rebuildReservationIntegrityScan,
  rebuildHealthCache,
  rebuildCustomsNote,
} from "../src/services/inventoryRebuildService.js";

function arg(name, fallback = "") {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3);
  if (process.argv.includes(`--${name}`)) return true;
  return fallback;
}

async function main() {
  const companyCode = String(arg("company", "MAR")).toUpperCase();
  const warehouse = String(arg("warehouse", "")).toUpperCase();
  const article = String(arg("article", "")).toUpperCase();
  const apply = Boolean(arg("apply", false));
  const validateRi = Boolean(arg("validate-ri", false));
  const healthCache = Boolean(arg("health-cache", false));
  const customs = Boolean(arg("customs", false));
  const limit = Number(arg("limit", "200")) || 200;

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

    if (customs) {
      console.log(JSON.stringify(await rebuildCustomsNote(), null, 2));
      return;
    }
    if (healthCache) {
      console.log(
        JSON.stringify(await rebuildHealthCache({ companyId: company._id, apply }), null, 2)
      );
      return;
    }
    if (validateRi) {
      console.log(
        JSON.stringify(
          await rebuildReservationIntegrityScan({
            companyId: company._id,
            warehouse: warehouse || undefined,
            article: article || undefined,
            apply,
          }),
          null,
          2
        )
      );
      return;
    }

    // Company-wide dry-run when no article (never apply bulk without explicit per-article)
    if (!article) {
      if (apply) {
        throw new Error(
          "Company-wide --apply is refused. Pass --article=CODE --apply for a single guarded rebuild."
        );
      }
      const report = await diagnoseCompanyInventoryRebuild({
        companyId: company._id,
        warehouse: warehouse || undefined,
        limit,
      });
      console.log(JSON.stringify(report, null, 2));
      console.log(
        `\nDRY-RUN OK — scanned ${report.rowsScanned}, rebuildable ${report.rebuildable}, refused ${report.refused}. Evidence: ${report.evidencePath}`
      );
      return;
    }

    const wh = warehouse || "MAIN";
    if (!apply) {
      const d = await diagnoseInventoryRebuild({
        companyId: company._id,
        warehouse: wh,
        article,
      });
      console.log(JSON.stringify(d, null, 2));
      console.log(d.rebuildable ? "\nDRY-RUN OK — use --apply when approved." : "\nNo changes needed.");
      return;
    }

    const result = await rebuildInventoryBuckets({
      companyId: company._id,
      warehouse: wh,
      article,
      apply: true,
      repairedBy: process.env.USER || process.env.USERNAME || "cli-inventoryRebuild",
    });
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
