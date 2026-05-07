export default function CashBankLedgerTab({ loading = false, rows = [], onDelete }) {
  return (
    <table className="min-w-full text-left text-sm">
      <thead className="border-b bg-gray-50 text-xs font-semibold text-gray-600">
        <tr>
          <th className="px-3 py-2">Date</th>
          <th className="px-3 py-2">Account</th>
          <th className="px-3 py-2">Type</th>
          <th className="px-3 py-2">Party</th>
          <th className="px-3 py-2 text-right">Amount</th>
          <th className="px-3 py-2 w-16" />
        </tr>
      </thead>
      <tbody>
        {loading ? (
          <tr><td colSpan={6} className="px-3 py-8 text-center text-gray-500">Loading…</td></tr>
        ) : rows.length === 0 ? (
          <tr><td colSpan={6} className="px-3 py-8 text-center text-gray-500">No entries.</td></tr>
        ) : rows.map((r) => (
          <tr key={r._id} className="border-b border-gray-100">
            <td className="px-3 py-2 text-xs">{r.entryDate ? new Date(r.entryDate).toLocaleDateString() : "—"}</td>
            <td className="px-3 py-2">{r.accountName}</td>
            <td className="px-3 py-2">{r.transactionType}</td>
            <td className="px-3 py-2 text-xs">{r.partyName}</td>
            <td className="px-3 py-2 text-right tabular-nums">{r.amount}</td>
            <td className="px-3 py-2">
              <button type="button" className="text-xs text-red-600" onClick={() => onDelete?.(r)}>Del</button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
