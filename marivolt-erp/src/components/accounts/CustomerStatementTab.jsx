import { FormField, SelectInput, TextInput } from "../erp/FormField.jsx";

function money(v) {
  return Number(v || 0).toFixed(2);
}

export default function CustomerStatementTab({
  rows = [],
  loading = false,
  filters,
  setFilters,
  closingBalance = 0,
  onExportCsv,
  onPrint,
  onOpenInvoice,
  onOpenPayment,
  onPreviewAttachment,
}) {
  return (
    <div className="space-y-4">
      <div className="grid gap-3 rounded-2xl border bg-white p-4 md:grid-cols-6">
        <FormField label="Customer">
          <TextInput value={filters.customerName} onChange={(e) => setFilters((f) => ({ ...f, customerName: e.target.value }))} />
        </FormField>
        <FormField label="From Date">
          <TextInput type="date" value={filters.fromDate} onChange={(e) => setFilters((f) => ({ ...f, fromDate: e.target.value }))} />
        </FormField>
        <FormField label="To Date">
          <TextInput type="date" value={filters.toDate} onChange={(e) => setFilters((f) => ({ ...f, toDate: e.target.value }))} />
        </FormField>
        <FormField label="Currency">
          <SelectInput value={filters.currency} onChange={(e) => setFilters((f) => ({ ...f, currency: e.target.value }))}>
            <option value="">All</option>
            <option value="USD">USD</option>
            <option value="EUR">EUR</option>
            <option value="AED">AED</option>
          </SelectInput>
        </FormField>
        <div className="rounded-xl border bg-slate-50 p-3 text-sm">
          <div className="text-xs text-slate-500">Closing Balance</div>
          <div className="text-lg font-semibold tabular-nums">{money(closingBalance)}</div>
        </div>
        <div className="flex items-end justify-end gap-2">
          <button type="button" className="rounded border bg-white px-3 py-1.5 text-xs font-medium hover:bg-gray-50" onClick={() => onExportCsv?.()} disabled={!rows.length}>
            Export CSV
          </button>
          <button type="button" className="rounded border bg-white px-3 py-1.5 text-xs font-medium hover:bg-gray-50" onClick={() => onPrint?.()} disabled={!rows.length}>
            Print / PDF
          </button>
        </div>
      </div>

      <div className="overflow-hidden rounded-2xl border bg-white">
        <div className="overflow-x-auto">
          <table className="min-w-full text-left text-sm">
            <thead className="sticky top-0 z-10 border-b bg-gray-50 text-xs font-semibold uppercase tracking-wide text-gray-600">
              <tr>
                <th className="px-3 py-2">Date</th>
                <th className="px-3 py-2">Document No</th>
                <th className="px-3 py-2">Movement</th>
                <th className="px-3 py-2 text-right">Debit</th>
                <th className="px-3 py-2 text-right">Credit</th>
                <th className="px-3 py-2 text-right">Running Balance</th>
                <th className="px-3 py-2">Remarks</th>
                <th className="px-3 py-2">Actions</th>
              </tr>
            </thead>
            <tbody>
              {!filters.customerName.trim() ? (
                <tr><td colSpan={8} className="px-3 py-8 text-center text-gray-500">Enter a customer name to load statement.</td></tr>
              ) : loading ? (
                <tr><td colSpan={8} className="px-3 py-8 text-center text-gray-500">Loading...</td></tr>
              ) : rows.length === 0 ? (
                <tr><td colSpan={8} className="px-3 py-8 text-center text-gray-500">No statement rows.</td></tr>
              ) : rows.map((r) => (
                <tr key={r._id} className="border-b border-gray-100 hover:bg-gray-50/80">
                  <td className="px-3 py-2 text-xs">{r.transactionDate ? new Date(r.transactionDate).toLocaleDateString() : "—"}</td>
                  <td className="px-3 py-2 font-mono text-xs">{r.documentNo || "—"}</td>
                  <td className="px-3 py-2 text-xs">{String(r.movementType || "").replaceAll("_", " ")}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{money(r.debitAmount)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{money(r.creditAmount)}</td>
                  <td className="px-3 py-2 text-right font-medium tabular-nums">{money(r.runningBalance)}</td>
                  <td className="px-3 py-2 text-xs">{r.remarks || "—"}</td>
                  <td className="px-3 py-2">
                    <div className="flex flex-wrap gap-1">
                      <button type="button" className="rounded border px-2 py-1 text-xs" disabled={!r.linkedInvoiceId} onClick={() => onOpenInvoice?.(r.linkedInvoiceId)}>
                        Invoice
                      </button>
                      <button type="button" className="rounded border px-2 py-1 text-xs" disabled={!r.linkedPaymentId} onClick={() => onOpenPayment?.(r.linkedPaymentId)}>
                        Payment
                      </button>
                      <button type="button" className="rounded border px-2 py-1 text-xs" disabled={!r.linkedPaymentId} onClick={() => onPreviewAttachment?.(r.linkedPaymentId)}>
                        Attachment
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
