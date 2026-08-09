/**
 * P2 — Manual sales document number override + counter catch-up.
 * Run: node scripts/salesDocumentNumbering.p2.test.js
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyManualSalesDocumentNumber,
  bumpSalesDocumentCounterToAtLeast,
  generateSalesDocumentNumber,
  parseCanonicalSalesDocumentNumber,
  peekNextSalesDocumentNumber,
  validateManualSalesDocumentNumber,
} from "../src/utils/salesDocNumber.js";
import { assertSalesDocumentNumberChangeAllowed } from "../src/utils/salesDocumentNumberChangeGuard.js";

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
    if (seq == null) {
      seq = 0;
      map.set(k, seq);
    }
    if (update?.$inc?.seq != null) {
      seq += Number(update.$inc.seq) || 0;
    }
    if (update?.$max?.seq != null) {
      seq = Math.max(seq, Number(update.$max.seq) || 0);
    }
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

console.log("\nSales document numbering (P2 — manual override)\n");

await run("Parser — QT/260809.01", () => {
  const p = parseCanonicalSalesDocumentNumber("QT/260809.01");
  assert.equal(p.isCanonical, true);
  assert.equal(p.documentType, "QT");
  assert.equal(p.dateToken, "260809");
  assert.equal(p.sequence, 1);
  assert.equal(p.normalized, "QT/260809.01");
});

await run("Parser — OA/260809.99", () => {
  const p = parseCanonicalSalesDocumentNumber("OA/260809.99");
  assert.equal(p.isCanonical, true);
  assert.equal(p.documentType, "OA");
  assert.equal(p.sequence, 99);
});

await run("Parser — PI/260809.100", () => {
  const p = parseCanonicalSalesDocumentNumber("PI/260809.100");
  assert.equal(p.isCanonical, true);
  assert.equal(p.sequence, 100);
  assert.equal(p.normalized, "PI/260809.100");
});

await run("Parser — CUSTOM-QT-100 noncanonical", () => {
  const p = parseCanonicalSalesDocumentNumber("CUSTOM-QT-100");
  assert.equal(p.isCanonical, false);
});

await run("Parser — lowercase qt/260809.05 normalizes", () => {
  const v = validateManualSalesDocumentNumber({
    value: "qt/260809.05",
    expectedDocumentType: "QT",
  });
  assert.equal(v.number, "QT/260809.05");
  assert.equal(v.parsed.isCanonical, true);
});

await run("Wrong prefix — Quotation rejects PI/", () => {
  assert.throws(
    () =>
      validateManualSalesDocumentNumber({
        value: "PI/260809.05",
        expectedDocumentType: "QT",
      }),
    /Quotation number cannot use the PI prefix/
  );
});

await run("Wrong prefix — OA rejects QT/", () => {
  assert.throws(
    () =>
      validateManualSalesDocumentNumber({
        value: "QT/260809.05",
        expectedDocumentType: "OA",
      }),
    /Order Acknowledgement number cannot use the QT prefix/
  );
});

await run("Whitespace trim", () => {
  const v = validateManualSalesDocumentNumber({
    value: "  QT/260809.05  ",
    expectedDocumentType: "QT",
  });
  assert.equal(v.number, "QT/260809.05");
});

await run("Custom number preserves case", () => {
  const v = validateManualSalesDocumentNumber({
    value: "Custom-Qt-100",
    expectedDocumentType: "QT",
  });
  assert.equal(v.number, "Custom-Qt-100");
  assert.equal(v.parsed.isCanonical, false);
});

await run("Counter catch-up — manual .10 advances from 4 to 10; next auto .11", async () => {
  const CounterModel = createMemoryCounter();
  const companyId = "company-mar";
  const instant = new Date("2026-08-09T08:00:00.000Z");
  for (let i = 0; i < 4; i += 1) {
    await generateSalesDocumentNumber({
      companyId,
      documentType: "QT",
      referenceDate: instant,
      CounterModel,
    });
  }
  const model = createModelStore();
  const prepared = await applyManualSalesDocumentNumber({
    companyId,
    documentType: "QT",
    value: "QT/260809.10",
    model,
    field: "quotationNo",
    CounterModel,
  });
  assert.equal(prepared.number, "QT/260809.10");
  assert.equal(await CounterModel.getSeq(companyId, "salesdoc:QT:260809"), 10);
  model.add({ companyId, quotationNo: prepared.number, _id: "1" });
  const next = await generateSalesDocumentNumber({
    companyId,
    documentType: "QT",
    referenceDate: instant,
    CounterModel,
  });
  assert.equal(next, "QT/260809.11");
});

await run("Counter never moves backward — .15 when counter=20 stays 20", async () => {
  const CounterModel = createMemoryCounter();
  const companyId = "company-mar";
  await bumpSalesDocumentCounterToAtLeast({
    companyId,
    documentType: "QT",
    dateToken: "260809",
    sequence: 20,
    CounterModel,
  });
  const model = createModelStore();
  await applyManualSalesDocumentNumber({
    companyId,
    documentType: "QT",
    value: "QT/260809.15",
    model,
    field: "quotationNo",
    CounterModel,
  });
  assert.equal(await CounterModel.getSeq(companyId, "salesdoc:QT:260809"), 20);
  const next = await generateSalesDocumentNumber({
    companyId,
    documentType: "QT",
    referenceDate: new Date("2026-08-09T08:00:00.000Z"),
    CounterModel,
  });
  assert.equal(next, "QT/260809.21");
});

await run("Custom number does not affect counter", async () => {
  const CounterModel = createMemoryCounter();
  const companyId = "company-mar";
  const instant = new Date("2026-08-09T08:00:00.000Z");
  for (let i = 0; i < 4; i += 1) {
    await generateSalesDocumentNumber({
      companyId,
      documentType: "QT",
      referenceDate: instant,
      CounterModel,
    });
  }
  const model = createModelStore();
  await applyManualSalesDocumentNumber({
    companyId,
    documentType: "QT",
    value: "CUSTOM-QT-100",
    model,
    field: "quotationNo",
    CounterModel,
  });
  assert.equal(await CounterModel.getSeq(companyId, "salesdoc:QT:260809"), 4);
  const next = await generateSalesDocumentNumber({
    companyId,
    documentType: "QT",
    referenceDate: instant,
    CounterModel,
  });
  assert.equal(next, "QT/260809.05");
});

await run("Company isolation — MAR catch-up does not affect OKE", async () => {
  const CounterModel = createMemoryCounter();
  const model = createModelStore();
  await applyManualSalesDocumentNumber({
    companyId: "company-mar",
    documentType: "QT",
    value: "QT/260809.10",
    model,
    field: "quotationNo",
    CounterModel,
  });
  const oke = await generateSalesDocumentNumber({
    companyId: "company-oke",
    documentType: "QT",
    referenceDate: new Date("2026-08-09T08:00:00.000Z"),
    CounterModel,
  });
  assert.equal(oke, "QT/260809.01");
});

await run("Document type isolation — QT catch-up does not change PI", async () => {
  const CounterModel = createMemoryCounter();
  const model = createModelStore();
  await applyManualSalesDocumentNumber({
    companyId: "company-mar",
    documentType: "QT",
    value: "QT/260809.10",
    model,
    field: "quotationNo",
    CounterModel,
  });
  const pi = await generateSalesDocumentNumber({
    companyId: "company-mar",
    documentType: "PI",
    referenceDate: new Date("2026-08-09T08:00:00.000Z"),
    CounterModel,
  });
  assert.equal(pi, "PI/260809.01");
});

await run("Date isolation — bump 260809 leaves 260810 unchanged", async () => {
  const CounterModel = createMemoryCounter();
  const model = createModelStore();
  await applyManualSalesDocumentNumber({
    companyId: "company-mar",
    documentType: "QT",
    value: "QT/260809.10",
    model,
    field: "quotationNo",
    CounterModel,
  });
  assert.equal(await CounterModel.getSeq("company-mar", "salesdoc:QT:260809"), 10);
  assert.equal(await CounterModel.getSeq("company-mar", "salesdoc:QT:260810"), 0);
});

await run("Duplicate manual number → 409", async () => {
  const CounterModel = createMemoryCounter();
  const model = createModelStore();
  model.add({ companyId: "company-mar", quotationNo: "QT/260809.05", _id: "a" });
  await assert.rejects(
    () =>
      applyManualSalesDocumentNumber({
        companyId: "company-mar",
        documentType: "QT",
        value: "QT/260809.05",
        model,
        field: "quotationNo",
        CounterModel,
      }),
    (err) => err.statusCode === 409 && /already exists/.test(err.message)
  );
});

await run("Concurrent manual + auto — no duplicate; counter ≥ 10", async () => {
  const CounterModel = createMemoryCounter();
  const companyId = "company-mar";
  const instant = new Date("2026-08-09T08:00:00.000Z");
  for (let i = 0; i < 4; i += 1) {
    await generateSalesDocumentNumber({
      companyId,
      documentType: "QT",
      referenceDate: instant,
      CounterModel,
    });
  }
  const model = createModelStore();
  const [auto, manual] = await Promise.all([
    generateSalesDocumentNumber({
      companyId,
      documentType: "QT",
      referenceDate: instant,
      CounterModel,
    }),
    applyManualSalesDocumentNumber({
      companyId,
      documentType: "QT",
      value: "QT/260809.10",
      model,
      field: "quotationNo",
      CounterModel,
    }).then((r) => r.number),
  ]);
  assert.notEqual(auto, manual);
  assert.equal(manual, "QT/260809.10");
  const seq = await CounterModel.getSeq(companyId, "salesdoc:QT:260809");
  assert.ok(seq >= 10, `expected counter >= 10, got ${seq}`);
  const next = await generateSalesDocumentNumber({
    companyId,
    documentType: "QT",
    referenceDate: instant,
    CounterModel,
  });
  const nextSeq = Number(next.split(".")[1]);
  assert.ok(nextSeq > 10, `expected next > 10, got ${next}`);
});

await run("Peek does not consume counter", async () => {
  const CounterModel = createMemoryCounter();
  const companyId = "company-mar";
  const instant = new Date("2026-08-09T08:00:00.000Z");
  const peek1 = await peekNextSalesDocumentNumber({
    companyId,
    documentType: "QT",
    referenceDate: instant,
    CounterModel,
  });
  const peek2 = await peekNextSalesDocumentNumber({
    companyId,
    documentType: "QT",
    referenceDate: instant,
    CounterModel,
  });
  assert.equal(peek1, "QT/260809.01");
  assert.equal(peek2, "QT/260809.01");
  assert.equal(await CounterModel.getSeq(companyId, "salesdoc:QT:260809"), 0);
  const created = await generateSalesDocumentNumber({
    companyId,
    documentType: "QT",
    referenceDate: instant,
    CounterModel,
  });
  assert.equal(created, "QT/260809.01");
});

await run("Future-dated canonical bumps only matching date key", async () => {
  const CounterModel = createMemoryCounter();
  const model = createModelStore();
  await applyManualSalesDocumentNumber({
    companyId: "company-mar",
    documentType: "QT",
    value: "QT/260810.05",
    model,
    field: "quotationNo",
    CounterModel,
  });
  assert.equal(await CounterModel.getSeq("company-mar", "salesdoc:QT:260810"), 5);
  assert.equal(await CounterModel.getSeq("company-mar", "salesdoc:QT:260809"), 0);
});

await run("Live sources — QT/OA/PI use applyManual; ALLOC/SI invoiceNo not update-editable", () => {
  const qt = fs.readFileSync(path.join(srcRoot, "controllers", "quotationController.js"), "utf8");
  const sales = fs.readFileSync(path.join(srcRoot, "controllers", "salesFlowController.js"), "utf8");
  const sd = fs.readFileSync(path.join(srcRoot, "services", "canonicalSalesDispatchService.js"), "utf8");
  assert.ok(qt.includes("applyManualSalesDocumentNumber"));
  assert.ok(qt.includes("peekNextSalesDocumentNumber"));
  assert.ok(sales.includes('documentType: "OA"'));
  assert.ok(sales.includes('documentType: "PI"'));
  assert.ok(sd.includes('documentType: "SD"'));
  // Allocation / SI: no applyManual for renumber; invoiceNo not in update allowed list
  assert.equal(sales.includes('documentType: "ALLOC"'), false);
  assert.equal(sales.includes('documentType: "SI"'), false);
  assert.ok(!/allowed = \[[^\]]*["']invoiceNo["']/s.test(sales));
  assert.equal(sales.includes("req.body.allocationNo"), false);
  assert.equal(sales.includes("req.body.invoiceNo"), false);
});

await run("SD create path validates manual override; StoreDispatch stays DISPATCH", () => {
  const sd = fs.readFileSync(path.join(srcRoot, "services", "canonicalSalesDispatchService.js"), "utf8");
  const store = fs.readFileSync(path.join(srcRoot, "controllers", "storeOutboundController.js"), "utf8");
  assert.ok(sd.includes("applyManualSalesDocumentNumber"));
  assert.ok(store.includes('docKey: "DISPATCH"'));
  assert.equal(store.includes("applyManualSalesDocumentNumber"), false);
});

await run("CASE A — OA with downstream PI rejects renumber; no counter bump", async () => {
  const CounterModel = createMemoryCounter();
  const companyId = "company-mar";
  await bumpSalesDocumentCounterToAtLeast({
    companyId,
    documentType: "OA",
    dateToken: "260809",
    sequence: 4,
    CounterModel,
  });
  await assert.rejects(
    () =>
      assertSalesDocumentNumberChangeAllowed({
        companyId,
        documentType: "OA",
        documentId: "oa1",
        existsFns: {
          piByOa: async () => true,
          allocByOa: async () => false,
          ciplByOa: async () => false,
          siByOa: async () => false,
        },
      }),
    /downstream documents already reference this OA/
  );
  assert.equal(await CounterModel.getSeq(companyId, "salesdoc:OA:260809"), 4);
});

await run("CASE B — OA with downstream Allocation rejects renumber", async () => {
  await assert.rejects(
    () =>
      assertSalesDocumentNumberChangeAllowed({
        companyId: "company-mar",
        documentType: "OA",
        documentId: "oa1",
        existsFns: {
          piByOa: async () => false,
          allocByOa: async () => true,
          ciplByOa: async () => false,
          siByOa: async () => false,
        },
      }),
    /downstream documents already reference this OA/
  );
});

await run("CASE C — OA no downstream: renumber + catch-up allowed", async () => {
  const CounterModel = createMemoryCounter();
  const companyId = "company-mar";
  const model = createModelStore();
  model.add({ companyId, oaNo: "OA/260809.01", _id: "oa1" });
  await assertSalesDocumentNumberChangeAllowed({
    companyId,
    documentType: "OA",
    documentId: "oa1",
    existsFns: {
      piByOa: async () => false,
      allocByOa: async () => false,
      ciplByOa: async () => false,
      siByOa: async () => false,
    },
  });
  const prepared = await applyManualSalesDocumentNumber({
    companyId,
    documentType: "OA",
    value: "OA/260809.20",
    model,
    field: "oaNo",
    excludeId: "oa1",
    previousNumber: "OA/260809.01",
    CounterModel,
  });
  assert.equal(prepared.number, "OA/260809.20");
  assert.equal(prepared.unchanged, false);
  assert.equal(await CounterModel.getSeq(companyId, "salesdoc:OA:260809"), 20);
});

await run("CASE D — QT with downstream OA rejects renumber", async () => {
  await assert.rejects(
    () =>
      assertSalesDocumentNumberChangeAllowed({
        companyId: "company-mar",
        documentType: "QT",
        documentId: "qt1",
        existsFns: {
          oaByQuotation: async () => true,
          piByQuotation: async () => false,
          allocByQuotation: async () => false,
          ciplByQuotation: async () => false,
          siByQuotation: async () => false,
        },
      }),
    /downstream documents already reference this quotation/
  );
});

await run("CASE E — PI with Allocation rejects renumber", async () => {
  await assert.rejects(
    () =>
      assertSalesDocumentNumberChangeAllowed({
        companyId: "company-mar",
        documentType: "PI",
        documentId: "pi1",
        existsFns: {
          allocByPi: async () => true,
          ciplByPi: async () => false,
          siByPi: async () => false,
        },
      }),
    /Order Allocation already references this Proforma Invoice/
  );
});

await run("CASE F — same number: unchanged, no counter bump", async () => {
  const CounterModel = createMemoryCounter();
  const companyId = "company-mar";
  await bumpSalesDocumentCounterToAtLeast({
    companyId,
    documentType: "OA",
    dateToken: "260809",
    sequence: 5,
    CounterModel,
  });
  const model = createModelStore();
  model.add({ companyId, oaNo: "OA/260809.05", _id: "oa1" });
  const prepared = await applyManualSalesDocumentNumber({
    companyId,
    documentType: "OA",
    value: "  oa/260809.05  ",
    model,
    field: "oaNo",
    excludeId: "oa1",
    previousNumber: "OA/260809.05",
    CounterModel,
  });
  assert.equal(prepared.unchanged, true);
  assert.equal(prepared.number, "OA/260809.05");
  assert.equal(await CounterModel.getSeq(companyId, "salesdoc:OA:260809"), 5);
});

await run("Controllers call downstream guard before applyManual on number change", () => {
  const qt = fs.readFileSync(path.join(srcRoot, "controllers", "quotationController.js"), "utf8");
  const sales = fs.readFileSync(path.join(srcRoot, "controllers", "salesFlowController.js"), "utf8");
  assert.ok(qt.includes("assertSalesDocumentNumberChangeAllowed"));
  assert.ok(sales.includes("assertSalesDocumentNumberChangeAllowed"));
  // Guard appears before applyManual in update paths (ordering check by index)
  const oaIdxGuard = sales.indexOf('documentType: "OA"');
  const oaIdxApply = sales.indexOf("applyManualSalesDocumentNumber", sales.indexOf("export async function updateOA"));
  const oaGuard = sales.indexOf("assertSalesDocumentNumberChangeAllowed", sales.indexOf("export async function updateOA"));
  assert.ok(oaGuard > 0 && oaIdxApply > oaGuard, "OA update must guard before applyManual");
  void oaIdxGuard;
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
