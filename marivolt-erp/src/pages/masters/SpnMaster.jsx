import { useCallback, useEffect, useState } from "react";
import {
  createSpn,
  deleteSpn,
  fetchSpnList,
  fetchVerticalList,
  importSpn,
  updateSpn,
} from "../../lib/materialApi.js";
import { STATUSES } from "../../lib/masterValuesClient.js";
import {
  Modal,
  PaginationBar,
  Field,
  ErrorBanner,
} from "../../components/master/MasterUi.jsx";
import ImportPanel from "../../components/master/ImportPanel.jsx";
import { refId } from "../../utils/refId.js";

const LIMIT = 20;

export default function SpnMaster() {
  const [verticals, setVerticals] = useState([]);
  const [items, setItems] = useState([]);
  const [pagination, setPagination] = useState({ page: 1, limit: LIMIT, total: 0 });
  const [search, setSearch] = useState("");
  const [filterVertical, setFilterVertical] = useState("");
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");

  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [saveErr, setSaveErr] = useState("");
  const [form, setForm] = useState({
    spn: "",
    vertical: "",
    partName: "",
    description: "",
    genericDescription: "",
    category: "",
    subCategory: "",
    uom: "",
    status: "Active",
    remarks: "",
  });

  useEffect(() => {
    fetchVerticalList({ limit: 500 })
      .then((r) => setVerticals(r.items || []))
      .catch(() => setVerticals([]));
  }, []);

  const load = useCallback(async () => {
    setErr("");
    setLoading(true);
    try {
      const r = await fetchSpnList({
        page: pagination.page,
        limit: pagination.limit,
        search,
        vertical: filterVertical || undefined,
      });
      setItems(r.items || []);
      setPagination((p) => ({ ...p, ...(r.pagination || {}), limit: LIMIT }));
    } catch (e) {
      setErr(e.message || "Failed to load SPNs");
    } finally {
      setLoading(false);
    }
  }, [pagination.page, pagination.limit, search, filterVertical]);

  useEffect(() => {
    load();
  }, [load]);

  function openCreate() {
    setEditing(null);
    setSaveErr("");
    setForm({
      spn: "",
      vertical: filterVertical || "",
      partName: "",
      description: "",
      genericDescription: "",
      category: "",
      subCategory: "",
      uom: "",
      status: "Active",
      remarks: "",
    });
    setModalOpen(true);
  }

  function openEdit(row) {
    setEditing(row);
    setSaveErr("");
    setForm({
      spn: row.spn || "",
      vertical: refId(row.vertical),
      partName: row.partName || "",
      description: row.description || row.genericDescription || "",
      genericDescription: row.genericDescription || row.description || "",
      category: row.category || "",
      subCategory: row.subCategory || "",
      uom: row.uom || "",
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
      genericDescription: form.genericDescription || form.description,
      description: form.description || form.genericDescription,
    };
    try {
      if (editing) {
        await updateSpn(editing._id, payload);
      } else {
        await createSpn(payload);
      }
      setModalOpen(false);
      await load();
    } catch (e2) {
      setSaveErr(e2.message || "Save failed");
    }
  }

  async function remove(row) {
    if (!window.confirm(`Delete SPN “${row.spn}”?`)) return;
    setErr("");
    try {
      await deleteSpn(row._id);
      await load();
    } catch (e2) {
      setErr(e2.message || "Delete failed");
    }
  }

  function verticalLabel(row) {
    const v = row.vertical;
    if (v && typeof v === "object") return v.name || "—";
    return "—";
  }

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border bg-white p-6">
        <h1 className="text-xl font-semibold">SPN master</h1>
        <p className="mt-1 text-gray-600">
          Standard part numbers per vertical. Materials must use the same vertical as their SPN.
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
              placeholder="SPN, name, description…"
            />
          </Field>
          <Field label="Vertical">
            <select
              value={filterVertical}
              onChange={(e) => setFilterVertical(e.target.value)}
              className="w-full rounded-xl border px-3 py-2 text-sm"
            >
              <option value="">All</option>
              {verticals.map((v) => (
                <option key={v._id} value={v._id}>
                  {v.name}
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
              Add SPN
            </button>
          </div>
        </div>

        <div className="mt-4 overflow-x-auto">
          {loading ? (
            <p className="text-sm text-gray-500">Loading…</p>
          ) : (
            <table className="w-full min-w-[720px] border-collapse text-sm">
              <thead>
                <tr className="border-b text-left text-gray-600">
                  <th className="py-2 pr-2">SPN</th>
                  <th className="py-2 pr-2">Vertical</th>
                  <th className="py-2 pr-2">Part name</th>
                  <th className="py-2 pr-2">Description</th>
                  <th className="py-2 pr-2">UoM</th>
                  <th className="py-2 pr-2">Status</th>
                  <th className="py-2">Actions</th>
                </tr>
              </thead>
              <tbody>
                {items.map((row) => (
                  <tr key={row._id} className="border-b border-gray-100">
                    <td className="py-2 pr-2 font-mono text-xs">{row.spn}</td>
                    <td className="py-2 pr-2">{verticalLabel(row)}</td>
                    <td className="py-2 pr-2">{row.partName}</td>
                    <td className="py-2 pr-2 text-gray-600">
                      {row.description || row.genericDescription || "—"}
                    </td>
                    <td className="py-2 pr-2">{row.uom || "—"}</td>
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
        hint="Columns must include spn, vertical (Mongo id), partName. Optional: description, genericDescription, category, subCategory, uom, status, remarks."
        onImport={(rows) => importSpn(rows)}
      />

      <Modal
        open={modalOpen}
        title={editing ? "Edit SPN" : "New SPN"}
        onClose={() => setModalOpen(false)}
        wide
      >
        <form onSubmit={save} className="grid gap-3 sm:grid-cols-2">
          <Field label="SPN *" className="sm:col-span-2">
            <input
              required
              value={form.spn}
              onChange={(e) => setForm((f) => ({ ...f, spn: e.target.value }))}
              className="w-full rounded-xl border px-3 py-2 text-sm font-mono"
            />
          </Field>
          <Field label="Vertical *" className="sm:col-span-2">
            <select
              required
              value={form.vertical}
              onChange={(e) => setForm((f) => ({ ...f, vertical: e.target.value }))}
              className="w-full rounded-xl border px-3 py-2 text-sm"
            >
              <option value="">Select…</option>
              {verticals.map((v) => (
                <option key={v._id} value={v._id}>
                  {v.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Part name *" className="sm:col-span-2">
            <input
              required
              value={form.partName}
              onChange={(e) => setForm((f) => ({ ...f, partName: e.target.value }))}
              className="w-full rounded-xl border px-3 py-2 text-sm"
            />
          </Field>
          <Field label="Description" className="sm:col-span-2">
            <textarea
              value={form.description}
              onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
              rows={2}
              className="w-full rounded-xl border px-3 py-2 text-sm"
            />
          </Field>
          <Field label="Category">
            <input
              value={form.category}
              onChange={(e) => setForm((f) => ({ ...f, category: e.target.value }))}
              className="w-full rounded-xl border px-3 py-2 text-sm"
            />
          </Field>
          <Field label="Sub-category">
            <input
              value={form.subCategory}
              onChange={(e) => setForm((f) => ({ ...f, subCategory: e.target.value }))}
              className="w-full rounded-xl border px-3 py-2 text-sm"
            />
          </Field>
          <Field label="UoM">
            <input
              value={form.uom}
              onChange={(e) => setForm((f) => ({ ...f, uom: e.target.value }))}
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
