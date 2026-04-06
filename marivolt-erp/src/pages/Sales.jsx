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
  salePrice: 0,
  currency: "USD",
  remarks: "",
});

export default function Sales() {
  const qc = useQueryClient();
  const [page, setPage] = useState(1);
  const limit = 20;
  const [createOpen, setCreateOpen] = useState(false);
  const [detailId, setDetailId] = useState(null);
  const [stockOpen, setStockOpen] = useState(false);
  const [form, setForm] = useState({
    customerName: "",
    currency: "USD",
    remarks: "",
    lines: [defaultLine()],
  });
  const [stockWarehouse, setStockWarehouse] = useState("MAIN");
  const [stockLines, setStockLines] = useState([]);
  const [err, setErr] = useState("");

  const { data, isLoading, error } = useQuery({
    queryKey: ["quotations", page],
    queryFn: () => apiGetWithQuery("/quotations", { page, limit }),
  });

  const { data: detail } = useQuery({
    queryKey: ["quotation", detailId],
    queryFn: () => apiGet(`/quotations/${detailId}`),
    enabled: !!detailId,
  });

  const createMutation = useMutation({
    mutationFn: () => apiPost("/quotations", form),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["quotations"] });
      setCreateOpen(false);
      setForm({ customerName: "", currency: "USD", remarks: "", lines: [defaultLine()] });
    },
    onError: (e) => setErr(e.message),
  });

  const stockOutMutation = useMutation({
    mutationFn: (body) => apiPost(`/quotations/${detailId}/stock-out`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["quotations"] });
      qc.invalidateQueries({ queryKey: ["quotation", detailId] });
      qc.invalidateQueries({ queryKey: ["stockBalances"] });
      qc.invalidateQueries({ queryKey: ["inventoryLedger"] });
      setStockOpen(false);
    },
    onError: (e) => setErr(e.message),
  });

  function openStockOut() {
    if (!detail?.lines?.length) return;
    setErr("");
    setStockWarehouse("MAIN");
    setStockLines(
      detail.lines.map((l) => ({
        lineId: l._id,
        itemCode: l.itemCode,
        max: l.qty || 0,
        qty: l.qty || 0,
      }))
    );
    setStockOpen(true);
  }

  const rows = data?.items ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / limit));

  return (
    <div>
      <PageHeader title="Sales" subtitle="Quotations and issue stock from accepted lines.">
        <button
          type="button"
          onClick={() => {
            setErr("");
            setCreateOpen(true);
          }}
          className="rounded-xl bg-gray-900 px-3 py-2 text-sm font-semibold text-white"
        >
          New quotation
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
                <th className="px-3 py-2">Quote #</th>
                <th className="px-3 py-2">Customer</th>
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
                    No quotations.
                  </td>
                </tr>
              ) : (
                rows.map((r) => (
                  <tr key={r._id} className="border-b border-gray-100 hover:bg-gray-50/80">
                    <td className="px-3 py-2 font-mono text-xs">{r.quotationNumber}</td>
                    <td className="px-3 py-2">{r.customerName}</td>
                    <td className="px-3 py-2 text-gray-600">
                      {r.quotationDate
                        ? new Date(r.quotationDate).toLocaleDateString()
                        : "—"}
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
            Page {page}/{totalPages} · {total} quotes
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

      <Modal open={!!detailId} onClose={() => setDetailId(null)} title="Quotation" wide>
        {!detail ? (
          <p className="text-sm text-gray-500">Loading…</p>
        ) : (
          <div className="space-y-3 text-sm">
            <div className="flex flex-wrap gap-4">
              <div>
                <span className="text-gray-500">Quote</span>{" "}
                <span className="font-mono font-semibold">{detail.quotationNumber}</span>
              </div>
              <div>
                <span className="text-gray-500">Customer</span> {detail.customerName}
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
                    <th className="px-2 py-1 text-right">Price</th>
                    <th className="px-2 py-1 text-right">Line</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.lines?.map((l) => (
                    <tr key={l._id} className="border-t">
                      <td className="px-2 py-1 font-mono">{l.itemCode}</td>
                      <td className="px-2 py-1 text-right">{l.qty}</td>
                      <td className="px-2 py-1 text-right">{l.salePrice}</td>
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
                onClick={openStockOut}
              >
                Stock out
              </button>
              {detail.status === "DRAFT" && (
                <button
                  type="button"
                  className="rounded-xl border px-3 py-2 text-sm"
                  onClick={() => {
                    setErr("");
                    apiPatch(`/quotations/${detail._id}/status`, { status: "SENT" })
                      .then(() => {
                        qc.invalidateQueries({ queryKey: ["quotation", detailId] });
                        qc.invalidateQueries({ queryKey: ["quotations"] });
                      })
                      .catch((e) => setErr(e.message));
                  }}
                >
                  Mark sent
                </button>
              )}
              {detail.status === "SENT" && (
                <button
                  type="button"
                  className="rounded-xl border px-3 py-2 text-sm"
                  onClick={() => {
                    setErr("");
                    apiPatch(`/quotations/${detail._id}/status`, { status: "ACCEPTED" })
                      .then(() => {
                        qc.invalidateQueries({ queryKey: ["quotation", detailId] });
                        qc.invalidateQueries({ queryKey: ["quotations"] });
                      })
                      .catch((e) => setErr(e.message));
                  }}
                >
                  Mark accepted
                </button>
              )}
            </div>
          </div>
        )}
      </Modal>

      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="New quotation"
        wide
      >
        {createMutation.isError && (
          <div className="mb-2 text-sm text-red-600">{createMutation.error.message}</div>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label="Customer *">
            <TextInput
              value={form.customerName}
              onChange={(e) => setForm((f) => ({ ...f, customerName: e.target.value }))}
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
                  placeholder="Sale price"
                  value={line.salePrice}
                  onChange={(e) => {
                    const lines = [...form.lines];
                    lines[idx] = { ...lines[idx], salePrice: Number(e.target.value) };
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

      <Modal open={stockOpen} onClose={() => setStockOpen(false)} title="Stock out from quotation" wide>
        <FormField label="Warehouse">
          <TextInput
            value={stockWarehouse}
            onChange={(e) => setStockWarehouse(e.target.value)}
          />
        </FormField>
        <div className="mt-3 max-h-64 space-y-2 overflow-y-auto">
          {stockLines.map((rl, i) => (
            <div key={rl.lineId} className="flex flex-wrap items-center gap-2 text-sm">
              <span className="w-24 font-mono">{rl.itemCode}</span>
              <span className="text-gray-500">max {rl.max}</span>
              <TextInput
                className="w-24"
                type="number"
                value={rl.qty}
                onChange={(e) => {
                  const next = [...stockLines];
                  next[i] = { ...next[i], qty: Number(e.target.value) };
                  setStockLines(next);
                }}
              />
            </div>
          ))}
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            className="rounded-xl border px-4 py-2 text-sm"
            onClick={() => setStockOpen(false)}
          >
            Cancel
          </button>
          <button
            type="button"
            className="rounded-xl bg-gray-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
            disabled={stockOutMutation.isPending}
            onClick={() => {
              setErr("");
              stockOutMutation.mutate({
                warehouse: stockWarehouse,
                lines: stockLines
                  .filter((l) => l.qty > 0)
                  .map((l) => ({ lineId: l.lineId, qty: l.qty })),
              });
            }}
          >
            {stockOutMutation.isPending ? "Posting…" : "Post stock out"}
          </button>
        </div>
      </Modal>
    </div>
  );
}
