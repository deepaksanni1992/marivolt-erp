/**
 * P3 — Order Allocation immutable reservation identity + controlled renaming.
 * Run: node scripts/allocationReservation.p3.test.js
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "path";
import { fileURLToPath } from "node:url";
import {
  allocationRemainingReservedQty,
  buildAllocReleaseEffectKeyV1,
  buildAllocReleaseEffectKeyV2,
  buildAllocReserveEffectKeyForAllocation,
  buildAllocReserveEffectKeyV1,
  buildAllocReserveEffectKeyV2,
  createAllocEffectIdempotencySimulator,
  parseAllocReservationEffectKey,
  resolveAllocReleaseEffectKey,
  RESERVATION_EFFECT_VERSION_V2,
} from "../src/utils/allocationReservationKeys.js";
import { evaluateOrderAllocationNumberEditability } from "../src/utils/orderAllocationNumberEdit.js";
import { assertSalesDocumentNumberChangeAllowed } from "../src/utils/salesDocumentNumberChangeGuard.js";
import {
  applyManualSalesDocumentNumber,
  bumpSalesDocumentCounterToAtLeast,
  generateSalesDocumentNumber,
  validateManualSalesDocumentNumber,
} from "../src/utils/salesDocNumber.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcRoot = path.join(__dirname, "..", "src");

let passed = 0;
let failed = 0;

async function run(name, fn) {
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

function createMemoryCounter() {
  const map = new Map();
  let chain = Promise.resolve();
  const keyOf = (filter) => `${String(filter.companyId)}::${String(filter.key)}`;

  function applyUpdate(filter, update) {
    const k = keyOf(filter);
    let seq = map.has(k) ? map.get(k) : null;
    if (seq == null) seq = 0;
    if (update?.$inc?.seq != null) seq += Number(update.$inc.seq) || 0;
    if (update?.$max?.seq != null) seq = Math.max(seq, Number(update.$max.seq) || 0);
    map.set(k, seq);
    return { companyId: filter.companyId, key: filter.key, seq };
  }

  return {
    findOne(filter) {
      const k = keyOf(filter);
      const seq = map.has(k) ? map.get(k) : null;
      const doc = seq == null ? null : { companyId: filter.companyId, key: filter.key, seq };
      return {
        lean: async () => doc,
        then: (resolve, reject) => Promise.resolve(doc).then(resolve, reject),
      };
    },
    findOneAndUpdate(filter, update) {
      const job = chain.then(async () => {
        await new Promise((r) => setImmediate(r));
        return applyUpdate(filter, update);
      });
      chain = job.then(
        () => undefined,
        () => undefined
      );
      return job;
    },
    async getSeq(companyId, key) {
      return map.get(`${String(companyId)}::${String(key)}`) ?? 0;
    },
  };
}

function createModelStore() {
  const rows = [];
  return {
    rows,
    async exists(filter) {
      return rows.some((r) => {
        if (String(r.companyId) !== String(filter.companyId)) return false;
        for (const [k, v] of Object.entries(filter)) {
          if (k === "companyId") continue;
          if (k === "_id" && v && typeof v === "object" && v.$ne) {
            if (String(r._id) === String(v.$ne)) return false;
            continue;
          }
          if (String(r[k]) !== String(v)) return false;
        }
        return true;
      });
    },
    add(row) {
      rows.push(row);
    },
  };
}

console.log("\nOrder Allocation reservation identity (P3)\n");

await run("v2 reserve key uses allocationId not allocationNo", () => {
  const allocation = {
    _id: "allocA",
    allocationNo: "ALLOC/260809.01",
    reservationEffectVersion: 2,
  };
  const key = buildAllocReserveEffectKeyForAllocation({
    companyId: "co1",
    allocation,
    article: "ART-X",
  });
  assert.equal(key, "alloc:reserve:v2:co1:allocA:ART-X");
  assert.ok(!key.includes("ALLOC/260809.01"));
});

await run("rename does not change v2 reserve key", () => {
  const before = {
    _id: "allocA",
    allocationNo: "ALLOC/260809.01",
    reservationEffectVersion: 2,
  };
  const after = { ...before, allocationNo: "ALLOC/260809.10" };
  const k1 = buildAllocReserveEffectKeyForAllocation({ companyId: "co1", allocation: before, article: "X" });
  const k2 = buildAllocReserveEffectKeyForAllocation({ companyId: "co1", allocation: after, article: "X" });
  assert.equal(k1, k2);
});

await run("release after rename resolves v2 once (no double key)", async () => {
  const allocation = {
    _id: "allocA",
    allocationNo: "ALLOC/260809.10",
    reservationEffectVersion: 2,
    reservationIdentityNo: "ALLOC/260809.01",
  };
  const resolved = await resolveAllocReleaseEffectKey({
    companyId: "co1",
    allocation,
    article: "ART-X",
    reserveExists: async () => false,
  });
  assert.equal(resolved.version, 2);
  assert.equal(resolved.effectKey, "alloc:release:v2:co1:allocA:ART-X");
  assert.equal(resolved.reserveEffectKey, "alloc:reserve:v2:co1:allocA:ART-X");
});

await run("legacy v1 release uses frozen reservationIdentityNo not renamed display no", async () => {
  const allocation = {
    _id: "legacy1",
    allocationNo: "ALLOC/260809.99",
    reservationEffectVersion: 1,
    reservationIdentityNo: "MAR-ALLOC-0015",
  };
  const resolved = await resolveAllocReleaseEffectKey({
    companyId: "co1",
    allocation,
    article: "PUMP",
    reserveExists: async () => false,
  });
  assert.equal(resolved.version, 1);
  assert.equal(resolved.effectKey, "alloc:release:co1:MAR-ALLOC-0015:PUMP");
  assert.equal(resolved.reserveEffectKey, "alloc:reserve:co1:MAR-ALLOC-0015:PUMP");
  assert.ok(!resolved.effectKey.includes("ALLOC/260809.99"));
});

await run("MAR-ALLOC-0015 legacy parse + rebuild compatibility", () => {
  const reserve = buildAllocReserveEffectKeyV1({
    companyId: "co1",
    allocationNo: "MAR-ALLOC-0015",
    article: "ART1",
  });
  assert.equal(reserve, "alloc:reserve:co1:MAR-ALLOC-0015:ART1");
  const parsed = parseAllocReservationEffectKey(reserve);
  assert.equal(parsed.kind, "reserve");
  assert.equal(parsed.version, 1);
  assert.equal(parsed.identity, "MAR-ALLOC-0015");
  const release = buildAllocReleaseEffectKeyV1({
    companyId: "co1",
    allocationNo: "MAR-ALLOC-0015",
    article: "ART1",
  });
  assert.equal(release, "alloc:release:co1:MAR-ALLOC-0015:ART1");
});

await run("v2 identity collision — same article different allocationIds", () => {
  const a = buildAllocReserveEffectKeyV2({ companyId: "co1", allocationId: "a1", article: "X" });
  const b = buildAllocReserveEffectKeyV2({ companyId: "co1", allocationId: "a2", article: "X" });
  assert.notEqual(a, b);
});

await run("duplicate article lines share one effect key (dedupe-by-article)", () => {
  const allocation = { _id: "a1", reservationEffectVersion: 2 };
  const k1 = buildAllocReserveEffectKeyForAllocation({ companyId: "c", allocation, article: "X" });
  const k2 = buildAllocReserveEffectKeyForAllocation({ companyId: "c", allocation, article: "x" });
  assert.equal(k1, k2);
});

await run("parser recognizes v1 and v2", () => {
  const v2 = parseAllocReservationEffectKey("alloc:reserve:v2:co:aid:ART");
  assert.equal(v2.version, 2);
  assert.equal(v2.identity, "aid");
  const v1 = parseAllocReservationEffectKey("alloc:reserve:co:ALLOC/260809.01:ART");
  assert.equal(v1.version, 1);
  assert.equal(v1.identity, "ALLOC/260809.01");
  // Must not mis-parse v2 as v1 with companyId=v2
  assert.equal(parseAllocReservationEffectKey("alloc:release:v2:co:aid:ART").version, 2);
});

await run("OPEN v2 reserved allocation is rename-eligible", async () => {
  const result = await evaluateOrderAllocationNumberEditability({
    companyId: "co1",
    allocation: {
      _id: "a1",
      status: "OPEN",
      packingStatus: "NOT_PACKED",
      invoiceStatus: "NOT_INVOICED",
      dispatchStatus: "NOT_DISPATCHED",
      reservationEffectVersion: 2,
      stockReservedAt: new Date(),
      lines: [{ qty: 9, packedQty: 0 }],
    },
    existsFns: {
      packing: async () => false,
      salesInvoice: async () => false,
      storeDispatch: async () => false,
      purchaseOrder: async () => false,
    },
  });
  assert.equal(result.allowed, true);
});

await run("partial pack blocks rename", async () => {
  const result = await evaluateOrderAllocationNumberEditability({
    companyId: "co1",
    allocation: {
      _id: "a1",
      status: "OPEN",
      packingStatus: "PARTIALLY_PACKED",
      reservationEffectVersion: 2,
      stockReservedAt: new Date(),
      lines: [{ qty: 9, packedQty: 4 }],
    },
    existsFns: {
      packing: async () => false,
      salesInvoice: async () => false,
      storeDispatch: async () => false,
      purchaseOrder: async () => false,
    },
  });
  assert.equal(result.allowed, false);
  assert.match(result.reason, /packing has started/i);
});

await run("packing document exists blocks rename", async () => {
  const result = await evaluateOrderAllocationNumberEditability({
    companyId: "co1",
    allocation: {
      _id: "a1",
      status: "OPEN",
      packingStatus: "NOT_PACKED",
      reservationEffectVersion: 2,
      stockReservedAt: new Date(),
      lines: [{ qty: 9, packedQty: 0 }],
    },
    existsFns: {
      packing: async () => true,
      salesInvoice: async () => false,
      storeDispatch: async () => false,
      purchaseOrder: async () => false,
    },
  });
  assert.equal(result.allowed, false);
  assert.match(result.reason, /Packing document exists/i);
});

await run("SI / Dispatch / PO / cancelled / completed block rename", async () => {
  const base = {
    _id: "a1",
    status: "OPEN",
    packingStatus: "NOT_PACKED",
    invoiceStatus: "NOT_INVOICED",
    dispatchStatus: "NOT_DISPATCHED",
    reservationEffectVersion: 2,
    stockReservedAt: new Date(),
    lines: [{ qty: 1, packedQty: 0 }],
  };
  const none = {
    packing: async () => false,
    salesInvoice: async () => false,
    storeDispatch: async () => false,
    purchaseOrder: async () => false,
  };

  let r = await evaluateOrderAllocationNumberEditability({
    companyId: "c",
    allocation: { ...base, linkedSalesInvoiceId: "si1" },
    existsFns: none,
  });
  assert.equal(r.allowed, false);

  r = await evaluateOrderAllocationNumberEditability({
    companyId: "c",
    allocation: base,
    existsFns: { ...none, salesInvoice: async () => true },
  });
  assert.equal(r.allowed, false);

  r = await evaluateOrderAllocationNumberEditability({
    companyId: "c",
    allocation: base,
    existsFns: { ...none, storeDispatch: async () => true },
  });
  assert.equal(r.allowed, false);

  r = await evaluateOrderAllocationNumberEditability({
    companyId: "c",
    allocation: base,
    existsFns: { ...none, purchaseOrder: async () => true },
  });
  assert.equal(r.allowed, false);
  assert.match(r.reason, /Purchase Order/i);

  r = await evaluateOrderAllocationNumberEditability({
    companyId: "c",
    allocation: { ...base, status: "CANCELLED" },
    existsFns: none,
  });
  assert.equal(r.allowed, false);

  r = await evaluateOrderAllocationNumberEditability({
    companyId: "c",
    allocation: { ...base, status: "CLOSED" },
    existsFns: none,
  });
  assert.equal(r.allowed, false);
});

await run("legacy active reservation blocks rename", async () => {
  const result = await evaluateOrderAllocationNumberEditability({
    companyId: "co1",
    allocation: {
      _id: "legacy1",
      status: "OPEN",
      packingStatus: "NOT_PACKED",
      invoiceStatus: "NOT_INVOICED",
      dispatchStatus: "NOT_DISPATCHED",
      reservationEffectVersion: 1,
      stockReservedAt: new Date(),
      reservationIdentityNo: "MAR-ALLOC-0015",
      allocationNo: "MAR-ALLOC-0015",
      lines: [{ qty: 2, packedQty: 0 }],
    },
    existsFns: {
      packing: async () => false,
      salesInvoice: async () => false,
      storeDispatch: async () => false,
      purchaseOrder: async () => false,
    },
  });
  assert.equal(result.allowed, false);
  assert.match(result.reason, /Legacy reservation identity/i);
});

await run("guard ORDER_ALLOCATION delegates to allocation eligibility", async () => {
  await assert.rejects(
    () =>
      assertSalesDocumentNumberChangeAllowed({
        companyId: "co1",
        documentType: "ORDER_ALLOCATION",
        documentId: "a1",
        document: {
          _id: "a1",
          status: "OPEN",
          packingStatus: "NOT_PACKED",
          invoiceStatus: "NOT_INVOICED",
          dispatchStatus: "NOT_DISPATCHED",
          reservationEffectVersion: 1,
          stockReservedAt: new Date(),
          lines: [{ qty: 3, packedQty: 0 }],
        },
        existsFns: {
          packing: async () => false,
          salesInvoice: async () => false,
          storeDispatch: async () => false,
          purchaseOrder: async () => false,
        },
      }),
    /Legacy reservation identity/
  );
});

await run("counter catch-up on safe rename; rejected rename does not bump", async () => {
  const CounterModel = createMemoryCounter();
  const companyId = "company-mar";
  await bumpSalesDocumentCounterToAtLeast({
    companyId,
    documentType: "ALLOC",
    dateToken: "260809",
    sequence: 4,
    CounterModel,
  });
  const model = createModelStore();
  model.add({ companyId, allocationNo: "ALLOC/260809.01", _id: "a1" });
  const prepared = await applyManualSalesDocumentNumber({
    companyId,
    documentType: "ALLOC",
    value: "ALLOC/260809.20",
    model,
    field: "allocationNo",
    excludeId: "a1",
    previousNumber: "ALLOC/260809.01",
    CounterModel,
  });
  assert.equal(prepared.number, "ALLOC/260809.20");
  assert.equal(await CounterModel.getSeq(companyId, "salesdoc:ALLOC:260809"), 20);

  // Rejected rename path: eligibility fails before applyManual — counter stays.
  await assert.rejects(
    () =>
      assertSalesDocumentNumberChangeAllowed({
        companyId,
        documentType: "ALLOC",
        documentId: "a2",
        document: {
          _id: "a2",
          status: "OPEN",
          packingStatus: "NOT_PACKED",
          reservationEffectVersion: 2,
          stockReservedAt: new Date(),
          lines: [],
        },
        existsFns: {
          packing: async () => true,
          salesInvoice: async () => false,
          storeDispatch: async () => false,
          purchaseOrder: async () => false,
        },
      }),
    /Packing document exists/
  );
  assert.equal(await CounterModel.getSeq(companyId, "salesdoc:ALLOC:260809"), 20);

  const next = await generateSalesDocumentNumber({
    companyId,
    documentType: "ALLOC",
    referenceDate: new Date("2026-08-09T08:00:00.000Z"),
    CounterModel,
  });
  assert.equal(next, "ALLOC/260809.21");
});

await run("duplicate number 409; company isolation; wrong prefix", async () => {
  const CounterModel = createMemoryCounter();
  const mar = createModelStore();
  mar.add({ companyId: "mar", allocationNo: "ALLOC/260809.10", _id: "a1" });
  await assert.rejects(
    () =>
      applyManualSalesDocumentNumber({
        companyId: "mar",
        documentType: "ALLOC",
        value: "ALLOC/260809.10",
        model: mar,
        field: "allocationNo",
        excludeId: "a2",
        previousNumber: "ALLOC/260809.01",
        CounterModel,
      }),
    /Order Allocation number ALLOC\/260809\.10 already exists/
  );

  const oke = createModelStore();
  const prepared = await applyManualSalesDocumentNumber({
    companyId: "oke",
    documentType: "ALLOC",
    value: "ALLOC/260809.10",
    model: oke,
    field: "allocationNo",
    previousNumber: "ALLOC/260809.01",
    CounterModel,
  });
  assert.equal(prepared.number, "ALLOC/260809.10");

  assert.throws(
    () => validateManualSalesDocumentNumber({ value: "OA/260809.10", expectedDocumentType: "ALLOC" }),
    /cannot use the OA prefix/i
  );
});

await run("custom noncanonical ALLOC number validates", () => {
  const v = validateManualSalesDocumentNumber({
    value: "CUSTOM-ALLOC-001",
    expectedDocumentType: "ALLOC",
  });
  assert.equal(v.number, "CUSTOM-ALLOC-001");
  assert.equal(v.parsed.isCanonical, false);
});

await run("same-number update unchanged — no counter bump", async () => {
  const CounterModel = createMemoryCounter();
  const companyId = "company-mar";
  await bumpSalesDocumentCounterToAtLeast({
    companyId,
    documentType: "ALLOC",
    dateToken: "260809",
    sequence: 5,
    CounterModel,
  });
  const model = createModelStore();
  model.add({ companyId, allocationNo: "ALLOC/260809.05", _id: "a1" });
  const prepared = await applyManualSalesDocumentNumber({
    companyId,
    documentType: "ALLOC",
    value: "  alloc/260809.05  ",
    model,
    field: "allocationNo",
    excludeId: "a1",
    previousNumber: "ALLOC/260809.05",
    CounterModel,
  });
  assert.equal(prepared.unchanged, true);
  assert.equal(await CounterModel.getSeq(companyId, "salesdoc:ALLOC:260809"), 5);
});

await run("live sources — v2-only new reserves + rename endpoint; SI uses dedicated P4 path", () => {
  const sales = fs.readFileSync(path.join(srcRoot, "controllers", "salesFlowController.js"), "utf8");
  const keys = fs.readFileSync(path.join(srcRoot, "utils", "allocationReservationKeys.js"), "utf8");
  const routes = fs.readFileSync(path.join(srcRoot, "routes", "salesRoutes.js"), "utf8");
  const model = fs.readFileSync(path.join(srcRoot, "models", "OrderAllocation.js"), "utf8");
  const seed = fs.readFileSync(path.join(srcRoot, "seedStoreSalesDemo.js"), "utf8");

  assert.ok(keys.includes("alloc:reserve:v2:"));
  assert.ok(sales.includes("buildAllocReserveEffectKeyV2"));
  assert.ok(sales.includes("resolveAllocReleaseEffectKey"));
  assert.ok(sales.includes("reservationEffectVersion: RESERVATION_EFFECT_VERSION_V2"));
  assert.ok(sales.includes("updateOrderAllocationNumber"));
  assert.ok(routes.includes("/order-allocations/:id/allocation-no"));
  assert.ok(model.includes("reservationEffectVersion"));
  assert.ok(model.includes("reservationIdentityNo"));
  assert.ok(model.includes("Default stays 1"));

  // No production template v1 reserve producer remains
  assert.equal(sales.includes("`alloc:reserve:${"), false);
  assert.equal(sales.includes("`alloc:release:${"), false);
  assert.ok(sales.includes("requires allocation._id for immutable reservation identity"));
  assert.ok(seed.includes("buildAllocReserveEffectKeyV2"));

  // Identity fields rejected on allocation number API
  assert.ok(sales.includes("reservationEffectVersion and reservationIdentityNo are system fields"));

  // SI renumber is dedicated P4 endpoint (not general update allowed list)
  assert.ok(sales.includes("updateSalesInvoiceNumber"));
  assert.ok(!/allowed = \[[^\]]*["']invoiceNo["']/s.test(sales));

  // Historical ledger rewrite must not appear
  assert.equal(sales.includes("StockLedger.updateMany"), false);
  assert.equal(/effectKey:\s*\{?\s*\$set/.test(sales), false);
});

await run("integrity scanners do not parse alloc effectKeys for expected reserved", () => {
  const expected = fs.readFileSync(path.join(srcRoot, "services", "stockExpectedBuckets.js"), "utf8");
  const integrity = fs.readFileSync(path.join(srcRoot, "services", "stockBucketIntegrityService.js"), "utf8");
  const position = fs.readFileSync(path.join(srcRoot, "services", "allocationStockPositionService.js"), "utf8");
  assert.equal(expected.includes("alloc:reserve:"), false);
  assert.equal(integrity.includes("alloc:reserve:"), false);
  assert.equal(position.includes("alloc:reserve:"), false);
  assert.ok(expected.includes("qty") && expected.includes("packedQty"));
});

await run("release helper never returns both v1 and v2 simultaneously", async () => {
  for (const version of [1, 2]) {
    let lookups = 0;
    const resolved = await resolveAllocReleaseEffectKey({
      companyId: "c",
      allocation: {
        _id: "id1",
        allocationNo: "ALLOC/260809.01",
        reservationIdentityNo: "ALLOC/260809.01",
        reservationEffectVersion: version,
      },
      article: "A",
      reserveExists: async () => {
        lookups += 1;
        return false;
      },
    });
    assert.ok(resolved.effectKey.startsWith(version === 2 ? "alloc:release:v2:" : "alloc:release:"));
    // v2 stamped docs skip DB lookup; legacy may probe once for v2 reserve existence
    if (version === 2) assert.equal(lookups, 0);
    else assert.equal(lookups, 1);
  }
  void buildAllocReleaseEffectKeyV2;
});

await run("A — new allocation stamps always produce v2 reserve keys", () => {
  const allocation = {
    _id: "507f1f77bcf86cd799439011",
    allocationNo: "ALLOC/260809.01",
    reservationEffectVersion: RESERVATION_EFFECT_VERSION_V2,
    reservationIdentityNo: "ALLOC/260809.01",
  };
  const key = buildAllocReserveEffectKeyV2({
    companyId: "co1",
    allocationId: allocation._id,
    article: "700004.28",
  });
  assert.equal(key, "alloc:reserve:v2:co1:507f1f77bcf86cd799439011:700004.28");
  assert.ok(!key.includes("ALLOC/"));
});

await run("B/C — v2 reserve + release retry exactly once (effectKey idempotency)", async () => {
  const sim = createAllocEffectIdempotencySimulator(0);
  const allocation = {
    _id: "allocA",
    allocationNo: "ALLOC/260809.01",
    reservationEffectVersion: 2,
    reservationIdentityNo: "ALLOC/260809.01",
  };
  const reserveKey = buildAllocReserveEffectKeyV2({
    companyId: "co1",
    allocationId: allocation._id,
    article: "X",
  });
  const r1 = sim.reserve(reserveKey, 9);
  const r2 = sim.reserve(reserveKey, 9);
  assert.equal(r1.applied, true);
  assert.equal(r2.applied, false);
  assert.equal(sim.reservedQty, 9);

  const release = await resolveAllocReleaseEffectKey({
    companyId: "co1",
    allocation: { ...allocation, allocationNo: "ALLOC/260809.20" },
    article: "X",
  });
  assert.equal(release.version, 2);
  const rel1 = sim.release(release.effectKey, 9);
  const rel2 = sim.release(release.effectKey, 9);
  assert.equal(rel1.applied, true);
  assert.equal(rel2.applied, false);
  assert.equal(sim.reservedQty, 0);
  assert.equal(sim.ledgerCount, 2);
});

await run("D — reserve → rename display no → release uses allocationId (buckets restore)", async () => {
  const sim = createAllocEffectIdempotencySimulator(100);
  const allocation = {
    _id: "allocRename",
    allocationNo: "ALLOC/260809.01",
    reservationEffectVersion: 2,
    reservationIdentityNo: "ALLOC/260809.01",
    lines: [{ article: "ART", qty: 9, packedQty: 0 }],
  };
  const reserveKey = buildAllocReserveEffectKeyV2({
    companyId: "co1",
    allocationId: allocation._id,
    article: "ART",
  });
  sim.reserve(reserveKey, 9);
  assert.equal(sim.reservedQty, 109);

  // Display rename only — identity fields frozen
  const renamed = {
    ...allocation,
    allocationNo: "ALLOC/260809.20",
    reservationIdentityNo: "ALLOC/260809.01",
    reservationEffectVersion: 2,
  };
  assert.equal(
    buildAllocReserveEffectKeyV2({ companyId: "co1", allocationId: renamed._id, article: "ART" }),
    reserveKey
  );

  const release = await resolveAllocReleaseEffectKey({
    companyId: "co1",
    allocation: renamed,
    article: "ART",
    reserveExists: async (ek) => sim.has(ek),
  });
  assert.equal(release.version, 2);
  assert.ok(!release.effectKey.includes("ALLOC/260809"));
  sim.release(release.effectKey, 9);
  assert.equal(sim.reservedQty, 100);
});

await run("E — legacy v1 release for MAR-ALLOC-0015 / 700004.28", async () => {
  const allocation = {
    _id: "legacy15",
    allocationNo: "MAR-ALLOC-0015",
    reservationIdentityNo: "MAR-ALLOC-0015",
    reservationEffectVersion: 1,
  };
  const resolved = await resolveAllocReleaseEffectKey({
    companyId: "co1",
    allocation,
    article: "700004.28",
    reserveExists: async () => false,
  });
  assert.equal(resolved.version, 1);
  assert.equal(resolved.effectKey, "alloc:release:co1:MAR-ALLOC-0015:700004.28");
  assert.equal(resolved.reserveEffectKey, "alloc:reserve:co1:MAR-ALLOC-0015:700004.28");
});

await run("F — legacy active rename rejected; counter/identity unchanged", async () => {
  const CounterModel = createMemoryCounter();
  const companyId = "company-mar";
  await bumpSalesDocumentCounterToAtLeast({
    companyId,
    documentType: "ALLOC",
    dateToken: "260809",
    sequence: 4,
    CounterModel,
  });
  const legacy = {
    _id: "legacy15",
    status: "OPEN",
    packingStatus: "NOT_PACKED",
    invoiceStatus: "NOT_INVOICED",
    dispatchStatus: "NOT_DISPATCHED",
    allocationNo: "MAR-ALLOC-0015",
    reservationIdentityNo: "MAR-ALLOC-0015",
    reservationEffectVersion: 1,
    stockReservedAt: new Date(),
    lines: [{ qty: 5, packedQty: 0 }],
  };
  await assert.rejects(
    () =>
      assertSalesDocumentNumberChangeAllowed({
        companyId,
        documentType: "ALLOC",
        documentId: legacy._id,
        document: legacy,
        existsFns: {
          packing: async () => false,
          salesInvoice: async () => false,
          storeDispatch: async () => false,
          purchaseOrder: async () => false,
        },
      }),
    /Legacy reservation identity/
  );
  assert.equal(legacy.allocationNo, "MAR-ALLOC-0015");
  assert.equal(legacy.reservationIdentityNo, "MAR-ALLOC-0015");
  assert.equal(await CounterModel.getSeq(companyId, "salesdoc:ALLOC:260809"), 4);
});

await run("G — legacy OPEN with no active reservation may rename", async () => {
  const result = await evaluateOrderAllocationNumberEditability({
    companyId: "co1",
    allocation: {
      _id: "legacy-open",
      status: "OPEN",
      packingStatus: "NOT_PACKED",
      invoiceStatus: "NOT_INVOICED",
      dispatchStatus: "NOT_DISPATCHED",
      // Missing fields hydrate as default 1 / "" — never reserved
      allocationNo: "MAR-ALLOC-0099",
      lines: [{ qty: 2, packedQty: 0 }],
    },
    existsFns: {
      packing: async () => false,
      salesInvoice: async () => false,
      storeDispatch: async () => false,
      purchaseOrder: async () => false,
    },
  });
  assert.equal(result.allowed, true);
  assert.equal(allocationRemainingReservedQty({ lines: [{ qty: 2, packedQty: 0 }] }), 2);
});

await run("H — duplicate Article lines collapse to one effect (qty sum)", () => {
  // Mirrors salesFlowController.dedupeLines
  const lines = [
    { article: "X", qty: 4 },
    { article: "X", qty: 5 },
  ];
  const byArticle = new Map();
  for (const ln of lines) {
    const code = String(ln.article).toUpperCase();
    byArticle.set(code, (byArticle.get(code) || 0) + Number(ln.qty));
  }
  assert.equal(byArticle.size, 1);
  assert.equal(byArticle.get("X"), 9);
  const allocation = { _id: "a1", reservationEffectVersion: 2 };
  const key = buildAllocReserveEffectKeyV2({ companyId: "c", allocationId: allocation._id, article: "X" });
  assert.equal(key, "alloc:reserve:v2:c:a1:X");
});

await run("I — identity fields rejected by number-change API source", () => {
  const sales = fs.readFileSync(path.join(srcRoot, "controllers", "salesFlowController.js"), "utf8");
  assert.ok(sales.includes("reservationEffectVersion and reservationIdentityNo are system fields"));
  assert.ok(sales.includes("doc.reservationIdentityNo = frozenIdentityNo"));
  assert.ok(sales.includes("doc.reservationEffectVersion = frozenEffectVersion"));
});

await run("legacy missing fields: default v1 + identityNo fallback to allocationNo", async () => {
  // Simulates hydrated legacy doc without persisted P3 fields
  const allocation = {
    _id: "legacy",
    allocationNo: "MAR-ALLOC-0015",
    // reservationEffectVersion / reservationIdentityNo absent
    stockReservedAt: new Date(),
    lines: [{ qty: 1, packedQty: 0 }],
  };
  const version = Number(allocation.reservationEffectVersion) || 1;
  assert.equal(version, 1);
  const resolved = await resolveAllocReleaseEffectKey({
    companyId: "co1",
    allocation,
    article: "700004.28",
    reserveExists: async () => false,
  });
  assert.equal(resolved.version, 1);
  assert.equal(resolved.effectKey, "alloc:release:co1:MAR-ALLOC-0015:700004.28");
});

await run("effectKey length stays within practical String index bounds", () => {
  const companyId = "507f1f77bcf86cd799439011";
  const allocationId = "507f191e810c19729de860ea";
  const article = "A".repeat(120);
  const key = buildAllocReserveEffectKeyV2({ companyId, allocationId, article });
  // MongoDB index key limit is 1024 bytes; realistic keys are far smaller.
  assert.ok(Buffer.byteLength(key, "utf8") < 512, `key bytes=${Buffer.byteLength(key)}`);
  assert.match(key, /^alloc:reserve:v2:/);
});

await run("version=2 means v2 semantics even if reserve not yet present", async () => {
  const allocation = {
    _id: "new1",
    allocationNo: "ALLOC/260809.01",
    reservationEffectVersion: 2,
    reservationIdentityNo: "ALLOC/260809.01",
    // stockReservedAt intentionally unset — reserve may still be in-flight / rolled back
  };
  const resolved = await resolveAllocReleaseEffectKey({
    companyId: "co1",
    allocation,
    article: "X",
    reserveExists: async () => {
      throw new Error("v2 stamped docs must not require reserveExists lookup");
    },
  });
  assert.equal(resolved.version, 2);
  assert.equal(resolved.effectKey, "alloc:release:v2:co1:new1:X");
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
