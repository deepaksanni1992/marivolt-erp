export default function AgingReportTab({ rows = [] }) {
  return (
    <table className="min-w-full text-left text-sm">
      <thead className="border-b bg-gray-50 text-xs font-semibold text-gray-600">
        <tr>
          <th className="px-3 py-2">Customer</th>
          <th className="px-3 py-2">Currency</th>
          <th className="px-3 py-2 text-right">Not Due</th>
          <th className="px-3 py-2 text-right">0-30</th>
          <th className="px-3 py-2 text-right">31-60</th>
          <th className="px-3 py-2 text-right">61-90</th>
          <th className="px-3 py-2 text-right">90+</th>
          <th className="px-3 py-2 text-right">Total</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r, idx) => (
          <tr key={`${r.customer}-${idx}`} className="border-b border-gray-100">
            <td className="px-3 py-2">{r.customer}</td>
            <td className="px-3 py-2">{r.currency}</td>
            <td className="px-3 py-2 text-right tabular-nums">{Number(r.notDue || 0).toFixed(2)}</td>
            <td className="px-3 py-2 text-right tabular-nums">{Number(r.d0_30 || 0).toFixed(2)}</td>
            <td className="px-3 py-2 text-right tabular-nums">{Number(r.d31_60 || 0).toFixed(2)}</td>
            <td className="px-3 py-2 text-right tabular-nums">{Number(r.d61_90 || 0).toFixed(2)}</td>
            <td className="px-3 py-2 text-right tabular-nums">{Number(r.d90Plus || 0).toFixed(2)}</td>
            <td className="px-3 py-2 text-right tabular-nums font-medium">{Number(r.totalOutstanding || 0).toFixed(2)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
