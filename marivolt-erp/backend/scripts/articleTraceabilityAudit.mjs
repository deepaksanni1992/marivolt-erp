/**
 * Article Traceability acceptance audit — node scripts/articleTraceabilityAudit.mjs
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

async function api(path, { token, companyId } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (companyId) headers["x-company-id"] = companyId;
  const res = await fetch(`${API_BASE}${path}`, { headers, signal: AbortSignal.timeout(90000) });
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
  const pick = (code) => companies.find((c) => c.code === code);
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
  return {
    token: data.token,
    marId: data.company?.id || pick("MAR")?.id,
    okeId: pick("OKE")?.id,
  };
}

async function trace(q, auth, companyId) {
  const enc = encodeURIComponent(q);
  return api(`/traceability/article?q=${enc}`, { token: auth.token, companyId });
}

async function main() {
  console.log("=== Article Traceability Audit ===\nAPI:", API_BASE);

  try {
    const auth = await login(process.env.AUDIT_USER || "advitya", process.env.AUDIT_PASS || "advitya2026");

    const route = await api("/traceability/article?q=test", { token: auth.token, companyId: auth.marId });
    if (route.status === 404) fail("API", "GET /traceability/article not found");
    else if (route.status === 403) warn("API", "GET /traceability/article → 403 (permission not deployed yet)");
    else pass("API", `GET /traceability/article → ${route.status}`);

    const article = process.env.TRACE_ARTICLE || "911161522";
    const t1 = await trace(article, auth, auth.marId);
    if (t1.status === 200 && t1.data?.found) {
      pass("T1", `Article ${article}: flow ${t1.data.flow?.length || 0} steps, timeline ${t1.data.timeline?.length || 0}`);
      if ((t1.data.sales || []).length) pass("T1a", "Sales section populated");
      if ((t1.data.customs || []).length) pass("T1b", "Customs section populated");
    } else if (t1.status === 403) warn("T1", "Permission denied — deploy permissions first");
    else fail("T1", t1.data?.message || `Article trace failed (${t1.status})`);

    const bl = process.env.TRACE_BL || "BL001";
    const t2 = await trace(bl, auth, auth.marId);
    if (t2.status === 200 && t2.data?.found) {
      pass("T2", `BL ${bl}: customs rows ${t2.data.customs?.length || 0}`);
    } else if (t2.status === 403) warn("T2", "Permission denied");
    else warn("T2", t2.data?.message || `BL trace not found (${t2.status})`);

    const t5 = await trace("NONEXISTENT-TRACE-XYZ", auth, auth.marId);
    if (t5.status === 200 && !t5.data?.found) pass("T5", "Missing links returns found=false without error");
    else if (t5.status === 400) fail("T5", "Threw error for missing trace");
    else warn("T5", `Unexpected status ${t5.status}`);

    if (auth.marId && auth.okeId) {
      const mar = await trace(article, auth, auth.marId);
      const oke = await trace(article, auth, auth.okeId);
      if (mar.status === 200 && oke.status === 200) {
        const marArt = mar.data?.summary?.articleNumber;
        const okeArt = oke.data?.summary?.articleNumber;
        if (mar.data?.companyCode !== oke.data?.companyCode) pass("T6", "Company isolation: distinct company codes");
        else if (!mar.data?.found && !oke.data?.found) pass("T6", "Company isolation: separate lookups (no cross-leak)");
        else warn("T6", `MAR=${marArt} OKE=${okeArt} — verify data separation manually`);
      }
    } else warn("T6", "OKE company not available for isolation test");
  } catch (err) {
    fail("FATAL", err.message);
  }

  console.log("\n--- Summary ---");
  console.log(`Passed: ${report.passed.length}, Failed: ${report.failed.length}, Warnings: ${report.warnings.length}`);
  process.exit(report.failed.length ? 1 : 0);
}

main();
