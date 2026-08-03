import { useCallback, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import PageHeader from "../components/erp/PageHeader.jsx";
import { useAuth } from "../context/AuthContext.jsx";
import { apiGetWithQuery, apiPost } from "../lib/api.js";
import { downloadCsv, downloadExcelWorkbook, downloadPdfTable } from "../lib/purchaseExport.js";
import { notify } from "../lib/notifications.js";

const MODULES = ["", "Sales", "Purchase", "Inventory", "Customs", "Master Data", "Accounts"];
const SEVERITIES = ["", "Critical", "Major", "Minor"];

const ISSUE_COLUMNS = [
  { key: "severity", header: "Severity" },
  { key: "module", header: "Module" },
  { key: "issueType", header: "Issue Type" },
  { key: "documentNumber", header: "Document Number" },
  { key: "reference", header: "Reference" },
  { key: "description", header: "Description" },
  { key: "suggestedAction", header: "Suggested Action" },
];

function fmtDate(v) {
  if (!v) return "—";
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toISOString().slice(0, 10);
}

function fmtDateTime(v) {
  if (!v) return "—";
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString();
}

function fmtNum(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
}

function severityTone(s) {
  if (s === "Critical") return "bg-rose-50 text-rose-800 ring-rose-200";
  if (s === "Major") return "bg-amber-50 text-amber-900 ring-amber-200";
  return "bg-slate-50 text-slate-700 ring-slate-200";
}

function ratingTone(r) {
  if (r === "Excellent") return "text-emerald-700";
  if (r === "Good") return "text-sky-700";
  if (r === "Warning") return "text-amber-700";
  return "text-rose-700";
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

function BarList({ items = [], labelKey = "label", valueKey = "count" }) {
  const max = Math.max(1, ...items.map((x) => Number(x[valueKey]) || 0));
  return (
    <div className="space-y-1">
      {!items.length ? (
        <p className="text-xs text-slate-500">No data.</p>
      ) : (
        items.map((x) => (
          <div key={x[labelKey]} className="flex items-center gap-2 text-xs">
            <div className="w-28 truncate" title={x[labelKey]}>
              {x[labelKey]}
            </div>
            <div className="h-2 flex-1 rounded bg-slate-100">
              <div className="h-2 rounded bg-sky-600" style={{ width: `${Math.max(4, ((Number(x[valueKey]) || 0) / max) * 100)}%` }} />
            </div>
            <div className="w-8 text-right tabular-nums">{x[valueKey]}</div>
          </div>
        ))
      )}
    </div>
  );
}

export default function DataHealthDashboard() {
  const { auth, selectCompany } = useAuth();
  const queryClient = useQueryClient();
  const [module, setModule] = useState("");
  const [severity, setSeverity] = useState("");
  const [documentNumber, setDocumentNumber] = useState("");
  const [article, setArticle] = useState("");
  const [customer, setCustomer] = useState("");
  const [supplier, setSupplier] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [exporting, setExporting] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const queryParams = useMemo(
    () => ({
      module: module || undefined,
      severity: severity || undefined,
      documentNumber: documentNumber.trim() || undefined,
      article: article.trim() || undefined,
      customer: customer.trim() || undefined,
      supplier: supplier.trim() || undefined,
      dateFrom: dateFrom || undefined,
      dateTo: dateTo || undefined,
    }),
    [module, severity, documentNumber, article, customer, supplier, dateFrom, dateTo],
  );

  const healthQ = useQuery({
    queryKey: ["data-health", queryParams, auth?.company?.id],
    queryFn: () => apiGetWithQuery("/data-health", queryParams),
  });

  const data = healthQ.data;
  const counts = data?.counts || {};
  const charts = data?.charts || {};
  const issues = data?.issues || [];
  const currentCompany = auth?.company?.code || data?.companyCode || "—";

  const refreshAudit = useCallback(async () => {
    setRefreshing(true);
    try {
      const fresh = await apiGetWithQuery("/data-health", { ...queryParams, refresh: "true" });
      queryClient.setQueryData(["data-health", queryParams, auth?.company?.id], fresh);
    } catch (err) {
      notify.error(err.message || "Failed to refresh audit");
    } finally {
      setRefreshing(false);
    }
  }, [auth?.company?.id, queryClient, queryParams]);

  const onCompanyChange = useCallback(
    async (e) => {
      const nextId = e.target.value;
      if (!nextId || nextId === auth?.company?.id) return;
      try {
        await selectCompany(nextId);
      } catch (err) {
        notify.error(err.message || "Failed to switch company");
      }
    },
    [auth?.company?.id, selectCompany],
  );

  const logExport = async (format) => {
    try {
      await apiPost("/data-health/export-log", { format, filters: queryParams });
    } catch {
      // Best-effort.
    }
  };

  const summaryRows = () => [
    { metric: "Health Score", value: data?.healthScore },
    { metric: "Health Rating", value: data?.healthRating },
    { metric: "Critical Issues", value: data?.criticalCount },
    { metric: "Major Issues", value: data?.majorCount },
    { metric: "Minor Issues", value: data?.minorCount },
    { metric: "Sales Count", value: counts.salesCount },
    { metric: "Purchase Count", value: counts.purchaseCount },
    { metric: "GRN Count", value: counts.grnCount },
    { metric: "Inventory Count", value: counts.inventoryCount },
    { metric: "Customs Count", value: counts.customsCount },
    { metric: "Customer Count", value: counts.customerCount },
    { metric: "Supplier Count", value: counts.supplierCount },
    { metric: "Article Count", value: counts.articleCount },
  ];

  const exportCsv = async () => {
    setExporting(true);
    try {
      await logExport("csv");
      downloadCsv(`data-health-${currentCompany}-${Date.now()}.csv`, ISSUE_COLUMNS, issues);
    } catch (e) {
      notify.error(e.message || "CSV export failed");
    } finally {
      setExporting(false);
    }
  };

  const exportExcel = async () => {
    setExporting(true);
    try {
      await logExport("excel");
      downloadExcelWorkbook(`data-health-${currentCompany}-${Date.now()}.xls`, [
        { name: "Summary", columns: [{ key: "metric", header: "Metric" }, { key: "value", header: "Value" }], rows: summaryRows() },
        { name: "Issues", columns: ISSUE_COLUMNS, rows: issues },
      ]);
    } catch (e) {
      notify.error(e.message || "Excel export failed");
    } finally {
      setExporting(false);
    }
  };

  const exportPdf = async () => {
    setExporting(true);
    try {
      await logExport("pdf");
      const base = `data-health-${currentCompany}-${Date.now()}`;
      await downloadPdfTable("Data Health Dashboard", `ERP Data Health — ${currentCompany}`, [{ key: "metric", header: "Metric" }, { key: "value", header: "Value" }], summaryRows(), base, auth?.company);
      if (issues.length) {
        await downloadPdfTable(`${base}-issues`, "Data Health Issues", ISSUE_COLUMNS, issues, `${base}-issues`, auth?.company);
      }
    } catch (e) {
      notify.error(e.message || "PDF export failed");
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="p-4 md:p-6">
      <PageHeader title="Data Health Dashboard" subtitle="Read-only ERP self-audit — workflow, inventory, customs, master data, and accounts integrity.">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-sm font-semibold text-sky-800 hover:bg-sky-100 disabled:opacity-40"
            disabled={refreshing || healthQ.isLoading}
            onClick={refreshAudit}
          >
            {refreshing ? "Refreshing…" : "Refresh Audit"}
          </button>
          <span className="text-xs text-slate-500">
            Last audit: {fmtDateTime(data?.lastAuditRun || data?.generatedAt)}
            {data?.fromCache ? " (cached)" : ""}
          </span>
          <button type="button" className="rounded-lg border px-3 py-2 text-sm font-semibold hover:bg-slate-50 disabled:opacity-40" disabled={exporting || healthQ.isLoading} onClick={exportCsv}>
            Export CSV
          </button>
          <button type="button" className="rounded-lg border px-3 py-2 text-sm font-semibold hover:bg-slate-50 disabled:opacity-40" disabled={exporting || healthQ.isLoading} onClick={exportExcel}>
            Export Excel
          </button>
          <button type="button" className="rounded-lg border px-3 py-2 text-sm font-semibold hover:bg-slate-50 disabled:opacity-40" disabled={exporting || healthQ.isLoading} onClick={exportPdf}>
            Export PDF
          </button>
        </div>
      </PageHeader>

      <div className="mb-4 rounded-2xl border bg-white p-4 shadow-sm">
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
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
            <span className="font-medium text-slate-600">Module</span>
            <select className="rounded-lg border px-2 py-2 text-sm" value={module} onChange={(e) => setModule(e.target.value)}>
              {MODULES.map((m) => (
                <option key={m || "all"} value={m}>
                  {m || "All"}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs">
            <span className="font-medium text-slate-600">Severity</span>
            <select className="rounded-lg border px-2 py-2 text-sm" value={severity} onChange={(e) => setSeverity(e.target.value)}>
              {SEVERITIES.map((s) => (
                <option key={s || "all"} value={s}>
                  {s || "All"}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs">
            <span className="font-medium text-slate-600">Document Number</span>
            <input className="rounded-lg border px-2 py-2 text-sm" value={documentNumber} onChange={(e) => setDocumentNumber(e.target.value)} />
          </label>
          <label className="flex flex-col gap-1 text-xs">
            <span className="font-medium text-slate-600">Article</span>
            <input className="rounded-lg border px-2 py-2 text-sm" value={article} onChange={(e) => setArticle(e.target.value)} />
          </label>
          <label className="flex flex-col gap-1 text-xs">
            <span className="font-medium text-slate-600">Customer</span>
            <input className="rounded-lg border px-2 py-2 text-sm" value={customer} onChange={(e) => setCustomer(e.target.value)} />
          </label>
          <label className="flex flex-col gap-1 text-xs">
            <span className="font-medium text-slate-600">Supplier</span>
            <input className="rounded-lg border px-2 py-2 text-sm" value={supplier} onChange={(e) => setSupplier(e.target.value)} />
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
      </div>

      {healthQ.error ? (
        <div className="mb-3 rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">{healthQ.error.message}</div>
      ) : null}

      {healthQ.isLoading ? (
        <div className="rounded-2xl border bg-white p-8 text-center text-sm text-slate-500 shadow-sm">Running data health scan…</div>
      ) : (
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <KpiCard title="Health Score" value={data?.healthScore ?? "—"} hint={data?.healthRating} tone="emerald" />
            <div className="rounded-xl border bg-white p-3 shadow-sm sm:col-span-1">
              <div className="text-xs font-medium uppercase tracking-wide text-slate-500">Health Rating</div>
              <div className={`mt-1 text-xl font-semibold ${ratingTone(data?.healthRating)}`}>{data?.healthRating || "—"}</div>
            </div>
          </div>

          <div>
            <h2 className="mb-2 text-sm font-semibold text-slate-800">Issue Summary</h2>
            <div className="grid gap-3 sm:grid-cols-3">
              <KpiCard title="Critical Issues" value={fmtNum(data?.criticalCount)} tone="rose" />
              <KpiCard title="Major Issues" value={fmtNum(data?.majorCount)} tone="amber" />
              <KpiCard title="Minor Issues" value={fmtNum(data?.minorCount)} tone="slate" />
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <KpiCard title="Sales Count" value={fmtNum(counts.salesCount)} tone="sky" />
            <KpiCard title="Purchase Order Count" value={fmtNum(counts.purchaseCount)} tone="sky" />
            <KpiCard title="GRN Count" value={fmtNum(counts.grnCount)} tone="sky" />
            <KpiCard title="Inventory Count" value={fmtNum(counts.inventoryCount)} tone="violet" />
            <KpiCard title="Customs Count" value={fmtNum(counts.customsCount)} tone="violet" />
            <KpiCard title="Customer Count" value={fmtNum(counts.customerCount)} tone="slate" />
            <KpiCard title="Supplier Count" value={fmtNum(counts.supplierCount)} tone="slate" />
            <KpiCard title="Article Count" value={fmtNum(counts.articleCount)} tone="slate" />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <div className="rounded-2xl border bg-white p-4 shadow-sm">
              <h2 className="mb-2 text-sm font-semibold text-slate-800">Issues by Module</h2>
              <BarList items={(charts.byModule || []).map((x) => ({ label: x.module, count: x.count }))} />
            </div>
            <div className="rounded-2xl border bg-white p-4 shadow-sm">
              <h2 className="mb-2 text-sm font-semibold text-slate-800">Issues by Severity</h2>
              <BarList items={(charts.bySeverity || []).map((x) => ({ label: x.severity, count: x.count }))} />
            </div>
            <div className="rounded-2xl border bg-white p-4 shadow-sm">
              <h2 className="mb-2 text-sm font-semibold text-slate-800">Issues by Month</h2>
              <BarList items={(charts.byMonth || []).map((x) => ({ label: x.month, count: x.count }))} />
            </div>
            <div className="rounded-2xl border bg-white p-4 shadow-sm">
              <h2 className="mb-2 text-sm font-semibold text-slate-800">Top Problem Areas</h2>
              <BarList items={(charts.topProblemAreas || []).map((x) => ({ label: x.issueType, count: x.count }))} />
            </div>
          </div>

          <div className="overflow-hidden rounded-2xl border bg-white shadow-sm">
            <div className="border-b px-4 py-2 text-sm font-semibold text-slate-800">
              Issue Table ({issues.length} shown)
            </div>
            <div className="overflow-x-auto">
              <table className="min-w-full text-left text-xs">
                <thead className="bg-slate-100 text-[11px] uppercase tracking-wide text-slate-600">
                  <tr>
                    {ISSUE_COLUMNS.map((c) => (
                      <th key={c.key} className="px-2 py-2 whitespace-nowrap">
                        {c.header}
                      </th>
                    ))}
                    <th className="px-2 py-2">Open</th>
                  </tr>
                </thead>
                <tbody>
                  {!issues.length ? (
                    <tr>
                      <td colSpan={ISSUE_COLUMNS.length + 1} className="px-3 py-8 text-center text-emerald-700">
                        No issues detected for current filters.
                      </td>
                    </tr>
                  ) : (
                    issues.map((row, i) => (
                      <tr key={`${row.checkId}-${row.documentNumber}-${i}`} className="border-t hover:bg-slate-50">
                        <td className="px-2 py-1.5">
                          <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ring-1 ${severityTone(row.severity)}`}>{row.severity}</span>
                        </td>
                        <td className="px-2 py-1.5">{row.module}</td>
                        <td className="px-2 py-1.5 font-mono text-[10px]">{row.issueType}</td>
                        <td className="px-2 py-1.5">{row.documentNumber}</td>
                        <td className="px-2 py-1.5">{row.reference}</td>
                        <td className="px-2 py-1.5 max-w-xs">{row.description}</td>
                        <td className="px-2 py-1.5 max-w-xs">{row.suggestedAction}</td>
                        <td className="px-2 py-1.5">
                          {row.openPath ? (
                            <Link to={row.openPath} className="font-semibold text-sky-700 underline">
                              Open
                            </Link>
                          ) : (
                            "—"
                          )}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <p className="text-xs text-slate-500">
            Company <strong>{currentCompany}</strong> · Last audit run {fmtDateTime(data?.lastAuditRun || data?.generatedAt)}
            {data?.fromCache ? " · Served from cache" : ""} · Read-only scan (no data modified)
          </p>
        </div>
      )}
    </div>
  );
}
