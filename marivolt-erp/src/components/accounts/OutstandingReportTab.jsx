export default function OutstandingReportTab({ rows = [] }) {
  return (
    <table className="min-w-full text-left text-sm">
      <thead className="border-b bg-gray-50 text-xs font-semibold text-gray-600">
        <tr>
          <th className="px-3 py-2">Customer</th>
          <th className="px-3 py-2 text-right">Total Invoice</th>
          <th className="px-3 py-2 text-right">Received</th>
          <th className="px-3 py-2 text-right">Balance</th>
          <th className="px-3 py-2">Overdue</th>
          <th className="px-3 py-2">Latest Payment</th>
          <th className="px-3 py-2">Ageing Bucket</th>
          <th className="px-3 py-2">Invoice No</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r, idx) => (
          <tr key={`${r.sourceId || idx}`} className="border-b border-gray-100">
            <td className="px-3 py-2">{r.customer}</td>
            <td className="px-3 py-2 text-right tabular-nums">{Number(r.totalInvoice || r.invoiceAmount || 0).toFixed(2)}</td>
            <td className="px-3 py-2 text-right tabular-nums">{Number(r.received || r.paidAmount || 0).toFixed(2)}</td>
            <td className="px-3 py-2 text-right tabular-nums">{Number(r.balance || r.balanceAmount || 0).toFixed(2)}</td>
            <td className="px-3 py-2">{r.overdue ? "Yes" : "No"}</td>
            <td className="px-3 py-2 text-xs">{r.latestPaymentDate ? new Date(r.latestPaymentDate).toLocaleDateString() : "—"}</td>
            <td className="px-3 py-2">{r.ageingBucket || r.agingDays}</td>
            <td className="px-3 py-2 font-mono text-xs">{r.invoiceNo}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
