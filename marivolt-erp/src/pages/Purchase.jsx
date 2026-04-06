import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import PageHeader from "../components/erp/PageHeader.jsx";
import Modal from "../components/erp/Modal.jsx";
import { FormField, TextInput } from "../components/erp/FormField.jsx";
import { apiGet, apiGetWithQuery, apiPatch, apiPost } from "../lib/api.js";

const defaultLine = () => ({
  itemCode: "",
  description: "",
  qty: 1,
  unitPrice: 0,
  currency: "USD",
  remarks: "",
});

export default function Purchase() {
  const qc = useQueryClient();
  const [page, setPage] = useState(1);
  const limit = 20;
  const [createOpen, setCreateOpen] = useState(false);
  const [detailId, setDetailId] = useState(null);
  const [receiveOpen, setReceiveOpen] = useState(false);
  const [form, setForm] = useState({
    supplierName: "",
    currency: "USD",
    remarks: "",
    lines: [defaultLine()],
  });
  const [receiveWarehouse, setReceiveWarehouse] = useState("MAIN");
  const [receiveLines, setReceiveLines] = useState([]);
  const [err, setErr] = useState("");

  const { data, isLoading, error } = useQuery({
    queryKey: ["purchaseOrders", page],
    queryFn: () => apiGetWithQuery("/purchase-orders", { page, limit }),
  });

  const { data: detail } = useQuery({
    queryKey: ["purchaseOrder", detailId],
    queryFn: () => apiGet(`/purchase-orders/${detailId}`),
    enabled: !!detailId,
  });

  const createMutation = useMutation({
    mutationFn: () => apiPost("/purchase-orders", form),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["purchaseOrders"] });
      setCreateOpen(false);
      setForm({ supplierName: "", currency: "USD", remarks: "", lines: [defaultLine()] });
    },
    onError: (e) => setErr(e.message),
  });

  const receiveMutation = useMutation({
    mutationFn: (body) => apiPost(`/purchase-orders/${detailId}/receive`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["purchaseOrders"] });
      qc.invalidateQueries({ queryKey: ["purchaseOrder", detailId] });
      qc.invalidateQueries({ queryKey: ["stockBalances"] });
      qc.invalidateQueries({ queryKey: ["inventoryLedger"] });
      setReceiveOpen(false);
    },
    onError: (e) => setErr(e.message),
  });

  function openReceive() {
    if (!detail?.lines?.length) return;
    setErr("");
    setReceiveWarehouse("MAIN");
    setReceiveLines(
      detail.lines.map((l) => ({
        lineId: l._id,
        itemCode: l.itemCode,
        max: Math.max(0, (l.qty || 0) - (l.receivedQty || 0)),
        qty: Math.max(0, (l.qty || 0) - (l.receivedQty || 0)),
      }))
    );
    setReceiveOpen(true);
  }

  const rows = data?.items ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / limit));

  return (
    <div>
      <PageHeader title="Purchase" subtitle="Purchase orders and goods receipt.">
        <button
          type="button"
          onClick={() => {
            setErr("");
            setCreateOpen(true);
          }}
          className="rounded-xl bg-gray-900 px-3 py-2 text-sm font-semibold text-white"
        >
          New PO
        </button>
      </PageHeader>

      {(error || err) && (
        <div className="mb-4 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {error?.message || err}
        </div>
      )}

      <div className="overflow-hidden rounded-2xl border bg-white">
        <div className="overflow-x-auto">
          <table className="min-w-full text-left text-sm">
            <thead className="border-b bg-gray-50 text-xs font-semibold text-gray-600">
              <tr>
                <th className="px-3 py-2">PO #</th>
                <th className="px-3 py-2">Supplier</th>
                <th className="px-3 py-2">Date</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2 text-right">Total</th>
                <th className="px-3 py-2 w-24" />
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr>
                  <td colSpan={6} className="px-3 py-8 text-center text-gray-500">
                    Loading…
                  </td>
                </tr>
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-3 py-8 text-center text-gray-500">
                    No purchase orders.
                  </td>
                </tr>
              ) : (
                rows.map((r) => (
                  <tr key={r._id} className="border-b border-gray-100 hover:bg-gray-50/80">
                    <td className="px-3 py-2 font-mono text-xs">{r.poNumber}</td>
                    <td className="px-3 py-2">{r.supplierName}</td>
                    <td className="px-3 py-2 text-gray-600">
                      {r.orderDate ? new Date(r.orderDate).toLocaleDateString() : "—"}
                    </td>
                    <td className="px-3 py-2">{r.status}</td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {r.currency} {Number(r.grandTotal || 0).toFixed(2)}
                    </td>
                    <td className="px-3 py-2">
                      <button
                        type="button"
                        className="rounded-lg border px-2 py-1 text-xs"
                        onClick={() => {
                          setDetailId(r._id);
                          setErr("");
                        }}
                      >
                        Open
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <div className="flex items-center justify-between border-t px-3 py-2 text-sm text-gray-600">
          <span>
            Page {page}/{totalPages} · {total} POs
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              className="rounded-lg border px-2 py-1 disabled:opacity-40"
              disabled={page <= 1}
              onClick={() => setPage((p) => p - 1)}
            >
              Prev
            </button>
            <button
              type="button"
              className="rounded-lg border px-2 py-1 disabled:opacity-40"
              disabled={page >= totalPages}
              onClick={() => setPage((p) => p + 1)}
            >
              Next
            </button>
          </div>
        </div>
      </div>

      <Modal open={!!detailId} onClose={() => setDetailId(null)} title="Purchase order" wide>
        {!detail ? (
          <p className="text-sm text-gray-500">Loading…</p>
        ) : (
          <div className="space-y-3 text-sm">
            <div className="flex flex-wrap gap-4">
              <div>
                <span className="text-gray-500">PO</span>{" "}
                <span className="font-mono font-semibold">{detail.poNumber}</span>
              </div>
              <div>
                <span className="text-gray-500">Supplier</span> {detail.supplierName}
              </div>
              <div>
                <span className="text-gray-500">Status</span> {detail.status}
              </div>
            </div>
            <div className="overflow-x-auto rounded-xl border">
              <table className="min-w-full text-xs">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-2 py-1 text-left">Item</th>
                    <th className="px-2 py-1 text-right">Qty</th>
                    <th className="px-2 py-1 text-right">Rcvd</th>
                    <th className="px-2 py-1 text-right">Rate</th>
                    <th className="px-2 py-1 text-right">Line</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.lines?.map((l) => (
                    <tr key={l._id} className="border-t">
                      <td className="px-2 py-1 font-mono">{l.itemCode}</td>
                      <td className="px-2 py-1 text-right">{l.qty}</td>
                      <td className="px-2 py-1 text-right">{l.receivedQty ?? 0}</td>
                      <td className="px-2 py-1 text-right">{l.unitPrice}</td>
                      <td className="px-2 py-1 text-right">{l.lineTotal}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className="rounded-xl bg-gray-900 px-3 py-2 text-sm font-semibold text-white"
                onClick={openReceive}
              >
                Receive stock
              </button>
              {detail.status === "DRAFT" && (
                <button
                  type="button"
                  className="rounded-xl border px-3 py-2 text-sm"
                  onClick={() => {
                    setErr("");
                    apiPatch(`/purchase-orders/${detail._id}/status`, { status: "SENT" })
                      .then(() => {
                        qc.invalidateQueries({ queryKey: ["purchaseOrder", detailId] });
                        qc.invalidateQueries({ queryKey: ["purchaseOrders"] });
                      })
                      .catch((e) => setErr(e.message));
                  }}
                >
                  Mark sent
                </button>
              )}
            </div>
          </div>
        )}
      </Modal>

      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="New purchase order"
        wide
      >
        {createMutation.isError && (
          <div className="mb-2 text-sm text-red-600">{createMutation.error.message}</div>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label="Supplier *">
            <TextInput
              value={form.supplierName}
              onChange={(e) => setForm((f) => ({ ...f, supplierName: e.target.value }))}
            />
          </FormField>
          <FormField label="Currency">
            <TextInput
              value={form.currency}
              onChange={(e) => setForm((f) => ({ ...f, currency: e.target.value }))}
            />
          </FormField>
          <FormField label="Remarks" className="sm:col-span-2">
            <TextInput
              value={form.remarks}
              onChange={(e) => setForm((f) => ({ ...f, remarks: e.target.value }))}
            />
          </FormField>
        </div>
        <div className="mt-4">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-sm font-medium">Lines</span>
            <button
              type="button"
              className="text-sm text-gray-700 underline"
              onClick={() => setForm((f) => ({ ...f, lines: [...f.lines, defaultLine()] }))}
            >
              + Add line
            </button>
          </div>
          <div className="space-y-2">
            {form.lines.map((line, idx) => (
              <div
                key={idx}
                className="grid grid-cols-2 gap-2 rounded-xl border p-2 sm:grid-cols-5"
              >
                <TextInput
                  placeholder="Item code"
                  value={line.itemCode}
                  onChange={(e) => {
                    const lines = [...form.lines];
                    lines[idx] = { ...lines[idx], itemCode: e.target.value };
                    setForm((f) => ({ ...f, lines }));
                  }}
                />
                <TextInput
                  type="number"
                  placeholder="Qty"
                  value={line.qty}
                  onChange={(e) => {
                    const lines = [...form.lines];
                    lines[idx] = { ...lines[idx], qty: Number(e.target.value) };
                    setForm((f) => ({ ...f, lines }));
                  }}
                />
                <TextInput
                  type="number"
                  step="0.01"
                  placeholder="Unit price"
                  value={line.unitPrice}
                  onChange={(e) => {
                    const lines = [...form.lines];
                    lines[idx] = { ...lines[idx], unitPrice: Number(e.target.value) };
                    setForm((f) => ({ ...f, lines }));
                  }}
                />
                <TextInput
                  placeholder="Desc"
                  className="sm:col-span-2"
                  value={line.description}
                  onChange={(e) => {
                    const lines = [...form.lines];
                    lines[idx] = { ...lines[idx], description: e.target.value };
                    setForm((f) => ({ ...f, lines }));
                  }}
                />
              </div>
            ))}
          </div>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            className="rounded-xl border px-4 py-2 text-sm"
            onClick={() => setCreateOpen(false)}
          >
            Cancel
          </button>
          <button
            type="button"
            className="rounded-xl bg-gray-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
            disabled={createMutation.isPending}
            onClick={() => {
              setErr("");
              createMutation.mutate();
            }}
          >
            {createMutation.isPending ? "Saving…" : "Create"}
          </button>
        </div>
      </Modal>

      <Modal open={receiveOpen} onClose={() => setReceiveOpen(false)} title="Receive against PO" wide>
        <FormField label="Warehouse">
          <TextInput
            value={receiveWarehouse}
            onChange={(e) => setReceiveWarehouse(e.target.value)}
          />
        </FormField>
        <div className="mt-3 max-h-64 space-y-2 overflow-y-auto">
          {receiveLines.map((rl, i) => (
            <div key={rl.lineId} className="flex flex-wrap items-center gap-2 text-sm">
              <span className="font-mono w-24">{rl.itemCode}</span>
              <span className="text-gray-500">max {rl.max}</span>
              <TextInput
                className="w-24"
                type="number"
                value={rl.qty}
                onChange={(e) => {
                  const next = [...receiveLines];
                  next[i] = { ...next[i], qty: Number(e.target.value) };
                  setReceiveLines(next);
                }}
              />
            </div>
          ))}
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            className="rounded-xl border px-4 py-2 text-sm"
            onClick={() => setReceiveOpen(false)}
          >
            Cancel
          </button>
          <button
            type="button"
            className="rounded-xl bg-gray-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
            disabled={receiveMutation.isPending}
            onClick={() => {
              setErr("");
              receiveMutation.mutate({
                warehouse: receiveWarehouse,
                lines: receiveLines
                  .filter((l) => l.qty > 0)
                  .map((l) => ({ lineId: l.lineId, qty: l.qty })),
              });
            }}
          >
            {receiveMutation.isPending ? "Posting…" : "Post receipt"}
          </button>
        </div>
      </Modal>
    </div>
  );
}
