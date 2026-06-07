import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Modal from "../erp/Modal.jsx";
import { FormField, TextInput } from "../erp/FormField.jsx";
import { apiGet, apiGetWithQuery, apiPost } from "../../lib/api.js";

function money(n) {
  return Number(n || 0).toFixed(2);
}

function statusBadgeClass(status) {
  const s = String(status || "").toUpperCase();
  if (["ISSUED", "POSTED", "FULLY_PACKED", "FULLY_INVOICED", "PAID", "APPROVED"].includes(s)) {
    return "bg-emerald-50 text-emerald-800 ring-emerald-200";
  }
  if (["DRAFT", "PARTIAL", "PARTIALLY_PACKED", "PARTIALLY_INVOICED", "PARTIALLY_PAID"].includes(s)) {
    return "bg-amber-50 text-amber-800 ring-amber-200";
  }
  if (["CANCELLED", "REJECTED"].includes(s)) return "bg-rose-50 text-rose-800 ring-rose-200";
  return "bg-slate-50 text-slate-700 ring-slate-200";
}

export function packingReadyForSalesInvoice(packing) {
  if (!packing) return false;
  return (
    String(packing.status || "").toUpperCase() === "FULLY_PACKED" &&
    String(packing.invoiceStatus || "NOT_INVOICED").toUpperCase() !== "FULLY_INVOICED"
  );
}

export default function CreateInvoiceFromPackingModal({
  open,
  onClose,
  initialPackingId = "",
  onError,
  onCreated,
}) {
  const qc = useQueryClient();
  const [selectedPackingId, setSelectedPackingId] = useState("");
  const [search, setSearch] = useState("");

  useEffect(() => {
    if (!open) return;
    setSelectedPackingId(initialPackingId || "");
    setSearch("");
  }, [open, initialPackingId]);

  const readyQ = useQuery({
    queryKey: ["sales-packings-ready-invoice", search],
    queryFn: () => apiGetWithQuery("/sales/sales-invoices/packings/ready", { search: search || undefined }),
    enabled: open,
  });

  const previewQ = useQuery({
    queryKey: ["sales-packing-invoice-preview", selectedPackingId],
    queryFn: () => apiGet(`/sales/sales-invoices/from-packing/${selectedPackingId}`),
    enabled: open && !!selectedPackingId,
  });

  const createMut = useMutation({
    mutationFn: (packingId) => apiPost(`/sales/sales-invoices/from-packing/${packingId}`, {}),
    onSuccess: (doc) => {
      qc.invalidateQueries({ queryKey: ["sales-sales-invoices"] });
      qc.invalidateQueries({ queryKey: ["sales-packings-ready-invoice"] });
      qc.invalidateQueries({ queryKey: ["sales-dispatch-status"] });
      qc.invalidateQueries({ queryKey: ["sales-summary"] });
      qc.invalidateQueries({ queryKey: ["store-packing"] });
      qc.invalidateQueries({ queryKey: ["sales-order-allocations"] });
      onCreated?.(doc);
      onClose?.();
    },
    onError: (e) => onError?.(e.message || "Failed to create sales invoice"),
  });

  const readyItems = readyQ.data?.items || [];
  const previewLines = previewQ.data?.lines || [];
  const selectedPacking = useMemo(
    () => readyItems.find((p) => String(p._id) === String(selectedPackingId)) || previewQ.data?.packing || null,
    [readyItems, selectedPackingId, previewQ.data?.packing],
  );

  const previewTotal = previewLines.reduce((s, ln) => s + (Number(ln.totalPrice) || Number(ln.qty) * Number(ln.price) || 0), 0);

  return (
    <Modal open={open} onClose={onClose} title="Create Sales Invoice from Packing" wide>
      <div className="space-y-4 text-sm">
        <p className="text-xs text-gray-600">
          Select a fully packed document that has not been invoiced. One sales invoice per packing.
        </p>

        <FormField label="Search packing / customer / allocation">
          <TextInput
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="e.g. OKE-PK-0004"
          />
        </FormField>

        <div className="max-h-52 overflow-auto rounded-xl border">
          <table className="min-w-full text-left text-xs">
            <thead className="sticky top-0 bg-gray-100 uppercase text-gray-600">
              <tr>
                <th className="px-2 py-2">Packing No</th>
                <th className="px-2 py-2">Customer</th>
                <th className="px-2 py-2">Allocation</th>
                <th className="px-2 py-2 text-right">Pending Qty</th>
                <th className="px-2 py-2">Status</th>
                <th className="px-2 py-2 text-right">Select</th>
              </tr>
            </thead>
            <tbody>
              {readyQ.isLoading ? (
                <tr>
                  <td colSpan={6} className="px-2 py-4 text-center text-gray-500">
                    Loading packings…
                  </td>
                </tr>
              ) : readyItems.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-2 py-4 text-center text-gray-500">
                    No fully packed documents ready for invoice.
                  </td>
                </tr>
              ) : (
                readyItems.map((p) => (
                  <tr key={p._id} className={`border-t ${String(selectedPackingId) === String(p._id) ? "bg-sky-50" : ""}`}>
                    <td className="px-2 py-2 font-mono">{p.packingNo}</td>
                    <td className="px-2 py-2">{p.customerName}</td>
                    <td className="px-2 py-2 font-mono">{p.allocationNo}</td>
                    <td className="px-2 py-2 text-right font-semibold">{p.pendingInvoiceQty}</td>
                    <td className="px-2 py-2">
                      <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ${statusBadgeClass(p.invoiceStatus || "NOT_INVOICED")}`}>
                        {p.invoiceStatus || "NOT_INVOICED"}
                      </span>
                    </td>
                    <td className="px-2 py-2 text-right">
                      <button
                        type="button"
                        className={`rounded-lg border px-2 py-1 text-xs ${String(selectedPackingId) === String(p._id) ? "bg-gray-900 text-white" : ""}`}
                        onClick={() => setSelectedPackingId(p._id)}
                      >
                        {String(selectedPackingId) === String(p._id) ? "Selected" : "Select"}
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {selectedPackingId ? (
          <div className="rounded-xl border bg-gray-50 p-3">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <div>
                <div className="font-semibold">{selectedPacking?.packingNo || "—"}</div>
                <div className="text-xs text-gray-600">
                  {selectedPacking?.customerName || "—"} · {selectedPacking?.allocationNo || "—"}
                </div>
              </div>
              <div className="text-right text-xs">
                <div>Pending invoice qty: {selectedPacking?.pendingInvoiceQty ?? "—"}</div>
                <div className="font-semibold">Preview total: {money(previewTotal)}</div>
              </div>
            </div>
            {previewQ.isLoading ? (
              <p className="text-xs text-gray-500">Loading invoice lines…</p>
            ) : previewLines.length === 0 ? (
              <p className="text-xs text-amber-700">No pending invoice quantity on this packing.</p>
            ) : (
              <div className="max-h-40 overflow-auto rounded border bg-white">
                <table className="min-w-full text-xs">
                  <thead className="bg-gray-100 text-gray-600">
                    <tr>
                      <th className="px-2 py-1 text-left">Article</th>
                      <th className="px-2 py-1 text-left">Part</th>
                      <th className="px-2 py-1 text-right">Qty</th>
                      <th className="px-2 py-1 text-right">Price</th>
                      <th className="px-2 py-1 text-right">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {previewLines.map((ln, idx) => (
                      <tr key={idx} className="border-t">
                        <td className="px-2 py-1 font-mono">{ln.article}</td>
                        <td className="px-2 py-1">{ln.partNumber || "—"}</td>
                        <td className="px-2 py-1 text-right">{ln.qty ?? ln.pendingInvoiceQty}</td>
                        <td className="px-2 py-1 text-right">{money(ln.price)}</td>
                        <td className="px-2 py-1 text-right">{money(ln.totalPrice ?? (Number(ln.qty) * Number(ln.price)))}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        ) : null}

        <div className="flex justify-end gap-2 pt-2">
          <button type="button" className="rounded-xl border px-4 py-2 text-sm" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="rounded-xl bg-gray-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
            disabled={!selectedPackingId || createMut.isPending || previewQ.isLoading || previewLines.length === 0}
            onClick={() => createMut.mutate(selectedPackingId)}
          >
            {createMut.isPending ? "Creating…" : "Create Sales Invoice"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
