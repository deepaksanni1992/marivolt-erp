import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import PageHeader from "../components/erp/PageHeader.jsx";
import Modal from "../components/erp/Modal.jsx";
import { FormField, TextInput } from "../components/erp/FormField.jsx";
import { apiGet, apiGetWithQuery, apiPost } from "../lib/api.js";

export default function Kitting() {
  const qc = useQueryClient();
  const [page, setPage] = useState(1);
  const limit = 25;
  const [createOpen, setCreateOpen] = useState(false);
  const [detailId, setDetailId] = useState(null);
  const [form, setForm] = useState({
    parentItemCode: "",
    warehouse: "MAIN",
    quantity: 1,
    remarks: "",
  });
  const [err, setErr] = useState("");

  const { data, isLoading, error } = useQuery({
    queryKey: ["kittingOrders", page],
    queryFn: () => apiGetWithQuery("/kitting", { page, limit }),
  });

  const { data: detail } = useQuery({
    queryKey: ["kittingOrder", detailId],
    queryFn: () => apiGet(`/kitting/${detailId}`),
    enabled: !!detailId,
  });

  const createMutation = useMutation({
    mutationFn: () => apiPost("/kitting", form),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["kittingOrders"] });
      setCreateOpen(false);
      setForm({ parentItemCode: "", warehouse: "MAIN", quantity: 1, remarks: "" });
    },
    onError: (e) => setErr(e.message),
  });

  const executeMutation = useMutation({
    mutationFn: (id) => apiPost(`/kitting/${id}/execute`, {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["kittingOrders"] });
      qc.invalidateQueries({ queryKey: ["kittingOrder", detailId] });
      qc.invalidateQueries({ queryKey: ["stockBalances"] });
      qc.invalidateQueries({ queryKey: ["inventoryLedger"] });
    },
    onError: (e) => setErr(e.message),
  });

  const cancelMutation = useMutation({
    mutationFn: (id) => apiPost(`/kitting/${id}/cancel`, {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["kittingOrders"] });
      qc.invalidateQueries({ queryKey: ["kittingOrder", detailId] });
    },
    onError: (e) => setErr(e.message),
  });

  const rows = data?.items ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / limit));

  return (
    <div>
      <PageHeader
        title="Kitting"
        subtitle="Build kits from BOM: consumes components, adds parent stock when executed."
      >
        <button
          type="button"
          onClick={() => {
            setErr("");
            setCreateOpen(true);
          }}
          className="rounded-xl bg-gray-900 px-3 py-2 text-sm font-semibold text-white"
        >
          New kit order
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
                <th className="px-3 py-2">Kit #</th>
                <th className="px-3 py-2">Parent</th>
                <th className="px-3 py-2">Wh</th>
                <th className="px-3 py-2 text-right">Qty</th>
                <th className="px-3 py-2">Status</th>
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
                    No kitting orders.
                  </td>
                </tr>
              ) : (
                rows.map((r) => (
                  <tr key={r._id} className="border-b border-gray-100 hover:bg-gray-50/80">
                    <td className="px-3 py-2 font-mono text-xs">{r.kitNumber}</td>
                    <td className="px-3 py-2 font-mono text-xs">{r.parentItemCode}</td>
                    <td className="px-3 py-2">{r.warehouse}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{r.quantity}</td>
                    <td className="px-3 py-2">{r.status}</td>
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
            Page {page}/{totalPages} · {total} orders
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

      <Modal open={!!detailId} onClose={() => setDetailId(null)} title="Kitting order" wide>
        {!detail ? (
          <p className="text-sm text-gray-500">Loading…</p>
        ) : (
          <div className="space-y-3 text-sm">
            <div className="flex flex-wrap gap-4">
              <div>
                <span className="text-gray-500">Number</span>{" "}
                <span className="font-mono font-semibold">{detail.kitNumber}</span>
              </div>
              <div>
                <span className="text-gray-500">Parent</span>{" "}
                <span className="font-mono">{detail.parentItemCode}</span>
              </div>
              <div>
                <span className="text-gray-500">Warehouse</span> {detail.warehouse}
              </div>
              <div>
                <span className="text-gray-500">Kits</span> {detail.quantity}
              </div>
              <div>
                <span className="text-gray-500">Status</span> {detail.status}
              </div>
            </div>
            {detail.linesSnapshot?.length > 0 && (
              <div>
                <div className="mb-1 text-xs font-semibold text-gray-500">
                  BOM snapshot (at completion)
                </div>
                <div className="overflow-x-auto rounded-xl border">
                  <table className="min-w-full text-xs">
                    <thead className="bg-gray-50">
                      <tr>
                        <th className="px-2 py-1 text-left">Component</th>
                        <th className="px-2 py-1 text-right">Qty / kit</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detail.linesSnapshot.map((l, i) => (
                        <tr key={i} className="border-t">
                          <td className="px-2 py-1 font-mono">{l.componentItemCode}</td>
                          <td className="px-2 py-1 text-right">{l.qtyPerKit}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
            {detail.status === "DRAFT" && (
              <div className="flex flex-wrap gap-2 border-t pt-3">
                <button
                  type="button"
                  className="rounded-xl bg-gray-900 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50"
                  disabled={executeMutation.isPending}
                  onClick={() => {
                    setErr("");
                    if (
                      confirm(
                        "Execute kitting? This will consume components and add parent stock."
                      )
                    ) {
                      executeMutation.mutate(detail._id);
                    }
                  }}
                >
                  Execute
                </button>
                <button
                  type="button"
                  className="rounded-xl border px-3 py-2 text-sm disabled:opacity-50"
                  disabled={cancelMutation.isPending}
                  onClick={() => {
                    setErr("");
                    if (confirm("Cancel this draft order?")) {
                      cancelMutation.mutate(detail._id);
                    }
                  }}
                >
                  Cancel order
                </button>
              </div>
            )}
          </div>
        )}
      </Modal>

      <Modal open={createOpen} onClose={() => setCreateOpen(false)} title="New kitting order" wide>
        {createMutation.isError && (
          <div className="mb-2 text-sm text-red-600">{createMutation.error.message}</div>
        )}
        <p className="mb-3 text-xs text-gray-500">
          Requires an active BOM for the parent item code. Component stock must exist in the
          chosen warehouse.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label="Parent item code *">
            <TextInput
              value={form.parentItemCode}
              onChange={(e) => setForm((f) => ({ ...f, parentItemCode: e.target.value }))}
            />
          </FormField>
          <FormField label="Warehouse">
            <TextInput
              value={form.warehouse}
              onChange={(e) => setForm((f) => ({ ...f, warehouse: e.target.value }))}
            />
          </FormField>
          <FormField label="Number of kits *">
            <TextInput
              type="number"
              step="0.0001"
              value={form.quantity}
              onChange={(e) => setForm((f) => ({ ...f, quantity: Number(e.target.value) }))}
            />
          </FormField>
          <FormField label="Remarks" className="sm:col-span-2">
            <TextInput
              value={form.remarks}
              onChange={(e) => setForm((f) => ({ ...f, remarks: e.target.value }))}
            />
          </FormField>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            className="rounded-xl border px-4 py-2 text-sm"
            onClick={() => setCreateOpen(false)}
          >
            Close
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
            {createMutation.isPending ? "Creating…" : "Create draft"}
          </button>
        </div>
      </Modal>
    </div>
  );
}
