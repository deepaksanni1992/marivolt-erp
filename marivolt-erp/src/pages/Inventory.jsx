import { useEffect, useMemo, useState } from "react";
import { apiGet, apiGetWithQuery, apiPost } from "../lib/api.js";

export default function Inventory() {
  const [items, setItems] = useState([]);
  const [summary, setSummary] = useState([]);
  const [txns, setTxns] = useState([]);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(true);

  const [form, setForm] = useState({
    sku: "",
    type: "IN",
    qty: 1,
    ref: "",
    note: "",
  });

  async function loadAll() {
    setErr("");
    setLoading(true);
    try {
      const [itemsData, summaryData, txnsData] = await Promise.all([
        apiGet("/items"),
        apiGet("/stock-txns/summary"),
        apiGet("/stock-txns"),
      ]);
      setItems(itemsData);
      setSummary(summaryData);
      setTxns(txnsData);
    } catch (e) {
      setErr(e.message || "Failed to load inventory");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadAll();
  }, []);

  const stockBySku = useMemo(() => {
    const map = new Map();
    for (const s of summary) map.set(s.sku, s.stock);
    return map;
  }, [summary]);

  const rows = useMemo(() => {
    return items.map((it) => {
      const stock = stockBySku.get(it.sku) ?? 0;
      const min = it.minStock ?? 0;
      return { ...it, stock, low: stock <= min };
    });
  }, [items, stockBySku]);

  const selectedItem = useMemo(
    () => items.find((x) => x.sku === form.sku) || null,
    [items, form.sku]
  );

  function onChange(e) {
    const { name, value } = e.target;
    setForm((p) => ({ ...p, [name]: value }));
  }

  async function addTxn(e) {
    e.preventDefault();
    setErr("");

    if (!form.sku) return setErr("Select an item.");
    const qty = Number(form.qty);
    if (!qty || qty <= 0) return setErr("Qty must be > 0.");

    // Prevent negative stock for OUT
    const current = stockBySku.get(form.sku) ?? 0;
    if (form.type === "OUT" && current - qty < 0) {
      return setErr(`Not enough stock. Current: ${current}`);
    }

    try {
      await apiPost("/stock-txns", {
        sku: form.sku,
        type: form.type,
        qty,
        ref: form.ref,
        note: form.note,
      });

      setForm((p) => ({ ...p, qty: 1, ref: "", note: "" }));
      await loadAll();
    } catch (e2) {
      setErr(e2.message || "Failed to save transaction");
    }
  }

  async function filterTxnsBySku(sku) {
    setErr("");
    try {
      const data = await apiGetWithQuery("/stock-txns", { sku });
      setTxns(data);
    } catch (e) {
      setErr(e.message || "Failed to filter txns");
    }
  }

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border bg-white p-6">
        <h1 className="text-xl font-semibold">Inventory</h1>
        <p className="mt-1 text-gray-600">
          Now connected to MongoDB ✅ (Stock IN/OUT is stored in DB)
        </p>

        {err && (
          <div className="mt-3 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">
            {err}
          </div>
        )}
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        {/* Movement */}
        <div className="rounded-2xl border bg-white p-6">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold">Stock Movement</h2>
            <button
              onClick={loadAll}
              className="rounded-xl border px-3 py-2 text-sm hover:bg-gray-50"
            >
              Refresh
            </button>
          </div>

          <form onSubmit={addTxn} className="mt-4 space-y-3">
            <div>
              <label className="text-sm text-gray-600">Item *</label>
              <select
                name="sku"
                value={form.sku}
                onChange={(e) => {
                  onChange(e);
                  if (e.target.value) filterTxnsBySku(e.target.value);
                }}
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
                  Current stock: <b>{stockBySku.get(selectedItem.sku) ?? 0}</b>
                </div>
              )}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-sm text-gray-600">Type</label>
                <select
                  name="type"
                  value={form.type}
                  onChange={onChange}
                  className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
                >
                  <option value="IN">IN</option>
                  <option value="OUT">OUT</option>
                </select>
              </div>

              <div>
                <label className="text-sm text-gray-600">Qty</label>
                <input
                  name="qty"
                  type="number"
                  min="1"
                  value={form.qty}
                  onChange={onChange}
                  className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
                />
              </div>
            </div>

            <div>
              <label className="text-sm text-gray-600">Reference</label>
              <input
                name="ref"
                value={form.ref}
                onChange={onChange}
                className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
                placeholder="e.g. PO:PO-001 / INV:INV-001"
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
              Save Movement (DB)
            </button>
          </form>
        </div>

        {/* Summary + Recent */}
        <div className="rounded-2xl border bg-white p-6 lg:col-span-2">
          <h2 className="text-base font-semibold">Stock Summary</h2>

          {loading ? (
            <div className="mt-4 text-sm text-gray-600">Loading...</div>
          ) : (
            <>
              <div className="mt-4 overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="border-b text-gray-600">
                    <tr>
                      <th className="py-2 pr-3">Part No</th>
                      <th className="py-2 pr-3">Name</th>
                      <th className="py-2 pr-3">UOM</th>
                      <th className="py-2 pr-3">Min</th>
                      <th className="py-2 pr-3">Stock</th>
                      <th className="py-2 pr-3">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.length === 0 ? (
                      <tr>
                        <td className="py-6 text-gray-500" colSpan={6}>
                          No items.
                        </td>
                      </tr>
                    ) : (
                      rows.map((it) => (
                        <tr key={it._id} className="border-b last:border-b-0">
                          <td className="py-2 pr-3 font-medium">{it.sku}</td>
                          <td className="py-2 pr-3">{it.name}</td>
                          <td className="py-2 pr-3">{it.uom}</td>
                          <td className="py-2 pr-3">{it.minStock ?? 0}</td>
                          <td className="py-2 pr-3 font-semibold">{it.stock}</td>
                          <td className="py-2 pr-3">
                            {it.low ? (
                              <span className="rounded-full border px-2 py-1 text-xs">
                                Low
                              </span>
                            ) : (
                              <span className="rounded-full border px-2 py-1 text-xs">
                                OK
                              </span>
                            )}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>

              <div className="mt-6">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-semibold">Recent Movements</h3>
                  <button
                    onClick={() => loadAll()}
                    className="rounded-xl border px-3 py-2 text-sm hover:bg-gray-50"
                  >
                    Refresh
                  </button>
                </div>

                <div className="mt-3 space-y-2">
                  {txns.length === 0 ? (
                    <div className="text-sm text-gray-500">No movements yet.</div>
                  ) : (
                    txns.slice(0, 10).map((t) => (
                      <div
                        key={t._id}
                        className="flex items-center justify-between rounded-xl border bg-white px-3 py-2 text-sm"
                      >
                        <div>
                          <div className="font-medium">
                            {t.type} • {t.sku} • Qty {t.qty}
                          </div>
                          <div className="text-xs text-gray-600">
                            {t.ref ? `Ref: ${t.ref} • ` : ""}
                            {new Date(t.createdAt).toLocaleString()}
                          </div>
                        </div>
                        <div className="text-xs text-gray-600">{t.note}</div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
