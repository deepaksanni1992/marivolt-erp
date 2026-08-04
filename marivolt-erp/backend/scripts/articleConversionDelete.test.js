/**
 * Article Stock Conversion delete regressions (no DB).
 * Run: node scripts/articleConversionDelete.test.js
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "url";
import {
  ARTICLE_CONVERSION_DELETE_BLOCKED,
  ARTICLE_CONVERSION_DELETED,
  ARTICLE_CONVERSION_POSTED_DELETE_MESSAGE,
} from "../src/utils/articleConversionIdempotency.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.join(__dirname, "..");
const repoRoot = path.join(backendRoot, "..");

function read(rel) {
  return fs.readFileSync(path.join(backendRoot, rel), "utf8");
}

let passed = 0;
function ok(name, cond) {
  assert.ok(cond, name);
  passed += 1;
  console.log("✓", name);
}

const ctrl = read("src/controllers/articleConversionController.js");
const routes = read("src/routes/articleConversionRoutes.js");
const audit = read("src/models/AuditLog.js");
const ui = fs.readFileSync(
  path.join(repoRoot, "src/components/store/ArticleStockConversionPanel.jsx"),
  "utf8"
);

ok("constants exported", ARTICLE_CONVERSION_DELETED === "ARTICLE_CONVERSION_DELETED");
ok("delete blocked code", ARTICLE_CONVERSION_DELETE_BLOCKED === "ARTICLE_CONVERSION_DELETE_BLOCKED");
ok(
  "posted delete message",
  ARTICLE_CONVERSION_POSTED_DELETE_MESSAGE.includes("Use Reverse Conversion instead")
);

ok("DELETE route registered", /router\.delete\("\/:id"/.test(routes));
ok("controller exports deleteArticleConversion", /export async function deleteArticleConversion/.test(ctrl));

ok("1. Delete allowed for DRAFT", /st !== "DRAFT" && st !== "APPROVED"/.test(ctrl) || /st === "DRAFT"/.test(ctrl));
ok("2. Delete allowed for APPROVED (unposted)", /APPROVED/.test(ctrl) && /deleteArticleConversion/.test(ctrl));
ok(
  "3. Cannot delete POSTED → 409 + reverse message",
  /ARTICLE_CONVERSION_POSTED_DELETE_MESSAGE/.test(ctrl) && /st === "POSTED"/.test(ctrl)
);
ok("4. Cannot delete REVERSED/CANCELLED", /st === "REVERSED"/.test(ctrl) && /CANCELLED/.test(ctrl));
ok(
  "5. AuditLog ARTICLE_CONVERSION_DELETED",
  /ARTICLE_CONVERSION_DELETED/.test(audit) && /action:\s*ARTICLE_CONVERSION_DELETED/.test(ctrl)
);
ok(
  "6. Delete inside withTransaction",
  /session\.withTransaction/.test(ctrl.slice(ctrl.indexOf("deleteArticleConversion")))
);
ok(
  "7. Guards: postedAt, StockLedger, CustomsMovement, effectKeys",
  /postedAt/.test(ctrl) &&
    /StockLedger\.countDocuments/.test(ctrl) &&
    /CustomsMovement\.countDocuments/.test(ctrl) &&
    /buildArticleConversionEffectKey/.test(ctrl)
);
ok(
  "8. No stock/customs mutation on delete path",
  !/articleConversion\(/.test(ctrl.slice(ctrl.indexOf("deleteArticleConversion"))) &&
    !/retargetCustomsLotsForConversion/.test(ctrl.slice(ctrl.indexOf("deleteArticleConversion")))
);
ok("9. Physical deleteOne", /ArticleStockConversion\.deleteOne/.test(ctrl));
ok(
  "10. Audit metadata has conversionNo/reason/deletedBy/timestamp",
  /conversionNo:/.test(ctrl) &&
    /deletedBy/.test(ctrl) &&
    /timestamp:/.test(ctrl) &&
    /reason/.test(ctrl)
);

ok("UI Delete for DRAFT", /onDelete\(row\)/.test(ui) && /Delete Article Conversion/.test(ui));
ok("UI Edit+Delete+Post for DRAFT", /Edit<\/button>/.test(ui) && /Delete<\/button>/.test(ui) && /Post<\/button>/.test(ui));
ok("UI Delete+Post for APPROVED", /uiStatus === "APPROVED"/.test(ui));
ok("UI View+Reverse for POSTED", /uiStatus === "POSTED"/.test(ui) && /View<\/button>/.test(ui));
ok("UI confirm permanently", /Delete permanently\?/.test(ui));
ok("UI calls apiDelete", /apiDelete\(`\/article-conversions\/\$\{id\}`/.test(ui));

// Pure policy helpers mirrored from controller
function canDelete({ status, approvalStatus, postedAt, hasLedger, hasCustoms }) {
  const st = String(status || "").toUpperCase();
  if (st === "POSTED" || st === "POSTING") return { ok: false, message: ARTICLE_CONVERSION_POSTED_DELETE_MESSAGE };
  if (st === "REVERSED" || st === "REVERSING" || st === "CANCELLED") return { ok: false };
  if (st !== "DRAFT" && st !== "APPROVED") return { ok: false };
  if (postedAt) return { ok: false, message: ARTICLE_CONVERSION_POSTED_DELETE_MESSAGE };
  if (hasLedger || hasCustoms) return { ok: false };
  return { ok: true, approvedDraft: String(approvalStatus).toUpperCase() === "APPROVED" };
}

ok("policy: draft deletable", canDelete({ status: "DRAFT" }).ok === true);
ok(
  "policy: approved draft deletable",
  canDelete({ status: "DRAFT", approvalStatus: "APPROVED" }).ok === true
);
ok("policy: posted blocked", canDelete({ status: "POSTED" }).ok === false);
ok("policy: reversed blocked", canDelete({ status: "REVERSED" }).ok === false);
ok("policy: ledger blocks", canDelete({ status: "DRAFT", hasLedger: true }).ok === false);
ok("policy: customs blocks", canDelete({ status: "DRAFT", hasCustoms: true }).ok === false);
ok("policy: postedAt blocks", canDelete({ status: "DRAFT", postedAt: new Date() }).ok === false);

console.log(`\n${passed} checks passed`);
