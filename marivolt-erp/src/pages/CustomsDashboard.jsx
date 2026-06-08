import { useCallback, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import PageHeader from "../components/erp/PageHeader.jsx";
import { useAuth } from "../context/AuthContext.jsx";
import { apiGetWithQuery, apiPost } from "../lib/api.js";
import { downloadCsv, downloadPdfTable } from "../lib/purchaseExport.js";

const STOCK_COLUMNS = [
  { key: "article", header: "Article" },
  { key: "description", header: "Description" },
  { key: "qtyIn", header: "Qty In" },
  { key: "qtyOut", header: "Qty Out" },
  { key: "balance", header: "Balance" },
  { key: "stockValue", header: "Stock Value" },
];

const BL_COLUMNS = [
  { key: "blNumber", header: "BL Number" },
  { key: "supplier", header: "Supplier" },
  { key: "qty", header: "Qty" },
  { key: "balance", header: "Balance" },
  { key: "value", header: "Value" },
];

const BOE_COLUMNS = [
  { key: "boeNumber", header: "BOE Number" },
  { key: "date", header: "Date" },
  { key: "balanceQty", header: "Balance Qty" },
  { key: "balanceValue", header: "Balance Value" },
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

function KpiCard({ title, value, hint, tone = "slate" }) {
  const tones = {
    slate: "text-slate-900",
    emerald: "text-emerald-700",
    amber: "text-amber-700",
    rose: "text-rose-700",
    sky: "text-sky-700",
    violet: "text-violet-700",
  };
  return (
    <div className="rounded-xl border bg-white p-3 shadow-sm">
      <div className="text-xs font-medium uppercase tracking-wide text-slate-500">{title}</div>
      <div className={`mt-1 text-xl font-semibold tabular-nums ${tones[tone] || tones.slate}`}>{value}</div>
      {hint ? <div className="mt-1 text-xs text-slate-500">{hint}</div> : null}
    </div>
  );
}

function StatusCard({ label, count, tone }) {
  const tones = {
    emerald: "border-emerald-200 bg-emerald-50 text-emerald-900",
    amber: "border-amber-200 bg-amber-50 text-amber-900",
    sky: "border-sky-200 bg-sky-50 text-sky-900",
    violet: "border-violet-200 bg-violet-50 text-violet-900",
    rose: "border-rose-200 bg-rose-50 text-rose-900",
    slate: "border-slate-200 bg-slate-50 text-slate-900",
  };
  return (
    <div className={`rounded-xl border p-3 ${tones[tone] || tones.sky}`}>
      <div className="text-xs font-medium uppercase tracking-wide opacity-80">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{count}</div>
    </div>
  );
}

function MovementTrendChart({ series = [] }) {
  const max = Math.max(1, ...series.flatMap((x) => [Number(x.inboundQty) || 0, Number(x.outboundQty) || 0]));
  return (
    <div className="space-y-2">
      {series.length === 0 ? (
        <p className="text-xs text-slate-500">No movement data for selected filters.</p>
      ) : (
        series.map((x) => (
          <div key={x.month} className="space-y-1">
            <div className="text-xs font-medium text-slate-600">{x.month}</div>
            <div className="flex items-center gap-2 text-[11px]">
              <span className="w-14 text-emerald-700">In</span>
              <div className="h-2 flex-1 rounded bg-slate-100">
                <div
                  className="h-2 rounded bg-emerald-500"
                  style={{ width: `${Math.max(4, ((Number(x.inboundQty) || 0) / max) * 100)}%` }}
                />
              </div>
              <span className="w-12 text-right tabular-nums">{fmtNum(x.inboundQty, 0)}</span>
            </div>
            <div className="flex items-center gap-2 text-[11px]">
              <span className="w-14 text-rose-700">Out</span>
              <div className="h-2 flex-1 rounded bg-slate-100">
                <div
                  className="h-2 rounded bg-rose-500"
                  style={{ width: `${Math.max(4, ((Number(x.outboundQty) || 0) / max) * 100)}%` }}
                />
              </div>
              <span className="w-12 text-right tabular-nums">{fmtNum(x.outboundQty, 0)}</span>
            </div>
          </div>
        ))
      )}
    </div>
  );
}

function DataTable({ title, columns, rows, emptyText = "No data." }) {
  return (
    <div className="overflow-hidden rounded-2xl border bg-white shadow-sm">
      <div className="border-b px-4 py-2 text-sm font-semibold text-slate-800">{title}</div>
      <div className="overflow-x-auto">
        <table className="min-w-full text-left text-xs">
          <thead className="bg-slate-100 text-[11px] uppercase tracking-wide text-slate-600">
            <tr>
              {columns.map((c) => (
                <th key={c.key} className="px-2 py-2 whitespace-nowrap">
                  {c.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {!rows.length ? (
              <tr>
                <td colSpan={columns.length} className="px-3 py-8 text-center text-slate-500">
                  {emptyText}
                </td>
              </tr>
            ) : (
              rows.map((row, i) => (
                <tr key={row._key || i} className="border-t hover:bg-slate-50">
                  {columns.map((c) => (
                    <td key={c.key} className="px-2 py-1.5 whitespace-nowrap">
                      {c.render ? c.render(row) : row[c.key] ?? "—"}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function CustomsDashboard() {
  const { auth, selectCompany } = useAuth();
  const [article, setArticle] = useState("");
  const [supplier, setSupplier] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [exporting, setExporting] = useState(false);

  const queryParams = useMemo(
    () => ({
      article: article.trim() || undefined,
      supplier: supplier.trim() || undefined,
      dateFrom: dateFrom || undefined,
      dateTo: dateTo || undefined,
    }),
    [article, supplier, dateFrom, dateTo],
  );

  const dashQ = useQuery({
    queryKey: ["customs-dashboard", queryParams, auth?.company?.id],
    queryFn: () => apiGetWithQuery("/customs/dashboard", queryParams),
  });

  const data = dashQ.data;
  const enabled = data?.enabled !== false;
  const currentCompany = auth?.company?.code || data?.companyCode || "—";
  const summary = data?.summary || {};
  const statusCards = data?.statusCards || {};

  const onCompanyChange = useCallback(
    async (e) => {
      const nextId = e.target.value;
      if (!nextId || nextId === auth?.company?.id) return;
      try {
        await selectCompany(nextId);
      } catch (err) {
        window.alert(err.message || "Failed to switch company");
      }
    },
    [auth?.company?.id, selectCompany],
  );

  const logExport = async (format) => {
    try {
      await apiPost("/customs/dashboard/export-log", { format, filters: queryParams });
    } catch {
      // Audit logging is best-effort; export still proceeds.
    }
  };

  const buildExportRows = () => {
    const stock = (data?.stockOverview || []).map((r) => ({
      section: "Stock Overview",
      ...r,
      stockValue: fmtMoney(r.stockValue),
    }));
    const bl = (data?.openBl || []).map((r) => ({
      section: "Open BL",
      ...r,
      value: fmtMoney(r.value),
    }));
    const boe = (data?.openBoe || []).map((r) => ({
      section: "Open BOE",
      ...r,
      date: fmtDate(r.date),
      balanceValue: fmtMoney(r.balanceValue),
    }));
    return [...stock, ...bl, ...boe];
  };

  const exportExcel = async () => {
    setExporting(true);
    try {
      await logExport("excel");
      const rows = buildExportRows();
      const columns = [
        { key: "section", header: "Section" },
        { key: "article", header: "Article" },
        { key: "description", header: "Description" },
        { key: "blNumber", header: "BL Number" },
        { key: "boeNumber", header: "BOE Number" },
        { key: "supplier", header: "Supplier" },
        { key: "qtyIn", header: "Qty In" },
        { key: "qtyOut", header: "Qty Out" },
        { key: "balance", header: "Balance" },
        { key: "stockValue", header: "Stock Value" },
        { key: "date", header: "Date" },
      ];
      downloadCsv(`customs-dashboard-${currentCompany}-${Date.now()}.xls`, columns, rows);
    } catch (e) {
      window.alert(e.message || "Excel export failed");
    } finally {
      setExporting(false);
    }
  };

  const exportPdf = async () => {
    setExporting(true);
    try {
      await logExport("pdf");
      const summaryRows = [
        { metric: "Open BL Count", value: summary.openBlCount },
        { metric: "Open BOE Count", value: summary.openBoeCount },
        { metric: "Customs Stock Value", value: fmtMoney(summary.customsStockValue) },
        { metric: "Pending Reconciliation", value: summary.pendingReconciliation },
      ];
      const base = `customs-dashboard-${currentCompany}-${Date.now()}`;
      await downloadPdfTable(
        "Customs Dashboard",
        `Executive Customs Dashboard — ${currentCompany}`,
        [
          { key: "metric", header: "Metric" },
          { key: "value", header: "Value" },
        ],
        summaryRows,
        base,
        auth?.company,
      );
      if ((data?.stockOverview || []).length) {
        await downloadPdfTable(`${base}-stock`, "Customs Stock Overview", STOCK_COLUMNS, data.stockOverview, `${base}-stock`, auth?.company);
      }
      if ((data?.openBl || []).length) {
        await downloadPdfTable(`${base}-bl`, "Open BL Summary", BL_COLUMNS, data.openBl, `${base}-bl`, auth?.company);
      }
      if ((data?.openBoe || []).length) {
        const boeRows = (data.openBoe || []).map((r) => ({ ...r, date: fmtDate(r.date), balanceValue: fmtMoney(r.balanceValue) }));
        await downloadPdfTable(`${base}-boe`, "Open BOE Summary", BOE_COLUMNS, boeRows, `${base}-boe`, auth?.company);
      }
    } catch (e) {
      window.alert(e.message || "PDF export failed");
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="p-4 md:p-6">
      <PageHeader
        title="Customs Dashboard"
        subtitle="Executive view of customs stock, open BL/BOE, movement trends, and reconciliation status."
      >
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="rounded-lg border px-3 py-2 text-sm font-semibold hover:bg-slate-50 disabled:opacity-40"
            disabled={exporting || !enabled || dashQ.isLoading}
            onClick={exportExcel}
          >
            Export Excel
          </button>
          <button
            type="button"
            className="rounded-lg border px-3 py-2 text-sm font-semibold hover:bg-slate-50 disabled:opacity-40"
            disabled={exporting || !enabled || dashQ.isLoading}
            onClick={exportPdf}
          >
            Export PDF
          </button>
        </div>
      </PageHeader>

      <div className="mb-4 rounded-2xl border bg-white p-4 shadow-sm">
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-5">
          <label className="flex flex-col gap-1 text-xs">
            <span className="font-medium text-slate-600">Company</span>
            <select className="rounded-lg border px-2 py-2 text-sm" value={auth?.company?.id || ""} onChange={onCompanyChange}>
              {(auth?.companies || []).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.code || c.name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs">
            <span className="font-medium text-slate-600">Article</span>
            <input className="rounded-lg border px-2 py-2 text-sm" value={article} onChange={(e) => setArticle(e.target.value)} placeholder="Optional" />
          </label>
          <label className="flex flex-col gap-1 text-xs">
            <span className="font-medium text-slate-600">Supplier</span>
            <input className="rounded-lg border px-2 py-2 text-sm" value={supplier} onChange={(e) => setSupplier(e.target.value)} placeholder="Optional" />
          </label>
          <label className="flex flex-col gap-1 text-xs">
            <span className="font-medium text-slate-600">Date from</span>
            <input type="date" className="rounded-lg border px-2 py-2 text-sm" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
          </label>
          <label className="flex flex-col gap-1 text-xs">
            <span className="font-medium text-slate-600">Date to</span>
            <input type="date" className="rounded-lg border px-2 py-2 text-sm" value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
          </label>
        </div>
        <div className="mt-3 flex flex-wrap gap-2 text-xs">
          <Link to="/customs/stock" className="text-sky-700 underline">
            Customs Stock
          </Link>
          <Link to="/customs/ledger" className="text-sky-700 underline">
            Ledger
          </Link>
          <Link to="/customs/reconciliation" className="text-sky-700 underline">
            Reconciliation
          </Link>
        </div>
      </div>

      {dashQ.error ? (
        <div className="mb-3 rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">{dashQ.error.message}</div>
      ) : null}

      {!enabled ? (
        <div className="rounded-2xl border bg-white p-8 text-center text-sm text-slate-500 shadow-sm">
          Customs module is disabled on this environment.
        </div>
      ) : dashQ.isLoading ? (
        <div className="rounded-2xl border bg-white p-8 text-center text-sm text-slate-500 shadow-sm">Loading dashboard…</div>
      ) : (
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <KpiCard title="Open BL Count" value={fmtNum(summary.openBlCount, 0)} hint="BL numbers with stock remaining" tone="sky" />
            <KpiCard title="Open BOE Count" value={fmtNum(summary.openBoeCount, 0)} hint="BOE numbers with stock remaining" tone="violet" />
            <KpiCard title="Customs Stock Value" value={fmtMoney(summary.customsStockValue)} hint={`Balance ${fmtNum(summary.customsStockBalance, 0)} units`} tone="emerald" />
            <KpiCard
              title="Pending Reconciliation"
              value={fmtNum(summary.pendingReconciliation, 0)}
              hint={`Match ${summary.matchPct ?? 0}%`}
              tone="rose"
            />
          </div>

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <StatusCard label="In Stock" count={fmtNum(statusCards.inStock, 0)} tone="emerald" />
            <StatusCard label="Fully Consumed" count={fmtNum(statusCards.fullyConsumed, 0)} tone="slate" />
            <StatusCard label="Partially Consumed" count={fmtNum(statusCards.partiallyConsumed, 0)} tone="amber" />
            <StatusCard label="Reconciled" count={fmtNum(statusCards.reconciled, 0)} tone="sky" />
            <StatusCard label="Mismatch" count={fmtNum(statusCards.mismatch, 0)} tone="rose" />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <div className="rounded-2xl border bg-white p-4 shadow-sm">
              <h2 className="mb-3 text-sm font-semibold text-slate-800">Customs Movement Trend</h2>
              <MovementTrendChart series={data?.movementTrend || []} />
            </div>
            <DataTable
              title="Customs Stock Overview (Top 20)"
              columns={STOCK_COLUMNS.map((c) =>
                ["qtyIn", "qtyOut", "balance"].includes(c.key)
                  ? { ...c, render: (r) => fmtNum(r[c.key], 0) }
                  : c.key === "stockValue"
                    ? { ...c, render: (r) => fmtMoney(r.stockValue) }
                    : c,
              )}
              rows={data?.stockOverview || []}
            />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <DataTable
              title="Open BL Summary"
              columns={BL_COLUMNS.map((c) =>
                ["qty", "balance"].includes(c.key)
                  ? { ...c, render: (r) => fmtNum(r[c.key], 0) }
                  : c.key === "value"
                    ? { ...c, render: (r) => fmtMoney(r.value) }
                    : c,
              )}
              rows={data?.openBl || []}
            />
            <DataTable
              title="Open BOE Summary"
              columns={BOE_COLUMNS.map((c) =>
                c.key === "date"
                  ? { ...c, render: (r) => fmtDate(r.date) }
                  : c.key === "balanceQty"
                    ? { ...c, render: (r) => fmtNum(r.balanceQty, 0) }
                    : c.key === "balanceValue"
                      ? { ...c, render: (r) => fmtMoney(r.balanceValue) }
                      : c,
              )}
              rows={data?.openBoe || []}
            />
          </div>

          <p className="text-xs text-slate-500">
            Company <strong>{currentCompany}</strong> · Generated {fmtDate(data?.generatedAt)}
          </p>
        </div>
      )}
    </div>
  );
}
