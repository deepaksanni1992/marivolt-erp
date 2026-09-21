/**
 * MAN engine product-line access tests.
 * Run: node scripts/manEngineAccess.security.test.js
 */
import assert from "node:assert/strict";
import {
  MAN_ENGINE_DENIED,
  ManEngineAccessError,
  assertManEngineWriteAccess,
} from "../src/utils/manEngineAccess.js";
import { getDefaultPermissionsForRole } from "../src/services/roleService.js";

let passed = 0;
let failed = 0;

function run(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed += 1;
      console.log(`  ✓ ${name}`);
    })
    .catch((e) => {
      failed += 1;
      console.error(`  ✗ ${name}`);
      console.error(`    ${e.message}`);
    });
}

function reqForRole(role, companyId = "c1") {
  return {
    companyId,
    user: { role, id: "u1" },
    _permissions: getDefaultPermissionsForRole(role),
  };
}

await run("Purchase & Sales is allowed to write non-MAN lines", async () => {
  await assertManEngineWriteAccess(reqForRole("purchase_sales"), {
    lines: [{ article: "WART-1", brand: "Wartsila", engine: "Wartsila" }],
    header: { brand: "Wartsila" },
  }, { findItems: async () => [{ article: "WART-1", brand: "Wartsila", engine: "Wartsila" }] });
});

await run("Purchase & Sales is denied MAN RFQ source documents", async () => {
  await assert.rejects(
    () =>
      assertManEngineWriteAccess(reqForRole("purchase_sales"), {
        lines: [{ article: "X1" }],
        sourceType: "MAN_RFQ",
      }, { findItems: async () => [] }),
    (err) => err instanceof ManEngineAccessError && err.code === MAN_ENGINE_DENIED && err.statusCode === 403
  );
});

await run("Purchase & Sales is denied MAN brand lines without Item Master hit", async () => {
  await assert.rejects(
    () =>
      assertManEngineWriteAccess(reqForRole("purchase_sales"), {
        lines: [{ article: "MAN-1", brand: "MAN" }],
      }, { findItems: async () => [] }),
    (err) => err instanceof ManEngineAccessError && /MAN-1/.test(err.message)
  );
});

await run("Purchase & Sales is denied MAN-eligible Item Master articles", async () => {
  await assert.rejects(
    () =>
      assertManEngineWriteAccess(reqForRole("purchase_sales"), {
        lines: [{ article: "SPN-21" }],
      }, {
        findItems: async () => [{ article: "SPN-21", brand: "MAN", engine: "MAN" }],
      }),
    (err) => err instanceof ManEngineAccessError && /SPN-21/.test(err.message)
  );
});

await run("Purchase & Sales is denied MAN ASN / PO headers", async () => {
  await assert.rejects(
    () =>
      assertManEngineWriteAccess(reqForRole("purchase_sales"), {
        lines: [{ article: "PO-1" }],
        header: { brand: "MAN", engine: "MAN" },
      }, { findItems: async () => [{ article: "PO-1", brand: "MAK" }] }),
    (err) => err instanceof ManEngineAccessError
  );
});

await run("Sales role may write MAN lines", async () => {
  await assertManEngineWriteAccess(reqForRole("sales"), {
    lines: [{ article: "MAN-1", brand: "MAN" }],
    sourceType: "MAN_RFQ",
  }, { findItems: async () => [{ article: "MAN-1", brand: "MAN" }] });
});

await run("Purchase role may write MAN PO / ASN lines", async () => {
  await assertManEngineWriteAccess(reqForRole("purchase"), {
    lines: [{ article: "MAN-1", brand: "MAN" }],
    header: { brand: "MAN" },
  }, { findItems: async () => [{ article: "MAN-1", brand: "MAN" }] });
});

await run("MAK / Wartsila brand is not treated as MAN", async () => {
  await assertManEngineWriteAccess(reqForRole("purchase_sales"), {
    lines: [{ article: "MAK-1", brand: "MAK", engine: "MAK" }],
    header: { brand: "Wartsila" },
  }, { findItems: async () => [{ article: "MAK-1", brand: "MAK" }] });
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
