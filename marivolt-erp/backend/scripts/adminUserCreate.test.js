/**
 * Admin Create User + deployment version regression tests.
 * Run: node scripts/adminUserCreate.test.js
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ADMIN_ASSIGNABLE_ROLES,
  assertAssignableCompanies,
  assertAssignableRole,
  assignableRolesForActor,
  ROLE_DISPLAY_LABELS,
  resolveCreatePassword,
} from "../src/utils/authAdminPolicy.js";
import { getDeploymentVersion } from "../src/utils/deploymentVersion.js";
import {
  buildCreateUserPayload,
  canShowCreateUserUi,
  ROLE_DISPLAY_LABELS as FE_ROLE_LABELS,
  validateCreateUserForm,
} from "../../src/lib/userAdmin.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.join(__dirname, "..");
const repoRoot = path.join(backendRoot, "..");

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

console.log("\nAdmin Create User + version\n");

run("ADMIN_ASSIGNABLE_ROLES includes store_operator", () => {
  assert.ok(ADMIN_ASSIGNABLE_ROLES.includes("store_operator"));
  assert.equal(ROLE_DISPLAY_LABELS.store_operator, "Store Operator");
});

run("Admin can assign store_operator; create endpoint stays admin-only", () => {
  assert.equal(
    assertAssignableRole({ actorRole: "admin", requestedRole: "store_operator" }),
    "store_operator"
  );
  assert.equal(
    assertAssignableRole({ actorRole: "company_admin", requestedRole: "store_operator" }),
    "store_operator"
  );
  // Caller gate is requireRole(adminRoles) — store_operator / staff cannot call POST /users
  const src = fs.readFileSync(path.join(backendRoot, "src/routes/authRoutes.js"), "utf8");
  assert.match(src, /const adminRoles = \["super_admin", "company_admin", "admin"\]/);
  assert.match(src, /requireRole\(\.\.\.adminRoles\)/);
  assert.doesNotMatch(src, /adminRoles\s*=\s*\[[^\]]*store_operator/);
});

run("Invalid role blocked", () => {
  assert.throws(
    () => assertAssignableRole({ actorRole: "admin", requestedRole: "hacker" }),
    (e) => e.code === "INVALID_ROLE" && e.statusCode === 400
  );
});

run("allowedCompanies required; defaultCompany must belong to allowed set (UI)", () => {
  assert.throws(
    () =>
      assertAssignableCompanies({
        actorRole: "admin",
        requestedCompanyIds: [],
        actorAllowedCompanyIds: ["c1"],
        activeCompanyIds: ["c1"],
      }),
    (e) => e.code === "COMPANY_IDS_REQUIRED"
  );
  const ok = assertAssignableCompanies({
    actorRole: "admin",
    requestedCompanyIds: ["c1"],
    actorAllowedCompanyIds: ["c1"],
    activeCompanyIds: ["c1", "c2"],
  });
  assert.deepEqual(ok, ["c1"]);

  const badDefault = validateCreateUserForm({
    email: "ops@example.com",
    temporaryPassword: "abcdefghij",
    role: "store_operator",
    allowedCompanies: ["c1"],
    defaultCompanyId: "c2",
  });
  assert.equal(badDefault.ok, false);

  const good = validateCreateUserForm({
    email: "ops@example.com",
    temporaryPassword: "abcdefghij",
    role: "store_operator",
    allowedCompanies: ["c1"],
    defaultCompanyId: "c1",
  });
  assert.equal(good.ok, true);
  const payload = buildCreateUserPayload(
    { name: "Store1", username: "store1", isActive: true },
    good
  );
  assert.equal(payload.role, "store_operator");
  assert.deepEqual(payload.allowedCompanies, ["c1"]);
  assert.equal(payload.defaultCompanyId, "c1");
  assert.equal(payload.temporaryPassword, "abcdefghij");
  assert.ok(!("passwordHash" in payload));
});

run("Password min length enforced", () => {
  assert.equal(resolveCreatePassword({ temporaryPassword: "abcdefghij" }).length, 10);
  assert.throws(() => resolveCreatePassword({ temporaryPassword: "short" }), (e) => e.code === "WEAK_PASSWORD");
});

run("POST /api/auth/users remains admin-guarded", () => {
  const src = fs.readFileSync(path.join(backendRoot, "src/routes/authRoutes.js"), "utf8");
  assert.match(src, /router\.post\(\s*"\/users"/);
  assert.match(src, /requireRole\(\.\.\.adminRoles\)/);
  assert.match(src, /const adminRoles = \["super_admin", "company_admin", "admin"\]/);
  assert.match(src, /\/assignable-roles/);
  assert.doesNotMatch(src, /requireRole\([^)]*store_operator/);
  assert.match(src, /Username already exists|Email already exists/);
});

run("assignableRolesForActor includes store_operator for admin", () => {
  assert.ok(assignableRolesForActor("admin").includes("store_operator"));
  assert.ok(!assignableRolesForActor("admin").includes("super_admin"));
  assert.ok(assignableRolesForActor("super_admin").includes("super_admin"));
});

run("Create User UI visible to Admin; hidden from store_operator", () => {
  assert.equal(canShowCreateUserUi("admin"), true);
  assert.equal(canShowCreateUserUi("super_admin"), true);
  assert.equal(canShowCreateUserUi("store_operator"), false);
  assert.equal(canShowCreateUserUi("staff"), false);
  assert.equal(FE_ROLE_LABELS.store_operator, "Store Operator");

  const settings = fs.readFileSync(path.join(repoRoot, "src/pages/Settings.jsx"), "utf8");
  assert.match(settings, /Create User/);
  assert.match(settings, /canShowCreateUserUi/);
  assert.match(settings, /data-testid="create-user-open"/);
  assert.match(settings, /apiPost\("\/auth\/users"/);
  assert.match(settings, /reset-2fa/);
  assert.match(settings, /DeploymentTab/);
  assert.match(settings, /apiGet\("\/version"\)/);
  assert.match(settings, /Store Operator|roleDisplayLabel|assignable-roles/);
});

run("GET /api/version returns non-secret deployment metadata", () => {
  const v = getDeploymentVersion({
    RENDER_GIT_COMMIT: "abcdef0123456789abcdef0123456789abcdef01",
    NODE_ENV: "production",
    BUILD_TIME: "2026-08-01T00:00:00Z",
    RENDER_SERVICE_NAME: "marivolt-erp",
  });
  assert.equal(v.commit, "abcdef0123456789abcdef0123456789abcdef01");
  assert.equal(v.environment, "production");
  assert.equal(v.buildTime, "2026-08-01T00:00:00Z");
  assert.equal(v.service, "marivolt-erp");
  assert.equal(getDeploymentVersion({}).commit, "unknown");

  const serverSrc = fs.readFileSync(path.join(backendRoot, "src/server.js"), "utf8");
  assert.match(serverSrc, /app\.get\("\/api\/version"/);
  assert.match(serverSrc, /getDeploymentVersion/);
  const healthBlock = serverSrc.match(/app\.get\("\/api\/health",[\s\S]*?\}\);/);
  assert.ok(healthBlock);
  assert.match(healthBlock[0], /ok: true/);
  assert.doesNotMatch(healthBlock[0], /commit|password|secret|token/i);
});

run("STORE_OPERATOR frontend helpers remain in source", () => {
  const rbac = fs.readFileSync(path.join(repoRoot, "src/lib/rbac.js"), "utf8");
  assert.match(rbac, /STORE_OPERATOR/);
  assert.match(rbac, /store_operator/);
  assert.match(rbac, /filterStoreTabsForRole/);
  assert.match(rbac, /defaultHomePathForRole/);
  assert.match(rbac, /return "\/store"/);
  const sidebar = fs.readFileSync(path.join(repoRoot, "src/components/Sidebar.jsx"), "utf8");
  assert.match(sidebar, /isStoreOperatorRole/);
  const protectedRoute = fs.readFileSync(path.join(repoRoot, "src/components/ProtectedRoute.jsx"), "utf8");
  assert.match(protectedRoute, /storeOperatorAllowedPath/);
});

run("Vite injects VITE_APP_COMMIT without hardcoded release SHA", () => {
  const vite = fs.readFileSync(path.join(repoRoot, "vite.config.js"), "utf8");
  assert.match(vite, /VITE_APP_COMMIT/);
  assert.match(vite, /VERCEL_GIT_COMMIT_SHA/);
  assert.doesNotMatch(vite, /ff868b60fd29fd9f3739d08355cd3de806ab1c9e/);
});

console.log(`\nAdmin Create User: ${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
