/**
 * S0 — Authentication / tenant / perimeter security tests.
 * Run: node scripts/authSecurity.s0.test.js
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ADMIN_ASSIGNABLE_ROLES,
  USER_CREATE_PROHIBITED_BODY_FIELDS,
  assertAssignableCompanies,
  assertAssignableRole,
  pickUserCreateBody,
  resolveCreatePassword,
} from "../src/utils/authAdminPolicy.js";
import {
  buildCorsAllowlist,
  isCorsOriginAllowed,
  isProductionNodeEnv,
  parseCorsAllowedOrigins,
} from "../src/utils/corsAllowlist.js";
import { authRateLimitersFromEnv, consumeLimiter, createRateLimiter } from "../src/middleware/rateLimit.js";
import { normalizeFilters } from "../src/controllers/analyticsController.js";

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

console.log("\nAuth security (S0)\n");

run("Public register route returns 410 / REGISTRATION_DISABLED", () => {
  const src = fs.readFileSync(path.join(backendRoot, "src/routes/authRoutes.js"), "utf8");
  assert.match(src, /REGISTRATION_DISABLED/);
  assert.match(src, /status\(410\)/);
  assert.doesNotMatch(src, /User\.create\(\{[\s\S]*allowedCompanies:\s*allCompanyIds/);
});

run("Public request cannot assign admin via removed register body", () => {
  const src = fs.readFileSync(path.join(backendRoot, "src/routes/authRoutes.js"), "utf8");
  assert.doesNotMatch(src, /router\.post\("\/register",\s*async/);
});

run("Authorized admin role policy allows staff; forbids super_admin for ordinary admin", () => {
  assert.equal(assertAssignableRole({ actorRole: "admin", requestedRole: "staff" }), "staff");
  assert.throws(
    () => assertAssignableRole({ actorRole: "admin", requestedRole: "super_admin" }),
    (e) => e.code === "SUPER_ADMIN_ASSIGN_FORBIDDEN" && e.statusCode === 403
  );
  assert.equal(
    assertAssignableRole({ actorRole: "super_admin", requestedRole: "super_admin" }),
    "super_admin"
  );
});

run("Company admin cannot assign unrelated company", () => {
  assert.throws(
    () =>
      assertAssignableCompanies({
        actorRole: "company_admin",
        requestedCompanyIds: ["c2"],
        actorAllowedCompanyIds: ["c1"],
        activeCompanyIds: ["c1", "c2"],
      }),
    (e) => e.code === "COMPANY_ASSIGN_FORBIDDEN"
  );
});

run("Ordinary admin cannot grant all-company access", () => {
  assert.throws(
    () =>
      assertAssignableCompanies({
        actorRole: "admin",
        requestedCompanyIds: ["c1", "c2"],
        actorAllowedCompanyIds: ["c1", "c2"],
        activeCompanyIds: ["c1", "c2"],
      }),
    (e) => e.code === "ALL_COMPANY_ASSIGN_FORBIDDEN"
  );
});

run("Super admin may assign all active companies", () => {
  const ids = assertAssignableCompanies({
    actorRole: "super_admin",
    requestedCompanyIds: ["c1", "c2"],
    actorAllowedCompanyIds: [],
    activeCompanyIds: ["c1", "c2"],
  });
  assert.deepEqual(ids.sort(), ["c1", "c2"]);
});

run("Empty company array rejected", () => {
  assert.throws(
    () =>
      assertAssignableCompanies({
        actorRole: "super_admin",
        requestedCompanyIds: [],
        activeCompanyIds: ["c1"],
      }),
    (e) => e.code === "COMPANY_IDS_REQUIRED"
  );
});

run("User creation rejects protected fields", () => {
  assert.throws(
    () => pickUserCreateBody({ email: "a@b.com", passwordHash: "x", role: "staff" }),
    (e) => e.code === "PROTECTED_FIELD_REJECTED"
  );
  assert.ok(USER_CREATE_PROHIBITED_BODY_FIELDS.includes("twoFactorSecret"));
  const picked = pickUserCreateBody({
    email: "a@b.com",
    password: "longpassword1",
    role: "staff",
    companyIds: ["c1"],
  });
  assert.equal(picked.email, "a@b.com");
  assert.equal(resolveCreatePassword(picked), "longpassword1");
});

run("Seed script contains no plaintext credential literals", () => {
  const src = fs.readFileSync(path.join(backendRoot, "src/seedUsers.js"), "utf8");
  assert.doesNotMatch(src, /advitya2026|kalpesh13568|himanshu@22348/);
  assert.match(src, /SEED_ADMIN_PASSWORD/);
  assert.match(src, /SEED_ALLOW_PRODUCTION/);
  assert.match(src, /SEED_RESET_PASSWORDS/);
});

run("Seed script refuses unsafe production execution", () => {
  const src = fs.readFileSync(path.join(backendRoot, "src/seedUsers.js"), "utf8");
  assert.match(src, /Refusing to run seedUsers in production without SEED_ALLOW_PRODUCTION=true/);
});

run("Analytics ignores query.company override", () => {
  const f = normalizeFilters({
    companyId: "company-A",
    query: { company: "company-B", customer: "Acme" },
    body: { companyId: "company-C" },
  });
  assert.equal(f.companyId, "company-A");
  assert.equal(f.customer, "Acme");
});

run("Analytics requires authenticated company context", () => {
  assert.throws(
    () => normalizeFilters({ companyId: "", query: { company: "other" } }),
    (e) => e.code === "COMPANY_CONTEXT_REQUIRED"
  );
});

run("Login rate limiting works", () => {
  const limiter = createRateLimiter({
    name: "t_login",
    windowMs: 60_000,
    max: 3,
    keyFn: (req) => `ip:${req.body?.email || ""}`,
  });
  const req = { body: { email: "user@example.com" }, headers: {}, ip: "1.2.3.4" };
  const results = consumeLimiter(limiter, req, {}, 4);
  assert.equal(results.filter((r) => !r.limited).length, 3);
  assert.equal(results[3].limited, true);
  assert.equal(results[3].status, 429);
});

run("TOTP rate limiting works", () => {
  const limits = authRateLimitersFromEnv();
  limits.totp._resetForTests();
  const req = {
    body: { twoFactorTicket: "ticket-abc", code: "123456" },
    headers: {},
    ip: "9.9.9.9",
  };
  // Default max is 10 — exhaust with local limiter for determinism
  const limiter = createRateLimiter({ name: "t_totp", windowMs: 60_000, max: 2, keyFn: () => "totp" });
  const results = consumeLimiter(limiter, req, {}, 3);
  assert.equal(results[2].status, 429);
});

run("Rate-limit response is generic (no account disclosure)", () => {
  const limiter = createRateLimiter({ name: "t_msg", windowMs: 60_000, max: 1, keyFn: () => "k" });
  const req = { headers: {}, ip: "1.1.1.1", body: { email: "secret@x.com" } };
  let body;
  const res = {
    setHeader() {},
    status() {
      return this;
    },
    json(payload) {
      body = payload;
      return this;
    },
  };
  consumeLimiter(limiter, req, {}, 1);
  limiter(req, res, () => {});
  assert.equal(body.code, "RATE_LIMITED");
  assert.doesNotMatch(JSON.stringify(body), /secret@x\.com|user not found|Invalid credentials/i);
});

run("Unapproved Vercel origin rejected in production allowlist", () => {
  const allow = buildCorsAllowlist({
    corsAllowedOrigins: "https://marivolt-erp.vercel.app",
    clientUrl: "",
    nodeEnv: "production",
  });
  assert.equal(isCorsOriginAllowed("https://marivolt-erp.vercel.app", allow), true);
  assert.equal(isCorsOriginAllowed("https://evil-preview.vercel.app", allow), false);
  assert.equal(isCorsOriginAllowed("http://localhost:5173", allow), false);
});

run("Approved production origin works; localhost rejected in production", () => {
  assert.equal(isProductionNodeEnv("production"), true);
  const allow = buildCorsAllowlist({
    corsAllowedOrigins: "https://app.example.com",
    nodeEnv: "production",
  });
  assert.equal(isCorsOriginAllowed("https://app.example.com", allow), true);
  assert.equal(isCorsOriginAllowed("http://127.0.0.1:5173", allow), false);
});

run("Localhost allowed outside production", () => {
  const allow = buildCorsAllowlist({
    corsAllowedOrigins: "",
    nodeEnv: "development",
  });
  assert.equal(isCorsOriginAllowed("http://localhost:5173", allow), true);
});

run("CORS parser handles comma-separated exact origins", () => {
  assert.deepEqual(parseCorsAllowedOrigins(" https://a.com , https://b.com "), [
    "https://a.com",
    "https://b.com",
  ]);
});

run("server.js no longer allows wildcard *.vercel.app", () => {
  const src = fs.readFileSync(path.join(backendRoot, "src/server.js"), "utf8");
  assert.doesNotMatch(src, /endsWith\("\.vercel\.app"\)/);
  assert.match(src, /createCorsOriginDelegate/);
  assert.match(src, /trust proxy/);
});

run("Company update uses whitelist and membership checks", () => {
  const src = fs.readFileSync(path.join(backendRoot, "src/controllers/masterDataController.js"), "utf8");
  assert.match(src, /COMPANY_UPDATE_FORBIDDEN/);
  assert.match(src, /sanitiseCompanyPayload/);
  assert.match(src, /PROTECTED_FIELD_REJECTED/);
  assert.match(src, /assertCompanyMembership/);
});

run("Admin user create endpoint exists with role guards", () => {
  const src = fs.readFileSync(path.join(backendRoot, "src/routes/authRoutes.js"), "utf8");
  assert.match(src, /router\.post\(\s*"\/users"/);
  assert.match(src, /assertAssignableRole/);
  assert.match(src, /assertAssignableCompanies/);
  assert.match(src, /pickUserCreateBody/);
  assert.ok(ADMIN_ASSIGNABLE_ROLES.includes("staff"));
});

run("Frontend has no public register UI", () => {
  const pages = fs.readdirSync(path.join(repoRoot, "src/pages"));
  for (const f of pages) {
    if (!f.endsWith(".jsx") && !f.endsWith(".js")) continue;
    const src = fs.readFileSync(path.join(repoRoot, "src/pages", f), "utf8");
    assert.doesNotMatch(src, /\/auth\/register/);
  }
});

run("RTS remains absent from auth/security paths", () => {
  const auth = fs.readFileSync(path.join(backendRoot, "src/routes/authRoutes.js"), "utf8");
  assert.doesNotMatch(auth, /\bRTS\b|moveAllocationToRTS/);
  assert.ok(!fs.existsSync(path.join(backendRoot, "src/models/Rts.js")));
});

run("Deployment doc documents rotation checklist without passwords", () => {
  const doc = fs.readFileSync(path.join(repoRoot, "docs/security-s0-deployment.md"), "utf8");
  assert.match(doc, /CORS_ALLOWED_ORIGINS/);
  assert.match(doc, /rotate/i);
  assert.doesNotMatch(doc, /advitya2026|kalpesh13568|himanshu@22348/);
});

console.log(`\nAuth security S0: ${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
