import { useEffect, useMemo, useState } from "react";
import { apiGet, apiPost } from "../lib/api.js";

function todayStr() {
  return new Date().toLocaleDateString();
}

export default function Sales() {
  const [items, setItems] = useState([]);
  const [summary, setSummary] = useState([]);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(true);

  const [form, setForm] = useState({
    sku: "",
    qty: 1,
    customer: "",
    invoiceNo: "",
    price: "",
    note: "",
  });

  async function loadAll() {
    setErr("");
    setLoading(true);
    try {
      const [itemsData, summaryData] = await Promise.all([
        apiGet("/items"),
        apiGet("/stock-txns/summary"),
      ]);
      setItems(itemsData);
      setSummary(summaryData);
    } catch (e) {
      setErr(e.message || "Failed to load data");
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

  const selectedItem = useMemo(
    () => items.find((x) => x.sku === form.sku) || null,
    [items, form.sku]
  );

  const qtyNum = Number(form.qty) || 0;
  const priceNum = Number(form.price) || 0;
  const amount = qtyNum * priceNum;

  function onChange(e) {
    const { name, value } = e.target;
    setForm((p) => ({ ...p, [name]: value }));
  }

  async function saveAndPrint(e) {
    e.preventDefault();
    setErr("");

    if (!form.sku) return setErr("Select an item.");
    if (!form.customer.trim()) return setErr("Customer is required.");
    const qty = Number(form.qty);
    if (!qty || qty <= 0) return setErr("Qty must be > 0.");

    const current = stockBySku.get(form.sku) ?? 0;
    if (current - qty < 0) return setErr(`Not enough stock. Current: ${current}`);

    const inv = form.invoiceNo.trim() || `INV-${Date.now()}`;

    try {
      // Save Stock OUT to MongoDB
      await apiPost("/stock-txns", {
        sku: form.sku,
        type: "OUT",
        qty,
        ref: `INV:${inv}`,
        note: `${form.customer ? `Customer: ${form.customer}. ` : ""}${form.note}`.trim(),
      });

      // Refresh summary so UI stays correct
      const newSummary = await apiGet("/stock-txns/summary");
      setSummary(newSummary);

      // Print invoice
      openInvoicePrint({
        invoiceNo: inv,
        date: todayStr(),
        customer: form.customer.trim(),
        item: selectedItem,
        sku: form.sku,
        qty,
        uom: selectedItem?.uom || "pcs",
        price: priceNum,
        amount: amount,
        note: form.note.trim(),
      });

      setForm({
        sku: "",
        qty: 1,
        customer: "",
        invoiceNo: "",
        price: "",
        note: "",
      });
    } catch (e2) {
      setErr(e2.message || "Failed to save sale");
    }
  }

  function openInvoicePrint(data) {
    const w = window.open("about:blank", "_blank");
    if (!w) {
      alert("Popup blocked. Allow popups for localhost to print invoice.");
      return;
    }

    const money = (n) =>
      Number(n || 0).toLocaleString(undefined, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });

    w.document.write(`
<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Invoice ${data.invoiceNo}</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 24px; color: #111; }
    .row { display:flex; justify-content:space-between; gap: 16px; }
    .box { border:1px solid #ddd; padding:16px; border-radius:12px; }
    h1 { margin:0; font-size: 20px; }
    h2 { margin:0; font-size: 14px; color:#444; font-weight: normal; }
    table { width:100%; border-collapse: collapse; margin-top:16px; }
    th, td { border-bottom: 1px solid #eee; padding: 10px 6px; text-align:left; font-size: 12px; }
    th { color:#555; }
    .total { text-align:right; font-size: 14px; font-weight: bold; }
    .muted { color:#666; font-size: 12px; }
    @media print { button { display:none; } body { margin: 0; } }
  </style>
</head>
<body>
  <div class="row">
    <div>
      <h1>Marivoltz</h1>
      <h2>ERP System</h2>
      <div class="muted" style="margin-top:6px;">(Demo Invoice)</div>
    </div>
    <div style="text-align:right;">
      <div class="box">
        <div><b>Invoice:</b> ${data.invoiceNo}</div>
        <div><b>Date:</b> ${data.date}</div>
      </div>
    </div>
  </div>

  <div class="row" style="margin-top:16px;">
    <div class="box" style="flex:1;">
      <div class="muted">Bill To</div>
      <div style="margin-top:6px;"><b>${data.customer}</b></div>
    </div>
    <div class="box" style="flex:1;">
      <div class="muted">Notes</div>
      <div style="margin-top:6px;">${data.note || "-"}</div>
    </div>
  </div>

  <table>
    <thead>
      <tr>
        <th>Part No</th>
        <th>Item</th>
        <th>UOM</th>
        <th>Qty</th>
        <th>Unit Price</th>
        <th>Amount</th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <td>${data.sku}</td>
        <td>${data.item?.name || "-"}</td>
        <td>${data.uom}</td>
        <td>${data.qty}</td>
        <td>${money(data.price)}</td>
        <td>${money(data.amount)}</td>
      </tr>
    </tbody>
  </table>

  <div style="margin-top:14px;" class="total">
    Total: ${money(data.amount)}
  </div>

  <div style="margin-top:20px;" class="muted">
    Next upgrade: multi-line items + taxes + PDF export.
  </div>

  <button onclick="window.print()" style="margin-top:16px; padding:10px 14px; border-radius:10px; border:1px solid #ddd; background:#fff; cursor:pointer;">
    Print / Save as PDF
  </button>
</body>
</html>
    `);

    w.document.close();
  }

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border bg-white p-6">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold">Sales</h1>
            <p className="mt-1 text-gray-600">
              Stock OUT saved in MongoDB ✅ + Invoice print
            </p>
          </div>
          <button
            onClick={loadAll}
            className="rounded-xl border px-3 py-2 text-sm hover:bg-gray-50"
          >
            Refresh
          </button>
        </div>

        {err && (
          <div className="mt-3 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">
            {err}
          </div>
        )}
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="rounded-2xl border bg-white p-6">
          <h2 className="text-base font-semibold">New Sale</h2>

          {loading ? (
            <div className="mt-4 text-sm text-gray-600">Loading...</div>
          ) : (
            <form onSubmit={saveAndPrint} className="mt-4 space-y-3">
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
                    Current stock: <b>{stockBySku.get(selectedItem.sku) ?? 0}</b>
                  </div>
                )}
              </div>

              <div>
                <label className="text-sm text-gray-600">Customer *</label>
                <input
                  name="customer"
                  value={form.customer}
                  onChange={onChange}
                  className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
                />
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
                  <label className="text-sm text-gray-600">Unit Price</label>
                  <input
                    name="price"
                    type="number"
                    min="0"
                    value={form.price}
                    onChange={onChange}
                    className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
                    placeholder="e.g. 1761.63"
                  />
                </div>
              </div>

              <div>
                <label className="text-sm text-gray-600">Invoice No (optional)</label>
                <input
                  name="invoiceNo"
                  value={form.invoiceNo}
                  onChange={onChange}
                  className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
                  placeholder="e.g. INV-001"
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
                Save & Print Invoice
              </button>
            </form>
          )}
        </div>

        <div className="rounded-2xl border bg-white p-6 lg:col-span-2">
          <h2 className="text-base font-semibold">Invoice Preview</h2>

          <div className="mt-4 rounded-2xl border bg-white p-6">
            <div className="flex items-start justify-between">
              <div>
                <div className="text-lg font-semibold">Marivoltz</div>
                <div className="text-sm text-gray-600">ERP System</div>
              </div>
              <div className="text-right text-sm">
                <div>
                  <span className="text-gray-600">Invoice:</span>{" "}
                  <b>{form.invoiceNo || "Auto"}</b>
                </div>
                <div>
                  <span className="text-gray-600">Date:</span> <b>{todayStr()}</b>
                </div>
              </div>
            </div>

            <div className="mt-6 grid gap-3 md:grid-cols-2">
              <div className="rounded-xl border p-3">
                <div className="text-xs text-gray-600">Bill To</div>
                <div className="mt-1 font-semibold">{form.customer || "-"}</div>
              </div>
              <div className="rounded-xl border p-3">
                <div className="text-xs text-gray-600">Notes</div>
                <div className="mt-1">{form.note || "-"}</div>
              </div>
            </div>

            <div className="mt-6 overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="border-b text-gray-600">
                  <tr>
                    <th className="py-2 pr-3">Part No</th>
                    <th className="py-2 pr-3">Item</th>
                    <th className="py-2 pr-3">UOM</th>
                    <th className="py-2 pr-3">Qty</th>
                    <th className="py-2 pr-3">Unit Price</th>
                    <th className="py-2 pr-3">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  <tr className="border-b last:border-b-0">
                    <td className="py-2 pr-3 font-medium">{form.sku || "-"}</td>
                    <td className="py-2 pr-3">{selectedItem?.name || "-"}</td>
                    <td className="py-2 pr-3">{selectedItem?.uom || "-"}</td>
                    <td className="py-2 pr-3">{form.qty || 0}</td>
                    <td className="py-2 pr-3">
                      {priceNum ? priceNum.toFixed(2) : "0.00"}
                    </td>
                    <td className="py-2 pr-3 font-semibold">
                      {amount ? amount.toFixed(2) : "0.00"}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>

            <div className="mt-4 text-right text-base font-semibold">
              Total: {amount ? amount.toFixed(2) : "0.00"}
            </div>

            <div className="mt-3 text-xs text-gray-500">
              (Next upgrade: multiple line items + VAT + PDF export.)
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
