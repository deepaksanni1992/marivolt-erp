import { useCallback, useEffect, useState } from "react";
import {
  createArticle,
  deleteArticle,
  fetchArticleList,
  fetchMaterialList,
  importArticles,
  updateArticle,
} from "../../lib/materialApi.js";
import { STATUSES } from "../../lib/masterValuesClient.js";
import {
  Modal,
  PaginationBar,
  Field,
  ErrorBanner,
} from "../../components/master/MasterUi.jsx";
import ImportPanel from "../../components/master/ImportPanel.jsx";

const LIMIT = 20;

export default function ArticleMaster() {
  const [materials, setMaterials] = useState([]);
  const [items, setItems] = useState([]);
  const [pagination, setPagination] = useState({ page: 1, limit: LIMIT, total: 0 });
  const [search, setSearch] = useState("");
  const [filterMaterial, setFilterMaterial] = useState("");
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");

  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [saveErr, setSaveErr] = useState("");
  const [form, setForm] = useState({
    articleNo: "",
    materialCode: "",
    description: "",
    drawingNo: "",
    maker: "",
    brand: "",
    unit: "",
    weight: 0,
    hsnCode: "",
    status: "Active",
    remarks: "",
  });

  useEffect(() => {
    fetchMaterialList({ limit: 500 })
      .then((r) => setMaterials(r.items || []))
      .catch(() => setMaterials([]));
  }, []);

  const load = useCallback(async () => {
    setErr("");
    setLoading(true);
    try {
      const r = await fetchArticleList({
        page: pagination.page,
        limit: pagination.limit,
        search,
        materialCode: filterMaterial || undefined,
      });
      setItems(r.items || []);
      setPagination((p) => ({ ...p, ...(r.pagination || {}), limit: LIMIT }));
    } catch (e) {
      setErr(e.message || "Failed to load articles");
    } finally {
      setLoading(false);
    }
  }, [pagination.page, pagination.limit, search, filterMaterial]);

  useEffect(() => {
    load();
  }, [load]);

  function openCreate() {
    setEditing(null);
    setSaveErr("");
    setForm({
      articleNo: "",
      materialCode: filterMaterial || "",
      description: "",
      drawingNo: "",
      maker: "",
      brand: "",
      unit: "",
      weight: 0,
      hsnCode: "",
      status: "Active",
      remarks: "",
    });
    setModalOpen(true);
  }

  function openEdit(row) {
    setEditing(row);
    setSaveErr("");
    setForm({
      articleNo: row.articleNo || "",
      materialCode: row.materialCode || "",
      description: row.description || "",
      drawingNo: row.drawingNo || "",
      maker: row.maker || "",
      brand: row.brand || "",
      unit: row.unit || "",
      weight: row.weight ?? 0,
      hsnCode: row.hsnCode || "",
      status: row.status || "Active",
      remarks: row.remarks || "",
    });
    setModalOpen(true);
  }

  async function save(e) {
    e.preventDefault();
    setSaveErr("");
    const payload = {
      ...form,
      weight: Number(form.weight) || 0,
    };
    try {
      if (editing) {
        await updateArticle(editing._id, payload);
      } else {
        await createArticle(payload);
      }
      setModalOpen(false);
      await load();
    } catch (e2) {
      setSaveErr(e2.message || "Save failed");
    }
  }

  async function remove(row) {
    if (!window.confirm(`Delete article “${row.articleNo}”?`)) return;
    setErr("");
    try {
      await deleteArticle(row._id);
      await load();
    } catch (e2) {
      setErr(e2.message || "Delete failed");
    }
  }

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border bg-white p-6">
        <h1 className="text-xl font-semibold">Article master</h1>
        <p className="mt-1 text-gray-600">
          Article numbers linked to a material code (internal catalogue).
        </p>
        <ErrorBanner message={err} />
      </div>

      <div className="rounded-2xl border bg-white p-6">
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
          <Field label="Search">
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full rounded-xl border px-3 py-2 text-sm"
              placeholder="Article no, description…"
            />
          </Field>
          <Field label="Material code">
            <input
              value={filterMaterial}
              onChange={(e) => setFilterMaterial(e.target.value)}
              className="w-full rounded-xl border px-3 py-2 text-sm font-mono"
            />
          </Field>
          <div className="flex items-end gap-2">
            <button
              type="button"
              onClick={() => setPagination((p) => ({ ...p, page: 1 }))}
              className="rounded-xl border px-3 py-2 text-sm hover:bg-gray-50"
            >
              Apply
            </button>
            <button
              type="button"
              onClick={openCreate}
              className="rounded-xl bg-gray-900 px-4 py-2 text-sm text-white"
            >
              Add article
            </button>
          </div>
        </div>

        <div className="mt-4 overflow-x-auto">
          {loading ? (
            <p className="text-sm text-gray-500">Loading…</p>
          ) : (
            <table className="w-full min-w-[800px] border-collapse text-sm">
              <thead>
                <tr className="border-b text-left text-gray-600">
                  <th className="py-2 pr-2">Article no</th>
                  <th className="py-2 pr-2">Material</th>
                  <th className="py-2 pr-2">Description</th>
                  <th className="py-2 pr-2">Maker</th>
                  <th className="py-2 pr-2">HSN</th>
                  <th className="py-2 pr-2">Status</th>
                  <th className="py-2">Actions</th>
                </tr>
              </thead>
              <tbody>
                {items.map((row) => (
                  <tr key={row._id} className="border-b border-gray-100">
                    <td className="py-2 pr-2 font-mono text-xs font-medium">
                      {row.articleNo}
                    </td>
                    <td className="py-2 pr-2 font-mono text-xs">{row.materialCode}</td>
                    <td className="py-2 pr-2 text-gray-700">{row.description}</td>
                    <td className="py-2 pr-2">{row.maker || "—"}</td>
                    <td className="py-2 pr-2">{row.hsnCode || "—"}</td>
                    <td className="py-2 pr-2">{row.status}</td>
                    <td className="py-2">
                      <button
                        type="button"
                        className="mr-2 text-teal-700 hover:underline"
                        onClick={() => openEdit(row)}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        className="text-red-700 hover:underline"
                        onClick={() => remove(row)}
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div className="mt-4">
          <PaginationBar
            page={pagination.page}
            limit={pagination.limit}
            total={pagination.total}
            onPageChange={(p) => setPagination((x) => ({ ...x, page: p }))}
          />
        </div>
      </div>

      <ImportPanel
        hint="Columns: articleNo, materialCode, description, drawingNo, maker, brand, unit, weight, hsnCode, status, remarks."
        onImport={(rows) => importArticles(rows)}
      />

      <Modal
        open={modalOpen}
        title={editing ? "Edit article" : "New article"}
        onClose={() => setModalOpen(false)}
        wide
      >
        <form onSubmit={save} className="grid gap-3 sm:grid-cols-2">
          <Field label="Article number *" className="sm:col-span-2">
            <input
              required
              value={form.articleNo}
              onChange={(e) => setForm((f) => ({ ...f, articleNo: e.target.value }))}
              className="w-full rounded-xl border px-3 py-2 text-sm font-mono"
            />
          </Field>
          <Field label="Material code *" className="sm:col-span-2">
            <select
              required
              value={form.materialCode}
              onChange={(e) =>
                setForm((f) => ({ ...f, materialCode: e.target.value }))
              }
              className="w-full rounded-xl border px-3 py-2 text-sm font-mono"
            >
              <option value="">Select…</option>
              {materials.map((m) => (
                <option key={m._id} value={m.materialCode}>
                  {m.materialCode} — {m.shortDescription}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Description *" className="sm:col-span-2">
            <input
              required
              value={form.description}
              onChange={(e) =>
                setForm((f) => ({ ...f, description: e.target.value }))
              }
              className="w-full rounded-xl border px-3 py-2 text-sm"
            />
          </Field>
          <Field label="Drawing no">
            <input
              value={form.drawingNo}
              onChange={(e) => setForm((f) => ({ ...f, drawingNo: e.target.value }))}
              className="w-full rounded-xl border px-3 py-2 text-sm"
            />
          </Field>
          <Field label="Maker">
            <input
              value={form.maker}
              onChange={(e) => setForm((f) => ({ ...f, maker: e.target.value }))}
              className="w-full rounded-xl border px-3 py-2 text-sm"
            />
          </Field>
          <Field label="Brand">
            <input
              value={form.brand}
              onChange={(e) => setForm((f) => ({ ...f, brand: e.target.value }))}
              className="w-full rounded-xl border px-3 py-2 text-sm"
            />
          </Field>
          <Field label="Unit">
            <input
              value={form.unit}
              onChange={(e) => setForm((f) => ({ ...f, unit: e.target.value }))}
              className="w-full rounded-xl border px-3 py-2 text-sm"
            />
          </Field>
          <Field label="Weight">
            <input
              type="number"
              step="any"
              value={form.weight}
              onChange={(e) => setForm((f) => ({ ...f, weight: e.target.value }))}
              className="w-full rounded-xl border px-3 py-2 text-sm"
            />
          </Field>
          <Field label="HSN code">
            <input
              value={form.hsnCode}
              onChange={(e) => setForm((f) => ({ ...f, hsnCode: e.target.value }))}
              className="w-full rounded-xl border px-3 py-2 text-sm"
            />
          </Field>
          <Field label="Status">
            <select
              value={form.status}
              onChange={(e) => setForm((f) => ({ ...f, status: e.target.value }))}
              className="w-full rounded-xl border px-3 py-2 text-sm"
            >
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Remarks" className="sm:col-span-2">
            <input
              value={form.remarks}
              onChange={(e) => setForm((f) => ({ ...f, remarks: e.target.value }))}
              className="w-full rounded-xl border px-3 py-2 text-sm"
            />
          </Field>
          {saveErr && (
            <div className="sm:col-span-2">
              <ErrorBanner message={saveErr} />
            </div>
          )}
          <div className="sm:col-span-2">
            <button
              type="submit"
              className="w-full rounded-xl bg-gray-900 py-2 text-sm text-white"
            >
              Save
            </button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
