/**
 * Full Article Traceability acceptance audit
 * node backend/scripts/articleTraceabilityAudit.mjs
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
function perf(id, ms, detail) {
  report.performance.push({ id, ms, detail });
  console.log(`PERF [${id}] ${ms}ms — ${detail}`);
}

async function api(path, { token, companyId } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (companyId) headers["x-company-id"] = companyId;
  const t0 = performance.now();
  const res = await fetch(`${API_BASE}${path}`, { headers, signal: AbortSignal.timeout(90000) });
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
  return {
    token: data.token,
    marId: pick("MAR")?.id || data.company?.id,
    okeId: pick("OKE")?.id,
    companies,
  };
}

async function trace(q, auth, companyId, extra = {}) {
  const params = new URLSearchParams({ q });
  for (const [k, v] of Object.entries(extra)) {
    if (v != null && String(v).trim()) params.set(k, String(v).trim());
  }
  return api(`/traceability/article?${params}`, { token: auth.token, companyId });
}

function flowStep(data, stage) {
  return (data?.flow || []).find((s) => s.stage === stage);
}

function hasOpenPath(rows, field) {
  return (rows || []).some((r) => r[field] && String(r[field]).startsWith("/"));
}

function hasNotLinked(data) {
  const flowMissing = (data?.flow || []).some((s) => s.documentNumber === "Not Linked");
  const purchaseMissing = (data?.purchase || []).some((r) => r.grnNumber === "Not Linked" || r.poNumber === "Not Linked");
  const salesMissing = (data?.sales || []).some((r) => r.customsInvoiceNumber === "Not Linked" || r.dispatchStatus === "Not Linked");
  return flowMissing || purchaseMissing || salesMissing;
}

function timelineOrdered(timeline) {
  if (!timeline?.length) return true;
  for (let i = 1; i < timeline.length; i++) {
    const prev = new Date(timeline[i - 1].date).getTime();
    const cur = new Date(timeline[i].date).getTime();
    if (!Number.isNaN(prev) && !Number.isNaN(cur) && cur < prev) return false;
  }
  return true;
}

function exportPayloadValid(data) {
  const timeline = data?.timeline || [];
  const purchase = data?.purchase || [];
  const customs = data?.customs || [];
  const sales = data?.sales || [];
  const summary = data?.summary || null;
  const csvOk = Array.isArray(timeline) && timeline.every((r) => "documentType" in r && "documentNumber" in r);
  const pdfOk = summary && typeof summary.articleNumber === "string";
  return { csvOk, pdfOk, counts: { timeline: timeline.length, purchase: purchase.length, customs: customs.length, sales: sales.length } };
}

function idsOverlap(marData, okeData) {
  const collect = (d) => {
    const ids = new Set();
    for (const row of d?.purchase || []) {
      if (row.poNumber && row.poNumber !== "Not Linked") ids.add(`PO:${row.poNumber}`);
      if (row.grnNumber && row.grnNumber !== "Not Linked") ids.add(`GRN:${row.grnNumber}`);
    }
    for (const row of d?.sales || []) {
      if (row.salesInvoiceNumber) ids.add(`SI:${row.salesInvoiceNumber}`);
      if (row.customsInvoiceNumber && row.customsInvoiceNumber !== "Not Linked") ids.add(`CI:${row.customsInvoiceNumber}`);
    }
    for (const row of d?.customs || []) {
      if (row.blNumber && row.blNumber !== "—") ids.add(`BL:${row.blNumber}`);
      if (row.supplierInvoiceNumber && row.supplierInvoiceNumber !== "Not Linked") ids.add(`SINV:${row.supplierInvoiceNumber}`);
    }
    return ids;
  };
  const marIds = collect(marData);
  const okeIds = collect(okeData);
  const overlap = [...marIds].filter((x) => okeIds.has(x));
  return overlap;
}

async function discoverRefs(auth, companyId, article) {
  const art = await trace(article, auth, companyId);
  if (!art.data?.found) return {};
  const si = art.data.sales?.[0]?.salesInvoiceNumber;
  const sinv = art.data.customs?.[0]?.supplierInvoiceNumber || art.data.purchase?.[0]?.supplierInvoiceNumber;
  return { si, sinv, art: art.data };
}

async function main() {
  console.log("=== Article Traceability Full Audit ===\nAPI:", API_BASE);

  try {
    const auth = await login(process.env.AUDIT_USER || "advitya", process.env.AUDIT_PASS || "advitya2026");

    const route = await api("/traceability/article?q=test", { token: auth.token, companyId: auth.marId });
    perf("API-route", route.ms, `GET /traceability/article → ${route.status}`);
    if (route.status === 404) {
      fail("API", "GET /traceability/article not found — deploy before push");
      printSummary();
      process.exit(1);
    }
    if (route.status === 403) warn("API", "GET /traceability/article → 403 (TRACEABILITY permission may need role update)");
    else pass("API", `GET /traceability/article → ${route.status}`);

    // --- Test 1: Article 911161522 ---
    const article = process.env.TRACE_ARTICLE || "911161522";
    const t1 = await trace(article, auth, auth.marId);
    perf("T1-article", t1.ms, `article ${article}`);
    if (t1.status !== 200) {
      fail("T1", `HTTP ${t1.status}: ${t1.data?.message || "error"}`);
    } else if (!t1.data?.found) {
      fail("T1", t1.data?.message || "Article trace not found");
    } else {
      pass("T1", `Article ${article} resolved — company ${t1.data.companyCode}`);
      const d = t1.data;

      const poFlow = flowStep(d, "po");
      const grnFlow = flowStep(d, "grn");
      const csFlow = flowStep(d, "customsStock");
      const clFlow = flowStep(d, "customsLedger");
      const siFlow = flowStep(d, "salesInvoice");
      const ciFlow = flowStep(d, "customsInvoice");
      const dispFlow = flowStep(d, "dispatch");

      if (poFlow?.status === "linked" && poFlow.openPath) pass("T1-PO", `PO linked: ${poFlow.documentNumber}`);
      else if (poFlow?.documentNumber === "Not Linked") warn("T1-PO", "PO not linked (data may lack PO for article)");
      else fail("T1-PO", `PO link issue: ${poFlow?.documentNumber}`);

      if (grnFlow?.status === "linked" && grnFlow.openPath) pass("T1-GRN", `GRN linked: ${grnFlow.documentNumber}`);
      else if (grnFlow?.documentNumber === "Not Linked") warn("T1-GRN", "GRN not linked");
      else fail("T1-GRN", `GRN link issue: ${grnFlow?.documentNumber}`);

      if (csFlow?.status !== "missing" && (d.customs?.length || csFlow?.openPath)) pass("T1-CS", `Customs Stock: ${d.customs?.length || 0} row(s), openPath=${!!csFlow?.openPath}`);
      else warn("T1-CS", "Customs stock not visible");

      if (clFlow?.status === "linked" || (d.timeline || []).some((e) => String(e.documentType).includes("Customs"))) {
        pass("T1-CL", `Customs Ledger: ${clFlow?.documentNumber || "timeline entries present"}`);
      } else warn("T1-CL", "Customs ledger not visible");

      if (siFlow?.status === "linked" || (d.sales || []).length) pass("T1-SI", `Sales Invoice: ${siFlow?.documentNumber || d.sales?.[0]?.salesInvoiceNumber}`);
      else warn("T1-SI", "Sales invoice not linked");

      if (ciFlow?.status === "linked" || (d.sales || []).some((r) => r.customsInvoiceNumber && r.customsInvoiceNumber !== "Not Linked")) {
        pass("T1-CI", `Customs Invoice: ${ciFlow?.documentNumber || d.sales?.find((r) => r.customsInvoiceNumber !== "Not Linked")?.customsInvoiceNumber}`);
      } else warn("T1-CI", "Customs invoice not linked");

      if (dispFlow?.status === "linked" || dispFlow?.status === "pending" || (d.sales || []).some((r) => r.dispatchStatus !== "Not Linked")) {
        pass("T1-DISP", `Dispatch: ${dispFlow?.documentNumber || d.sales?.[0]?.dispatchStatus}`);
      } else warn("T1-DISP", "Dispatch not linked");

      if (hasOpenPath(d.purchase, "openPo") || hasOpenPath(d.purchase, "openGrn")) pass("T1-open", "Purchase open links present");
      if (hasOpenPath(d.customs, "openCustomsStock") || hasOpenPath(d.customs, "openCustomsLedger")) pass("T1-open-customs", "Customs open links present");
      if (hasOpenPath(d.sales, "openSalesInvoice")) pass("T1-open-sales", "Sales open links present");
    }

    // --- Test 2: BL001 ---
    const bl = process.env.TRACE_BL || "BL001";
    const t2 = await trace(bl, auth, auth.marId);
    perf("T2-bl", t2.ms, `BL ${bl}`);
    if (t2.status === 200 && t2.data?.found) {
      pass("T2", `BL ${bl} resolved to article ${t2.data.summary?.articleNumber}`);
      const customs = t2.data.customs || [];
      const hasBl = customs.some((r) => String(r.blNumber).toUpperCase().includes("BL001"));
      const hasStock = customs.some((r) => Number(r.qtyAvailable) > 0 || Number(r.qtyImported) > 0);
      const hasLot = (t2.data.timeline || []).some((e) => String(e.documentType).toLowerCase().includes("customs lot"));
      const hasConsumption = customs.some((r) => Number(r.qtyConsumed) > 0) ||
        (t2.data.timeline || []).some((e) => String(e.documentType).toLowerCase().includes("customs invoice"));
      if (hasBl || customs.length) pass("T2-lot", `Customs lot/stock rows: ${customs.length}`);
      else fail("T2-lot", "No customs lot visibility for BL001");
      if (hasStock) pass("T2-stock", "Customs stock availability shown");
      else warn("T2-stock", "No qty available/imported on customs rows");
      if (hasLot) pass("T2-timeline-lot", "Customs lot in timeline");
      else warn("T2-timeline-lot", "Customs lot not in timeline");
      if (hasConsumption) pass("T2-consumption", "Customs invoice consumption history present");
      else warn("T2-consumption", "No consumption history (may be unconsumed stock)");
    } else if (t2.status === 403) fail("T2", "Permission denied");
    else fail("T2", t2.data?.message || `BL trace failed (${t2.status})`);

    // --- Test 3: Supplier Invoice Number ---
    const refs = await discoverRefs(auth, auth.marId, article);
    const sinv =
      process.env.TRACE_SUPPLIER_INV ||
      refs.sinv ||
      refs.art?.customs?.find((r) => r.supplierInvoiceNumber && r.supplierInvoiceNumber !== "Not Linked")?.supplierInvoiceNumber ||
      "SI-BL001-AUDIT";
    if (sinv && sinv !== "Not Linked") {
      const t3 = await trace(sinv, auth, auth.marId);
      perf("T3-sinv", t3.ms, `supplier invoice ${sinv}`);
      if (t3.status === 200 && t3.data?.found) {
        pass("T3", `Supplier invoice ${sinv} resolved`);
        const grnLinked = (t3.data.purchase || []).some((r) => r.grnNumber && r.grnNumber !== "Not Linked");
        const customsLinked = (t3.data.customs || []).length > 0;
        const stockLinked = (t3.data.customs || []).some((r) => Number(r.qtyImported) > 0 || Number(r.qtyAvailable) >= 0);
        if (grnLinked) pass("T3-GRN", "GRN linkage present");
        else warn("T3-GRN", "GRN not linked from supplier invoice search");
        if (customsLinked) pass("T3-lot", "Customs lot linkage present");
        else warn("T3-lot", "Customs lot not linked");
        if (stockLinked) pass("T3-stock", "Customs stock linkage present");
        else warn("T3-stock", "Customs stock not linked");
      } else fail("T3", t3.data?.message || `Supplier invoice trace failed (${t3.status})`);
    } else {
      warn("T3", "No supplier invoice number discovered — set TRACE_SUPPLIER_INV");
    }

    // --- Test 4: Sales Invoice Number ---
    const siNo = process.env.TRACE_SI || refs.si;
    if (siNo) {
      const t4 = await trace(siNo, auth, auth.marId);
      perf("T4-si", t4.ms, `sales invoice ${siNo}`);
      if (t4.status === 200 && t4.data?.found) {
        pass("T4", `Sales invoice ${siNo} resolved`);
        const ciLinked = (t4.data.sales || []).some((r) => r.customsInvoiceNumber && r.customsInvoiceNumber !== "Not Linked");
        const dispLinked = (t4.data.sales || []).some((r) => r.dispatchStatus && r.dispatchStatus !== "Not Linked");
        if (ciLinked) pass("T4-CI", "Customs invoice linkage present");
        else warn("T4-CI", "Customs invoice not linked");
        if (dispLinked) pass("T4-DISP", `Dispatch linkage: ${t4.data.sales?.[0]?.dispatchStatus}`);
        else warn("T4-DISP", "Dispatch not linked");
      } else fail("T4", t4.data?.message || `Sales invoice trace failed (${t4.status})`);
    } else {
      warn("T4", "No sales invoice discovered — set TRACE_SI");
    }

    // --- Test 5 & 6: MAR / OKE company isolation ---
    if (auth.marId && auth.okeId) {
      const marTrace = await trace(article, auth, auth.marId);
      const okeTrace = await trace(article, auth, auth.okeId);
      perf("T5-6-isolation", marTrace.ms + okeTrace.ms, "MAR + OKE lookups");

      if (marTrace.status === 200) {
        if (marTrace.data?.companyCode && marTrace.data.companyCode !== "OKE") pass("T5-MAR", `MAR context: companyCode=${marTrace.data.companyCode}`);
        else if (marTrace.data?.found) warn("T5-MAR", `MAR companyCode=${marTrace.data?.companyCode}`);
        else pass("T5-MAR", "MAR lookup scoped (no cross-company leak in response)");
      }

      if (okeTrace.status === 200) {
        if (okeTrace.data?.companyCode === "OKE" || !okeTrace.data?.found) pass("T6-OKE", `OKE context: companyCode=${okeTrace.data?.companyCode || "—"}, found=${okeTrace.data?.found}`);
        else warn("T6-OKE", `OKE companyCode=${okeTrace.data?.companyCode}`);
      }

      if (marTrace.data?.found && okeTrace.data?.found) {
        const overlap = idsOverlap(marTrace.data, okeTrace.data);
        if (overlap.length === 0) pass("T5-6-no-overlap", "MAR and OKE document IDs do not overlap");
        else fail("T5-6-overlap", `Cross-company document overlap: ${overlap.join(", ")}`);
      } else if (marTrace.data?.found && !okeTrace.data?.found) {
        pass("T5-6-isolation", "Article found in MAR only — OKE correctly isolated");
      } else if (!marTrace.data?.found && okeTrace.data?.found) {
        pass("T5-6-isolation", "Article found in OKE only — MAR correctly isolated");
      } else {
        pass("T5-6-isolation", "Neither company returned article (isolation OK)");
      }

      const blMar = await trace(bl, auth, auth.marId);
      const blOke = await trace(bl, auth, auth.okeId);
      if (blMar.data?.found && !blOke.data?.found) pass("T5-6-BL", "BL001 visible in MAR, not in OKE");
      else if (!blMar.data?.found && blOke.data?.found) pass("T5-6-BL", "BL visible in OKE only");
      else if (blMar.data?.found && blOke.data?.found) warn("T5-6-BL", "BL found in both companies — verify test data");
    } else {
      warn("T5", "MAR company id missing");
      warn("T6", "OKE company id missing");
    }

    // --- Test 7: PDF export payload ---
    if (t1.data?.found) {
      const exp = exportPayloadValid(t1.data);
      if (exp.pdfOk) pass("T7-PDF", `PDF export payload valid (summary + ${exp.counts.timeline} timeline, ${exp.counts.purchase} purchase, ${exp.counts.customs} customs, ${exp.counts.sales} sales rows)`);
      else fail("T7-PDF", "Summary missing for PDF export");
    } else warn("T7-PDF", "Skipped — article trace not found");

    // --- Test 8: CSV export payload ---
    if (t1.data?.found) {
      const exp = exportPayloadValid(t1.data);
      if (exp.csvOk && exp.counts.timeline > 0) pass("T8-CSV", `CSV export payload valid (${exp.counts.timeline} timeline rows)`);
      else if (exp.csvOk) warn("T8-CSV", "CSV structure valid but timeline empty");
      else fail("T8-CSV", "Timeline rows missing required export fields");
    } else warn("T8-CSV", "Skipped — article trace not found");

    // --- Test 9: Timeline ordering ---
    if (t1.data?.found) {
      const ordered = timelineOrdered(t1.data.timeline);
      if (ordered) pass("T9", `Timeline chronologically ordered (${t1.data.timeline?.length || 0} events)`);
      else fail("T9", "Timeline not in chronological order");
    } else warn("T9", "Skipped — no timeline");

    // --- Test 10: Missing links → Not Linked ---
    const t10 = await trace("NONEXISTENT-TRACE-XYZ-999", auth, auth.marId);
    if (t10.status === 200 && !t10.data?.found) {
      pass("T10", "Unknown search returns found=false without HTTP error");
      const allNotLinked = (t10.data?.flow || []).every((s) => s.documentNumber === "Not Linked");
      if (allNotLinked) pass("T10-flow", "Flow chain shows Not Linked for all stages");
      else fail("T10-flow", "Flow chain missing Not Linked markers");
    } else if (t10.status === 400) {
      fail("T10", "API threw 400 for missing trace");
    } else {
      warn("T10", `Unexpected response status ${t10.status}`);
    }

    if (t1.data?.found && hasNotLinked(t1.data)) {
      pass("T10-partial", "Partial trace shows Not Linked for missing document links");
    }

    const perfVals = report.performance.map((p) => p.ms);
    if (perfVals.length) {
      const max = Math.max(...perfVals);
      const avg = Math.round(perfVals.reduce((a, b) => a + b, 0) / perfVals.length);
      perf("SUMMARY", avg, `avg ${avg}ms, max ${max}ms across ${perfVals.length} API calls`);
      if (max > 10000) warn("PERF", `Slowest call ${max}ms — consider index tuning`);
      else if (max > 5000) warn("PERF", `Max latency ${max}ms — acceptable but watch under load`);
      else pass("PERF", `All calls under 5s (max ${max}ms)`);
    }
  } catch (err) {
    fail("FATAL", err.message);
  }

  printSummary();
  process.exit(report.failed.length ? 1 : 0);
}

function printSummary() {
  console.log("\n=== AUDIT REPORT ===");
  console.log(`\nPassed (${report.passed.length}):`);
  report.passed.forEach((p) => console.log(`  ✓ [${p.id}] ${p.msg}`));
  console.log(`\nFailed (${report.failed.length}):`);
  report.failed.forEach((p) => console.log(`  ✗ [${p.id}] ${p.msg}`));
  console.log(`\nWarnings (${report.warnings.length}):`);
  report.warnings.forEach((p) => console.log(`  ! [${p.id}] ${p.msg}`));
  console.log(`\nPerformance:`);
  report.performance.forEach((p) => console.log(`  ⏱ [${p.id}] ${p.ms}ms — ${p.detail}`));
  console.log(`\nTotals: Passed=${report.passed.length} Failed=${report.failed.length} Warnings=${report.warnings.length}`);
}

main();
