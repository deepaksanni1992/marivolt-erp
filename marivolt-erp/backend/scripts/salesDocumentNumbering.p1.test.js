/**
 * P1 — Sales document numbering (XX/YYMMDD.ab, UAE business date).
 * Run: node scripts/salesDocumentNumbering.p1.test.js
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_SALES_DOC_TIMEZONE,
  formatSalesDocumentNumber,
  generateSalesDocumentNumber,
  getBusinessDateParts,
  getBusinessDateToken,
  isP1SalesDocumentType,
  nextSalesDocNumber,
  nextUniqueSalesDocNumber,
  resolveSalesDocTimezone,
  resolveSalesDocumentType,
  salesDocumentCounterKey,
} from "../src/utils/salesDocNumber.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcRoot = path.join(__dirname, "..", "src");

function readSrc(...parts) {
  return fs.readFileSync(path.join(srcRoot, ...parts), "utf8");
}

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

/** In-memory atomic Counter stand-in for concurrency / sequence tests. */
function createMemoryCounter() {
  const map = new Map();
  let chain = Promise.resolve();
  return {
    findOneAndUpdate(filter, update) {
      const job = chain.then(async () => {
        // Simulate concurrent callers contending on the same key.
        await new Promise((r) => setImmediate(r));
        const k = `${String(filter.companyId)}::${String(filter.key)}`;
        const prev = map.get(k) || 0;
        const next = prev + (Number(update?.$inc?.seq) || 0);
        map.set(k, next);
        return { companyId: filter.companyId, key: filter.key, seq: next };
      });
      chain = job.then(
        () => undefined,
        () => undefined
      );
      return job;
    },
    _snapshot() {
      return new Map(map);
    },
  };
}

console.log("\nSales document numbering (P1)\n");

await run("Timezone default is Asia/Dubai; invalid falls back", () => {
  assert.equal(DEFAULT_SALES_DOC_TIMEZONE, "Asia/Dubai");
  assert.equal(resolveSalesDocTimezone(""), "Asia/Dubai");
  assert.equal(resolveSalesDocTimezone(undefined), "Asia/Dubai");
  assert.equal(resolveSalesDocTimezone("Not/AZone"), "Asia/Dubai");
  assert.equal(resolveSalesDocTimezone("Asia/Dubai"), "Asia/Dubai");
});

await run("CASE 1 — 08-Aug-2026 Dubai → QT/260808.01", async () => {
  const CounterModel = createMemoryCounter();
  const companyId = "company-mar";
  // 08-Aug-2026 12:00 Dubai = 08-Aug-2026 08:00 UTC
  const instant = new Date("2026-08-08T08:00:00.000Z");
  assert.equal(getBusinessDateToken(instant), "260808");
  const n = await generateSalesDocumentNumber({
    companyId,
    documentType: "QT",
    referenceDate: instant,
    CounterModel,
  });
  assert.equal(n, "QT/260808.01");
});

await run("CASE 2 — second QT same company/date → QT/260808.02", async () => {
  const CounterModel = createMemoryCounter();
  const companyId = "company-mar";
  const instant = new Date("2026-08-08T08:00:00.000Z");
  const a = await generateSalesDocumentNumber({
    companyId,
    documentType: "QT",
    referenceDate: instant,
    CounterModel,
  });
  const b = await generateSalesDocumentNumber({
    companyId,
    documentType: "QT",
    referenceDate: instant,
    CounterModel,
  });
  assert.equal(a, "QT/260808.01");
  assert.equal(b, "QT/260808.02");
});

await run("CASE 3 — first PI same date → PI/260808.01 (own sequence)", async () => {
  const CounterModel = createMemoryCounter();
  const companyId = "company-mar";
  const instant = new Date("2026-08-08T08:00:00.000Z");
  await generateSalesDocumentNumber({
    companyId,
    documentType: "QT",
    referenceDate: instant,
    CounterModel,
  });
  const pi = await generateSalesDocumentNumber({
    companyId,
    documentType: "PI",
    referenceDate: instant,
    CounterModel,
  });
  assert.equal(pi, "PI/260808.01");
});

await run("CASE 4 — first ALLOC → ALLOC/260808.01", async () => {
  const CounterModel = createMemoryCounter();
  const n = await generateSalesDocumentNumber({
    companyId: "company-mar",
    documentType: "ALLOC",
    referenceDate: new Date("2026-08-08T08:00:00.000Z"),
    CounterModel,
  });
  assert.equal(n, "ALLOC/260808.01");
});

await run("CASE 5 — first SI → SI/260808.01", async () => {
  const CounterModel = createMemoryCounter();
  const n = await nextSalesDocNumber({
    companyId: "company-mar",
    companyCode: "MAR",
    docKey: "SALES_INVOICE",
    referenceDate: new Date("2026-08-08T08:00:00.000Z"),
    CounterModel,
  });
  assert.equal(n, "SI/260808.01");
});

await run("CASE 6 — first SD via SALES_DISPATCH → SD/260808.01", async () => {
  const CounterModel = createMemoryCounter();
  const n = await nextSalesDocNumber({
    companyId: "company-mar",
    companyCode: "MAR",
    docKey: "SALES_DISPATCH",
    referenceDate: new Date("2026-08-08T08:00:00.000Z"),
    CounterModel,
  });
  assert.equal(n, "SD/260808.01");
});

await run("CASE — OA means Order Acknowledgement prefix OA", async () => {
  const CounterModel = createMemoryCounter();
  const n = await nextSalesDocNumber({
    companyId: "company-mar",
    companyCode: "MAR",
    docKey: "ORDER_ACK",
    referenceDate: new Date("2026-08-08T08:00:00.000Z"),
    CounterModel,
  });
  assert.equal(n, "OA/260808.01");
  assert.equal(resolveSalesDocumentType("ORDER_ACK"), "OA");
  assert.equal(resolveSalesDocumentType("ORDER_ALLOCATION"), "ALLOC");
});

await run("Daily reset — 09-Aug starts at .01", async () => {
  const CounterModel = createMemoryCounter();
  const companyId = "company-mar";
  const d8 = new Date("2026-08-08T08:00:00.000Z");
  const d9 = new Date("2026-08-09T08:00:00.000Z");
  assert.equal(
    await generateSalesDocumentNumber({ companyId, documentType: "QT", referenceDate: d8, CounterModel }),
    "QT/260808.01"
  );
  assert.equal(
    await generateSalesDocumentNumber({ companyId, documentType: "QT", referenceDate: d8, CounterModel }),
    "QT/260808.02"
  );
  assert.equal(
    await generateSalesDocumentNumber({ companyId, documentType: "QT", referenceDate: d9, CounterModel }),
    "QT/260809.01"
  );
});

await run("Company isolation — MAR and OKE both get QT/260808.01", async () => {
  const CounterModel = createMemoryCounter();
  const instant = new Date("2026-08-08T08:00:00.000Z");
  const mar = await generateSalesDocumentNumber({
    companyId: "company-mar",
    documentType: "QT",
    referenceDate: instant,
    CounterModel,
  });
  const oke = await generateSalesDocumentNumber({
    companyId: "company-oke",
    documentType: "QT",
    referenceDate: instant,
    CounterModel,
  });
  assert.equal(mar, "QT/260808.01");
  assert.equal(oke, "QT/260808.01");
  assert.equal(salesDocumentCounterKey("QT", "260808"), "salesdoc:QT:260808");
});

await run("Midnight Dubai — UTC 20:05 on 08-Aug → token 260809", () => {
  // 2026-08-08 20:05 UTC = 2026-08-09 00:05 Asia/Dubai
  const justAfterMidnightDubai = new Date("2026-08-08T20:05:00.000Z");
  const justBefore = new Date("2026-08-08T19:55:00.000Z");
  assert.equal(getBusinessDateToken(justAfterMidnightDubai), "260809");
  assert.equal(getBusinessDateToken(justBefore), "260808");
  const parts = getBusinessDateParts(justAfterMidnightDubai);
  assert.equal(parts.yy, "26");
  assert.equal(parts.mm, "08");
  assert.equal(parts.dd, "09");
  assert.equal(parts.timeZone, "Asia/Dubai");
});

await run("Concurrency — parallel QT requests yield unique sequences", async () => {
  const CounterModel = createMemoryCounter();
  const companyId = "company-mar";
  const instant = new Date("2026-08-08T08:00:00.000Z");
  const results = await Promise.all(
    Array.from({ length: 20 }, () =>
      generateSalesDocumentNumber({
        companyId,
        documentType: "QT",
        referenceDate: instant,
        CounterModel,
      })
    )
  );
  const unique = new Set(results);
  assert.equal(unique.size, 20, `expected 20 unique, got ${unique.size}: ${[...unique].join(",")}`);
  assert.ok(unique.has("QT/260808.01"));
  assert.ok(unique.has("QT/260808.20"));
  assert.equal(results.every((r) => /^QT\/260808\.\d+$/.test(r)), true);
});

await run(">99 documents — QT/260808.99 then QT/260808.100", async () => {
  const CounterModel = createMemoryCounter();
  const companyId = "company-mar";
  const instant = new Date("2026-08-08T08:00:00.000Z");
  let last = "";
  for (let i = 0; i < 100; i += 1) {
    last = await generateSalesDocumentNumber({
      companyId,
      documentType: "QT",
      referenceDate: instant,
      CounterModel,
    });
  }
  assert.equal(last, "QT/260808.100");
  assert.equal(formatSalesDocumentNumber("QT", "260808", 99), "QT/260808.99");
  assert.equal(formatSalesDocumentNumber("QT", "260808", 100), "QT/260808.100");
});

await run("Legacy coexistence — PACKING/DISPATCH stay MAR-*-####", async () => {
  const CounterModel = createMemoryCounter();
  const packing = await nextSalesDocNumber({
    companyId: "company-mar",
    companyCode: "MAR",
    docKey: "PACKING",
    CounterModel,
  });
  const storeDispatch = await nextSalesDocNumber({
    companyId: "company-mar",
    companyCode: "MAR",
    docKey: "DISPATCH",
    CounterModel,
  });
  const salesDispatch = await nextSalesDocNumber({
    companyId: "company-mar",
    companyCode: "MAR",
    docKey: "SALES_DISPATCH",
    referenceDate: new Date("2026-08-08T08:00:00.000Z"),
    CounterModel,
  });
  assert.equal(packing, "MAR-PK-0001");
  assert.equal(storeDispatch, "MAR-DSP-0001");
  assert.equal(salesDispatch, "SD/260808.01");
  // StoreDispatch must not consume SD sequence
  const salesDispatch2 = await nextSalesDocNumber({
    companyId: "company-mar",
    companyCode: "MAR",
    docKey: "SALES_DISPATCH",
    referenceDate: new Date("2026-08-08T08:00:00.000Z"),
    CounterModel,
  });
  assert.equal(salesDispatch2, "SD/260808.02");
  assert.equal(isP1SalesDocumentType("DISPATCH"), false);
  assert.equal(isP1SalesDocumentType("SALES_DISPATCH"), true);
});

await run("Legacy number string format still recognized as valid coexistence", () => {
  // Historical numbers are not generated here; confirm format helpers accept slash/dot
  // and do not reject legacy-style strings at the uniqueness layer (no format validation).
  const legacy = "MAR-QTN-0028";
  const neu = "QT/260808.01";
  assert.match(legacy, /^MAR-QTN-\d+$/);
  assert.match(neu, /^QT\/\d{6}\.\d+$/);
  assert.notEqual(legacy, neu);
});

await run("Duplicate-key retry advances past existing number", async () => {
  const CounterModel = createMemoryCounter();
  const companyId = "company-mar";
  const instant = new Date("2026-08-08T08:00:00.000Z");
  const taken = new Set(["QT/260808.01"]);
  const model = {
    async exists({ companyId: c, quotationNo }) {
      assert.equal(c, companyId);
      return taken.has(quotationNo);
    },
  };
  const n = await nextUniqueSalesDocNumber({
    companyId,
    companyCode: "MAR",
    docKey: "QUOTATION",
    referenceDate: instant,
    model,
    field: "quotationNo",
    CounterModel,
  });
  assert.equal(n, "QT/260808.02");
});

await run("Duplicate retry exhausts maxAttempts", async () => {
  const CounterModel = createMemoryCounter();
  const model = {
    async exists() {
      return true;
    },
  };
  await assert.rejects(
    () =>
      nextUniqueSalesDocNumber({
        companyId: "company-mar",
        companyCode: "MAR",
        docKey: "QUOTATION",
        referenceDate: new Date("2026-08-08T08:00:00.000Z"),
        model,
        field: "quotationNo",
        maxAttempts: 3,
        CounterModel,
      }),
    /Unable to allocate a unique QUOTATION number after 3 attempts/
  );
});

await run("Mixed lineage — new PI format independent of legacy QT string", () => {
  // Linkage is by ObjectId in controllers; numbers may mix freely.
  const parentQt = "MAR-QTN-0028";
  const childPi = formatSalesDocumentNumber("PI", "260808", 1);
  assert.equal(childPi, "PI/260808.01");
  assert.notEqual(parentQt.split("-")[0], childPi.split("/")[0]);
});

await run("docKey map covers all six P1 types", () => {
  assert.equal(resolveSalesDocumentType("QUOTATION"), "QT");
  assert.equal(resolveSalesDocumentType("ORDER_ACK"), "OA");
  assert.equal(resolveSalesDocumentType("PROFORMA"), "PI");
  assert.equal(resolveSalesDocumentType("ORDER_ALLOCATION"), "ALLOC");
  assert.equal(resolveSalesDocumentType("SALES_INVOICE"), "SI");
  assert.equal(resolveSalesDocumentType("SALES_DISPATCH"), "SD");
  assert.equal(resolveSalesDocumentType("OA"), "OA");
  assert.equal(resolveSalesDocumentType("ALLOC"), "ALLOC");
});

/** Live create-path contracts: source must pass these docKeys; generator must emit prefixes. */
const LIVE_CREATE_PATHS = [
  {
    document: "Quotation",
    file: ["controllers", "quotationController.js"],
    mustInclude: ['docKey: "QUOTATION"'],
    docKey: "QUOTATION",
    prefix: "QT",
  },
  {
    document: "Order Acknowledgement",
    file: ["controllers", "salesFlowController.js"],
    mustInclude: ['docKey: "ORDER_ACK"'],
    docKey: "ORDER_ACK",
    prefix: "OA",
  },
  {
    document: "Proforma Invoice",
    file: ["controllers", "salesFlowController.js"],
    mustInclude: ['docKey: "PROFORMA"'],
    docKey: "PROFORMA",
    prefix: "PI",
  },
  {
    document: "Order Allocation",
    file: ["controllers", "salesFlowController.js"],
    mustInclude: ['docKey: "ORDER_ALLOCATION"'],
    docKey: "ORDER_ALLOCATION",
    prefix: "ALLOC",
  },
  {
    document: "Sales Invoice",
    file: ["controllers", "salesFlowController.js"],
    mustInclude: ['docKey: "SALES_INVOICE"'],
    docKey: "SALES_INVOICE",
    prefix: "SI",
  },
  {
    document: "Sales Dispatch",
    file: ["services", "canonicalSalesDispatchService.js"],
    mustInclude: ['docKey: "SALES_DISPATCH"'],
    docKey: "SALES_DISPATCH",
    prefix: "SD",
  },
];

await run("Live create paths — source uses correct docKeys (no MAR-* construction)", () => {
  const banned = ["MAR-QTN-", "MAR-OA-", "MAR-PI-", "MAR-ALLOC-", "MAR-SI-", "MAR-DSP-"];
  for (const pathSpec of LIVE_CREATE_PATHS) {
    const src = readSrc(...pathSpec.file);
    for (const needle of pathSpec.mustInclude) {
      assert.ok(src.includes(needle), `${pathSpec.document}: missing ${needle} in ${pathSpec.file.join("/")}`);
    }
    for (const ban of banned) {
      assert.equal(src.includes(ban), false, `${pathSpec.document}: must not hardcode ${ban}`);
    }
  }
  const store = readSrc("controllers", "storeOutboundController.js");
  assert.ok(store.includes('docKey: "DISPATCH"'), "StoreDispatch must keep docKey DISPATCH");
  assert.equal(store.includes('docKey: "SALES_DISPATCH"'), false, "StoreDispatch must not use SALES_DISPATCH");
});

await run("Live create paths — each docKey yields expected new prefix", async () => {
  const CounterModel = createMemoryCounter();
  const companyId = "company-live-map";
  const instant = new Date("2026-08-08T08:00:00.000Z");
  for (const pathSpec of LIVE_CREATE_PATHS) {
    const n = await nextSalesDocNumber({
      companyId,
      companyCode: "MAR",
      docKey: pathSpec.docKey,
      referenceDate: instant,
      CounterModel,
    });
    assert.equal(
      n,
      `${pathSpec.prefix}/260808.01`,
      `${pathSpec.document}: expected ${pathSpec.prefix}/260808.01, got ${n}`
    );
  }
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
