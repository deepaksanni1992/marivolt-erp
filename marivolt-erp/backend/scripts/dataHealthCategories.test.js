/**
 * Data Health category / scoring acceptance tests (no DB).
 * Run: node scripts/dataHealthCategories.test.js
 */
import assert from "assert";
import {
  OPERATIONAL_ISSUE_TYPES,
  PROCUREMENT_QUEUE_TYPES,
  classifyIssueCategory,
  enrichIssue,
  isOperationalIssueType,
  isProcurementQueueType,
  ISSUE_CATEGORIES,
  computeHealthScore,
  healthRating,
  parseAgingDays,
  buildIssueId,
  agingBandFromDays,
  INTEGRITY_SCORE_WEIGHTS,
} from "../src/services/dataHealthService.js";

let passed = 0;
function ok(name, cond) {
  assert.ok(cond, name);
  passed += 1;
  console.log("✓", name);
}

// --- Category matrix ---
ok("OA without allocation is operational", isOperationalIssueType("OA_WITHOUT_ALLOCATION"));
ok("Allocation without packing is operational", isOperationalIssueType("ALLOCATION_WITHOUT_PACKING"));
ok("Invoice without dispatch is operational", isOperationalIssueType("INVOICE_WITHOUT_DISPATCH"));
ok("PO awaiting GRN is operational", isOperationalIssueType("PO_AWAITING_GRN"));
ok("PI awaiting payment is operational", isOperationalIssueType("PI_AWAITING_PAYMENT"));
ok("Packing without invoice is operational", isOperationalIssueType("PACKING_WITHOUT_INVOICE"));
ok("Packing without dispatch is operational", isOperationalIssueType("PACKING_WITHOUT_DISPATCH"));
ok("Stock bucket integrity is NOT operational", !isOperationalIssueType("STOCK_BUCKET_INTEGRITY"));

// Allocate-before-purchase / negative available — operational, not integrity
for (const t of [
  "NEGATIVE_INVENTORY",
  "ALLOCATED_EXCEEDS_AVAILABLE",
  "ALLOCATED_EXCEEDS_ONHAND",
  "AVAILABLE_BELOW_ZERO",
  "OUT_OF_STOCK_FOR_ALLOCATION",
  "BACKORDER_REQUIRED",
  "WAITING_PURCHASE_AFTER_ALLOCATION",
]) {
  ok(`${t} is operational`, classifyIssueCategory(t) === ISSUE_CATEGORIES.OPERATIONAL);
  ok(`${t} is procurement queue`, isProcurementQueueType(t));
}

ok(
  "NEGATIVE_PHYSICAL_ON_HAND remains integrity",
  classifyIssueCategory("NEGATIVE_PHYSICAL_ON_HAND") === ISSUE_CATEGORIES.INTEGRITY
);
ok(
  "Dispatch without invoice is integrity (SI required by Store dispatch)",
  classifyIssueCategory("DISPATCH_WITHOUT_INVOICE") === ISSUE_CATEGORIES.INTEGRITY
);
ok(
  "GRN without PO is integrity (Store GRN is PO-line based)",
  classifyIssueCategory("GRN_WITHOUT_PO") === ISSUE_CATEGORIES.INTEGRITY
);
ok("GRN exceeds PO is integrity", classifyIssueCategory("GRN_EXCEEDS_PO") === ISSUE_CATEGORIES.INTEGRITY);
ok("Customs mismatch is integrity", classifyIssueCategory("ERP_CUSTOMS_STOCK_MISMATCH") === ISSUE_CATEGORIES.INTEGRITY);

// --- Enrich ---
const enriched = enrichIssue(
  {
    issueType: "OA_WITHOUT_ALLOCATION",
    severity: "Critical",
    description: "raw",
    documentNumber: "OA-1",
    date: new Date(Date.UTC(2020, 0, 1)),
  },
  { companyCode: "MAR", now: new Date(Date.UTC(2020, 0, 21)) }
);
ok("enrich forces Info severity for operational", enriched.severity === "Info");
ok("enrich sets OPERATIONAL category/section", enriched.category === ISSUE_CATEGORIES.OPERATIONAL && enriched.section === "OPERATIONAL");
ok("enrich adds pending label", /awaiting Allocation/i.test(enriched.pendingLabel || ""));
ok("enrich marks aging when old enough", enriched.isAging === true);
ok("enrich has stable issueId", Boolean(enriched.issueId));
ok("enrich aging band 7+ for 20 days", enriched.agingBand === "7+");

const waiting = enrichIssue(
  {
    issueType: "WAITING_PURCHASE_AFTER_ALLOCATION",
    severity: "Critical",
    description: "On hand 0, allocated 9, available -9",
    documentNumber: "8X0098",
    date: new Date(Date.UTC(2020, 0, 1)),
  },
  { companyCode: "MAR", now: new Date(Date.UTC(2020, 4, 1)) }
);
ok("waiting purchase forced to Info", waiting.severity === "Info");
ok("waiting purchase operational", waiting.category === ISSUE_CATEGORIES.OPERATIONAL);
ok("waiting purchase procurement group", waiting.operationalGroup === "PROCUREMENT");
ok("waiting purchase follow-up action", /Purchasing/i.test(waiting.suggestedAction || ""));
ok("waiting purchase aging band 90+", waiting.agingBand === "90+");

const integrity = enrichIssue({
  issueType: "STOCK_BUCKET_INTEGRITY",
  severity: "Critical",
  description: "orphan",
  documentNumber: "8X0098",
  date: new Date(),
});
ok("integrity keeps Critical severity", integrity.severity === "Critical");
ok("integrity category INTEGRITY", integrity.category === ISSUE_CATEGORIES.INTEGRITY);

const physicalNeg = enrichIssue({
  issueType: "NEGATIVE_PHYSICAL_ON_HAND",
  severity: "Critical",
  documentNumber: "ART-NEG",
  date: new Date(),
});
ok("physical negative stays Critical", physicalNeg.severity === "Critical");
ok("physical negative integrity", physicalNeg.category === ISSUE_CATEGORIES.INTEGRITY);

// --- Score: 100 OAs pending, zero integrity → 100 ---
const manyOa = Array.from({ length: 100 }, (_, i) =>
  enrichIssue({
    issueType: "OA_WITHOUT_ALLOCATION",
    severity: "Major",
    documentNumber: `OA-${i}`,
    date: new Date(),
  })
);
const scoreOa = computeHealthScore(manyOa);
ok("100 OAs without allocation → Health Score 100", scoreOa.healthScore === 100);
ok("100 OAs → zero integrity penalties", scoreOa.scoreBreakdown.penaltyPoints === 0);

const allocPending = enrichIssue({
  issueType: "ALLOCATION_WITHOUT_PACKING",
  severity: "Major",
  documentNumber: "ALLOC-1",
  date: new Date(),
});
ok("allocation without packing → no score penalty", computeHealthScore([allocPending]).healthScore === 100);

const poPending = enrichIssue({
  issueType: "PO_AWAITING_GRN",
  severity: "Minor",
  documentNumber: "PO-1",
  date: new Date(),
});
ok("PO without GRN → no score penalty", computeHealthScore([poPending]).healthScore === 100);

const piPending = enrichIssue({
  issueType: "PI_AWAITING_PAYMENT",
  severity: "Minor",
  documentNumber: "PI-1",
  date: new Date(),
});
ok("PI without payment → no score penalty", computeHealthScore([piPending]).healthScore === 100);

// Example: On Hand 0 / Allocated 9 / Available -9 → score unchanged
const coverShortfall = [
  enrichIssue({
    issueType: "WAITING_PURCHASE_AFTER_ALLOCATION",
    severity: "Critical",
    documentNumber: "ART-1",
    date: new Date(),
  }),
  enrichIssue({
    issueType: "NEGATIVE_INVENTORY",
    severity: "Critical",
    documentNumber: "ART-1B",
    date: new Date(),
  }),
  enrichIssue({
    issueType: "ALLOCATED_EXCEEDS_AVAILABLE",
    severity: "Critical",
    documentNumber: "ART-1C",
    date: new Date(),
  }),
  enrichIssue({
    issueType: "AVAILABLE_BELOW_ZERO",
    severity: "Critical",
    documentNumber: "ART-1D",
    date: new Date(),
  }),
];
ok(
  "allocate-before-purchase cover shortfall → Health Score 100",
  computeHealthScore(coverShortfall).healthScore === 100
);
ok(
  "cover shortfall → zero integrity penalties",
  computeHealthScore(coverShortfall).scoreBreakdown.penaltyPoints === 0
);

const orphan = enrichIssue({
  issueType: "STOCK_BUCKET_INTEGRITY",
  severity: "Critical",
  documentNumber: "8X0098",
  date: new Date(),
});
const orphanScore = computeHealthScore([orphan]);
ok(
  "orphaned reservation critical → score 85 (100-15)",
  orphanScore.healthScore === 100 - INTEGRITY_SCORE_WEIGHTS.Critical
);

const ledger = enrichIssue({
  issueType: "ON_HAND_LEDGER_MISMATCH",
  severity: "Critical",
  documentNumber: "ART-1",
  date: new Date(),
});
ok("ledger mismatch critical → penalty 15", computeHealthScore([ledger]).healthScore === 85);

const customs = enrichIssue({
  issueType: "ERP_CUSTOMS_STOCK_MISMATCH",
  severity: "Critical",
  documentNumber: "ART-C",
  date: new Date(),
});
ok("customs mismatch → integrity penalty", computeHealthScore([customs]).healthScore === 85);

ok(
  "physical negative on hand → integrity penalty",
  computeHealthScore([physicalNeg]).healthScore === 85
);

// Mixed: many operational + one critical integrity
const mixed = computeHealthScore([...manyOa, ...coverShortfall, orphan]);
ok("mixed pending + cover shortfall + one critical → still 85", mixed.healthScore === 85);

// Dedup same issueId
const dup = computeHealthScore([orphan, { ...orphan }]);
ok("duplicate integrity issueId does not double-penalize", dup.healthScore === 85);

ok("rating Healthy for 100", healthRating(100) === "Healthy");
ok("rating Attention for 80", healthRating(80) === "Attention");
ok("rating Poor for 60", healthRating(60) === "Poor");
ok("rating Critical for 40", healthRating(40) === "Critical");

ok("parseAgingDays default 7", parseAgingDays(undefined) === 7);
ok("parseAgingDays invalid → 7", parseAgingDays("nope") === 7);
ok("parseAgingDays zero → 7", parseAgingDays("0") === 7);
ok("parseAgingDays negative → 7", parseAgingDays("-3") === 7);
ok("parseAgingDays 14", parseAgingDays("14") === 14);
ok("parseAgingDays clamps high", parseAgingDays("9999") === 365);

ok("agingBand 0-6", agingBandFromDays(3) === "0-6");
ok("agingBand 7+", agingBandFromDays(7) === "7+");
ok("agingBand 30+", agingBandFromDays(30) === "30+");
ok("agingBand 90+", agingBandFromDays(90) === "90+");
ok("agingBand null", agingBandFromDays(null) === null);

ok(
  "buildIssueId stable",
  buildIssueId({ companyCode: "MAR", issueType: "OA_WITHOUT_ALLOCATION", documentNumber: "OA-1" }) ===
    buildIssueId({ companyCode: "mar", issueType: "oa_without_allocation", documentNumber: "oa-1" })
);

ok("operational set includes packing without dispatch", OPERATIONAL_ISSUE_TYPES.has("PACKING_WITHOUT_DISPATCH"));
ok("procurement set includes waiting purchase", PROCUREMENT_QUEUE_TYPES.has("WAITING_PURCHASE_AFTER_ALLOCATION"));

console.log(`\n${passed} checks passed`);
