export default function AsnStatusBadge({ status }) {
  const s = String(status || "").toUpperCase();
  const map = {
    DRAFT: "bg-slate-100 text-slate-800 ring-slate-200",
    SHIPPED: "bg-sky-50 text-sky-900 ring-sky-200",
    ARRIVED: "bg-emerald-50 text-emerald-900 ring-emerald-200",
    PARTIALLY_RECEIVED: "bg-amber-50 text-amber-900 ring-amber-200",
    COMPLETED: "bg-indigo-50 text-indigo-900 ring-indigo-200",
    CANCELLED: "bg-red-50 text-red-800 ring-red-200",
  };
  const cls = map[s] || "bg-gray-100 text-gray-800 ring-gray-200";
  return (
    <span className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ring-inset ${cls}`}>
      {s || "—"}
    </span>
  );
}
