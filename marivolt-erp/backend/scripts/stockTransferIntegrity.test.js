/**
 * Stock transfer effectKey + derived available filtering regression tests (no DB).
 * Run: node scripts/stockTransferIntegrity.test.js
 */
import assert from "assert";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { buildPhysicalEffectKey } from "../src/services/stockExpectedBuckets.js";

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

function deriveAvailable(row) {
  const phys = Number(row.onHandQty ?? row.quantity) || 0;
  const resq = Math.max(Number(row.allocatedQty) || 0, Number(row.reservedQty) || 0);
  const packed = Number(row.packedQty) || 0;
  return phys - resq - packed;
}

function transferKeys({
  companyId = "c1",
  transferNo = "TRF-0001",
  article = "ART1",
  fromWh = "MAIN",
  toWh = "WH2",
  lineId = "line1",
  qty = 5,
  reverse = false,
}) {
  const out = buildPhysicalEffectKey({
    movementType: "STOCK_TRANSFER_OUT",
    companyId,
    referenceNo: transferNo,
    article,
    warehouse: reverse ? toWh : fromWh,
    lineId,
    qty,
    extra: reverse ? `REV:TO:${fromWh}` : `TO:${toWh}`,
  });
  const inn = buildPhysicalEffectKey({
    movementType: "STOCK_TRANSFER_IN",
    companyId,
    referenceNo: transferNo,
    article,
    warehouse: reverse ? fromWh : toWh,
    lineId,
    qty,
    extra: reverse ? `REV:FROM:${toWh}` : `FROM:${fromWh}`,
  });
  return { out, inn };
}

// --- EffectKey uniqueness / determinism ---
{
  const a = transferKeys({});
  const b = transferKeys({});
  ok("Transfer OUT/IN keys deterministic (first = retry)", a.out === b.out && a.inn === b.inn);
  ok("Transfer OUT ≠ IN", a.out !== a.inn);
  ok("OUT embeds STOCK_TRANSFER_OUT", a.out.includes("STOCK_TRANSFER_OUT"));
  ok("IN embeds STOCK_TRANSFER_IN", a.inn.includes("STOCK_TRANSFER_IN"));
  ok("OUT embeds from warehouse MAIN", a.out.includes(":MAIN:"));
  ok("OUT embeds TO:WH2", a.out.includes("TO:WH2"));
  ok("IN embeds FROM:MAIN", a.inn.includes("FROM:MAIN"));
}

{
  const post = transferKeys({ lineId: "idA" });
  const replay = transferKeys({ lineId: "idA" });
  const otherLine = transferKeys({ lineId: "idB" });
  ok("Duplicate replay same keys", post.out === replay.out && post.inn === replay.inn);
  ok("Different transferLineId → different keys", post.out !== otherLine.out);
}

{
  const post = transferKeys({});
  const rev = transferKeys({ reverse: true });
  ok("Cancel/reversal OUT key ≠ post OUT", rev.out !== post.out);
  ok("Cancel/reversal IN key ≠ post IN", rev.inn !== post.inn);
  ok("Reversal keys contain REV", rev.out.includes("REV:") && rev.inn.includes("REV:"));
}

{
  const concurrent = [transferKeys({}), transferKeys({}), transferKeys({})];
  ok(
    "Concurrent replay same effectKeys",
    concurrent.every((k) => k.out === concurrent[0].out && k.inn === concurrent[0].inn)
  );
}

// --- Source wiring ---
{
  const stockService = read("src/services/stockService.js");
  const stockCtrl = read("src/controllers/stockController.js");
  const invCtrl = read("src/controllers/inventoryController.js");

  ok("stockTransfer uses resolvePhysicalEffectKey / effectKey", /STOCK_TRANSFER_OUT[\s\S]*effectKey/.test(stockService));
  ok("stockTransfer soft-idempotent findLedgerByEffectKey", /stockTransfer[\s\S]*findLedgerByEffectKey/.test(stockService));
  ok("reverseStockTransfer exported", /export async function reverseStockTransfer/.test(stockService));
  ok("reverseStockTransfer uses REV extras", /REV:TO:/.test(stockService) && /REV:FROM:/.test(stockService));
  ok("postTransfer passes transferLineId from document _id", /transferLineId: String\(row\._id\)/.test(stockCtrl));
  ok("listStockBalance does not Mongo-filter stored availableQty", !/filter\.availableQty\s*=/.test(stockCtrl));
  ok("listStockBalance derives then filters availableOnly", /availableOnly[\s\S]*availableQty > 0/.test(stockCtrl));
  ok("inventory listBalances never trusts stored available for filter", !/filter\.availableQty/.test(invCtrl));
  ok("inventory listBalances derives available", /deriveStockBuckets/.test(invCtrl) || /phys - resq - packed/.test(invCtrl));
}

// --- Derived available filtering ---
{
  const rows = [
    {
      companyId: "c1",
      itemCode: "A",
      warehouse: "MAIN",
      onHandQty: 10,
      reservedQty: 0,
      packedQty: 0,
      availableQty: 0, // stale stored
    },
    {
      companyId: "c1",
      itemCode: "B",
      warehouse: "MAIN",
      onHandQty: 10,
      reservedQty: 4,
      packedQty: 3,
      availableQty: 99, // stale high
    },
    {
      companyId: "c1",
      itemCode: "C",
      warehouse: "WH2",
      onHandQty: 5,
      reservedQty: 5,
      packedQty: 0,
      availableQty: 5, // stale positive but derived 0
    },
    {
      companyId: "c2",
      itemCode: "A",
      warehouse: "MAIN",
      onHandQty: 8,
      reservedQty: 0,
      packedQty: 0,
      availableQty: 0,
    },
  ];

  const derived = rows.map((r) => ({ ...r, availableQty: deriveAvailable(r) }));
  ok("Stored stale 0 but onHand 10 → derived 10", derived[0].availableQty === 10);
  ok("Reserved+packed subtracted: 10-4-3=3", derived[1].availableQty === 3);
  ok("Fully reserved → derived 0", derived[2].availableQty === 0);

  const availableOnly = derived.filter((r) => r.availableQty > 0);
  ok("availableOnly excludes derived-zero C", !availableOnly.some((r) => r.itemCode === "C"));
  ok("availableOnly includes A despite stale stored 0", availableOnly.some((r) => r.itemCode === "A" && r.companyId === "c1"));
  ok("availableOnly includes B with packed/reserved", availableOnly.some((r) => r.itemCode === "B"));

  const companyScope = derived.filter((r) => r.companyId === "c1" && r.availableQty > 0);
  ok("Company scope c1 only", companyScope.every((r) => r.companyId === "c1") && companyScope.length === 2);

  const whMain = derived.filter((r) => r.warehouse === "MAIN" && r.availableQty > 0);
  ok("Mixed warehouse filter MAIN", whMain.every((r) => r.warehouse === "MAIN") && whMain.length === 3);

  const reservedOnly = derived.filter((r) => Math.max(r.reservedQty || 0, 0) > 0);
  ok("Reserved rows present", reservedOnly.some((r) => r.itemCode === "B"));
  const packedOnly = derived.filter((r) => (r.packedQty || 0) > 0);
  ok("Packed rows present", packedOnly.some((r) => r.itemCode === "B"));
}

console.log(`\n${passed} assertions passed`);
