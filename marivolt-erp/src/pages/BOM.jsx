import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import PageHeader from "../components/erp/PageHeader.jsx";
import Modal from "../components/erp/Modal.jsx";
import { FormField, SelectInput, TextInput } from "../components/erp/FormField.jsx";
import { apiDelete, apiGetWithQuery, apiPost, apiPut } from "../lib/api.js";
import { notify, confirmDialog } from "../lib/notifications.js";

const emptyLine = () => ({
  article: "",
  qty: 1,
  optionalFlag: false,
  interchangeableGroup: "",
  alternativeArticles: "",
  remarks: "",
});

export default function BOM() {
  const qc = useQueryClient();
  const [page, setPage] = useState(1);
  const limit = 25;
  const [search, setSearch] = useState("");
  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState({
    bomCode: "",
    bomName: "",
    parentItemCode: "",
    kitType: "CUSTOM_KIT",
    engineModel: "",
    configuration: "",
    revisionNo: "R1",
    workflowMode: "BOTH",
    remarks: "",
    isActive: true,
    lines: [emptyLine()],
  });
  const [err, setErr] = useState("");

  const { data, isLoading, error } = useQuery({
    queryKey: ["boms", page, search],
    queryFn: () =>
      apiGetWithQuery("/boms", { page, limit, search: search.trim() || undefined }),
  });

  const saveMutation = useMutation({
    mutationFn: () =>
      editingId ? apiPut(`/boms/${editingId}`, form) : apiPost("/boms", form),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["boms"] });
      setModalOpen(false);
      setEditingId(null);
      setForm({
        bomCode: "",
        bomName: "",
        parentItemCode: "",
        kitType: "CUSTOM_KIT",
        engineModel: "",
        configuration: "",
        revisionNo: "R1",
        workflowMode: "BOTH",
        remarks: "",
        isActive: true,
        lines: [emptyLine()],
      });
    },
    onError: (e) => setErr(e.message),
  });

  const deleteMutation = useMutation({
    mutationFn: (id) => apiDelete(`/boms/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["boms"] }),
  });

  function openCreate() {
    setEditingId(null);
    setForm({
      bomCode: "",
      bomName: "",
      parentItemCode: "",
      kitType: "CUSTOM_KIT",
      engineModel: "",
      configuration: "",
      revisionNo: "R1",
      workflowMode: "BOTH",
      remarks: "",
      isActive: true,
      lines: [emptyLine()],
    });
    setErr("");
    setModalOpen(true);
  }

  function openEdit(row) {
    setEditingId(row._id);
    setForm({
      bomCode: row.bomCode || "",
      bomName: row.bomName || row.name || "",
      parentItemCode: row.parentItemCode || "",
      kitType: row.kitType || "CUSTOM_KIT",
      engineModel: row.engineModel || "",
      configuration: row.configuration || "",
      revisionNo: row.revisionNo || "R1",
      workflowMode: row.workflowMode || "BOTH",
      remarks: row.remarks || row.description || "",
      isActive: row.isActive !== false,
      lines:
        row.lines?.length > 0
          ? row.lines.map((l) => ({
              article: l.article || l.componentItemCode || "",
              qty: l.qty ?? 1,
              optionalFlag: Boolean(l.optionalFlag),
              interchangeableGroup: l.interchangeableGroup || "",
              alternativeArticles: Array.isArray(l.alternativeArticles) ? l.alternativeArticles.join(", ") : "",
              remarks: l.remarks || l.description || "",
            }))
          : [emptyLine()],
    });
    setErr("");
    setModalOpen(true);
  }

  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / limit));

  return (
    <div>
      <PageHeader
        title="BOM"
        subtitle="Marine kit BOM with revision, compatibility context, optional/alternative components."
      >
        <button
          type="button"
          onClick={openCreate}
          className="rounded-xl bg-gray-900 px-3 py-2 text-sm font-semibold text-white"
        >
          New BOM
        </button>
      </PageHeader>

      {(error || err) && (
        <div className="mb-4 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {error?.message || err}
        </div>
      )}

      <div className="mb-4 flex flex-wrap items-end gap-3 rounded-2xl border bg-white p-4">
        <div className="min-w-[200px] flex-1">
          <label className="text-xs font-medium text-gray-600">Search</label>
          <TextInput
            className="mt-1"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Parent code or name…"
          />
        </div>
        <button
          type="button"
          className="rounded-xl bg-gray-100 px-3 py-2 text-sm"
          onClick={async () => {
            setPage(1);
            qc.invalidateQueries({ queryKey: ["boms"] });
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
                <th className="px-3 py-2">Parent</th>
                <th className="px-3 py-2">BOM</th>
                <th className="px-3 py-2">Kit Type</th>
                <th className="px-3 py-2 text-center">Lines</th>
                <th className="px-3 py-2">Active</th>
                <th className="px-3 py-2 w-28" />
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr>
                  <td colSpan={6} className="px-3 py-8 text-center text-gray-500">
                    Loading…
                  </td>
                </tr>
              ) : items.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-3 py-8 text-center text-gray-500">
                    No BOMs yet.
                  </td>
                </tr>
              ) : (
                items.map((row) => (
                  <tr key={row._id} className="border-b border-gray-100 hover:bg-gray-50/80">
                    <td className="px-3 py-2 font-mono text-xs">{row.parentItemCode}</td>
                    <td className="px-3 py-2">{row.bomCode || row.bomName || row.name || "—"}</td>
                    <td className="px-3 py-2">{row.kitType || "—"}</td>
                    <td className="px-3 py-2 text-center">{row.lines?.length ?? 0}</td>
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
                          onClick={async () => {
                            if (await confirmDialog(`Delete BOM for ${row.parentItemCode}?`)) {
                              deleteMutation.mutate(row._id);
                            }
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
            Page {page}/{totalPages} · {total} BOMs
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

      <Modal
        open={modalOpen}
        onClose={() => {
          setModalOpen(false);
          setEditingId(null);
        }}
        title={editingId ? "Edit BOM" : "New BOM"}
        wide
      >
        {saveMutation.isError && (
          <div className="mb-2 text-sm text-red-600">{saveMutation.error.message}</div>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label="BOM Code">
            <TextInput
              value={form.bomCode}
              onChange={(e) => setForm((f) => ({ ...f, bomCode: e.target.value }))}
            />
          </FormField>
          <FormField label="BOM Name">
            <TextInput
              value={form.bomName}
              onChange={(e) => setForm((f) => ({ ...f, bomName: e.target.value }))}
            />
          </FormField>
          <FormField label="Parent item code (kit SKU) *">
            <TextInput
              value={form.parentItemCode}
              onChange={(e) => setForm((f) => ({ ...f, parentItemCode: e.target.value }))}
              disabled={!!editingId}
            />
          </FormField>
          <FormField label="Kit Type">
            <SelectInput value={form.kitType} onChange={(e) => setForm((f) => ({ ...f, kitType: e.target.value }))}>
              {["ENGINE_OVERHAUL_KIT", "SERVICE_KIT", "CYLINDER_HEAD_KIT", "FUEL_PUMP_KIT", "CUSTOM_KIT"].map((x) => (
                <option key={x} value={x}>{x}</option>
              ))}
            </SelectInput>
          </FormField>
          <FormField label="Engine Model">
            <TextInput value={form.engineModel} onChange={(e) => setForm((f) => ({ ...f, engineModel: e.target.value }))} />
          </FormField>
          <FormField label="Configuration">
            <TextInput value={form.configuration} onChange={(e) => setForm((f) => ({ ...f, configuration: e.target.value }))} />
          </FormField>
          <FormField label="Revision No">
            <TextInput value={form.revisionNo} onChange={(e) => setForm((f) => ({ ...f, revisionNo: e.target.value }))} />
          </FormField>
          <FormField label="Workflow">
            <SelectInput value={form.workflowMode} onChange={(e) => setForm((f) => ({ ...f, workflowMode: e.target.value }))}>
              {["ASSEMBLY", "DISASSEMBLY", "BOTH"].map((x) => <option key={x} value={x}>{x}</option>)}
            </SelectInput>
          </FormField>
          <FormField label="Remarks" className="sm:col-span-2">
            <TextInput value={form.remarks} onChange={(e) => setForm((f) => ({ ...f, remarks: e.target.value }))} />
          </FormField>
          <label className="flex items-center gap-2 text-sm sm:col-span-2">
            <input
              type="checkbox"
              checked={form.isActive}
              onChange={(e) => setForm((f) => ({ ...f, isActive: e.target.checked }))}
            />
            Active (required for kitting / de-kitting)
          </label>
        </div>
        <div className="mt-4">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-sm font-medium">Components (qty per 1 parent kit)</span>
            <button
              type="button"
              className="text-sm underline"
              onClick={() => setForm((f) => ({ ...f, lines: [...f.lines, emptyLine()] }))}
            >
              + Line
            </button>
          </div>
          <div className="max-h-56 space-y-2 overflow-y-auto">
            {form.lines.map((line, idx) => (
              <div
                key={idx}
                className="grid grid-cols-2 gap-2 rounded-xl border p-2 sm:grid-cols-6"
              >
                <TextInput
                  placeholder="Article"
                  value={line.article}
                  onChange={(e) => {
                    const lines = [...form.lines];
                    lines[idx] = { ...lines[idx], article: e.target.value };
                    setForm((f) => ({ ...f, lines }));
                  }}
                />
                <TextInput
                  type="number"
                  step="0.0001"
                  placeholder="Qty / kit"
                  value={line.qty}
                  onChange={(e) => {
                    const lines = [...form.lines];
                    lines[idx] = { ...lines[idx], qty: Number(e.target.value) };
                    setForm((f) => ({ ...f, lines }));
                  }}
                />
                <TextInput
                  placeholder="Interchange group"
                  value={line.interchangeableGroup}
                  onChange={(e) => {
                    const lines = [...form.lines];
                    lines[idx] = { ...lines[idx], interchangeableGroup: e.target.value };
                    setForm((f) => ({ ...f, lines }));
                  }}
                />
                <TextInput
                  placeholder="Alternatives (comma)"
                  value={line.alternativeArticles}
                  onChange={(e) => {
                    const lines = [...form.lines];
                    lines[idx] = { ...lines[idx], alternativeArticles: e.target.value };
                    setForm((f) => ({ ...f, lines }));
                  }}
                />
                <TextInput
                  placeholder="Remarks"
                  value={line.remarks}
                  onChange={(e) => {
                    const lines = [...form.lines];
                    lines[idx] = { ...lines[idx], remarks: e.target.value };
                    setForm((f) => ({ ...f, lines }));
                  }}
                />
                <label className="inline-flex items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={line.optionalFlag}
                    onChange={(e) => {
                      const lines = [...form.lines];
                      lines[idx] = { ...lines[idx], optionalFlag: e.target.checked };
                      setForm((f) => ({ ...f, lines }));
                    }}
                  />
                  Optional
                </label>
                <button
                  type="button"
                  className="rounded border px-2 py-1 text-xs text-rose-700"
                  onClick={async () => {
                    const lines = form.lines.filter((_, i) => i !== idx);
                    setForm((f) => ({ ...f, lines: lines.length ? lines : [emptyLine()] }));
                  }}
                >
                  Remove
                </button>
                <div className="sm:col-span-6 text-[11px] text-slate-500">
                  Qty x order quantity is consumed; alternative articles are checked as substitute availability.
                </div>
              </div>
            ))}
          </div>
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
            onClick={async () => {
              setErr("");
              saveMutation.mutate();
            }}
          >
            {saveMutation.isPending ? "Saving…" : "Save"}
          </button>
        </div>
      </Modal>
    </div>
  );
}
