import "../src/loadEnv.js";
import mongoose from "mongoose";
import { previewBucketIntegrityRepair } from "../src/services/stockBucketIntegrityService.js";
import { diagnoseOrphanedStockBuckets } from "../src/services/stockBucketReconcileService.js";
import Company from "../src/models/Company.js";

await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 20000 });
const mar = await Company.findOne({ code: "MAR" }).lean();

console.log("=== Dry-run diagnose 8X0098 ===");
console.log(
  JSON.stringify(
    await diagnoseOrphanedStockBuckets({
      companyId: mar._id,
      article: "8X0098",
      warehouse: "MAIN",
    }),
    null,
    2
  )
);

console.log("\n=== Preview (MAR three articles) ===");
const p = await previewBucketIntegrityRepair({
  companyCode: "MAR",
  articles: ["8X0098", "85509", "700004.28"],
  mismatchTypes: ["ORPHANED_RESERVED", "ORPHANED_PACKED", "STORED_AVAILABLE_MISMATCH", "GHOST_ALLOCATION_EFFECT"],
  reason: "Acceptance dry-run preview for three MAR candidates — do not apply",
});
console.log(
  JSON.stringify(
    {
      applyEnabled: p.applyEnabled,
      applyBlockedReason: p.applyBlockedReason,
      candidateCount: p.candidateCount,
      candidates: p.candidates.map((c) => ({
        article: c.article,
        types: c.mismatchTypes,
        before: c.before,
        after: c.proposedAfter,
        fields: c.fieldsThatWouldChange,
        ghost: c.ghostAllocationLedgerRefs,
        safety: c.safetyDecision,
      })),
    },
    null,
    2
  )
);

console.log("\nCONFIRMATION: no repair applied.");
await mongoose.disconnect();
