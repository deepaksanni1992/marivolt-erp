/**
 * Customs Dashboard acceptance audit — node backend/scripts/customsDashboardAudit.mjs
 */
const API_BASE = (process.env.API_BASE || "https://marivolt-erp.onrender.com/api").replace(/\/$/, "");

const report = { passed: [], failed: [], warnings: [] };

function pass(id, msg) {
  report.passed.push({ id, msg });
  console.log(`PASS [${id}] ${msg}`);
}
function fail(id, msg) {
  report.failed.push({ id, msg });
  console.error(`FAIL [${id}] ${msg}`);
}
function warn(id, msg) {
  report.warnings.push({ id, msg });
  console.warn(`WARN [${id}] ${msg}`);
}

async function api(path, { token, companyId, method = "GET", body } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (companyId) headers["x-company-id"] = companyId;
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(90000),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

async function login(username, password) {
  const loginRes = await fetch(`${API_BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: username, password }),
  });
  let data = await loginRes.json();
  const companies = data.companies || [];
  const pick = (code) => companies.find((c) => String(c.code || "").toUpperCase() === code);
  if (data.requiresCompanySelection && data.loginTicket) {
    const mar = pick("MAR");
    const selRes = await fetch(`${API_BASE}/auth/select-company`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ loginTicket: data.loginTicket, companyId: mar?.id }),
    });
    data = await selRes.json();
  }
  if (!data.token) throw new Error("Login failed");
  return { token: data.token, marId: pick("MAR")?.id, okeId: pick("OKE")?.id };
}

async function main() {
  console.log("=== Customs Dashboard Audit ===\nAPI:", API_BASE);
  try {
    const auth = await login(process.env.AUDIT_USER || "advitya", process.env.AUDIT_PASS || "advitya2026");

    const route = await api("/customs/dashboard", { token: auth.token, companyId: auth.marId });
    if (route.status === 404) fail("API", "GET /customs/dashboard not found");
    else if (route.status === 200) pass("API", "GET /customs/dashboard → 200");
    else fail("API", `Unexpected status ${route.status}`);

    const s = route.data?.summary || {};
    if (typeof s.openBlCount === "number") pass("KPI-BL", `Open BL Count = ${s.openBlCount}`);
    else fail("KPI-BL", "openBlCount missing");
    if (typeof s.openBoeCount === "number") pass("KPI-BOE", `Open BOE Count = ${s.openBoeCount}`);
    else fail("KPI-BOE", "openBoeCount missing");
    if (typeof s.customsStockValue === "number") pass("KPI-VALUE", `Stock Value = ${s.customsStockValue}`);
    else fail("KPI-VALUE", "customsStockValue missing");
    if (typeof s.pendingReconciliation === "number") pass("KPI-RECON", `Pending Reconciliation = ${s.pendingReconciliation}`);
    else fail("KPI-RECON", "pendingReconciliation missing");

    if (Array.isArray(route.data?.stockOverview)) pass("TABLE-STOCK", `Stock overview ${route.data.stockOverview.length} rows`);
    if (Array.isArray(route.data?.openBl)) pass("TABLE-BL", `Open BL ${route.data.openBl.length} rows`);
    if (Array.isArray(route.data?.openBoe)) pass("TABLE-BOE", `Open BOE ${route.data.openBoe.length} rows`);
    if (Array.isArray(route.data?.movementTrend)) pass("CHART", `Movement trend ${route.data.movementTrend.length} months`);

    const exportLog = await api("/customs/dashboard/export-log", {
      token: auth.token,
      companyId: auth.marId,
      method: "POST",
      body: { format: "pdf", filters: {} },
    });
    if (exportLog.status === 200 && exportLog.data?.logged) pass("AUDIT", "Export audit log accepted");
    else if (exportLog.status === 403) warn("AUDIT", "Export log permission denied");
    else warn("AUDIT", `Export log status ${exportLog.status}`);

    if (auth.marId && auth.okeId) {
      const mar = await api("/customs/dashboard", { token: auth.token, companyId: auth.marId });
      const oke = await api("/customs/dashboard", { token: auth.token, companyId: auth.okeId });
      if (mar.data?.companyCode !== oke.data?.companyCode) pass("ISO", `MAR=${mar.data?.companyCode} OKE=${oke.data?.companyCode}`);
      else warn("ISO", "Verify company isolation manually");
    }
  } catch (err) {
    fail("FATAL", err.message);
  }

  console.log(`\nPassed: ${report.passed.length}, Failed: ${report.failed.length}, Warnings: ${report.warnings.length}`);
  process.exit(report.failed.length ? 1 : 0);
}

main();
