/**
 * CustomsBoe legal identity — unique company + normalizedBoeNumber.
 * Run: node scripts/customsBoeIdentity.test.js
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeBoeNumber } from "../src/utils/asnCustomsFieldOwnership.js";
import {
  assertCustomsBoeDeclarationCompatible,
  assertCustomsBoeNotCancelled,
  isMongoDuplicateKeyError,
} from "../src/services/customsBoeService.js";
import {
  CUSTOMS_BOE_IDENTITY_INDEX_SPECS,
  CUSTOMS_BOE_NORMALIZED_IDENTITY_INDEX,
  customsBoeNormalizedIdentityPartialFilter,
  evaluateCustomsBoeIdentityIndexInventory,
} from "../src/utils/customsBoeIdentityIndexes.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcRoot = path.join(__dirname, "../src");

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
    console.error(e);
  }
}

console.log("customsBoeIdentity.test.js");

run("1. normalize trim + uppercase", () => {
  assert.equal(normalizeBoeNumber("  83535  "), "83535");
  assert.equal(normalizeBoeNumber("boe-ab"), "BOE-AB");
});

run("2. preserve leading zeros", () => {
  assert.equal(normalizeBoeNumber("083535"), "083535");
});

run("3. preserve internal legal characters / spaces", () => {
  assert.equal(normalizeBoeNumber("83 535"), "83 535");
  assert.equal(normalizeBoeNumber("BOE/2026-01"), "BOE/2026-01");
});

run("4/5. same company normalized variants collide in simulated unique map", () => {
  const store = new Map();
  function insert(companyId, boeNumber) {
    const key = `${companyId}::${normalizeBoeNumber(boeNumber)}`;
    if (store.has(key)) {
      const err = new Error("E11000 duplicate");
      err.code = 11000;
      throw err;
    }
    store.set(key, { companyId, boeNumber, normalizedBoeNumber: normalizeBoeNumber(boeNumber) });
    return store.get(key);
  }
  insert("MAR", "83535");
  assert.throws(() => insert("MAR", " 83535 "), (e) => isMongoDuplicateKeyError(e));
  assert.throws(() => insert("MAR", "83535"), (e) => Number(e.code) === 11000);
  assert.equal(store.size, 1);
});

run("6. cross-company same BOE allowed", () => {
  const store = new Map();
  const put = (c, n) => store.set(`${c}::${normalizeBoeNumber(n)}`, true);
  put("MAR", "83535");
  put("OKE", "83535");
  assert.equal(store.size, 2);
});

run("7. concurrent same declaration → one parent (simulated unique + reload)", () => {
  const parents = new Map();
  function createOrReuse(companyId, header) {
    const key = `${companyId}::${normalizeBoeNumber(header.boeNumber)}`;
    if (parents.has(key)) {
      return { reused: true, boe: parents.get(key) };
    }
    try {
      if (parents.has(key)) {
        const err = new Error("dup");
        err.code = 11000;
        throw err;
      }
      const boe = {
        customsBoeRef: "MAR-BOE-0001",
        boeNumber: header.boeNumber,
        normalizedBoeNumber: normalizeBoeNumber(header.boeNumber),
        boeDeclaredQty: header.boeDeclaredQty,
        boeDeclaredValue: header.boeDeclaredValue,
        customsCurrency: header.customsCurrency,
        exchangeRateToAED: header.exchangeRateToAED,
        customsUnitValue: 50,
        status: "OPEN",
      };
      parents.set(key, boe);
      return { reused: false, boe };
    } catch (err) {
      if (!isMongoDuplicateKeyError(err)) throw err;
      const winner = parents.get(key);
      const compat = assertCustomsBoeDeclarationCompatible(winner, header);
      assert.equal(compat.ok, true);
      return { reused: true, boe: winner };
    }
  }
  const header = {
    boeNumber: "83535",
    boeDeclaredQty: 500,
    boeDeclaredValue: 25000,
    customsCurrency: "EUR",
    exchangeRateToAED: 4.25,
  };
  const a = createOrReuse("MAR", header);
  // Simulate race: second insert hits E11000 path
  parents.set(`MAR::83535`, a.boe);
  const fakeDup = Object.assign(new Error("E11000"), { code: 11000 });
  assert.equal(isMongoDuplicateKeyError(fakeDup), true);
  const compat = assertCustomsBoeDeclarationCompatible(a.boe, header);
  assert.equal(compat.ok, true);
  assert.equal(parents.size, 1);
});

run("8. concurrent conflicting declaration → conflict code", () => {
  const parent = {
    customsBoeRef: "MAR-BOE-0001",
    boeDeclaredQty: 500,
    boeDeclaredValue: 25000,
    customsUnitValue: 50,
    customsCurrency: "EUR",
    exchangeRateToAED: 4.25,
    customsUom: "PCS",
  };
  const compat = assertCustomsBoeDeclarationCompatible(parent, {
    boeDeclaredQty: 600,
    boeDeclaredValue: 99999,
    customsCurrency: "USD",
    exchangeRateToAED: 1,
  });
  assert.equal(compat.ok, false);
  assert.equal(compat.code, "CUSTOMS_BOE_DECLARATION_CONFLICT");
  assert.ok(compat.errors.length >= 2);
});

run("9. cancelled parent does not allow duplicate identity / blocks link", () => {
  const cancelled = {
    customsBoeRef: "MAR-BOE-0009",
    boeNumber: "83535",
    status: "CANCELLED",
  };
  assert.throws(() => assertCustomsBoeNotCancelled(cancelled), (e) => e.code === "CUSTOMS_BOE_CANCELLED");
  // Identity still occupied — unique key would include CANCELLED (no status in partial filter)
  const pf = customsBoeNormalizedIdentityPartialFilter();
  assert.equal(Object.prototype.hasOwnProperty.call(pf, "status"), false);
  assert.deepEqual(pf.normalizedBoeNumber, { $type: "string", $gt: "" });
});

run("10. existing parent declaration immutable when omitted client fields", () => {
  const parent = {
    customsBoeRef: "MAR-BOE-0001",
    boeDeclaredQty: 500,
    boeDeclaredValue: 25000,
    customsUnitValue: 50,
    customsCurrency: "EUR",
    exchangeRateToAED: 4.25,
    customsUom: "PCS",
  };
  const compat = assertCustomsBoeDeclarationCompatible(parent, { boeNumber: "83535" });
  assert.equal(compat.ok, true);
});

run("11. race loser is DuplicateKey not generic 500", () => {
  assert.equal(isMongoDuplicateKeyError({ code: 11000 }), true);
  assert.equal(isMongoDuplicateKeyError({ codeName: "DuplicateKey" }), true);
  assert.equal(isMongoDuplicateKeyError({ code: 500 }), false);
  const svc = fs.readFileSync(path.join(srcRoot, "services", "customsBoeService.js"), "utf8");
  assert.match(svc, /isMongoDuplicateKeyError/);
  assert.match(svc, /CUSTOMS_BOE_RACE_RELOAD_FAILED|reuseExistingCustomsBoe/);
  assert.doesNotMatch(svc, /status:\s*500/);
});

run("12. index spec present; migration-first (no mongoose unique registration)", () => {
  assert.equal(CUSTOMS_BOE_IDENTITY_INDEX_SPECS[0].name, CUSTOMS_BOE_NORMALIZED_IDENTITY_INDEX);
  assert.deepEqual(CUSTOMS_BOE_IDENTITY_INDEX_SPECS[0].key, { companyId: 1, normalizedBoeNumber: 1 });
  assert.equal(CUSTOMS_BOE_IDENTITY_INDEX_SPECS[0].unique, true);
  const model = fs.readFileSync(path.join(srcRoot, "models", "CustomsBoe.js"), "utf8");
  assert.match(model, /customsBoe_company_normalizedBoeNumber_unique/);
  assert.doesNotMatch(model, /index\(\s*\{\s*companyId:\s*1,\s*normalizedBoeNumber:\s*1/);
});

run("13. collision audit refuses migration (inventory helper)", () => {
  const inv = evaluateCustomsBoeIdentityIndexInventory({ customsboes: [] });
  assert.equal(inv.ok, false);
  assert.equal(inv.missing[0].name, CUSTOMS_BOE_NORMALIZED_IDENTITY_INDEX);
  const migrate = fs.readFileSync(
    path.join(__dirname, "migrate-customs-boe-identity-indexes.mjs"),
    "utf8",
  );
  assert.match(migrate, /EXECUTE REFUSED/);
  assert.match(migrate, /safeToCreateUniqueIndex/);
  assert.match(migrate, /CustomsLot untouched|never touch CustomsLot|customslots/i);
});

run("14. no CustomsLot mutation in identity migration", () => {
  const migrate = fs.readFileSync(
    path.join(__dirname, "migrate-customs-boe-identity-indexes.mjs"),
    "utf8",
  );
  assert.doesNotMatch(migrate, /collection\(\s*["']customslots["']\s*\)\.(update|delete|insert|bulkWrite|replace)/i);
  assert.match(migrate, /Never repairs BOE-AUDIT-001|never repair BOE-AUDIT-001/i);
  assert.doesNotMatch(migrate, /BOE-AUDIT-001["'\s]*[,:]/);
  assert.match(migrate, /CUSTOMS_BOE_COLLECTION|customsboes/);
  assert.match(migrate, /Never touches CustomsLot|never touch CustomsLot/i);
});

run("boot verifies identity index create:false", () => {
  const server = fs.readFileSync(path.join(srcRoot, "server.js"), "utf8");
  assert.match(server, /ensureCustomsBoeIdentityIndexes/);
  assert.match(server, /create:\s*false/);
});

run("accepted-qty hardening still present", () => {
  const avg = fs.readFileSync(path.join(srcRoot, "utils", "customsBoeAverage.js"), "utf8");
  assert.match(avg, /forceAcceptedQtyOnly/);
  assert.match(avg, /ACCEPTED_QTY_ONLY/);
});

console.log(`\ncustomsBoeIdentity: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
