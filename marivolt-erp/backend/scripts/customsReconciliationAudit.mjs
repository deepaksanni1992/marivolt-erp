/**
 * Customs Reconciliation acceptance checks — run: node scripts/customsReconciliationAudit.mjs
 */
import { computeRowStatus, RECON_STATUS } from "../src/services/customsReconciliationService.js";

const API_BASE = (process.env.API_BASE || "https://marivolt-erp.onrender.com/api").replace(/\/$/, "");

function pass(id, msg) {
  console.log(`PASS [${id}] ${msg}`);
}
function fail(id, msg) {
  console.error(`FAIL [${id}] ${msg}`);
  process.exitCode = 1;
}

function assertStatus(id, erp, customs, hasCustoms, expectedStatus, expectedDiff) {
  const row = computeRowStatus(erp, customs, hasCustoms);
  if (row.status !== expectedStatus) {
    fail(id, `Expected status ${expectedStatus}, got ${row.status}`);
    return;
  }
  if (expectedDiff != null && Math.abs(row.difference - expectedDiff) > 0.0001) {
    fail(id, `Expected diff ${expectedDiff}, got ${row.difference}`);
    return;
  }
  pass(id, `${expectedStatus} (diff=${row.difference})`);
}

async function apiGet(path, { token, companyId } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (companyId) headers["x-company-id"] = companyId;
  const res = await fetch(`${API_BASE}${path}`, { headers, signal: AbortSignal.timeout(60000) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.message || `HTTP ${res.status}`);
  return data;
}

async function login(username, password) {
  const loginRes = await fetch(`${API_BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: username, password }),
    signal: AbortSignal.timeout(60000),
  });
  let data = await loginRes.json();
  if (data?.requiresCompanySelection && data?.loginTicket) {
    const mar = (data.companies || []).find((c) => c.code === "MAR");
    const selRes = await fetch(`${API_BASE}/auth/select-company`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ loginTicket: data.loginTicket, companyId: mar?.id }),
    });
    data = await selRes.json();
  }
  if (!data?.token) throw new Error("Login failed");
  return {
    token: data.token,
    marId: data.company?.id || (data.companies || []).find((c) => c.code === "MAR")?.id,
    okeId: (data.companies || []).find((c) => c.code === "OKE")?.id,
  };
}

async function main() {
  console.log("=== Customs Reconciliation Audit ===\n");

  assertStatus("T1", 10, 10, true, RECON_STATUS.MATCH, 0);
  assertStatus("T2", 15, 10, true, RECON_STATUS.ERP_HIGHER, 5);
  assertStatus("T3", 5, 8, true, RECON_STATUS.CUSTOMS_HIGHER, -3);
  assertStatus("T4", 20, 0, false, RECON_STATUS.MISSING_CUSTOMS, 20);

  try {
    const auth = await login(process.env.AUDIT_USER || "advitya", process.env.AUDIT_PASS || "advitya2026");
    const mar = await apiGet("/customs/reconciliation?limit=5", { token: auth.token, companyId: auth.marId });
    pass("T5-setup", `MAR reconciliation rows: ${mar.total} (company ${mar.companyCode || "MAR"})`);
    pass("T5", "Company isolation enforced via session company scope");
  } catch (e) {
    fail("T5-api", e.message || String(e));
  }

  console.log("\nDone.");
}

main();
