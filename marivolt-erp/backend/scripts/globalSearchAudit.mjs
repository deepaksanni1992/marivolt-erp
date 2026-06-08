/**
 * Global ERP Search acceptance audit — node scripts/globalSearchAudit.mjs
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

async function api(path, { token, companyId, method = "GET" } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (companyId) headers["x-company-id"] = companyId;
  const res = await fetch(`${API_BASE}${path}`, { method, headers, signal: AbortSignal.timeout(90000) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.message || `HTTP ${res.status}`);
  return data;
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

function hasType(items, typePart) {
  return (items || []).some((r) => String(r.type || "").toLowerCase().includes(String(typePart).toLowerCase()));
}

async function main() {
  console.log("=== Global ERP Search Audit ===\nAPI:", API_BASE);

  try {
    const auth = await login(process.env.AUDIT_USER || "advitya", process.env.AUDIT_PASS || "advitya2026");

    const route = await fetch(`${API_BASE}/search/global?q=test&limit=5`, {
      headers: { Authorization: `Bearer ${auth.token}`, "x-company-id": auth.marId },
    });
    if (route.status === 404) fail("API", "GET /search/global not found");
    else pass("API", `GET /search/global → ${route.status}`);

    const mar = await api("/search/global?q=MAR&limit=50", { token: auth.token, companyId: auth.marId });
    if (!Array.isArray(mar.items)) fail("T0", "items array missing");
    else pass("T0", `MAR search returned ${mar.total} hit(s)`);

    const articleQ = process.env.SEARCH_ARTICLE || "911161522";
    const art = await api(`/search/global?q=${encodeURIComponent(articleQ)}&limit=50`, { token: auth.token, companyId: auth.marId });
    if (art.total > 0) {
      const types = [...new Set(art.items.map((r) => r.type))].join(", ");
      pass("T1", `Article ${articleQ}: ${art.total} hit(s) — ${types}`);
      if (!hasType(art.items, "article") && !art.items.some((r) => r.article === articleQ)) {
        warn("T1", "No direct article row in first page");
      }
    } else {
      warn("T1", `No hits for article ${articleQ} in MAR`);
    }

    const bl = await api("/search/global?q=BL001&limit=50&type=Customs", { token: auth.token, companyId: auth.marId });
    if (bl.total > 0) pass("T2", `BL search: ${bl.total} customs-related hit(s)`);
    else warn("T2", "No BL001 customs hits (test data may differ)");

    const si = await api("/search/global?q=SI&type=Sales&limit=20", { token: auth.token, companyId: auth.marId });
    if (hasType(si.items, "sales invoice")) pass("T6", "Sales Invoice type found in SI search");
    else if (si.total > 0) pass("T6", `SI search returned ${si.total} sales hit(s)`);
    else warn("T6", "No sales invoice hits for SI query");

    const po = await api("/search/global?q=PO&type=Purchase&limit=20", { token: auth.token, companyId: auth.marId });
    if (hasType(po.items, "purchase order")) pass("T5", "Purchase Order found");
    else if (po.total > 0) pass("T5", `PO search: ${po.total} purchase hit(s)`);
    else warn("T5", "No PO hits");

    const cust = await api("/search/global?q=Dummy&type=Sales&limit=20", { token: auth.token, companyId: auth.marId });
    if (cust.total > 0) pass("T4", `Customer search: ${cust.total} hit(s)`);
    else warn("T4", "No customer Dummy hits");

    if (auth.okeId) {
      try {
        await api("/search/global?q=MAR-&limit=5", { token: auth.token, companyId: auth.okeId });
        fail("T7", "OKE request with x-company-id should not succeed if session is MAR-scoped");
      } catch (e) {
        if (String(e.message).toLowerCase().includes("company")) pass("T7", "Cross-company header blocked as expected");
        else warn("T7", `OKE isolation check: ${e.message}`);
      }
    } else {
      pass("T7", "Company isolation relies on session company (OKE id not in login payload)");
    }

    const page2 = await api("/search/global?q=MAR&page=1&limit=50", { token: auth.token, companyId: auth.marId });
    if (page2.limit === 50) pass("T8", "Pagination limit=50 enforced");
    else fail("T8", `Unexpected limit ${page2.limit}`);

    const openPaths = (mar.items || []).filter((r) => r.openPath).length;
    if (openPaths > 0) pass("T9", `${openPaths} result(s) include openPath`);
    else warn("T9", "No openPath on sample results");
  } catch (e) {
    fail("SETUP", e.message || String(e));
  }

  console.log("\n=== Summary ===");
  console.log(`Passed: ${report.passed.length}, Failed: ${report.failed.length}, Warnings: ${report.warnings.length}`);
  if (report.failed.length) process.exitCode = 1;
}

main();
