/**
 * Analytics / Data Health derived-availability regressions (no DB).
 * Run: node scripts/analyticsDerivedAvailability.test.js
 */
import assert from "assert";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  deriveAvailableQty,
  deriveStockBuckets,
  buildDerivedAvailableExpression,
  buildDerivedAvailableNegativeMatch,
} from "../src/services/stockExpectedBuckets.js";
import {
  buildIssuesFromSnapshot,
  RESERVATION_INTEGRITY_ISSUE_TYPES,
} from "../src/services/reservationIntegrityService.js";
import {
  classifyIssueCategory,
  enrichIssue,
  computeHealthScore,
  ISSUE_CATEGORIES,
  INTEGRITY_SCORE_WEIGHTS,
} from "../src/services/dataHealthService.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.join(__dirname, "..");

function read(rel) {
  return fs.readFileSync(path.join(backendRoot, rel), "utf8");
}

let passed = 0;
function ok(name, cond) {
  assert.ok(cond, name);
  passed += 1;
  console.log("✓", name);
}

/** Minimal evaluator for the subset of Mongo expr used by buildDerivedAvailableExpression. */
function evalExpr(node, doc) {
  if (node == null) return null;
  if (typeof node === "number" || typeof node === "boolean") return node;
  if (typeof node === "string") {
    if (node.startsWith("$")) {
      const key = node.slice(1);
      return Object.prototype.hasOwnProperty.call(doc, key) ? doc[key] : undefined;
    }
    return node;
  }
  if (Array.isArray(node)) return node.map((x) => evalExpr(x, doc));
  if (typeof node === "object") {
    if ("$ifNull" in node) {
      const [a, b] = node.$ifNull;
      const va = evalExpr(a, doc);
      return va == null ? evalExpr(b, doc) : va;
    }
    if ("$max" in node) {
      const vals = (node.$max || []).map((x) => evalExpr(x, doc)).map((v) => Number(v) || 0);
      return Math.max(...vals);
    }
    if ("$add" in node) {
      return (node.$add || []).map((x) => evalExpr(x, doc)).reduce((s, v) => s + (Number(v) || 0), 0);
    }
    if ("$subtract" in node) {
      const [a, b] = node.$subtract;
      return (Number(evalExpr(a, doc)) || 0) - (Number(evalExpr(b, doc)) || 0);
    }
    if ("$lt" in node) {
      const [a, b] = node.$lt;
      return (Number(evalExpr(a, doc)) || 0) < (Number(evalExpr(b, doc)) || 0);
    }
    if ("$expr" in node) return evalExpr(node.$expr, doc);
  }
  throw new Error(`Unsupported expr: ${JSON.stringify(node)}`);
}

/** Analytics classification: count negative only from derived free stock (never stored). */
function analyticsCountsNegative(row) {
  return deriveAvailableQty(row) < 0;
}

// ---------------------------------------------------------------------------
// 1–2 Stale stored projection must not drive analytics negatives
// ---------------------------------------------------------------------------
{
  const falseNeg = {
    onHandQty: 10,
    allocatedQty: 5,
    reservedQty: 4,
    packedQty: 0,
    availableQty: -5, // stale
  };
  ok(
    "1. Stored -5 / derived +5 → not counted as negative available",
    deriveAvailableQty(falseNeg) === 5 && !analyticsCountsNegative(falseNeg)
  );

  const falsePos = {
    onHandQty: 2,
    allocatedQty: 4,
    reservedQty: 3,
    packedQty: 3,
    availableQty: 5, // stale healthy
  };
  ok(
    "2. Stored +5 / derived -5 → counted as negative available",
    deriveAvailableQty(falsePos) === -5 && analyticsCountsNegative(falsePos)
  );
}

// ---------------------------------------------------------------------------
// 3–5 max(allocated, reserved) and packed
// ---------------------------------------------------------------------------
ok(
  "3. reservedQty > allocatedQty → use reserved",
  deriveAvailableQty({ onHandQty: 20, allocatedQty: 2, reservedQty: 7, packedQty: 1 }) === 12
);
ok(
  "4. allocatedQty > reservedQty → use allocated",
  deriveAvailableQty({ onHandQty: 20, allocatedQty: 8, reservedQty: 3, packedQty: 1 }) === 11
);
ok(
  "5. packedQty reduces availability",
  deriveAvailableQty({ onHandQty: 20, allocatedQty: 5, reservedQty: 5, packedQty: 4 }) === 11
);

// ---------------------------------------------------------------------------
// 6–7 nulls and unclamped negatives
// ---------------------------------------------------------------------------
ok("6a. null buckets → 0", deriveAvailableQty({ onHandQty: null, allocatedQty: null }) === 0);
ok(
  "6b. missing buckets → onHand only",
  deriveAvailableQty({ onHandQty: 4 }) === 4
);
ok(
  "6c. quantity fallback when onHand missing",
  deriveAvailableQty({ quantity: 9, reservedQty: 2, packedQty: 1 }) === 6
);
ok(
  "7. negative derived remains negative (no clamp)",
  deriveAvailableQty({ onHandQty: 1, reservedQty: 5, packedQty: 2 }) === -6
);

// ---------------------------------------------------------------------------
// 8–9 Company / warehouse scope (source contract)
// ---------------------------------------------------------------------------
{
  const analytics = read("src/controllers/analyticsController.js");
  ok(
    "8. Analytics uses findNegativeDerivedBalances / derived expression",
    /findNegativeDerivedBalances/.test(analytics) &&
      /buildDerivedAvailableExpression/.test(analytics) &&
      !/availableQty:\s*\{\s*\$lt:\s*0\s*\}/.test(analytics)
  );
  ok(
    "8b. inventoryAnalytics applies companyMatch + optional warehouse",
    /companyMatch\(f\.companyId\)/.test(analytics) &&
      /if \(f\.warehouse\) match\.warehouse = f\.warehouse/.test(analytics)
  );
  ok(
    "9. Drilldown negative-stock uses same derived helper",
    /negative-stock/.test(analytics) &&
      analytics.includes("findNegativeDerivedBalances(q")
  );
  ok(
    "9b. Response contract keeps availableQty field name",
    /availableQty:\s*"\$derivedAvailableQty"/.test(analytics) ||
      /availableQty:\s*x\.availableQty/.test(analytics)
  );
}

// ---------------------------------------------------------------------------
// 10 Projection drift vs operational negative — no duplicate Health penalty
// ---------------------------------------------------------------------------
{
  const healthSrc = read("src/services/dataHealthService.js");
  ok(
    "10a. Data Health negative scan uses buildDerivedAvailableExpression",
    /available:\s*buildDerivedAvailableExpression\(\)/.test(healthSrc)
  );
  ok(
    "10b. Data Health operational available is derived-only (not $ifNull stored)",
    /available:\s*buildDerivedAvailableExpression\(\)/.test(healthSrc) &&
      !/available:\s*\{\s*\$ifNull:\s*\[\s*"\$availableQty"/.test(healthSrc)
  );
  ok(
    "10c. STORED_AVAILABLE_MISMATCH excluded from Health bucket emit (no duplicate)",
    /MISMATCH_TYPES\.STORED_AVAILABLE_MISMATCH/.test(healthSrc)
  );

  // Stale stored projection, healthy derived, buckets match docs → drift only
  const driftOnly = buildIssuesFromSnapshot({
    companyId: "c1",
    warehouse: "MAIN",
    article: "ART-DRIFT",
    stockBalanceId: "b1",
    onHandQty: 10,
    balance: {
      allocatedQty: 0,
      reservedQty: 0,
      packedQty: 0,
      availableQty: 9, // off by 1 → Minor
    },
    expectedReservedQty: 0,
    expectedPackedQty: 0,
    expectedAvailableQty: 10,
    allocationDocuments: [],
    packingDocuments: [],
  });
  ok(
    "10d. Projection drift → AVAILABLE_QTY_MISMATCH only",
    driftOnly.length === 1 &&
      driftOnly[0].issueType === RESERVATION_INTEGRITY_ISSUE_TYPES.AVAILABLE_QTY_MISMATCH
  );
  ok(
    "10e. AVAILABLE_QTY_MISMATCH is integrity (not operational negative)",
    classifyIssueCategory("AVAILABLE_QTY_MISMATCH") === ISSUE_CATEGORIES.INTEGRITY
  );

  const driftEnriched = enrichIssue({
    ...driftOnly[0],
    documentNumber: "ART-DRIFT",
    date: new Date(),
  });
  const belowZeroOp = enrichIssue({
    issueType: "AVAILABLE_BELOW_ZERO",
    severity: "Critical",
    documentNumber: "ART-DRIFT",
    date: new Date(),
  });
  // Drift alone: one Minor integrity hit. Operational below-zero would not score.
  const driftScore = computeHealthScore([driftEnriched]);
  const bothScore = computeHealthScore([driftEnriched, belowZeroOp]);
  ok(
    "10f. Drift scores as integrity once; operational below-zero adds no extra penalty",
    driftEnriched.severity === "Minor" &&
      driftScore.healthScore === 100 - INTEGRITY_SCORE_WEIGHTS.Minor &&
      bothScore.healthScore === driftScore.healthScore
  );

  // True derived negative must still be detectable for analytics/ops (formula)
  ok(
    "10g. Healthy stored cannot hide negative derived",
    analyticsCountsNegative({
      onHandQty: 1,
      reservedQty: 4,
      packedQty: 0,
      availableQty: 99,
    })
  );
  ok(
    "10h. Stale stored negative does not imply analytics negative when derived healthy",
    !analyticsCountsNegative({
      onHandQty: 10,
      reservedQty: 0,
      packedQty: 0,
      availableQty: -1,
    })
  );
}

// ---------------------------------------------------------------------------
// 11 Analytics response contract unchanged (shape)
// ---------------------------------------------------------------------------
{
  const analytics = read("src/controllers/analyticsController.js");
  ok(
    "11. negativeStockItems maps article/warehouse/availableQty",
    /negativeStockItems:\s*negativeItems\.map/.test(analytics) &&
      /article:\s*x\.article/.test(analytics) &&
      /availableQty:\s*x\.availableQty/.test(analytics)
  );
  ok(
    "11b. KPIs still expose negativeStockCount",
    /negativeStockCount:\s*negativeResult\.total/.test(analytics)
  );
}

// ---------------------------------------------------------------------------
// 12 Shared Mongo expression matches deriveAvailableQty
// ---------------------------------------------------------------------------
{
  const cases = [
    { onHandQty: 10, allocatedQty: 2, reservedQty: 5, packedQty: 1 },
    { onHandQty: 10, allocatedQty: 5, reservedQty: 2, packedQty: 1 },
    { onHandQty: 0, allocatedQty: 0, reservedQty: 0, packedQty: 0 },
    { onHandQty: 3, allocatedQty: null, reservedQty: null, packedQty: null },
    { quantity: 8, allocatedQty: 1, reservedQty: 0, packedQty: 2 },
    { onHandQty: 2, allocatedQty: 9, reservedQty: 9, packedQty: 0 },
    { onHandQty: 100, allocatedQty: 0, reservedQty: 0, packedQty: 40 },
  ];
  const expr = buildDerivedAvailableExpression();
  for (const c of cases) {
    const js = deriveAvailableQty(c);
    const mongo = evalExpr(expr, c);
    ok(`12. Mongo≡JS for ${JSON.stringify(c)} → ${js}`, mongo === js);
  }
  ok(
    "12b. buildDerivedAvailableNegativeMatch uses shared expression",
    evalExpr(buildDerivedAvailableNegativeMatch(0), {
      onHandQty: 1,
      reservedQty: 5,
      packedQty: 0,
    }) === true
  );
  ok(
    "12c. negative match false when derived healthy",
    evalExpr(buildDerivedAvailableNegativeMatch(0), {
      onHandQty: 10,
      reservedQty: 1,
      packedQty: 0,
      availableQty: -99,
    }) === false
  );
}

// ---------------------------------------------------------------------------
// deriveStockBuckets ignores stored; stock summary uses shared expr
// ---------------------------------------------------------------------------
{
  const b = deriveStockBuckets({
    onHandQty: 10,
    reservedQty: 1,
    allocatedQty: 1,
    packedQty: 2,
    availableQty: -50,
  });
  ok("deriveStockBuckets ignores stored availableQty", b.availableQty === 7);

  const stockCtrl = read("src/controllers/stockController.js");
  ok(
    "listStockSummary uses buildDerivedAvailableExpression",
    /buildDerivedAvailableExpression/.test(stockCtrl)
  );
}

console.log(`\n${passed} checks passed`);
