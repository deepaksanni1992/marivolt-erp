import { useCallback, useEffect, useState } from "react";
import {
  createVertical,
  deleteVertical,
  fetchVerticalList,
  updateVertical,
} from "../../lib/materialApi.js";
import { STATUSES } from "../../lib/masterValuesClient.js";
import {
  Modal,
  PaginationBar,
  Field,
  ErrorBanner,
} from "../../components/master/MasterUi.jsx";

const LIMIT = 20;

export default function VerticalMaster() {
  const [items, setItems] = useState([]);
  const [pagination, setPagination] = useState({ page: 1, limit: LIMIT, total: 0 });
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");

  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState({ name: "", status: "Active" });
  const [saveErr, setSaveErr] = useState("");

  const load = useCallback(async () => {
    setErr("");
    setLoading(true);
    try {
      const r = await fetchVerticalList({
        page: pagination.page,
        limit: pagination.limit,
        search,
      });
      setItems(r.items || []);
      setPagination((p) => ({ ...p, ...(r.pagination || {}), limit: LIMIT }));
    } catch (e) {
      setErr(e.message || "Failed to load verticals");
    } finally {
      setLoading(false);
    }
  }, [pagination.page, pagination.limit, search]);

  useEffect(() => {
    load();
  }, [load]);

  function openCreate() {
    setEditing(null);
    setSaveErr("");
    setForm({ name: "", status: "Active" });
    setModalOpen(true);
  }

  function openEdit(row) {
    setEditing(row);
    setSaveErr("");
    setForm({
      name: row.name || "",
      status: row.status || "Active",
    });
    setModalOpen(true);
  }

  async function save(e) {
    e.preventDefault();
    setSaveErr("");
    try {
      if (editing) {
        await updateVertical(editing._id, form);
      } else {
        await createVertical(form);
      }
      setModalOpen(false);
      await load();
    } catch (e2) {
      setSaveErr(e2.message || "Save failed");
    }
  }

  async function remove(row) {
    if (!window.confirm(`Delete vertical “${row.name}”?`)) return;
    setErr("");
    try {
      await deleteVertical(row._id);
      await load();
    } catch (e2) {
      setErr(e2.message || "Delete failed");
    }
  }

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border bg-white p-6">
        <h1 className="text-xl font-semibold">Vertical master</h1>
        <p className="mt-1 text-gray-600">
          Product lines (e.g. main engines, turbochargers). Brands are scoped to a vertical.
        </p>
        <ErrorBanner message={err} />
      </div>

      <div className="rounded-2xl border bg-white p-6">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-[200px] flex-1">
            <Field label="Search">
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-full rounded-xl border px-3 py-2 text-sm"
                placeholder="Name…"
              />
            </Field>
          </div>
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
            Add vertical
          </button>
        </div>

        <div className="mt-4 overflow-x-auto">
          {loading ? (
            <p className="text-sm text-gray-500">Loading…</p>
          ) : (
            <table className="w-full min-w-[480px] border-collapse text-sm">
              <thead>
                <tr className="border-b text-left text-gray-600">
                  <th className="py-2 pr-2">Name</th>
                  <th className="py-2 pr-2">Status</th>
                  <th className="py-2">Actions</th>
                </tr>
              </thead>
              <tbody>
                {items.map((row) => (
                  <tr key={row._id} className="border-b border-gray-100">
                    <td className="py-2 pr-2 font-medium">{row.name}</td>
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
        title={editing ? "Edit vertical" : "New vertical"}
        onClose={() => setModalOpen(false)}
      >
        <form onSubmit={save} className="space-y-3">
          <Field label="Name *">
            <input
              required
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
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
