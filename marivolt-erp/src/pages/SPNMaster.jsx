import { useEffect, useState } from "react";
import {
  fetchSpnList,
  createSpn,
  updateSpn,
  deleteSpn,
  importSpn,
} from "../lib/materialApi.js";

const STATUSES = ["Active", "Inactive"];

export default function SPNMaster() {
  const [items, setItems] = useState([]);
  const [pagination, setPagination] = useState({ page: 1, limit: 20, total: 0 });
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState({
    spn: "",
    partName: "",
    genericDescription: "",
    category: "",
    subCategory: "",
    uom: "",
    status: "Active",
    remarks: "",
  });

  async function load(page = 1) {
    setErr("");
    setLoading(true);
    try {
      const data = await fetchSpnList({
        page,
        search,
        status: statusFilter,
      });
      setItems(data.items || []);
      setPagination(data.pagination || { page, limit: 20, total: 0 });
    } catch (e) {
      setErr(e.message || "Failed to load SPN master");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function onChange(e) {
    const { name, value } = e.target;
    setForm((p) => ({ ...p, [name]: value }));
  }

  function startCreate() {
    setEditing(null);
    setForm({
      spn: "",
      partName: "",
      genericDescription: "",
      category: "",
      subCategory: "",
      uom: "",
      status: "Active",
      remarks: "",
    });
  }

  function startEdit(item) {
    setEditing(item);
    setForm({
      spn: item.spn || "",
      partName: item.partName || "",
      genericDescription: item.genericDescription || "",
      category: item.category || "",
      subCategory: item.subCategory || "",
      uom: item.uom || "",
      status: item.status || "Active",
      remarks: item.remarks || "",
    });
  }

  async function onSubmit(e) {
    e.preventDefault();
    setErr("");
    try {
      if (editing) {
        await updateSpn(editing._id, form);
      } else {
        await createSpn(form);
      }
      await load(pagination.page);
      if (!editing) {
        startCreate();
      }
    } catch (e2) {
      setErr(e2.message || "Failed to save");
    }
  }

  async function onDelete(id) {
    if (!window.confirm("Delete this SPN?")) return;
    setErr("");
    try {
      await deleteSpn(id);
      await load(pagination.page);
    } catch (e) {
      setErr(e.message || "Failed to delete");
    }
  }

  async function handleImport(file) {
    if (!file) return;
    setErr("");
    try {
      const text = await file.text();
      const lines = text.split(/\r?\n/).filter((l) => l.trim());
      if (lines.length <= 1) {
        setErr("File must have a header and at least one data row.");
        return;
      }
      const headers = lines[0].split(",").map((h) => h.trim());
      const rows = lines.slice(1).map((line) => {
        const cells = line.split(",");
        const row = {};
        headers.forEach((h, i) => {
          row[h] = cells[i] != null ? cells[i].trim() : "";
        });
        return row;
      });
      const result = await importSpn(rows);
      setErr(
        `Imported: ${result.successRows}, Failed: ${result.failedRows}, Duplicates: ${result.duplicateRows}`
      );
      await load(1);
    } catch (e) {
      setErr(e.message || "Failed to import");
    }
  }

  function downloadTemplate() {
    const headers = [
      "spn",
      "partName",
      "genericDescription",
      "category",
      "subCategory",
      "uom",
      "status",
      "remarks",
    ];
    const example = [
      "SPN-1001",
      "Exhaust Valve",
      "Exhaust valve for Wärtsilä W32",
      "Valve",
      "Exhaust",
      "pcs",
      "Active",
      "",
    ];
    const csv =
      [headers.join(","), example.map((c) => `"${c}"`).join(",")].join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = "spn-master-template.csv";
    link.click();
    URL.revokeObjectURL(link.href);
  }

  const totalPages = Math.max(
    1,
    Math.ceil((pagination.total || 0) / (pagination.limit || 20))
  );

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border bg-white p-6">
        <h1 className="text-xl font-semibold">SPN Master</h1>
        <p className="mt-1 text-gray-600">
          Define SPN and generic descriptions for marine engine spares.
        </p>
        {err && (
          <div className="mt-3 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">
            {err}
          </div>
        )}
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="rounded-2xl border bg-white p-6">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold">
              {editing ? "Edit SPN" : "Add SPN"}
            </h2>
            {editing && (
              <button
                type="button"
                onClick={startCreate}
                className="text-sm text-gray-600 hover:underline"
              >
                Cancel
              </button>
            )}
          </div>

          <form onSubmit={onSubmit} className="mt-4 space-y-3">
            <div>
              <label className="text-sm text-gray-600">SPN *</label>
              <input
                name="spn"
                value={form.spn}
                onChange={onChange}
                className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
                placeholder="e.g. SPN-1001"
              />
            </div>
            <div>
              <label className="text-sm text-gray-600">Part name *</label>
              <input
                name="partName"
                value={form.partName}
                onChange={onChange}
                className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="text-sm text-gray-600">
                Generic description
              </label>
              <input
                name="genericDescription"
                value={form.genericDescription}
                onChange={onChange}
                className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-sm text-gray-600">Category</label>
                <input
                  name="category"
                  value={form.category}
                  onChange={onChange}
                  className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="text-sm text-gray-600">Sub-category</label>
                <input
                  name="subCategory"
                  value={form.subCategory}
                  onChange={onChange}
                  className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-sm text-gray-600">UOM</label>
                <input
                  name="uom"
                  value={form.uom}
                  onChange={onChange}
                  className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
                  placeholder="pcs, set, etc."
                />
              </div>
              <div>
                <label className="text-sm text-gray-600">Status</label>
                <select
                  name="status"
                  value={form.status}
                  onChange={onChange}
                  className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
                >
                  {STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div>
              <label className="text-sm text-gray-600">Remarks</label>
              <input
                name="remarks"
                value={form.remarks}
                onChange={onChange}
                className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
              />
            </div>

            <button
              type="submit"
              className="w-full rounded-xl bg-gray-900 px-4 py-2 text-sm font-semibold text-white"
            >
              {editing ? "Update SPN" : "Add SPN"}
            </button>
          </form>
        </div>

        <div className="rounded-2xl border bg-white p-6 lg:col-span-2">
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <h2 className="text-base font-semibold">SPNs</h2>
            <div className="flex flex-wrap gap-2">
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-full rounded-xl border px-3 py-2 text-sm md:w-64"
                placeholder="Search SPN / name..."
              />
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
                className="rounded-xl border px-3 py-2 text-sm"
              >
                <option value="">All statuses</option>
                {STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
              <button
                onClick={() => load(1)}
                className="rounded-xl border px-3 py-2 text-sm hover:bg-gray-50"
              >
                Apply
              </button>
              <button
                type="button"
                onClick={downloadTemplate}
                className="rounded-xl border px-3 py-2 text-sm hover:bg-gray-50"
              >
                Download CSV template
              </button>
              <label className="inline-flex cursor-pointer items-center rounded-xl border px-3 py-2 text-sm hover:bg-gray-50">
                <span>Import CSV</span>
                <input
                  type="file"
                  accept=".csv"
                  onChange={(e) => handleImport(e.target.files?.[0])}
                  className="hidden"
                />
              </label>
            </div>
          </div>

          <div className="mt-4">
            {loading ? (
              <div className="text-sm text-gray-600">Loading...</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="border-b text-gray-600">
                    <tr>
                      <th className="py-2 pr-3">SPN</th>
                      <th className="py-2 pr-3">Part name</th>
                      <th className="py-2 pr-3">Generic description</th>
                      <th className="py-2 pr-3">Category</th>
                      <th className="py-2 pr-3">Sub-category</th>
                      <th className="py-2 pr-3">UOM</th>
                      <th className="py-2 pr-3">Status</th>
                      <th className="py-2 pr-3"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.length === 0 ? (
                      <tr>
                        <td
                          className="py-6 text-center text-gray-500"
                          colSpan={8}
                        >
                          No SPNs yet.
                        </td>
                      </tr>
                    ) : (
                      items.map((it) => (
                        <tr key={it._id} className="border-b last:border-b-0">
                          <td className="py-2 pr-3 font-medium">{it.spn}</td>
                          <td className="py-2 pr-3">{it.partName}</td>
                          <td className="py-2 pr-3">
                            {it.genericDescription || "-"}
                          </td>
                          <td className="py-2 pr-3">{it.category || "-"}</td>
                          <td className="py-2 pr-3">
                            {it.subCategory || "-"}
                          </td>
                          <td className="py-2 pr-3">{it.uom || "-"}</td>
                          <td className="py-2 pr-3">{it.status}</td>
                          <td className="py-2 pr-3 text-right">
                            <div className="flex justify-end gap-2">
                              <button
                                type="button"
                                onClick={() => startEdit(it)}
                                className="rounded-lg border px-2 py-1 text-xs hover:bg-gray-50"
                              >
                                Edit
                              </button>
                              <button
                                type="button"
                                onClick={() => onDelete(it._id)}
                                className="rounded-lg border px-2 py-1 text-xs text-red-600 hover:bg-red-50"
                              >
                                Delete
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            )}

            <div className="mt-3 flex items-center justify-between text-xs text-gray-600">
              <div>
                Page {pagination.page} of {totalPages} • {pagination.total}{" "}
                record(s)
              </div>
              <div className="flex gap-1">
                <button
                  type="button"
                  disabled={pagination.page <= 1}
                  onClick={() => load(pagination.page - 1)}
                  className="rounded border px-2 py-1 disabled:opacity-50"
                >
                  Prev
                </button>
                <button
                  type="button"
                  disabled={pagination.page >= totalPages}
                  onClick={() => load(pagination.page + 1)}
                  className="rounded border px-2 py-1 disabled:opacity-50"
                >
                  Next
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

