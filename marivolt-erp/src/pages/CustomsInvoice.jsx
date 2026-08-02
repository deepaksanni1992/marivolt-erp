import { useCallback, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import PageHeader from "../components/erp/PageHeader.jsx";
import CustomsInvoiceManualAllocModal from "../components/customs/CustomsInvoiceManualAllocModal.jsx";
import { useAuth } from "../context/AuthContext.jsx";
import { apiGet, apiGetWithQuery, apiPost, apiPut } from "../lib/api.js";
import { printCustomsInvoice } from "../lib/customsInvoicePrint.js";

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

function statusTone(status) {
  const s = String(status || "").toUpperCase();
  if (s === "POSTED") return "bg-emerald-50 text-emerald-800 ring-emerald-200";
  if (s === "DRAFT") return "bg-amber-50 text-amber-800 ring-amber-200";
  if (s === "CANCELLED") return "bg-rose-50 text-rose-800 ring-rose-200";
  return "bg-slate-50 text-slate-700 ring-slate-200";
}

function allocModeLabel(mode) {
  if (mode === "AUTO_FIFO") return "FIFO";
  if (mode === "MANUAL") return "Manual";
  if (mode === "OVERRIDE_DUMMY") return "Override";
  return mode || "—";
}

async function openDocument(documentId) {
  if (!documentId) return;
  try {
    const { url } = await apiGet(`/documents/${documentId}/download?inline=1`);
    if (url) window.open(url, "_blank", "noopener,noreferrer");
  } catch (e) {
    window.alert(e.message || "Could not open document");
  }
}

function CustomsInvoiceList() {
  const { auth, selectCompany } = useAuth();
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const limit = 50;

  const queryParams = useMemo(
    () => ({
      page,
      limit,
      search: search.trim() || undefined,
      status: status || undefined,
    }),
    [page, limit, search, status],
  );

  const listQ = useQuery({
    queryKey: ["customs-invoices", queryParams, auth?.company?.id],
    queryFn: () => apiGetWithQuery("/customs/invoices", queryParams),
  });

  const rows = listQ.data?.items || [];
  const total = listQ.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const enabled = listQ.data?.enabled !== false;

  const onCompanyChange = useCallback(
    async (e) => {
      const nextId = e.target.value;
      if (!nextId || nextId === auth?.company?.id) return;
      try {
        await selectCompany(nextId);
        setPage(1);
      } catch (err) {
        window.alert(err.message || "Failed to switch company");
      }
    },
    [auth?.company?.id, selectCompany],
  );

  return (
    <div className="space-y-4">
      {!enabled ? (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          Customs module is disabled. Set <code className="font-mono">CUSTOMS_ENABLED=true</code> on the API.
        </div>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <input
          className="rounded-xl border px-3 py-2 text-sm"
          placeholder="Search invoice no, sales invoice, customer…"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(1);
          }}
        />
        <select
          className="rounded-xl border px-3 py-2 text-sm"
          value={status}
          onChange={(e) => {
            setStatus(e.target.value);
            setPage(1);
          }}
        >
          <option value="">All statuses</option>
          <option value="DRAFT">DRAFT</option>
          <option value="POSTED">POSTED</option>
          <option value="CANCELLED">CANCELLED</option>
        </select>
        {auth?.companies?.length > 1 ? (
          <select className="rounded-xl border px-3 py-2 text-sm" value={auth?.company?.id || ""} onChange={onCompanyChange}>
            {(auth.companies || []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.code || c.name}
              </option>
            ))}
          </select>
        ) : null}
      </div>

      <div className="overflow-x-auto rounded-xl border bg-white">
        <table className="min-w-full text-sm">
          <thead className="bg-gray-100 text-xs uppercase tracking-wide text-gray-600">
            <tr>
              <th className="px-3 py-2 text-left">Customs Invoice</th>
              <th className="px-3 py-2 text-left">Sales Invoice</th>
              <th className="px-3 py-2 text-left">Customer</th>
              <th className="px-3 py-2 text-left">Date</th>
              <th className="px-3 py-2 text-left">Status</th>
              <th className="px-3 py-2 text-left">Company</th>
            </tr>
          </thead>
          <tbody>
            {listQ.isLoading ? (
              <tr>
                <td colSpan={6} className="px-3 py-6 text-center text-gray-500">
                  Loading…
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-3 py-6 text-center text-gray-500">
                  No customs invoices yet.
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr key={row._id} className="border-t hover:bg-gray-50">
                  <td className="px-3 py-2">
                    <Link className="font-mono text-xs text-blue-700 hover:underline" to={`/customs/invoices/${row._id}`}>
                      {row.customsInvoiceNumber}
                    </Link>
                  </td>
                  <td className="px-3 py-2 font-mono text-xs">{row.salesInvoiceNumber || "—"}</td>
                  <td className="px-3 py-2">{row.customerName || "—"}</td>
                  <td className="px-3 py-2 text-xs">{fmtDate(row.invoiceDate)}</td>
                  <td className="px-3 py-2">
                    <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ${statusTone(row.status)}`}>
                      {row.status}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-xs">{row.companyCode || "—"}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between text-sm text-gray-600">
        <span>
          Page {page} of {totalPages} · {total} total
        </span>
        <div className="flex gap-2">
          <button type="button" className="rounded-xl border px-3 py-1 disabled:opacity-40" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
            Previous
          </button>
          <button
            type="button"
            className="rounded-xl border px-3 py-1 disabled:opacity-40"
            disabled={page >= totalPages}
            onClick={() => setPage((p) => p + 1)}
          >
            Next
          </button>
        </div>
      </div>
    </div>
  );
}

function CustomsInvoiceDetail({ id }) {
  const queryClient = useQueryClient();
  const { auth } = useAuth();
  const [allocModal, setAllocModal] = useState({ open: false, lineIndex: null });
  const [draftItems, setDraftItems] = useState(null);
  const [preview, setPreview] = useState(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  const detailQ = useQuery({
    queryKey: ["customs-invoice", id, auth?.company?.id],
    queryFn: () => apiGet(`/customs/invoices/${id}`),
    enabled: !!id,
  });

  const invoice = detailQ.data?.item;
  const allowOverride = detailQ.data?.canOverride === true;
  const isDraft = String(invoice?.status || "").toUpperCase() === "DRAFT";
  const items = draftItems ?? invoice?.items ?? [];

  const loadPreview = useCallback(async () => {
    if (!invoice?.salesInvoiceId) return;
    setPreviewLoading(true);
    try {
      const data = await apiPost(
        `/customs/invoices/preview-from-sales-invoice/${invoice.salesInvoiceId}`,
        {
          items: items.map((line) => ({
            salesInvoiceLineId: line.salesInvoiceLineId,
            allocations: (line.allocations || []).map((a) => ({
              customsLotItemId: a.customsLotItemId,
              qty: a.qty,
              allocationMode: a.allocationMode,
              boeNumber: a.boeNumber,
              blNumber: a.blNumber,
              awbNumber: a.awbNumber,
              supplierInvoiceNumber: a.supplierInvoiceNumber,
              overrideReason: a.overrideReason,
              countryOfOrigin: a.countryOfOrigin,
              hsCode: a.hsCode,
            })),
          })),
        },
      );
      setPreview(data);
    } catch (err) {
      window.alert(err.message || "Preview failed");
      setPreview(null);
    } finally {
      setPreviewLoading(false);
    }
  }, [invoice?.salesInvoiceId, items]);

  const updateMutation = useMutation({
    mutationFn: (body) => apiPut(`/customs/invoices/${id}`, body),
    onSuccess: (data) => {
      queryClient.setQueryData(["customs-invoice", id, auth?.company?.id], (prev) => ({
        ...data,
        canOverride: data?.canOverride ?? prev?.canOverride,
      }));
      setDraftItems(null);
      setPreview(null);
      queryClient.invalidateQueries({ queryKey: ["customs-invoices"] });
    },
    onError: (err) => window.alert(err.message || "Update failed"),
  });

  const finalizeMutation = useMutation({
    mutationFn: () => apiPost(`/customs/invoices/${id}/finalize`, {}),
    onSuccess: (data) => {
      queryClient.setQueryData(["customs-invoice", id, auth?.company?.id], (prev) => ({
        ...data,
        canOverride: data?.canOverride ?? prev?.canOverride,
      }));
      queryClient.invalidateQueries({ queryKey: ["customs-invoices"] });
      queryClient.invalidateQueries({ queryKey: ["customs-ledger-page"] });
      queryClient.invalidateQueries({ queryKey: ["customs-stock-page"] });
      window.alert("Customs invoice finalized — lot remaining qty reduced.");
    },
    onError: (err) => window.alert(err.message || "Finalize failed"),
  });

  const cancelMutation = useMutation({
    mutationFn: (reason) => apiPost(`/customs/invoices/${id}/cancel`, { reason }),
    onSuccess: (data) => {
      queryClient.setQueryData(["customs-invoice", id, auth?.company?.id], (prev) => ({
        ...data,
        canOverride: data?.canOverride ?? prev?.canOverride,
      }));
      queryClient.invalidateQueries({ queryKey: ["customs-invoices"] });
      queryClient.invalidateQueries({ queryKey: ["customs-ledger-page"] });
      queryClient.invalidateQueries({ queryKey: ["customs-stock-page"] });
    },
    onError: (err) => window.alert(err.message || "Cancel failed"),
  });

  const handlePrint = async (exportPdf) => {
    try {
      const data = await apiGet(`/customs/invoices/${id}/print`);
      await printCustomsInvoice(data, {
        exportPdf,
        companyName: auth?.company?.name || invoice?.companyCode,
      });
    } catch (err) {
      window.alert(err.message || "Print failed");
    }
  };

  const handleManualSave = (lineIndex, allocations) => {
    const nextItems = items.map((line, idx) => {
      if (idx !== lineIndex) return line;
      return { ...line, allocations };
    });
    setDraftItems(nextItems);
    setAllocModal({ open: false, lineIndex: null });
    updateMutation.mutate({
      items: nextItems.map((line) => ({
        salesInvoiceLineId: line.salesInvoiceLineId,
        allocations: (line.allocations || []).map((a) => ({
          customsLotItemId: a.customsLotItemId,
          qty: a.qty,
          allocationMode: a.allocationMode,
          boeNumber: a.boeNumber,
          blNumber: a.blNumber,
          awbNumber: a.awbNumber,
          supplierInvoiceNumber: a.supplierInvoiceNumber,
          overrideReason: a.overrideReason,
          countryOfOrigin: a.countryOfOrigin,
          hsCode: a.hsCode,
        })),
      })),
    });
  };

  const handleCancel = () => {
    const reason = window.prompt("Cancellation reason (optional):");
    if (reason === null) return;
    cancelMutation.mutate(reason);
  };

  if (detailQ.isLoading) return <p className="text-sm text-gray-500">Loading customs invoice…</p>;
  if (!invoice) return <p className="text-sm text-rose-600">Customs invoice not found.</p>;

  const modalLine = allocModal.lineIndex != null ? items[allocModal.lineIndex] : null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link to="/customs/invoices" className="text-xs text-blue-700 hover:underline">
            ← All customs invoices
          </Link>
          <h2 className="mt-1 font-mono text-lg">{invoice.customsInvoiceNumber}</h2>
          <p className="text-sm text-gray-600">
            Sales invoice {invoice.salesInvoiceNumber} · {invoice.customerName}
          </p>
        </div>
        <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ${statusTone(invoice.status)}`}>
          {invoice.status}
        </span>
      </div>

      <div className="grid gap-3 sm:grid-cols-4">
        <div className="rounded-xl border bg-white p-3 text-sm">
          <div className="text-xs text-gray-500">Invoice date</div>
          <div>{fmtDate(invoice.invoiceDate)}</div>
        </div>
        <div className="rounded-xl border bg-white p-3 text-sm">
          <div className="text-xs text-gray-500">Company</div>
          <div>{invoice.companyCode || "—"}</div>
        </div>
        <div className="rounded-xl border bg-white p-3 text-sm sm:col-span-2">
          <div className="text-xs text-gray-500">Remarks</div>
          <div className="whitespace-pre-wrap text-xs">{invoice.remarks || "—"}</div>
        </div>
      </div>

      <div className="overflow-x-auto rounded-xl border bg-white">
        <table className="min-w-full text-sm">
          <thead className="bg-gray-100 text-xs uppercase tracking-wide text-gray-600">
            <tr>
              <th className="px-3 py-2 text-left">Article</th>
              <th className="px-3 py-2 text-left">Part</th>
              <th className="px-3 py-2 text-left">Description</th>
              <th className="px-3 py-2 text-right">Export Qty</th>
              <th className="px-3 py-2 text-left">Allocations</th>
              <th className="px-3 py-2 text-left">Docs</th>
              {isDraft ? <th className="px-3 py-2 text-left">Actions</th> : null}
            </tr>
          </thead>
          <tbody>
            {items.map((line, lineIndex) => (
              <tr key={line._id || lineIndex} className="border-t align-top">
                <td className="px-3 py-2 font-mono text-xs">{line.articleNumber}</td>
                <td className="px-3 py-2 font-mono text-xs">{line.partNumber || "—"}</td>
                <td className="px-3 py-2 text-xs">{line.description || line.partName || "—"}</td>
                <td className="px-3 py-2 text-right tabular-nums">{fmtNum(line.qtyExported)}</td>
                <td className="px-3 py-2">
                  <div className="space-y-1">
                    {(line.allocations || []).map((alloc, ai) => (
                      <div key={alloc._id || ai} className="rounded border bg-gray-50 px-2 py-1 text-xs">
                        <span className="font-semibold">{allocModeLabel(alloc.allocationMode)}</span>
                        {" · "}
                        Qty {fmtNum(alloc.qty)}
                        {alloc.boeNumber ? ` · BOE ${alloc.boeNumber}` : null}
                        {alloc.boeDate ? ` · ${fmtDate(alloc.boeDate)}` : null}
                        {alloc.blNumber ? ` · BL ${alloc.blNumber}` : null}
                        {alloc.remainingAfter != null ? ` · Rem ${fmtNum(alloc.remainingAfter)}` : null}
                        {alloc.customsValueAED ? ` · AED ${fmtNum(alloc.customsValueAED)}` : null}
                        {alloc.totalWeightKg ? ` · ${fmtNum(alloc.totalWeightKg)} kg` : null}
                        {alloc.overrideReason ? (
                          <div className="mt-0.5 text-amber-800">Reason: {alloc.overrideReason}</div>
                        ) : null}
                      </div>
                    ))}
                  </div>
                </td>
                <td className="px-3 py-2">
                  <div className="flex flex-col gap-1">
                    {(line.allocations || []).map((alloc, ai) => {
                      const docIds = alloc.documentLinks || [];
                      const blDoc = docIds[0];
                      const siDoc = docIds[1];
                      return (
                        <div key={`docs-${ai}`} className="flex flex-wrap gap-1">
                          {blDoc ? (
                            <button
                              type="button"
                              className="rounded border px-1.5 py-0.5 text-[10px]"
                              onClick={() => openDocument(blDoc)}
                            >
                              View BL
                            </button>
                          ) : alloc.blNumber ? (
                            <span className="text-[10px] text-gray-400">BL doc N/A</span>
                          ) : null}
                          {siDoc ? (
                            <button
                              type="button"
                              className="rounded border px-1.5 py-0.5 text-[10px]"
                              onClick={() => openDocument(siDoc)}
                            >
                              View Supplier Inv
                            </button>
                          ) : alloc.supplierInvoiceNumber ? (
                            <span className="text-[10px] text-gray-400">SI doc N/A</span>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                </td>
                {isDraft ? (
                  <td className="px-3 py-2">
                    <button
                      type="button"
                      className="rounded border px-2 py-1 text-xs"
                      onClick={() => setAllocModal({ open: true, lineIndex })}
                    >
                      Manual BOE
                    </button>
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {preview ? (
        <div className="space-y-2 rounded-xl border border-sky-200 bg-sky-50 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-sky-900">Allocation preview (before post)</h3>
            <button type="button" className="text-xs text-sky-800 underline" onClick={() => setPreview(null)}>
              Dismiss
            </button>
          </div>
          {(preview.warnings || []).length ? (
            <ul className="list-disc pl-5 text-xs text-amber-800">
              {preview.warnings.map((w, i) => (
                <li key={i}>
                  {w.articleNumber ? `${w.articleNumber}: ` : ""}
                  {w.message}
                </li>
              ))}
            </ul>
          ) : null}
          <div className="overflow-x-auto rounded border bg-white">
            <table className="min-w-full text-xs">
              <thead className="bg-gray-100">
                <tr>
                  <th className="px-2 py-1 text-left">Article</th>
                  <th className="px-2 py-1 text-right">Requested</th>
                  <th className="px-2 py-1 text-left">Allocated BOEs</th>
                  <th className="px-2 py-1 text-right">AED</th>
                  <th className="px-2 py-1 text-right">Weight</th>
                </tr>
              </thead>
              <tbody>
                {(preview.lines || []).map((line, i) => (
                  <tr key={i} className="border-t align-top">
                    <td className="px-2 py-1 font-mono">{line.articleNumber}</td>
                    <td className="px-2 py-1 text-right">{fmtNum(line.requestedQty)}</td>
                    <td className="px-2 py-1">
                      {(line.allocations || []).map((a, ai) => (
                        <div key={ai}>
                          {a.boeNumber || "—"} → {fmtNum(a.allocatedQty)}
                          {a.remainingAfter != null ? ` (rem ${fmtNum(a.remainingAfter)})` : ""}
                        </div>
                      ))}
                    </td>
                    <td className="px-2 py-1 text-right">{fmtNum(line.customsValueAED)}</td>
                    <td className="px-2 py-1 text-right">{fmtNum(line.totalWeightKg)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-sky-900">
            Totals: qty {fmtNum(preview.totals?.requestedQty)} · AED {fmtNum(preview.totals?.customsValueAED)} ·{" "}
            {fmtNum(preview.totals?.totalWeightKg)} kg
          </p>
        </div>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <button type="button" className="rounded-xl border px-3 py-1.5 text-sm" onClick={() => handlePrint(false)}>
          Print
        </button>
        <button type="button" className="rounded-xl border px-3 py-1.5 text-sm" onClick={() => handlePrint(true)}>
          Export PDF
        </button>
        {isDraft ? (
          <>
            <button
              type="button"
              className="rounded-xl border px-3 py-1.5 text-sm disabled:opacity-50"
              disabled={previewLoading || !invoice?.salesInvoiceId}
              onClick={loadPreview}
            >
              {previewLoading ? "Previewing…" : "Preview allocation"}
            </button>
            <button
              type="button"
              className="rounded-xl bg-gray-900 px-3 py-1.5 text-sm text-white disabled:opacity-50"
              disabled={finalizeMutation.isPending || updateMutation.isPending}
              onClick={async () => {
                if (!preview) await loadPreview();
                if (!window.confirm("Finalize customs invoice? This will reduce customs lot remaining qty.")) return;
                finalizeMutation.mutate();
              }}
            >
              {finalizeMutation.isPending ? "Finalizing…" : "Finalize"}
            </button>
            <button
              type="button"
              className="rounded-xl border border-rose-200 px-3 py-1.5 text-sm text-rose-700 disabled:opacity-50"
              disabled={cancelMutation.isPending}
              onClick={handleCancel}
            >
              Cancel draft
            </button>
          </>
        ) : null}
        {String(invoice.status).toUpperCase() === "POSTED" ? (
          <button
            type="button"
            className="rounded-xl border border-rose-200 px-3 py-1.5 text-sm text-rose-700 disabled:opacity-50"
            disabled={cancelMutation.isPending}
            onClick={handleCancel}
          >
            Cancel & reverse stock
          </button>
        ) : null}
        {invoice.salesInvoiceNumber ? (
          <span className="rounded-xl border px-3 py-1.5 text-sm text-gray-600">
            Sales invoice: {invoice.salesInvoiceNumber}
          </span>
        ) : null}
      </div>

      <CustomsInvoiceManualAllocModal
        open={allocModal.open}
        onClose={() => setAllocModal({ open: false, lineIndex: null })}
        line={modalLine}
        initialAllocations={modalLine?.allocations}
        allowOverride={allowOverride}
        onSave={(allocations) => handleManualSave(allocModal.lineIndex, allocations)}
      />
    </div>
  );
}

export default function CustomsInvoice() {
  const { id } = useParams();

  return (
    <div className="mx-auto max-w-7xl space-y-4 p-4 md:p-6">
      <PageHeader
        title={id ? "Customs Invoice Detail" : "Customs Invoice"}
        subtitle={
          id
            ? "Review allocations, finalize to post outbound customs movements."
            : "Customs export invoices linked to sales invoices — FIFO allocation from imported lots."
        }
      />
      {id ? <CustomsInvoiceDetail id={id} /> : <CustomsInvoiceList />}
    </div>
  );
}
