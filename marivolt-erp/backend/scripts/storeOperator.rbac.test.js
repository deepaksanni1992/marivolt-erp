/**
 * STORE_OPERATOR RBAC — basic warehouse floor operator (planned Store1).
 * Run: node scripts/storeOperator.rbac.test.js
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  getDefaultPermissionsForRole,
  hasPermission,
  normaliseRoleCode,
  ROLE_DEFAULTS,
} from "../src/services/roleService.js";
import { SYSTEM_ROLE_CODES } from "../src/models/Role.js";
import { USER_ROLES, ADMIN_ASSIGNABLE_ROLES } from "../src/utils/authAdminPolicy.js";
import { denyRoles } from "../src/middleware/permissions.js";

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

console.log("\nSTORE_OPERATOR RBAC\n");

const erpAccess = fs.readFileSync(path.join(srcRoot, "middleware", "erpAccess.js"), "utf8");
const grnRoutes = fs.readFileSync(path.join(srcRoot, "routes", "grnRoutes.js"), "utf8");
const packingRoutes = fs.readFileSync(path.join(srcRoot, "routes", "packingRoutes.js"), "utf8");
const stockRoutes = fs.readFileSync(path.join(srcRoot, "routes", "stockRoutes.js"), "utf8");
const inventoryRoutes = fs.readFileSync(path.join(srcRoot, "routes", "inventoryRoutes.js"), "utf8");
const dispatchRoutes = fs.readFileSync(path.join(srcRoot, "routes", "dispatchRoutes.js"), "utf8");
const labelRoutes = fs.readFileSync(path.join(srcRoot, "routes", "labelRoutes.js"), "utf8");
const userModel = fs.readFileSync(path.join(srcRoot, "models", "User.js"), "utf8");
const storeUi = fs.readFileSync(path.join(feRoot, "pages", "StoreModule.jsx"), "utf8");
const sidebar = fs.readFileSync(path.join(feRoot, "components", "Sidebar.jsx"), "utf8");
const rbacFe = fs.readFileSync(path.join(feRoot, "lib", "rbac.js"), "utf8");
const protectedRoute = fs.readFileSync(path.join(feRoot, "components", "ProtectedRoute.jsx"), "utf8");

run("Role code STORE_OPERATOR exists in system defaults", () => {
  assert.ok(SYSTEM_ROLE_CODES.includes("STORE_OPERATOR"));
  assert.ok(ROLE_DEFAULTS.STORE_OPERATOR);
  assert.equal(normaliseRoleCode("store_operator"), "STORE_OPERATOR");
  assert.ok(USER_ROLES.includes("store_operator"));
  assert.ok(ADMIN_ASSIGNABLE_ROLES.includes("store_operator"));
  assert.ok(userModel.includes('"store_operator"'));
});

run("Existing STORE role unchanged (still has cancel/approve)", () => {
  const store = getDefaultPermissionsForRole("store");
  assert.ok(store.STORE.includes("cancel"));
  assert.ok(store.STORE.includes("approve"));
  assert.ok(store.CUSTOMS.includes("create"));
  assert.ok(store.ARTICLE_CONVERSION.includes("reverse"));
  assert.ok(store.LABELS.includes("reprint"));
});

run("STORE_OPERATOR matrix — allowed Store/Label ops", () => {
  const m = getDefaultPermissionsForRole("store_operator");
  for (const a of ["view", "create", "edit", "post", "export"]) {
    assert.ok(m.STORE.includes(a), `missing STORE.${a}`);
  }
  for (const a of ["view", "print", "reprint"]) {
    assert.ok(m.LABELS.includes(a), `missing LABELS.${a}`);
  }
  assert.ok(m.ITEM_MASTER.includes("view"));
  assert.ok(m.PURCHASE.includes("view"));
  assert.deepEqual(m.ASN, ["view"]);
});

run("STORE_OPERATOR can prepare ASN receiving labels without ASN.edit", () => {
  const asnRoutes = fs.readFileSync(path.join(srcRoot, "routes", "asnRoutes.js"), "utf8");
  assert.ok(asnRoutes.includes("receiving-units/plan"));
  assert.ok(asnRoutes.includes("requireAllPermissions"));
  assert.ok(!asnRoutes.includes('requirePermission("ASN", "edit"), ru.plan'));
});

run("STORE_OPERATOR cannot mutate ASN attachments; downloads stay company-scoped", () => {
  const asnRoutes = fs.readFileSync(path.join(srcRoot, "routes", "asnRoutes.js"), "utf8");
  const docCtrl = fs.readFileSync(path.join(srcRoot, "controllers", "documentController.js"), "utf8");
  const docRoutes = fs.readFileSync(path.join(srcRoot, "routes", "documentRoutes.js"), "utf8");
  assert.ok(asnRoutes.includes('requirePermission("ASN", "edit")'));
  assert.ok(asnRoutes.includes("/:id/attachments"));
  assert.ok(docCtrl.includes("isAsnDocumentRequest"));
  assert.ok(docCtrl.includes("assertAsnAttachmentMutatePermission"));
  assert.ok(docCtrl.includes('hasPermission(req, "ASN", "edit")'));
  assert.ok(docCtrl.includes("scopeToCompany(req, { _id: id })"));
  assert.ok(docRoutes.includes('["ASN", "view"]'));
  assert.ok(docRoutes.includes('["ASN", "edit"]'));
});

run("STORE_OPERATOR matrix — destructive / commercial blocked", () => {
  const m = getDefaultPermissionsForRole("store_operator");
  for (const a of ["cancel", "delete", "approve", "override", "reverse"]) {
    assert.ok(!m.STORE.includes(a), `STORE should not have ${a}`);
  }
  assert.deepEqual(m.SALES || [], []);
  assert.deepEqual(m.ACCOUNTS || [], []);
  assert.deepEqual(m.SETTINGS || [], []);
  assert.deepEqual(m.CUSTOMS || [], []);
  assert.deepEqual(m.ARTICLE_CONVERSION || [], []);
  assert.ok(!m.LABELS.includes("admin"));
  assert.ok(!(m.ITEM_MASTER || []).includes("create"));
  assert.ok(!(m.PURCHASE || []).includes("create"));
  assert.ok(!(m.ASN || []).includes("create"));
  assert.ok(!(m.ASN || []).includes("cancel"));
});

await runAsync("hasPermission reflects matrix for mock req", async () => {
  const req = { user: { role: "store_operator" } };
  assert.equal(await hasPermission(req, "STORE", "view"), true);
  assert.equal(await hasPermission(req, "STORE", "create"), true);
  assert.equal(await hasPermission(req, "STORE", "post"), true);
  assert.equal(await hasPermission(req, "STORE", "cancel"), false);
  assert.equal(await hasPermission(req, "STORE", "approve"), false);
  assert.equal(await hasPermission(req, "STORE", "delete"), false);
  assert.equal(await hasPermission(req, "LABELS", "print"), true);
  assert.equal(await hasPermission(req, "LABELS", "reprint"), true);
  assert.equal(await hasPermission(req, "LABELS", "admin"), false);
  assert.equal(await hasPermission(req, "SALES", "create"), false);
  assert.equal(await hasPermission(req, "ACCOUNTS", "view"), false);
  assert.equal(await hasPermission(req, "CUSTOMS", "view"), false);
  assert.equal(await hasPermission(req, "SETTINGS", "view"), false);
  assert.equal(await hasPermission(req, "ITEM_MASTER", "edit"), false);
  assert.equal(await hasPermission(req, "ASN", "view"), true);
  assert.equal(await hasPermission(req, "ASN", "edit"), false);
  assert.equal(await hasPermission(req, "ASN", "create"), false);
});

run("erpAccess includes Phase-10 + store_operator via USER_ROLES", () => {
  assert.ok(erpAccess.includes("USER_ROLES"));
  assert.ok(erpAccess.includes("requireRole(...USER_ROLES)"));
});

run("GRN/Packing post accept STORE.post | STORE.approve", () => {
  assert.ok(grnRoutes.includes('requireAnyPermission(["STORE", "approve"], ["STORE", "post"])'));
  assert.ok(packingRoutes.includes('requireAnyPermission(["STORE", "approve"], ["STORE", "post"])'));
  assert.ok(grnRoutes.includes('requirePermission("STORE", "cancel")'));
  assert.ok(packingRoutes.includes('requirePermission("STORE", "cancel")'));
  assert.ok(grnRoutes.includes('requirePermission("STORE", "delete")'));
});

run("Stock adjustment / inventory mutate / dispatch deny STORE_OPERATOR", () => {
  assert.ok(stockRoutes.includes('denyRoles("STORE_OPERATOR")'));
  assert.ok(stockRoutes.includes("/adjustment"));
  assert.ok(inventoryRoutes.includes('denyRoles("STORE_OPERATOR")'));
  assert.ok(dispatchRoutes.includes('denyRoles("STORE_OPERATOR")'));
  assert.ok(dispatchRoutes.includes("/draft"));
});

run("Label admin remains gated; print/reprint routes present", () => {
  assert.ok(labelRoutes.includes("labelsPrint") || labelRoutes.includes('requirePermission("LABELS", "print")'));
  assert.ok(labelRoutes.includes("/jobs/from-grn"));
  assert.ok(labelRoutes.includes("/jobs/from-packing"));
  assert.ok(labelRoutes.includes("/jobs/from-custom-packing"));
  assert.ok(labelRoutes.includes("/jobs/from-asn"));
  // Settings write must NOT be available via LABELS.print alone
  assert.ok(labelRoutes.includes("labelsSettingsWrite"));
  assert.ok(!labelRoutes.includes('router.put("/settings", labelsPrint'));
  assert.ok(labelRoutes.includes('["LABELS", "admin"]'));
  assert.ok(labelRoutes.includes('["SETTINGS", "edit"]'));
});

run("Global search blocked for STORE_OPERATOR", () => {
  const searchRoutes = fs.readFileSync(path.join(srcRoot, "routes", "searchRoutes.js"), "utf8");
  assert.ok(searchRoutes.includes('denyRoles("STORE_OPERATOR")'));
  assert.ok(searchRoutes.includes("requireAnyPermission"));
});

run("Report PDF requires module permission (not auth-only)", () => {
  const pdfRoutes = fs.readFileSync(path.join(srcRoot, "routes", "reportPdfRoutes.js"), "utf8");
  assert.ok(pdfRoutes.includes("requireAnyPermission"));
  assert.ok(pdfRoutes.includes('["STORE", "view"]') || pdfRoutes.includes('["STORE", "export"]'));
  assert.ok(pdfRoutes.includes("requireAuth"));
  assert.ok(pdfRoutes.includes("requireCompanyContext"));
});

await runAsync("denyRoles middleware blocks STORE_OPERATOR", async () => {
  const mw = denyRoles("STORE_OPERATOR");
  let status = 0;
  let body = null;
  const req = { user: { role: "store_operator" } };
  const res = {
    status(code) {
      status = code;
      return this;
    },
    json(payload) {
      body = payload;
      return this;
    },
  };
  let nextCalled = false;
  await new Promise((resolve) => {
    mw(req, res, () => {
      nextCalled = true;
      resolve();
    });
    // denyRoles is sync
    if (!nextCalled) resolve();
  });
  assert.equal(nextCalled, false);
  assert.equal(status, 403);
  assert.equal(body?.code, "PERMISSION_DENIED");

  // STORE manager still passes denyRoles
  let next2 = false;
  mw({ user: { role: "store" } }, res, () => {
    next2 = true;
  });
  assert.equal(next2, true);
});

run("Frontend: store-only nav + landing + path guard", () => {
  assert.ok(rbacFe.includes("store_operator"));
  assert.ok(rbacFe.includes('"/store"'));
  assert.ok(rbacFe.includes("STORE_OPERATOR_TABS"));
  assert.ok(sidebar.includes("isStoreOperatorRole"));
  assert.ok(protectedRoute.includes("storeOperatorAllowedPath"));
  assert.ok(storeUi.includes("filterStoreTabsForRole"));
  assert.ok(storeUi.includes("canCancelStore"));
  assert.ok(storeUi.includes("canDeleteStore"));
});

run("Admin SUPER_ADMIN defaults remain full", () => {
  const admin = getDefaultPermissionsForRole("admin");
  assert.ok(admin.SETTINGS.includes("approve"));
  assert.ok(admin.STORE.includes("cancel"));
  const sa = getDefaultPermissionsForRole("super_admin");
  assert.ok(sa.STORE.includes("cancel"));
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
