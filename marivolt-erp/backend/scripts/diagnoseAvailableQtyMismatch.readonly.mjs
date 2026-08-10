/**
 * READ-ONLY: find StockBalance rows where stored availableQty != deriveAvailableQty.
 *
 * Usage:
 *   node scripts/diagnoseAvailableQtyMismatch.readonly.mjs
 *   node scripts/diagnoseAvailableQtyMismatch.readonly.mjs --company=MAR
 *   node scripts/diagnoseAvailableQtyMismatch.readonly.mjs --company=MAR --warehouse=MAIN
 *   node scripts/diagnoseAvailableQtyMismatch.readonly.mjs --company=MAR --article=8X0098
 *
 * Does not mutate data.
 */
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import mongoose from "mongoose";
import Company from "../src/models/Company.js";
import StockBalance from "../src/models/StockBalance.js";
import { deriveAvailableQty } from "../src/services/stockExpectedBuckets.js";

const EPS = 1e-6;

function arg(name, fallback = "") {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3);
  if (process.argv.includes(`--${name}`)) return true;
  return fallback;
}

async function main() {
  const companyCode = String(arg("company", "") || "").trim().toUpperCase();
  const warehouse = String(arg("warehouse", "") || "").trim().toUpperCase();
  const article = String(arg("article", "") || "").trim().toUpperCase();
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) {
    console.error("No MONGODB_URI/MONGO_URI");
    process.exit(2);
  }
  await mongoose.connect(uri);

  const filter = {};
  let company = null;
  if (companyCode) {
    company = await Company.findOne({
      $or: [{ code: companyCode }, { companyCode }],
    })
      .select("_id code companyCode")
      .lean();
    if (!company) {
      console.error(`Company ${companyCode} not found`);
      process.exit(2);
    }
    filter.companyId = company._id;
  }
  if (warehouse) {
    filter.$or = [{ warehouse }, { location: warehouse }];
  }
  if (article) {
    filter.article = article;
  }

  const rows = await StockBalance.find(filter).lean();
  const mismatches = [];
  for (const b of rows) {
    const derived = deriveAvailableQty(b);
    const stored = b.availableQty != null ? Number(b.availableQty) || 0 : derived;
    const diff = stored - derived;
    if (Math.abs(diff) > EPS) {
      mismatches.push({
        companyId: String(b.companyId || ""),
        companyCode: company?.code || company?.companyCode || "",
        warehouse: b.warehouse || b.location || "",
        location: b.location || "",
        article: b.article || b.itemCode || "",
        onHandQty: Number(b.onHandQty ?? b.quantity) || 0,
        quantity: Number(b.quantity) || 0,
        reservedQty: Number(b.reservedQty) || 0,
        allocatedQty: Number(b.allocatedQty) || 0,
        packedQty: Number(b.packedQty) || 0,
        storedAvailableQty: b.availableQty != null ? Number(b.availableQty) || 0 : null,
        derivedAvailableQty: derived,
        difference: diff,
        updatedAt: b.updatedAt || null,
        stockBalanceId: String(b._id),
      });
    }
  }

  const summary = {
    scanned: rows.length,
    mismatchCount: mismatches.length,
    companyCode: companyCode || "(all)",
    warehouse: warehouse || "(all)",
    article: article || "(all)",
    generatedAt: new Date().toISOString(),
  };

  console.log("=== AVAILABLE QTY MISMATCH DIAGNOSTIC (read-only) ===");
  console.log(JSON.stringify(summary, null, 2));
  console.log("\n=== MISMATCHES ===");
  console.log(JSON.stringify(mismatches, null, 2));

  const evidenceDir = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "repair-evidence");
  try {
    fs.mkdirSync(evidenceDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const outPath = path.join(
      evidenceDir,
      `available-qty-mismatch-diagnostic-${companyCode || "ALL"}-${stamp}.json`,
    );
    fs.writeFileSync(outPath, JSON.stringify({ summary, mismatches }, null, 2));
    console.log(`\nWrote evidence: ${outPath}`);
  } catch (e) {
    console.log(`\n(evidence write skipped: ${e.message})`);
  }

  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
