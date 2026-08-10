import { useCallback, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import PageHeader from "../components/erp/PageHeader.jsx";
import Modal from "../components/erp/Modal.jsx";
import { useAuth } from "../context/AuthContext.jsx";
import { apiGetWithQuery } from "../lib/api.js";
import { downloadCsv, downloadPdfTable } from "../lib/purchaseExport.js";
import { notify } from "../lib/notifications.js";

const STATUS_OPTIONS = ["", "MATCH", "ERP HIGHER", "CUSTOMS HIGHER", "MISSING CUSTOMS RECORD"];

const CSV_COLUMNS = [
  { key: "company", header: "Company" },
  { key: "article", header: "Article Number" },
  { key: "partNumber", header: "Part Number" },
  { key: "partName", header: "Part Name" },
  { key: "erpStock", header: "ERP Stock" },
  { key: "customsStock", header: "Customs Stock" },
  { key: "difference", header: "Difference" },
  { key: "differencePct", header: "Difference %" },
  { key: "lastErpMovementDate", header: "Last ERP Movement Date" },
  { key: "lastCustomsMovementDate", header: "Last Customs Movement Date" },
  { key: "lastBoe", header: "Last BOE" },
  { key: "lastBl", header: "Last BL" },
  { key: "lastSupplierInvoice", header: "Last Supplier Invoice" },
  { key: "status", header: "Status" },
  { key: "actionRequired", header: "Action Required" },
];

function fmtDate(v) {
  if (!v) return "—";
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toISOString().slice(0, 10);
}

function fmtNum(v, digits = 2) {
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: digits });
}

function fmtMoney(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function statusClass(status) {
  const s = String(status || "").toUpperCase();
  if (s === "MATCH") return "bg-emerald-50 text-emerald-800 ring-emerald-200";
  if (s === "ERP HIGHER") return "bg-amber-50 text-amber-900 ring-amber-200";
  if (s === "CUSTOMS HIGHER") return "bg-rose-50 text-rose-800 ring-rose-200";
  if (s.includes("MISSING")) return "bg-rose-100 text-rose-900 ring-rose-300";
  return "bg-slate-50 text-slate-700 ring-slate-200";
}

function isBoeAverageMethod(method) {
  return String(method || "").toUpperCase() === "BOE_AVERAGE";
}

function pickDeclaredField(items, field) {
  for (const it of items) {
    const v = it?.[field] ?? it?.lot?.[field];
    if (v != null && v !== "") return Number(v);
  }
  return null;
}

/** BOE_AVERAGE declared qty/value invariants — skipped for LEGACY_LINE_VALUE rows. */
function computeBoeAverageInvariants(items = []) {
  const groups = new Map();
  for (const it of items) {
    if (!isBoeAverageMethod(it.valuationMethod)) continue;
    const key = it.boeNumber || "—";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(it);
  }

  const results = [];
  for (const [boeNumber, group] of groups) {
    const declaredQty = pickDeclaredField(group, "boeDeclaredQty");
    const declaredValue = pickDeclaredField(group, "boeDeclaredValue");
    if (declaredQty == null && declaredValue == null) continue;

    const sumQty = group.reduce(
      (s, it) => s + (Number(it.customsQtyImported ?? it.qtyImported) || 0),
      0,
    );
    const sumValue = group.reduce((s, it) => s + (Number(it.totalValue) || 0), 0);
    const qtyOk = declaredQty == null || Math.abs(sumQty - declaredQty) < 0.0001;
    const valueOk = declaredValue == null || Math.abs(sumValue - declaredValue) < 0.01;

    results.push({
      boeNumber,
      declaredQty,
      declaredValue,
      sumQty,
      sumValue,
      qtyOk,
      valueOk,
    });
  }
  return results;
}

function KpiCard({ title, value, hint, tone = "slate" }) {
  const tones = {
    slate: "text-slate-900",
    emerald: "text-emerald-700",
    amber: "text-amber-700",
    rose: "text-rose-700",
    sky: "text-sky-700",
  };
  return (
    <div className="rounded-xl border bg-white p-3 shadow-sm">
      <div className="text-xs font-medium uppercase tracking-wide text-slate-500">{title}</div>
      <div className={`mt-1 text-xl font-semibold tabular-nums ${tones[tone] || tones.slate}`}>{value}</div>
      {hint ? <div className="mt-1 text-xs text-slate-500">{hint}</div> : null}
    </div>
  );
}

function DonutChart({ matched = 0, mismatch = 0 }) {
  const total = Math.max(1, matched + mismatch);
  const pct = (matched / total) * 100;
  const r = 42;
  const c = 2 * Math.PI * r;
  const dash = (pct / 100) * c;
  return (
    <div className="flex items-center gap-4">
      <svg width="110" height="110" viewBox="0 0 110 110" className="shrink-0">
        <circle cx="55" cy="55" r={r} fill="none" stroke="#e2e8f0" strokeWidth="14" />
        <circle
          cx="55"
          cy="55"
          r={r}
          fill="none"
          stroke="#059669"
          strokeWidth="14"
          strokeDasharray={`${dash} ${c - dash}`}
          strokeLinecap="round"
          transform="rotate(-90 55 55)"
        />
        <text x="55" y="52" textAnchor="middle" className="fill-slate-900 text-sm font-semibold">
          {pct.toFixed(0)}%
        </text>
        <text x="55" y="68" textAnchor="middle" className="fill-slate-500 text-[10px]">
          Match
        </text>
      </svg>
      <div className="space-y-1 text-xs">
        <div className="flex items-center gap-2">
          <span className="h-2 w-2 rounded-full bg-emerald-600" />
          Matched: {matched}
        </div>
        <div className="flex items-center gap-2">
          <span className="h-2 w-2 rounded-full bg-slate-300" />
          Mismatch: {mismatch}
        </div>
      </div>
    </div>
  );
}

function BarChart({ items = [] }) {
  const max = Math.max(1, ...items.map((x) => Number(x.absDifference || Math.abs(x.difference) || 0)));
  return (
    <div className="max-h-56 space-y-1 overflow-auto pr-1">
      {items.length === 0 ? (
        <p className="text-xs text-slate-500">No differences to chart.</p>
      ) : (
        items.map((x) => {
          const val = Math.abs(Number(x.difference || 0));
          return (
            <div key={`${x.article}-${x.partNumber}`} className="flex items-center gap-2 text-xs">
              <div className="w-28 truncate font-mono text-slate-600" title={x.article}>
                {x.article}
              </div>
              <div className="h-2 flex-1 rounded bg-slate-100">
                <div
                  className="h-2 rounded bg-amber-600"
                  style={{ width: `${Math.max(4, (val / max) * 100)}%` }}
                />
              </div>
              <div className="w-14 text-right tabular-nums">{fmtNum(val, 0)}</div>
            </div>
          );
        })
      )}
    </div>
  );
}

function TrendChart({ series = [] }) {
  return (
    <div className="space-y-1">
      {series.length === 0 ? (
        <p className="text-xs text-slate-500">No mismatch trend data yet.</p>
      ) : (
        series.map((x) => (
          <div key={x.month} className="flex items-center gap-2 text-xs">
            <div className="w-16 text-slate-500">{x.month}</div>
            <div className="h-2 flex-1 rounded bg-slate-100">
              <div
                className="h-2 rounded bg-rose-500"
                style={{
                  width: `${Math.max(4, (Number(x.mismatchCount) / Math.max(...series.map((s) => s.mismatchCount), 1)) * 100)}%`,
                }}
              />
            </div>
            <div className="w-8 text-right tabular-nums">{x.mismatchCount}</div>
          </div>
        ))
      )}
    </div>
  );
}

export default function CustomsReconciliation() {
  const nav = useNavigate();
  const { auth, selectCompany } = useAuth();
  const [page, setPage] = useState(1);
  const [limit] = useState(50);
  const [search, setSearch] = useState("");
  const [article, setArticle] = useState("");
  const [partNumber, setPartNumber] = useState("");
  const [supplier, setSupplier] = useState("");
  const [boe, setBoe] = useState("");
  const [bl, setBl] = useState("");
  const [awb, setAwb] = useState("");
  const [status, setStatus] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [onlyMismatches, setOnlyMismatches] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [drill, setDrill] = useState({ open: false, article: "", partNumber: "" });

  const queryParams = useMemo(
    () => ({
      page,
      limit,
      search: search.trim() || undefined,
      article: article.trim() || undefined,
      partNumber: partNumber.trim() || undefined,
      supplier: supplier.trim() || undefined,
      boe: boe.trim() || undefined,
      bl: bl.trim() || undefined,
      awb: awb.trim() || undefined,
      status: status || undefined,
      dateFrom: dateFrom || undefined,
      dateTo: dateTo || undefined,
      onlyMismatches: onlyMismatches ? "true" : undefined,
    }),
    [page, limit, search, article, partNumber, supplier, boe, bl, awb, status, dateFrom, dateTo, onlyMismatches],
  );

  const reconQ = useQuery({
    queryKey: ["customs-reconciliation", queryParams, auth?.company?.id],
    queryFn: () => apiGetWithQuery("/customs/reconciliation", queryParams),
  });

  const detailQ = useQuery({
    queryKey: ["customs-reconciliation-detail", drill.article, drill.partNumber, auth?.company?.id],
    queryFn: () =>
      apiGetWithQuery("/customs/reconciliation/detail", {
        article: drill.article,
        partNumber: drill.partNumber || undefined,
      }),
    enabled: drill.open && !!drill.article,
  });

  const rows = reconQ.data?.items || [];
  const total = reconQ.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const summary = reconQ.data?.summary || {};
  const charts = reconQ.data?.charts || {};
  const enabled = reconQ.data?.enabled !== false;
  const currentCompany = auth?.company?.code || reconQ.data?.companyCode || "—";

  const onCompanyChange = useCallback(
    async (e) => {
      const nextId = e.target.value;
      if (!nextId || nextId === auth?.company?.id) return;
      try {
        await selectCompany(nextId);
        setPage(1);
      } catch (err) {
        notify.error(err.message || "Failed to switch company");
      }
    },
    [auth?.company?.id, selectCompany],
  );

  const resetFilters = () => {
    setSearch("");
    setArticle("");
    setPartNumber("");
    setSupplier("");
    setBoe("");
    setBl("");
    setAwb("");
    setStatus("");
    setDateFrom("");
    setDateTo("");
    setOnlyMismatches(false);
    setPage(1);
  };

  const fetchExportRows = async () => {
    const data = await apiGetWithQuery("/customs/reconciliation", {
      ...queryParams,
      page: 1,
      limit: 50000,
      exportAll: true,
    });
    return (data.items || []).map((row) => ({
      ...row,
      lastErpMovementDate: fmtDate(row.lastErpMovementDate),
      lastCustomsMovementDate: fmtDate(row.lastCustomsMovementDate),
    }));
  };

  const exportCsv = async (filenameSuffix = "csv") => {
    setExporting(true);
    try {
      const exportRows = await fetchExportRows();
      const base = `customs-reconciliation-${currentCompany}-${Date.now()}`;
      downloadCsv(`${base}.${filenameSuffix === "xls" ? "xls" : "csv"}`, CSV_COLUMNS, exportRows);
    } catch (e) {
      notify.error(e.message || "Export failed");
    } finally {
      setExporting(false);
    }
  };

  const exportPdf = async () => {
    setExporting(true);
    try {
      const exportRows = await fetchExportRows();
      downloadPdfTable(
        `customs-reconciliation-${currentCompany}`,
        `Customs Reconciliation — ${currentCompany}`,
        CSV_COLUMNS,
        exportRows,
        "Customs Reconciliation",
      );
    } catch (e) {
      notify.error(e.message || "PDF export failed");
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="p-4 md:p-6">
      <PageHeader
        title="Customs Reconciliation"
        subtitle="Read-only comparison of ERP inventory stock vs customs stock — Sharjah Free Zone audit control."
      >
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-800 hover:bg-slate-50 disabled:opacity-40"
            disabled={exporting || !enabled}
            onClick={() => exportCsv("csv")}
          >
            Export CSV
          </button>
          <button
            type="button"
            className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-800 hover:bg-slate-50 disabled:opacity-40"
            disabled={exporting || !enabled}
            onClick={() => exportCsv("xls")}
          >
            Export Excel
          </button>
          <button
            type="button"
            className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-800 hover:bg-slate-50 disabled:opacity-40"
            disabled={exporting || !enabled}
            onClick={exportPdf}
          >
            Export PDF
          </button>
        </div>
      </PageHeader>

      {!enabled && !reconQ.isLoading ? (
        <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          Customs module is disabled. Set <code className="font-mono">CUSTOMS_ENABLED=true</code> on the API.
        </div>
      ) : null}

      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-8">
        <KpiCard title="ERP Stock Value" value={fmtMoney(summary.totalErpStockValue)} tone="sky" />
        <KpiCard title="Customs Stock Value" value={fmtMoney(summary.totalCustomsStockValue)} tone="sky" />
        <KpiCard title="Matched Articles" value={summary.matchedArticles ?? "—"} tone="emerald" />
        <KpiCard title="Mismatch Articles" value={summary.mismatchArticles ?? "—"} tone="amber" />
        <KpiCard title="ERP Higher" value={summary.erpHigherItems ?? "—"} tone="amber" />
        <KpiCard title="Customs Higher" value={summary.customsHigherItems ?? "—"} tone="rose" />
        <KpiCard title="Missing Customs" value={summary.missingCustomsRecords ?? "—"} tone="rose" />
        <KpiCard title="Match %" value={`${summary.matchPct ?? 0}%`} hint={`${summary.totalArticles ?? 0} articles`} tone="emerald" />
      </div>

      <div className="mb-4 grid gap-4 lg:grid-cols-3">
        <div className="rounded-2xl border bg-white p-4 shadow-sm">
          <h3 className="mb-3 text-sm font-semibold text-slate-800">Stock Match %</h3>
          <DonutChart matched={charts.matchBreakdown?.matched} mismatch={charts.matchBreakdown?.mismatch} />
        </div>
        <div className="rounded-2xl border bg-white p-4 shadow-sm">
          <h3 className="mb-3 text-sm font-semibold text-slate-800">Top 20 Largest Differences</h3>
          <BarChart items={charts.topDifferences || []} />
        </div>
        <div className="rounded-2xl border bg-white p-4 shadow-sm">
          <h3 className="mb-3 text-sm font-semibold text-slate-800">Mismatch Trend (by month)</h3>
          <TrendChart series={charts.mismatchTrend || []} />
        </div>
      </div>

      <div className="mb-4 rounded-2xl border bg-white p-4 shadow-sm">
        <div className="mb-3 grid gap-2 md:grid-cols-3 lg:grid-cols-6">
          <label className="flex flex-col gap-1 text-xs">
            <span className="font-medium text-slate-600">Company</span>
            <select
              className="rounded-lg border px-2 py-1.5 text-sm"
              value={auth?.company?.id || ""}
              onChange={onCompanyChange}
            >
              {(auth?.companies || []).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.code || c.name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs">
            <span className="font-medium text-slate-600">Search</span>
            <input className="rounded-lg border px-2 py-1.5 text-sm" value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} placeholder="Article, part, BOE…" />
          </label>
          <label className="flex flex-col gap-1 text-xs">
            <span className="font-medium text-slate-600">Article</span>
            <input className="rounded-lg border px-2 py-1.5 text-sm font-mono" value={article} onChange={(e) => { setArticle(e.target.value); setPage(1); }} />
          </label>
          <label className="flex flex-col gap-1 text-xs">
            <span className="font-medium text-slate-600">Part Number</span>
            <input className="rounded-lg border px-2 py-1.5 text-sm font-mono" value={partNumber} onChange={(e) => { setPartNumber(e.target.value); setPage(1); }} />
          </label>
          <label className="flex flex-col gap-1 text-xs">
            <span className="font-medium text-slate-600">Supplier</span>
            <input className="rounded-lg border px-2 py-1.5 text-sm" value={supplier} onChange={(e) => { setSupplier(e.target.value); setPage(1); }} />
          </label>
          <label className="flex flex-col gap-1 text-xs">
            <span className="font-medium text-slate-600">Status</span>
            <select className="rounded-lg border px-2 py-1.5 text-sm" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
              {STATUS_OPTIONS.map((st) => (
                <option key={st || "ALL"} value={st}>
                  {st || "All statuses"}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs">
            <span className="font-medium text-slate-600">BOE</span>
            <input className="rounded-lg border px-2 py-1.5 text-sm" value={boe} onChange={(e) => { setBoe(e.target.value); setPage(1); }} />
          </label>
          <label className="flex flex-col gap-1 text-xs">
            <span className="font-medium text-slate-600">BL</span>
            <input className="rounded-lg border px-2 py-1.5 text-sm" value={bl} onChange={(e) => { setBl(e.target.value); setPage(1); }} />
          </label>
          <label className="flex flex-col gap-1 text-xs">
            <span className="font-medium text-slate-600">AWB</span>
            <input className="rounded-lg border px-2 py-1.5 text-sm" value={awb} onChange={(e) => { setAwb(e.target.value); setPage(1); }} />
          </label>
          <label className="flex flex-col gap-1 text-xs">
            <span className="font-medium text-slate-600">Date from</span>
            <input type="date" className="rounded-lg border px-2 py-1.5 text-sm" value={dateFrom} onChange={(e) => { setDateFrom(e.target.value); setPage(1); }} />
          </label>
          <label className="flex flex-col gap-1 text-xs">
            <span className="font-medium text-slate-600">Date to</span>
            <input type="date" className="rounded-lg border px-2 py-1.5 text-sm" value={dateTo} onChange={(e) => { setDateTo(e.target.value); setPage(1); }} />
          </label>
          <label className="flex items-end gap-2 pb-1 text-xs">
            <input type="checkbox" checked={onlyMismatches} onChange={(e) => { setOnlyMismatches(e.target.checked); setPage(1); }} />
            Only mismatches
          </label>
          <div className="flex items-end">
            <button type="button" className="rounded-lg border px-3 py-1.5 text-xs hover:bg-slate-50" onClick={resetFilters}>
              Reset filters
            </button>
          </div>
        </div>

        {reconQ.error ? (
          <p className="mb-2 text-sm text-rose-700">{reconQ.error.message || "Failed to load reconciliation"}</p>
        ) : null}

        <div className="overflow-x-auto rounded-xl border">
          <table className="min-w-full text-left text-xs">
            <thead className="sticky top-0 bg-slate-100 text-[11px] uppercase tracking-wide text-slate-600">
              <tr>
                {[
                  "Company",
                  "Article",
                  "Part No",
                  "Part Name",
                  "ERP Stock",
                  "Customs Stock",
                  "Difference",
                  "Diff %",
                  "Last ERP Mvmt",
                  "Last Customs Mvmt",
                  "Last BOE",
                  "Last BL",
                  "Last Supp. Inv",
                  "Status",
                  "Action Required",
                ].map((h) => (
                  <th key={h} className="px-2 py-2 whitespace-nowrap">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {reconQ.isLoading ? (
                <tr>
                  <td colSpan={15} className="px-2 py-8 text-center text-slate-500">
                    Loading reconciliation…
                  </td>
                </tr>
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan={15} className="px-2 py-8 text-center text-slate-500">
                    No reconciliation rows for current filters.
                  </td>
                </tr>
              ) : (
                rows.map((row) => (
                  <tr
                    key={`${row.article}-${row.partNumber}`}
                    className="cursor-pointer border-t hover:bg-sky-50/60"
                    onClick={() => setDrill({ open: true, article: row.article, partNumber: row.partNumber || "" })}
                  >
                    <td className="px-2 py-2">{row.company || currentCompany}</td>
                    <td className="px-2 py-2 font-mono">{row.article}</td>
                    <td className="px-2 py-2 font-mono">{row.partNumber || "—"}</td>
                    <td className="px-2 py-2 max-w-[10rem] truncate" title={row.partName}>
                      {row.partName || "—"}
                    </td>
                    <td className="px-2 py-2 text-right tabular-nums">{fmtNum(row.erpStock, 4)}</td>
                    <td className="px-2 py-2 text-right tabular-nums">{fmtNum(row.customsStock, 4)}</td>
                    <td className="px-2 py-2 text-right tabular-nums font-semibold">{fmtNum(row.difference, 4)}</td>
                    <td className="px-2 py-2 text-right tabular-nums">{fmtNum(row.differencePct, 1)}%</td>
                    <td className="px-2 py-2 whitespace-nowrap">{fmtDate(row.lastErpMovementDate)}</td>
                    <td className="px-2 py-2 whitespace-nowrap">{fmtDate(row.lastCustomsMovementDate)}</td>
                    <td className="px-2 py-2">{row.lastBoe || "—"}</td>
                    <td className="px-2 py-2">{row.lastBl || "—"}</td>
                    <td className="px-2 py-2">{row.lastSupplierInvoice || "—"}</td>
                    <td className="px-2 py-2">
                      <span className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-semibold ring-1 ${statusClass(row.status)}`}>
                        {row.status}
                      </span>
                    </td>
                    <td className="px-2 py-2 text-slate-700">{row.actionRequired}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-600">
          <span>
            Page {page} of {totalPages} · {total} article(s)
          </span>
          <div className="flex gap-2">
            <button type="button" className="rounded border px-2 py-1 disabled:opacity-40" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>
              Previous
            </button>
            <button type="button" className="rounded border px-2 py-1 disabled:opacity-40" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>
              Next
            </button>
          </div>
        </div>
      </div>

      <Modal
        open={drill.open}
        onClose={() => setDrill({ open: false, article: "", partNumber: "" })}
        title={`Reconciliation detail — ${drill.article}${drill.partNumber ? ` / ${drill.partNumber}` : ""}`}
        wide
      >
        {detailQ.isLoading ? (
          <p className="text-sm text-slate-500">Loading detail…</p>
        ) : (
          <div className="grid gap-4 lg:grid-cols-2 text-sm">
            <div className="rounded-xl border bg-slate-50 p-3">
              <h4 className="mb-2 font-semibold text-slate-800">ERP Details</h4>
              <p className="mb-2 text-xs text-slate-600">
                Current stock: <strong>{fmtNum(detailQ.data?.erp?.currentStock, 4)}</strong>
              </p>
              <div className="mb-3 max-h-32 overflow-auto rounded border bg-white text-xs">
                <table className="min-w-full">
                  <thead className="bg-slate-100">
                    <tr>
                      <th className="px-2 py-1 text-left">WH/Loc</th>
                      <th className="px-2 py-1 text-right">Available</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(detailQ.data?.erp?.locations || []).map((loc, i) => (
                      <tr key={i} className="border-t">
                        <td className="px-2 py-1">{loc.warehouse || loc.location}</td>
                        <td className="px-2 py-1 text-right tabular-nums">{fmtNum(loc.availableQty, 4)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="mb-1 text-xs font-medium text-slate-600">Last stock movements</p>
              <div className="max-h-36 overflow-auto rounded border bg-white text-xs">
                {(detailQ.data?.erp?.lastMovements || []).slice(0, 8).map((m, i) => (
                  <div key={i} className="border-b px-2 py-1">
                    {fmtDate(m.date)} · {m.type} · {m.referenceNo} · in {m.qtyIn} / out {m.qtyOut}
                  </div>
                ))}
              </div>
              <button
                type="button"
                className="mt-2 rounded border px-2 py-1 text-xs hover:bg-white"
                onClick={() => nav(`/store?tab=Stock View&article=${encodeURIComponent(drill.article)}`)}
              >
                View Stock Ledger
              </button>
            </div>

            <div className="rounded-xl border bg-slate-50 p-3">
              <h4 className="mb-2 font-semibold text-slate-800">Customs Details</h4>
              <p className="mb-2 text-xs text-slate-600">
                Available customs stock: <strong>{fmtNum(detailQ.data?.customs?.currentStock, 4)}</strong>
              </p>
              {(() => {
                const customsItems = detailQ.data?.customs?.items || [];
                const invariants = computeBoeAverageInvariants(customsItems);
                return invariants.length ? (
                  <div className="mb-3 rounded border border-sky-200 bg-sky-50 p-2 text-xs text-sky-900">
                    <div className="font-semibold">BOE average declared invariants</div>
                    {invariants.map((inv) => (
                      <div key={inv.boeNumber} className="mt-1">
                        BOE {inv.boeNumber}: qty Σ {fmtNum(inv.sumQty, 4)}
                        {inv.declaredQty != null ? ` vs declared ${fmtNum(inv.declaredQty, 4)}` : ""}
                        {inv.declaredQty != null ? (inv.qtyOk ? " ✓" : " ⚠ mismatch") : ""}
                        {" · "}
                        value Σ {fmtMoney(inv.sumValue)}
                        {inv.declaredValue != null ? ` vs declared ${fmtMoney(inv.declaredValue)}` : ""}
                        {inv.declaredValue != null ? (inv.valueOk ? " ✓" : " ⚠ mismatch") : ""}
                      </div>
                    ))}
                  </div>
                ) : null;
              })()}
              <div className="mb-3 max-h-40 overflow-auto rounded border bg-white text-xs">
                <table className="min-w-full">
                  <thead className="bg-slate-100">
                    <tr>
                      <th className="px-2 py-1 text-left">BOE</th>
                      <th className="px-2 py-1 text-left">BL</th>
                      <th className="px-2 py-1 text-left">Invoice</th>
                      <th className="px-2 py-1 text-left">Valuation</th>
                      <th className="px-2 py-1 text-right">BOE Decl. Qty</th>
                      <th className="px-2 py-1 text-right">BOE Decl. Value</th>
                      <th className="px-2 py-1 text-right">Customs Unit</th>
                      <th className="px-2 py-1 text-right">Imported</th>
                      <th className="px-2 py-1 text-right">Consumed</th>
                      <th className="px-2 py-1 text-right">Available</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(detailQ.data?.customs?.items || []).map((it, i) => (
                      <tr key={i} className="border-t">
                        <td className="px-2 py-1">{it.boeNumber || "—"}</td>
                        <td className="px-2 py-1">{it.blNumber || "—"}</td>
                        <td className="px-2 py-1">{it.supplierInvoiceNumber || "—"}</td>
                        <td className="px-2 py-1">{it.valuationMethod || "—"}</td>
                        <td className="px-2 py-1 text-right tabular-nums">
                          {isBoeAverageMethod(it.valuationMethod) && it.boeDeclaredQty != null
                            ? fmtNum(it.boeDeclaredQty, 4)
                            : "—"}
                        </td>
                        <td className="px-2 py-1 text-right tabular-nums">
                          {isBoeAverageMethod(it.valuationMethod) && it.boeDeclaredValue != null
                            ? fmtMoney(it.boeDeclaredValue)
                            : "—"}
                        </td>
                        <td className="px-2 py-1 text-right tabular-nums">
                          {it.customsUnitValue != null || it.unitPrice != null
                            ? fmtNum(it.customsUnitValue ?? it.unitPrice, 4)
                            : "—"}
                        </td>
                        <td className="px-2 py-1 text-right tabular-nums">{fmtNum(it.qtyImported, 4)}</td>
                        <td className="px-2 py-1 text-right tabular-nums">{fmtNum(it.qtyConsumed, 4)}</td>
                        <td className="px-2 py-1 text-right tabular-nums">{fmtNum(it.qtyAvailable, 4)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="mb-1 text-xs font-medium text-slate-600">Last customs movements</p>
              <div className="max-h-28 overflow-auto rounded border bg-white text-xs">
                {(detailQ.data?.customs?.lastMovements || []).slice(0, 6).map((m, i) => (
                  <div key={i} className="border-b px-2 py-1">
                    {fmtDate(m.date)} · {m.movementType} · {m.referenceNumber} · qty {fmtNum(m.qty, 4)}
                  </div>
                ))}
              </div>
              <Link
                className="mt-2 inline-block rounded border px-2 py-1 text-xs hover:bg-white"
                to={`/customs/ledger?article=${encodeURIComponent(drill.article)}`}
                onClick={() => setDrill({ open: false, article: "", partNumber: "" })}
              >
                View Customs Ledger
              </Link>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
