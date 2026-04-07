import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { apiGet } from "../lib/api.js";

function Card({ title, children, className = "" }) {
  return (
    <section
      className={`rounded-xl border border-slate-200/80 bg-white p-5 shadow-sm ${className}`}
    >
      {title ? (
        <h2 className="mb-4 text-xs font-semibold uppercase tracking-wider text-slate-500">{title}</h2>
      ) : null}
      {children}
    </section>
  );
}

export default function ItemFullView() {
  const raw = useParams().article ?? "";
  const article = decodeURIComponent(String(raw)).trim().toUpperCase();

  const { data, isLoading, error } = useQuery({
    queryKey: ["itemFull", article],
    queryFn: () => apiGet(`/items/full/${encodeURIComponent(article)}`),
    enabled: !!article,
  });

  const item = data?.item;
  const mappings = data?.mappings ?? [];
  const suppliers = data?.suppliers ?? [];

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6">
      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <Link
            to="/items"
            className="text-sm font-medium text-slate-500 hover:text-slate-800"
          >
            ← Item Master
          </Link>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight text-slate-900">
            {article || "—"}
          </h1>
          <p className="mt-1 text-sm text-slate-500">Full article record, mappings, and supplier offers</p>
        </div>
      </div>

      {error ? (
        <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">
          {error.message}
        </div>
      ) : null}

      {isLoading ? (
        <p className="text-sm text-slate-500">Loading…</p>
      ) : !item ? (
        <p className="text-sm text-slate-500">No data.</p>
      ) : (
        <div className="space-y-6">
          <Card title="Master data">
            <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {[
                ["Product name", item.description || "—"],
                ["Brand", item.brand || "—"],
                ["Vertical", item.vertical || "—"],
                ["UOM", item.uom || "—"],
                ["COO", item.coo || "—"],
                ["Status", item.isActive ? "Active" : "Inactive"],
                ["Currency", item.currency || "—"],
                ["Sale price", `${item.currency || ""} ${Number(item.salePrice || 0).toFixed(2)}`],
              ].map(([k, v]) => (
                <div key={k}>
                  <dt className="text-xs font-medium text-slate-500">{k}</dt>
                  <dd className="mt-0.5 text-sm text-slate-900">{v}</dd>
                </div>
              ))}
            </dl>
          </Card>

          <Card title={`Technical mappings (${mappings.length})`}>
            {mappings.length === 0 ? (
              <p className="text-sm text-slate-500">No mapping rows.</p>
            ) : (
              <div className="overflow-x-auto rounded-lg border border-slate-100">
                <table className="min-w-full text-left text-sm">
                  <thead className="border-b border-slate-100 bg-slate-50/80 text-xs font-semibold text-slate-600">
                    <tr>
                      <th className="px-3 py-2">Model</th>
                      <th className="px-3 py-2">ESN</th>
                      <th className="px-3 py-2">MPN</th>
                      <th className="px-3 py-2">Part #</th>
                      <th className="px-3 py-2">Drawing</th>
                      <th className="px-3 py-2">Description</th>
                    </tr>
                  </thead>
                  <tbody>
                    {mappings.map((m) => (
                      <tr key={m._id} className="border-b border-slate-50">
                        <td className="px-3 py-2">{m.model || "—"}</td>
                        <td className="px-3 py-2 font-mono text-xs">{m.esn || "—"}</td>
                        <td className="px-3 py-2 font-mono text-xs">{m.mpn || "—"}</td>
                        <td className="px-3 py-2 font-mono text-xs">{m.partNumber || "—"}</td>
                        <td className="px-3 py-2 font-mono text-xs">{m.drawingNumber || "—"}</td>
                        <td className="px-3 py-2 text-slate-700">{m.description || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <Card title={`Supplier comparison (${suppliers.length})`}>
            {suppliers.length === 0 ? (
              <p className="text-sm text-slate-500">No supplier offers.</p>
            ) : (
              <div className="overflow-x-auto rounded-lg border border-slate-100">
                <table className="min-w-full text-left text-sm">
                  <thead className="border-b border-slate-100 bg-slate-50/80 text-xs font-semibold text-slate-600">
                    <tr>
                      <th className="px-3 py-2">Supplier</th>
                      <th className="px-3 py-2">Supplier part #</th>
                      <th className="px-3 py-2 text-right">Unit price</th>
                      <th className="px-3 py-2">Currency</th>
                    </tr>
                  </thead>
                  <tbody>
                    {suppliers.map((s) => (
                      <tr key={s._id} className="border-b border-slate-50">
                        <td className="px-3 py-2 font-medium">{s.supplierName}</td>
                        <td className="px-3 py-2 font-mono text-xs">{s.supplierPartNumber || "—"}</td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {Number(s.unitPrice || 0).toFixed(2)}
                        </td>
                        <td className="px-3 py-2">{s.currency || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </div>
      )}
    </div>
  );
}
