import { useEffect, useMemo, useState } from "react";
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import { apiGet, apiGetWithQuery, apiPost } from "../lib/api.js";

export default function Purchase() {
  const [items, setItems] = useState([]);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(true);
  const [history, setHistory] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyErr, setHistoryErr] = useState("");
  const [historyFilters, setHistoryFilters] = useState({
    from: "",
    to: "",
    sku: "",
    supplier: "",
    q: "",
  });

  const [form, setForm] = useState({
    sku: "",
    qty: 1,
    supplier: "",
    poNo: "",
    note: "",
  });

  async function loadItems() {
    setErr("");
    setLoading(true);
    try {
      const data = await apiGet("/items");
      setItems(data);
    } catch (e) {
      setErr(e.message || "Failed to load items");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadItems();
  }, []);

  const selectedItem = useMemo(
    () => items.find((x) => x.sku === form.sku) || null,
    [items, form.sku]
  );

  function onChange(e) {
    const { name, value } = e.target;
    setForm((p) => ({ ...p, [name]: value }));
  }

  function onHistoryChange(e) {
    const { name, value } = e.target;
    setHistoryFilters((p) => ({ ...p, [name]: value }));
  }

  async function loadHistory() {
    setHistoryErr("");
    setHistoryLoading(true);
    try {
      const data = await apiGetWithQuery("/stock-txns", {
        type: "IN",
        sku: historyFilters.sku.trim() || undefined,
        supplier: historyFilters.supplier.trim() || undefined,
        from: historyFilters.from || undefined,
        to: historyFilters.to || undefined,
      });
      setHistory(data);
    } catch (e) {
      setHistoryErr(e.message || "Failed to load purchase history");
    } finally {
      setHistoryLoading(false);
    }
  }

  async function addPurchase(e) {
    e.preventDefault();
    setErr("");

    if (!form.sku) return setErr("Select an item.");
    const qty = Number(form.qty);
    if (!qty || qty <= 0) return setErr("Qty must be > 0.");

    const ref = form.poNo.trim() ? `PO:${form.poNo.trim()}` : "PURCHASE";
    const supplier = form.supplier.trim();

    try {
      await apiPost("/stock-txns", {
        sku: form.sku,
        type: "IN",
        qty,
        ref,
        supplier,
        note: `${form.supplier ? `Supplier: ${form.supplier}. ` : ""}${form.note}`.trim(),
      });

      setForm({ sku: "", qty: 1, supplier: "", poNo: "", note: "" });
      alert("Purchase saved → Stock IN added to DB ✅");
      loadHistory();
    } catch (e2) {
      setErr(e2.message || "Failed to save purchase");
    }
  }

  const historyFiltered = useMemo(() => {
    const query = historyFilters.q.trim().toLowerCase();
    if (!query) return history;
    return history.filter((tx) => {
      const parts = [tx.sku, tx.ref, tx.note, tx.supplier]
        .filter(Boolean)
        .map((v) => String(v).toLowerCase());
      return parts.some((v) => v.includes(query));
    });
  }, [history, historyFilters.q]);

  function getSupplier(tx) {
    if (tx.supplier) return tx.supplier;
    const match = String(tx.note || "").match(/supplier:\s*([^\.]+)/i);
    return match ? match[1].trim() : "";
  }

  const historySummary = useMemo(() => {
    const bySupplier = new Map();
    let totalQty = 0;
    historyFiltered.forEach((tx) => {
      totalQty += Number(tx.qty) || 0;
      const supplier = getSupplier(tx) || "Unknown";
      const entry = bySupplier.get(supplier) || {
        supplier,
        qty: 0,
        count: 0,
      };
      entry.qty += Number(tx.qty) || 0;
      entry.count += 1;
      bySupplier.set(supplier, entry);
    });
    return {
      totalQty,
      totalRows: historyFiltered.length,
      rows: Array.from(bySupplier.values()).sort((a, b) =>
        a.supplier.localeCompare(b.supplier)
      ),
    };
  }, [historyFiltered]);

  function downloadCsv(filename, rows) {
    const csv = rows
      .map((row) =>
        row
          .map((cell) =>
            `"${String(cell ?? "")
              .replace(/"/g, '""')
              .replace(/\r?\n/g, " ")}"`
          )
          .join(",")
      )
      .join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    link.click();
    URL.revokeObjectURL(link.href);
  }

  function exportHistoryCsv() {
    const rows = [
      ["Date", "Supplier", "SKU", "Qty", "Ref", "Note"],
      ...historyFiltered.map((tx) => [
        new Date(tx.createdAt).toLocaleDateString(),
        getSupplier(tx) || "-",
        tx.sku,
        tx.qty,
        tx.ref || "",
        tx.note || "",
      ]),
    ];
    downloadCsv("purchase-history.csv", rows);
  }

  function exportReportCsv() {
    const rows = [
      ["Supplier", "Total Qty", "Entries"],
      ...historySummary.rows.map((row) => [
        row.supplier,
        row.qty,
        row.count,
      ]),
    ];
    downloadCsv("purchase-report-supplier.csv", rows);
  }

  function exportPdf(title, headers, body, filename) {
    const doc = new jsPDF();
    doc.text(title, 14, 16);
    autoTable(doc, {
      startY: 22,
      head: [headers],
      body,
      styles: { fontSize: 9 },
    });
    doc.save(filename);
  }

  function exportHistoryPdf() {
    const body = historyFiltered.map((tx) => [
      new Date(tx.createdAt).toLocaleDateString(),
      getSupplier(tx) || "-",
      tx.sku,
      String(tx.qty),
      tx.ref || "",
      tx.note || "",
    ]);
    exportPdf(
      "Purchase History",
      ["Date", "Supplier", "SKU", "Qty", "Ref", "Note"],
      body,
      "purchase-history.pdf"
    );
  }

  function exportReportPdf() {
    const body = historySummary.rows.map((row) => [
      row.supplier,
      String(row.qty),
      String(row.count),
    ]);
    exportPdf(
      "Purchase Report (Supplier)",
      ["Supplier", "Total Qty", "Entries"],
      body,
      "purchase-report-supplier.pdf"
    );
  }

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border bg-white p-6">
        <h1 className="text-xl font-semibold">Purchase</h1>
        <p className="mt-1 text-gray-600">
          Saves directly to MongoDB ✅ (creates Stock <b>IN</b> transaction)
        </p>

        {err && (
          <div className="mt-3 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">
            {err}
          </div>
        )}
      </div>

      <div className="rounded-2xl border bg-white p-6 max-w-2xl">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold">New Purchase</h2>
          <button
            onClick={loadItems}
            className="rounded-xl border px-3 py-2 text-sm hover:bg-gray-50"
          >
            Refresh Items
          </button>
        </div>

        {loading ? (
          <div className="mt-4 text-sm text-gray-600">Loading items...</div>
        ) : (
          <form onSubmit={addPurchase} className="mt-4 space-y-3">
            <div>
              <label className="text-sm text-gray-600">Item *</label>
              <select
                name="sku"
                value={form.sku}
                onChange={onChange}
                className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
              >
                <option value="">Select item...</option>
                {items.map((it) => (
                  <option key={it._id} value={it.sku}>
                    {it.sku} — {it.name}
                  </option>
                ))}
              </select>

              {selectedItem && (
                <div className="mt-2 text-xs text-gray-600">
                  Selected: <b>{selectedItem.name}</b>
                </div>
              )}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-sm text-gray-600">Qty *</label>
                <input
                  name="qty"
                  type="number"
                  min="1"
                  value={form.qty}
                  onChange={onChange}
                  className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
                />
              </div>

              <div>
                <label className="text-sm text-gray-600">PO No</label>
                <input
                  name="poNo"
                  value={form.poNo}
                  onChange={onChange}
                  className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
                  placeholder="e.g. PO-001"
                />
              </div>
            </div>

            <div>
              <label className="text-sm text-gray-600">Supplier</label>
              <input
                name="supplier"
                value={form.supplier}
                onChange={onChange}
                className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
                placeholder="Supplier name"
              />
            </div>

            <div>
              <label className="text-sm text-gray-600">Note</label>
              <input
                name="note"
                value={form.note}
                onChange={onChange}
                className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
              />
            </div>

            <button className="w-full rounded-xl bg-gray-900 px-4 py-2 text-sm font-semibold text-white">
              Save Purchase (DB Stock IN)
            </button>

            <p className="text-xs text-gray-500">
              Go to Inventory → Refresh → stock should increase.
            </p>
          </form>
        )}
      </div>

      <div className="rounded-2xl border bg-white p-6">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div>
            <h2 className="text-base font-semibold">Purchase History</h2>
            <p className="text-sm text-gray-500">
              Stock IN transactions (latest 500)
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={loadHistory}
              className="rounded-xl border px-3 py-2 text-sm hover:bg-gray-50"
            >
              Load History
            </button>
            <button
              onClick={exportHistoryCsv}
              className="rounded-xl border px-3 py-2 text-sm hover:bg-gray-50"
            >
              Export CSV
            </button>
            <button
              onClick={exportHistoryPdf}
              className="rounded-xl border px-3 py-2 text-sm hover:bg-gray-50"
            >
              Export PDF
            </button>
          </div>
        </div>

        <div className="mt-4 grid gap-3 md:grid-cols-5">
          <div>
            <label className="text-sm text-gray-600">From</label>
            <input
              type="date"
              name="from"
              value={historyFilters.from}
              onChange={onHistoryChange}
              className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="text-sm text-gray-600">To</label>
            <input
              type="date"
              name="to"
              value={historyFilters.to}
              onChange={onHistoryChange}
              className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="text-sm text-gray-600">SKU</label>
            <input
              name="sku"
              value={historyFilters.sku}
              onChange={onHistoryChange}
              className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
              placeholder="e.g. 034.12.001"
            />
          </div>
          <div>
            <label className="text-sm text-gray-600">Supplier</label>
            <input
              name="supplier"
              value={historyFilters.supplier}
              onChange={onHistoryChange}
              className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
              placeholder="Supplier name"
            />
          </div>
          <div>
            <label className="text-sm text-gray-600">Search</label>
            <input
              name="q"
              value={historyFilters.q}
              onChange={onHistoryChange}
              className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
              placeholder="ref / note / sku"
            />
          </div>
        </div>

        {historyErr && (
          <div className="mt-3 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">
            {historyErr}
          </div>
        )}

        <div className="mt-4">
          {historyLoading ? (
            <div className="text-sm text-gray-600">Loading history...</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="border-b text-gray-600">
                  <tr>
                    <th className="py-2 pr-3">Date</th>
                    <th className="py-2 pr-3">Supplier</th>
                    <th className="py-2 pr-3">SKU</th>
                    <th className="py-2 pr-3">Qty</th>
                    <th className="py-2 pr-3">Ref</th>
                    <th className="py-2 pr-3">Note</th>
                  </tr>
                </thead>
                <tbody>
                  {historyFiltered.length === 0 ? (
                    <tr>
                      <td className="py-6 text-gray-500" colSpan={6}>
                        No purchases yet.
                      </td>
                    </tr>
                  ) : (
                    historyFiltered.map((tx) => (
                      <tr key={tx._id} className="border-b last:border-b-0">
                        <td className="py-2 pr-3">
                          {new Date(tx.createdAt).toLocaleDateString()}
                        </td>
                        <td className="py-2 pr-3">{getSupplier(tx) || "-"}</td>
                        <td className="py-2 pr-3 font-medium">{tx.sku}</td>
                        <td className="py-2 pr-3">{tx.qty}</td>
                        <td className="py-2 pr-3">{tx.ref || "-"}</td>
                        <td className="py-2 pr-3">{tx.note || "-"}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>

              <div className="mt-3 text-xs text-gray-500">
                Total rows: {historySummary.totalRows} • Total qty:{" "}
                {historySummary.totalQty}
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="rounded-2xl border bg-white p-6">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div>
            <h2 className="text-base font-semibold">
              Purchase Report (Supplier)
            </h2>
            <div className="text-xs text-gray-500">
              Based on current history filter
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={exportReportCsv}
              className="rounded-xl border px-3 py-2 text-sm hover:bg-gray-50"
            >
              Export CSV
            </button>
            <button
              onClick={exportReportPdf}
              className="rounded-xl border px-3 py-2 text-sm hover:bg-gray-50"
            >
              Export PDF
            </button>
          </div>
        </div>

        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b text-gray-600">
              <tr>
                <th className="py-2 pr-3">Supplier</th>
                <th className="py-2 pr-3">Total Qty</th>
                <th className="py-2 pr-3">Entries</th>
              </tr>
            </thead>
            <tbody>
              {historySummary.rows.length === 0 ? (
                <tr>
                  <td className="py-6 text-gray-500" colSpan={3}>
                    No data for report.
                  </td>
                </tr>
              ) : (
                historySummary.rows.map((row) => (
                  <tr key={row.supplier} className="border-b last:border-b-0">
                    <td className="py-2 pr-3 font-medium">{row.supplier}</td>
                    <td className="py-2 pr-3">{row.qty}</td>
                    <td className="py-2 pr-3">{row.count}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
