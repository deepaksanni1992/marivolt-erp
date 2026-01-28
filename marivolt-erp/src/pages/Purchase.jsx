import { useEffect, useMemo, useState } from "react";
import { apiGet, apiPost } from "../lib/api.js";

export default function Purchase() {
  const [items, setItems] = useState([]);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(true);

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

  async function addPurchase(e) {
    e.preventDefault();
    setErr("");

    if (!form.sku) return setErr("Select an item.");
    const qty = Number(form.qty);
    if (!qty || qty <= 0) return setErr("Qty must be > 0.");

    const ref = form.poNo.trim() ? `PO:${form.poNo.trim()}` : "PURCHASE";

    try {
      await apiPost("/stock-txns", {
        sku: form.sku,
        type: "IN",
        qty,
        ref,
        note: `${form.supplier ? `Supplier: ${form.supplier}. ` : ""}${form.note}`.trim(),
      });

      setForm({ sku: "", qty: 1, supplier: "", poNo: "", note: "" });
      alert("Purchase saved → Stock IN added to DB ✅");
    } catch (e2) {
      setErr(e2.message || "Failed to save purchase");
    }
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
    </div>
  );
}
