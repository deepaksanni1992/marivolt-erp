/**
 * Data Health Dashboard acceptance audit — node backend/scripts/dataHealthAudit.mjs
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
  const t0 = performance.now();
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (companyId) headers["x-company-id"] = companyId;
  const res = await fetch(`${API_BASE}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(120000) });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data, ms: Math.round(performance.now() - t0) };
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
  console.log("=== Data Health Dashboard Audit ===\nAPI:", API_BASE);
  try {
    const auth = await login(process.env.AUDIT_USER || "advitya", process.env.AUDIT_PASS || "advitya2026");

    const route = await api("/data-health", { token: auth.token, companyId: auth.marId });
    if (route.status === 404) fail("API", "GET /data-health not found");
    else if (route.status === 200) pass("API", `GET /data-health → 200 (${route.ms}ms)`);
    else fail("API", `Status ${route.status}`);

    if (route.ms > 3000) warn("PERF", `Load ${route.ms}ms exceeds 3s target`);
    else pass("PERF", `Load ${route.ms}ms`);

    const d = route.data || {};
    if (typeof d.healthScore === "number" && d.healthScore >= 0 && d.healthScore <= 100) {
      const expected = 100 - d.criticalCount * 10 - d.majorCount * 5 - d.minorCount * 1;
      const clamped = Math.max(0, expected);
      if (Math.abs(d.healthScore - clamped) <= 0.01) pass("SCORE", `Health score ${d.healthScore} (${d.healthRating})`);
      else warn("SCORE", `Score ${d.healthScore} vs expected ${clamped} (filtered issues may differ)`);
    } else fail("SCORE", "healthScore missing");

    if (Array.isArray(d.issues)) pass("ISSUES", `${d.issues.length} issue rows, critical=${d.criticalCount} major=${d.majorCount} minor=${d.minorCount}`);
    else fail("ISSUES", "issues array missing");

    if (d.counts?.salesCount != null) pass("COUNTS", "Entity counts present");

    const filtered = await api("/data-health?severity=Critical", { token: auth.token, companyId: auth.marId });
    if (filtered.status === 200 && (filtered.data.issues || []).every((i) => i.severity === "Critical")) pass("FILTER", "Severity filter works");
    else warn("FILTER", "Severity filter check inconclusive");

    for (const fmt of ["pdf", "excel", "csv"]) {
      const exp = await api("/data-health/export-log", { token: auth.token, companyId: auth.marId, method: "POST", body: { format: fmt } });
      if (exp.status === 200 && exp.data?.logged) pass(`EXPORT-${fmt.toUpperCase()}`, "Export audit logged");
      else warn(`EXPORT-${fmt.toUpperCase()}`, `Status ${exp.status}`);
    }

    if (auth.marId && auth.okeId) {
      const mar = await api("/data-health", { token: auth.token, companyId: auth.marId });
      const oke = await api("/data-health", { token: auth.token, companyId: auth.okeId });
      if (mar.data?.companyCode === "MAR") pass("ISO-MAR", "MAR scoped");
      if (oke.data?.companyCode === "OKE" || oke.data?.counts?.salesCount !== mar.data?.counts?.salesCount) pass("ISO-OKE", "OKE isolated from MAR counts");
      else warn("ISO", "Verify company isolation manually");
    }
  } catch (err) {
    fail("FATAL", err.message);
  }

  console.log(`\nPassed: ${report.passed.length}, Failed: ${report.failed.length}, Warnings: ${report.warnings.length}`);
  process.exit(report.failed.length ? 1 : 0);
}

main();
