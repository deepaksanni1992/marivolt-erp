import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiGetWithQuery } from "../lib/api.js";

const MODULES = ["", "SALES", "STORE", "ACCOUNTS", "PURCHASE", "INVENTORY"];
const ACTIONS = [
  "",
  "CREATE",
  "UPDATE",
  "DELETE",
  "STATUS_CHANGE",
  "CANCEL",
  "POST",
  "PAYMENT",
  "STOCK",
  "ATTACHMENT",
];

function badgeClass(action) {
  switch (action) {
    case "CREATE":
    case "POST":
      return "bg-emerald-100 text-emerald-700";
    case "UPDATE":
      return "bg-sky-100 text-sky-700";
    case "DELETE":
    case "CANCEL":
      return "bg-rose-100 text-rose-700";
    case "STATUS_CHANGE":
      return "bg-amber-100 text-amber-700";
    case "PAYMENT":
      return "bg-indigo-100 text-indigo-700";
    case "STOCK":
      return "bg-purple-100 text-purple-700";
    default:
      return "bg-gray-100 text-gray-700";
  }
}

function fmtDate(d) {
  if (!d) return "—";
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return "—";
  return dt.toLocaleString();
}

export default function AuditTrail() {
  const [module, setModule] = useState("");
  const [action, setAction] = useState("");
  const [documentNo, setDocumentNo] = useState("");
  const [userEmail, setUserEmail] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [page, setPage] = useState(1);
  const limit = 100;

  const params = useMemo(
    () => ({ module, action, documentNo, userEmail, from, to, page, limit }),
    [module, action, documentNo, userEmail, from, to, page]
  );

  const { data, isLoading, isError, error, refetch, isFetching } = useQuery({
    queryKey: ["audit-logs", params],
    queryFn: () => apiGetWithQuery("/audit-logs", params),
    keepPreviousData: true,
  });

  const items = data?.items || [];
  const total = data?.total || 0;
  const pages = Math.max(1, Math.ceil(total / limit));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Audit Trail</h1>
          <p className="text-sm text-gray-500">
            Every business-meaningful change in the ERP. Lifecycle transitions, cancellations, edits on
            posted documents, payments and stock movements.
          </p>
        </div>
        <button
          onClick={() => refetch()}
          className="rounded-lg border px-3 py-1.5 text-sm hover:bg-gray-50"
          disabled={isFetching}
        >
          {isFetching ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      <div className="grid grid-cols-1 gap-3 rounded-2xl border bg-white p-3 md:grid-cols-3 xl:grid-cols-6">
        <div>
          <label className="block text-xs text-gray-500">Module</label>
          <select
            className="mt-1 w-full rounded-lg border px-2 py-1.5 text-sm"
            value={module}
            onChange={(e) => {
              setPage(1);
              setModule(e.target.value);
            }}
          >
            {MODULES.map((m) => (
              <option key={m || "_all"} value={m}>
                {m || "All"}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs text-gray-500">Action</label>
          <select
            className="mt-1 w-full rounded-lg border px-2 py-1.5 text-sm"
            value={action}
            onChange={(e) => {
              setPage(1);
              setAction(e.target.value);
            }}
          >
            {ACTIONS.map((a) => (
              <option key={a || "_all"} value={a}>
                {a || "All"}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs text-gray-500">Document No</label>
          <input
            className="mt-1 w-full rounded-lg border px-2 py-1.5 text-sm"
            value={documentNo}
            onChange={(e) => {
              setPage(1);
              setDocumentNo(e.target.value);
            }}
            placeholder="e.g. PI-OK/260508.1"
          />
        </div>
        <div>
          <label className="block text-xs text-gray-500">User email</label>
          <input
            className="mt-1 w-full rounded-lg border px-2 py-1.5 text-sm"
            value={userEmail}
            onChange={(e) => {
              setPage(1);
              setUserEmail(e.target.value);
            }}
            placeholder="someone@..."
          />
        </div>
        <div>
          <label className="block text-xs text-gray-500">From</label>
          <input
            type="date"
            className="mt-1 w-full rounded-lg border px-2 py-1.5 text-sm"
            value={from}
            onChange={(e) => {
              setPage(1);
              setFrom(e.target.value);
            }}
          />
        </div>
        <div>
          <label className="block text-xs text-gray-500">To</label>
          <input
            type="date"
            className="mt-1 w-full rounded-lg border px-2 py-1.5 text-sm"
            value={to}
            onChange={(e) => {
              setPage(1);
              setTo(e.target.value);
            }}
          />
        </div>
      </div>

      <div className="overflow-hidden rounded-2xl border bg-white">
        <div className="max-h-[70vh] overflow-auto">
          <table className="min-w-full text-sm">
            <thead className="sticky top-0 z-10 bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
              <tr>
                <th className="px-3 py-2">When</th>
                <th className="px-3 py-2">Module</th>
                <th className="px-3 py-2">Action</th>
                <th className="px-3 py-2">Entity</th>
                <th className="px-3 py-2">Document</th>
                <th className="px-3 py-2">From → To</th>
                <th className="px-3 py-2">User</th>
                <th className="px-3 py-2">Description</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {isLoading && (
                <tr>
                  <td className="px-3 py-4 text-gray-500" colSpan={8}>
                    Loading…
                  </td>
                </tr>
              )}
              {isError && (
                <tr>
                  <td className="px-3 py-4 text-rose-600" colSpan={8}>
                    {error?.message || "Failed to load audit log"}
                  </td>
                </tr>
              )}
              {!isLoading && !isError && items.length === 0 && (
                <tr>
                  <td className="px-3 py-4 text-gray-500" colSpan={8}>
                    No audit entries match these filters.
                  </td>
                </tr>
              )}
              {items.map((row) => (
                <tr key={row._id} className="hover:bg-gray-50">
                  <td className="whitespace-nowrap px-3 py-2 text-gray-600">{fmtDate(row.createdAt)}</td>
                  <td className="whitespace-nowrap px-3 py-2">{row.module || "—"}</td>
                  <td className="px-3 py-2">
                    <span
                      className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${badgeClass(
                        row.action
                      )}`}
                    >
                      {row.action || "—"}
                    </span>
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-gray-700">{row.entityType || "—"}</td>
                  <td className="whitespace-nowrap px-3 py-2 font-medium">{row.documentNo || "—"}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-gray-600">
                    {row.fromStatus || row.toStatus
                      ? `${row.fromStatus || "—"} → ${row.toStatus || "—"}`
                      : "—"}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-gray-600">{row.userEmail || "—"}</td>
                  <td className="px-3 py-2">
                    <div className="text-gray-800">{row.description}</div>
                    {row.metadata && (
                      <pre className="mt-1 max-w-[40rem] overflow-x-auto rounded bg-gray-50 p-1 text-[11px] text-gray-500">
                        {JSON.stringify(row.metadata, null, 0)}
                      </pre>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="flex items-center justify-between border-t bg-white px-3 py-2 text-xs text-gray-500">
          <div>
            {total} entr{total === 1 ? "y" : "ies"} · page {page} / {pages}
          </div>
          <div className="flex gap-2">
            <button
              className="rounded border px-2 py-1 disabled:opacity-50"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page <= 1}
            >
              Prev
            </button>
            <button
              className="rounded border px-2 py-1 disabled:opacity-50"
              onClick={() => setPage((p) => (p < pages ? p + 1 : p))}
              disabled={page >= pages}
            >
              Next
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
