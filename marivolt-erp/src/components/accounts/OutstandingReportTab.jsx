export default function OutstandingReportTab({ rows = [] }) {
  return (
    <table className="min-w-full text-left text-sm">
      <thead className="border-b bg-gray-50 text-xs font-semibold text-gray-600">
        <tr>
          <th className="px-3 py-2">Customer</th>
          <th className="px-3 py-2">Invoice No</th>
          <th className="px-3 py-2">Invoice Date</th>
          <th className="px-3 py-2 text-right">Invoice Amount</th>
          <th className="px-3 py-2 text-right">Paid</th>
          <th className="px-3 py-2 text-right">Balance</th>
          <th className="px-3 py-2">Aging</th>
          <th className="px-3 py-2">Status</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r, idx) => (
          <tr key={`${r.sourceId || idx}`} className="border-b border-gray-100">
            <td className="px-3 py-2">{r.customer}</td>
            <td className="px-3 py-2 font-mono text-xs">{r.invoiceNo}</td>
            <td className="px-3 py-2 text-xs">{r.invoiceDate ? new Date(r.invoiceDate).toLocaleDateString() : "—"}</td>
            <td className="px-3 py-2 text-right tabular-nums">{Number(r.invoiceAmount || 0).toFixed(2)}</td>
            <td className="px-3 py-2 text-right tabular-nums">{Number(r.paidAmount || 0).toFixed(2)}</td>
            <td className="px-3 py-2 text-right tabular-nums">{Number(r.balanceAmount || 0).toFixed(2)}</td>
            <td className="px-3 py-2">{r.agingDays}</td>
            <td className="px-3 py-2">{r.status}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
