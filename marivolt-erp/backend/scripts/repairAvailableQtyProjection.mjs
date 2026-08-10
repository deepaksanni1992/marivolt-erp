/**
 * Repair ONLY stored availableQty projection mismatches.
 * Does NOT touch onHand / reserved / allocated / packed / ledger / allocations.
 *
 * Dry-run (default):
 *   node scripts/repairAvailableQtyProjection.mjs --company=MAR
 *   node scripts/repairAvailableQtyProjection.mjs --company=MAR --article=8X0098
 *
 * Apply (explicit):
 *   node scripts/repairAvailableQtyProjection.mjs --company=MAR --article=8X0098 --apply
 *
 * DO NOT run --apply against production without separate approval.
 */
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import mongoose from "mongoose";
import Company from "../src/models/Company.js";
import StockBalance from "../src/models/StockBalance.js";
import AuditLog from "../src/models/AuditLog.js";
import { deriveAvailableQty } from "../src/services/stockExpectedBuckets.js";

const EPS = 1e-6;

function arg(name, fallback = "") {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3);
  if (process.argv.includes(`--${name}`)) return true;
  return fallback;
}

function scriptsDir() {
  return path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
}

async function main() {
  const companyCode = String(arg("company", "") || "").trim().toUpperCase();
  const warehouse = String(arg("warehouse", "") || "").trim().toUpperCase();
  const article = String(arg("article", "") || "").trim().toUpperCase();
  const apply = Boolean(arg("apply", false));

  if (!companyCode) {
    console.error("--company=CODE is required");
    process.exit(2);
  }

  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) {
    console.error("No MONGODB_URI/MONGO_URI");
    process.exit(2);
  }
  await mongoose.connect(uri);

  const company = await Company.findOne({
    $or: [{ code: companyCode }, { companyCode }],
  })
    .select("_id code companyCode")
    .lean();
  if (!company) {
    console.error(`Company ${companyCode} not found`);
    process.exit(2);
  }

  const filter = { companyId: company._id };
  if (warehouse) filter.$or = [{ warehouse }, { location: warehouse }];
  if (article) filter.article = article;

  const rows = await StockBalance.find(filter);
  const plan = [];
  for (const doc of rows) {
    const derived = deriveAvailableQty(doc);
    const stored = doc.availableQty != null ? Number(doc.availableQty) || 0 : derived;
    if (Math.abs(stored - derived) <= EPS) continue;
    plan.push({
      stockBalanceId: String(doc._id),
      article: doc.article || doc.itemCode,
      warehouse: doc.warehouse || doc.location,
      onHandQty: Number(doc.onHandQty ?? doc.quantity) || 0,
      reservedQty: Number(doc.reservedQty) || 0,
      allocatedQty: Number(doc.allocatedQty) || 0,
      packedQty: Number(doc.packedQty) || 0,
      fromAvailableQty: stored,
      toAvailableQty: derived,
      difference: stored - derived,
    });
  }

  const summary = {
    mode: apply ? "APPLY" : "DRY_RUN",
    companyCode,
    warehouse: warehouse || "(all)",
    article: article || "(all)",
    scanned: rows.length,
    repairCount: plan.length,
    generatedAt: new Date().toISOString(),
  };

  console.log("=== AVAILABLE QTY PROJECTION REPAIR ===");
  console.log(JSON.stringify(summary, null, 2));
  console.log("\n=== PLAN ===");
  console.log(JSON.stringify(plan, null, 2));

  const evidenceDir = path.join(scriptsDir(), "repair-evidence");
  fs.mkdirSync(evidenceDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const evidencePath = path.join(
    evidenceDir,
    `available-qty-projection-repair-${companyCode}-${apply ? "apply" : "dry"}-${stamp}.json`,
  );

  if (!apply) {
    fs.writeFileSync(evidencePath, JSON.stringify({ summary, plan, applied: [] }, null, 2));
    console.log(`\nDRY-RUN only. Evidence: ${evidencePath}`);
    console.log("Re-run with --apply after explicit approval to persist.");
    await mongoose.disconnect();
    return;
  }

  const applied = [];
  for (const item of plan) {
    const doc = await StockBalance.findOne({ _id: item.stockBalanceId, companyId: company._id });
    if (!doc) continue;
    const derived = deriveAvailableQty(doc);
    const before = doc.availableQty != null ? Number(doc.availableQty) || 0 : derived;
    if (Math.abs(before - derived) <= EPS) {
      applied.push({ ...item, skipped: true, reason: "already matching" });
      continue;
    }
    // Touch ONLY availableQty
    doc.availableQty = derived;
    await doc.save();
    await AuditLog.create({
      companyId: company._id,
      userEmail: "repairAvailableQtyProjection.mjs",
      userName: "SYSTEM_REPAIR",
      action: "AVAILABLE_QTY_PROJECTION_REPAIRED",
      module: "STOCK",
      entityType: "StockBalance",
      entityId: doc._id,
      documentNo: doc.article || doc.itemCode,
      description: `Repaired availableQty projection ${before} → ${derived} for ${doc.article} / ${doc.warehouse || doc.location}`,
      beforeData: {
        onHandQty: doc.onHandQty,
        reservedQty: doc.reservedQty,
        allocatedQty: doc.allocatedQty,
        packedQty: doc.packedQty,
        availableQty: before,
      },
      afterData: {
        onHandQty: doc.onHandQty,
        reservedQty: doc.reservedQty,
        allocatedQty: doc.allocatedQty,
        packedQty: doc.packedQty,
        availableQty: derived,
      },
    });
    applied.push({ ...item, skipped: false, appliedAvailableQty: derived });
  }

  fs.writeFileSync(evidencePath, JSON.stringify({ summary, plan, applied }, null, 2));
  console.log(`\nAPPLY complete. Evidence: ${evidencePath}`);
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
