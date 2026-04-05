import { useCallback, useEffect, useState } from "react";
import {
  createMaterial,
  deleteMaterial,
  fetchMaterialList,
  fetchSpnList,
  fetchVerticalList,
  importMaterials,
  updateMaterial,
} from "../../lib/materialApi.js";
import { ITEM_TYPES, STATUSES } from "../../lib/masterValuesClient.js";
import {
  Modal,
  PaginationBar,
  Field,
  ErrorBanner,
} from "../../components/master/MasterUi.jsx";
import ImportPanel from "../../components/master/ImportPanel.jsx";
import { refId } from "../../utils/refId.js";

const LIMIT = 20;

export default function MaterialMaster() {
  const [verticals, setVerticals] = useState([]);
  const [spnOptions, setSpnOptions] = useState([]);
  const [items, setItems] = useState([]);
  const [pagination, setPagination] = useState({ page: 1, limit: LIMIT, total: 0 });
  const [search, setSearch] = useState("");
  const [filterVertical, setFilterVertical] = useState("");
  const [filterSpn, setFilterSpn] = useState("");
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");

  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [saveErr, setSaveErr] = useState("");
  const [form, setForm] = useState({
    materialCode: "",
    spn: "",
    vertical: "",
    shortDescription: "",
    itemType: "OEM",
    unit: "",
    status: "Active",
    remarks: "",
  });

  useEffect(() => {
    fetchVerticalList({ limit: 500 })
      .then((r) => setVerticals(r.items || []))
      .catch(() => setVerticals([]));
  }, []);

  const loadSpnsForVertical = useCallback(async (verticalId) => {
    if (!verticalId) {
      setSpnOptions([]);
      return;
    }
    try {
      const r = await fetchSpnList({ vertical: verticalId, limit: 500, page: 1 });
      setSpnOptions(r.items || []);
    } catch {
      setSpnOptions([]);
    }
  }, []);

  const load = useCallback(async () => {
    setErr("");
    setLoading(true);
    try {
      const r = await fetchMaterialList({
        page: pagination.page,
        limit: pagination.limit,
        search,
        vertical: filterVertical || undefined,
        spn: filterSpn || undefined,
      });
      setItems(r.items || []);
      setPagination((p) => ({ ...p, ...(r.pagination || {}), limit: LIMIT }));
    } catch (e) {
      setErr(e.message || "Failed to load materials");
    } finally {
      setLoading(false);
    }
  }, [pagination.page, pagination.limit, search, filterVertical, filterSpn]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (modalOpen && form.vertical) {
      loadSpnsForVertical(form.vertical);
    }
  }, [modalOpen, form.vertical, loadSpnsForVertical]);

  function openCreate() {
    setEditing(null);
    setSaveErr("");
    setSpnOptions([]);
    setForm({
      materialCode: "",
      spn: "",
      vertical: filterVertical || "",
      shortDescription: "",
      itemType: "OEM",
      unit: "",
      status: "Active",
      remarks: "",
    });
    setModalOpen(true);
  }

  function openEdit(row) {
    setEditing(row);
    setSaveErr("");
    const vid = refId(row.vertical);
    setForm({
      materialCode: row.materialCode || "",
      spn: row.spn || "",
      vertical: vid,
      shortDescription: row.shortDescription || "",
      itemType: row.itemType || "OEM",
      unit: row.unit || "",
      status: row.status || "Active",
      remarks: row.remarks || "",
    });
    setModalOpen(true);
    if (vid) loadSpnsForVertical(vid);
  }

  function onSpnChange(code) {
    const opt = spnOptions.find((s) => s.spn === code);
    setForm((f) => ({
      ...f,
      spn: code,
      vertical: opt ? refId(opt.vertical) : f.vertical,
    }));
  }

  function onVerticalChange(vid) {
    setForm((f) => ({ ...f, vertical: vid, spn: "" }));
    loadSpnsForVertical(vid);
  }

  async function save(e) {
    e.preventDefault();
    setSaveErr("");
    try {
      if (editing) {
        await updateMaterial(editing._id, form);
      } else {
        await createMaterial(form);
      }
      setModalOpen(false);
      await load();
    } catch (e2) {
      setSaveErr(e2.message || "Save failed");
    }
  }

  async function remove(row) {
    if (!window.confirm(`Delete material “${row.materialCode}”?`)) return;
    setErr("");
    try {
      await deleteMaterial(row._id);
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
        <h1 className="text-xl font-semibold">Material master</h1>
        <p className="mt-1 text-gray-600">
          Stockkeeping units linked to an SPN and vertical (must match the SPN’s vertical).
        </p>
        <ErrorBanner message={err} />
      </div>

      <div className="rounded-2xl border bg-white p-6">
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-5">
          <Field label="Search">
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full rounded-xl border px-3 py-2 text-sm"
              placeholder="Code, SPN, description…"
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
          <Field label="SPN (exact)">
            <input
              value={filterSpn}
              onChange={(e) => setFilterSpn(e.target.value)}
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
              Add material
            </button>
          </div>
        </div>

        <div className="mt-4 overflow-x-auto">
          {loading ? (
            <p className="text-sm text-gray-500">Loading…</p>
          ) : (
            <table className="w-full min-w-[860px] border-collapse text-sm">
              <thead>
                <tr className="border-b text-left text-gray-600">
                  <th className="py-2 pr-2">Material code</th>
                  <th className="py-2 pr-2">SPN</th>
                  <th className="py-2 pr-2">Vertical</th>
                  <th className="py-2 pr-2">Description</th>
                  <th className="py-2 pr-2">Type</th>
                  <th className="py-2 pr-2">Compat</th>
                  <th className="py-2 pr-2">Suppliers</th>
                  <th className="py-2 pr-2">Status</th>
                  <th className="py-2">Actions</th>
                </tr>
              </thead>
              <tbody>
                {items.map((row) => (
                  <tr key={row._id} className="border-b border-gray-100">
                    <td className="py-2 pr-2 font-mono text-xs font-medium">
                      {row.materialCode}
                    </td>
                    <td className="py-2 pr-2 font-mono text-xs">{row.spn}</td>
                    <td className="py-2 pr-2">{verticalLabel(row)}</td>
                    <td className="py-2 pr-2 text-gray-600">{row.shortDescription}</td>
                    <td className="py-2 pr-2">{row.itemType}</td>
                    <td className="py-2 pr-2">{row.compatibilityCount ?? 0}</td>
                    <td className="py-2 pr-2">{row.supplierCount ?? 0}</td>
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
        hint="Columns: materialCode, spn, vertical (id), shortDescription, itemType, unit, status, remarks."
        onImport={(rows) => importMaterials(rows)}
      />

      <Modal
        open={modalOpen}
        title={editing ? "Edit material" : "New material"}
        onClose={() => setModalOpen(false)}
        wide
      >
        <form onSubmit={save} className="grid gap-3 sm:grid-cols-2">
          <Field label="Material code *" className="sm:col-span-2">
            <input
              required
              value={form.materialCode}
              onChange={(e) =>
                setForm((f) => ({ ...f, materialCode: e.target.value }))
              }
              className="w-full rounded-xl border px-3 py-2 text-sm font-mono"
            />
          </Field>
          <Field label="Vertical *" className="sm:col-span-2">
            <select
              required
              value={form.vertical}
              onChange={(e) => onVerticalChange(e.target.value)}
              className="w-full rounded-xl border px-3 py-2 text-sm"
            >
              <option value="">Select vertical…</option>
              {verticals.map((v) => (
                <option key={v._id} value={v._id}>
                  {v.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="SPN *" className="sm:col-span-2">
            <select
              required
              value={form.spn}
              onChange={(e) => onSpnChange(e.target.value)}
              className="w-full rounded-xl border px-3 py-2 text-sm font-mono"
            >
              <option value="">Select SPN…</option>
              {spnOptions.map((s) => (
                <option key={s._id} value={s.spn}>
                  {s.spn} — {s.partName}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Short description *" className="sm:col-span-2">
            <input
              required
              value={form.shortDescription}
              onChange={(e) =>
                setForm((f) => ({ ...f, shortDescription: e.target.value }))
              }
              className="w-full rounded-xl border px-3 py-2 text-sm"
            />
          </Field>
          <Field label="Item type *">
            <select
              required
              value={form.itemType}
              onChange={(e) => setForm((f) => ({ ...f, itemType: e.target.value }))}
              className="w-full rounded-xl border px-3 py-2 text-sm"
            >
              {ITEM_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Unit *">
            <input
              required
              value={form.unit}
              onChange={(e) => setForm((f) => ({ ...f, unit: e.target.value }))}
              className="w-full rounded-xl border px-3 py-2 text-sm"
              placeholder="pcs, kg…"
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
