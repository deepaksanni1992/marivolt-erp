/**
 * Customs Phase 2C audit — run: node scripts/customsPhase2cAudit.mjs
 */
import fs from "fs";
import { fileURLToPath } from "url";

const API_BASE = (process.env.API_BASE || "https://marivolt-erp.onrender.com/api").replace(/\/$/, "");
const BL1 = "BL001";
const BL2 = "BL002";

const report = {
  passed: [],
  failed: [],
  warnings: [],
  suggestedFixes: [],
  meta: { api: API_BASE, startedAt: new Date().toISOString() },
};

function pass(id, msg) {
  report.passed.push({ id, msg });
  console.log(`PASS [${id}] ${msg}`);
}
function fail(id, msg, detail) {
  report.failed.push({ id, msg, detail: detail ?? null });
  console.error(`FAIL [${id}] ${msg}`, detail ?? "");
}
function warn(id, msg) {
  report.warnings.push({ id, msg });
  console.warn(`WARN [${id}] ${msg}`);
}

async function api(path, { method = "GET", token, companyId, body, timeoutMs = 120000 } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (companyId) headers["x-company-id"] = companyId;
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: body != null ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text.slice(0, 500) };
  }
  if (!res.ok) {
    const err = new Error(data?.message || `HTTP ${res.status}`);
    err.status = res.status;
    err.body = data;
    throw err;
  }
  return { status: res.status, data, headers: res.headers };
}

async function login(username, password) {
  let { data } = await api("/auth/login", { method: "POST", body: { email: username, password } });
  if (data?.requiresCompanySelection && data?.loginTicket) {
    const mar = (data.companies || []).find((c) => c.code === "MAR");
    ({ data } = await api("/auth/select-company", {
      method: "POST",
      body: { loginTicket: data.loginTicket, companyId: mar?.id },
    }));
  }
  if (!data?.token) throw new Error(`Login failed for ${username}`);
  return data;
}

function sumStockAvailable(items, article) {
  return (items || [])
    .filter((r) => String(r.articleNumber || "").toUpperCase() === article.toUpperCase())
    .reduce((s, r) => s + (Number(r.qtyAvailable ?? r.customsStockBalance ?? r.customsStock) || 0), 0);
}

function allocByBl(invoice, bl) {
  let total = 0;
  for (const line of invoice?.items || []) {
    for (const a of line.allocations || []) {
      if (String(a.blNumber || "").toUpperCase() === bl.toUpperCase()) total += Number(a.qty) || 0;
    }
  }
  return total;
}

async function getDefaultLocation(token, companyId) {
  const { data } = await api("/stock/locations", { token, companyId });
  const rows = Array.isArray(data) ? data : data?.items || [];
  return rows[0]?.locationCode || "MAIN";
}

async function findPoLine(token, companyId, minPending = 15) {
  const { data } = await api("/purchase-orders?limit=10", { token, companyId });
  for (const po of data?.items || []) {
    if (!["APPROVED", "PARTIAL_RECEIVED", "OPEN"].includes(String(po.status || "").toUpperCase())) continue;
    const detail = await api(`/purchase-orders/${po._id}`, { token, companyId });
    for (const ln of detail.data?.lines || detail.data?.items || []) {
      const ordered = Number(ln.orderedQty ?? ln.qty) || 0;
      const received = Number(ln.receivedQty ?? ln.qtyReceived) || 0;
      const pending = ordered - received;
      if (pending >= minPending) return { po: detail.data, line: ln, pending };
    }
  }
  return null;
}

async function postGrnWithCustoms(token, companyId, po, line, location, { blNumber, qty, supplierInvoiceNumber, supplierInvoiceDate }) {
  await api("/grn/post", {
    method: "POST",
    token,
    companyId,
    body: {
      poId: po._id,
      lines: [{ poLineId: String(line._id ?? line.id), grnQty: qty, location, warehouse: "MAIN" }],
      customs: {
        boeNumber: "BOE-AUDIT-001",
        blNumber,
        awbNumber: `AWB-${blNumber}`,
        supplierInvoiceNumber,
        supplierInvoiceDate,
        countryOfOrigin: "DE",
        hsCode: "840999",
        currency: "USD",
      },
    },
  });
}

async function createTestSalesInvoice(token, companyId, article, qty) {
  const invNo = `AUD-SI-${Date.now()}`;
  const { data } = await api("/accounts/sales-invoices", {
    method: "POST",
    token,
    companyId,
    body: {
      invoiceNumber: invNo,
      invoiceNo: invNo,
      invoiceDate: new Date().toISOString(),
      customerName: "Customs Audit Customer",
      status: "ISSUED",
      currency: "USD",
      lines: [{ article, qty, uom: "PCS", price: 100, totalPrice: 100 * qty }],
      subTotal: 100 * qty,
      grandTotal: 100 * qty,
      totalAmount: 100 * qty,
    },
  });
  return data;
}

function finish() {
  report.meta.finishedAt = new Date().toISOString();
  report.meta.summary = {
    passed: report.passed.length,
    failed: report.failed.length,
    warnings: report.warnings.length,
  };
  if (report.failed.some((f) => f.id.startsWith("S2") || f.msg.includes("next is not a function"))) {
    report.suggestedFixes.push(
      "Fix SalesInvoice pre('validate') middleware for Mongoose 9 — remove callback `next()` (causes POST /accounts/sales-invoices to fail with 'next is not a function').",
    );
  }
  if (report.warnings.some((w) => w.id === "S7")) {
    report.suggestedFixes.push(
      "Upload BL and Supplier Invoice documents on GRN customs capture to enable document link tests.",
    );
  }
  console.log("\n=== AUDIT SUMMARY ===");
  console.log(JSON.stringify(report.meta.summary, null, 2));
  const out = fileURLToPath(new URL("./customsPhase2cAudit.report.json", import.meta.url));
  fs.writeFileSync(out, JSON.stringify(report, null, 2));
  console.log("Full report:", out);
}

async function main() {
  console.log("=== Customs Phase 2C Audit ===\nAPI:", API_BASE);

  const admin = await login("advitya", "advitya2026");
  const mar = (admin.companies || []).find((c) => c.code === "MAR") || admin.company;
  const oke = (admin.companies || []).find((c) => c.code === "OKE");
  const marId = mar?.id;
  if (!marId) {
    fail("SETUP", "MAR company not found");
    return finish();
  }
  pass("SETUP", `Logged in; MAR ${marId}`);

  let article = "911161522";
  let location = "MAIN";
  try {
    location = await getDefaultLocation(admin.token, marId);
  } catch {
    warn("SETUP-loc", "Could not load stock locations — using MAIN");
  }

  // S1 — verify BL001=5, BL002=10 stock (imported in prior run or import now)
  try {
    let stockRes = await api(`/customs/stock?articleNumber=${encodeURIComponent(article)}&limit=50`, {
      token: admin.token,
      companyId: marId,
    });
    let bl1 = allocByBl({ items: [{ allocations: (stockRes.data?.items || []).map((r) => ({ blNumber: r.blNumber, qty: r.qtyAvailable ?? r.customsStockBalance })) }] }, BL1);
    let bl2 = allocByBl({ items: [{ allocations: (stockRes.data?.items || []).map((r) => ({ blNumber: r.blNumber, qty: r.qtyAvailable ?? r.customsStockBalance })) }] }, BL2);

    if (bl1 < 5 || bl2 < 10) {
      const poCtx = await findPoLine(admin.token, marId, 15);
      if (!poCtx) throw new Error("No PO line with pending qty >= 15 for GRN import");
      article = String(poCtx.line.article || article).toUpperCase();
      await postGrnWithCustoms(admin.token, marId, poCtx.po, poCtx.line, location, {
        blNumber: BL1,
        qty: 5,
        supplierInvoiceNumber: "SI-BL001-AUDIT",
        supplierInvoiceDate: "2024-01-01",
      });
      await postGrnWithCustoms(admin.token, marId, poCtx.po, poCtx.line, location, {
        blNumber: BL2,
        qty: 10,
        supplierInvoiceNumber: "SI-BL002-AUDIT",
        supplierInvoiceDate: "2024-02-01",
      });
      stockRes = await api(`/customs/stock?articleNumber=${encodeURIComponent(article)}&limit=50`, {
        token: admin.token,
        companyId: marId,
      });
      bl1 = (stockRes.data?.items || []).filter((r) => String(r.blNumber).toUpperCase() === BL1).reduce((s, r) => s + (Number(r.qtyAvailable ?? r.customsStockBalance) || 0), 0);
      bl2 = (stockRes.data?.items || []).filter((r) => String(r.blNumber).toUpperCase() === BL2).reduce((s, r) => s + (Number(r.qtyAvailable ?? r.customsStockBalance) || 0), 0);
    }

    const total = sumStockAvailable(stockRes.data?.items, article);
    report.meta.article = article;
    if (bl1 >= 5 && bl2 >= 10) pass("S1", `Stock BL001=${bl1} BL002=${bl2} (article ${article}, total available ${total})`);
    else fail("S1", `Expected BL001>=5 BL002>=10`, { bl1, bl2, total });
  } catch (e) {
    fail("S1", "Import / stock verification failed", e.message);
  }

  article = report.meta.article || article;

  // S2 — FIFO (needs test sales invoice)
  let customsInvoiceId = null;
  let salesInvoiceId = null;
  let stockBeforeFinalize = sumStockAvailable(
    (await api(`/customs/stock?articleNumber=${encodeURIComponent(article)}&limit=50`, { token: admin.token, companyId: marId })).data?.items,
    article,
  );

  try {
    let si;
    try {
      si = await createTestSalesInvoice(admin.token, marId, article, 6);
    } catch (e) {
      fail("S2-setup", `Cannot create test sales invoice: ${e.message}`, null);
      throw e;
    }
    salesInvoiceId = si._id;
    pass("S2-setup", `Sales invoice ${si.invoiceNo} qty 6`);

    const ci = await api(`/customs/invoices/from-sales-invoice/${salesInvoiceId}`, {
      method: "POST",
      token: admin.token,
      companyId: marId,
      body: {},
    });
    customsInvoiceId = ci.data?.item?._id;
    const inv = ci.data?.item;
    const bl1Qty = allocByBl(inv, BL1);
    const bl2Qty = allocByBl(inv, BL2);

    if (bl1Qty === 5 && bl2Qty === 1) pass("S2-fifo", `FIFO BL001=5 BL002=1`);
    else fail("S2-fifo", `Expected BL001=5 BL002=1`, { bl1Qty, bl2Qty, items: inv?.items });

    const allocs = (inv?.items || []).flatMap((l) => l.allocations || []);
    if (allocs.length >= 2) pass("S2-multi", `${allocs.length} allocation rows stored`);
    else fail("S2-multi", "Expected multi-BL allocations", allocs);

    await api(`/customs/invoices/${customsInvoiceId}/finalize`, { method: "POST", token: admin.token, companyId: marId, body: {} });

    const availAfter = sumStockAvailable(
      (await api(`/customs/stock?articleNumber=${encodeURIComponent(article)}&limit=50`, { token: admin.token, companyId: marId })).data?.items,
      article,
    );
    if (Math.abs(availAfter - (stockBeforeFinalize - 6)) <= 0.01) {
      pass("S2-stock", `Stock reduced by 6 (${stockBeforeFinalize} → ${availAfter})`);
    } else {
      fail("S2-stock", `Expected ${stockBeforeFinalize - 6}, got ${availAfter}`);
    }

    const ledger = await api(`/customs/ledger?articleNumber=${encodeURIComponent(article)}&movementType=OUTBOUND&limit=20`, {
      token: admin.token,
      companyId: marId,
    });
    const outbound = (ledger.data?.items || []).filter((m) => m.referenceType === "CUSTOMS_INVOICE");
    if (outbound.length >= 1) pass("S2-ledger", `${outbound.length} OUTBOUND movement(s)`);
    else fail("S2-ledger", "No OUTBOUND customs ledger entries");
  } catch (e) {
    if (!String(e.message).includes("Cannot create test sales invoice")) {
      fail("S2", "FIFO / finalize test failed", e.message);
    }
  }

  // S3 — Manual allocation
  try {
    const si2 = await createTestSalesInvoice(admin.token, marId, article, 3);
    const ciCreate = await api(`/customs/invoices/from-sales-invoice/${si2._id}`, {
      method: "POST",
      token: admin.token,
      companyId: marId,
      body: {},
    });
    const ciId = ciCreate.data?.item?._id;
    const line = ciCreate.data?.item?.items?.[0];
    const lots = await api(`/customs/available-lots?articleNumber=${encodeURIComponent(article)}`, { token: admin.token, companyId: marId });
    const bl2Lot = (lots.data?.items || []).find((l) => String(l.blNumber).toUpperCase() === BL2);
    if (!bl2Lot) throw new Error("BL002 lot not found");

    await api(`/customs/invoices/${ciId}`, {
      method: "PUT",
      token: admin.token,
      companyId: marId,
      body: {
        items: [{
          salesInvoiceLineId: line.salesInvoiceLineId,
          allocations: [{ customsLotItemId: bl2Lot.customsLotItemId, qty: 3, allocationMode: "MANUAL" }],
        }],
      },
    });
    const updated = await api(`/customs/invoices/${ciId}`, { token: admin.token, companyId: marId });
    const a0 = updated.data?.item?.items?.[0]?.allocations?.[0];
    if (a0?.allocationMode === "MANUAL" && String(a0?.blNumber).toUpperCase() === BL2) {
      pass("S3", "Manual BL002 allocation saved (FIFO bypassed)");
    } else fail("S3", "Manual allocation incorrect", a0);

    const audit = await api("/audit-logs?module=CUSTOMS&limit=15", { token: admin.token, companyId: marId });
    const logs = audit.data?.items || audit.data?.logs || [];
    if (logs.some((a) => String(a.action).includes("UPDATE") || String(a.description).toLowerCase().includes("updated"))) {
      pass("S3-audit", "Audit trail contains customs UPDATE");
    } else warn("S3-audit", "UPDATE audit entry not found in recent logs");

    await api(`/customs/invoices/${ciId}/cancel`, { method: "POST", token: admin.token, companyId: marId, body: { reason: "Audit cleanup" } });
  } catch (e) {
    fail("S3", "Manual allocation failed", e.message);
  }

  // S4 — Cancel posted invoice from S2
  try {
    if (!customsInvoiceId) throw new Error("No customs invoice from S2");
    const before = sumStockAvailable(
      (await api(`/customs/stock?articleNumber=${encodeURIComponent(article)}&limit=50`, { token: admin.token, companyId: marId })).data?.items,
      article,
    );
    await api(`/customs/invoices/${customsInvoiceId}/cancel`, {
      method: "POST",
      token: admin.token,
      companyId: marId,
      body: { reason: "Audit scenario 4" },
    });
    const after = sumStockAvailable(
      (await api(`/customs/stock?articleNumber=${encodeURIComponent(article)}&limit=50`, { token: admin.token, companyId: marId })).data?.items,
      article,
    );
    if (after >= before + 5) pass("S4-stock", `Stock restored ${before} → ${after}`);
    else fail("S4-stock", `Stock not restored enough: ${before} → ${after}`);

    const rev = await api(`/customs/ledger?articleNumber=${encodeURIComponent(article)}&movementType=REVERSAL&limit=10`, {
      token: admin.token,
      companyId: marId,
    });
    if ((rev.data?.items || []).length >= 1) pass("S4-ledger", "REVERSAL movement created");
    else fail("S4-ledger", "No REVERSAL entry");

    const elig = await api(`/customs/invoices/by-sales-invoice/${salesInvoiceId}/eligibility`, { token: admin.token, companyId: marId });
    if (!elig.data?.hasCustomsInvoice) pass("S4-release", "Sales invoice released after cancel");
    else warn("S4-release", "Active customs invoice still linked");
  } catch (e) {
    fail("S4", "Cancel / reversal failed", e.message);
  }

  // S5 — Override permission
  try {
    const salesUser = await login("himanshu", "himanshu@22348").catch(() => login("kalpesh", "kalpesh13568"));
    const siHuge = await createTestSalesInvoice(admin.token, marId, article, 99999).catch((e) => {
      warn("S5-setup", `Skip huge SI: ${e.message}`);
      return null;
    });
    if (siHuge) {
      let blocked = false;
      try {
        await api(`/customs/invoices/from-sales-invoice/${siHuge._id}`, {
          method: "POST",
          token: salesUser.token,
          companyId: marId,
          body: {},
        });
      } catch {
        blocked = true;
      }
      if (blocked) pass("S5-perm", "Non-admin blocked on insufficient stock");
      else warn("S5-perm", "Non-admin not blocked — verify CUSTOMS.create role");
    }

    const si4 = await createTestSalesInvoice(admin.token, marId, article, 2);
    const draft = await api(`/customs/invoices/from-sales-invoice/${si4._id}`, { method: "POST", token: admin.token, companyId: marId, body: {} });
    const ciId5 = draft.data?.item?._id;
    const line5 = draft.data?.item?.items?.[0];
    await api(`/customs/invoices/${ciId5}`, {
      method: "PUT",
      token: admin.token,
      companyId: marId,
      body: {
        items: [{
          salesInvoiceLineId: line5.salesInvoiceLineId,
          allocations: [{
            allocationMode: "OVERRIDE_DUMMY",
            qty: 2,
            boeNumber: "BOE-DUMMY",
            blNumber: "BL-DUMMY-AUDIT",
            awbNumber: "AWB-DUMMY",
            supplierInvoiceNumber: "SI-DUMMY",
            overrideReason: "Audit override — mandatory reason",
          }],
        }],
      },
    });
    await api(`/customs/invoices/${ciId5}/finalize`, { method: "POST", token: admin.token, companyId: marId, body: {} });
    pass("S5-override", "Admin override finalized with reason");

    const auditOv = await api("/audit-logs?module=CUSTOMS&limit=25", { token: admin.token, companyId: marId });
    const logs = auditOv.data?.items || auditOv.data?.logs || [];
    if (logs.some((a) => /override|manual|update|cancel|create|post/i.test(String(a.description)))) {
      pass("S5-audit", "Customs audit trail entries present");
    } else warn("S5-audit", "Override not explicitly tagged in audit descriptions");
  } catch (e) {
    fail("S5", "Override test failed", e.message);
  }

  // S6 — Company isolation (switch company token, not header-only)
  try {
    if (!oke?.id) {
      warn("S6", "OKE company not on admin user");
    } else {
      const marList = await api("/customs/invoices?limit=5", { token: admin.token, companyId: marId });
      const marInvId = marList.data?.items?.[0]?._id;
      if (!marInvId) throw new Error("No MAR customs invoice");
      const switched = await api("/auth/switch-company", {
        method: "POST",
        token: admin.token,
        body: { companyId: oke.id },
      });
      let isolated = false;
      try {
        await api(`/customs/invoices/${marInvId}`, { token: switched.data.token, companyId: oke.id });
      } catch (e) {
        if (e.status === 404 || String(e.message).toLowerCase().includes("not found")) isolated = true;
      }
      if (isolated) pass("S6", "MAR invoice not accessible after switch to OKE");
      else fail("S6", "Company isolation breach — MAR invoice visible under OKE");

      const okeList = await api("/customs/invoices?limit=5", { token: switched.data.token, companyId: oke.id });
      const okeInvId = okeList.data?.items?.[0]?._id;
      if (okeInvId) {
        const back = await api("/auth/switch-company", {
          method: "POST",
          token: switched.data.token,
          body: { companyId: marId },
        });
        let isolated2 = false;
        try {
          await api(`/customs/invoices/${okeInvId}`, { token: back.data.token, companyId: marId });
        } catch (e) {
          if (e.status === 404 || String(e.message).toLowerCase().includes("not found")) isolated2 = true;
        }
        if (isolated2) pass("S6-b", "OKE invoice not accessible after switch to MAR");
        else fail("S6-b", "Company isolation breach — OKE invoice visible under MAR");
      } else {
        warn("S6-b", "No OKE customs invoices to test reverse isolation");
      }
    }
  } catch (e) {
    fail("S6", "Company isolation failed", e.message);
  }

  // S7 — Documents
  try {
    const stock = await api(`/customs/stock?articleNumber=${encodeURIComponent(article)}&limit=30`, { token: admin.token, companyId: marId });
    const row = (stock.data?.items || []).find((r) => r.documents?.blDocumentId || r.documents?.supplierInvoiceDocumentId);
    if (!row) {
      warn("S7", "No customs stock with uploaded BL/Supplier Invoice documents in test data");
    } else {
      if (row.documents?.blDocumentId) {
        const v = await api(`/documents/${row.documents.blDocumentId}/download?inline=1`, { token: admin.token, companyId: marId });
        const d = await api(`/documents/${row.documents.blDocumentId}/download`, { token: admin.token, companyId: marId });
        if (v.data?.url) pass("S7-bl-view", "View BL URL ok");
        if (d.data?.url) pass("S7-bl-dl", "Download BL URL ok");
      }
      if (row.documents?.supplierInvoiceDocumentId) {
        const v = await api(`/documents/${row.documents.supplierInvoiceDocumentId}/download?inline=1`, { token: admin.token, companyId: marId });
        const d = await api(`/documents/${row.documents.supplierInvoiceDocumentId}/download`, { token: admin.token, companyId: marId });
        if (v.data?.url) pass("S7-si-view", "View Supplier Invoice URL ok");
        if (d.data?.url) pass("S7-si-dl", "Download Supplier Invoice URL ok");
      }
    }
  } catch (e) {
    fail("S7", "Document access failed", e.message);
  }

  // S8 — PDF
  try {
    const list = await api("/customs/invoices?limit=5&status=POSTED", { token: admin.token, companyId: marId });
    const invId = list.data?.items?.[0]?._id;
    if (!invId) throw new Error("No POSTED customs invoice");
    const printData = await api(`/customs/invoices/${invId}/print`, { token: admin.token, companyId: marId });
    const rows = printData.data?.rows || [];
    const header = printData.data?.header || {};
    if (rows.length && rows.some((r) => r.boeNumber && r.blNumber && r.awbNumber && r.supplierInvoiceNumber)) {
      pass("S8-data", "Print API returns BOE/BL/AWB/Supplier Invoice columns");
    } else fail("S8-data", "Print data incomplete", rows[0]);

    const blSet = new Set(rows.map((r) => r.blNumber).filter(Boolean));
    if (blSet.size >= 2) pass("S8-multi", "Multi-BL visible in print rows");
    else warn("S8-multi", `Print sample has ${blSet.size} BL(s) — multi-BL not in this invoice`);

    const html = `<!DOCTYPE html><html><body><h1>Customs Invoice ${header.customsInvoiceNumber || ""}</h1><table><tbody>${rows
      .map((r) => `<tr><td>${r.articleNumber}</td><td>${r.qty}</td><td>${r.boeNumber}</td><td>${r.blNumber}</td><td>${r.awbNumber}</td><td>${r.supplierInvoiceNumber}</td></tr>`)
      .join("")}</tbody></table></body></html>`;
    const pdfRes = await fetch(`${API_BASE}/reports/pdf`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${admin.token}`, "x-company-id": marId },
      body: JSON.stringify({ html, filename: "customs-audit.pdf", options: { printBackground: true } }),
      signal: AbortSignal.timeout(120000),
    });
    const buf = Buffer.from(await pdfRes.arrayBuffer());
    const isPdf = pdfRes.ok && (buf.slice(0, 4).toString() === "%PDF");
    const searchable = buf.toString("latin1").includes(header.customsInvoiceNumber || "CUS") || rows.some((r) => r.blNumber && buf.toString("latin1").includes(r.blNumber));
    if (isPdf) pass("S8-pdf", "Searchable PDF generated");
    else fail("S8-pdf", "PDF generation failed", pdfRes.status);
    if (searchable) pass("S8-search", "PDF contains invoice/BL text");
    else warn("S8-search", "Text markers not found in PDF buffer");
  } catch (e) {
    fail("S8", "PDF test failed", e.message);
  }

  finish();
}

main().catch((e) => {
  fail("FATAL", e.message, e.stack);
  finish();
});
