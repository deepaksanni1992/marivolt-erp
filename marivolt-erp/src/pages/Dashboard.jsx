import { useEffect, useState } from "react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  LineChart,
  Line,
} from "recharts";
import { apiGet } from "../lib/api.js";

function formatCurrency(value) {
  const n = Number(value);
  if (Number.isNaN(n)) return "0";
  return n.toLocaleString("en-IN", {
    maximumFractionDigits: 0,
    minimumFractionDigits: 0,
  });
}

export default function Dashboard() {
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setErr("");
      setLoading(true);
      try {
        const data = await apiGet("/dashboard/stats");
        if (!cancelled) setStats(data);
      } catch (e) {
        if (!cancelled) setErr(e.message || "Failed to load dashboard");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, []);

  if (loading && !stats) {
    return (
      <div className="rounded-2xl border bg-white p-6">
        <h1 className="text-xl font-semibold">Dashboard</h1>
        <p className="mt-4 text-gray-500">Loading...</p>
      </div>
    );
  }

  if (err && !stats) {
    return (
      <div className="rounded-2xl border bg-white p-6">
        <h1 className="text-xl font-semibold">Dashboard</h1>
        <p className="mt-4 text-red-600">{err}</p>
      </div>
    );
  }

  const s = stats || {
    purchaseExpense: 0,
    salesOrderValue: 0,
    logisticsExpense: 0,
    totalProfit: 0,
    byMonth: [],
  };

  const summaryData = [
    { name: "Purchase", value: s.purchaseExpense, fill: "#64748b" },
    { name: "Sales", value: s.salesOrderValue, fill: "#0f766e" },
    { name: "Logistics", value: s.logisticsExpense, fill: "#b45309" },
    { name: "Profit", value: Math.max(0, s.totalProfit), fill: "#15803d" },
  ].filter((d) => d.value > 0);

  if (summaryData.length === 0) {
    summaryData.push(
      { name: "Purchase", value: 0, fill: "#64748b" },
      { name: "Sales", value: 0, fill: "#0f766e" },
      { name: "Logistics", value: 0, fill: "#b45309" },
      { name: "Profit", value: 0, fill: "#15803d" }
    );
  }

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border bg-white p-6">
        <h1 className="text-xl font-semibold">Dashboard</h1>
        <p className="mt-1 text-gray-600">Overview of purchase, sales, logistics and profit</p>
      </div>

      {/* KPI cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <p className="text-sm font-medium text-slate-500">Purchase expense</p>
          <p className="mt-1 text-2xl font-semibold text-slate-800">
            {formatCurrency(s.purchaseExpense)}
          </p>
        </div>
        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <p className="text-sm font-medium text-slate-500">Sales order value</p>
          <p className="mt-1 text-2xl font-semibold text-teal-800">
            {formatCurrency(s.salesOrderValue)}
          </p>
        </div>
        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <p className="text-sm font-medium text-slate-500">Logistics expense</p>
          <p className="mt-1 text-2xl font-semibold text-amber-800">
            {formatCurrency(s.logisticsExpense)}
          </p>
        </div>
        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <p className="text-sm font-medium text-slate-500">Total profit</p>
          <p className={`mt-1 text-2xl font-semibold ${s.totalProfit >= 0 ? "text-green-800" : "text-red-700"}`}>
            {formatCurrency(s.totalProfit)}
          </p>
        </div>
      </div>

      {/* Bar chart: summary */}
      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="text-base font-semibold text-slate-800">Summary (all time)</h2>
        <div className="mt-4 h-64">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={summaryData} margin={{ top: 8, right: 16, left: 0, bottom: 8 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
              <XAxis dataKey="name" tick={{ fontSize: 12 }} stroke="#64748b" />
              <YAxis tick={{ fontSize: 12 }} stroke="#64748b" tickFormatter={formatCurrency} />
              <Tooltip formatter={(v) => formatCurrency(v)} />
              <Bar dataKey="value" name="Amount" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Monthly trend: last 6 months */}
      {s.byMonth && s.byMonth.length > 0 && (
        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <h2 className="text-base font-semibold text-slate-800">Monthly trend (last 6 months)</h2>
          <div className="mt-4 h-72">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart
                data={s.byMonth}
                margin={{ top: 8, right: 16, left: 0, bottom: 8 }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                <XAxis dataKey="monthLabel" tick={{ fontSize: 11 }} stroke="#64748b" />
                <YAxis tick={{ fontSize: 11 }} stroke="#64748b" tickFormatter={formatCurrency} />
                <Tooltip formatter={(v) => formatCurrency(v)} />
                <Legend />
                <Line type="monotone" dataKey="purchase" name="Purchase" stroke="#64748b" strokeWidth={2} dot={{ r: 4 }} />
                <Line type="monotone" dataKey="sales" name="Sales" stroke="#0f766e" strokeWidth={2} dot={{ r: 4 }} />
                <Line type="monotone" dataKey="logistics" name="Logistics" stroke="#b45309" strokeWidth={2} dot={{ r: 4 }} />
                <Line type="monotone" dataKey="profit" name="Profit" stroke="#15803d" strokeWidth={2} dot={{ r: 4 }} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {/* Monthly bars: same 6 months as stacked or grouped */}
      {s.byMonth && s.byMonth.length > 0 && (
        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <h2 className="text-base font-semibold text-slate-800">Monthly comparison</h2>
          <div className="mt-4 h-72">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={s.byMonth} margin={{ top: 8, right: 16, left: 0, bottom: 8 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                <XAxis dataKey="monthLabel" tick={{ fontSize: 11 }} stroke="#64748b" />
                <YAxis tick={{ fontSize: 11 }} stroke="#64748b" tickFormatter={formatCurrency} />
                <Tooltip formatter={(v) => formatCurrency(v)} />
                <Legend />
                <Bar dataKey="purchase" name="Purchase" fill="#64748b" radius={[4, 4, 0, 0]} />
                <Bar dataKey="sales" name="Sales" fill="#0f766e" radius={[4, 4, 0, 0]} />
                <Bar dataKey="logistics" name="Logistics" fill="#b45309" radius={[4, 4, 0, 0]} />
                <Bar dataKey="profit" name="Profit" fill="#15803d" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}
    </div>
  );
}
