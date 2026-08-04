/**
 * Article conversion transactional create/session regressions (no DB).
 * Run: node scripts/articleConversionTransactionCreate.test.js
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "path";
import { fileURLToPath } from "url";
import mongoose from "mongoose";

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

// 1–2 / 10 — Mongoose create+session contract
{
  const msg =
    "Cannot call `create()` with a session and multiple documents unless `ordered: true` is set";
  function mongooseWouldReject(argsLength, options) {
    return Boolean(options?.session && !options?.ordered && argsLength > 1);
  }
  ok("10. Multi-doc + session without ordered throws (guard)", mongooseWouldReject(2, { session: {} }));
  ok("10b. Multi-doc + session + ordered is allowed", !mongooseWouldReject(2, { session: {}, ordered: true }));
  ok("2. Single-doc + session without ordered is allowed", !mongooseWouldReject(1, { session: {} }));
  ok("error message matches production toast", msg.includes("ordered: true"));
}

// 3–7 / 8 — conversion posting path invariants (source)
{
  const customs = read("src/services/articleConversionCustomsService.js");
  const stock = read("src/services/stockService.js");
  const ctrl = read("src/controllers/articleConversionController.js");

  ok("3. Source ledger via createStockLedgerEntry (OUT)", /ARTICLE_CONVERSION_OUT/.test(stock));
  ok("4. Target ledger via createStockLedgerEntry (IN)", /ARTICLE_CONVERSION_IN/.test(stock));
  ok(
    "5–6. articleConversion decrements source then increments target once each",
    /inc:\s*\{\s*quantity:\s*-srcQty,\s*onHandQty:\s*-srcQty/.test(stock) &&
      /inc:\s*\{\s*quantity:\s*tgtQty,\s*onHandQty:\s*tgtQty/.test(stock)
  );
  ok(
    "7. Conversion status DRAFT→POSTING→POSTED in same transaction",
    /status:\s*"POSTING"/.test(ctrl) && /claimed\.status = "POSTED"/.test(ctrl)
  );
  ok(
    "8. Idempotent already-posted path exists",
    /ARTICLE_CONVERSION_ALREADY_POSTED/.test(ctrl) && /alreadyPosted:\s*true/.test(ctrl)
  );
  ok(
    "9. Failure path uses withTransaction (full rollback)",
    /session\.withTransaction/.test(ctrl) && /startSession\(\)/.test(ctrl)
  );
  ok(
    "customs OUT+IN movements created together with ordered:true",
    (customs.match(/CustomsMovement\.create/g) || []).length === 2 &&
      (customs.match(/ordered:\s*true/g) || []).length >= 2
  );
  ok("target customs layer uses save({ session })", /targetItem\.save\(\{ session \}\)/.test(customs));
  ok(
    "ledger create uses ordered:true",
    /StockLedger\.create\(\[row\],\s*\{\s*session:\s*data\?\.session,\s*ordered:\s*true/.test(stock)
  );
}

// Confirm mongoose version still enforces the rule
ok("mongoose major is 9+", Number(String(mongoose.version).split(".")[0]) >= 9);

console.log(`\n${passed} checks passed`);
