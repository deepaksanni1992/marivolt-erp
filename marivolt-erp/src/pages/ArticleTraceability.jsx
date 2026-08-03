import { useCallback, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import PageHeader from "../components/erp/PageHeader.jsx";
import { useAuth } from "../context/AuthContext.jsx";
import { apiGet, apiGetWithQuery } from "../lib/api.js";
import { downloadCsv, downloadPdfTable } from "../lib/purchaseExport.js";
import { notify } from "../lib/notifications.js";

const DOC_TYPES = ["", "PO", "GRN", "Customs Lot", "Customs Ledger", "Sales Invoice", "Customs Invoice", "Dispatch"];

const FLOW_COLORS = {
  linked: "bg-emerald-500 border-emerald-600 text-white",
  pending: "bg-amber-400 border-amber-500 text-amber-950",
  missing: "bg-rose-500 border-rose-600 text-white",
  na: "bg-slate-300 border-slate-400 text-slate-700",
};

const TIMELINE_COLUMNS = [
  { key: "date", header: "Date" },
  { key: "stage", header: "Stage" },
  { key: "documentType", header: "Document Type" },
  { key: "documentNumber", header: "Document Number" },
  { key: "party", header: "Customer / Supplier" },
  { key: "qtyIn", header: "Qty In" },
  { key: "qtyOut", header: "Qty Out" },
  { key: "balance", header: "Balance" },
  { key: "status", header: "Status" },
  { key: "linkedDocument", header: "Linked Document" },
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

async function openDocument(documentId) {
  if (!documentId) return;
  try {
    const { url } = await apiGet(`/documents/${documentId}/download?inline=1`);
    if (url) window.open(url, "_blank", "noopener,noreferrer");
  } catch (e) {
    notify.error(e.message || "Could not open document");
  }
}

function SummaryCard({ summary }) {
  if (!summary) return null;
  const fields = [
    ["Company", summary.company],
    ["Article Number", summary.articleNumber],
    ["Part Number", summary.partNumber],
    ["Description", summary.description],
    ["Brand", summary.brand],
    ["Model", summary.model],
    ["Config", summary.config],
    ["Total PO Qty", fmtNum(summary.totalPoQty)],
    ["Total GRN Qty", fmtNum(summary.totalGrnQty)],
    ["ERP On Hand", fmtNum(summary.erpOnHandQty ?? summary.erpStockQty)],
    ["Reserved", fmtNum(summary.erpReservedQty)],
    ["Packed", fmtNum(summary.erpPackedQty)],
    ["Free Available", fmtNum(summary.erpFreeAvailableQty)],
    ["Customs Available", fmtNum(summary.customsAvailableQty ?? summary.customsStockQty)],
    ["Total Sold Qty", fmtNum(summary.totalSoldQty)],
    ["Pending Dispatch Qty", fmtNum(summary.pendingDispatchQty)],
  ];
  return (
    <div className="mb-4 rounded-2xl border bg-white p-4 shadow-sm">
      <h2 className="mb-3 text-sm font-semibold text-slate-800">Article Summary</h2>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {fields.map(([label, value]) => (
          <div key={label} className="rounded-lg border bg-slate-50 px-3 py-2">
            <div className="text-[10px] font-medium uppercase tracking-wide text-slate-500">{label}</div>
            <div className="mt-0.5 text-sm font-semibold text-slate-900">{value ?? "—"}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function FlowChain({ flow = [] }) {
  if (!flow.length) return null;
  return (
    <div className="mb-4 overflow-x-auto rounded-2xl border bg-white p-4 shadow-sm">
      <h2 className="mb-3 text-sm font-semibold text-slate-800">Document Flow</h2>
      <div className="flex min-w-max items-center gap-1">
        {flow.map((step, idx) => (
          <div key={step.stage} className="flex items-center">
            <div
              className={[
                "rounded-lg border px-3 py-2 text-center text-[11px] font-semibold shadow-sm",
                FLOW_COLORS[step.status] || FLOW_COLORS.na,
              ].join(" ")}
              title={`${step.label}: ${step.documentNumber}`}
            >
              <div className="text-[10px] opacity-90">{step.label}</div>
              <div className="mt-0.5 max-w-[120px] truncate">{step.documentNumber}</div>
            </div>
            {idx < flow.length - 1 ? <span className="px-1 text-slate-400">→</span> : null}
          </div>
        ))}
      </div>
      <div className="mt-3 flex flex-wrap gap-3 text-[10px] text-slate-600">
        <span className="flex items-center gap-1"><span className="h-2 w-2 rounded bg-emerald-500" /> Linked</span>
        <span className="flex items-center gap-1"><span className="h-2 w-2 rounded bg-amber-400" /> Pending</span>
        <span className="flex items-center gap-1"><span className="h-2 w-2 rounded bg-rose-500" /> Missing</span>
        <span className="flex items-center gap-1"><span className="h-2 w-2 rounded bg-slate-300" /> N/A</span>
      </div>
    </div>
  );
}

function DataTable({ title, columns, rows, emptyText = "No records." }) {
  return (
    <div className="overflow-hidden rounded-2xl border bg-white shadow-sm">
      <div className="border-b px-4 py-2 text-sm font-semibold text-slate-800">{title}</div>
      <div className="overflow-x-auto">
        <table className="min-w-full text-left text-xs">
          <thead className="bg-slate-100 text-[11px] uppercase tracking-wide text-slate-600">
            <tr>
              {columns.map((c) => (
                <th key={c.key || c.header} className="px-2 py-2 whitespace-nowrap">
                  {c.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {!rows.length ? (
              <tr>
                <td colSpan={columns.length} className="px-3 py-8 text-center text-slate-500">
                  {emptyText}
                </td>
              </tr>
            ) : (
              rows.map((row, i) => (
                <tr key={row._key || i} className="border-t hover:bg-slate-50">
                  {columns.map((c) => (
                    <td key={c.key} className="px-2 py-1.5 whitespace-nowrap">
                      {c.render ? c.render(row) : row[c.key] ?? "—"}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function ArticleTraceability() {
  const [searchParams, setSearchParams] = useSearchParams();
  const { auth, selectCompany } = useAuth();

  const [q, setQ] = useState(searchParams.get("q") || "");
  const [articleNumber, setArticleNumber] = useState(searchParams.get("articleNumber") || "");
  const [partNumber, setPartNumber] = useState(searchParams.get("partNumber") || "");
  const [customer, setCustomer] = useState(searchParams.get("customer") || "");
  const [supplier, setSupplier] = useState(searchParams.get("supplier") || "");
  const [documentType, setDocumentType] = useState(searchParams.get("documentType") || "");
  const [status, setStatus] = useState(searchParams.get("status") || "");
  const [dateFrom, setDateFrom] = useState(searchParams.get("dateFrom") || "");
  const [dateTo, setDateTo] = useState(searchParams.get("dateTo") || "");
  const [exporting, setExporting] = useState(false);
  const [submitted, setSubmitted] = useState(!!(searchParams.get("q") || searchParams.get("articleNumber")));

  const syncUrl = useCallback(
    (vals) => {
      const params = new URLSearchParams();
      Object.entries(vals).forEach(([k, v]) => {
        if (v && String(v).trim()) params.set(k, String(v).trim());
      });
      setSearchParams(params, { replace: true });
    },
    [setSearchParams],
  );

  const queryParams = useMemo(
    () => ({
      q: q.trim() || undefined,
      articleNumber: articleNumber.trim() || undefined,
      partNumber: partNumber.trim() || undefined,
      customer: customer.trim() || undefined,
      supplier: supplier.trim() || undefined,
      documentType: documentType || undefined,
      status: status.trim() || undefined,
      dateFrom: dateFrom || undefined,
      dateTo: dateTo || undefined,
    }),
    [q, articleNumber, partNumber, customer, supplier, documentType, status, dateFrom, dateTo],
  );

  const hasQuery = !!(queryParams.q || queryParams.articleNumber);

  const traceQ = useQuery({
    queryKey: ["article-traceability", queryParams, auth?.company?.id],
    queryFn: () => apiGetWithQuery("/traceability/article", queryParams),
    enabled: submitted && hasQuery,
  });

  const data = traceQ.data;
  const companyCode = auth?.company?.code || data?.companyCode || "—";

  const runSearch = (e) => {
    e?.preventDefault?.();
    if (!q.trim() && !articleNumber.trim()) {
      notify.warning("Enter article number or a search term");
      return;
    }
    setSubmitted(true);
    syncUrl(queryParams);
  };

  const onCompanyChange = async (e) => {
    const nextId = e.target.value;
    if (!nextId || nextId === auth?.company?.id) return;
    try {
      await selectCompany(nextId);
    } catch (err) {
      notify.error(err.message || "Failed to switch company");
    }
  };

  const exportAll = async (kind) => {
    if (!data?.found) return;
    setExporting(true);
    try {
      const base = `article-traceability-${data.summary?.articleNumber || "search"}-${companyCode}-${Date.now()}`;
      const timelineRows = (data.timeline || []).map((r) => ({
        ...r,
        date: fmtDate(r.date),
        qtyIn: r.qtyIn != null ? r.qtyIn : "",
        qtyOut: r.qtyOut != null ? r.qtyOut : "",
        balance: r.balance != null ? r.balance : "",
      }));

      if (kind === "csv") {
        downloadCsv(`${base}.csv`, TIMELINE_COLUMNS, timelineRows);
        return;
      }

      const summaryLines = data.summary
        ? Object.entries(data.summary).map(([k, v]) => ({ field: k, value: v }))
        : [];
      await downloadPdfTable(
        "Article Traceability",
        `${companyCode} · ${data.summary?.articleNumber || q}`,
        [
          { key: "field", header: "Summary Field" },
          { key: "value", header: "Value" },
        ],
        summaryLines,
        base,
        auth?.company,
      );

      const sections = [
        { title: "Timeline", cols: TIMELINE_COLUMNS, rows: timelineRows },
        {
          title: "Purchase",
          cols: [
            { key: "poNumber", header: "PO Number" },
            { key: "supplier", header: "Supplier" },
            { key: "poDate", header: "PO Date" },
            { key: "qtyOrdered", header: "Qty Ordered" },
            { key: "grnNumber", header: "GRN Number" },
            { key: "qtyReceived", header: "Qty Received" },
            { key: "supplierInvoiceNumber", header: "Supplier Invoice" },
          ],
          rows: (data.purchase || []).map((r) => ({ ...r, poDate: fmtDate(r.poDate) })),
        },
        {
          title: "Customs",
          cols: [
            { key: "boeNumber", header: "BOE" },
            { key: "blNumber", header: "BL" },
            { key: "supplierInvoiceNumber", header: "Supplier Invoice" },
            { key: "qtyImported", header: "Qty Imported" },
            { key: "qtyAvailable", header: "Qty Available" },
            { key: "status", header: "Status" },
          ],
          rows: data.customs || [],
        },
        {
          title: "Sales",
          cols: [
            { key: "salesInvoiceNumber", header: "Sales Invoice" },
            { key: "customer", header: "Customer" },
            { key: "invoiceDate", header: "Invoice Date" },
            { key: "qtySold", header: "Qty Sold" },
            { key: "customsInvoiceNumber", header: "Customs Invoice" },
            { key: "dispatchStatus", header: "Dispatch Status" },
          ],
          rows: (data.sales || []).map((r) => ({ ...r, invoiceDate: fmtDate(r.invoiceDate) })),
        },
      ];

      for (const sec of sections) {
        if (!sec.rows.length) continue;
        await downloadPdfTable(`${base}-${sec.title}`, sec.title, sec.cols, sec.rows, `${base}-${sec.title}`, auth?.company);
      }
    } catch (err) {
      notify.error(err.message || "Export failed");
    } finally {
      setExporting(false);
    }
  };

  const openLink = (path) =>
    path ? (
      <Link to={path} className="font-semibold text-sky-700 underline">
        Open
      </Link>
    ) : (
      "—"
    );

  return (
    <div className="p-4 md:p-6">
      <PageHeader
        title="Article Traceability"
        subtitle="Read-only document flow for an article — PO, GRN, customs, sales invoice, dispatch, and linked records."
      >
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={exporting || !data?.found}
            className="rounded-lg border px-3 py-2 text-sm font-semibold hover:bg-slate-50 disabled:opacity-40"
            onClick={() => exportAll("csv")}
          >
            Export CSV
          </button>
          <button
            type="button"
            disabled={exporting || !data?.found}
            className="rounded-lg border px-3 py-2 text-sm font-semibold hover:bg-slate-50 disabled:opacity-40"
            onClick={() => exportAll("pdf")}
          >
            Export PDF
          </button>
        </div>
      </PageHeader>

      <form onSubmit={runSearch} className="mb-4 rounded-2xl border bg-white p-4 shadow-sm">
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
          <label className="flex flex-col gap-1 text-xs md:col-span-2">
            <span className="font-medium text-slate-600">Search</span>
            <input
              className="rounded-lg border px-3 py-2 text-sm"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Article, part, PO, GRN, SI, customs invoice, BL, AWB, BOE, supplier invoice…"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs">
            <span className="font-medium text-slate-600">Article Number</span>
            <input className="rounded-lg border px-2 py-2 text-sm" value={articleNumber} onChange={(e) => setArticleNumber(e.target.value)} />
          </label>
          <label className="flex flex-col gap-1 text-xs">
            <span className="font-medium text-slate-600">Part Number</span>
            <input className="rounded-lg border px-2 py-2 text-sm" value={partNumber} onChange={(e) => setPartNumber(e.target.value)} />
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
            <span className="font-medium text-slate-600">Customer</span>
            <input className="rounded-lg border px-2 py-2 text-sm" value={customer} onChange={(e) => setCustomer(e.target.value)} />
          </label>
          <label className="flex flex-col gap-1 text-xs">
            <span className="font-medium text-slate-600">Supplier</span>
            <input className="rounded-lg border px-2 py-2 text-sm" value={supplier} onChange={(e) => setSupplier(e.target.value)} />
          </label>
          <label className="flex flex-col gap-1 text-xs">
            <span className="font-medium text-slate-600">Document Type</span>
            <select className="rounded-lg border px-2 py-2 text-sm" value={documentType} onChange={(e) => setDocumentType(e.target.value)}>
              {DOC_TYPES.map((d) => (
                <option key={d || "all"} value={d}>
                  {d || "All"}
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
              Trace
            </button>
          </div>
        </div>
      </form>

      {traceQ.error ? (
        <div className="mb-3 rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">{traceQ.error.message}</div>
      ) : null}

      {!submitted || !hasQuery ? (
        <div className="rounded-2xl border bg-white p-8 text-center text-sm text-slate-500 shadow-sm">
          Enter an article number or document reference to trace the full document lifecycle.
        </div>
      ) : traceQ.isLoading ? (
        <div className="rounded-2xl border bg-white p-8 text-center text-sm text-slate-500 shadow-sm">Loading traceability…</div>
      ) : !data?.found ? (
        <div className="rounded-2xl border bg-white p-8 text-center text-sm text-slate-500 shadow-sm">
          {data?.message || "No matching article trace found."}
        </div>
      ) : (
        <div className="space-y-4">
          <SummaryCard summary={data.summary} />
          <FlowChain flow={data.flow} />

          <DataTable
            title="Timeline"
            columns={[
              ...TIMELINE_COLUMNS.map((c) =>
                c.key === "date" ? { ...c, render: (r) => fmtDate(r.date) } : c.key === "qtyIn" || c.key === "qtyOut" || c.key === "balance" ? { ...c, render: (r) => fmtNum(r[c.key]) } : c,
              ),
              {
                key: "open",
                header: "Open",
                render: (r) => openLink(r.openPath),
              },
            ]}
            rows={data.timeline || []}
            emptyText="No timeline events for current filters."
          />

          <DataTable
            title="Purchase"
            columns={[
              { key: "poNumber", header: "PO Number" },
              { key: "supplier", header: "Supplier" },
              { key: "poDate", header: "PO Date", render: (r) => fmtDate(r.poDate) },
              { key: "article", header: "Article" },
              { key: "partNumber", header: "Part Number" },
              { key: "qtyOrdered", header: "Qty Ordered", render: (r) => fmtNum(r.qtyOrdered) },
              { key: "grnNumber", header: "GRN Number" },
              { key: "qtyReceived", header: "Qty Received", render: (r) => fmtNum(r.qtyReceived) },
              { key: "supplierInvoiceNumber", header: "Supplier Invoice" },
              { key: "openPo", header: "Open PO", render: (r) => openLink(r.openPo) },
              { key: "openGrn", header: "Open GRN", render: (r) => openLink(r.openGrn) },
            ]}
            rows={data.purchase || []}
          />

          <DataTable
            title="Customs"
            columns={[
              { key: "boeNumber", header: "BOE Number" },
              { key: "blNumber", header: "BL Number" },
              { key: "awbNumber", header: "AWB Number" },
              { key: "supplierInvoiceNumber", header: "Supplier Invoice" },
              { key: "supplier", header: "Supplier" },
              { key: "countryOfOrigin", header: "COO" },
              { key: "qtyImported", header: "Qty Imported", render: (r) => fmtNum(r.qtyImported) },
              { key: "qtyConsumed", header: "Qty Consumed", render: (r) => fmtNum(r.qtyConsumed) },
              { key: "qtyAvailable", header: "Qty Available", render: (r) => fmtNum(r.qtyAvailable) },
              { key: "status", header: "Status" },
              {
                key: "blCopy",
                header: "View BL Copy",
                render: (r) => (
                  <button
                    type="button"
                    className="underline disabled:opacity-40"
                    disabled={!r.blDocumentId}
                    onClick={() => openDocument(r.blDocumentId)}
                  >
                    View
                  </button>
                ),
              },
              {
                key: "siCopy",
                header: "View Supplier Invoice",
                render: (r) => (
                  <button
                    type="button"
                    className="underline disabled:opacity-40"
                    disabled={!r.supplierInvoiceDocumentId}
                    onClick={() => openDocument(r.supplierInvoiceDocumentId)}
                  >
                    View
                  </button>
                ),
              },
              { key: "openCustomsStock", header: "Customs Stock", render: (r) => openLink(r.openCustomsStock) },
              { key: "openCustomsLedger", header: "Customs Ledger", render: (r) => openLink(r.openCustomsLedger) },
            ]}
            rows={data.customs || []}
          />

          <DataTable
            title="Sales"
            columns={[
              { key: "salesInvoiceNumber", header: "Sales Invoice" },
              { key: "customer", header: "Customer" },
              { key: "invoiceDate", header: "Invoice Date", render: (r) => fmtDate(r.invoiceDate) },
              { key: "article", header: "Article" },
              { key: "partNumber", header: "Part Number" },
              { key: "qtySold", header: "Qty Sold", render: (r) => fmtNum(r.qtySold) },
              { key: "customsInvoiceNumber", header: "Customs Invoice" },
              { key: "dispatchStatus", header: "Dispatch Status" },
              { key: "openSalesInvoice", header: "Open SI", render: (r) => openLink(r.openSalesInvoice) },
              { key: "openCustomsInvoice", header: "Open Customs Inv.", render: (r) => openLink(r.openCustomsInvoice) },
            ]}
            rows={data.sales || []}
          />
        </div>
      )}
    </div>
  );
}
