/**
 * ASN Phase 1 — quantity, status, numbering, RBAC, stock-safety.
 * Run: node scripts/asn.phase1.test.js
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ASN_SYSTEM_STATUSES,
  ALLOWED_ASN_TRANSITIONS,
  ASN_IMMUTABLE_PATCH_KEYS,
  AsnError,
  activeAsnQtyByPoLine,
  applyAsnQtyClaims,
  applyAsnQtyDeltas,
  applyCancelRelease,
  assertArticleMatchesPoLine,
  assertNoImmutableAsnPatch,
  assertQtyWithinAvailable,
  assertValidTransition,
  canUserSetAsnStatus,
  consolidateAsnLinePayload,
  lineQtyDeltas,
  mergeAsnLinesPreservingIds,
  remainingAsnQty,
  roundAsnQty,
  sameCompanyId,
  tryClaimAsnQtyInMemory,
  canRestoreAsnReservation,
  validatePoLinesAgainstActiveAsn,
} from "../src/utils/asnRules.js";
import { tryClaimLineQty } from "../src/utils/quantitySerialization.js";
import { formatAsnNumber, asnCounterKey, normalizeCompanyCode } from "../src/services/asnNumberService.js";
import {
  getDefaultPermissionsForRole,
  hasPermission,
} from "../src/services/roleService.js";
import { PERMISSION_MODULES } from "../src/models/Role.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.join(__dirname, "..");
const srcRoot = path.join(backendRoot, "src");
const feRoot = path.join(backendRoot, "..", "src");

let passed = 0;
let failed = 0;
function run(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed += 1;
    console.error(`  ✗ ${name}`);
    console.error(`    ${e.message}`);
  }
}

async function runAsync(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed += 1;
    console.error(`  ✗ ${name}`);
    console.error(`    ${e.message}`);
  }
}

console.log("\nASN Phase 1\n");

const lineA = "aaaaaaaaaaaaaaaaaaaaaaaa";
const poLines = [
  { _id: lineA, article: "915002722", qty: 100, orderedQty: 100, uom: "PCS" },
];

run("valid partial ASN remaining calculation", () => {
  const remaining = remainingAsnQty(100, 30);
  assert.equal(remaining, 70);
  const ok = assertQtyWithinAvailable({ article: "A", poQty: 100, alreadyActive: 0, requested: 30 });
  assert.equal(ok.requested, 30);
});

run("full quantity ASN is allowed", () => {
  assertQtyWithinAvailable({ article: "A", poQty: 100, alreadyActive: 0, requested: 100 });
});

run("multiple ASNs for one PO accumulate against remaining", () => {
  const asns = [
    { _id: "1", status: "DRAFT", lines: [{ poLineId: lineA, asnQty: 30 }] },
    { _id: "2", status: "SHIPPED", lines: [{ poLineId: lineA, asnQty: 40 }] },
  ];
  const claimed = activeAsnQtyByPoLine(asns);
  assert.equal(claimed.get(lineA), 70);
  assert.equal(remainingAsnQty(100, claimed.get(lineA)), 30);
});

run("reject ASN greater than remaining quantity", () => {
  assert.throws(
    () => assertQtyWithinAvailable({ article: "A", poQty: 100, alreadyActive: 70, requested: 40 }),
    (err) => err instanceof AsnError && err.code === "ASN_QTY_EXCEEDED" && err.status === 409
  );
});

run("receivedQty reduces remaining ASN entitlement (50 ordered, 43 received → 7)", () => {
  assert.equal(remainingAsnQty(50, 0, 43), 7);
  assertQtyWithinAvailable({ article: "20834", poQty: 50, alreadyActive: 0, requested: 7, receivedQty: 43 });
  assert.throws(
    () => assertQtyWithinAvailable({ article: "20834", poQty: 50, alreadyActive: 0, requested: 8, receivedQty: 43 }),
    (err) => err.code === "ASN_QTY_EXCEEDED"
  );
  assert.throws(
    () => assertQtyWithinAvailable({ article: "20834", poQty: 50, alreadyActive: 0, requested: 50, receivedQty: 43 }),
    (err) => err.code === "ASN_QTY_EXCEEDED"
  );
});

run("concurrent replacement ASN of 7: only one succeeds", () => {
  const line = { orderedQty: 50, receivedQty: 43, asnActiveQty: 0 };
  const a = tryClaimAsnQtyInMemory(line, 7);
  const b = tryClaimAsnQtyInMemory(a.line, 7);
  assert.equal(a.ok, true);
  assert.equal(b.ok, false);
  assert.equal(a.line.asnActiveQty, 7);
});

run("post-complete remaining: received 25 + active 20 → new ASN 55 ok / 56 blocked", () => {
  assert.equal(remainingAsnQty(100, 20, 25), 55);
  assertQtyWithinAvailable({ article: "A", poQty: 100, alreadyActive: 20, requested: 55, receivedQty: 25 });
  assert.throws(
    () => assertQtyWithinAvailable({ article: "A", poQty: 100, alreadyActive: 20, requested: 56, receivedQty: 25 }),
    (err) => err.code === "ASN_QTY_EXCEEDED"
  );
});

run("cancelled ASN quantity becomes available again", () => {
  const asns = [
    { _id: "1", status: "SHIPPED", lines: [{ poLineId: lineA, asnQty: 40 }] },
    { _id: "2", status: "CANCELLED", lines: [{ poLineId: lineA, asnQty: 30 }] },
  ];
  const claimed = activeAsnQtyByPoLine(asns);
  assert.equal(claimed.get(lineA), 40);
  assert.equal(remainingAsnQty(100, claimed.get(lineA) || 0), 60);
});

run("duplicate ASN lines for the same PO line are consolidated", () => {
  const lines = consolidateAsnLinePayload([
    { poLineId: lineA, asnQty: 10, article: "915002722" },
    { poLineId: lineA, asnQty: 5, article: "915002722" },
  ]);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].asnQty, 15);
});

run("company isolation compares company ids as strings", () => {
  assert.equal(sameCompanyId("abc", "abc"), true);
  assert.equal(sameCompanyId("mar", "oke"), false);
});

run("reject mismatched article", () => {
  assert.throws(
    () => assertArticleMatchesPoLine("WARTSILA", { article: "915002722", itemCode: "915002722" }),
    (err) => err.code === "ASN_ARTICLE_MISMATCH"
  );
  assert.equal(assertArticleMatchesPoLine("915002722", { article: "915002722" }), "915002722");
});

run("valid status transitions succeed", () => {
  assertValidTransition("DRAFT", "SHIPPED");
  assertValidTransition("DRAFT", "CANCELLED");
  assertValidTransition("SHIPPED", "ARRIVED");
  assertValidTransition("SHIPPED", "CANCELLED");
  assertValidTransition("ARRIVED", "CANCELLED");
});

run("invalid status transitions fail", () => {
  assert.throws(() => assertValidTransition("ARRIVED", "SHIPPED"), AsnError);
  assert.throws(() => assertValidTransition("CANCELLED", "DRAFT"), AsnError);
  assert.throws(() => assertValidTransition("DRAFT", "ARRIVED"), AsnError);
});

run("system-only future statuses cannot be manually selected", () => {
  for (const s of ASN_SYSTEM_STATUSES) {
    assert.equal(canUserSetAsnStatus(s), false);
    assert.throws(() => assertValidTransition("DRAFT", s), (err) => err.code === "ASN_SYSTEM_STATUS");
  }
  assert.deepEqual(ALLOWED_ASN_TRANSITIONS.PARTIALLY_RECEIVED, []);
  assert.deepEqual(ALLOWED_ASN_TRANSITIONS.COMPLETED, []);
});

run("concurrency: second stale claim cannot exceed remaining 30", () => {
  const bucket = { [lineA]: 30 };
  const afterA = applyAsnQtyClaims(bucket, [{ poLineId: lineA, qty: 30, article: "A" }]);
  assert.equal(afterA[lineA], 0);
  assert.throws(
    () => applyAsnQtyClaims(afterA, [{ poLineId: lineA, qty: 30, article: "A" }]),
    (err) => err instanceof AsnError && err.code === "ASN_QTY_EXCEEDED"
  );
});

run("create concurrency: atomic $inc allows only one remaining-30 claim", () => {
  const line = { asnActiveQty: 70 };
  const a = tryClaimLineQty(line, "asnActiveQty", 30, 100, 1e-6);
  const b = tryClaimLineQty(line, "asnActiveQty", 30, 100, 1e-6);
  assert.equal(a.ok, true);
  assert.equal(b.ok, false);
  assert.equal(b.reason, "QUANTITY_CLAIM_EXHAUSTED");
  assert.equal(line.asnActiveQty, 100);
  assert.notEqual(line.asnActiveQty, 130);
});

run("edit concurrency: two +40 DRAFT edits against remaining 40 — one wins", () => {
  const claimed = { [lineA]: 60 };
  const max = { [lineA]: 100 };
  const afterA = applyAsnQtyDeltas(claimed, max, [{ poLineId: lineA, delta: 40, article: "A" }]);
  assert.equal(afterA[lineA], 100);
  assert.throws(
    () => applyAsnQtyDeltas(afterA, max, [{ poLineId: lineA, delta: 40, article: "A" }]),
    (err) => err instanceof AsnError && err.code === "ASN_QTY_EXCEEDED" && err.status === 409
  );
});

run("edit excludes own qty via delta against the shared counter", () => {
  const deltas = lineQtyDeltas(
    [{ poLineId: lineA, asnQty: 30 }],
    [{ poLineId: lineA, asnQty: 70 }]
  );
  assert.equal(deltas.length, 1);
  assert.equal(deltas[0].delta, 40);
});

run("cancel releases availability once; repeat cancel is a no-op", () => {
  const lines = [{ poLineId: lineA, asnQty: 70 }];
  const after = applyCancelRelease({ [lineA]: 100 }, lines);
  assert.equal(after[lineA], 30);
  const repeat = applyCancelRelease(after, lines, { alreadyCancelled: true });
  assert.equal(repeat[lineA], 30);
});

run("cancel vs create: status-claimed release cannot double-free", () => {
  let claimed = 70;
  const cancelClaimed = true;
  if (cancelClaimed) claimed = Math.max(0, claimed - 70);
  const create = tryClaimLineQty({ asnActiveQty: claimed }, "asnActiveQty", 30, 100, 1e-6);
  assert.equal(create.ok, true);
  assert.equal(create.claimed, 30);
  const secondCancel = applyCancelRelease({ [lineA]: create.claimed }, [{ poLineId: lineA, asnQty: 70 }], {
    alreadyCancelled: true,
  });
  assert.equal(secondCancel[lineA], 30);
});

run("PO qty cannot drop below active ASN qty", () => {
  const errors = validatePoLinesAgainstActiveAsn(
    [{ _id: lineA, article: "915002722", qty: 60, orderedQty: 60 }],
    new Map([[lineA, 80]])
  );
  assert.ok(errors.length);
  assert.match(errors[0], /active ASN quantity of 80/);
  const ok = validatePoLinesAgainstActiveAsn(
    [{ _id: lineA, article: "915002722", qty: 80, orderedQty: 80 }],
    new Map([[lineA, 80]])
  );
  assert.equal(ok.length, 0);
});

run("PO qty cannot drop below receivedQty plus active ASN qty", () => {
  const errors = validatePoLinesAgainstActiveAsn(
    [{ _id: lineA, article: "915002722", qty: 49, orderedQty: 49, receivedQty: 43 }],
    new Map([[lineA, 7]])
  );
  assert.ok(errors.length);
  const ok = validatePoLinesAgainstActiveAsn(
    [{ _id: lineA, article: "915002722", qty: 50, orderedQty: 50, receivedQty: 43 }],
    new Map([[lineA, 7]])
  );
  assert.equal(ok.length, 0);
});

run("embedded ASN line _id is stable across quantity edits", () => {
  const existingId = "bbbbbbbbbbbbbbbbbbbbbbbb";
  const merged = mergeAsnLinesPreservingIds(
    [{ _id: existingId, poLineId: lineA, asnQty: 30, article: "915002722" }],
    [{ poLineId: lineA, asnQty: 40, article: "915002722", uom: "PCS", poQty: 100 }]
  );
  assert.equal(String(merged[0]._id), existingId);
  assert.equal(merged[0].asnQty, 40);
});

run("ordinary PATCH rejects identity and status fields", () => {
  for (const key of ["companyId", "asnNo", "sourcePoId", "supplierId", "createdBy", "status"]) {
    assert.throws(
      () => assertNoImmutableAsnPatch({ [key]: "x" }),
      (err) => err instanceof AsnError && err.code === "ASN_IMMUTABLE_FIELD"
    );
  }
  assert.ok(ASN_IMMUTABLE_PATCH_KEYS.includes("poIds"));
  assertNoImmutableAsnPatch({ remarks: "ok", lines: [] });
});

run("ASN quantity follows PO precision: integer PCS and decimal KG", () => {
  assertQtyWithinAvailable({ article: "BOLT", poQty: 10, alreadyActive: 0, requested: 10 });
  assertQtyWithinAvailable({ article: "OIL", poQty: 12.5, alreadyActive: 0, requested: 12.5 });
  assert.equal(roundAsnQty(12.5), 12.5);
  assert.throws(
    () => assertQtyWithinAvailable({ article: "BOLT", poQty: 10, alreadyActive: 0, requested: 0 }),
    (err) => err.code === "ASN_QTY_INVALID"
  );
});

run("numbering is company-prefixed and isolated by counter key", () => {
  assert.equal(formatAsnNumber("MAR", 1), "MAR-ASN-0001");
  assert.equal(formatAsnNumber("OKE", 1), "OKE-ASN-0001");
  assert.equal(asnCounterKey("MAR"), "asn:MAR");
  assert.equal(asnCounterKey("OKE"), "asn:OKE");
  assert.notEqual(asnCounterKey("MAR"), asnCounterKey("OKE"));
  assert.equal(normalizeCompanyCode("marivolt"), "MAR");
});

run("ASN module exists in RBAC catalog", () => {
  assert.ok(PERMISSION_MODULES.includes("ASN"));
});

run("PURCHASE role can create/edit/ship/cancel ASN", () => {
  const m = getDefaultPermissionsForRole("purchase");
  for (const a of ["view", "create", "edit", "post", "cancel"]) {
    assert.ok(m.ASN.includes(a), `PURCHASE missing ASN.${a}`);
  }
});

run("STORE_OPERATOR is ASN view-only", () => {
  const m = getDefaultPermissionsForRole("store_operator");
  assert.deepEqual(m.ASN, ["view"]);
  assert.ok(!m.ASN.includes("create"));
  assert.ok(!m.ASN.includes("edit"));
  assert.ok(!m.ASN.includes("post"));
  assert.ok(!m.ASN.includes("cancel"));
});

await runAsync("hasPermission STORE_OPERATOR cannot mutate ASN", async () => {
  const req = { user: { role: "store_operator" } };
  assert.equal(await hasPermission(req, "ASN", "view"), true);
  assert.equal(await hasPermission(req, "ASN", "create"), false);
  assert.equal(await hasPermission(req, "ASN", "edit"), false);
  assert.equal(await hasPermission(req, "ASN", "post"), false);
  assert.equal(await hasPermission(req, "ASN", "cancel"), false);
});

run("ASN routes use ASN module permissions", () => {
  const routes = fs.readFileSync(path.join(srcRoot, "routes", "asnRoutes.js"), "utf8");
  assert.ok(routes.includes('requirePermission("ASN", "view")'));
  assert.ok(routes.includes('requirePermission("ASN", "create")'));
  assert.ok(routes.includes('requirePermission("ASN", "edit")'));
  assert.ok(routes.includes('requirePermission("ASN", "post")'));
  assert.ok(routes.includes('requirePermission("ASN", "cancel")'));
});

run("stock/customs safety: ASN service has no inventory side effects", () => {
  const service = fs.readFileSync(path.join(srcRoot, "services", "asnService.js"), "utf8");
  const controller = fs.readFileSync(path.join(srcRoot, "controllers", "asnController.js"), "utf8");
  const model = fs.readFileSync(path.join(srcRoot, "models", "AdvanceShipmentNotice.js"), "utf8");
  for (const src of [service, controller, model]) {
    assert.equal(/from ["'][^"']*StockLedger/.test(src), false);
    assert.equal(/from ["'][^"']*CustomsLot/.test(src), false);
    assert.equal(/from ["'][^"']*CustomsMovement/.test(src), false);
    assert.equal(/postGrnFromPo|createGrn\b/.test(src), false);
    assert.equal(/from ["'][^"']*stockService/.test(src), false);
    assert.equal(/from ["'][^"']*inventoryRebuild/.test(src), false);
  }
  assert.ok(service.includes("logistics document only"));
});

run("ASN reservation uses atomic pipeline predicate including receivedQty", () => {
  const service = fs.readFileSync(path.join(srcRoot, "services", "asnService.js"), "utf8");
  assert.ok(service.includes("$map"));
  assert.ok(service.includes("receivedQty"));
  assert.ok(service.includes("asnActiveQty"));
  assert.ok(service.includes("claimPoLineAsnQty"));
  assert.ok(service.includes("restorePoLineAsnQty"));
  assert.ok(service.includes("ASN_RESERVATION_RESTORE_CONFLICT"));
  assert.equal(service.includes("deleteOne"), false);
  assert.equal(service.includes("recomputeAndGuard"), false);
  assert.equal(service.includes("orderedQty ="), false);
  assert.equal(service.includes("po.qty ="), false);
});

run("supplier identity is copied from the PO, not the client snapshot", () => {
  const service = fs.readFileSync(path.join(srcRoot, "services", "asnService.js"), "utf8");
  assert.ok(service.includes("supplierId: po.supplierId"));
  assert.ok(service.includes("supplierName: po.supplierName"));
  assert.ok(service.includes("ASN_SUPPLIER_MISMATCH"));
  assert.equal(/supplierId:\s*body\.supplierId/.test(service), false);
});

run("ship/arrive audit timestamps are not copied onto operational dates", () => {
  const service = fs.readFileSync(path.join(srcRoot, "services", "asnService.js"), "utf8");
  assert.equal(service.includes("if (!doc.shipmentDate)"), false);
  assert.equal(service.includes("if (!doc.actualArrivalDate)"), false);
  assert.ok(service.includes("shippedAt: now"));
  assert.ok(service.includes("arrivedAt: now"));
});

run("ASN line snapshots include historical identity fields", () => {
  const service = fs.readFileSync(path.join(srcRoot, "services", "asnService.js"), "utf8");
  for (const field of [
    "article:",
    "description:",
    "supplierPartNumber:",
    "uom:",
    "poLineId:",
    "poQty,",
    "asnQty:",
  ]) {
    assert.ok(service.includes(field), `missing snapshot field ${field}`);
  }
  assert.ok(service.includes("mergeAsnLinesPreservingIds"));
});

run("cross-company PO lookup is company-scoped", () => {
  const service = fs.readFileSync(path.join(srcRoot, "services", "asnService.js"), "utf8");
  assert.ok(service.includes("loadPoForCompany"));
  assert.ok(service.includes("ASN_COMPANY_MISMATCH"));
  assert.ok(service.includes("companyScope(companyId"));
});

run("PO update/cancel/delete are blocked by active ASN qty", () => {
  const purchase = fs.readFileSync(path.join(srcRoot, "controllers", "purchaseController.js"), "utf8");
  assert.ok(purchase.includes("validatePoLinesAgainstActiveAsn"));
  assert.ok(purchase.includes("assertPoHasNoActiveAsns"));
  assert.ok(purchase.includes("ASN_PO_HAS_ACTIVE") || purchase.includes("assertPoHasNoActiveAsns"));
});

run("Phase 1 does not leak receiving/barcode/GRN workflow", () => {
  const service = fs.readFileSync(path.join(srcRoot, "services", "asnService.js"), "utf8");
  const model = fs.readFileSync(path.join(srcRoot, "models", "AdvanceShipmentNotice.js"), "utf8");
  for (const src of [service, model]) {
    assert.equal(/ReceivingUnit/.test(src), false);
    assert.equal(/barcode/.test(src), false);
    assert.equal(/inspectionQty/.test(src), false);
  }
});

run("ASN does not mutate PO ordered qty fields", () => {
  const service = fs.readFileSync(path.join(srcRoot, "services", "asnService.js"), "utf8");
  assert.equal(service.includes("orderedQty ="), false);
  assert.equal(service.includes("po.qty ="), false);
});

run("frontend Incoming Shipments is a Store operator tab", () => {
  const rbac = fs.readFileSync(path.join(feRoot, "lib", "rbac.js"), "utf8");
  const store = fs.readFileSync(path.join(feRoot, "pages", "StoreModule.jsx"), "utf8");
  assert.ok(rbac.includes("Incoming Shipments"));
  assert.ok(store.includes("Incoming Shipments"));
});

run("roundAsnQty preserves engine-style decimals", () => {
  assert.equal(roundAsnQty(1.2345674), 1.234567);
  assert.equal(poLines[0].qty, 100);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
