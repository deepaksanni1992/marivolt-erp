import { useEffect, useMemo, useState } from "react";
import { apiDelete, apiGet, apiPost } from "../lib/api.js";

export default function ItemMaster() {
  const [items, setItems] = useState([]);
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");

  const [form, setForm] = useState({
    sku: "",
    name: "",
    uom: "pcs",
    category: "General",
    minStock: "",
    location: "",
  });

  async function load() {
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
    load();
  }, []);

  const filtered = useMemo(() => {
    const query = q.trim().toLowerCase();
    if (!query) return items;
    return items.filter((it) =>
      [it.sku, it.name, it.category, it.uom, it.location]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(query))
    );
  }, [items, q]);

  function onChange(e) {
    setForm((p) => ({ ...p, [e.target.name]: e.target.value }));
  }

  async function addItem(e) {
    e.preventDefault();
    setErr("");

    const sku = form.sku.trim();
    const name = form.name.trim();
    if (!sku || !name) {
      setErr("SKU/Part No and Item Name are required.");
      return;
    }

    try {
      const created = await apiPost("/items", {
        sku,
        name,
        uom: form.uom,
        category: form.category.trim() || "General",
        minStock: form.minStock ? Number(form.minStock) : 0,
        location: form.location.trim(),
      });
      setItems((prev) => [created, ...prev]);
      setForm({
        sku: "",
        name: "",
        uom: "pcs",
        category: "General",
        minStock: "",
        location: "",
      });
    } catch (e2) {
      setErr(e2.message || "Failed to add item");
    }
  }

  async function removeItem(id) {
    const ok = confirm("Delete this item?");
    if (!ok) return;

    setErr("");
    try {
      await apiDelete(`/items/${id}`);
      setItems((prev) => prev.filter((x) => x._id !== id));
    } catch (e) {
      setErr(e.message || "Failed to delete item");
    }
  }

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border bg-white p-6">
        <h1 className="text-xl font-semibold">Item Master</h1>
        <p className="mt-1 text-gray-600">
          Now connected to MongoDB ✅
        </p>

        {err && (
          <div className="mt-3 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">
            {err}
          </div>
        )}
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="rounded-2xl border bg-white p-6">
          <h2 className="text-base font-semibold">Add Item</h2>

          <form onSubmit={addItem} className="mt-4 space-y-3">
            <div>
              <label className="text-sm text-gray-600">SKU / Part No *</label>
              <input
                name="sku"
                value={form.sku}
                onChange={onChange}
                className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
                placeholder="e.g. 034.12.001"
              />
            </div>

            <div>
              <label className="text-sm text-gray-600">Item Name *</label>
              <input
                name="name"
                value={form.name}
                onChange={onChange}
                className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
                placeholder="e.g. Piston Pin"
              />
            </div>

            <div>
              <label className="text-sm text-gray-600">UOM</label>
              <select
                name="uom"
                value={form.uom}
                onChange={onChange}
                className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
              >
                <option value="pcs">pcs</option>
                <option value="set">set</option>
                <option value="kg">kg</option>
                <option value="ltr">ltr</option>
                <option value="box">box</option>
              </select>
            </div>

            <div>
              <label className="text-sm text-gray-600">Category</label>
              <input
                name="category"
                value={form.category}
                onChange={onChange}
                className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
              />
            </div>

            <div>
              <label className="text-sm text-gray-600">Min Stock</label>
              <input
                name="minStock"
                value={form.minStock}
                onChange={onChange}
                type="number"
                min="0"
                className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
              />
            </div>

            <div>
              <label className="text-sm text-gray-600">Location</label>
              <input
                name="location"
                value={form.location}
                onChange={onChange}
                className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
              />
            </div>

            <button
              type="submit"
              className="w-full rounded-xl bg-gray-900 px-4 py-2 text-sm font-semibold text-white"
            >
              + Add Item
            </button>
          </form>
        </div>

        <div className="rounded-2xl border bg-white p-6 lg:col-span-2">
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <h2 className="text-base font-semibold">Items</h2>

            <div className="flex gap-2">
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                className="w-full md:w-80 rounded-xl border px-3 py-2 text-sm"
                placeholder="Search..."
              />
              <button
                onClick={load}
                className="rounded-xl border px-3 py-2 text-sm hover:bg-gray-50"
              >
                Refresh
              </button>
            </div>
          </div>

          <div className="mt-4">
            {loading ? (
              <div className="text-sm text-gray-600">Loading...</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="border-b text-gray-600">
                    <tr>
                      <th className="py-2 pr-3">Part No</th>
                      <th className="py-2 pr-3">Name</th>
                      <th className="py-2 pr-3">UOM</th>
                      <th className="py-2 pr-3">Category</th>
                      <th className="py-2 pr-3">Min</th>
                      <th className="py-2 pr-3">Location</th>
                      <th className="py-2"></th>
                    </tr>
                  </thead>

                  <tbody>
                    {filtered.length === 0 ? (
                      <tr>
                        <td className="py-6 text-gray-500" colSpan={7}>
                          No items yet.
                        </td>
                      </tr>
                    ) : (
                      filtered.map((it) => (
                        <tr key={it._id} className="border-b last:border-b-0">
                          <td className="py-2 pr-3 font-medium">{it.sku}</td>
                          <td className="py-2 pr-3">{it.name}</td>
                          <td className="py-2 pr-3">{it.uom}</td>
                          <td className="py-2 pr-3">{it.category}</td>
                          <td className="py-2 pr-3">{it.minStock ?? 0}</td>
                          <td className="py-2 pr-3">{it.location || "-"}</td>
                          <td className="py-2 text-right">
                            <button
                              onClick={() => removeItem(it._id)}
                              className="rounded-lg border px-3 py-1 text-xs hover:bg-gray-50"
                            >
                              Delete
                            </button>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>

                <div className="mt-3 text-xs text-gray-500">
                  Total items: {items.length}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
