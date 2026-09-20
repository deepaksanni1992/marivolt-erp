/**
 * Phase 1 RBAC security hardening tests.
 * Run: node scripts/rbacPhase1.security.test.js
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import jwt from "jsonwebtoken";
import {
  authorizeDecodedUser,
  AUTH_USER_SAFE_SELECT,
  requireAuth,
  requireCompanyContext,
} from "../src/middleware/auth.js";
import { requirePermission } from "../src/middleware/permissions.js";
import {
  computeEffectivePermissions,
  emptyPermissionMatrix,
  getDefaultPermissionsForRole,
  hasPermission,
  resolvePermissions,
} from "../src/services/roleService.js";
import { MODULE_ALLOWED_ACTIONS as BE_MODULE_ACTIONS } from "../src/models/Role.js";
import { sanitiseRolePayload } from "../src/controllers/rolesController.js";
import {
  MODULE_ALLOWED_ACTIONS as FE_MODULE_ACTIONS,
  allowedActionsForModule,
  canAccessPath,
  canFromStaticMatrix,
  canPerform,
  filterSidebarNav,
  firstAuthorizedPath,
  hasDangerousRoleActions,
  selectedPermissionSummary,
  SIDEBAR_NAV,
} from "../../src/lib/rbacAccess.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.join(__dirname, "..");
const feRoot = path.join(backendRoot, "..", "src");

process.env.JWT_SECRET = process.env.JWT_SECRET || "rbac-phase1-test-secret";

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

function mockRes() {
  const out = { statusCode: 0, body: null };
  const res = {
    status(code) {
      out.statusCode = code;
      return res;
    },
    json(body) {
      out.body = body;
      return res;
    },
  };
  return { res, out };
}

function signSession(payload) {
  return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: "1h" });
}

const COMPANY_A = "64aaaaaaaaaaaaaaaaaaaaaa";
const COMPANY_B = "64bbbbbbbbbbbbbbbbbbbbbb";
const ROLE_ID = "64cccccccccccccccccccccc";

function dbUser(overrides = {}) {
  return {
    _id: "64dddddddddddddddddddddd",
    name: "Test User",
    email: "test@example.com",
    username: "testuser",
    role: "purchase",
    roleIds: [],
    allowedCompanies: [COMPANY_A],
    defaultCompany: COMPANY_A,
    isActive: true,
    permissionOverrides: [],
    ...overrides,
  };
}

function deepaMatrix() {
  const empty = emptyPermissionMatrix();
  return {
    ...empty,
    SALES: ["view", "create", "edit", "export"],
    STORE: ["view"],
  };
}

async function invokeRequireAuth({ token, user, loaderError }) {
  const { res, out } = mockRes();
  let nextCalled = false;
  const req = {
    headers: { authorization: `Bearer ${token}` },
    loadAuthUser: async () => {
      if (loaderError) throw loaderError;
      return user;
    },
  };
  await requireAuth(req, res, () => {
    nextCalled = true;
  });
  return { req, out, nextCalled };
}

async function invokeRequirePermission(moduleName, action, req) {
  const { res, out } = mockRes();
  let nextCalled = false;
  await requirePermission(moduleName, action)(req, res, () => {
    nextCalled = true;
  });
  return { out, nextCalled };
}

console.log("\nPhase 1 RBAC security\n");

run("Safe user select omits secrets", () => {
  assert.doesNotMatch(AUTH_USER_SAFE_SELECT, /password/i);
  assert.doesNotMatch(AUTH_USER_SAFE_SELECT, /twoFactorSecret/);
  assert.doesNotMatch(AUTH_USER_SAFE_SELECT, /token/i);
  const src = fs.readFileSync(path.join(backendRoot, "src/middleware/auth.js"), "utf8");
  assert.match(src, /loadActiveAuthUser/);
  assert.match(src, /tokenVersion/);
  assert.match(src, /Phase 2/);
});

run("Deleted user JWT is rejected", () => {
  const result = authorizeDecodedUser({ id: "gone", role: "admin", companyId: COMPANY_A }, null);
  assert.equal(result.ok, false);
  assert.equal(result.status, 401);
  assert.equal(result.body.code, "USER_NOT_FOUND");
});

run("Inactive user JWT is rejected", () => {
  const result = authorizeDecodedUser(
    { id: "u1", role: "admin", companyId: COMPANY_A },
    dbUser({ isActive: false, role: "admin" })
  );
  assert.equal(result.ok, false);
  assert.equal(result.status, 403);
  assert.equal(result.body.code, "USER_INACTIVE");
});

run("Live DB role replaces stale JWT role", () => {
  const result = authorizeDecodedUser(
    { id: "u1", role: "admin", companyId: COMPANY_A, email: "stale@example.com" },
    dbUser({ role: "purchase", email: "live@example.com" })
  );
  assert.equal(result.ok, true);
  assert.equal(result.reqUser.role, "purchase");
  assert.equal(result.reqUser.email, "live@example.com");
  assert.ok(!Object.prototype.hasOwnProperty.call(result.reqUser, "passwordHash"));
});

run("Purpose tickets cannot be used as session tokens", () => {
  const result = authorizeDecodedUser(
    { purpose: "2fa_verify", id: "u1" },
    dbUser({ role: "admin" })
  );
  assert.equal(result.ok, false);
  assert.equal(result.body.code, "INVALID_TOKEN");
});

await runAsync("requireAuth rejects deleted user token", async () => {
  const token = signSession({ id: "gone", role: "admin", companyId: COMPANY_A });
  const { out, nextCalled } = await invokeRequireAuth({ token, user: null });
  assert.equal(nextCalled, false);
  assert.equal(out.statusCode, 401);
  assert.equal(out.body.code, "USER_NOT_FOUND");
});

await runAsync("requireAuth rejects inactive user token", async () => {
  const token = signSession({ id: "u1", role: "purchase", companyId: COMPANY_A });
  const { out, nextCalled } = await invokeRequireAuth({
    token,
    user: dbUser({ isActive: false }),
  });
  assert.equal(nextCalled, false);
  assert.equal(out.statusCode, 403);
});

await runAsync("requireAuth hydrates live purchase role from admin JWT", async () => {
  const token = signSession({ id: "u1", role: "admin", companyId: COMPANY_A });
  const { req, nextCalled } = await invokeRequireAuth({
    token,
    user: dbUser({ role: "purchase" }),
  });
  assert.equal(nextCalled, true);
  assert.equal(req.user.role, "purchase");
});

run("Removed company cannot be used as request context", () => {
  const { res, out } = mockRes();
  let nextCalled = false;
  requireCompanyContext(
    {
      user: {
        role: "purchase",
        companyId: COMPANY_B,
        allowedCompanyIds: [COMPANY_A],
      },
      headers: {},
    },
    res,
    () => {
      nextCalled = true;
    }
  );
  assert.equal(nextCalled, false);
  assert.equal(out.statusCode, 403);
  assert.equal(out.body.code, "COMPANY_ACCESS_DENIED");
});

run("Allowed company context still proceeds", () => {
  const { res, out } = mockRes();
  let nextCalled = false;
  const req = {
    user: { role: "purchase", companyId: COMPANY_A, allowedCompanyIds: [COMPANY_A] },
    headers: { "x-company-id": COMPANY_A },
  };
  requireCompanyContext(req, res, () => {
    nextCalled = true;
  });
  assert.equal(nextCalled, true);
  assert.equal(out.statusCode, 0);
  assert.equal(req.companyId, COMPANY_A);
});

run("View Only / Staff defaults omit SETTINGS", () => {
  const viewOnly = getDefaultPermissionsForRole("view_only");
  const staff = getDefaultPermissionsForRole("staff");
  assert.deepEqual(viewOnly.SETTINGS, []);
  assert.deepEqual(staff.SETTINGS, []);
  assert.ok(viewOnly.SALES.includes("view"));
  assert.ok(staff.SALES.includes("view"));
});

run("Unknown role fails closed", () => {
  const matrix = getDefaultPermissionsForRole("not_a_real_role");
  assert.equal(matrix.SALES.length, 0);
  assert.equal(matrix.PURCHASE.length, 0);
  assert.equal(matrix.SETTINGS.length, 0);
  assert.equal(matrix.PRICE_LIST.length, 0);
});

run("Unresolved custom roleIds fail closed", () => {
  const matrix = computeEffectivePermissions({
    role: "view_only",
    roleIds: [ROLE_ID],
    customRoleDocs: [],
  });
  assert.equal(matrix.SALES.length, 0);
  assert.equal(matrix.STORE.length, 0);
  assert.equal(matrix.SETTINGS.length, 0);
});

run("Custom-role lookup error fails closed", () => {
  const matrix = computeEffectivePermissions({
    role: "view_only",
    roleIds: [ROLE_ID],
    customRoleLookupFailed: true,
  });
  assert.deepEqual(matrix.SALES, []);
  assert.deepEqual(matrix.PURCHASE, []);
});

await runAsync("resolvePermissions fails closed when Role lookup throws", async () => {
  const req = {
    user: { id: "u1", role: "view_only", roleIds: [ROLE_ID] },
    authUser: dbUser({ role: "view_only", roleIds: [ROLE_ID] }),
  };
  const matrix = await resolvePermissions(req, {
    findRoles: async () => {
      throw new Error("db down");
    },
  });
  assert.equal(matrix.SALES.length, 0);
  assert.equal(matrix.SETTINGS.length, 0);
});

run("Empty custom matrix permits no protected module", () => {
  const empty = emptyPermissionMatrix();
  assert.ok(Object.values(empty).every((actions) => Array.isArray(actions) && actions.length === 0));
});

run("Valid custom role gets only selected actions", () => {
  const matrix = computeEffectivePermissions({
    role: "view_only",
    roleIds: [ROLE_ID],
    customRoleDocs: [
      {
        _id: ROLE_ID,
        permissions: [
          { module: "SALES", actions: ["view", "create"] },
          { module: "STORE", actions: ["view"] },
        ],
      },
    ],
  });
  assert.deepEqual(matrix.SALES.sort(), ["create", "view"]);
  assert.deepEqual(matrix.STORE, ["view"]);
  assert.deepEqual(matrix.PURCHASE, []);
  assert.deepEqual(matrix.ACCOUNTS, []);
  assert.deepEqual(matrix.CUSTOMS, []);
  assert.deepEqual(matrix.SETTINGS, []);
  assert.deepEqual(matrix.PRICE_LIST, []);
});

run("Standard roles without roleIds keep system matrix", () => {
  const purchase = computeEffectivePermissions({ role: "purchase", roleIds: [] });
  assert.ok(purchase.PURCHASE.includes("view"));
  assert.ok(purchase.ASN.includes("view"));
  assert.equal(purchase.SALES.length, 0);
});

await runAsync("Deepa-equivalent Sales Coordinator APIs", async () => {
  const req = {
    user: { id: "deepa", role: "view_only" },
    _permissions: deepaMatrix(),
  };
  assert.equal(await hasPermission(req, "SALES", "view"), true);
  assert.equal(await hasPermission(req, "PURCHASE", "view"), false);
  assert.equal(await hasPermission(req, "ACCOUNTS", "view"), false);
  assert.equal(await hasPermission(req, "CUSTOMS", "view"), false);
  assert.equal(await hasPermission(req, "SETTINGS", "view"), false);
  assert.equal(await hasPermission(req, "PRICE_LIST", "view"), false);
  const denied = [];
  for (const [mod, act] of [
    ["PURCHASE", "view"],
    ["ACCOUNTS", "view"],
    ["CUSTOMS", "view"],
    ["SETTINGS", "view"],
    ["PRICE_LIST", "view"],
  ]) {
    const { nextCalled, out } = await invokeRequirePermission(mod, act, {
      user: { role: "view_only" },
      _permissions: deepaMatrix(),
    });
    assert.equal(nextCalled, false, `${mod}.${act} should 403`);
    assert.equal(out.statusCode, 403);
    denied.push(out.body.code);
  }
  assert.ok(denied.every((c) => c === "PERMISSION_DENIED"));
});

await runAsync("Purchase user APIs", async () => {
  const matrix = getDefaultPermissionsForRole("purchase");
  const req = { user: { role: "purchase" }, _permissions: matrix };
  assert.equal(await hasPermission(req, "PURCHASE", "view"), true);
  assert.equal(await hasPermission(req, "ASN", "view"), true);
  assert.equal(await hasPermission(req, "SALES", "view"), false);
  assert.equal(await hasPermission(req, "ACCOUNTS", "view"), false);
  assert.equal(await hasPermission(req, "CUSTOMS", "view"), false);
  assert.equal(await hasPermission(req, "SETTINGS", "view"), false);
  assert.equal(await hasPermission(req, "PRICE_LIST", "view"), false);
  const { nextCalled } = await invokeRequirePermission("PURCHASE", "view", req);
  assert.equal(nextCalled, true);
  const asn = await invokeRequirePermission("ASN", "view", {
    user: { role: "purchase" },
    _permissions: matrix,
  });
  assert.equal(asn.nextCalled, true);
  for (const [mod, act] of [
    ["SALES", "view"],
    ["ACCOUNTS", "view"],
    ["CUSTOMS", "view"],
    ["SETTINGS", "view"],
    ["PRICE_LIST", "view"],
  ]) {
    const result = await invokeRequirePermission(mod, act, {
      user: { role: "purchase" },
      _permissions: matrix,
    });
    assert.equal(result.nextCalled, false, `${mod}.${act} should 403`);
    assert.equal(result.out.statusCode, 403);
  }
});

run("Direct restricted frontend routes are denied", () => {
  const deepaCan = canFromStaticMatrix(deepaMatrix());
  const ctx = { role: "view_only", can: deepaCan, permissionsReady: true };
  assert.equal(canAccessPath("/purchase", ctx), false);
  assert.equal(canAccessPath("/accounts", ctx), false);
  assert.equal(canAccessPath("/customs/invoices", ctx), false);
  assert.equal(canAccessPath("/settings", ctx), false);
  assert.equal(canAccessPath("/price-list", ctx), false);
  assert.equal(canAccessPath("/sales", ctx), true);
  assert.equal(canAccessPath("/store", ctx), true);

  const purchaseCan = canFromStaticMatrix(getDefaultPermissionsForRole("purchase"));
  const pctx = { role: "purchase", can: purchaseCan, permissionsReady: true };
  assert.equal(canAccessPath("/sales", pctx), false);
  assert.equal(canAccessPath("/accounts", pctx), false);
  assert.equal(canAccessPath("/customs/stock", pctx), false);
  assert.equal(canAccessPath("/settings", pctx), false);
  assert.equal(canAccessPath("/price-list", pctx), false);
  assert.equal(canAccessPath("/purchase", pctx), true);
  assert.equal(canAccessPath("/asn", pctx), true);
});

run("Sidebar hides unauthorized modules", () => {
  const deepaNav = filterSidebarNav(SIDEBAR_NAV, {
    role: "view_only",
    can: canFromStaticMatrix(deepaMatrix()),
    permissionsReady: true,
  });
  const deepaHrefs = deepaNav.flatMap((e) => (e.items ? e.items.map((i) => i.to) : [e.to]));
  assert.ok(deepaHrefs.includes("/sales"));
  assert.ok(deepaHrefs.includes("/store"));
  assert.ok(!deepaHrefs.includes("/purchase"));
  assert.ok(!deepaHrefs.includes("/accounts"));
  assert.ok(!deepaHrefs.includes("/settings"));
  assert.ok(!deepaHrefs.includes("/price-list"));
  assert.ok(!deepaNav.some((e) => e.label === "Customs"));

  const purchaseNav = filterSidebarNav(SIDEBAR_NAV, {
    role: "purchase",
    can: canFromStaticMatrix(getDefaultPermissionsForRole("purchase")),
    permissionsReady: true,
  });
  const purchaseHrefs = purchaseNav.flatMap((e) => (e.items ? e.items.map((i) => i.to) : [e.to]));
  assert.ok(purchaseHrefs.includes("/purchase"));
  assert.ok(purchaseHrefs.includes("/asn"));
  assert.ok(!purchaseHrefs.includes("/sales"));
  assert.ok(!purchaseHrefs.includes("/settings"));
  assert.ok(!purchaseHrefs.includes("/price-list"));
});

run("Permission-loading state does not show unrestricted navigation", () => {
  const loadingPurchase = filterSidebarNav(SIDEBAR_NAV, {
    role: "purchase",
    can: () => true,
    permissionsReady: false,
  });
  assert.equal(loadingPurchase.length, 0);
  const loadingAdmin = filterSidebarNav(SIDEBAR_NAV, {
    role: "admin",
    can: () => true,
    permissionsReady: false,
  });
  assert.equal(loadingAdmin.length, 0);
  const loadingSa = filterSidebarNav(SIDEBAR_NAV, {
    role: "super_admin",
    can: () => true,
    permissionsReady: false,
  });
  assert.equal(loadingSa.length, 0);
  assert.equal(
    canAccessPath("/purchase", { role: "admin", can: () => true, permissionsReady: false }),
    false
  );
  assert.equal(
    canAccessPath("/settings", { role: "super_admin", can: () => true, permissionsReady: false }),
    false
  );
  assert.equal(
    canPerform({ permissionsReady: false, permissionFailed: false, liveRole: "admin", matrix: null }, "SETTINGS", "view"),
    false
  );
});

run("Stale Admin session cannot grant access before or against live Purchase identity", () => {
  assert.equal(
    canPerform(
      { permissionsReady: false, permissionFailed: false, liveRole: "admin", matrix: null },
      "SETTINGS",
      "view"
    ),
    false
  );
  const livePurchase = getDefaultPermissionsForRole("purchase");
  assert.equal(
    canPerform(
      {
        permissionsReady: true,
        permissionFailed: false,
        liveRole: "purchase",
        matrix: livePurchase,
      },
      "SETTINGS",
      "view"
    ),
    false
  );
  assert.equal(
    canAccessPath("/settings", {
      role: "purchase",
      can: canFromStaticMatrix(livePurchase),
      permissionsReady: true,
    }),
    false
  );
  assert.equal(
    canAccessPath("/purchase", {
      role: "purchase",
      can: canFromStaticMatrix(livePurchase),
      permissionsReady: true,
    }),
    true
  );
  const adminNav = filterSidebarNav(SIDEBAR_NAV, {
    role: "purchase",
    can: canFromStaticMatrix(livePurchase),
    permissionsReady: true,
  });
  const hrefs = adminNav.flatMap((e) => (e.items ? e.items.map((i) => i.to) : [e.to]));
  assert.ok(!hrefs.includes("/settings"));
});

run("Permission request failure exposes no module page", () => {
  assert.equal(
    canPerform(
      { permissionsReady: false, permissionFailed: true, liveRole: "admin", matrix: {} },
      "SETTINGS",
      "view"
    ),
    false
  );
  assert.equal(
    canAccessPath("/settings", {
      role: "admin",
      can: () => true,
      permissionsReady: true,
      permissionFailed: true,
    }),
    false
  );
  const failedNav = filterSidebarNav(SIDEBAR_NAV, {
    role: "admin",
    can: () => true,
    permissionsReady: false,
    permissionFailed: true,
  });
  assert.equal(failedNav.length, 0);
});

run("Admin receives Settings only after successful live bootstrap", () => {
  const adminMatrix = getDefaultPermissionsForRole("admin");
  assert.equal(
    canPerform(
      { permissionsReady: false, permissionFailed: false, liveRole: "", matrix: null },
      "SETTINGS",
      "view"
    ),
    false
  );
  assert.equal(
    canPerform(
      {
        permissionsReady: true,
        permissionFailed: false,
        liveRole: "admin",
        matrix: adminMatrix,
      },
      "SETTINGS",
      "view"
    ),
    true
  );
  assert.equal(
    canAccessPath("/settings", {
      role: "admin",
      can: canFromStaticMatrix(adminMatrix),
      permissionsReady: true,
    }),
    true
  );
  assert.equal(
    canAccessPath("/settings", {
      role: "company_admin",
      can: canFromStaticMatrix(getDefaultPermissionsForRole("company_admin")),
      permissionsReady: true,
    }),
    true
  );
});

run("Settings is denied for Staff, View Only, Sales, Purchase and custom roles", () => {
  const roles = ["staff", "view_only", "sales", "purchase", "purchase_sales", "store", "logistics", "accounts"];
  for (const role of roles) {
    const matrix = getDefaultPermissionsForRole(role);
    const ctx = { role, can: canFromStaticMatrix(matrix), permissionsReady: true };
    assert.equal(canAccessPath("/settings", ctx), false, `${role} must not open /settings`);
    const hrefs = filterSidebarNav(SIDEBAR_NAV, ctx).flatMap((e) =>
      e.items ? e.items.map((i) => i.to) : [e.to]
    );
    assert.ok(!hrefs.includes("/settings"), `${role} must not see Settings`);
  }
  const allowSettingsView = () => true;
  assert.equal(
    canAccessPath("/settings", { role: "view_only", can: allowSettingsView, permissionsReady: true }),
    false
  );
  const customCtx = {
    role: "view_only",
    can: canFromStaticMatrix(deepaMatrix()),
    permissionsReady: true,
  };
  assert.equal(canAccessPath("/settings", customCtx), false);
  assert.equal(canAccessPath("/profile", customCtx), true);
});

run("Admin and Super Admin retain intended access", () => {
  const adminCan = canFromStaticMatrix(getDefaultPermissionsForRole("admin"));
  const adminCtx = { role: "admin", can: adminCan, permissionsReady: true };
  assert.equal(canAccessPath("/settings", adminCtx), true);
  assert.equal(canAccessPath("/purchase", adminCtx), true);
  assert.equal(canAccessPath("/sales", adminCtx), true);
  assert.equal(canAccessPath("/price-list", adminCtx), true);
  const saCan = canFromStaticMatrix(getDefaultPermissionsForRole("super_admin"));
  const saCtx = { role: "super_admin", can: saCan, permissionsReady: true };
  assert.equal(canAccessPath("/settings", saCtx), true);
  assert.equal(canAccessPath("/price-list", saCtx), true);
  assert.equal(firstAuthorizedPath(saCtx), "/dashboard");
});

run("Store Operator restrictions remain intact", () => {
  const opCan = canFromStaticMatrix(getDefaultPermissionsForRole("store_operator"));
  const ctx = { role: "store_operator", can: opCan, permissionsReady: true };
  assert.equal(canAccessPath("/store", ctx), true);
  assert.equal(canAccessPath("/profile", ctx), true);
  assert.equal(canAccessPath("/purchase", ctx), false);
  assert.equal(canAccessPath("/sales", ctx), false);
  assert.equal(canAccessPath("/settings", ctx), false);
  assert.equal(firstAuthorizedPath(ctx), "/store");
});

run("Frontend/backend module action catalogues match", () => {
  assert.deepEqual(FE_MODULE_ACTIONS, BE_MODULE_ACTIONS);
  const salesAll = allowedActionsForModule("SALES");
  assert.ok(salesAll.includes("view"));
  assert.ok(!salesAll.includes("admin"));
  assert.ok(FE_MODULE_ACTIONS.LABELS.includes("admin"));
  assert.ok(FE_MODULE_ACTIONS.ARTICLE_CONVERSION.includes("admin"));
  assert.ok(FE_MODULE_ACTIONS.ITEM_MASTER.includes("approve"));
  assert.ok(FE_MODULE_ACTIONS.ITEM_MASTER.includes("cancel"));
  const storeOp = getDefaultPermissionsForRole("store_operator");
  assert.ok(storeOp.STORE.includes("post"));
});

run("Role Form All does not copy global-only actions", () => {
  const cleaned = sanitiseRolePayload({
    code: "SALES COORDINATOR",
    name: "Deepa",
    permissions: [{ module: "SALES", actions: ["view", "admin", "override", "post", "reverse", "create"] }],
  });
  const sales = cleaned.permissions.find((p) => p.module === "SALES");
  assert.deepEqual(sales.actions.sort(), ["create", "view"]);
  assert.ok(hasDangerousRoleActions([{ module: "STORE", actions: ["view", "post"] }]));
  assert.ok(!hasDangerousRoleActions([{ module: "SALES", actions: ["view", "create"] }]));
  assert.deepEqual(selectedPermissionSummary([{ module: "SALES", actions: ["view"] }]), ["SALES: view"]);
});

run("Admin companies listing is admin-gated and membership-scoped", () => {
  const adminRoutes = fs.readFileSync(path.join(backendRoot, "src/routes/adminRoutes.js"), "utf8");
  assert.match(adminRoutes, /router\.get\("\/companies", requireAuth, requireRole\(\.\.\.adminRoles\), masters\.listCompanies\)/);
  assert.match(
    adminRoutes,
    /router\.get\("\/companies\/:id", requireAuth, requireRole\(\.\.\.adminRoles\), masters\.getCompany\)/
  );
  assert.match(
    adminRoutes,
    /router\.get\("\/roles", settingsView, requireRole\(\.\.\.adminRoles\), roles\.listRoles\)/
  );
  assert.match(adminRoutes, /router\.get\("\/me\/permissions", roles\.getMyPermissions\)/);
  const masters = fs.readFileSync(
    path.join(backendRoot, "src/controllers/masterDataController.js"),
    "utf8"
  );
  assert.match(masters, /if \(!isSuperAdminRole\(user\.role\)\)/);
  assert.match(masters, /filter\._id = \{ \$in: allowedIds \}/);
  const authRoutes = fs.readFileSync(path.join(backendRoot, "src/routes/authRoutes.js"), "utf8");
  assert.match(authRoutes, /router\.get\("\/companies", requireAuth/);
  const rolesCtrl = fs.readFileSync(path.join(backendRoot, "src/controllers/rolesController.js"), "utf8");
  assert.match(rolesCtrl, /role: req\.user\?\.role \|\| ""/);
  assert.match(rolesCtrl, /roleIds: Array\.isArray\(req\.user\?\.roleIds\)/);
});

run("Frontend source uses the shared permission map", () => {
  const sidebar = fs.readFileSync(path.join(feRoot, "components/Sidebar.jsx"), "utf8");
  const guard = fs.readFileSync(path.join(feRoot, "components/ModulePermissionGuard.jsx"), "utf8");
  const denied = fs.readFileSync(path.join(feRoot, "pages/AccessDenied.jsx"), "utf8");
  const settings = fs.readFileSync(path.join(feRoot, "pages/Settings.jsx"), "utf8");
  const layout = fs.readFileSync(path.join(feRoot, "components/AppLayout.jsx"), "utf8");
  const protectedRoute = fs.readFileSync(path.join(feRoot, "components/ProtectedRoute.jsx"), "utf8");
  const authCtx = fs.readFileSync(path.join(feRoot, "context/AuthContext.jsx"), "utf8");
  const access = fs.readFileSync(path.join(feRoot, "lib/rbacAccess.js"), "utf8");
  assert.match(sidebar, /filterSidebarNav/);
  assert.match(sidebar, /isStoreOperatorRole/);
  assert.match(sidebar, /sidebar-permissions-loading/);
  assert.match(guard, /canAccessPath/);
  assert.match(guard, /AccessDenied/);
  assert.match(guard, /permissions-failed/);
  assert.match(denied, /Access denied/);
  assert.match(layout, /ModulePermissionGuard/);
  assert.match(protectedRoute, /storeOperatorAllowedPath/);
  assert.match(settings, /allowedActionsForModule/);
  assert.match(settings, /confirmDialog/);
  assert.match(settings, /Selected permissions/);
  assert.match(authCtx, /canPerform/);
  assert.match(authCtx, /liveRole/);
  assert.doesNotMatch(authCtx, /isFullAdminRole\(role\) && !permissionMatrix/);
  assert.match(access, /prefix: "\/settings", requireAdmin: true/);
  assert.doesNotMatch(access, /settingsAccess/);
  const profile = fs.readFileSync(path.join(feRoot, "pages/MyProfile.jsx"), "utf8");
  const app = fs.readFileSync(path.join(feRoot, "App.jsx"), "utf8");
  assert.match(profile, /\/profile\/security/);
  assert.match(app, /path="profile"/);
  assert.match(app, /path="profile\/security"/);
  assert.match(app, /path="settings"/);
});

run("Fail-closed resolver does not keep View Only defaults", () => {
  const src = fs.readFileSync(path.join(backendRoot, "src/services/roleService.js"), "utf8");
  assert.match(src, /failing closed/);
  assert.doesNotMatch(src, /Soft fall-through: legacy role defaults remain/);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
