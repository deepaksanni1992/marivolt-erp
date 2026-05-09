import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AUTH_KEY, apiGetWithQuery } from "../lib/api.js";
import { downloadCsv, downloadPdfTable } from "../lib/purchaseExport.js";
import Modal from "../components/erp/Modal.jsx";

function getUserLabel() {
  try {
    const auth = JSON.parse(localStorage.getItem(AUTH_KEY) || "null");
    const u = auth?.user;
    if (!u) return "";
    return u.name || u.email || u.username || "";
  } catch {
    return "";
  }
}

export default function Dashboard() {
  const label = getUserLabel();
  const [tab, setTab] = useState("Overview");
  const [filters, setFilters] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("erp_bi_filters_v1") || "null");
      if (saved && typeof saved === "object") return saved;
    } catch {}
    return {
      company: "",
      branch: "",
      warehouse: "",
      dateFrom: "",
      dateTo: "",
      customer: "",
      supplier: "",
    };
  });
  const [drill, setDrill] = useState({ open: false, type: "", title: "", page: 1 });
  const [chartMode, setChartMode] = useState("line");
  useEffect(() => {
    localStorage.setItem("erp_bi_filters_v1", JSON.stringify(filters));
  }, [filters]);
  const dashboardFilters = useMemo(() => filters, [filters]);
  const dashboard = useQuery({
    queryKey: ["analytics-dashboard", dashboardFilters],
    queryFn: () => apiGetWithQuery("/analytics/dashboard", dashboardFilters),
  });
  const data = dashboard.data || {};
  const drillQuery = useQuery({
    queryKey: ["analytics-drilldown", drill.type, drill.page, dashboardFilters],
    queryFn: () => apiGetWithQuery(`/analytics/drilldown/${drill.type}`, { ...dashboardFilters, page: drill.page, limit: 20 }),
    enabled: drill.open && Boolean(drill.type),
  });

  const tabs = ["Overview", "Sales", "Inventory", "Procurement", "Accounts", "Logistics", "Kitting"];
  const trend = data?.trendIndicators || {};

  const card = (title, value, hint = "") => (
    <div className="rounded-xl border bg-white p-4">
      <div className="text-xs uppercase tracking-wide text-slate-500">{title}</div>
      <div className="mt-1 text-2xl font-semibold text-slate-900">{value}</div>
      {hint ? <div className="mt-1 text-xs text-slate-500">{hint}</div> : null}
    </div>
  );
  const indicator = (labelText, row = { deltaPct: 0 }) => (
    <span className={`inline-flex rounded-full px-2 py-0.5 text-xs ${Number(row.deltaPct || 0) >= 0 ? "bg-emerald-100 text-emerald-700" : "bg-rose-100 text-rose-700"}`}>
      {labelText}: {Number(row.deltaPct || 0).toFixed(1)}%
    </span>
  );

  function exportRows(fileBase, sectionRows, columns) {
    downloadCsv(`${fileBase}.csv`, columns, sectionRows);
    downloadPdfTable(fileBase, "", columns, sectionRows, fileBase);
  }

  function miniBars(series = [], color = "bg-slate-700") {
    const max = Math.max(1, ...series.map((x) => Number(x.value || 0)));
    return (
      <div className="space-y-1">
        {series.map((x) => (
          <div key={x.month} className="flex items-center gap-2 text-xs">
            <div className="w-16 text-slate-500">{x.month}</div>
            <div className="h-2 flex-1 rounded bg-slate-100">
              <div className={`h-2 rounded ${color}`} style={{ width: `${Math.max(2, (Number(x.value || 0) / max) * 100)}%` }} />
            </div>
            <div className="w-16 text-right tabular-nums">{Number(x.value || 0).toFixed(0)}</div>
          </div>
        ))}
      </div>
    );
  }

  function lineChart(series = [], tone = "#334155", area = false) {
    const w = 520;
    const h = 160;
    const values = series.map((x) => Number(x.value || 0));
    const max = Math.max(1, ...values);
    const min = Math.min(0, ...values);
    const range = Math.max(1, max - min);
    const points = series.map((x, i) => {
      const px = (i / Math.max(1, series.length - 1)) * (w - 20) + 10;
      const py = h - 20 - ((Number(x.value || 0) - min) / range) * (h - 40);
      return [px, py];
    });
    const polyline = points.map((p) => `${p[0]},${p[1]}`).join(" ");
    const areaPath = points.length
      ? `M ${points[0][0]} ${h - 20} L ${points.map((p) => `${p[0]} ${p[1]}`).join(" L ")} L ${points[points.length - 1][0]} ${h - 20} Z`
      : "";
    return (
      <svg viewBox={`0 0 ${w} ${h}`} className="h-40 w-full rounded border bg-white">
        <line x1="10" y1={h - 20} x2={w - 10} y2={h - 20} stroke="#e2e8f0" />
        <line x1="10" y1="20" x2="10" y2={h - 20} stroke="#e2e8f0" />
        {area && areaPath ? <path d={areaPath} fill={tone} opacity="0.2" /> : null}
        <polyline fill="none" stroke={tone} strokeWidth="2.5" points={polyline} />
      </svg>
    );
  }

  function stackedBars(a = [], b = []) {
    const rows = a.map((x, i) => ({ month: x.month, a: Number(x.value || 0), b: Number(b[i]?.value || 0) }));
    const max = Math.max(1, ...rows.map((r) => r.a + r.b));
    return (
      <div className="space-y-1">
        {rows.map((r) => (
          <div key={r.month} className="flex items-center gap-2 text-xs">
            <div className="w-16 text-slate-500">{r.month}</div>
            <div className="h-3 flex-1 overflow-hidden rounded bg-slate-100">
              <div className="flex h-3">
                <div className="bg-emerald-500" style={{ width: `${((r.a / max) * 100).toFixed(2)}%` }} />
                <div className="bg-amber-500" style={{ width: `${((r.b / max) * 100).toFixed(2)}%` }} />
              </div>
            </div>
          </div>
        ))}
      </div>
    );
  }

  const skeleton = (
    <div className="grid gap-3 md:grid-cols-4">
      {Array.from({ length: 8 }).map((_, i) => <div key={i} className="h-20 animate-pulse rounded-xl border bg-slate-100" />)}
    </div>
  );

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border bg-white p-6">
        <h1 className="text-2xl font-semibold">ERP BI Dashboard</h1>
        <p className="mt-1 text-sm text-slate-600">
          Management-level visibility across Sales, Inventory, Procurement, Accounts, Logistics, and Kitting
          {label ? ` · ${label}` : ""}.
        </p>
      </div>
      <div className="rounded-2xl border bg-white p-4">
        <div className="grid gap-2 md:grid-cols-4 xl:grid-cols-7">
          {["company", "branch", "warehouse", "customer", "supplier", "dateFrom", "dateTo"].map((k) => (
            <input
              key={k}
              type={k.startsWith("date") ? "date" : "text"}
              className="rounded border px-3 py-2 text-sm"
              placeholder={k}
              value={filters[k]}
              onChange={(e) => setFilters((s) => ({ ...s, [k]: e.target.value }))}
            />
          ))}
        </div>
        <div className="mt-2 flex flex-wrap gap-2">
          {indicator("Sales", trend.monthlySales)}
          {indicator("Procurement", trend.monthlyProcurement)}
          {indicator("Inventory IN", trend.inventoryMovementIn)}
          {indicator("AR", trend.receivableTrend)}
          {indicator("AP", trend.payableTrend)}
        </div>
      </div>

      <div className="flex flex-wrap gap-2 rounded-2xl border bg-white p-2">
        {tabs.map((x) => (
          <button
            key={x}
            type="button"
            onClick={() => setTab(x)}
            className={tab === x ? "rounded-lg bg-slate-900 px-3 py-2 text-sm text-white" : "rounded-lg px-3 py-2 text-sm hover:bg-slate-100"}
          >
            {x}
          </button>
        ))}
      </div>

      {dashboard.isLoading ? skeleton : null}

      {tab === "Overview" && !dashboard.isLoading ? (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          {card("Sales Amount", Number(data.sales?.kpis?.salesAmount || 0).toFixed(2), "Current filtered period")}
          {card("Pending PO Value", Number(data.procurement?.kpis?.pendingPoValue || 0).toFixed(2), "Open procurement commitments")}
          {card("Stock Valuation", Number(data.inventory?.kpis?.stockValuation || 0).toFixed(2), "Inventory value")}
          <button type="button" className="text-left" onClick={() => setDrill({ open: true, type: "negative-stock", title: "Negative Stock Items", page: 1 })}>
            {card("Negative Stock Items", data.inventory?.kpis?.negativeStockCount || 0, "Replenishment risk")}
          </button>
          {card("AR Outstanding", Number(data.accounts?.kpis?.arOutstanding || 0).toFixed(2))}
          {card("AP Outstanding", Number(data.accounts?.kpis?.apOutstanding || 0).toFixed(2))}
          <button type="button" className="text-left" onClick={() => setDrill({ open: true, type: "delayed-shipments", title: "Delayed Shipments", page: 1 })}>
            {card("Delayed Shipments", data.logistics?.kpis?.delayedShipmentCount || 0)}
          </button>
          {card("Completed Kits", data.kitting?.kpis?.completedKits || 0)}
        </div>
      ) : null}

      {tab === "Sales" ? (
        <div className="grid gap-3 lg:grid-cols-2">
          <div className="rounded-xl border bg-white p-4">
            <div className="mb-2 flex items-center justify-between">
              <div className="text-sm font-semibold">Monthly Sales Trend</div>
              <div className="flex gap-1">
                <button type="button" className={`rounded border px-2 py-1 text-[10px] ${chartMode === "line" ? "bg-slate-900 text-white" : ""}`} onClick={() => setChartMode("line")}>Line</button>
                <button type="button" className={`rounded border px-2 py-1 text-[10px] ${chartMode === "area" ? "bg-slate-900 text-white" : ""}`} onClick={() => setChartMode("area")}>Area</button>
              </div>
              <button
                type="button"
                className="rounded border px-2 py-1 text-xs"
                onClick={() =>
                  exportRows("sales-trend", data.sales?.trends?.monthlySales || [], [
                    { key: "month", header: "Month" },
                    { key: "value", header: "Sales" },
                  ])
                }
              >
                Export CSV/PDF
              </button>
            </div>
            {chartMode === "line"
              ? lineChart(data.sales?.trends?.monthlySales || [], "#4f46e5")
              : lineChart(data.sales?.trends?.monthlySales || [], "#4f46e5", true)}
            <div className="mt-1 text-[11px] text-slate-500">Legend: sales amount by month</div>
          </div>
          <div className="rounded-xl border bg-white p-4">
            <div className="mb-2 text-sm font-semibold">Top Customers</div>
            <div className="space-y-1 text-xs">
              {(data.sales?.topCustomers || []).map((r) => (
                <div key={r._id} className="flex justify-between border-b py-1">
                  <span>{r._id || "Unknown"}</span>
                  <span>{Number(r.value || 0).toFixed(2)}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      ) : null}

      {tab === "Inventory" ? (
        <div className="space-y-3">
          <div className="flex justify-end">
            <button
              type="button"
              className="rounded border px-2 py-1 text-xs"
              onClick={() =>
                exportRows(
                  "inventory-top-moving",
                  data.inventory?.topMovingArticles || [],
                  [
                    { key: "_id", header: "Article" },
                    { key: "movedQty", header: "Moved Qty" },
                  ]
                )
              }
            >
              Export CSV/PDF
            </button>
          </div>
          <div className="grid gap-3 md:grid-cols-5">
            {card("Stock Valuation", Number(data.inventory?.kpis?.stockValuation || 0).toFixed(2))}
            {card("On Hand", Number(data.inventory?.kpis?.onHandQty || 0).toFixed(0))}
            {card("Negative Stock", data.inventory?.kpis?.negativeStockCount || 0)}
            {card("Dead Stock", data.inventory?.kpis?.deadStockCount || 0)}
            {card("Fast Moving", data.inventory?.kpis?.fastMovingCount || 0)}
          </div>
          <div className="grid gap-3 lg:grid-cols-2">
            <div className="rounded-xl border bg-white p-4">
              <div className="mb-2 text-sm font-semibold">Inventory Movement (IN)</div>
              {stackedBars(data.inventory?.trends?.inventoryMovementIn || [], data.inventory?.trends?.inventoryMovementOut || [])}
              <div className="mt-1 text-[11px] text-slate-500">Legend: green=in, amber=out</div>
            </div>
            <div className="rounded-xl border bg-white p-4">
              <div className="mb-2 text-sm font-semibold">Top Moving Articles</div>
              <div className="space-y-1 text-xs">
                {(data.inventory?.topMovingArticles || []).map((r) => (
                  <div key={r._id} className="flex justify-between border-b py-1">
                    <span>{r._id}</span>
                    <span>{Number(r.movedQty || 0).toFixed(2)}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {tab === "Procurement" ? (
        <div className="space-y-3">
          <div className="flex justify-end">
            <button
              type="button"
              className="rounded border px-2 py-1 text-xs"
              onClick={() =>
                exportRows("procurement-suppliers", data.procurement?.supplierPerformance || [], [
                  { key: "_id", header: "Supplier" },
                  { key: "totalPo", header: "Total PO" },
                  { key: "delayed", header: "Delayed" },
                  { key: "value", header: "PO Value" },
                ])
              }
            >
              Export CSV/PDF
            </button>
          </div>
          <div className="grid gap-3 md:grid-cols-4">
            {card("Pending PO Value", Number(data.procurement?.kpis?.pendingPoValue || 0).toFixed(2))}
            {card("Open POs", data.procurement?.kpis?.openPoCount || 0)}
            {card("Landed Cost Impact", Number(data.procurement?.landedCostImpact || 0).toFixed(2))}
            {card("Delayed Suppliers", (data.procurement?.delayedSuppliers || []).length)}
          </div>
          <div className="grid gap-3 lg:grid-cols-2">
            <div className="rounded-xl border bg-white p-4">
              <div className="mb-2 text-sm font-semibold">Monthly Procurement</div>
              {lineChart(data.procurement?.trends?.monthlyProcurement || [], "#d97706", true)}
            </div>
            <div className="rounded-xl border bg-white p-4">
              <div className="mb-2 text-sm font-semibold">Supplier Performance</div>
              <div className="space-y-1 text-xs">
                {(data.procurement?.supplierPerformance || []).map((r) => (
                  <div key={r._id} className="grid grid-cols-4 gap-2 border-b py-1">
                    <span className="col-span-2">{r._id || "Unknown"}</span>
                    <span>PO: {r.totalPo || 0}</span>
                    <span>Delayed: {r.delayed || 0}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {tab === "Accounts" ? (
        <div className="grid gap-3 lg:grid-cols-2">
          <div className="lg:col-span-2 flex justify-end">
            <button
              type="button"
              className="rounded border px-2 py-1 text-xs"
              onClick={() =>
                exportRows("accounts-overdue-customers", data.accounts?.overdueCustomers || [], [
                  { key: "customerName", header: "Customer" },
                  { key: "balanceAmount", header: "Balance" },
                  { key: "daysOverdue", header: "Days Overdue" },
                ])
              }
            >
              Export CSV/PDF
            </button>
          </div>
          <div className="rounded-xl border bg-white p-4">
            <div className="text-sm font-semibold">AR Ageing Summary</div>
            <div className="mt-2 grid grid-cols-3 gap-2 text-xs">
              {Object.entries(data.accounts?.arAgeingSummary || {}).map(([k, v]) => <div key={k} className="rounded border p-2">{k}: {Number(v || 0).toFixed(2)}</div>)}
            </div>
            <div className="mt-2 text-[11px] text-slate-500">Ageing visual: current, 0-30, 31-60, 61-90, 90+</div>
          </div>
          <div className="rounded-xl border bg-white p-4">
            <div className="text-sm font-semibold">AP Ageing Summary</div>
            <div className="mt-2 grid grid-cols-3 gap-2 text-xs">
              {Object.entries(data.accounts?.apAgeingSummary || {}).map(([k, v]) => <div key={k} className="rounded border p-2">{k}: {Number(v || 0).toFixed(2)}</div>)}
            </div>
          </div>
          <div className="rounded-xl border bg-white p-4">
            <div className="mb-2 text-sm font-semibold">Cash Collection Trend</div>
            {miniBars(data.accounts?.trends?.cashCollectionTrend || [], "bg-sky-600")}
          </div>
          <div className="rounded-xl border bg-white p-4">
            <div className="text-sm font-semibold">Overdue Customers / Suppliers</div>
            <div className="mt-2 max-h-60 overflow-auto text-xs">
              {(data.accounts?.overdueCustomers || []).slice(0, 5).map((r, i) => (
                <button key={`c-${i}`} type="button" className="block w-full border-b py-1 text-left" onClick={() => setDrill({ open: true, type: "overdue-invoices", title: "Overdue Invoices", page: 1 })}>{r.customerName}: {Number(r.balanceAmount || 0).toFixed(2)} ({r.daysOverdue}d)</button>
              ))}
              {(data.accounts?.overdueSuppliers || []).slice(0, 5).map((r, i) => (
                <div key={`s-${i}`} className="border-b py-1">{r.supplierName}: {Number(r.balanceAmount || 0).toFixed(2)} ({r.daysOverdue}d)</div>
              ))}
            </div>
          </div>
        </div>
      ) : null}

      {tab === "Logistics" ? (
        <div className="space-y-3">
          <div className="flex justify-end">
            <button
              type="button"
              className="rounded border px-2 py-1 text-xs"
              onClick={() =>
                exportRows("logistics-status-summary", data.logistics?.shipmentStatusSummary || [], [
                  { key: "_id", header: "Status" },
                  { key: "count", header: "Count" },
                ])
              }
            >
              Export CSV/PDF
            </button>
          </div>
          <div className="grid gap-3 md:grid-cols-4">
            {card("Shipments", data.logistics?.kpis?.shipmentCount || 0)}
            {card("Delayed", data.logistics?.kpis?.delayedShipmentCount || 0)}
            {card("On-time %", Number(data.logistics?.kpis?.deliveryPerformancePct || 0).toFixed(2))}
            {card("Delivered", data.logistics?.deliveryPerformance?.deliveredCount || 0)}
          </div>
          <div className="grid gap-3 lg:grid-cols-2">
            <div className="rounded-xl border bg-white p-4">
              <div className="mb-2 text-sm font-semibold">Dispatch Trend</div>
              {lineChart(data.logistics?.trends?.dispatchTrend || [], "#7c3aed")}
            </div>
            <div className="rounded-xl border bg-white p-4">
              <div className="mb-2 text-sm font-semibold">Shipment Status Summary</div>
              <div className="space-y-1 text-xs">
                {(data.logistics?.shipmentStatusSummary || []).map((r) => (
                  <div key={r._id} className="flex justify-between border-b py-1"><span>{r._id}</span><span>{r.count}</span></div>
                ))}
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {tab === "Kitting" ? (
        <div className="grid gap-3 md:grid-cols-2">
          <div className="md:col-span-2 flex justify-end">
            <button
              type="button"
              className="rounded border px-2 py-1 text-xs"
              onClick={() =>
                exportRows(
                  "kitting-top-assembled",
                  Object.entries(data.kitting?.topAssembledItems || {}).map(([article, qty]) => ({ article, qty })),
                  [
                    { key: "article", header: "Article" },
                    { key: "qty", header: "Assembled Qty" },
                  ]
                )
              }
            >
              Export CSV/PDF
            </button>
          </div>
          <div className="rounded-xl border bg-white p-4">
            <div className="mb-2 text-sm font-semibold">Kitting Trend</div>
            {miniBars(data.kitting?.trends?.kittingTrend || [], "bg-teal-600")}
          </div>
          <div className="rounded-xl border bg-white p-4">
            <div className="mb-2 text-sm font-semibold">Top Assembled Items</div>
            <div className="max-h-64 overflow-auto text-xs">
              {Object.entries(data.kitting?.topAssembledItems || {})
                .sort((a, b) => Number(b[1]) - Number(a[1]))
                .slice(0, 20)
                .map(([article, qty]) => (
                  <div key={article} className="flex justify-between border-b py-1">
                    <span>{article}</span>
                    <span>{Number(qty).toFixed(2)}</span>
                  </div>
                ))}
            </div>
          </div>
        </div>
      ) : null}
      {!dashboard.isLoading && !Object.keys(data || {}).length ? (
        <div className="rounded-xl border bg-white p-6 text-center text-sm text-slate-500">
          No analytics data available for the selected filters.
        </div>
      ) : null}
      <Modal open={drill.open} onClose={() => setDrill({ open: false, type: "", title: "", page: 1 })} title={drill.title || "Drilldown"} wide>
        {drillQuery.isLoading ? (
          <div className="space-y-2">{Array.from({ length: 8 }).map((_, i) => <div key={i} className="h-8 animate-pulse rounded bg-slate-100" />)}</div>
        ) : (
          <div className="space-y-2">
            <div className="max-h-[55vh] overflow-auto rounded border">
              <table className="min-w-full text-xs">
                <thead className="bg-slate-50">
                  <tr>{Object.keys((drillQuery.data?.items || [])[0] || { value: "" }).map((k) => <th key={k} className="px-2 py-1 text-left">{k}</th>)}</tr>
                </thead>
                <tbody>
                  {(drillQuery.data?.items || []).map((row, i) => (
                    <tr key={i} className="border-t">{Object.keys((drillQuery.data?.items || [])[0] || { value: "" }).map((k) => <td key={k} className="px-2 py-1">{String(row[k] ?? "")}</td>)}</tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex justify-between">
              <button type="button" className="rounded border px-2 py-1 text-xs" disabled={drill.page <= 1} onClick={() => setDrill((s) => ({ ...s, page: s.page - 1 }))}>Prev</button>
              <div className="text-xs text-slate-600">Page {drill.page}</div>
              <button type="button" className="rounded border px-2 py-1 text-xs" disabled={(drillQuery.data?.items || []).length < 20} onClick={() => setDrill((s) => ({ ...s, page: s.page + 1 }))}>Next</button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
