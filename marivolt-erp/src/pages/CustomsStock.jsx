import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import PageHeader from "../components/erp/PageHeader.jsx";
import { useAuth } from "../context/AuthContext.jsx";
import { apiGet, apiGetWithQuery } from "../lib/api.js";
import { downloadCsv } from "../lib/purchaseExport.js";
import { notify } from "../lib/notifications.js";

const STATUS_OPTIONS = ["", "OPEN", "CLOSED", "CANCELLED", "IN_STOCK", "PARTIAL", "CONSUMED"];

/** Article-level CSV with BOE economics repeated (Excel reconciliation). */
const CSV_COLUMNS = [
  { key: "boeNumber", header: "BOE No" },
  { key: "boeDate", header: "BOE Date" },
  { key: "supplier", header: "Supplier" },
  { key: "invoiceNo", header: "Supplier Invoice" },
  { key: "blAwb", header: "BL/AWB" },
  { key: "articleNumber", header: "Article" },
  { key: "partNumber", header: "Part Number" },
  { key: "partName", header: "Description" },
  { key: "hsCode", header: "HS Code" },
  { key: "countryOfOrigin", header: "COO" },
  { key: "customsUom", header: "Customs UOM" },
  { key: "customsQtyImported", header: "Imported Customs Qty" },
  { key: "exportedCustomsQty", header: "Exported Customs Qty" },
  { key: "remainingCustomsQty", header: "Remaining Customs Qty" },
  { key: "boeDeclaredQty", header: "BOE Declared Qty" },
  { key: "boeDeclaredValue", header: "BOE Declared Value" },
  { key: "customsUnitValue", header: "BOE Customs Unit Value" },
  { key: "importedCustomsValue", header: "Article Customs Value Imported" },
  { key: "consumedCustomsValue", header: "Consumed Customs Value" },
  { key: "remainingCustomsValue", header: "Remaining Customs Value" },
  { key: "currency", header: "Currency" },
  { key: "valuationMethod", header: "Valuation Method" },
  { key: "grnNo", header: "GRN No" },
  { key: "sourceType", header: "Source Type" },
  { key: "sourceRef", header: "Source Ref" },
  { key: "originalGrnNo", header: "Original GRN" },
  { key: "originalReceivedArticle", header: "Original Received Article" },
  { key: "conversionNo", header: "Conversion No" },
  { key: "conversionStatus", header: "Conversion Status" },
  { key: "status", header: "Status" },
  { key: "companyCode", header: "Company" },
];

function sourceTypeLabel(sourceType) {
  const t = String(sourceType || "").toUpperCase();
  if (t === "ARTICLE_CONVERSION") return "ARTICLE CONVERSION";
  if (t === "GRN") return "GRN";
  if (t === "LEGACY") return "LEGACY";
  if (t === "OTHER") return "OTHER";
  return t || "—";
}

function isConvertedOut(article) {
  return String(article?.conversionStatus || "").toUpperCase() === "CONVERTED_OUT";
}

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

function optionalNum(v, digits = 2) {
  if (v == null || v === "") return "—";
  return fmtNum(v, digits);
}

function money(v, currency) {
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  const cur = currency ? `${currency} ` : "";
  return `${cur}${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function statusTone(status) {
  const s = String(status || "").toUpperCase();
  if (s === "OPEN" || s === "IN_STOCK") return "bg-emerald-50 text-emerald-800 ring-emerald-200";
  if (s === "PARTIAL") return "bg-amber-50 text-amber-800 ring-amber-200";
  if (s === "CLOSED" || s === "CONSUMED") return "bg-slate-100 text-slate-700 ring-slate-200";
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
  const [expanded, setExpanded] = useState(() => new Set());

  const queryParams = useMemo(
    () => ({
      view: "boe",
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
    queryKey: ["customs-stock-boe", queryParams, auth?.company?.id],
    queryFn: () => apiGetWithQuery("/customs/stock", queryParams),
  });

  const groups = stockQ.data?.groups || [];
  const total = stockQ.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const enabled = stockQ.data?.enabled !== false;
  const currentCompany = auth?.company?.code || stockQ.data?.companyCode || "—";

  useEffect(() => {
    // Auto-expand groups that contain an article search match
    const next = new Set();
    for (const g of groups) {
      if (g.hasArticleMatch) next.add(String(g.groupKey || g.customsLotId));
    }
    if (next.size) setExpanded(next);
  }, [groups]);

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

  const toggleExpand = (key) => {
    setExpanded((prev) => {
      const n = new Set(prev);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });
  };

  const exportCsv = async () => {
    setExporting(true);
    try {
      const data = await apiGetWithQuery("/customs/stock", {
        ...queryParams,
        view: "article",
        page: 1,
        limit: 5000,
        exportAll: true,
      });
      const exportRows = (data.items || []).map((row) => ({
        ...row,
        boeDate: fmtDate(row.boeDate || row.date),
        blAwb: [row.blNumber, row.awbNumber].filter(Boolean).join(" / ") || "",
        invoiceNo: row.invoiceNo || row.supplierInvoiceNumber || "",
        exportedCustomsQty: row.exportedCustomsQty ?? row.exportedQty,
        remainingCustomsQty: row.remainingCustomsQty ?? row.remainingQty,
        importedCustomsValue: row.importedCustomsValue ?? row.totalValue,
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
        subtitle="BOE-level customs inventory (Hamriyah Free Zone) — expand for article details. Commercial costing is unchanged."
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
              placeholder="BOE, AWB, BL, article, part, GRN, invoice…"
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
            Showing company <strong>{currentCompany}</strong> · {total} BOE / lot group(s)
          </span>
          <button type="button" className="rounded border px-2 py-1 text-slate-700 hover:bg-slate-50" onClick={resetFilters}>
            Reset filters
          </button>
          <span className="text-slate-400">Grouped by Customs Lot (not BOE number alone).</span>
        </div>
      </div>

      {stockQ.isError ? (
        <div className="mb-4 rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">
          {stockQ.error?.message || "Failed to load customs stock"}
        </div>
      ) : null}

      <div className="overflow-hidden rounded-2xl border bg-white">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1600px] text-xs">
            <thead className="bg-slate-100 text-left text-[11px] uppercase tracking-wide text-slate-600">
              <tr>
                <th className="px-2 py-2 w-10" />
                <th className="px-2 py-2">BOE No</th>
                <th className="px-2 py-2">BOE Date</th>
                <th className="px-2 py-2">BL / AWB</th>
                <th className="px-2 py-2">Supplier</th>
                <th className="px-2 py-2">Supplier Inv.</th>
                <th className="px-2 py-2">Curr</th>
                <th className="px-2 py-2">UOM</th>
                <th className="px-2 py-2 text-right">Declared</th>
                <th className="px-2 py-2 text-right">Exported</th>
                <th className="px-2 py-2 text-right">Remaining</th>
                <th className="px-2 py-2 text-right">Declared Value</th>
                <th className="px-2 py-2 text-right">Unit Value</th>
                <th className="px-2 py-2 text-right">Consumed</th>
                <th className="px-2 py-2 text-right">Remaining Value</th>
                <th className="px-2 py-2 text-right">Gross / Net kg</th>
                <th className="px-2 py-2">Valuation</th>
                <th className="px-2 py-2">Status</th>
                <th className="px-2 py-2">Actions</th>
              </tr>
            </thead>
            <tbody>
              {stockQ.isLoading ? (
                <tr>
                  <td colSpan={19} className="px-4 py-8 text-center text-slate-500">
                    Loading customs stock…
                  </td>
                </tr>
              ) : groups.length ? (
                groups.map((g) => {
                  const key = String(g.groupKey || g.customsLotId);
                  const open = expanded.has(key);
                  const s = g.boeSummary || {};
                  const isLegacy = !g.isBoeAverage;
                  return (
                    <Fragment key={key}>
                      <tr className="border-t border-slate-100 hover:bg-slate-50/80">
                        <td className="px-2 py-1.5">
                          <button
                            type="button"
                            className="rounded border px-1.5 py-0.5 text-[10px] font-semibold"
                            onClick={() => toggleExpand(key)}
                            aria-expanded={open}
                          >
                            {open ? "▾" : "▸"}
                          </button>
                        </td>
                        <td className="px-2 py-1.5 font-mono font-semibold">{g.boeNumber || "—"}</td>
                        <td className="px-2 py-1.5 whitespace-nowrap">{fmtDate(g.boeDate)}</td>
                        <td className="px-2 py-1.5 font-mono">
                          {[g.blNumber, g.awbNumber].filter(Boolean).join(" / ") || "—"}
                        </td>
                        <td className="max-w-[160px] truncate px-2 py-1.5" title={g.supplier}>
                          {g.supplier || "—"}
                        </td>
                        <td className="px-2 py-1.5 font-mono">{g.supplierInvoiceNumber || "—"}</td>
                        <td className="px-2 py-1.5">{g.currency || "—"}</td>
                        <td className="px-2 py-1.5">{g.customsUom || s.customsUom || "—"}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums">
                          {isLegacy ? optionalNum(s.importedQty, 4) : optionalNum(s.declaredQty, 4)}
                        </td>
                        <td className="px-2 py-1.5 text-right tabular-nums">{optionalNum(s.exportedQty, 4)}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums font-semibold text-emerald-800">
                          {optionalNum(s.remainingQty, 4)}
                        </td>
                        <td className="px-2 py-1.5 text-right tabular-nums">
                          {isLegacy ? "—" : money(s.declaredValue, g.currency)}
                        </td>
                        <td className="px-2 py-1.5 text-right tabular-nums">
                          {isLegacy ? "—" : money(s.customsUnitValue, g.currency)}
                        </td>
                        <td className="px-2 py-1.5 text-right tabular-nums">{money(s.consumedValue, g.currency)}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums font-semibold">
                          {money(s.remainingValue, g.currency)}
                        </td>
                        <td className="px-2 py-1.5 text-right tabular-nums">
                          {optionalNum(s.grossWeightKg, 3)} / {optionalNum(s.netWeightKg, 3)}
                        </td>
                        <td className="px-2 py-1.5">
                          {isLegacy ? (
                            <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-700">
                              Legacy Line Value
                            </span>
                          ) : (
                            <span className="rounded bg-sky-50 px-1.5 py-0.5 text-[10px] font-semibold text-sky-800">
                              BOE Average
                            </span>
                          )}
                        </td>
                        <td className="px-2 py-1.5">
                          <span className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-semibold ring-1 ${statusTone(g.status)}`}>
                            {g.status}
                          </span>
                          {g.reconciliation?.warning ? (
                            <div className="mt-1 max-w-[140px] text-[10px] text-amber-700" title={g.reconciliation.warning}>
                              Recon warning
                            </div>
                          ) : null}
                        </td>
                        <td className="px-2 py-1.5">
                          <div className="flex flex-col gap-1">
                            <button
                              type="button"
                              className="rounded border px-1.5 py-0.5 text-[10px] font-semibold hover:bg-slate-50"
                              onClick={() => toggleExpand(key)}
                            >
                              {open ? "Hide Articles" : "View Articles"}
                            </button>
                            <button
                              type="button"
                              className="rounded border px-1.5 py-0.5 text-[10px] font-semibold hover:bg-slate-50 disabled:opacity-40"
                              disabled={!g.documents?.blDocumentId}
                              onClick={() => openDocument(g.documents?.blDocumentId)}
                            >
                              View BL Copy
                            </button>
                            <button
                              type="button"
                              className="rounded border px-1.5 py-0.5 text-[10px] font-semibold hover:bg-slate-50 disabled:opacity-40"
                              disabled={!g.documents?.supplierInvoiceDocumentId}
                              onClick={() => openDocument(g.documents?.supplierInvoiceDocumentId)}
                            >
                              View Supplier Invoice
                            </button>
                            <button
                              type="button"
                              className="rounded border px-1.5 py-0.5 text-[10px] font-semibold hover:bg-slate-50 disabled:opacity-40"
                              disabled={!g.grnNo}
                              onClick={() => nav(`/store?tab=GRN&grnNo=${encodeURIComponent(g.grnNo)}`)}
                            >
                              View GRN
                            </button>
                          </div>
                        </td>
                      </tr>
                      {open ? (
                        <tr className="bg-slate-50/90">
                          <td colSpan={19} className="px-4 py-3">
                            <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                              Articles in lot {g.customsLotRef || key}
                              {isLegacy ? " · Valuation: Legacy Line Value (no BOE-average economics)" : ""}
                            </div>
                            <table className="w-full min-w-[1280px] text-xs">
                              <thead className="text-left text-[10px] uppercase text-slate-500">
                                <tr>
                                  <th className="px-2 py-1">Article</th>
                                  <th className="px-2 py-1">Part</th>
                                  <th className="px-2 py-1">Description</th>
                                  <th className="px-2 py-1">HS / COO</th>
                                  <th className="px-2 py-1">Source</th>
                                  <th className="px-2 py-1">Original GRN</th>
                                  <th className="px-2 py-1 text-right">Physical GRN Qty</th>
                                  <th className="px-2 py-1 text-right">Imported</th>
                                  <th className="px-2 py-1 text-right">Exported</th>
                                  <th className="px-2 py-1 text-right">Balance</th>
                                  <th className="px-2 py-1 text-right">Customs Unit</th>
                                  <th className="px-2 py-1 text-right">Imported Value</th>
                                  <th className="px-2 py-1 text-right">Consumed</th>
                                  <th className="px-2 py-1 text-right">Remaining Value</th>
                                  <th className="px-2 py-1">Actions</th>
                                </tr>
                              </thead>
                              <tbody>
                                {(g.articles || []).map((a) => {
                                  const convertedOut = isConvertedOut(a);
                                  const isConversion =
                                    String(a.sourceType || "").toUpperCase() === "ARTICLE_CONVERSION";
                                  const originalGrn = a.originalGrnNo || a.grnNo || "";
                                  const tip =
                                    a.provenanceTooltip ||
                                    (a.originalReceivedArticle
                                      ? `Original received article: ${a.originalReceivedArticle}`
                                      : "");
                                  return (
                                  <tr
                                    key={String(a._id)}
                                    className={`border-t border-slate-200 ${a.matchHighlight ? "bg-amber-50" : ""}`}
                                    title={tip || undefined}
                                  >
                                    <td className="px-2 py-1 font-mono font-semibold">
                                      <div>{a.articleNumber || "—"}</div>
                                      {convertedOut ? (
                                        <span className="mt-0.5 inline-flex rounded-full bg-violet-50 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-violet-800 ring-1 ring-violet-200">
                                          Converted Out
                                        </span>
                                      ) : null}
                                    </td>
                                    <td className="px-2 py-1 font-mono">{a.partNumber || "—"}</td>
                                    <td className="max-w-[160px] truncate px-2 py-1" title={a.partName}>
                                      {a.partName || "—"}
                                    </td>
                                    <td className="px-2 py-1 font-mono">
                                      {a.hsCode || "—"} / {a.countryOfOrigin || "—"}
                                    </td>
                                    <td className="px-2 py-1">
                                      <div className="font-semibold text-slate-800">
                                        {sourceTypeLabel(a.sourceType)}
                                      </div>
                                      <div className="font-mono text-[11px] text-slate-600">
                                        {a.sourceRef || "—"}
                                      </div>
                                      {isConversion && a.originalReceivedArticle ? (
                                        <div className="mt-0.5 text-[10px] text-slate-500">
                                          from {a.originalReceivedArticle}
                                        </div>
                                      ) : null}
                                    </td>
                                    <td className="px-2 py-1 font-mono">{originalGrn || "—"}</td>
                                    <td className="px-2 py-1 text-right tabular-nums">
                                      {fmtNum(a.physicalQtyImported, 4)}
                                    </td>
                                    <td className="px-2 py-1 text-right tabular-nums">
                                      {fmtNum(a.customsQtyImported, 4)}
                                    </td>
                                    <td className="px-2 py-1 text-right tabular-nums">
                                      {fmtNum(a.exportedCustomsQty, 4)}
                                    </td>
                                    <td className="px-2 py-1 text-right tabular-nums font-semibold text-emerald-800">
                                      {fmtNum(a.remainingCustomsQty, 4)}
                                    </td>
                                    <td className="px-2 py-1 text-right tabular-nums">
                                      {money(a.customsUnitValue, g.currency)}
                                    </td>
                                    <td className="px-2 py-1 text-right tabular-nums">
                                      {money(a.importedCustomsValue, g.currency)}
                                    </td>
                                    <td className="px-2 py-1 text-right tabular-nums">
                                      {money(a.consumedCustomsValue, g.currency)}
                                    </td>
                                    <td className="px-2 py-1 text-right tabular-nums font-semibold">
                                      {money(a.remainingCustomsValue, g.currency)}
                                    </td>
                                    <td className="px-2 py-1">
                                      <div className="flex flex-col gap-1">
                                        {isConversion || convertedOut ? (
                                          <>
                                            <button
                                              type="button"
                                              className="rounded border px-1.5 py-0.5 text-[10px] font-semibold disabled:opacity-40"
                                              disabled={!(a.conversionNo || (isConversion && a.sourceRef))}
                                              onClick={() =>
                                                nav(
                                                  `/store?tab=${encodeURIComponent("Article Stock Conversion")}&conversionNo=${encodeURIComponent(a.conversionNo || a.sourceRef || "")}`,
                                                )
                                              }
                                            >
                                              View Conversion
                                            </button>
                                            <button
                                              type="button"
                                              className="rounded border px-1.5 py-0.5 text-[10px] font-semibold disabled:opacity-40"
                                              disabled={!originalGrn}
                                              onClick={() =>
                                                nav(`/store?tab=GRN&grnNo=${encodeURIComponent(originalGrn)}`)
                                              }
                                            >
                                              View Original GRN
                                            </button>
                                          </>
                                        ) : (
                                          <button
                                            type="button"
                                            className="rounded border px-1.5 py-0.5 text-[10px] font-semibold disabled:opacity-40"
                                            disabled={!originalGrn}
                                            onClick={() =>
                                              nav(`/store?tab=GRN&grnNo=${encodeURIComponent(originalGrn)}`)
                                            }
                                          >
                                            View GRN
                                          </button>
                                        )}
                                      </div>
                                    </td>
                                  </tr>
                                  );
                                })}
                              </tbody>
                            </table>
                          </td>
                        </tr>
                      ) : null}
                    </Fragment>
                  );
                })
              ) : (
                <tr>
                  <td colSpan={19} className="px-4 py-10 text-center text-slate-500">
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
