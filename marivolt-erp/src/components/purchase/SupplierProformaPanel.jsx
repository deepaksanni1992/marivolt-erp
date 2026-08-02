import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Modal from "../erp/Modal.jsx";
import { FormField, TextInput, SelectInput } from "../erp/FormField.jsx";
import { apiGet, apiGetWithQuery, apiPost, apiPut } from "../../lib/api.js";

function StatusBadge({ status }) {
  const s = String(status || "").toUpperCase();
  const classes = {
    DRAFT: "bg-slate-100 text-slate-800",
    RECEIVED: "bg-sky-100 text-sky-800",
    APPROVED: "bg-emerald-100 text-emerald-800",
    CANCELLED: "bg-zinc-200 text-zinc-800",
    UNPAID: "bg-amber-100 text-amber-900",
    PARTIALLY_PAID: "bg-orange-100 text-orange-900",
    PAID: "bg-emerald-100 text-emerald-900",
  };
  return (
    <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ${classes[s] || classes.DRAFT}`}>
      {s || "—"}
    </span>
  );
}

const emptyForm = () => ({
  purchaseOrderId: "",
  supplierProformaNo: "",
  supplierProformaDate: new Date().toISOString().slice(0, 10),
  currency: "",
  totalValue: "",
  requestedAdvanceAmount: "",
  requestedAdvancePercent: "",
  paymentTerms: "",
  remarks: "",
});

/**
 * Supplier Proforma list / create / detail for Purchase module (A1).
 * Does not create AP liability or stock.
 */
export default function SupplierProformaPanel({ embeddedPoId = null, setErr }) {
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [detailId, setDetailId] = useState(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState(emptyForm());
  const [cancelReason, setCancelReason] = useState("");

  const listQ = useQuery({
    queryKey: ["supplier-proformas", search, embeddedPoId],
    queryFn: () =>
      apiGetWithQuery("/supplier-proformas", {
        search: search || undefined,
        purchaseOrderId: embeddedPoId || undefined,
        limit: 100,
      }),
  });

  const detailQ = useQuery({
    queryKey: ["supplier-proforma", detailId],
    queryFn: () => apiGet(`/supplier-proformas/${detailId}`),
    enabled: Boolean(detailId),
  });

  const poQ = useQuery({
    queryKey: ["purchaseOrders-for-spf"],
    queryFn: () => apiGetWithQuery("/purchase-orders", { limit: 200 }),
    enabled: creating && !embeddedPoId,
  });

  const selectedPo = useMemo(() => {
    const id = embeddedPoId || form.purchaseOrderId;
    const items = poQ.data?.items || [];
    return items.find((p) => String(p._id) === String(id)) || null;
  }, [poQ.data, form.purchaseOrderId, embeddedPoId]);

  const createMut = useMutation({
    mutationFn: (payload) => apiPost("/supplier-proformas", payload),
    onSuccess: (data) => {
      setCreating(false);
      setForm(emptyForm());
      setErr?.("");
      qc.invalidateQueries({ queryKey: ["supplier-proformas"] });
      if (data?._id) setDetailId(data._id);
      if (data?.message) setErr?.(data.message);
    },
    onError: (e) => setErr?.(e.message || String(e)),
  });

  const receiveMut = useMutation({
    mutationFn: () => apiPost(`/supplier-proformas/${detailId}/receive`, {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["supplier-proforma", detailId] });
      qc.invalidateQueries({ queryKey: ["supplier-proformas"] });
    },
    onError: (e) => setErr?.(e.message || String(e)),
  });

  const approveMut = useMutation({
    mutationFn: () => apiPost(`/supplier-proformas/${detailId}/approve`, {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["supplier-proforma", detailId] });
      qc.invalidateQueries({ queryKey: ["supplier-proformas"] });
    },
    onError: (e) => setErr?.(e.message || String(e)),
  });

  const cancelMut = useMutation({
    mutationFn: () => apiPost(`/supplier-proformas/${detailId}/cancel`, { reason: cancelReason }),
    onSuccess: () => {
      setCancelReason("");
      qc.invalidateQueries({ queryKey: ["supplier-proforma", detailId] });
      qc.invalidateQueries({ queryKey: ["supplier-proformas"] });
    },
    onError: (e) => setErr?.(e.message || String(e)),
  });

  const updateMut = useMutation({
    mutationFn: (payload) => apiPut(`/supplier-proformas/${detailId}`, payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["supplier-proforma", detailId] });
      qc.invalidateQueries({ queryKey: ["supplier-proformas"] });
    },
    onError: (e) => setErr?.(e.message || String(e)),
  });

  const items = listQ.data?.items || [];
  const detail = detailQ.data;

  function submitCreate(e) {
    e.preventDefault();
    const purchaseOrderId = embeddedPoId || form.purchaseOrderId;
    if (!purchaseOrderId) {
      setErr?.("Select a Purchase Order");
      return;
    }
    createMut.mutate({
      purchaseOrderId,
      supplierProformaNo: form.supplierProformaNo,
      supplierProformaDate: form.supplierProformaDate,
      currency: form.currency || selectedPo?.currency || "USD",
      totalValue: Number(form.totalValue) || 0,
      requestedAdvanceAmount: Number(form.requestedAdvanceAmount) || 0,
      requestedAdvancePercent: Number(form.requestedAdvancePercent) || 0,
      paymentTerms: form.paymentTerms,
      remarks: form.remarks,
    });
  }

  return (
    <div className="space-y-4">
      <div className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-950">
        <b>Supplier Proforma</b> authorizes advance payment only.{" "}
        <b>This document does not create AP liability</b>, stock, or a final Purchase Invoice.
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {!embeddedPoId ? (
          <TextInput
            className="min-w-[200px]"
            placeholder="Search ref / supplier / PO"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        ) : null}
        <button
          type="button"
          className="rounded bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white"
          onClick={() => {
            setCreating(true);
            setForm({ ...emptyForm(), purchaseOrderId: embeddedPoId || "", currency: "" });
          }}
        >
          New Supplier Proforma
        </button>
      </div>

      <div className="overflow-auto rounded border border-slate-200">
        <table className="min-w-full text-left text-xs">
          <thead className="bg-slate-50 text-[11px] uppercase tracking-wide text-slate-600">
            <tr>
              <th className="px-2 py-2">Internal ref</th>
              <th className="px-2 py-2">Supplier SPF no</th>
              <th className="px-2 py-2">Supplier</th>
              <th className="px-2 py-2">PO</th>
              <th className="px-2 py-2">Date</th>
              <th className="px-2 py-2">Total</th>
              <th className="px-2 py-2">Advance</th>
              <th className="px-2 py-2">Doc</th>
              <th className="px-2 py-2">Advance cover</th>
            </tr>
          </thead>
          <tbody>
            {listQ.isLoading ? (
              <tr>
                <td className="px-2 py-3 text-slate-500" colSpan={9}>
                  Loading…
                </td>
              </tr>
            ) : !items.length ? (
              <tr>
                <td className="px-2 py-3 text-slate-500" colSpan={9}>
                  No Supplier Proformas yet.
                </td>
              </tr>
            ) : (
              items.map((row) => (
                <tr
                  key={row._id}
                  className="cursor-pointer border-t border-slate-100 hover:bg-slate-50"
                  onClick={() => setDetailId(row._id)}
                >
                  <td className="px-2 py-2 font-mono">{row.internalProformaRef}</td>
                  <td className="px-2 py-2 font-mono">{row.supplierProformaNo}</td>
                  <td className="px-2 py-2">{row.supplierName || "—"}</td>
                  <td className="px-2 py-2 font-mono">{row.purchaseOrderNo || "—"}</td>
                  <td className="px-2 py-2">
                    {row.supplierProformaDate ? String(row.supplierProformaDate).slice(0, 10) : "—"}
                  </td>
                  <td className="px-2 py-2">
                    {row.currency} {Number(row.totalValue || 0).toLocaleString()}
                  </td>
                  <td className="px-2 py-2">
                    {Number(row.requestedAdvanceAmount || 0).toLocaleString()} ({row.requestedAdvancePercent || 0}
                    %)
                  </td>
                  <td className="px-2 py-2">
                    <StatusBadge status={row.documentStatus} />
                  </td>
                  <td className="px-2 py-2">
                    <StatusBadge status={row.paymentStatus} />
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <Modal open={creating} onClose={() => setCreating(false)} title="Create Supplier Proforma" wide>
        <form className="space-y-3" onSubmit={submitCreate}>
          <p className="text-xs text-slate-600">
            Supplier is derived from the Purchase Order. No Purchase Invoice or AP liability will be created.
          </p>
          {!embeddedPoId ? (
            <FormField label="Purchase Order">
              <SelectInput
                value={form.purchaseOrderId}
                onChange={(e) => setForm((f) => ({ ...f, purchaseOrderId: e.target.value }))}
                required
              >
                <option value="">Select PO…</option>
                {(poQ.data?.items || []).map((p) => (
                  <option key={p._id} value={p._id}>
                    {p.poNo || p.poNumber} — {p.supplierName}
                  </option>
                ))}
              </SelectInput>
            </FormField>
          ) : null}
          {selectedPo || embeddedPoId ? (
            <div className="text-xs text-slate-700">
              Supplier: <b>{selectedPo?.supplierName || "from selected PO"}</b>
            </div>
          ) : null}
          <div className="grid gap-3 sm:grid-cols-2">
            <FormField label="Supplier proforma number">
              <TextInput
                required
                value={form.supplierProformaNo}
                onChange={(e) => setForm((f) => ({ ...f, supplierProformaNo: e.target.value }))}
              />
            </FormField>
            <FormField label="Date">
              <TextInput
                type="date"
                value={form.supplierProformaDate}
                onChange={(e) => setForm((f) => ({ ...f, supplierProformaDate: e.target.value }))}
              />
            </FormField>
            <FormField label="Currency">
              <TextInput
                value={form.currency}
                placeholder={selectedPo?.currency || "USD"}
                onChange={(e) => setForm((f) => ({ ...f, currency: e.target.value.toUpperCase() }))}
              />
            </FormField>
            <FormField label="Total value">
              <TextInput
                type="number"
                min="0"
                step="any"
                value={form.totalValue}
                onChange={(e) => setForm((f) => ({ ...f, totalValue: e.target.value }))}
              />
            </FormField>
            <FormField label="Requested advance amount">
              <TextInput
                type="number"
                min="0"
                step="any"
                value={form.requestedAdvanceAmount}
                onChange={(e) => setForm((f) => ({ ...f, requestedAdvanceAmount: e.target.value }))}
              />
            </FormField>
            <FormField label="Requested advance %">
              <TextInput
                type="number"
                min="0"
                max="100"
                step="any"
                value={form.requestedAdvancePercent}
                onChange={(e) => setForm((f) => ({ ...f, requestedAdvancePercent: e.target.value }))}
              />
            </FormField>
          </div>
          <FormField label="Payment terms">
            <TextInput
              value={form.paymentTerms}
              onChange={(e) => setForm((f) => ({ ...f, paymentTerms: e.target.value }))}
            />
          </FormField>
          <FormField label="Remarks">
            <TextInput value={form.remarks} onChange={(e) => setForm((f) => ({ ...f, remarks: e.target.value }))} />
          </FormField>
          <div className="flex justify-end gap-2">
            <button type="button" className="rounded border px-3 py-1.5 text-xs" onClick={() => setCreating(false)}>
              Cancel
            </button>
            <button
              type="submit"
              className="rounded bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white"
              disabled={createMut.isPending}
            >
              Save draft
            </button>
          </div>
        </form>
      </Modal>

      <Modal open={Boolean(detailId)} onClose={() => setDetailId(null)} title="Supplier Proforma detail" wide>
        {!detail ? (
          <p className="text-xs text-slate-500">Loading…</p>
        ) : (
          <div className="space-y-3 text-xs">
            <div className="rounded border border-amber-200 bg-amber-50 px-2 py-1.5 text-amber-950">
              This document does not create AP liability.
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <div>
                Internal ref: <b className="font-mono">{detail.internalProformaRef}</b>
              </div>
              <div>
                Supplier no: <b className="font-mono">{detail.supplierProformaNo}</b>
              </div>
              <div>
                PO: <b className="font-mono">{detail.purchaseOrderNo}</b>
              </div>
              <div>
                Supplier: <b>{detail.supplierName}</b>
              </div>
              <div>
                Status: <StatusBadge status={detail.documentStatus} />
              </div>
              <div>
                Advance cover: <StatusBadge status={detail.paymentStatus} />
              </div>
              <div>
                Total: {detail.currency} {Number(detail.totalValue || 0).toLocaleString()}
              </div>
              <div>
                Requested advance: {Number(detail.requestedAdvanceAmount || 0).toLocaleString()} (
                {detail.requestedAdvancePercent || 0}%)
              </div>
            </div>
            {detail.primaryAttachment?.fileUrl || detail.primaryAttachment?.documentId ? (
              <div>
                Attachment:{" "}
                {detail.primaryAttachment.fileUrl ? (
                  <a className="text-sky-700 underline" href={detail.primaryAttachment.fileUrl} target="_blank" rel="noreferrer">
                    Open file
                  </a>
                ) : (
                  <span className="font-mono">{String(detail.primaryAttachment.documentId)}</span>
                )}
              </div>
            ) : (
              <div className="text-slate-500">No primary attachment linked.</div>
            )}
            <div className="rounded border border-slate-200 bg-slate-50 p-2 text-slate-700">
              <div className="font-semibold">Advance payment (A2 placeholder)</div>
              <div>{detail.advancePaymentSummary?.message || "Coming in Phase A2."}</div>
            </div>
            <div className="text-slate-600">
              Created by {detail.createdBy || "—"} · Approved by {detail.approvedBy || "—"} · Cancelled by{" "}
              {detail.cancelledBy || "—"}
            </div>
            <div className="flex flex-wrap gap-2">
              {detail.documentStatus === "DRAFT" ? (
                <button
                  type="button"
                  className="rounded bg-sky-700 px-3 py-1.5 text-white"
                  onClick={() => receiveMut.mutate()}
                >
                  Receive
                </button>
              ) : null}
              {detail.documentStatus === "RECEIVED" ? (
                <button
                  type="button"
                  className="rounded bg-emerald-700 px-3 py-1.5 text-white"
                  onClick={() => approveMut.mutate()}
                >
                  Approve
                </button>
              ) : null}
              {["DRAFT", "RECEIVED"].includes(detail.documentStatus) ? (
                <button
                  type="button"
                  className="rounded border px-3 py-1.5"
                  onClick={() =>
                    updateMut.mutate({
                      remarks: detail.remarks || "",
                      totalValue: detail.totalValue,
                      requestedAdvanceAmount: detail.requestedAdvanceAmount,
                      requestedAdvancePercent: detail.requestedAdvancePercent,
                    })
                  }
                >
                  Save commercial fields
                </button>
              ) : null}
              {detail.documentStatus !== "CANCELLED" ? (
                <div className="flex flex-wrap items-center gap-2">
                  <TextInput
                    placeholder="Cancellation reason"
                    value={cancelReason}
                    onChange={(e) => setCancelReason(e.target.value)}
                  />
                  <button
                    type="button"
                    className="rounded bg-rose-700 px-3 py-1.5 text-white"
                    onClick={() => cancelMut.mutate()}
                    disabled={!cancelReason.trim()}
                  >
                    Cancel
                  </button>
                </div>
              ) : null}
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
