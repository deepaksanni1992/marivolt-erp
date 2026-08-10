import { useCallback, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import PageHeader from "../components/erp/PageHeader.jsx";
import { useAuth } from "../context/AuthContext.jsx";
import { apiGetWithQuery } from "../lib/api.js";
import { downloadCsv } from "../lib/purchaseExport.js";
import { notify } from "../lib/notifications.js";

const MOVEMENT_TYPES = ["", "INBOUND", "OUTBOUND", "ADJUSTMENT", "REVERSAL"];

const CSV_COLUMNS = [
  { key: "date", header: "Date" },
  { key: "movementType", header: "Movement Type" },
  { key: "company", header: "Company" },
  { key: "articleNumber", header: "Article Number" },
  { key: "partNumber", header: "Part Number" },
  { key: "partName", header: "Part Name" },
  { key: "boeNumber", header: "BOE Number" },
  { key: "blNumber", header: "BL Number" },
  { key: "awbNumber", header: "AWB Number" },
  { key: "supplierInvoiceNumber", header: "Supplier Invoice Number" },
  { key: "supplier", header: "Supplier" },
  { key: "qtyIn", header: "Qty In" },
  { key: "qtyOut", header: "Qty Out" },
  { key: "balance", header: "Balance" },
  { key: "customsUnitValue", header: "Customs Unit Value" },
  { key: "customsValue", header: "Customs Value" },
  { key: "currency", header: "Currency" },
  { key: "referenceType", header: "Reference Type" },
  { key: "referenceNumber", header: "Reference Number" },
  { key: "user", header: "User" },
  { key: "remarks", header: "Remarks" },
];

function fmtDate(v) {
  if (!v) return "—";
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toISOString().slice(0, 10);
}

function fmtNum(v, digits = 4) {
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: digits });
}

function optionalNum(v, digits = 4) {
  if (v == null || v === "") return "—";
  return fmtNum(v, digits);
}

function movementTone(type) {
  const s = String(type || "").toUpperCase();
  if (s === "INBOUND") return "bg-emerald-50 text-emerald-800 ring-emerald-200";
  if (s === "OUTBOUND") return "bg-blue-50 text-blue-800 ring-blue-200";
  if (s === "ADJUSTMENT") return "bg-amber-50 text-amber-800 ring-amber-200";
  if (s === "REVERSAL") return "bg-rose-50 text-rose-800 ring-rose-200";
  return "bg-slate-50 text-slate-700 ring-slate-200";
}

export default function CustomsStockLedger() {
  const { auth, selectCompany } = useAuth();
  const [page, setPage] = useState(1);
  const [limit] = useState(50);
  const [articleNumber, setArticleNumber] = useState("");
  const [partNumber, setPartNumber] = useState("");
  const [supplier, setSupplier] = useState("");
  const [boeNumber, setBoeNumber] = useState("");
  const [blNumber, setBlNumber] = useState("");
  const [awbNumber, setAwbNumber] = useState("");
  const [movementType, setMovementType] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [exporting, setExporting] = useState(false);

  const queryParams = useMemo(
    () => ({
      page,
      limit,
      articleNumber: articleNumber.trim() || undefined,
      partNumber: partNumber.trim() || undefined,
      supplier: supplier.trim() || undefined,
      boeNumber: boeNumber.trim() || undefined,
      blNumber: blNumber.trim() || undefined,
      awbNumber: awbNumber.trim() || undefined,
      movementType: movementType || undefined,
      dateFrom: dateFrom || undefined,
      dateTo: dateTo || undefined,
    }),
    [page, limit, articleNumber, partNumber, supplier, boeNumber, blNumber, awbNumber, movementType, dateFrom, dateTo],
  );

  const ledgerQ = useQuery({
    queryKey: ["customs-ledger-page", queryParams, auth?.company?.id],
    queryFn: () => apiGetWithQuery("/customs/ledger", queryParams),
  });

  const rows = ledgerQ.data?.items || [];
  const total = ledgerQ.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const enabled = ledgerQ.data?.enabled !== false;
  const currentCompany = auth?.company?.code || ledgerQ.data?.companyCode || "—";

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
      const data = await apiGetWithQuery("/customs/ledger", {
        ...queryParams,
        page: 1,
        limit: 5000,
        exportAll: true,
      });
      const exportRows = (data.items || []).map((row) => ({
        ...row,
        date: fmtDate(row.date),
        movementType: String(row.movementType || "").replace(/_/g, " "),
        referenceType: String(row.referenceType || "").replace(/_/g, " "),
      }));
      downloadCsv(`customs-stock-ledger-${currentCompany}-${Date.now()}.csv`, CSV_COLUMNS, exportRows);
    } catch (e) {
      notify.error(e.message || "Export failed");
    } finally {
      setExporting(false);
    }
  };

  const resetFilters = () => {
    setArticleNumber("");
    setPartNumber("");
    setSupplier("");
    setBoeNumber("");
    setBlNumber("");
    setAwbNumber("");
    setMovementType("");
    setDateFrom("");
    setDateTo("");
    setPage(1);
  };

  return (
    <div className="p-4 md:p-6">
      <PageHeader
        title="Customs Stock Ledger"
        subtitle="Complete audit trail of customs stock movements — INBOUND, OUTBOUND, ADJUSTMENT, and REVERSAL."
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

      {!enabled && !ledgerQ.isLoading ? (
        <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          Customs module is disabled. Set <code className="font-mono">CUSTOMS_ENABLED=true</code> on the API.
        </div>
      ) : null}

      <div className="mb-4 rounded-2xl border bg-white p-4">
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4 xl:grid-cols-5">
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
            <span className="mb-1 block font-medium text-slate-600">Date from</span>
            <input type="date" className="w-full rounded-lg border px-3 py-2 text-sm" value={dateFrom} onChange={(e) => { setDateFrom(e.target.value); setPage(1); }} />
          </label>
          <label className="block text-xs">
            <span className="mb-1 block font-medium text-slate-600">Date to</span>
            <input type="date" className="w-full rounded-lg border px-3 py-2 text-sm" value={dateTo} onChange={(e) => { setDateTo(e.target.value); setPage(1); }} />
          </label>
          <label className="block text-xs">
            <span className="mb-1 block font-medium text-slate-600">Article</span>
            <input className="w-full rounded-lg border px-3 py-2 text-sm font-mono" value={articleNumber} onChange={(e) => { setArticleNumber(e.target.value); setPage(1); }} />
          </label>
          <label className="block text-xs">
            <span className="mb-1 block font-medium text-slate-600">Part Number</span>
            <input className="w-full rounded-lg border px-3 py-2 text-sm font-mono" value={partNumber} onChange={(e) => { setPartNumber(e.target.value); setPage(1); }} />
          </label>
          <label className="block text-xs">
            <span className="mb-1 block font-medium text-slate-600">Supplier</span>
            <input className="w-full rounded-lg border px-3 py-2 text-sm" value={supplier} onChange={(e) => { setSupplier(e.target.value); setPage(1); }} />
          </label>
          <label className="block text-xs">
            <span className="mb-1 block font-medium text-slate-600">BOE</span>
            <input className="w-full rounded-lg border px-3 py-2 text-sm font-mono" value={boeNumber} onChange={(e) => { setBoeNumber(e.target.value); setPage(1); }} />
          </label>
          <label className="block text-xs">
            <span className="mb-1 block font-medium text-slate-600">BL</span>
            <input className="w-full rounded-lg border px-3 py-2 text-sm font-mono" value={blNumber} onChange={(e) => { setBlNumber(e.target.value); setPage(1); }} />
          </label>
          <label className="block text-xs">
            <span className="mb-1 block font-medium text-slate-600">AWB</span>
            <input className="w-full rounded-lg border px-3 py-2 text-sm font-mono" value={awbNumber} onChange={(e) => { setAwbNumber(e.target.value); setPage(1); }} />
          </label>
          <label className="block text-xs">
            <span className="mb-1 block font-medium text-slate-600">Movement type</span>
            <select className="w-full rounded-lg border px-3 py-2 text-sm" value={movementType} onChange={(e) => { setMovementType(e.target.value); setPage(1); }}>
              <option value="">All</option>
              {MOVEMENT_TYPES.filter(Boolean).map((s) => (
                <option key={s} value={s}>{s.replace(/_/g, " ")}</option>
              ))}
            </select>
          </label>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-slate-500">
          <span>Company <strong>{currentCompany}</strong> · {total} movement(s)</span>
          <button type="button" className="rounded border px-2 py-1 text-slate-700 hover:bg-slate-50" onClick={resetFilters}>
            Reset filters
          </button>
        </div>
      </div>

      {ledgerQ.isError ? (
        <div className="mb-4 rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">
          {ledgerQ.error?.message || "Failed to load customs ledger"}
        </div>
      ) : null}

      <div className="overflow-hidden rounded-2xl border bg-white">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[2400px] text-xs">
            <thead className="bg-slate-100 text-left text-[11px] uppercase tracking-wide text-slate-600">
              <tr>
                <th className="px-2 py-2">Date</th>
                <th className="px-2 py-2">Movement Type</th>
                <th className="px-2 py-2">Company</th>
                <th className="px-2 py-2">Article Number</th>
                <th className="px-2 py-2">Part Number</th>
                <th className="px-2 py-2">Part Name</th>
                <th className="px-2 py-2">BOE Number</th>
                <th className="px-2 py-2">BL Number</th>
                <th className="px-2 py-2">AWB Number</th>
                <th className="px-2 py-2">Supplier Invoice No</th>
                <th className="px-2 py-2">Supplier</th>
                <th className="px-2 py-2 text-right">Qty In</th>
                <th className="px-2 py-2 text-right">Qty Out</th>
                <th className="px-2 py-2 text-right">Balance</th>
                <th className="px-2 py-2 text-right">Customs Unit Value</th>
                <th className="px-2 py-2 text-right">Customs Value</th>
                <th className="px-2 py-2">Currency</th>
                <th className="px-2 py-2">Reference Type</th>
                <th className="px-2 py-2">Reference Number</th>
                <th className="px-2 py-2">User</th>
                <th className="px-2 py-2">Remarks</th>
              </tr>
            </thead>
            <tbody>
              {ledgerQ.isLoading ? (
                <tr>
                  <td colSpan={21} className="px-4 py-8 text-center text-slate-500">Loading ledger…</td>
                </tr>
              ) : rows.length ? (
                rows.map((row) => (
                  <tr key={row._id} className="border-t border-slate-100 hover:bg-slate-50/80">
                    <td className="whitespace-nowrap px-2 py-1.5">{fmtDate(row.date)}</td>
                    <td className="px-2 py-1.5">
                      <span className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-semibold ring-1 ${movementTone(row.movementType)}`}>
                        {String(row.movementType || "").replace(/_/g, " ")}
                      </span>
                    </td>
                    <td className="px-2 py-1.5 font-mono">{row.company || "—"}</td>
                    <td className="px-2 py-1.5 font-mono font-semibold">{row.articleNumber || "—"}</td>
                    <td className="px-2 py-1.5 font-mono">{row.partNumber || "—"}</td>
                    <td className="max-w-[160px] truncate px-2 py-1.5" title={row.partName}>{row.partName || "—"}</td>
                    <td className="px-2 py-1.5 font-mono">{row.boeNumber || "—"}</td>
                    <td className="px-2 py-1.5 font-mono">{row.blNumber || "—"}</td>
                    <td className="px-2 py-1.5 font-mono">{row.awbNumber || "—"}</td>
                    <td className="px-2 py-1.5 font-mono">{row.supplierInvoiceNumber || "—"}</td>
                    <td className="max-w-[160px] truncate px-2 py-1.5" title={row.supplier}>{row.supplier || "—"}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums text-emerald-800">{row.qtyIn > 0 ? fmtNum(row.qtyIn) : "—"}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums text-rose-800">{row.qtyOut > 0 ? fmtNum(row.qtyOut) : "—"}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums font-semibold">{fmtNum(row.balance)}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{optionalNum(row.customsUnitValue, 4)}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{optionalNum(row.customsValue, 2)}</td>
                    <td className="px-2 py-1.5">{row.currency || "—"}</td>
                    <td className="px-2 py-1.5">{String(row.referenceType || "").replace(/_/g, " ") || "—"}</td>
                    <td className="px-2 py-1.5 font-mono">{row.referenceNumber || "—"}</td>
                    <td className="px-2 py-1.5">{row.user || "—"}</td>
                    <td className="max-w-[180px] truncate px-2 py-1.5" title={row.remarks}>{row.remarks || "—"}</td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={21} className="px-4 py-10 text-center text-slate-500">
                    No customs movements yet. Post a GRN with customs data to create INBOUND ledger entries.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 border-t px-4 py-3 text-sm">
          <span className="text-slate-600">Page {page} of {totalPages} · {total} total</span>
          <div className="flex gap-2">
            <button type="button" className="rounded border px-3 py-1.5 disabled:opacity-40" disabled={page <= 1 || ledgerQ.isLoading} onClick={() => setPage((p) => Math.max(1, p - 1))}>
              Previous
            </button>
            <button type="button" className="rounded border px-3 py-1.5 disabled:opacity-40" disabled={page >= totalPages || ledgerQ.isLoading} onClick={() => setPage((p) => p + 1)}>
              Next
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
