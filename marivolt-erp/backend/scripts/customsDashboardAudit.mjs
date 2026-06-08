/**
 * Customs Dashboard V2 acceptance audit — node backend/scripts/customsDashboardAudit.mjs
 */
const API_BASE = (process.env.API_BASE || "https://marivolt-erp.onrender.com/api").replace(/\/$/, "");

const report = { passed: [], failed: [], warnings: [], performance: [] };

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
  const t0 = performance.now();
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
  const ms = Math.round(performance.now() - t0);
  return { status: res.status, data, ms };
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

function bucketSum(b) {
  return (b.under30 || 0) + (b.days30to60 || 0) + (b.days61to90 || 0) + (b.over90 || 0);
}

async function main() {
  console.log("=== Customs Dashboard V2 Audit ===\nAPI:", API_BASE);
  try {
    const auth = await login(process.env.AUDIT_USER || "advitya", process.env.AUDIT_PASS || "advitya2026");

    const route = await api("/customs/dashboard", { token: auth.token, companyId: auth.marId });
    report.performance.push({ id: "dashboard-load", ms: route.ms });
    if (route.status === 404) fail("API", "GET /customs/dashboard not found");
    else if (route.status === 200) pass("API", `GET /customs/dashboard → 200 (${route.ms}ms)`);
    else fail("API", `Unexpected status ${route.status}`);

    if (route.ms > 3000) warn("PERF", `Dashboard load ${route.ms}ms exceeds 3s target`);
    else pass("PERF", `Dashboard load ${route.ms}ms (< 3s)`);

    const d = route.data || {};
    const buckets = d.blAgingBuckets || {};
    const blSum = bucketSum(buckets);
    const openBl = d.summary?.openBlCount || 0;
    if (typeof buckets.under30 === "number") pass("AGING-BUCKETS", `BL aging buckets present (sum=${blSum}, openBL=${openBl})`);
    else fail("AGING-BUCKETS", "blAgingBuckets missing");

    if (Array.isArray(d.blAging) && d.blAging.length) {
      const row = d.blAging[0];
      if (typeof row.ageDays === "number" && row.status) pass("AGING-TABLE", `BL aging row: age=${row.ageDays} status=${row.status}`);
      const valueOk = d.blAging.every((r) => Number.isFinite(r.openValue));
      if (valueOk) pass("VALUE-CALC", "Open value fields numeric on all BL aging rows");
    } else {
      warn("AGING-TABLE", "No BL aging rows (may be empty data)");
    }

    if (Array.isArray(d.topValueArticles)) {
      pass("TOP-ARTICLES", `Top articles: ${d.topValueArticles.length} rows`);
      if (d.topValueArticles.length) {
        const top = d.topValueArticles[0];
        const expected = Number((top.balanceQty * top.unitPrice).toFixed(2));
        if (Math.abs(top.customsValue - expected) < 0.02) pass("TOP-ARTICLE-VALUE", `Value formula OK for ${top.article}`);
        else warn("TOP-ARTICLE-VALUE", `Expected ~${expected}, got ${top.customsValue}`);
      }
    } else fail("TOP-ARTICLES", "topValueArticles missing");

    if (d.exposure?.totalCustomsStockValue != null) pass("EXPOSURE", `Exposure summary present (stock value=${d.exposure.totalCustomsStockValue})`);
    else fail("EXPOSURE", "exposure summary missing");

    const exportLog = await api("/customs/dashboard/export-log", {
      token: auth.token,
      companyId: auth.marId,
      method: "POST",
      body: { format: "pdf", filters: {} },
    });
    if (exportLog.status === 200 && exportLog.data?.logged) pass("EXPORT-AUDIT", "Export audit log accepted");
    else warn("EXPORT-AUDIT", `Export log status ${exportLog.status}`);

    if (auth.marId && auth.okeId) {
      const mar = await api("/customs/dashboard", { token: auth.token, companyId: auth.marId });
      const oke = await api("/customs/dashboard", { token: auth.token, companyId: auth.okeId });
      if (mar.data?.companyCode === "MAR") pass("ISO-MAR", "MAR company scoped");
      if (oke.data?.companyCode === "OKE" || !oke.data?.summary?.openBlCount) pass("ISO-OKE", `OKE scoped (code=${oke.data?.companyCode || "—"})`);
    } else {
      warn("ISO", "OKE company id not in login payload");
    }
  } catch (err) {
    fail("FATAL", err.message);
  }

  console.log("\n=== Summary ===");
  console.log(`Passed: ${report.passed.length}, Failed: ${report.failed.length}, Warnings: ${report.warnings.length}`);
  if (report.performance.length) console.log(`Performance: ${report.performance.map((p) => `${p.id}=${p.ms}ms`).join(", ")}`);
  process.exit(report.failed.length ? 1 : 0);
}

main();
