import { useEffect, useState } from "react";
import {
  fetchArticleList,
  createArticle,
  updateArticle,
  deleteArticle,
  importArticles,
  fetchMaterialList,
} from "../lib/materialApi.js";
import { STATUSES } from "../lib/masterValuesClient.js";

export default function ArticleMaster() {
  const [items, setItems] = useState([]);
  const [pagination, setPagination] = useState({ page: 1, limit: 20, total: 0 });
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [materialFilter, setMaterialFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [editing, setEditing] = useState(null);
  const [materialOptions, setMaterialOptions] = useState([]);

  const [form, setForm] = useState({
    articleNo: "",
    materialCode: "",
    description: "",
    drawingNo: "",
    maker: "",
    brand: "",
    unit: "",
    weight: "",
    hsnCode: "",
    status: "Active",
    remarks: "",
  });

  async function load(page = 1) {
    setErr("");
    setLoading(true);
    try {
      const data = await fetchArticleList({
        page,
        search,
        materialCode: materialFilter,
        status: statusFilter,
      });
      setItems(data.items || []);
      setPagination(data.pagination || { page, limit: 20, total: 0 });
    } catch (e) {
      setErr(e.message || "Failed to load Article Master");
    } finally {
      setLoading(false);
    }
  }

  async function loadMaterials() {
    try {
      const data = await fetchMaterialList({
        page: 1,
        limit: 500,
        status: "Active",
      });
      setMaterialOptions(data.items || []);
    } catch {
      // ignore
    }
  }

  useEffect(() => {
    load(1);
    loadMaterials();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function onChange(e) {
    const { name, value } = e.target;
    setForm((p) => ({ ...p, [name]: value }));
  }

  function startCreate() {
    setEditing(null);
    setForm({
      articleNo: "",
      materialCode: "",
      description: "",
      drawingNo: "",
      maker: "",
      brand: "",
      unit: "",
      weight: "",
      hsnCode: "",
      status: "Active",
      remarks: "",
    });
  }

  function startEdit(it) {
    setEditing(it);
    setForm({
      articleNo: it.articleNo || "",
      materialCode: it.materialCode || "",
      description: it.description || "",
      drawingNo: it.drawingNo || "",
      maker: it.maker || "",
      brand: it.brand || "",
      unit: it.unit || "",
      weight: it.weight ?? "",
      hsnCode: it.hsnCode || "",
      status: it.status || "Active",
      remarks: it.remarks || "",
    });
  }

  async function onSubmit(e) {
    e.preventDefault();
    setErr("");
    try {
      if (editing) {
        await updateArticle(editing._id, form);
      } else {
        await createArticle(form);
      }
      await load(pagination.page);
      if (!editing) startCreate();
    } catch (e2) {
      setErr(e2.message || "Failed to save article");
    }
  }

  async function onDelete(id) {
    if (!window.confirm("Delete this article?")) return;
    setErr("");
    try {
      await deleteArticle(id);
      await load(pagination.page);
      if (editing && editing._id === id) startCreate();
    } catch (e) {
      setErr(e.message || "Failed to delete article");
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
      const result = await importArticles(rows);
      setErr(
        `Imported: ${result.successRows}, Failed: ${result.failedRows}, Duplicates: ${result.duplicateRows}`
      );
      await load(1);
    } catch (e) {
      setErr(e.message || "Failed to import articles");
    }
  }

  function downloadTemplate() {
    const headers = [
      "articleNo",
      "materialCode",
      "description",
      "drawingNo",
      "maker",
      "brand",
      "unit",
      "weight",
      "hsnCode",
      "status",
      "remarks",
    ];
    const example = [
      "ART-1001",
      "MAT-1001",
      "Exhaust valve assembly, W32",
      "DWG-EXH-1001",
      "Wärtsilä",
      "OEM",
      "pcs",
      "2.5",
      "84099190",
      "Active",
      "",
    ];
    const csv =
      [headers.join(","), example.map((c) => `"${c}"`).join(",")].join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = "article-master-template.csv";
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
        <h1 className="text-xl font-semibold">Article Master</h1>
        <p className="mt-1 text-gray-600">
          Define article numbers, descriptions and drawing numbers for each
          material code.
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
              {editing ? "Edit Article" : "Add Article"}
            </h2>
            {editing && (
              <button
                type="button"
                onClick={startCreate}
                className="text-sm text-gray-600 hover:underline"
              >
                New
              </button>
            )}
          </div>

          <form onSubmit={onSubmit} className="mt-4 space-y-3">
            <div>
              <label className="text-sm text-gray-600">Article No *</label>
              <input
                name="articleNo"
                value={form.articleNo}
                onChange={onChange}
                className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
                placeholder="e.g. ART-1001"
              />
            </div>
            <div>
              <label className="text-sm text-gray-600">Material code *</label>
              <select
                name="materialCode"
                value={form.materialCode}
                onChange={onChange}
                className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
              >
                <option value="">Select material...</option>
                {materialOptions.map((m) => (
                  <option key={m._id} value={m.materialCode}>
                    {m.materialCode} — {m.shortDescription}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-sm text-gray-600">Description *</label>
              <input
                name="description"
                value={form.description}
                onChange={onChange}
                className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-sm text-gray-600">Drawing No</label>
                <input
                  name="drawingNo"
                  value={form.drawingNo}
                  onChange={onChange}
                  className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="text-sm text-gray-600">Maker</label>
                <input
                  name="maker"
                  value={form.maker}
                  onChange={onChange}
                  className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-sm text-gray-600">Brand</label>
                <input
                  name="brand"
                  value={form.brand}
                  onChange={onChange}
                  className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="text-sm text-gray-600">Unit</label>
                <input
                  name="unit"
                  value={form.unit}
                  onChange={onChange}
                  className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
                  placeholder="pcs, set, kg..."
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-sm text-gray-600">Weight</label>
                <input
                  name="weight"
                  value={form.weight}
                  onChange={onChange}
                  className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="text-sm text-gray-600">HSN Code</label>
                <input
                  name="hsnCode"
                  value={form.hsnCode}
                  onChange={onChange}
                  className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
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
              <div>
                <label className="text-sm text-gray-600">Remarks</label>
                <input
                  name="remarks"
                  value={form.remarks}
                  onChange={onChange}
                  className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
                />
              </div>
            </div>
            <button
              type="submit"
              className="w-full rounded-xl bg-gray-900 px-4 py-2 text-sm font-semibold text-white"
            >
              {editing ? "Update Article" : "Add Article"}
            </button>
          </form>
        </div>

        <div className="rounded-2xl border bg-white p-6 lg:col-span-2">
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <h2 className="text-base font-semibold">Articles</h2>
            <div className="flex flex-wrap gap-2">
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-full rounded-xl border px-3 py-2 text-sm md:w-64"
                placeholder="Search article / description..."
              />
              <select
                value={materialFilter}
                onChange={(e) => setMaterialFilter(e.target.value)}
                className="rounded-xl border px-3 py-2 text-sm"
              >
                <option value="">All materials</option>
                {materialOptions.map((m) => (
                  <option key={m._id} value={m.materialCode}>
                    {m.materialCode}
                  </option>
                ))}
              </select>
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
                      <th className="py-2 pr-3">Article No</th>
                      <th className="py-2 pr-3">Material code</th>
                      <th className="py-2 pr-3">Description</th>
                      <th className="py-2 pr-3">Drawing No</th>
                      <th className="py-2 pr-3">Maker</th>
                      <th className="py-2 pr-3">Brand</th>
                      <th className="py-2 pr-3">Unit</th>
                      <th className="py-2 pr-3">Weight</th>
                      <th className="py-2 pr-3">Status</th>
                      <th className="py-2 pr-3"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.length === 0 ? (
                      <tr>
                        <td
                          className="py-6 text-center text-gray-500"
                          colSpan={10}
                        >
                          No articles.
                        </td>
                      </tr>
                    ) : (
                      items.map((it) => (
                        <tr key={it._id} className="border-b last:border-b-0">
                          <td className="py-2 pr-3 font-medium">
                            {it.articleNo}
                          </td>
                          <td className="py-2 pr-3">{it.materialCode}</td>
                          <td className="py-2 pr-3">{it.description}</td>
                          <td className="py-2 pr-3">{it.drawingNo || "-"}</td>
                          <td className="py-2 pr-3">{it.maker || "-"}</td>
                          <td className="py-2 pr-3">{it.brand || "-"}</td>
                          <td className="py-2 pr-3">{it.unit || "-"}</td>
                          <td className="py-2 pr-3">{it.weight ?? ""}</td>
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

