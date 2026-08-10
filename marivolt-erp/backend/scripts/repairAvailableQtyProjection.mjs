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
 *
 * If AuditLog fails after StockBalance mutation, the script reports
 * APPLIED_AUDIT_FAILED clearly and does NOT retry the mutation.
 */
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import mongoose from "mongoose";
import Company from "../src/models/Company.js";
import StockBalance from "../src/models/StockBalance.js";
import AuditLog from "../src/models/AuditLog.js";
import {
  EVIDENCE_STATUS,
  buildAvailableQtyMismatchPlan,
  applyAvailableQtyProjectionRepair,
} from "../src/services/repairAvailableQtyProjectionService.js";

function arg(name, fallback = "") {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3);
  if (process.argv.includes(`--${name}`)) return true;
  return fallback;
}

function scriptsDir() {
  return path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
}

function writeEvidence(evidencePath, payload) {
  fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
  fs.writeFileSync(evidencePath, JSON.stringify(payload, null, 2));
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

  const evidenceDir = path.join(scriptsDir(), "repair-evidence");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const evidencePath = path.join(
    evidenceDir,
    `available-qty-projection-repair-${companyCode}-${apply ? "apply" : "dry"}-${stamp}.json`,
  );

  let exitCode = 0;
  try {
    const company = await Company.findOne({
      $or: [{ code: companyCode }, { companyCode }],
    })
      .select("_id code companyCode")
      .lean();
    if (!company) {
      writeEvidence(evidencePath, {
        status: EVIDENCE_STATUS.FAILED_BEFORE_APPLY,
        summary: { companyCode, mode: apply ? "APPLY" : "DRY_RUN" },
        error: `Company ${companyCode} not found`,
      });
      console.error(`Company ${companyCode} not found`);
      exitCode = 2;
      return;
    }

    const filter = { companyId: company._id };
    if (warehouse) filter.$or = [{ warehouse }, { location: warehouse }];
    if (article) filter.article = article;

    const rows = await StockBalance.find(filter);
    const plan = buildAvailableQtyMismatchPlan(rows);

    const summary = {
      mode: apply ? "APPLY" : "DRY_RUN",
      status: apply
        ? plan.length
          ? EVIDENCE_STATUS.APPLY_STARTED
          : EVIDENCE_STATUS.NO_CHANGE
        : EVIDENCE_STATUS.DRY_RUN,
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

    // Pre-apply / dry-run evidence first (mutation status unambiguous later)
    writeEvidence(evidencePath, {
      status: summary.status,
      summary,
      plan,
      results: [],
    });

    if (!apply) {
      console.log(`\nDRY-RUN only. Evidence: ${evidencePath}`);
      console.log("Re-run with --apply after explicit approval to persist.");
      return;
    }

    if (!plan.length) {
      writeEvidence(evidencePath, {
        status: EVIDENCE_STATUS.NO_CHANGE,
        summary: { ...summary, status: EVIDENCE_STATUS.NO_CHANGE },
        plan,
        results: [],
        message: "No mismatches — 0 StockBalance mutations, 0 repair AuditLogs",
      });
      console.log("\nNO_CHANGE — 0 repairs required. Evidence:", evidencePath);
      return;
    }

    const results = [];
    let anyAuditFailed = false;
    let anyFailedBefore = false;

    for (const item of plan) {
      const doc = await StockBalance.findOne({ _id: item.stockBalanceId, companyId: company._id });
      const result = await applyAvailableQtyProjectionRepair({
        doc,
        companyId: company._id,
        writeAuditLog: async (payload) => AuditLog.create(payload),
        tool: "repairAvailableQtyProjection.mjs",
      });
      results.push({ ...item, ...result });

      if (result.status === EVIDENCE_STATUS.APPLIED_AUDIT_FAILED) {
        anyAuditFailed = true;
        console.error("\n!!! STOCK REPAIR APPLIED SUCCESSFULLY");
        console.error("!!! AUDIT LOG WRITE FAILED");
        console.error(
          JSON.stringify(
            {
              stockBalanceId: result.stockBalanceId,
              article: result.article,
              warehouse: result.warehouse,
              beforeAvailableQty: result.before?.availableQty,
              afterAvailableQty: result.after?.availableQty,
              error: result.error,
              timestamp: result.timestamp || new Date().toISOString(),
            },
            null,
            2,
          ),
        );
        console.error("Do NOT retry StockBalance mutation for this document.");
      } else if (result.status === EVIDENCE_STATUS.FAILED_BEFORE_APPLY) {
        anyFailedBefore = true;
        console.error("\nFAILED_BEFORE_APPLY:", result.message, result.error || "");
      } else if (result.status === EVIDENCE_STATUS.APPLIED) {
        console.log(
          `APPLIED ${result.article} / ${result.warehouse}: availableQty ${result.before.availableQty} → ${result.after.availableQty}`,
        );
      } else if (result.status === EVIDENCE_STATUS.NO_CHANGE) {
        console.log(`NO_CHANGE ${result.article || item.article} (idempotent skip)`);
      }
    }

    const finalStatus = anyFailedBefore
      ? EVIDENCE_STATUS.FAILED_BEFORE_APPLY
      : anyAuditFailed
        ? EVIDENCE_STATUS.APPLIED_AUDIT_FAILED
        : results.every((r) => r.status === EVIDENCE_STATUS.NO_CHANGE)
          ? EVIDENCE_STATUS.NO_CHANGE
          : EVIDENCE_STATUS.APPLIED;

    writeEvidence(evidencePath, {
      status: finalStatus,
      summary: { ...summary, status: finalStatus, completedAt: new Date().toISOString() },
      plan,
      results,
    });

    console.log(`\nFinal status: ${finalStatus}`);
    console.log(`Evidence: ${evidencePath}`);

    if (anyAuditFailed) exitCode = 3; // mutation may have succeeded — non-zero for operator attention
    if (anyFailedBefore && !results.some((r) => r.mutated)) exitCode = 2;
  } catch (err) {
    writeEvidence(evidencePath, {
      status: EVIDENCE_STATUS.FAILED_BEFORE_APPLY,
      error: err?.message || String(err),
      stack: err?.stack,
      at: new Date().toISOString(),
    });
    console.error(err);
    exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
  process.exit(exitCode);
}

main();
