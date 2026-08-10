import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import PageHeader from "../components/erp/PageHeader.jsx";
import { useAuth } from "../context/AuthContext.jsx";
import { apiGet, apiGetWithQuery } from "../lib/api.js";
import { downloadCsv } from "../lib/purchaseExport.js";
import { notify } from "../lib/notifications.js";

const STATUS_OPTIONS = ["", "IN_STOCK", "PARTIAL", "CONSUMED", "CANCELLED"];

const CSV_COLUMNS = [
  { key: "srNo", header: "Sr No" },
  { key: "boeNumber", header: "BOE No" },
  { key: "awbNumber", header: "AWB No" },
  { key: "date", header: "Date" },
  { key: "supplier", header: "Supplier" },
  { key: "invoiceNo", header: "Invoice No" },
  { key: "countryOfOrigin", header: "COO" },
  { key: "articleNumber", header: "Article Number" },
  { key: "partName", header: "Part Name" },
  { key: "partNumber", header: "Part Number" },
  { key: "hsCode", header: "HS Code" },
  { key: "currency", header: "Currency" },
  { key: "boeDeclaredQty", header: "BOE Declared Qty" },
  { key: "boeDeclaredValue", header: "BOE Declared Value" },
  { key: "customsUnitValue", header: "BOE Customs Unit Value" },
  { key: "unitPrice", header: "Unit Price" },
  { key: "qtyImported", header: "Qty Imported" },
  { key: "weightKg", header: "Weight in KG" },
  { key: "totalValue", header: "Total Value" },
  { key: "customsStock", header: "Customs Stock" },
  { key: "customsStockBalance", header: "Customs Stock Balance" },
  { key: "remarks1", header: "Remarks 1" },
  { key: "remarks2", header: "Remarks 2" },
  { key: "status", header: "Status" },
  { key: "grnNo", header: "GRN No" },
  { key: "companyCode", header: "Company" },
];

function fmtDate(v) {
  if (!v) return "—";
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toISOString().slice(0, 10);
}

function fmtNum(v, digits = 2) {
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: digits });
}

function boeCustomsUnit(row) {
  const n = Number(row?.customsUnitValue ?? row?.unitPrice);
  return Number.isFinite(n) ? n : null;
}

function optionalNum(v, digits = 2) {
  if (v == null || v === "") return "—";
  return fmtNum(v, digits);
}

function statusTone(status) {
  const s = String(status || "").toUpperCase();
  if (s === "IN_STOCK") return "bg-emerald-50 text-emerald-800 ring-emerald-200";
  if (s === "PARTIAL") return "bg-amber-50 text-amber-800 ring-amber-200";
  if (s === "CONSUMED") return "bg-slate-100 text-slate-700 ring-slate-200";
  if (s === "CANCELLED") return "bg-rose-50 text-rose-800 ring-rose-200";
  return "bg-slate-50 text-slate-700 ring-slate-200";
}

async function openDocument(documentId) {
  if (!documentId) return;
  try {
    const { url } = await apiGet(`/documents/${documentId}/download?inline=1`);
    if (url) window.open(url, "_blank", "noopener,noreferrer");
  } catch (e) {
    notify.error(e.message || "Could not open document");
  }
}

export default function CustomsStock() {
  const nav = useNavigate();
  const [searchParams] = useSearchParams();
  const { auth, selectCompany } = useAuth();
  const [page, setPage] = useState(1);
  const [limit] = useState(50);
  const [search, setSearch] = useState("");
  const [supplier, setSupplier] = useState("");
  const [countryOfOrigin, setCountryOfOrigin] = useState("");
  const [status, setStatus] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [exporting, setExporting] = useState(false);

  const queryParams = useMemo(
    () => ({
      page,
      limit,
      search: search.trim() || undefined,
      articleNumber: searchParams.get("articleNumber") || undefined,
      supplier: supplier.trim() || undefined,
      countryOfOrigin: countryOfOrigin.trim() || undefined,
      status: status || undefined,
      dateFrom: dateFrom || undefined,
      dateTo: dateTo || undefined,
    }),
    [page, limit, search, supplier, countryOfOrigin, status, dateFrom, dateTo, searchParams],
  );

  useEffect(() => {
    const q = searchParams.get("search") || searchParams.get("q");
    const article = searchParams.get("articleNumber");
    if (q) setSearch(q);
    else if (article) setSearch(article);
  }, [searchParams]);

  const stockQ = useQuery({
    queryKey: ["customs-stock-page", queryParams, auth?.company?.id],
    queryFn: () => apiGetWithQuery("/customs/stock", queryParams),
  });

  const rows = stockQ.data?.items || [];
  const total = stockQ.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const enabled = stockQ.data?.enabled !== false;
  const currentCompany = auth?.company?.code || stockQ.data?.companyCode || "—";

  const onCompanyChange = useCallback(
    async (e) => {
      const nextId = e.target.value;
      if (!nextId || nextId === auth?.company?.id) return;
      try {
        await selectCompany(nextId);
        setPage(1);
      } catch (err) {
        notify.error(err.message || "Failed to switch company");
      }
    },
    [auth?.company?.id, selectCompany],
  );

  const exportCsv = async () => {
    setExporting(true);
    try {
      const data = await apiGetWithQuery("/customs/stock", {
        ...queryParams,
        page: 1,
        limit: 5000,
        exportAll: true,
      });
      const exportRows = (data.items || []).map((row) => ({
        ...row,
        date: fmtDate(row.date),
        boeDeclaredQty: row.boeDeclaredQty,
        boeDeclaredValue: row.boeDeclaredValue,
        customsUnitValue: boeCustomsUnit(row),
        unitPrice: row.unitPrice,
        qtyImported: row.qtyImported,
        weightKg: row.weightKg,
        totalValue: row.totalValue,
        customsStock: row.customsStock,
        customsStockBalance: row.customsStockBalance,
      }));
      downloadCsv(`customs-stock-${currentCompany}-${Date.now()}.csv`, CSV_COLUMNS, exportRows);
    } catch (e) {
      notify.error(e.message || "Export failed");
    } finally {
      setExporting(false);
    }
  };

  const resetFilters = () => {
    setSearch("");
    setSupplier("");
    setCountryOfOrigin("");
    setStatus("");
    setDateFrom("");
    setDateTo("");
    setPage(1);
  };

  return (
    <div className="p-4 md:p-6">
      <PageHeader
        title="Customs Stock"
        subtitle="Inbound customs inventory from posted GRNs — company-scoped stock register."
      >
        <button
          type="button"
          className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-800 hover:bg-slate-50 disabled:opacity-40"
          disabled={exporting || !enabled}
          onClick={exportCsv}
        >
          {exporting ? "Exporting…" : "Export CSV"}
        </button>
      </PageHeader>

      {!enabled && !stockQ.isLoading ? (
        <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          Customs module is disabled on this server. Set <code className="font-mono">CUSTOMS_ENABLED=true</code> on the
          API to use this page.
        </div>
      ) : null}

      <div className="mb-4 rounded-2xl border bg-white p-4">
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4 xl:grid-cols-6">
          <label className="block text-xs lg:col-span-2">
            <span className="mb-1 block font-medium text-slate-600">Search</span>
            <input
              className="w-full rounded-lg border px-3 py-2 text-sm"
              placeholder="BOE, AWB, article, part, GRN, invoice…"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
            />
          </label>
          <label className="block text-xs">
            <span className="mb-1 block font-medium text-slate-600">Company</span>
            <select
              className="w-full rounded-lg border px-3 py-2 text-sm"
              value={auth?.company?.id || ""}
              onChange={onCompanyChange}
            >
              {(auth?.companies || (auth?.company ? [auth.company] : [])).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} ({c.code})
                </option>
              ))}
            </select>
          </label>
          <label className="block text-xs">
            <span className="mb-1 block font-medium text-slate-600">Supplier</span>
            <input
              className="w-full rounded-lg border px-3 py-2 text-sm"
              value={supplier}
              onChange={(e) => {
                setSupplier(e.target.value);
                setPage(1);
              }}
            />
          </label>
          <label className="block text-xs">
            <span className="mb-1 block font-medium text-slate-600">COO</span>
            <input
              className="w-full rounded-lg border px-3 py-2 text-sm uppercase"
              value={countryOfOrigin}
              onChange={(e) => {
                setCountryOfOrigin(e.target.value.toUpperCase());
                setPage(1);
              }}
            />
          </label>
          <label className="block text-xs">
            <span className="mb-1 block font-medium text-slate-600">Status</span>
            <select
              className="w-full rounded-lg border px-3 py-2 text-sm"
              value={status}
              onChange={(e) => {
                setStatus(e.target.value);
                setPage(1);
              }}
            >
              <option value="">All</option>
              {STATUS_OPTIONS.filter(Boolean).map((s) => (
                <option key={s} value={s}>
                  {s.replace(/_/g, " ")}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-xs">
            <span className="mb-1 block font-medium text-slate-600">Date from</span>
            <input
              type="date"
              className="w-full rounded-lg border px-3 py-2 text-sm"
              value={dateFrom}
              onChange={(e) => {
                setDateFrom(e.target.value);
                setPage(1);
              }}
            />
          </label>
          <label className="block text-xs">
            <span className="mb-1 block font-medium text-slate-600">Date to</span>
            <input
              type="date"
              className="w-full rounded-lg border px-3 py-2 text-sm"
              value={dateTo}
              onChange={(e) => {
                setDateTo(e.target.value);
                setPage(1);
              }}
            />
          </label>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-slate-500">
          <span>
            Showing company <strong>{currentCompany}</strong> · {total} record(s)
          </span>
          <button type="button" className="rounded border px-2 py-1 text-slate-700 hover:bg-slate-50" onClick={resetFilters}>
            Reset filters
          </button>
          {/* BOE lot-level grouping / declared-value rollups deferred — per-line economics shown when API provides them. */}
          <span className="text-slate-400">BOE declared totals are per lot when available; line grouping not shown here.</span>
        </div>
      </div>

      {stockQ.isError ? (
        <div className="mb-4 rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">
          {stockQ.error?.message || "Failed to load customs stock"}
        </div>
      ) : null}

      <div className="overflow-hidden rounded-2xl border bg-white">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[2500px] text-xs">
            <thead className="bg-slate-100 text-left text-[11px] uppercase tracking-wide text-slate-600">
              <tr>
                <th className="sticky left-0 z-10 bg-slate-100 px-2 py-2">Sr No</th>
                <th className="px-2 py-2">BOE No</th>
                <th className="px-2 py-2">AWB No</th>
                <th className="px-2 py-2">Date</th>
                <th className="px-2 py-2">Supplier</th>
                <th className="px-2 py-2">Invoice No</th>
                <th className="px-2 py-2">COO</th>
                <th className="px-2 py-2">Article Number</th>
                <th className="px-2 py-2">Part Name</th>
                <th className="px-2 py-2">Part Number</th>
                <th className="px-2 py-2">HS Code</th>
                <th className="px-2 py-2">Currency</th>
                <th className="px-2 py-2 text-right">BOE Decl. Qty</th>
                <th className="px-2 py-2 text-right">BOE Decl. Value</th>
                <th className="px-2 py-2 text-right">BOE Customs Unit</th>
                <th className="px-2 py-2 text-right">Unit Price</th>
                <th className="px-2 py-2 text-right">Qty Imported</th>
                <th className="px-2 py-2 text-right">Weight KG</th>
                <th className="px-2 py-2 text-right">Total Value</th>
                <th className="px-2 py-2 text-right">Customs Stock</th>
                <th className="px-2 py-2 text-right">Customs Stock Balance</th>
                <th className="px-2 py-2">Remarks 1</th>
                <th className="px-2 py-2">Remarks 2</th>
                <th className="px-2 py-2">Status</th>
                <th className="sticky right-0 z-10 bg-slate-100 px-2 py-2">Actions</th>
              </tr>
            </thead>
            <tbody>
              {stockQ.isLoading ? (
                <tr>
                  <td colSpan={25} className="px-4 py-8 text-center text-slate-500">
                    Loading customs stock…
                  </td>
                </tr>
              ) : rows.length ? (
                rows.map((row) => (
                  <tr key={row._id} className="border-t border-slate-100 hover:bg-slate-50/80">
                    <td className="sticky left-0 z-[1] bg-white px-2 py-1.5 tabular-nums">{row.srNo}</td>
                    <td className="px-2 py-1.5 font-mono">{row.boeNumber || "—"}</td>
                    <td className="px-2 py-1.5 font-mono">{row.awbNumber || "—"}</td>
                    <td className="px-2 py-1.5 whitespace-nowrap">{fmtDate(row.date)}</td>
                    <td className="max-w-[180px] truncate px-2 py-1.5" title={row.supplier}>
                      {row.supplier || "—"}
                    </td>
                    <td className="px-2 py-1.5 font-mono">{row.invoiceNo || "—"}</td>
                    <td className="px-2 py-1.5">{row.countryOfOrigin || "—"}</td>
                    <td className="px-2 py-1.5 font-mono font-semibold">{row.articleNumber || "—"}</td>
                    <td className="max-w-[160px] truncate px-2 py-1.5" title={row.partName}>
                      {row.partName || "—"}
                    </td>
                    <td className="px-2 py-1.5 font-mono">{row.partNumber || "—"}</td>
                    <td className="px-2 py-1.5 font-mono">{row.hsCode || "—"}</td>
                    <td className="px-2 py-1.5">{row.currency || "—"}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{optionalNum(row.boeDeclaredQty, 4)}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{optionalNum(row.boeDeclaredValue, 2)}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{optionalNum(boeCustomsUnit(row), 4)}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{fmtNum(row.unitPrice, 4)}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{fmtNum(row.qtyImported, 4)}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{fmtNum(row.weightKg, 4)}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{fmtNum(row.totalValue, 2)}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{fmtNum(row.customsStock, 4)}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums font-semibold text-emerald-800">
                      {fmtNum(row.customsStockBalance, 4)}
                    </td>
                    <td className="max-w-[120px] truncate px-2 py-1.5" title={row.remarks1}>
                      {row.remarks1 || "—"}
                    </td>
                    <td className="max-w-[120px] truncate px-2 py-1.5" title={row.remarks2}>
                      {row.remarks2 || "—"}
                    </td>
                    <td className="px-2 py-1.5">
                      <span className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-semibold ring-1 ${statusTone(row.status)}`}>
                        {String(row.status || "").replace(/_/g, " ")}
                      </span>
                    </td>
                    <td className="sticky right-0 z-[1] bg-white px-2 py-1.5">
                      <div className="flex flex-col gap-1">
                        <button
                          type="button"
                          className="rounded border px-1.5 py-0.5 text-[10px] font-semibold text-slate-800 hover:bg-slate-50 disabled:opacity-40"
                          disabled={!row.documents?.blDocumentId}
                          onClick={() => openDocument(row.documents?.blDocumentId)}
                        >
                          View BL Copy
                        </button>
                        <button
                          type="button"
                          className="rounded border px-1.5 py-0.5 text-[10px] font-semibold text-slate-800 hover:bg-slate-50 disabled:opacity-40"
                          disabled={!row.documents?.supplierInvoiceDocumentId}
                          onClick={() => openDocument(row.documents?.supplierInvoiceDocumentId)}
                        >
                          View Supplier Invoice
                        </button>
                        <button
                          type="button"
                          className="rounded border px-1.5 py-0.5 text-[10px] font-semibold text-slate-800 hover:bg-slate-50 disabled:opacity-40"
                          disabled={!row.grnNo}
                          onClick={() => nav(`/store?tab=GRN&grnNo=${encodeURIComponent(row.grnNo)}`)}
                        >
                          View GRN
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={25} className="px-4 py-10 text-center text-slate-500">
                    No customs stock records. Post a GRN with customs information to create inbound stock.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 border-t px-4 py-3 text-sm">
          <span className="text-slate-600">
            Page {page} of {totalPages} · {total} total
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              className="rounded border px-3 py-1.5 disabled:opacity-40"
              disabled={page <= 1 || stockQ.isLoading}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              Previous
            </button>
            <button
              type="button"
              className="rounded border px-3 py-1.5 disabled:opacity-40"
              disabled={page >= totalPages || stockQ.isLoading}
              onClick={() => setPage((p) => p + 1)}
            >
              Next
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
