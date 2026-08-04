import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import PageHeader from "../components/erp/PageHeader.jsx";
import { apiGetWithQuery, apiPost } from "../lib/api.js";
import { notify } from "../lib/notifications.js";

function n(v) {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
}

function fmt(v) {
  return n(v).toLocaleString(undefined, { maximumFractionDigits: 3 });
}

function severityTone(s) {
  if (s === "Critical") return "bg-rose-50 text-rose-800 ring-rose-200";
  if (s === "Major") return "bg-amber-50 text-amber-900 ring-amber-200";
  if (s === "Minor") return "bg-slate-50 text-slate-700 ring-slate-200";
  if (s === "RESOLVED" || s === "Healthy") return "bg-emerald-50 text-emerald-800 ring-emerald-200";
  return "bg-slate-50 text-slate-700 ring-slate-200";
}

function Kpi({ title, value, tone = "slate" }) {
  const tones = {
    slate: "text-slate-900",
    emerald: "text-emerald-700",
    amber: "text-amber-700",
    rose: "text-rose-700",
  };
  return (
    <div className="rounded-xl border bg-white p-3 shadow-sm">
      <div className="text-xs font-medium uppercase tracking-wide text-slate-500">{title}</div>
      <div className={`mt-1 text-xl font-semibold tabular-nums ${tones[tone] || tones.slate}`}>{value}</div>
    </div>
  );
}

export default function ReservationIntegrity() {
  const [searchParams, setSearchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const [warehouse, setWarehouse] = useState(searchParams.get("warehouse") || "");
  const [article, setArticle] = useState(searchParams.get("article") || "");
  const [issueType, setIssueType] = useState(searchParams.get("issueType") || "");
  const [severity, setSeverity] = useState(searchParams.get("severity") || "");
  const [status, setStatus] = useState(searchParams.get("status") || "OPEN");
  const [detail, setDetail] = useState(null);

  const queryParams = useMemo(
    () => ({
      warehouse: warehouse || undefined,
      article: article || undefined,
      issueType: issueType || undefined,
      severity: severity || undefined,
      status: status || "OPEN",
      limit: 200,
      page: 1,
      liveScan: "false",
    }),
    [warehouse, article, issueType, severity, status]
  );

  const listQ = useQuery({
    queryKey: ["reservation-integrity", queryParams],
    queryFn: () => apiGetWithQuery("/admin/stock/reservation-integrity", queryParams),
  });

  const validateMut = useMutation({
    mutationFn: (body) => apiPost("/admin/stock/reservation-integrity/validate", body),
    onSuccess: (data) => {
      notify.success(
        data.summary
          ? `Validation complete: ${data.summary.mismatchRows} mismatch row(s), ${data.summary.issueCount} issue(s)`
          : data.ok
            ? "Article healthy"
            : `${(data.issues || []).length} issue(s) found`
      );
      queryClient.invalidateQueries({ queryKey: ["reservation-integrity"] });
    },
    onError: (e) => notify.error(e.message || "Validation failed"),
  });

  const summary = listQ.data?.summary || {};
  const items = listQ.data?.items || [];

  const applyFilters = () => {
    const next = new URLSearchParams();
    if (warehouse) next.set("warehouse", warehouse);
    if (article) next.set("article", article);
    if (issueType) next.set("issueType", issueType);
    if (severity) next.set("severity", severity);
    if (status) next.set("status", status);
    setSearchParams(next);
  };

  const exportCsv = () => {
    window.open(
      `/api/admin/stock/reservation-integrity?${new URLSearchParams({
        ...Object.fromEntries(
          Object.entries(queryParams).filter(([, v]) => v != null && v !== "")
        ),
        format: "csv",
      }).toString()}`,
      "_blank"
    );
  };

  const runValidateAll = () => {
    validateMut.mutate({ all: true, warehouse: warehouse || undefined, includeHealthy: false });
  };

  const viewRow = async (row) => {
    try {
      const data = await apiGetWithQuery(
        `/admin/stock/reservation-integrity/article/${encodeURIComponent(row.article)}`,
        { warehouse: row.warehouse || "MAIN" }
      );
      setDetail({ row, data });
    } catch (e) {
      notify.error(e.message || "Failed to load detail");
    }
  };

  return (
    <div className="p-4 md:p-6">
      <PageHeader
        title="Reservation Integrity"
        subtitle="Expected reserved/packed are always calculated from live Order Allocation and Packing documents — StockBalance buckets are never trusted blindly."
      >
        <div className="flex flex-wrap gap-2">
          <Link
            to="/dashboard/data-health"
            className="rounded-lg border px-3 py-2 text-sm font-semibold hover:bg-slate-50"
          >
            Data Health
          </Link>
          <Link
            to="/dashboard/stock-bucket-integrity"
            className="rounded-lg border px-3 py-2 text-sm font-semibold hover:bg-slate-50"
          >
            Stock Bucket Integrity
          </Link>
          <button
            type="button"
            className="rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-sm font-semibold text-sky-800"
            onClick={() => listQ.refetch()}
            disabled={listQ.isFetching}
          >
            {listQ.isFetching ? "Refreshing…" : "Refresh"}
          </button>
          <button
            type="button"
            className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm font-semibold text-emerald-900"
            onClick={runValidateAll}
            disabled={validateMut.isPending}
          >
            {validateMut.isPending ? "Validating…" : "Run Validation"}
          </button>
          <button type="button" className="rounded-lg border px-3 py-2 text-sm font-semibold" onClick={exportCsv}>
            Export
          </button>
        </div>
      </PageHeader>

      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Kpi title="Open issues" value={fmt(summary.openCount)} tone="rose" />
        <Kpi title="Critical" value={fmt(summary.openBySeverity?.Critical)} tone="rose" />
        <Kpi title="Major" value={fmt(summary.openBySeverity?.Major)} tone="amber" />
        <Kpi title="Health impact (−pts)" value={fmt(summary.openHealthImpact)} tone="amber" />
      </div>

      <div className="mb-4 rounded-2xl border bg-white p-4 shadow-sm">
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-6">
          <label className="flex flex-col gap-1 text-xs">
            <span className="font-medium text-slate-600">Warehouse</span>
            <input
              className="rounded-lg border px-2 py-2 text-sm"
              value={warehouse}
              onChange={(e) => setWarehouse(e.target.value)}
              placeholder="MAIN"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs">
            <span className="font-medium text-slate-600">Article</span>
            <input
              className="rounded-lg border px-2 py-2 text-sm"
              value={article}
              onChange={(e) => setArticle(e.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1 text-xs">
            <span className="font-medium text-slate-600">Issue type</span>
            <select
              className="rounded-lg border px-2 py-2 text-sm"
              value={issueType}
              onChange={(e) => setIssueType(e.target.value)}
            >
              <option value="">All</option>
              <option value="ORPHAN_RESERVED_QTY">ORPHAN_RESERVED_QTY</option>
              <option value="RESERVED_QTY_MISMATCH">RESERVED_QTY_MISMATCH</option>
              <option value="PACKED_QTY_MISMATCH">PACKED_QTY_MISMATCH</option>
              <option value="AVAILABLE_QTY_MISMATCH">AVAILABLE_QTY_MISMATCH</option>
              <option value="NEGATIVE_RESERVED">NEGATIVE_RESERVED</option>
              <option value="NEGATIVE_PACKED">NEGATIVE_PACKED</option>
              <option value="ALLOCATED_WITHOUT_DOCUMENT">ALLOCATED_WITHOUT_DOCUMENT</option>
              <option value="PACKED_WITHOUT_DOCUMENT">PACKED_WITHOUT_DOCUMENT</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs">
            <span className="font-medium text-slate-600">Severity</span>
            <select
              className="rounded-lg border px-2 py-2 text-sm"
              value={severity}
              onChange={(e) => setSeverity(e.target.value)}
            >
              <option value="">All</option>
              <option value="Critical">Critical</option>
              <option value="Major">Major</option>
              <option value="Minor">Minor</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs">
            <span className="font-medium text-slate-600">Status</span>
            <select
              className="rounded-lg border px-2 py-2 text-sm"
              value={status}
              onChange={(e) => setStatus(e.target.value)}
            >
              <option value="OPEN">OPEN</option>
              <option value="RESOLVED">RESOLVED</option>
              <option value="ALL">ALL</option>
            </select>
          </label>
          <div className="flex items-end">
            <button
              type="button"
              className="w-full rounded-lg bg-slate-900 px-3 py-2 text-sm font-semibold text-white"
              onClick={applyFilters}
            >
              Apply filters
            </button>
          </div>
        </div>
      </div>

      <div className="overflow-x-auto rounded-2xl border bg-white shadow-sm">
        <table className="min-w-full text-left text-sm">
          <thead className="border-b bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-3 py-2">Article</th>
              <th className="px-3 py-2">Warehouse</th>
              <th className="px-3 py-2 text-right">On Hand</th>
              <th className="px-3 py-2 text-right">Reserved</th>
              <th className="px-3 py-2 text-right">Exp. Reserved</th>
              <th className="px-3 py-2 text-right">Packed</th>
              <th className="px-3 py-2 text-right">Exp. Packed</th>
              <th className="px-3 py-2 text-right">Available</th>
              <th className="px-3 py-2 text-right">Exp. Available</th>
              <th className="px-3 py-2 text-right">Diff</th>
              <th className="px-3 py-2">Issue</th>
              <th className="px-3 py-2">Severity</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">Last Checked</th>
              <th className="px-3 py-2">Actions</th>
            </tr>
          </thead>
          <tbody>
            {listQ.isLoading ? (
              <tr>
                <td colSpan={15} className="px-3 py-8 text-center text-slate-500">
                  Loading…
                </td>
              </tr>
            ) : items.length === 0 ? (
              <tr>
                <td colSpan={15} className="px-3 py-8 text-center text-slate-500">
                  No issues. Click <strong>Run Validation</strong> to scan all stock.
                </td>
              </tr>
            ) : (
              items.map((row) => (
                <tr key={row._id || row.fingerprint} className="border-b last:border-0 hover:bg-slate-50/80">
                  <td className="px-3 py-2 font-medium">{row.article}</td>
                  <td className="px-3 py-2">{row.warehouse}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{fmt(row.onHandQty)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{fmt(row.reservedQty)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{fmt(row.expectedReservedQty)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{fmt(row.packedQty)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{fmt(row.expectedPackedQty)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{fmt(row.availableQty)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{fmt(row.expectedAvailableQty)}</td>
                  <td className="px-3 py-2 text-right tabular-nums font-medium">{fmt(row.difference)}</td>
                  <td className="px-3 py-2 text-xs">{row.issueType}</td>
                  <td className="px-3 py-2">
                    <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ring-1 ${severityTone(row.severity)}`}>
                      {row.severity}
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ring-1 ${severityTone(row.status)}`}>
                      {row.status}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-xs text-slate-600">
                    {row.lastCheckedAt ? new Date(row.lastCheckedAt).toLocaleString() : "—"}
                  </td>
                  <td className="px-3 py-2">
                    <button
                      type="button"
                      className="text-sm font-semibold text-sky-700 hover:underline"
                      onClick={() => viewRow(row)}
                    >
                      View
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {detail ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="max-h-[90vh] w-full max-w-3xl overflow-auto rounded-2xl border bg-white p-5 shadow-xl">
            <div className="mb-3 flex items-start justify-between gap-3">
              <div>
                <h3 className="text-lg font-semibold">
                  {detail.row.article} · {detail.row.warehouse}
                </h3>
                <p className="text-sm text-slate-600">{detail.row.issueType}</p>
              </div>
              <button
                type="button"
                className="rounded-lg border px-3 py-1.5 text-sm"
                onClick={() => setDetail(null)}
              >
                Close
              </button>
            </div>
            <p className="mb-3 text-sm text-slate-700">{detail.row.repairRecommendation}</p>
            <pre className="overflow-auto rounded-xl bg-slate-950 p-3 text-xs text-slate-100">
              {JSON.stringify(detail.data, null, 2)}
            </pre>
          </div>
        </div>
      ) : null}
    </div>
  );
}
