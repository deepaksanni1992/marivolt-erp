import { FormField, SelectInput, TextInput } from "../erp/FormField.jsx";

function statusBadgeClass(status = "") {
  const k = String(status || "").toUpperCase();
  if (["FULLY_ALLOCATED"].includes(k)) return "bg-emerald-50 text-emerald-700 ring-emerald-200";
  if (["PARTIALLY_ALLOCATED", "POSTED"].includes(k)) return "bg-amber-50 text-amber-700 ring-amber-200";
  if (["CANCELLED"].includes(k)) return "bg-rose-50 text-rose-700 ring-rose-200";
  return "bg-slate-100 text-slate-700 ring-slate-200";
}

export default function PaymentReceiptsTab({
  rows = [],
  loading = false,
  summary = {},
  filters,
  setFilters,
  onView,
  onPrint,
  onViewSlip,
  onDownloadSlip,
  onViewJournal,
  onCancel,
  onExportCsv,
  isCancelPending = false,
}) {
  return (
    <>
      <div className="mb-4 space-y-3">
        <div className="grid gap-3 md:grid-cols-4">
          <div className="rounded-xl border bg-white p-3 text-sm"><div className="text-gray-500">Total Received</div><div className="text-lg font-semibold">{Number(summary.totalReceived || 0).toFixed(2)}</div></div>
          <div className="rounded-xl border bg-white p-3 text-sm"><div className="text-gray-500">Total Allocated</div><div className="text-lg font-semibold">{Number(summary.totalAllocated || 0).toFixed(2)}</div></div>
          <div className="rounded-xl border bg-white p-3 text-sm"><div className="text-gray-500">Total Unallocated</div><div className="text-lg font-semibold">{Number(summary.totalUnallocated || 0).toFixed(2)}</div></div>
          <div className="rounded-xl border bg-white p-3 text-sm"><div className="text-gray-500">Cancelled Receipts</div><div className="text-lg font-semibold">{Number(summary.cancelledCount || 0)}</div></div>
        </div>
        <div className="grid gap-3 rounded-2xl border bg-white p-4 md:grid-cols-6">
          <FormField label="Customer"><TextInput value={filters.customerName} onChange={(e) => setFilters((f) => ({ ...f, customerName: e.target.value }))} /></FormField>
          <FormField label="Reference"><TextInput value={filters.referenceNo} onChange={(e) => setFilters((f) => ({ ...f, referenceNo: e.target.value }))} /></FormField>
          <FormField label="Proforma No"><TextInput value={filters.proformaNo} onChange={(e) => setFilters((f) => ({ ...f, proformaNo: e.target.value }))} /></FormField>
          <FormField label="Invoice No"><TextInput value={filters.invoiceNo} onChange={(e) => setFilters((f) => ({ ...f, invoiceNo: e.target.value }))} /></FormField>
          <FormField label="Status">
            <SelectInput value={filters.status} onChange={(e) => setFilters((f) => ({ ...f, status: e.target.value }))}>
              <option value="">All</option>
              <option value="POSTED">Posted</option>
              <option value="PARTIALLY_ALLOCATED">Partially Allocated</option>
              <option value="FULLY_ALLOCATED">Fully Allocated</option>
              <option value="CANCELLED">Cancelled</option>
            </SelectInput>
          </FormField>
          <div className="flex items-end justify-end gap-2">
            <button
              type="button"
              className="rounded border bg-white px-3 py-1.5 text-xs font-medium hover:bg-gray-50"
              onClick={() => onExportCsv?.(rows)}
              disabled={!rows.length}
              title="Export current results to CSV"
            >
              Export CSV
            </button>
          </div>
        </div>
      </div>
      <table className="min-w-full text-left text-sm">
        <thead className="border-b bg-gray-50 text-xs font-semibold text-gray-600">
          <tr>
            <th className="px-3 py-2">Receipt No</th><th className="px-3 py-2">Date</th><th className="px-3 py-2">Customer</th>
            <th className="px-3 py-2">Proforma No</th><th className="px-3 py-2">Sales Invoice No</th>
            <th className="px-3 py-2 text-right">Amount</th><th className="px-3 py-2 text-right">Allocated</th><th className="px-3 py-2 text-right">Unallocated</th>
            <th className="px-3 py-2">Mode</th><th className="px-3 py-2">Bank/Cash Account</th><th className="px-3 py-2">Reference</th><th className="px-3 py-2">Status</th><th className="px-3 py-2">Actions</th>
          </tr>
        </thead>
        <tbody>
          {loading ? (
            <tr><td colSpan={13} className="px-3 py-8 text-center text-gray-500">Loading…</td></tr>
          ) : rows.length === 0 ? (
            <tr><td colSpan={13} className="px-3 py-8 text-center text-gray-500">No payment receipts.</td></tr>
          ) : rows.map((r) => (
            <tr key={r._id} className="border-b border-gray-100">
              <td className="px-3 py-2 font-mono text-xs">{r.receiptNo}</td>
              <td className="px-3 py-2 text-xs">{r.receiptDate ? new Date(r.receiptDate).toLocaleDateString() : "—"}</td>
              <td className="px-3 py-2">{r.customerName || "—"}</td>
              <td className="px-3 py-2 font-mono text-xs">{r.proformaInvoiceNo || "—"}</td>
              <td className="px-3 py-2 font-mono text-xs">{r.salesInvoiceNo || "—"}</td>
              <td className="px-3 py-2 text-right tabular-nums">{r.currency} {Number(r.amountReceived || 0).toFixed(2)}</td>
              <td className="px-3 py-2 text-right tabular-nums">{Number(r.allocatedAmount || 0).toFixed(2)}</td>
              <td className="px-3 py-2 text-right tabular-nums">{Number(r.unallocatedAmount || 0).toFixed(2)}</td>
              <td className="px-3 py-2 text-xs">{String(r.paymentMode || "").replaceAll("_", " ")}</td>
              <td className="px-3 py-2 text-xs">{r.bankCashAccountName || r.accountName || "—"}</td>
              <td className="px-3 py-2 text-xs">{r.paymentReference || "—"}</td>
              <td className="px-3 py-2">
                <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ${statusBadgeClass(r.status)}`}>
                  {r.status}
                </span>
              </td>
              <td className="px-3 py-2">
                <div className="flex flex-wrap gap-1">
                  <button type="button" className="rounded border px-2 py-1 text-xs" onClick={() => onView?.(r)}>View</button>
                  <button type="button" className="rounded border px-2 py-1 text-xs" onClick={() => onPrint?.(r._id)}>Print</button>
                  <button
                    type="button"
                    className={`rounded border px-2 py-1 text-xs ${r.attachmentKey ? "" : "opacity-40"}`}
                    disabled={!r.attachmentKey}
                    onClick={() => onViewSlip?.(r._id)}
                    title="Preview payment slip in new tab"
                  >
                    Preview
                  </button>
                  <button
                    type="button"
                    className={`rounded border px-2 py-1 text-xs ${r.attachmentKey ? "" : "opacity-40"}`}
                    disabled={!r.attachmentKey}
                    onClick={() => onDownloadSlip?.(r._id)}
                    title="Download payment slip"
                  >
                    Download
                  </button>
                  <button type="button" className={`rounded border px-2 py-1 text-xs ${r.journalEntryId ? "" : "opacity-40"}`} disabled={!r.journalEntryId} onClick={() => onViewJournal?.(r.journalEntryId)}>Journal</button>
                  <button type="button" className={`rounded border px-2 py-1 text-xs text-red-600 ${String(r.status || "").toUpperCase() === "CANCELLED" ? "opacity-40" : ""}`} disabled={String(r.status || "").toUpperCase() === "CANCELLED" || isCancelPending} onClick={() => onCancel?.(r)}>Cancel</button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
