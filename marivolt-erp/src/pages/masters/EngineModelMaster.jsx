import { useCallback, useEffect, useState } from "react";
import {
  createEngineModel,
  deleteEngineModel,
  fetchBrandList,
  fetchEngineModelList,
  updateEngineModel,
} from "../../lib/materialApi.js";
import { STATUSES } from "../../lib/masterValuesClient.js";
import {
  Modal,
  PaginationBar,
  Field,
  ErrorBanner,
} from "../../components/master/MasterUi.jsx";
import { refId } from "../../utils/refId.js";

const LIMIT = 25;

function brandLabel(row) {
  const b = row.brand;
  if (b && typeof b === "object") return b.name || "—";
  return "—";
}

function verticalLabel(row) {
  const b = row.brand;
  const v = b?.vertical;
  if (v && typeof v === "object") return v.name || "—";
  return "—";
}

export default function EngineModelMaster() {
  const [brands, setBrands] = useState([]);
  const [items, setItems] = useState([]);
  const [pagination, setPagination] = useState({ page: 1, limit: LIMIT, total: 0 });
  const [search, setSearch] = useState("");
  const [filterBrand, setFilterBrand] = useState("");
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");

  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [saveErr, setSaveErr] = useState("");
  const [form, setForm] = useState({
    name: "",
    brand: "",
    status: "Active",
  });

  useEffect(() => {
    fetchBrandList({ limit: 800 })
      .then((r) => setBrands(r.items || []))
      .catch(() => setBrands([]));
  }, []);

  const load = useCallback(async () => {
    setErr("");
    setLoading(true);
    try {
      const r = await fetchEngineModelList({
        page: pagination.page,
        limit: pagination.limit,
        search,
        brand: filterBrand || undefined,
      });
      setItems(r.items || []);
      setPagination((p) => ({ ...p, ...(r.pagination || {}), limit: LIMIT }));
    } catch (e) {
      setErr(e.message || "Failed to load engine models");
    } finally {
      setLoading(false);
    }
  }, [pagination.page, pagination.limit, search, filterBrand]);

  useEffect(() => {
    load();
  }, [load]);

  function openCreate() {
    setEditing(null);
    setSaveErr("");
    setForm({
      name: "",
      brand: filterBrand || "",
      status: "Active",
    });
    setModalOpen(true);
  }

  function openEdit(row) {
    setEditing(row);
    setSaveErr("");
    setForm({
      name: row.name || "",
      brand: refId(row.brand),
      status: row.status || "Active",
    });
    setModalOpen(true);
  }

  async function save(e) {
    e.preventDefault();
    setSaveErr("");
    try {
      if (editing) {
        await updateEngineModel(editing._id, form);
      } else {
        await createEngineModel(form);
      }
      setModalOpen(false);
      await load();
    } catch (e2) {
      setSaveErr(e2.message || "Save failed");
    }
  }

  async function remove(row) {
    if (!window.confirm(`Delete model “${row.name}”?`)) return;
    setErr("");
    try {
      await deleteEngineModel(row._id);
      await load();
    } catch (e2) {
      setErr(e2.message || "Delete failed");
    }
  }

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border bg-white p-6">
        <h1 className="text-xl font-semibold">Engine models</h1>
        <p className="mt-1 text-gray-600">
          Engine types per brand (e.g. W32, W34DF, W50DF). Compatibility and resolve use this list.
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
              placeholder="Model name…"
            />
          </Field>
          <Field label="Brand">
            <select
              value={filterBrand}
              onChange={(e) => setFilterBrand(e.target.value)}
              className="w-full rounded-xl border px-3 py-2 text-sm"
            >
              <option value="">All brands</option>
              {brands.map((b) => (
                <option key={b._id} value={b._id}>
                  {b.name}
                </option>
              ))}
            </select>
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
              Add model
            </button>
          </div>
        </div>

        <div className="mt-4 overflow-x-auto">
          {loading ? (
            <p className="text-sm text-gray-500">Loading…</p>
          ) : (
            <table className="w-full min-w-[640px] border-collapse text-sm">
              <thead>
                <tr className="border-b text-left text-gray-600">
                  <th className="py-2 pr-2">Model</th>
                  <th className="py-2 pr-2">Brand</th>
                  <th className="py-2 pr-2">Vertical</th>
                  <th className="py-2 pr-2">Status</th>
                  <th className="py-2">Actions</th>
                </tr>
              </thead>
              <tbody>
                {items.map((row) => (
                  <tr key={row._id} className="border-b border-gray-100">
                    <td className="py-2 pr-2 font-medium">{row.name}</td>
                    <td className="py-2 pr-2">{brandLabel(row)}</td>
                    <td className="py-2 pr-2">{verticalLabel(row)}</td>
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

      <Modal
        open={modalOpen}
        title={editing ? "Edit engine model" : "New engine model"}
        onClose={() => setModalOpen(false)}
      >
        <form onSubmit={save} className="space-y-3">
          <Field label="Brand *">
            <select
              required
              value={form.brand}
              onChange={(e) => setForm((f) => ({ ...f, brand: e.target.value }))}
              className="w-full rounded-xl border px-3 py-2 text-sm"
            >
              <option value="">Select…</option>
              {brands.map((b) => (
                <option key={b._id} value={b._id}>
                  {b.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Model name *">
            <input
              required
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              className="w-full rounded-xl border px-3 py-2 text-sm"
              placeholder="e.g. W32, W34DF, W50DF"
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
          {saveErr && <ErrorBanner message={saveErr} />}
          <button
            type="submit"
            className="w-full rounded-xl bg-gray-900 py-2 text-sm text-white"
          >
            Save
          </button>
        </form>
      </Modal>
    </div>
  );
}
