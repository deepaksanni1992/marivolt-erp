import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import PageHeader from "../components/erp/PageHeader.jsx";
import { TextInput } from "../components/erp/FormField.jsx";
import Modal from "../components/erp/Modal.jsx";
import Inventory from "./Inventory.jsx";
import { apiGet, apiGetWithQuery, apiPatch, apiPost } from "../lib/api.js";

function money(n) {
  return Number(n || 0).toFixed(2);
}

export default function Store() {
  const qc = useQueryClient();
  const [tab, setTab] = useState("orders");
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [allocationOpenId, setAllocationOpenId] = useState(null);
  const [selected, setSelected] = useState({});
  const [packing, setPacking] = useState({
    totalWeightKg: "",
    boxCount: "",
    boxDimensionsMm: "",
  });
  const limit = 20;

  const { data: allocationData, isLoading: allocationLoading } = useQuery({
    queryKey: ["store-order-allocations", page, search],
    queryFn: () =>
      apiGetWithQuery("/sales/order-allocations", {
        page,
        limit,
        search: search || undefined,
      }),
    enabled: tab === "orders",
  });

  const { data: allocationDetail } = useQuery({
    queryKey: ["store-order-allocation-detail", allocationOpenId],
    queryFn: () => apiGet(`/sales/order-allocations/${allocationOpenId}`),
    enabled: !!allocationOpenId,
  });

  const { data: rtsData, isLoading: rtsLoading } = useQuery({
    queryKey: ["store-rts", page, search],
    queryFn: () =>
      apiGetWithQuery("/sales/rts", {
        page,
        limit,
        search: search || undefined,
      }),
    enabled: tab === "rts",
  });

  const createRtsMutation = useMutation({
    mutationFn: () => {
      const lines = (allocationDetail?.lines || [])
        .map((line) => {
          const s = selected[String(line._id)] || {};
          const qty = Number(s.qty || 0);
          if (!(qty > 0)) return null;
          return {
            allocationLineId: line._id,
            qty,
            unitWeightKg: s.unitWeightKg === "" ? null : Number(s.unitWeightKg),
          };
        })
        .filter(Boolean);
      return apiPost(`/sales/order-allocations/${allocationOpenId}/rts`, {
        lines,
        packingDetails: {
          totalWeightKg: Number(packing.totalWeightKg || 0),
          boxCount: Number(packing.boxCount || 0),
          boxDimensionsMm: packing.boxDimensionsMm || "",
        },
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["store-order-allocations"] });
      qc.invalidateQueries({ queryKey: ["store-order-allocation-detail", allocationOpenId] });
      qc.invalidateQueries({ queryKey: ["store-rts"] });
      setAllocationOpenId(null);
      setSelected({});
      setPacking({ totalWeightKg: "", boxCount: "", boxDimensionsMm: "" });
    },
  });

  const approveRtsMutation = useMutation({
    mutationFn: (id) => apiPatch(`/sales/rts/${id}/approve`, {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["store-rts"] });
      qc.invalidateQueries({ queryKey: ["store-order-allocations"] });
    },
  });

  const convertAllocationToInvoiceMutation = useMutation({
    mutationFn: (id) => apiPost(`/sales/order-allocations/${id}/to-sales-invoice`, {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["store-order-allocations"] });
    },
  });

  const rows = allocationData?.items || [];
  const rtsRows = rtsData?.items || [];
  const totalPages = Math.max(1, Math.ceil((allocationData?.total || 0) / limit));
  const rtsPages = Math.max(1, Math.ceil((rtsData?.total || 0) / limit));

  const canSubmitRts = useMemo(() => {
    const anySelected = Object.values(selected).some((x) => Number(x?.qty || 0) > 0);
    return anySelected && !createRtsMutation.isPending;
  }, [selected, createRtsMutation.isPending]);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Store"
        subtitle="Order allocation processing, RTS creation, and inventory visibility."
      />

      <div className="flex flex-wrap gap-2 rounded-2xl border bg-white p-2">
        {[
          { key: "orders", label: "Order List" },
          { key: "rts", label: "RTS" },
          { key: "inventory", label: "Inventory" },
        ].map((t) => (
          <button
            key={t.key}
            type="button"
            className={`rounded-xl px-3 py-1.5 text-sm ${tab === t.key ? "bg-gray-900 text-white" : "hover:bg-gray-100"}`}
            onClick={() => {
              setTab(t.key);
              setPage(1);
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "inventory" ? (
        <Inventory />
      ) : tab === "orders" ? (
        <>
          <div className="rounded-2xl border bg-white p-3">
            <TextInput
              className="w-72"
              placeholder="Search allocation/customer"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
            />
          </div>
          <div className="overflow-hidden rounded-2xl border bg-white">
            <div className="overflow-x-auto">
              <table className="min-w-full text-left text-sm">
                <thead className="border-b bg-gray-100 text-xs font-semibold uppercase tracking-wide text-gray-700">
                  <tr>
                    <th className="px-3 py-2">Allocation No</th>
                    <th className="px-3 py-2">Date</th>
                    <th className="px-3 py-2">Customer</th>
                    <th className="px-3 py-2">Linked</th>
                    <th className="px-3 py-2">Status</th>
                    <th className="px-3 py-2">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {allocationLoading ? (
                    <tr><td className="px-3 py-8 text-center text-gray-500" colSpan={6}>Loading...</td></tr>
                  ) : rows.length === 0 ? (
                    <tr><td className="px-3 py-8 text-center text-gray-500" colSpan={6}>No order allocation found.</td></tr>
                  ) : (
                    rows.map((r) => (
                      <tr key={r._id} className="border-b border-gray-100">
                        <td className="px-3 py-2 font-mono text-xs">{r.allocationNo}</td>
                        <td className="px-3 py-2">{r.allocationDate ? new Date(r.allocationDate).toLocaleDateString() : "-"}</td>
                        <td className="px-3 py-2">{r.customerName}</td>
                        <td className="px-3 py-2 text-xs">{r.linkedProformaNo || r.linkedOANo || "-"}</td>
                        <td className="px-3 py-2">{r.status}</td>
                        <td className="px-3 py-2">
                          <div className="flex flex-wrap gap-1">
                            <button type="button" className="rounded-lg border px-2 py-1 text-xs" onClick={() => setAllocationOpenId(r._id)}>
                              Create RTS
                            </button>
                            <button
                              type="button"
                              className="rounded-lg border px-2 py-1 text-xs"
                              onClick={() => convertAllocationToInvoiceMutation.mutate(r._id)}
                            >
                              Convert to SI
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
            <div className="flex items-center justify-between border-t px-3 py-2 text-sm text-gray-600">
              <span>Page {page}/{totalPages} · {allocationData?.total || 0} allocations</span>
              <div className="flex gap-2">
                <button type="button" className="rounded border px-2 py-1 disabled:opacity-40" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Prev</button>
                <button type="button" className="rounded border px-2 py-1 disabled:opacity-40" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>Next</button>
              </div>
            </div>
          </div>
        </>
      ) : (
        <>
          <div className="rounded-2xl border bg-white p-3">
            <TextInput
              className="w-72"
              placeholder="Search RTS/customer"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
            />
          </div>
          <div className="overflow-hidden rounded-2xl border bg-white">
            <div className="overflow-x-auto">
              <table className="min-w-full text-left text-sm">
                <thead className="border-b bg-gray-100 text-xs font-semibold uppercase tracking-wide text-gray-700">
                  <tr>
                    <th className="px-3 py-2">RTS No</th>
                    <th className="px-3 py-2">Date</th>
                    <th className="px-3 py-2">Allocation</th>
                    <th className="px-3 py-2">Customer</th>
                    <th className="px-3 py-2">Boxes</th>
                    <th className="px-3 py-2">Weight (Kg)</th>
                    <th className="px-3 py-2">Status</th>
                    <th className="px-3 py-2">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {rtsLoading ? (
                    <tr><td className="px-3 py-8 text-center text-gray-500" colSpan={8}>Loading...</td></tr>
                  ) : rtsRows.length === 0 ? (
                    <tr><td className="px-3 py-8 text-center text-gray-500" colSpan={8}>No RTS found.</td></tr>
                  ) : (
                    rtsRows.map((r) => (
                      <tr key={r._id} className="border-b border-gray-100">
                        <td className="px-3 py-2 font-mono text-xs">{r.rtsNo}</td>
                        <td className="px-3 py-2">{r.rtsDate ? new Date(r.rtsDate).toLocaleDateString() : "-"}</td>
                        <td className="px-3 py-2">{r.linkedOrderAllocationNo || "-"}</td>
                        <td className="px-3 py-2">{r.customerName || "-"}</td>
                        <td className="px-3 py-2">{r.packingDetails?.boxCount ?? r.boxCount ?? 0}</td>
                        <td className="px-3 py-2">{money(r.packingDetails?.totalWeightKg ?? r.totalWeightKg ?? 0)}</td>
                        <td className="px-3 py-2">{r.status}</td>
                        <td className="px-3 py-2">
                          <button
                            type="button"
                            className="rounded-lg border px-2 py-1 text-xs disabled:opacity-40"
                            disabled={String(r.status || "").toUpperCase() === "APPROVED"}
                            onClick={() => approveRtsMutation.mutate(r._id)}
                          >
                            Approve
                          </button>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
            <div className="flex items-center justify-between border-t px-3 py-2 text-sm text-gray-600">
              <span>Page {page}/{rtsPages} · {rtsData?.total || 0} RTS</span>
              <div className="flex gap-2">
                <button type="button" className="rounded border px-2 py-1 disabled:opacity-40" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Prev</button>
                <button type="button" className="rounded border px-2 py-1 disabled:opacity-40" disabled={page >= rtsPages} onClick={() => setPage((p) => p + 1)}>Next</button>
              </div>
            </div>
          </div>
        </>
      )}

      <Modal
        open={!!allocationOpenId}
        onClose={() => {
          setAllocationOpenId(null);
          setSelected({});
          setPacking({ totalWeightKg: "", boxCount: "", boxDimensionsMm: "" });
        }}
        title={`Create RTS${allocationDetail?.allocationNo ? ` • ${allocationDetail.allocationNo}` : ""}`}
        xlarge
      >
        {!allocationDetail ? (
          <p className="text-sm text-gray-500">Loading allocation...</p>
        ) : (
          <div className="space-y-4">
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className="rounded-xl border px-3 py-1.5 text-xs"
                onClick={() => {
                  const next = {};
                  for (const line of allocationDetail.lines || []) {
                    next[String(line._id)] = {
                      qty: Number(line.pendingQty || 0),
                      unitWeightKg: line.unitWeightKg ?? "",
                    };
                  }
                  setSelected(next);
                }}
              >
                Select All Pending
              </button>
              <button
                type="button"
                className="rounded-xl border px-3 py-1.5 text-xs"
                onClick={() => {
                  const next = {};
                  for (const line of allocationDetail.lines || []) {
                    next[String(line._id)] = {
                      qty: Number(line.qty || 0),
                      unitWeightKg: line.unitWeightKg ?? "",
                    };
                  }
                  setSelected(next);
                }}
              >
                Select Full Quantities
              </button>
              <button type="button" className="rounded-xl border px-3 py-1.5 text-xs" onClick={() => setSelected({})}>
                Clear Selection
              </button>
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <TextInput
                placeholder="Total Weight (Kg)"
                type="number"
                value={packing.totalWeightKg}
                onChange={(e) => setPacking((p) => ({ ...p, totalWeightKg: e.target.value }))}
              />
              <TextInput
                placeholder="Number of boxes"
                type="number"
                value={packing.boxCount}
                onChange={(e) => setPacking((p) => ({ ...p, boxCount: e.target.value }))}
              />
              <TextInput
                placeholder="Box dimensions (LxWxH mm)"
                value={packing.boxDimensionsMm}
                onChange={(e) => setPacking((p) => ({ ...p, boxDimensionsMm: e.target.value }))}
              />
            </div>
            <div className="overflow-x-auto rounded-xl border">
              <table className="min-w-[1100px] w-full text-xs">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-2 py-2 text-left">S/N</th>
                    <th className="px-2 py-2 text-left">Article</th>
                    <th className="px-2 py-2 text-left">Part no</th>
                    <th className="px-2 py-2 text-left">Description</th>
                    <th className="px-2 py-2 text-right">Qty</th>
                    <th className="px-2 py-2 text-right">Shipped</th>
                    <th className="px-2 py-2 text-right">Pending</th>
                    <th className="px-2 py-2 text-right">RTS Qty</th>
                    <th className="px-2 py-2 text-right">Unit wt (Kg)</th>
                  </tr>
                </thead>
                <tbody>
                  {(allocationDetail.lines || []).map((line, idx) => {
                    const key = String(line._id);
                    const row = selected[key] || {};
                    return (
                      <tr key={key} className="border-t">
                        <td className="px-2 py-1">{idx + 1}</td>
                        <td className="px-2 py-1">{line.article}</td>
                        <td className="px-2 py-1">{line.partNumber || "-"}</td>
                        <td className="px-2 py-1">{line.description}</td>
                        <td className="px-2 py-1 text-right">{line.qty}</td>
                        <td className="px-2 py-1 text-right">{line.shippedQty || 0}</td>
                        <td className="px-2 py-1 text-right">{line.pendingQty || 0}</td>
                        <td className="px-2 py-1">
                          <TextInput
                            type="number"
                            value={row.qty ?? ""}
                            onChange={(e) =>
                              setSelected((s) => ({
                                ...s,
                                [key]: { ...row, qty: e.target.value },
                              }))
                            }
                          />
                        </td>
                        <td className="px-2 py-1">
                          <TextInput
                            type="number"
                            value={row.unitWeightKg ?? line.unitWeightKg ?? ""}
                            onChange={(e) =>
                              setSelected((s) => ({
                                ...s,
                                [key]: { ...row, unitWeightKg: e.target.value },
                              }))
                            }
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="flex justify-end gap-2">
              <button type="button" className="rounded-xl border px-4 py-2 text-sm" onClick={() => setAllocationOpenId(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="rounded-xl bg-gray-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-40"
                disabled={!canSubmitRts}
                onClick={() => createRtsMutation.mutate()}
              >
                {createRtsMutation.isPending ? "Creating..." : "Create RTS"}
              </button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}

