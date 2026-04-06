import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import PageHeader from "../components/erp/PageHeader.jsx";
import Modal from "../components/erp/Modal.jsx";
import { FormField, TextInput } from "../components/erp/FormField.jsx";
import { apiGetWithQuery, apiPost } from "../lib/api.js";

const tabs = [
  { id: "balances", label: "Stock balances" },
  { id: "ledger", label: "Ledger" },
  { id: "movements", label: "Movements" },
];

export default function Inventory() {
  const qc = useQueryClient();
  const [tab, setTab] = useState("balances");
  const [page, setPage] = useState(1);
  const limit = 40;
  const [filterItem, setFilterItem] = useState("");
  const [filterWh, setFilterWh] = useState("");
  const [modal, setModal] = useState(null);
  const [err, setErr] = useState("");

  const balQuery = useQuery({
    queryKey: ["stockBalances", page, filterItem, filterWh],
    queryFn: () =>
      apiGetWithQuery("/inventory/balances", {
        page,
        limit,
        itemCode: filterItem.trim() || undefined,
        warehouse: filterWh.trim() || undefined,
      }),
    enabled: tab === "balances",
  });

  const ledQuery = useQuery({
    queryKey: ["inventoryLedger", page, filterItem, filterWh],
    queryFn: () =>
      apiGetWithQuery("/inventory/ledger", {
        page,
        limit,
        itemCode: filterItem.trim() || undefined,
        warehouse: filterWh.trim() || undefined,
      }),
    enabled: tab === "ledger",
  });

  const movementMutation = useMutation({
    mutationFn: ({ path, body }) => apiPost(path, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["stockBalances"] });
      qc.invalidateQueries({ queryKey: ["inventoryLedger"] });
      setModal(null);
      setErr("");
    },
    onError: (e) => setErr(e.message),
  });

  const [mv, setMv] = useState({
    itemCode: "",
    warehouse: "MAIN",
    qty: 1,
    qtyDelta: 0,
    quantity: 0,
    unitCost: 0,
    referenceType: "",
    referenceNumber: "",
    remarks: "",
    movementType: "IN_PURCHASE",
  });

  const balRows = balQuery.data?.items ?? [];
  const balTotal = balQuery.data?.total ?? 0;
  const ledRows = ledQuery.data?.items ?? [];
  const ledTotal = ledQuery.data?.total ?? 0;
  const activeTotal = tab === "balances" ? balTotal : ledTotal;
  const totalPages = Math.max(1, Math.ceil(activeTotal / limit));

  return (
    <div>
      <PageHeader
        title="Inventory"
        subtitle="Balances, movement history, and manual stock adjustments."
      />

      {err ? (
        <div className="mb-4 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {err}
        </div>
      ) : null}

      <div className="mb-4 flex flex-wrap gap-2 rounded-2xl border bg-white p-2">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => {
              setTab(t.id);
              setPage(1);
            }}
            className={[
              "rounded-xl px-4 py-2 text-sm font-medium",
              tab === t.id ? "bg-gray-900 text-white" : "text-gray-700 hover:bg-gray-100",
            ].join(" ")}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab !== "movements" && (
        <div className="mb-4 flex flex-wrap items-end gap-3 rounded-2xl border bg-white p-4">
          <FormField label="Item code" className="min-w-[140px]">
            <TextInput value={filterItem} onChange={(e) => setFilterItem(e.target.value)} />
          </FormField>
          <FormField label="Warehouse" className="min-w-[120px]">
            <TextInput value={filterWh} onChange={(e) => setFilterWh(e.target.value)} />
          </FormField>
          <button
            type="button"
            className="rounded-xl bg-gray-100 px-3 py-2 text-sm"
            onClick={() => setPage(1)}
          >
            Apply filters
          </button>
        </div>
      )}

      {tab === "movements" && (
        <div className="mb-4 flex flex-wrap gap-2">
          <button
            type="button"
            className="rounded-xl border bg-white px-3 py-2 text-sm"
            onClick={() => {
              setErr("");
              setModal("in");
            }}
          >
            Stock in
          </button>
          <button
            type="button"
            className="rounded-xl border bg-white px-3 py-2 text-sm"
            onClick={() => {
              setErr("");
              setModal("out");
            }}
          >
            Stock out
          </button>
          <button
            type="button"
            className="rounded-xl border bg-white px-3 py-2 text-sm"
            onClick={() => {
              setErr("");
              setModal("adj");
            }}
          >
            Adjustment
          </button>
          <button
            type="button"
            className="rounded-xl border bg-white px-3 py-2 text-sm"
            onClick={() => {
              setErr("");
              setModal("open");
            }}
          >
            Opening balance
          </button>
        </div>
      )}

      {tab === "balances" && (
        <div className="overflow-hidden rounded-2xl border bg-white">
          <div className="overflow-x-auto">
            <table className="min-w-full text-left text-sm">
              <thead className="border-b bg-gray-50 text-xs font-semibold text-gray-600">
                <tr>
                  <th className="px-3 py-2">Item</th>
                  <th className="px-3 py-2">Warehouse</th>
                  <th className="px-3 py-2 text-right">Qty</th>
                  <th className="px-3 py-2 text-right">Reserved</th>
                  <th className="px-3 py-2 text-right">Unit cost</th>
                </tr>
              </thead>
              <tbody>
                {balQuery.isLoading ? (
                  <tr>
                    <td colSpan={5} className="px-3 py-8 text-center text-gray-500">
                      Loading…
                    </td>
                  </tr>
                ) : balRows.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-3 py-8 text-center text-gray-500">
                      No balances.
                    </td>
                  </tr>
                ) : (
                  balRows.map((r) => (
                    <tr key={r._id} className="border-b border-gray-100">
                      <td className="px-3 py-2 font-mono text-xs">{r.itemCode}</td>
                      <td className="px-3 py-2">{r.warehouse}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{r.quantity}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{r.reservedQty}</td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {Number(r.unitCost || 0).toFixed(2)}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === "ledger" && (
        <div className="overflow-hidden rounded-2xl border bg-white">
          <div className="overflow-x-auto">
            <table className="min-w-full text-left text-sm">
              <thead className="border-b bg-gray-50 text-xs font-semibold text-gray-600">
                <tr>
                  <th className="px-3 py-2">When</th>
                  <th className="px-3 py-2">Type</th>
                  <th className="px-3 py-2">Item</th>
                  <th className="px-3 py-2">Wh</th>
                  <th className="px-3 py-2 text-right">Δ</th>
                  <th className="px-3 py-2">Ref</th>
                </tr>
              </thead>
              <tbody>
                {ledQuery.isLoading ? (
                  <tr>
                    <td colSpan={6} className="px-3 py-8 text-center text-gray-500">
                      Loading…
                    </td>
                  </tr>
                ) : ledRows.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-3 py-8 text-center text-gray-500">
                      No movements.
                    </td>
                  </tr>
                ) : (
                  ledRows.map((r) => (
                    <tr key={r._id} className="border-b border-gray-100">
                      <td className="px-3 py-2 text-xs text-gray-600">
                        {r.createdAt ? new Date(r.createdAt).toLocaleString() : "—"}
                      </td>
                      <td className="px-3 py-2 text-xs">{r.movementType}</td>
                      <td className="px-3 py-2 font-mono text-xs">{r.itemCode}</td>
                      <td className="px-3 py-2">{r.warehouse}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{r.qtyDelta}</td>
                      <td className="px-3 py-2 text-xs">
                        {r.referenceNumber || r.referenceType || "—"}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab !== "movements" && (
        <div className="mt-3 flex items-center justify-between text-sm text-gray-600">
          <span>
            Page {page}/{totalPages} · {activeTotal} rows
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
      )}

      <Modal
        open={modal === "in"}
        onClose={() => setModal(null)}
        title="Stock in"
        wide
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label="Item code *">
            <TextInput value={mv.itemCode} onChange={(e) => setMv((m) => ({ ...m, itemCode: e.target.value }))} />
          </FormField>
          <FormField label="Warehouse">
            <TextInput
              value={mv.warehouse}
              onChange={(e) => setMv((m) => ({ ...m, warehouse: e.target.value }))}
            />
          </FormField>
          <FormField label="Qty *">
            <TextInput
              type="number"
              value={mv.qty}
              onChange={(e) => setMv((m) => ({ ...m, qty: Number(e.target.value) }))}
            />
          </FormField>
          <FormField label="Unit cost">
            <TextInput
              type="number"
              step="0.01"
              value={mv.unitCost}
              onChange={(e) => setMv((m) => ({ ...m, unitCost: Number(e.target.value) }))}
            />
          </FormField>
          <FormField label="Movement type">
            <TextInput
              value={mv.movementType}
              onChange={(e) => setMv((m) => ({ ...m, movementType: e.target.value }))}
              placeholder="IN_PURCHASE"
            />
          </FormField>
          <FormField label="Reference #">
            <TextInput
              value={mv.referenceNumber}
              onChange={(e) => setMv((m) => ({ ...m, referenceNumber: e.target.value }))}
            />
          </FormField>
          <FormField label="Reference type" className="sm:col-span-2">
            <TextInput
              value={mv.referenceType}
              onChange={(e) => setMv((m) => ({ ...m, referenceType: e.target.value }))}
            />
          </FormField>
          <FormField label="Remarks" className="sm:col-span-2">
            <TextInput
              value={mv.remarks}
              onChange={(e) => setMv((m) => ({ ...m, remarks: e.target.value }))}
            />
          </FormField>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" className="rounded-xl border px-4 py-2 text-sm" onClick={() => setModal(null)}>
            Cancel
          </button>
          <button
            type="button"
            className="rounded-xl bg-gray-900 px-4 py-2 text-sm font-semibold text-white"
            disabled={movementMutation.isPending}
            onClick={() =>
              movementMutation.mutate({
                path: "/inventory/stock-in",
                body: {
                  itemCode: mv.itemCode,
                  warehouse: mv.warehouse,
                  qty: mv.qty,
                  unitCost: mv.unitCost,
                  movementType: mv.movementType || "IN_PURCHASE",
                  referenceType: mv.referenceType,
                  referenceNumber: mv.referenceNumber,
                  remarks: mv.remarks,
                },
              })
            }
          >
            Post
          </button>
        </div>
      </Modal>

      <Modal open={modal === "out"} onClose={() => setModal(null)} title="Stock out" wide>
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label="Item code *">
            <TextInput value={mv.itemCode} onChange={(e) => setMv((m) => ({ ...m, itemCode: e.target.value }))} />
          </FormField>
          <FormField label="Warehouse">
            <TextInput
              value={mv.warehouse}
              onChange={(e) => setMv((m) => ({ ...m, warehouse: e.target.value }))}
            />
          </FormField>
          <FormField label="Qty *">
            <TextInput
              type="number"
              value={mv.qty}
              onChange={(e) => setMv((m) => ({ ...m, qty: Number(e.target.value) }))}
            />
          </FormField>
          <FormField label="Reference #">
            <TextInput
              value={mv.referenceNumber}
              onChange={(e) => setMv((m) => ({ ...m, referenceNumber: e.target.value }))}
            />
          </FormField>
          <FormField label="Remarks" className="sm:col-span-2">
            <TextInput
              value={mv.remarks}
              onChange={(e) => setMv((m) => ({ ...m, remarks: e.target.value }))}
            />
          </FormField>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" className="rounded-xl border px-4 py-2 text-sm" onClick={() => setModal(null)}>
            Cancel
          </button>
          <button
            type="button"
            className="rounded-xl bg-gray-900 px-4 py-2 text-sm font-semibold text-white"
            disabled={movementMutation.isPending}
            onClick={() =>
              movementMutation.mutate({
                path: "/inventory/stock-out",
                body: {
                  itemCode: mv.itemCode,
                  warehouse: mv.warehouse,
                  qty: mv.qty,
                  referenceType: mv.referenceType || "MANUAL",
                  referenceNumber: mv.referenceNumber,
                  remarks: mv.remarks,
                },
              })
            }
          >
            Post
          </button>
        </div>
      </Modal>

      <Modal open={modal === "adj"} onClose={() => setModal(null)} title="Stock adjustment" wide>
        <p className="mb-2 text-xs text-gray-500">
          Use positive qtyDelta to increase stock, negative to decrease.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label="Item code *">
            <TextInput value={mv.itemCode} onChange={(e) => setMv((m) => ({ ...m, itemCode: e.target.value }))} />
          </FormField>
          <FormField label="Warehouse">
            <TextInput
              value={mv.warehouse}
              onChange={(e) => setMv((m) => ({ ...m, warehouse: e.target.value }))}
            />
          </FormField>
          <FormField label="Qty delta *">
            <TextInput
              type="number"
              value={mv.qtyDelta}
              onChange={(e) => setMv((m) => ({ ...m, qtyDelta: Number(e.target.value) }))}
            />
          </FormField>
          <FormField label="Remarks" className="sm:col-span-2">
            <TextInput
              value={mv.remarks}
              onChange={(e) => setMv((m) => ({ ...m, remarks: e.target.value }))}
            />
          </FormField>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" className="rounded-xl border px-4 py-2 text-sm" onClick={() => setModal(null)}>
            Cancel
          </button>
          <button
            type="button"
            className="rounded-xl bg-gray-900 px-4 py-2 text-sm font-semibold text-white"
            disabled={movementMutation.isPending}
            onClick={() =>
              movementMutation.mutate({
                path: "/inventory/adjust",
                body: {
                  itemCode: mv.itemCode,
                  warehouse: mv.warehouse,
                  qtyDelta: mv.qtyDelta,
                  remarks: mv.remarks,
                },
              })
            }
          >
            Post
          </button>
        </div>
      </Modal>

      <Modal open={modal === "open"} onClose={() => setModal(null)} title="Opening balance" wide>
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label="Item code *">
            <TextInput value={mv.itemCode} onChange={(e) => setMv((m) => ({ ...m, itemCode: e.target.value }))} />
          </FormField>
          <FormField label="Warehouse">
            <TextInput
              value={mv.warehouse}
              onChange={(e) => setMv((m) => ({ ...m, warehouse: e.target.value }))}
            />
          </FormField>
          <FormField label="Quantity *">
            <TextInput
              type="number"
              value={mv.quantity}
              onChange={(e) => setMv((m) => ({ ...m, quantity: Number(e.target.value) }))}
            />
          </FormField>
          <FormField label="Unit cost">
            <TextInput
              type="number"
              step="0.01"
              value={mv.unitCost}
              onChange={(e) => setMv((m) => ({ ...m, unitCost: Number(e.target.value) }))}
            />
          </FormField>
          <FormField label="Remarks" className="sm:col-span-2">
            <TextInput
              value={mv.remarks}
              onChange={(e) => setMv((m) => ({ ...m, remarks: e.target.value }))}
            />
          </FormField>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" className="rounded-xl border px-4 py-2 text-sm" onClick={() => setModal(null)}>
            Cancel
          </button>
          <button
            type="button"
            className="rounded-xl bg-gray-900 px-4 py-2 text-sm font-semibold text-white"
            disabled={movementMutation.isPending}
            onClick={() =>
              movementMutation.mutate({
                path: "/inventory/opening",
                body: {
                  itemCode: mv.itemCode,
                  warehouse: mv.warehouse,
                  quantity: mv.quantity,
                  unitCost: mv.unitCost,
                  remarks: mv.remarks,
                },
              })
            }
          >
            Post
          </button>
        </div>
      </Modal>
    </div>
  );
}
