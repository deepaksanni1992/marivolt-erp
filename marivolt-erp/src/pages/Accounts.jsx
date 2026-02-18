import { useEffect, useState } from "react";
import { apiGet, apiPost } from "../lib/api.js";

function formatCurrency(value) {
  const n = Number(value);
  if (Number.isNaN(n)) return "0";
  return n.toLocaleString("en-IN", {
    maximumFractionDigits: 0,
    minimumFractionDigits: 0,
  });
}

export default function Accounts() {
  const [summary, setSummary] = useState(null);
  const [transactions, setTransactions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [payingId, setPayingId] = useState(null);
  const [payAmount, setPayAmount] = useState("");
  const [payDate, setPayDate] = useState("");
  const [filterType, setFilterType] = useState("");

  async function load() {
    setErr("");
    setLoading(true);
    try {
      const [sum, txn] = await Promise.all([
        apiGet("/accounts/summary"),
        apiGet("/accounts/transactions"),
      ]);
      setSummary(sum);
      setTransactions(txn);
    } catch (e) {
      setErr(e.message || "Failed to load accounts");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function recordPayment(id, type, amount, date) {
    const num = Number(amount);
    if (!num || num <= 0) return;
    setErr("");
    try {
      if (type === "SALES") {
        await apiPost(`/accounts/sales/${id}/payment`, {
          amount: num,
          date: date || undefined,
        });
      } else if (type === "PURCHASE") {
        await apiPost(`/accounts/purchase/${id}/payment`, {
          amount: num,
          date: date || undefined,
        });
      }
      setPayingId(null);
      setPayAmount("");
      setPayDate("");
      await load();
    } catch (e) {
      setErr(e.message || "Failed to record payment");
    }
  }

  const filteredTxns =
    filterType === ""
      ? transactions
      : transactions.filter((t) => t.type === filterType);

  if (loading && !summary) {
    return (
      <div className="rounded-2xl border bg-white p-6">
        <h1 className="text-xl font-semibold">Accounts</h1>
        <p className="mt-4 text-gray-500">Loading...</p>
      </div>
    );
  }

  const s = summary || {
    revenue: 0,
    costOfGoods: 0,
    logisticsExpense: 0,
    grossProfit: 0,
    totalProfit: 0,
    receivables: 0,
    payables: 0,
  };

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border bg-white p-6">
        <h1 className="text-xl font-semibold">Accounts</h1>
        <p className="mt-1 text-gray-600">
          Linked view of revenue, costs, receivables and payables from Sales, Purchase and Logistics.
        </p>
      </div>

      {err && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">
          {err}
        </div>
      )}

      {/* Summary KPIs */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-8">
        <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <p className="text-xs font-medium text-slate-500">Revenue (Sales)</p>
          <p className="mt-1 text-lg font-semibold text-teal-800">
            {formatCurrency(s.revenue)}
          </p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <p className="text-xs font-medium text-slate-500">Cost of goods</p>
          <p className="mt-1 text-lg font-semibold text-slate-800">
            {formatCurrency(s.costOfGoods)}
          </p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <p className="text-xs font-medium text-slate-500">Logistics</p>
          <p className="mt-1 text-lg font-semibold text-amber-800">
            {formatCurrency(s.logisticsExpense)}
          </p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <p className="text-xs font-medium text-slate-500">Gross profit</p>
          <p className={`mt-1 text-lg font-semibold ${s.grossProfit >= 0 ? "text-green-800" : "text-red-700"}`}>
            {formatCurrency(s.grossProfit)}
          </p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <p className="text-xs font-medium text-slate-500">Total profit</p>
          <p className={`mt-1 text-lg font-semibold ${s.totalProfit >= 0 ? "text-green-800" : "text-red-700"}`}>
            {formatCurrency(s.totalProfit)}
          </p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <p className="text-xs font-medium text-slate-500">Receivables</p>
          <p className="mt-1 text-lg font-semibold text-blue-800">
            {formatCurrency(s.receivables)}
          </p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <p className="text-xs font-medium text-slate-500">Payables</p>
          <p className="mt-1 text-lg font-semibold text-orange-800">
            {formatCurrency(s.payables)}
          </p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <p className="text-xs font-medium text-slate-500">Sales collected</p>
          <p className="mt-1 text-lg font-semibold text-slate-700">
            {formatCurrency(s.salesPaid)}
          </p>
        </div>
      </div>

      {/* Linked activity */}
      <div className="rounded-2xl border bg-white p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-base font-semibold">Activity (linked from Sales, Purchase, Logistics)</h2>
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-500">Filter:</span>
            <select
              value={filterType}
              onChange={(e) => setFilterType(e.target.value)}
              className="rounded-lg border px-2 py-1 text-xs"
            >
              <option value="">All</option>
              <option value="SALES">Sales</option>
              <option value="PURCHASE">Purchase</option>
              <option value="LOGISTICS">Logistics</option>
            </select>
          </div>
        </div>
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[640px] text-left text-xs">
            <thead className="border-b bg-gray-50 text-gray-600">
              <tr>
                <th className="py-2 px-3">Type</th>
                <th className="py-2 px-3">Ref</th>
                <th className="py-2 px-3">Date</th>
                <th className="py-2 px-3">Party</th>
                <th className="py-2 px-3 text-right">Amount</th>
                <th className="py-2 px-3 text-right">Paid</th>
                <th className="py-2 px-3 text-right">Outstanding</th>
                <th className="py-2 px-3"></th>
              </tr>
            </thead>
            <tbody>
              {filteredTxns.length === 0 ? (
                <tr>
                  <td colSpan={8} className="py-6 text-center text-gray-500">
                    No transactions.
                  </td>
                </tr>
              ) : (
                filteredTxns.map((t) => {
                  const isPaying = payingId === t._id;
                  const party = t.customerName || t.supplierName || t.docNo || "—";
                  return (
                    <tr key={`${t.type}-${t._id}`} className="border-b last:border-b-0">
                      <td className="py-2 px-3">
                        <span
                          className={`inline-block rounded px-1.5 py-0.5 font-medium ${
                            t.type === "SALES"
                              ? "bg-teal-100 text-teal-800"
                              : t.type === "PURCHASE"
                              ? "bg-slate-100 text-slate-800"
                              : "bg-amber-100 text-amber-800"
                          }`}
                        >
                          {t.type}
                        </span>
                        {t.docType && (
                          <span className="ml-1 text-gray-500">{t.docType}</span>
                        )}
                      </td>
                      <td className="py-2 px-3 font-medium">{t.ref}</td>
                      <td className="py-2 px-3 text-gray-600">
                        {t.date ? new Date(t.date).toLocaleDateString() : "—"}
                      </td>
                      <td className="max-w-[180px] truncate py-2 px-3 text-gray-700" title={party}>
                        {party}
                      </td>
                      <td className="py-2 px-3 text-right">
                        {t.currency} {formatCurrency(t.amount)}
                      </td>
                      <td className="py-2 px-3 text-right">
                        {t.paid > 0 ? `${t.currency} ${formatCurrency(t.paid)}` : "—"}
                      </td>
                      <td className="py-2 px-3 text-right">
                        {t.outstanding > 0 ? (
                          <span className="font-medium text-gray-800">
                            {t.currency} {formatCurrency(t.outstanding)}
                          </span>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className="py-2 px-3">
                        {t.type !== "LOGISTICS" && t.outstanding > 0 && (
                          <>
                            {!isPaying ? (
                              <button
                                type="button"
                                onClick={() => setPayingId(t._id)}
                                className="rounded border border-teal-600 px-2 py-1 text-[11px] font-medium text-teal-700 hover:bg-teal-50"
                              >
                                Record payment
                              </button>
                            ) : (
                              <div className="flex flex-wrap items-center gap-2">
                                <input
                                  type="number"
                                  min="0.01"
                                  step="0.01"
                                  value={payAmount}
                                  onChange={(e) => setPayAmount(e.target.value)}
                                  placeholder="Amount"
                                  className="w-20 rounded border px-2 py-1 text-xs"
                                />
                                <input
                                  type="date"
                                  value={payDate}
                                  onChange={(e) => setPayDate(e.target.value)}
                                  className="rounded border px-2 py-1 text-xs"
                                />
                                <button
                                  type="button"
                                  onClick={() =>
                                    recordPayment(t._id, t.type, payAmount, payDate || undefined)
                                  }
                                  className="rounded bg-teal-600 px-2 py-1 text-[11px] font-medium text-white hover:bg-teal-700"
                                >
                                  Save
                                </button>
                                <button
                                  type="button"
                                  onClick={() => {
                                    setPayingId(null);
                                    setPayAmount("");
                                    setPayDate("");
                                  }}
                                  className="rounded border px-2 py-1 text-[11px] hover:bg-gray-50"
                                >
                                  Cancel
                                </button>
                              </div>
                            )}
                          </>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
