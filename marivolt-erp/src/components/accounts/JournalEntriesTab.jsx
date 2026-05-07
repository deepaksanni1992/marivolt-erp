export default function JournalEntriesTab({ rows = [] }) {
  return (
    <table className="min-w-full text-left text-sm">
      <thead className="border-b bg-gray-50 text-xs font-semibold text-gray-600">
        <tr>
          <th className="px-3 py-2">Entry No</th>
          <th className="px-3 py-2">Date</th>
          <th className="px-3 py-2">Reference</th>
          <th className="px-3 py-2">Narration</th>
          <th className="px-3 py-2">Status</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r._id} className="border-b border-gray-100">
            <td className="px-3 py-2 font-mono text-xs">{r.entryNo}</td>
            <td className="px-3 py-2 text-xs">{r.entryDate ? new Date(r.entryDate).toLocaleDateString() : "—"}</td>
            <td className="px-3 py-2 text-xs">{r.referenceNo || "—"}</td>
            <td className="px-3 py-2">{r.narration || "—"}</td>
            <td className="px-3 py-2">{r.status}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
