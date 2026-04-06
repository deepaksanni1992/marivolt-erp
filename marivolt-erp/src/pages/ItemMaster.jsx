import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import PageHeader from "../components/erp/PageHeader.jsx";
import Modal from "../components/erp/Modal.jsx";
import { FormField, TextInput } from "../components/erp/FormField.jsx";
import { apiDelete, apiGetWithQuery, apiPost, apiPut } from "../lib/api.js";

const emptyItem = {
  itemCode: "",
  description: "",
  uom: "PCS",
  brand: "",
  makerPartNo: "",
  hsnCode: "",
  category: "",
  supplierName: "",
  supplierPartNo: "",
  supplierLeadTimeDays: 0,
  purchasePrice: 0,
  salePrice: 0,
  currency: "USD",
  weightKg: 0,
  reorderLevel: 0,
  remarks: "",
  isActive: true,
};

export default function ItemMaster() {
  const qc = useQueryClient();
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [modalOpen, setModalOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState("");
  const [form, setForm] = useState(emptyItem);
  const [editingId, setEditingId] = useState(null);
  const [formError, setFormError] = useState("");

  const limit = 25;
  const { data, isLoading, error } = useQuery({
    queryKey: ["items", page, search],
    queryFn: () =>
      apiGetWithQuery("/items", { page, limit, search: search.trim() || undefined }),
  });

  const saveMutation = useMutation({
    mutationFn: async () => {
      setFormError("");
      if (editingId) {
        return apiPut(`/items/${editingId}`, form);
      }
      return apiPost("/items", form);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["items"] });
      setModalOpen(false);
      setForm(emptyItem);
      setEditingId(null);
    },
    onError: (e) => setFormError(e.message),
  });

  const deleteMutation = useMutation({
    mutationFn: (id) => apiDelete(`/items/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["items"] }),
  });

  const importMutation = useMutation({
    mutationFn: async () => {
      let rows;
      try {
        rows = JSON.parse(importText);
      } catch {
        throw new Error("Paste valid JSON: an array of item objects");
      }
      if (!Array.isArray(rows)) throw new Error("JSON must be an array");
      return apiPost("/items/import", { items: rows });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["items"] });
      setImportOpen(false);
      setImportText("");
    },
  });

  function openCreate() {
    setEditingId(null);
    setForm(emptyItem);
    setFormError("");
    setModalOpen(true);
  }

  function openEdit(row) {
    setEditingId(row._id);
    setForm({
      ...emptyItem,
      ...row,
      supplierLeadTimeDays: row.supplierLeadTimeDays ?? 0,
      purchasePrice: row.purchasePrice ?? 0,
      salePrice: row.salePrice ?? 0,
      weightKg: row.weightKg ?? 0,
      reorderLevel: row.reorderLevel ?? 0,
    });
    setFormError("");
    setModalOpen(true);
  }

  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / limit));

  return (
    <div>
      <PageHeader
        title="Item Master"
        subtitle="Single spare-parts catalogue (codes, supplier fields, pricing)."
      >
        <button
          type="button"
          onClick={() => setImportOpen(true)}
          className="rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm font-medium hover:bg-gray-50"
        >
          Import JSON
        </button>
        <button
          type="button"
          onClick={openCreate}
          className="rounded-xl bg-gray-900 px-3 py-2 text-sm font-semibold text-white hover:bg-gray-800"
        >
          New item
        </button>
      </PageHeader>

      {error ? (
        <div className="mb-4 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {error.message}
        </div>
      ) : null}

      <div className="mb-4 flex flex-wrap items-end gap-3 rounded-2xl border bg-white p-4">
        <div className="min-w-[200px] flex-1">
          <label className="text-xs font-medium text-gray-600">Search</label>
          <TextInput
            className="mt-1"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Code, description, part no…"
          />
        </div>
        <button
          type="button"
          className="rounded-xl bg-gray-100 px-3 py-2 text-sm"
          onClick={() => {
            setPage(1);
            qc.invalidateQueries({ queryKey: ["items"] });
          }}
        >
          Apply
        </button>
      </div>

      <div className="overflow-hidden rounded-2xl border bg-white">
        <div className="overflow-x-auto">
          <table className="min-w-full text-left text-sm">
            <thead className="border-b bg-gray-50 text-xs font-semibold text-gray-600">
              <tr>
                <th className="px-3 py-2">Code</th>
                <th className="px-3 py-2">Description</th>
                <th className="px-3 py-2">UOM</th>
                <th className="px-3 py-2">Supplier</th>
                <th className="px-3 py-2 text-right">Sale</th>
                <th className="px-3 py-2">Active</th>
                <th className="px-3 py-2 w-28" />
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr>
                  <td colSpan={7} className="px-3 py-8 text-center text-gray-500">
                    Loading…
                  </td>
                </tr>
              ) : items.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-3 py-8 text-center text-gray-500">
                    No items yet.
                  </td>
                </tr>
              ) : (
                items.map((row) => (
                  <tr key={row._id} className="border-b border-gray-100 hover:bg-gray-50/80">
                    <td className="px-3 py-2 font-mono text-xs">{row.itemCode}</td>
                    <td className="px-3 py-2 max-w-[220px] truncate">{row.description}</td>
                    <td className="px-3 py-2">{row.uom}</td>
                    <td className="px-3 py-2 max-w-[160px] truncate">{row.supplierName}</td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {row.currency} {Number(row.salePrice).toFixed(2)}
                    </td>
                    <td className="px-3 py-2">{row.isActive ? "Yes" : "No"}</td>
                    <td className="px-3 py-2">
                      <div className="flex gap-1">
                        <button
                          type="button"
                          className="rounded-lg border px-2 py-1 text-xs"
                          onClick={() => openEdit(row)}
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          className="rounded-lg border border-red-200 px-2 py-1 text-xs text-red-700"
                          onClick={() => {
                            if (confirm(`Delete ${row.itemCode}?`)) deleteMutation.mutate(row._id);
                          }}
                        >
                          Del
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
          <span>
            Page {page} / {totalPages} · {total} items
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              className="rounded-lg border px-2 py-1 disabled:opacity-40"
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
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

      <Modal
        open={modalOpen}
        onClose={() => {
          setModalOpen(false);
          setEditingId(null);
        }}
        title={editingId ? "Edit item" : "New item"}
        wide
      >
        {formError ? (
          <div className="mb-3 rounded-lg border border-red-200 bg-red-50 p-2 text-sm text-red-700">
            {formError}
          </div>
        ) : null}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <FormField label="Item code *">
            <TextInput
              value={form.itemCode}
              onChange={(e) => setForm((f) => ({ ...f, itemCode: e.target.value }))}
              disabled={!!editingId}
            />
          </FormField>
          <FormField label="UOM">
            <TextInput
              value={form.uom}
              onChange={(e) => setForm((f) => ({ ...f, uom: e.target.value }))}
            />
          </FormField>
          <FormField label="Description" className="sm:col-span-2">
            <TextInput
              value={form.description}
              onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
            />
          </FormField>
          <FormField label="Brand">
            <TextInput
              value={form.brand}
              onChange={(e) => setForm((f) => ({ ...f, brand: e.target.value }))}
            />
          </FormField>
          <FormField label="Maker part no">
            <TextInput
              value={form.makerPartNo}
              onChange={(e) => setForm((f) => ({ ...f, makerPartNo: e.target.value }))}
            />
          </FormField>
          <FormField label="HSN">
            <TextInput
              value={form.hsnCode}
              onChange={(e) => setForm((f) => ({ ...f, hsnCode: e.target.value }))}
            />
          </FormField>
          <FormField label="Category">
            <TextInput
              value={form.category}
              onChange={(e) => setForm((f) => ({ ...f, category: e.target.value }))}
            />
          </FormField>
          <FormField label="Supplier name">
            <TextInput
              value={form.supplierName}
              onChange={(e) => setForm((f) => ({ ...f, supplierName: e.target.value }))}
            />
          </FormField>
          <FormField label="Supplier part no">
            <TextInput
              value={form.supplierPartNo}
              onChange={(e) => setForm((f) => ({ ...f, supplierPartNo: e.target.value }))}
            />
          </FormField>
          <FormField label="Lead time (days)">
            <TextInput
              type="number"
              value={form.supplierLeadTimeDays}
              onChange={(e) =>
                setForm((f) => ({ ...f, supplierLeadTimeDays: Number(e.target.value) }))
              }
            />
          </FormField>
          <FormField label="Currency">
            <TextInput
              value={form.currency}
              onChange={(e) => setForm((f) => ({ ...f, currency: e.target.value }))}
            />
          </FormField>
          <FormField label="Purchase price">
            <TextInput
              type="number"
              step="0.01"
              value={form.purchasePrice}
              onChange={(e) =>
                setForm((f) => ({ ...f, purchasePrice: Number(e.target.value) }))
              }
            />
          </FormField>
          <FormField label="Sale price">
            <TextInput
              type="number"
              step="0.01"
              value={form.salePrice}
              onChange={(e) => setForm((f) => ({ ...f, salePrice: Number(e.target.value) }))}
            />
          </FormField>
          <FormField label="Weight (kg)">
            <TextInput
              type="number"
              step="0.001"
              value={form.weightKg}
              onChange={(e) => setForm((f) => ({ ...f, weightKg: Number(e.target.value) }))}
            />
          </FormField>
          <FormField label="Reorder level">
            <TextInput
              type="number"
              value={form.reorderLevel}
              onChange={(e) =>
                setForm((f) => ({ ...f, reorderLevel: Number(e.target.value) }))
              }
            />
          </FormField>
          <FormField label="Remarks" className="sm:col-span-2">
            <TextInput
              value={form.remarks}
              onChange={(e) => setForm((f) => ({ ...f, remarks: e.target.value }))}
            />
          </FormField>
          <label className="flex items-center gap-2 text-sm sm:col-span-2">
            <input
              type="checkbox"
              checked={form.isActive}
              onChange={(e) => setForm((f) => ({ ...f, isActive: e.target.checked }))}
            />
            Active
          </label>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            className="rounded-xl border px-4 py-2 text-sm"
            onClick={() => setModalOpen(false)}
          >
            Cancel
          </button>
          <button
            type="button"
            className="rounded-xl bg-gray-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
            disabled={saveMutation.isPending}
            onClick={() => saveMutation.mutate()}
          >
            {saveMutation.isPending ? "Saving…" : "Save"}
          </button>
        </div>
      </Modal>

      <Modal
        open={importOpen}
        onClose={() => setImportOpen(false)}
        title="Import items (JSON)"
        wide
      >
        <p className="mb-2 text-sm text-gray-600">
          POST body shape: <code className="rounded bg-gray-100 px-1">{"{ items: [...] }"}</code>.
          Each object should include at least <code className="rounded bg-gray-100 px-1">itemCode</code>.
        </p>
        {importMutation.isError ? (
          <div className="mb-2 rounded-lg border border-red-200 bg-red-50 p-2 text-sm text-red-700">
            {importMutation.error.message}
          </div>
        ) : null}
        <textarea
          className="h-48 w-full rounded-xl border p-3 font-mono text-xs"
          value={importText}
          onChange={(e) => setImportText(e.target.value)}
          placeholder='[ { "itemCode": "ABC", "description": "..." } ]'
        />
        <div className="mt-3 flex justify-end gap-2">
          <button
            type="button"
            className="rounded-xl border px-4 py-2 text-sm"
            onClick={() => setImportOpen(false)}
          >
            Cancel
          </button>
          <button
            type="button"
            className="rounded-xl bg-gray-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
            disabled={importMutation.isPending}
            onClick={() => importMutation.mutate()}
          >
            {importMutation.isPending ? "Importing…" : "Import"}
          </button>
        </div>
      </Modal>
    </div>
  );
}
