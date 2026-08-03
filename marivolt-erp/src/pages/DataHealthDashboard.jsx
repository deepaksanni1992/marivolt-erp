import { useCallback, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import PageHeader from "../components/erp/PageHeader.jsx";
import { useAuth } from "../context/AuthContext.jsx";
import { apiGetWithQuery, apiPost } from "../lib/api.js";
import { downloadCsv, downloadExcelWorkbook, downloadPdfTable } from "../lib/purchaseExport.js";
import { notify } from "../lib/notifications.js";

const MODULES = ["", "Sales", "Purchase", "Inventory", "Customs", "Master Data", "Accounts"];
const SEVERITIES = ["", "Critical", "Major", "Minor", "Info"];
const SECTIONS = [
  { id: "", label: "All sections" },
  { id: "INTEGRITY", label: "ERP Integrity" },
  { id: "OPERATIONAL", label: "Operational Pending" },
  { id: "AGING", label: "Aging Monitor" },
];

const ISSUE_COLUMNS = [
  { key: "category", header: "Category" },
  { key: "severity", header: "Severity" },
  { key: "module", header: "Module" },
  { key: "issueType", header: "Issue Type" },
  { key: "pendingLabel", header: "Pending Label" },
  { key: "documentNumber", header: "Document Number" },
  { key: "reference", header: "Reference" },
  { key: "ageDays", header: "Age (days)" },
  { key: "description", header: "Description" },
  { key: "suggestedAction", header: "Suggested Action" },
];

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
  if (s === "Info") return "bg-sky-50 text-sky-800 ring-sky-200";
  return "bg-slate-50 text-slate-700 ring-slate-200";
}

function ratingTone(r) {
  if (r === "Healthy" || r === "Excellent") return "text-emerald-700";
  if (r === "Attention" || r === "Good") return "text-sky-700";
  if (r === "Poor" || r === "Warning") return "text-amber-700";
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
            <div className="w-40 truncate" title={x[labelKey]}>
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

function IssueTable({ rows = [], emptyMessage = "No rows." }) {
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-left text-xs">
        <thead className="bg-slate-100 text-[11px] uppercase tracking-wide text-slate-600">
          <tr>
            <th className="px-2 py-2">Severity</th>
            <th className="px-2 py-2">Type / Label</th>
            <th className="px-2 py-2">Document</th>
            <th className="px-2 py-2">Age</th>
            <th className="px-2 py-2">Description</th>
            <th className="px-2 py-2">Action</th>
            <th className="px-2 py-2">Open</th>
          </tr>
        </thead>
        <tbody>
          {!rows.length ? (
            <tr>
              <td colSpan={7} className="px-3 py-8 text-center text-emerald-700">
                {emptyMessage}
              </td>
            </tr>
          ) : (
            rows.map((row, i) => (
              <tr key={`${row.checkId}-${row.documentNumber}-${i}`} className="border-t hover:bg-slate-50">
                <td className="px-2 py-1.5">
                  <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ring-1 ${severityTone(row.severity)}`}>
                    {row.severity}
                  </span>
                </td>
                <td className="px-2 py-1.5">
                  <div className="font-mono text-[10px]">{row.issueType}</div>
                  {row.pendingLabel ? <div className="text-[11px] text-sky-800">{row.pendingLabel}</div> : null}
                </td>
                <td className="px-2 py-1.5">
                  {row.documentNumber}
                  {row.reference && row.reference !== "—" ? (
                    <div className="text-[10px] text-slate-500">{row.reference}</div>
                  ) : null}
                </td>
                <td className="px-2 py-1.5 tabular-nums">
                  {row.ageDays != null ? `${row.ageDays}d` : "—"}
                  {row.agingThresholdDays != null ? (
                    <div className="text-[10px] text-slate-400">thr {row.agingThresholdDays}d</div>
                  ) : null}
                </td>
                <td className="px-2 py-1.5 max-w-sm">{row.description}</td>
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
  );
}

export default function DataHealthDashboard() {
  const { auth, selectCompany } = useAuth();
  const queryClient = useQueryClient();
  const [module, setModule] = useState("");
  const [severity, setSeverity] = useState("");
  const [section, setSection] = useState("");
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
      section: section || undefined,
      documentNumber: documentNumber.trim() || undefined,
      article: article.trim() || undefined,
      customer: customer.trim() || undefined,
      supplier: supplier.trim() || undefined,
      dateFrom: dateFrom || undefined,
      dateTo: dateTo || undefined,
    }),
    [module, severity, section, documentNumber, article, customer, supplier, dateFrom, dateTo],
  );

  const healthQ = useQuery({
    queryKey: ["data-health", queryParams, auth?.company?.id],
    queryFn: () => apiGetWithQuery("/data-health", queryParams),
  });

  const data = healthQ.data;
  const counts = data?.counts || {};
  const charts = data?.charts || {};
  const integrityIssues = data?.integrityIssues || data?.sections?.integrity || [];
  const operationalPending = data?.operationalPending || data?.sections?.operationalPending || [];
  const agingMonitor = data?.agingMonitor || data?.sections?.agingMonitor || [];
  const operationalCounters = data?.operationalCounters || [];
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
    { metric: "Integrity Health Score", value: data?.healthScore },
    { metric: "Integrity Rating", value: data?.healthRating },
    { metric: "Integrity Critical", value: data?.criticalCount },
    { metric: "Integrity Major", value: data?.majorCount },
    { metric: "Integrity Minor", value: data?.minorCount },
    { metric: "Integrity Issues", value: data?.integrityIssueCount },
    { metric: "Operational Pending", value: data?.operationalIssueCount ?? data?.operationalPendingCount },
    { metric: "Aging Items", value: data?.agingIssueCount ?? data?.agingMonitorCount },
    { metric: "Aging Threshold Days", value: data?.agingThresholdDays },
    { metric: "Score Critical Penalties", value: data?.scoreBreakdown?.critical },
    { metric: "Score Major Penalties", value: data?.scoreBreakdown?.major },
    { metric: "Score Minor Penalties", value: data?.scoreBreakdown?.minor },
    { metric: "Score Penalty Points", value: data?.scoreBreakdown?.penaltyPoints },
  ];

  const exportCsv = async () => {
    setExporting(true);
    try {
      await logExport("csv");
      const rows = [...integrityIssues, ...operationalPending, ...agingMonitor];
      downloadCsv(`data-health-${currentCompany}-${Date.now()}.csv`, ISSUE_COLUMNS, rows);
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
        { name: "Integrity", columns: ISSUE_COLUMNS, rows: integrityIssues },
        { name: "Operational", columns: ISSUE_COLUMNS, rows: operationalPending },
        { name: "Aging", columns: ISSUE_COLUMNS, rows: agingMonitor },
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
      await downloadPdfTable(
        "Data Health Dashboard",
        `ERP Integrity Health — ${currentCompany}`,
        [{ key: "metric", header: "Metric" }, { key: "value", header: "Value" }],
        summaryRows(),
        base,
        auth?.company
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
        title="Data Health Dashboard"
        subtitle="Health Score reflects ERP Integrity only. Operational pending workflow states are informational and never reduce the score."
      >
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
            <span className="font-medium text-slate-600">Section</span>
            <select className="rounded-lg border px-2 py-2 text-sm" value={section} onChange={(e) => setSection(e.target.value)}>
              {SECTIONS.map((s) => (
                <option key={s.id || "all"} value={s.id}>
                  {s.label}
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
        <div className="space-y-6">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <KpiCard title="Integrity Health Score" value={data?.healthScore ?? "—"} hint="Integrity failures only (Critical −15 / Major −5 / Minor −1)" tone="emerald" />
            <div className="rounded-xl border bg-white p-3 shadow-sm">
              <div className="text-xs font-medium uppercase tracking-wide text-slate-500">Integrity Rating</div>
              <div className={`mt-1 text-xl font-semibold ${ratingTone(data?.healthRating)}`}>{data?.healthRating || "—"}</div>
              <div className="mt-1 text-xs text-slate-500">90+ Healthy · 75+ Attention · 50+ Poor · else Critical</div>
            </div>
            <KpiCard
              title="Integrity Issues"
              value={fmtNum(data?.integrityIssueCount)}
              tone="rose"
              hint={`${fmtNum(data?.criticalCount)} critical · ${fmtNum(data?.majorCount)} major · ${fmtNum(data?.minorCount)} minor`}
            />
            <Link
              to="/dashboard/stock-bucket-integrity"
              className="rounded-xl border bg-white p-3 shadow-sm hover:border-sky-300 hover:bg-sky-50"
            >
              <div className="text-xs font-medium uppercase tracking-wide text-slate-500">Stock Bucket Integrity</div>
              <div className="mt-1 text-sm font-semibold text-slate-900">
                {fmtNum(data?.stockBucketSummary?.mismatchCount ?? 0)} mismatch
                {(data?.stockBucketSummary?.criticalCount || 0) > 0
                  ? ` · ${fmtNum(data.stockBucketSummary.criticalCount)} critical`
                  : ""}
              </div>
              <div className="mt-1 text-xs text-slate-500">
                Open diagnostic · not affected by OA/PO pending · last {fmtDateTime(data?.stockBucketSummary?.lastScan || data?.lastAuditRun)}
              </div>
            </Link>
          </div>

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <KpiCard title="Operational Pending" value={fmtNum(data?.operationalIssueCount ?? data?.operationalPendingCount)} tone="sky" hint="Informational — not scored" />
            <KpiCard title="Aging Items" value={fmtNum(data?.agingIssueCount ?? data?.agingMonitorCount)} tone="amber" hint={`Threshold ${data?.agingThresholdDays ?? data?.agingDefaults?.defaultDays ?? 7} days · linked via sourceIssueId`} />
            <KpiCard title="Integrity Critical" value={fmtNum(data?.criticalCount)} tone="rose" hint="Integrity severity only" />
            <KpiCard title="Integrity Major" value={fmtNum(data?.majorCount)} tone="amber" hint="Integrity severity only" />
          </div>

          {/* Section 1 — ERP Integrity */}
          {(!section || section === "INTEGRITY") && (
            <section className="overflow-hidden rounded-2xl border border-rose-100 bg-white shadow-sm">
              <div className="border-b border-rose-100 bg-rose-50/60 px-4 py-3">
                <h2 className="text-sm font-semibold text-rose-900">1. ERP Integrity (Critical)</h2>
                <p className="text-xs text-rose-800/80">
                  Genuine data failures only — stock buckets, ledger, broken references, customs qty, duplicates, outstanding mismatches. These drive Health Score.
                </p>
              </div>
              <div className="grid gap-4 p-4 lg:grid-cols-2">
                <div>
                  <h3 className="mb-2 text-xs font-semibold uppercase text-slate-500">By severity</h3>
                  <BarList items={(charts.bySeverity || []).map((x) => ({ label: x.severity, count: x.count }))} />
                </div>
                <div>
                  <h3 className="mb-2 text-xs font-semibold uppercase text-slate-500">Top integrity types</h3>
                  <BarList items={(charts.topProblemAreas || []).map((x) => ({ label: x.issueType, count: x.count }))} />
                </div>
              </div>
              <IssueTable rows={integrityIssues} emptyMessage="No ERP integrity failures for current filters." />
            </section>
          )}

          {/* Section 2 — Operational Pending */}
          {(!section || section === "OPERATIONAL") && (
            <section className="overflow-hidden rounded-2xl border border-sky-100 bg-white shadow-sm">
              <div className="border-b border-sky-100 bg-sky-50/60 px-4 py-3">
                <h2 className="text-sm font-semibold text-sky-900">2. Operational Pending (Informational)</h2>
                <p className="text-xs text-sky-800/80">
                  Normal workflow states such as OA awaiting Allocation or PO awaiting GRN. Counters only — never reduce Health Score.
                </p>
              </div>
              <div className="p-4">
                <h3 className="mb-2 text-xs font-semibold uppercase text-slate-500">Pending counters</h3>
                <BarList
                  items={operationalCounters.map((x) => ({ label: x.label, count: x.count }))}
                />
              </div>
              <IssueTable rows={operationalPending} emptyMessage="No operational pending items for current filters." />
            </section>
          )}

          {/* Section 3 — Aging Monitor */}
          {(!section || section === "AGING") && (
            <section className="overflow-hidden rounded-2xl border border-amber-100 bg-white shadow-sm">
              <div className="border-b border-amber-100 bg-amber-50/60 px-4 py-3">
                <h2 className="text-sm font-semibold text-amber-900">3. Aging Monitor</h2>
                <p className="text-xs text-amber-800/80">
                  Operational pending items older than configurable thresholds (default {data?.agingDefaults?.defaultDays ?? 7} days). Informational — not scored.
                </p>
              </div>
              <IssueTable rows={agingMonitor} emptyMessage="No aged pending items for current filters." />
            </section>
          )}

          <p className="text-xs text-slate-500">
            Company <strong>{currentCompany}</strong> · Last audit run {fmtDateTime(data?.lastAuditRun || data?.generatedAt)}
            {data?.fromCache ? " · Served from cache" : ""} · Read-only scan (no data modified) · Health Score = integrity only
          </p>
        </div>
      )}
    </div>
  );
}
