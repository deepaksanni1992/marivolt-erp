import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import PageHeader from "../components/erp/PageHeader.jsx";
import { useAuth } from "../context/AuthContext.jsx";
import { apiGetWithQuery } from "../lib/api.js";
import { downloadCsv, downloadPdfTable } from "../lib/purchaseExport.js";

const CATEGORIES = ["All", "Sales", "Purchase", "Inventory", "Accounts", "Customs", "Documents"];

const EXPORT_COLUMNS = [
  { key: "type", header: "Type" },
  { key: "documentNumber", header: "Document Number" },
  { key: "company", header: "Company" },
  { key: "date", header: "Date" },
  { key: "party", header: "Customer/Supplier" },
  { key: "article", header: "Article" },
  { key: "partNumber", header: "Part Number" },
  { key: "description", header: "Description" },
  { key: "status", header: "Status" },
  { key: "amount", header: "Amount" },
  { key: "qty", header: "Qty" },
];

function fmtDate(v) {
  if (!v) return "—";
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toISOString().slice(0, 10);
}

function fmtNum(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

function typeTone(type) {
  const t = String(type || "").toLowerCase();
  if (t.includes("invoice") || t.includes("quotation")) return "bg-sky-50 text-sky-800 ring-sky-200";
  if (t.includes("customs")) return "bg-violet-50 text-violet-800 ring-violet-200";
  if (t.includes("grn") || t.includes("packing") || t.includes("dispatch")) return "bg-amber-50 text-amber-900 ring-amber-200";
  if (t.includes("customer") || t.includes("supplier")) return "bg-slate-100 text-slate-800 ring-slate-200";
  return "bg-gray-50 text-gray-700 ring-gray-200";
}

export default function GlobalSearch() {
  const [searchParams, setSearchParams] = useSearchParams();
  const { auth, selectCompany } = useAuth();

  const [q, setQ] = useState(searchParams.get("q") || "");
  const [category, setCategory] = useState(searchParams.get("type") || "All");
  const [status, setStatus] = useState(searchParams.get("status") || "");
  const [dateFrom, setDateFrom] = useState(searchParams.get("dateFrom") || "");
  const [dateTo, setDateTo] = useState(searchParams.get("dateTo") || "");
  const [page, setPage] = useState(Math.max(1, Number(searchParams.get("page") || 1)));
  const [exporting, setExporting] = useState(false);

  const syncUrl = useCallback(
    (next = {}) => {
      const params = new URLSearchParams();
      const vals = {
        q: next.q ?? q,
        type: next.type ?? category,
        status: next.status ?? status,
        dateFrom: next.dateFrom ?? dateFrom,
        dateTo: next.dateTo ?? dateTo,
        page: String(next.page ?? page),
      };
      Object.entries(vals).forEach(([k, v]) => {
        if (v && String(v).trim() && !(k === "type" && v === "All") && !(k === "page" && v === "1")) {
          params.set(k, String(v).trim());
        }
      });
      setSearchParams(params, { replace: true });
    },
    [q, category, status, dateFrom, dateTo, page, setSearchParams],
  );

  const queryParams = useMemo(
    () => ({
      q: q.trim() || undefined,
      type: category !== "All" ? category : undefined,
      status: status.trim() || undefined,
      dateFrom: dateFrom || undefined,
      dateTo: dateTo || undefined,
      page,
      limit: 50,
    }),
    [q, category, status, dateFrom, dateTo, page],
  );

  const searchQ = useQuery({
    queryKey: ["global-search", queryParams, auth?.company?.id],
    queryFn: () => apiGetWithQuery("/search/global", queryParams),
    enabled: (q.trim().length || 0) >= 1,
  });

  const rows = searchQ.data?.items || [];
  const total = searchQ.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / 50));
  const companyCode = auth?.company?.code || searchQ.data?.companyCode || "—";

  useEffect(() => {
    const urlQ = searchParams.get("q") || "";
    if (urlQ !== q) setQ(urlQ);
  }, [searchParams]);

  const runSearch = (e) => {
    e?.preventDefault?.();
    setPage(1);
    syncUrl({ q, page: 1 });
  };

  const onCompanyChange = async (e) => {
    const nextId = e.target.value;
    if (!nextId || nextId === auth?.company?.id) return;
    try {
      await selectCompany(nextId);
      setPage(1);
    } catch (err) {
      window.alert(err.message || "Failed to switch company");
    }
  };

  const exportResults = async (kind) => {
    if (!q.trim()) return;
    setExporting(true);
    try {
      const data = await apiGetWithQuery("/search/global", { ...queryParams, page: 1, limit: 500 });
      const exportRows = (data.items || []).map((r) => ({
        ...r,
        date: fmtDate(r.date),
        amount: r.amount != null ? r.amount : "",
        qty: r.qty != null ? r.qty : "",
      }));
      const base = `erp-global-search-${companyCode}-${Date.now()}`;
      if (kind === "pdf") {
        downloadPdfTable(base, `Global ERP Search — ${companyCode}`, EXPORT_COLUMNS, exportRows, "Global Search");
      } else {
        downloadCsv(`${base}.csv`, EXPORT_COLUMNS, exportRows);
      }
    } catch (err) {
      window.alert(err.message || "Export failed");
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="p-4 md:p-6">
      <PageHeader
        title="Global Search"
        subtitle="Search quotations, orders, GRNs, packings, dispatches, customs, and articles across the ERP."
      >
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={exporting || !q.trim()}
            className="rounded-lg border px-3 py-2 text-sm font-semibold hover:bg-slate-50 disabled:opacity-40"
            onClick={() => exportResults("csv")}
          >
            Export CSV
          </button>
          <button
            type="button"
            disabled={exporting || !q.trim()}
            className="rounded-lg border px-3 py-2 text-sm font-semibold hover:bg-slate-50 disabled:opacity-40"
            onClick={() => exportResults("pdf")}
          >
            Export PDF
          </button>
        </div>
      </PageHeader>

      <form onSubmit={runSearch} className="mb-4 rounded-2xl border bg-white p-4 shadow-sm">
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
          <label className="flex flex-col gap-1 text-xs md:col-span-2 lg:col-span-2">
            <span className="font-medium text-slate-600">Search</span>
            <input
              className="rounded-lg border px-3 py-2 text-sm"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Document no, article, customer, supplier, BL, AWB, BOE, supplier invoice…"
              autoFocus
            />
          </label>
          <label className="flex flex-col gap-1 text-xs">
            <span className="font-medium text-slate-600">Category</span>
            <select className="rounded-lg border px-2 py-2 text-sm" value={category} onChange={(e) => setCategory(e.target.value)}>
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs">
            <span className="font-medium text-slate-600">Company</span>
            <select className="rounded-lg border px-2 py-2 text-sm" value={auth?.company?.id || ""} onChange={onCompanyChange}>
              {(auth?.companies || []).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.code || c.name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs">
            <span className="font-medium text-slate-600">Status</span>
            <input className="rounded-lg border px-2 py-2 text-sm" value={status} onChange={(e) => setStatus(e.target.value)} placeholder="Optional" />
          </label>
          <label className="flex flex-col gap-1 text-xs">
            <span className="font-medium text-slate-600">Date from</span>
            <input type="date" className="rounded-lg border px-2 py-2 text-sm" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
          </label>
          <label className="flex flex-col gap-1 text-xs">
            <span className="font-medium text-slate-600">Date to</span>
            <input type="date" className="rounded-lg border px-2 py-2 text-sm" value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
          </label>
          <div className="flex items-end">
            <button type="submit" className="w-full rounded-lg bg-gray-900 px-4 py-2 text-sm font-semibold text-white hover:bg-gray-800">
              Search
            </button>
          </div>
        </div>
        <p className="mt-2 text-xs text-slate-500">
          Tip: search by exact or partial document number, article, part number, customer, supplier, BL/AWB/BOE, or supplier invoice.
        </p>
      </form>

      {searchQ.error ? (
        <div className="mb-3 rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">{searchQ.error.message}</div>
      ) : null}

      <div className="overflow-hidden rounded-2xl border bg-white shadow-sm">
        <div className="border-b px-4 py-2 text-xs text-slate-600">
          {q.trim() ? (
            <>
              {searchQ.isLoading ? "Searching…" : `${total} result(s)`} · Company <strong>{companyCode}</strong>
              {category !== "All" ? <> · Category <strong>{category}</strong></> : null}
            </>
          ) : (
            "Enter a search term to begin."
          )}
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full text-left text-xs">
            <thead className="bg-slate-100 text-[11px] uppercase tracking-wide text-slate-600">
              <tr>
                {["Type", "Document No", "Company", "Date", "Customer/Supplier", "Article", "Part No", "Description", "Status", "Amount/Qty", "Open"].map(
                  (h) => (
                    <th key={h} className="px-2 py-2 whitespace-nowrap">
                      {h}
                    </th>
                  ),
                )}
              </tr>
            </thead>
            <tbody>
              {!q.trim() ? (
                <tr>
                  <td colSpan={11} className="px-3 py-10 text-center text-slate-500">
                    Use the search box above or the header search to find documents across the ERP.
                  </td>
                </tr>
              ) : searchQ.isLoading ? (
                <tr>
                  <td colSpan={11} className="px-3 py-10 text-center text-slate-500">
                    Loading results…
                  </td>
                </tr>
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan={11} className="px-3 py-10 text-center text-slate-500">
                    No matches for &quot;{q}&quot;.
                  </td>
                </tr>
              ) : (
                rows.map((r) => (
                  <tr key={`${r.type}-${r.entityId}-${r.documentNumber}`} className="border-t hover:bg-slate-50/80">
                    <td className="px-2 py-2">
                      <span className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-semibold ring-1 ${typeTone(r.type)}`}>{r.type}</span>
                    </td>
                    <td className="px-2 py-2 font-mono">{r.documentNumber || "—"}</td>
                    <td className="px-2 py-2">{r.company || companyCode}</td>
                    <td className="px-2 py-2 whitespace-nowrap">{fmtDate(r.date)}</td>
                    <td className="px-2 py-2 max-w-[8rem] truncate" title={r.party}>
                      {r.party || "—"}
                    </td>
                    <td className="px-2 py-2 font-mono">{r.article || "—"}</td>
                    <td className="px-2 py-2 font-mono">{r.partNumber || "—"}</td>
                    <td className="px-2 py-2 max-w-[10rem] truncate" title={r.description}>
                      {r.description || "—"}
                    </td>
                    <td className="px-2 py-2">{r.status || "—"}</td>
                    <td className="px-2 py-2 text-right tabular-nums">
                      {r.amount != null ? fmtNum(r.amount) : r.qty != null ? fmtNum(r.qty) : "—"}
                    </td>
                    <td className="px-2 py-2 text-right">
                      {r.openPath ? (
                        <Link to={r.openPath} className="rounded border px-2 py-0.5 text-[11px] font-semibold hover:bg-white">
                          Open
                        </Link>
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        {q.trim() && totalPages > 1 ? (
          <div className="flex items-center justify-between border-t px-4 py-2 text-xs text-slate-600">
            <span>
              Page {page} of {totalPages}
            </span>
            <div className="flex gap-2">
              <button
                type="button"
                className="rounded border px-2 py-1 disabled:opacity-40"
                disabled={page <= 1}
                onClick={() => {
                  const p = Math.max(1, page - 1);
                  setPage(p);
                  syncUrl({ page: p });
                }}
              >
                Previous
              </button>
              <button
                type="button"
                className="rounded border px-2 py-1 disabled:opacity-40"
                disabled={page >= totalPages}
                onClick={() => {
                  const p = page + 1;
                  setPage(p);
                  syncUrl({ page: p });
                }}
              >
                Next
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
