import { useCallback, useEffect, useState } from "react";
import {
  createMaterialSupplier,
  deleteMaterialSupplier,
  fetchMaterialList,
  fetchMaterialSupplierList,
  importMaterialSuppliers,
  updateMaterialSupplier,
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

export default function SupplierMappingMaster() {
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
    materialCode: "",
    supplierName: "",
    supplierArticleNo: "",
    supplierDescription: "",
    currency: "",
    price: 0,
    leadTimeDays: 0,
    moq: 0,
    supplierCountry: "",
    preferred: false,
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
      const r = await fetchMaterialSupplierList({
        page: pagination.page,
        limit: pagination.limit,
        search,
        materialCode: filterMaterial || undefined,
      });
      setItems(r.items || []);
      setPagination((p) => ({ ...p, ...(r.pagination || {}), limit: LIMIT }));
    } catch (e) {
      setErr(e.message || "Failed to load supplier mappings");
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
      materialCode: filterMaterial || "",
      supplierName: "",
      supplierArticleNo: "",
      supplierDescription: "",
      currency: "",
      price: 0,
      leadTimeDays: 0,
      moq: 0,
      supplierCountry: "",
      preferred: false,
      status: "Active",
      remarks: "",
    });
    setModalOpen(true);
  }

  function openEdit(row) {
    setEditing(row);
    setSaveErr("");
    setForm({
      materialCode: row.materialCode || "",
      supplierName: row.supplierName || "",
      supplierArticleNo: row.supplierArticleNo || "",
      supplierDescription: row.supplierDescription || "",
      currency: row.currency || "",
      price: row.price ?? row.purchasePrice ?? 0,
      leadTimeDays: row.leadTimeDays ?? 0,
      moq: row.moq ?? 0,
      supplierCountry: row.supplierCountry || "",
      preferred: Boolean(row.preferred),
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
      price: Number(form.price) || 0,
      leadTimeDays: Number(form.leadTimeDays) || 0,
      moq: Number(form.moq) || 0,
      preferred: Boolean(form.preferred),
    };
    try {
      if (editing) {
        await updateMaterialSupplier(editing._id, payload);
      } else {
        await createMaterialSupplier(payload);
      }
      setModalOpen(false);
      await load();
    } catch (e2) {
      setSaveErr(e2.message || "Save failed");
    }
  }

  async function remove(row) {
    if (!window.confirm("Delete this supplier mapping?")) return;
    setErr("");
    try {
      await deleteMaterialSupplier(row._id);
      await load();
    } catch (e2) {
      setErr(e2.message || "Delete failed");
    }
  }

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border bg-white p-6">
        <h1 className="text-xl font-semibold">Material supplier mapping</h1>
        <p className="mt-1 text-gray-600">
          Alternate sources per material: price, lead time, MOQ, and preferred flag.
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
              placeholder="Supplier name, article no…"
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
              Add mapping
            </button>
          </div>
        </div>

        <div className="mt-4 overflow-x-auto">
          {loading ? (
            <p className="text-sm text-gray-500">Loading…</p>
          ) : (
            <table className="w-full min-w-[900px] border-collapse text-sm">
              <thead>
                <tr className="border-b text-left text-gray-600">
                  <th className="py-2 pr-2">Material</th>
                  <th className="py-2 pr-2">Supplier</th>
                  <th className="py-2 pr-2">Sup. article</th>
                  <th className="py-2 pr-2">Currency</th>
                  <th className="py-2 pr-2">Price</th>
                  <th className="py-2 pr-2">Lead (d)</th>
                  <th className="py-2 pr-2">Pref.</th>
                  <th className="py-2 pr-2">Status</th>
                  <th className="py-2">Actions</th>
                </tr>
              </thead>
              <tbody>
                {items.map((row) => (
                  <tr key={row._id} className="border-b border-gray-100">
                    <td className="py-2 pr-2 font-mono text-xs">{row.materialCode}</td>
                    <td className="py-2 pr-2 font-medium">{row.supplierName}</td>
                    <td className="py-2 pr-2 text-xs">{row.supplierArticleNo || "—"}</td>
                    <td className="py-2 pr-2">{row.currency || "—"}</td>
                    <td className="py-2 pr-2">
                      {row.price ?? row.purchasePrice ?? "—"}
                    </td>
                    <td className="py-2 pr-2">{row.leadTimeDays ?? "—"}</td>
                    <td className="py-2 pr-2">{row.preferred ? "Yes" : ""}</td>
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
        title="Bulk import supplier rows (append-only)"
        hint="Each row creates a new mapping. Columns: materialCode, supplierName, supplierArticleNo, supplierDescription, currency, price (or purchasePrice), leadTimeDays, moq, supplierCountry, preferred, status, remarks."
        onImport={(rows) => importMaterialSuppliers(rows)}
      />

      <Modal
        open={modalOpen}
        title={editing ? "Edit supplier mapping" : "New supplier mapping"}
        onClose={() => setModalOpen(false)}
        wide
      >
        <form onSubmit={save} className="grid gap-3 sm:grid-cols-2">
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
                  {m.materialCode}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Supplier name *" className="sm:col-span-2">
            <input
              required
              value={form.supplierName}
              onChange={(e) =>
                setForm((f) => ({ ...f, supplierName: e.target.value }))
              }
              className="w-full rounded-xl border px-3 py-2 text-sm"
            />
          </Field>
          <Field label="Supplier article no">
            <input
              value={form.supplierArticleNo}
              onChange={(e) =>
                setForm((f) => ({ ...f, supplierArticleNo: e.target.value }))
              }
              className="w-full rounded-xl border px-3 py-2 text-sm"
            />
          </Field>
          <Field label="Currency">
            <input
              value={form.currency}
              onChange={(e) => setForm((f) => ({ ...f, currency: e.target.value }))}
              className="w-full rounded-xl border px-3 py-2 text-sm"
              placeholder="EUR, USD…"
            />
          </Field>
          <Field label="Price *">
            <input
              type="number"
              step="any"
              required
              value={form.price}
              onChange={(e) => setForm((f) => ({ ...f, price: e.target.value }))}
              className="w-full rounded-xl border px-3 py-2 text-sm"
            />
          </Field>
          <Field label="Lead time (days)">
            <input
              type="number"
              value={form.leadTimeDays}
              onChange={(e) =>
                setForm((f) => ({ ...f, leadTimeDays: e.target.value }))
              }
              className="w-full rounded-xl border px-3 py-2 text-sm"
            />
          </Field>
          <Field label="MOQ">
            <input
              type="number"
              value={form.moq}
              onChange={(e) => setForm((f) => ({ ...f, moq: e.target.value }))}
              className="w-full rounded-xl border px-3 py-2 text-sm"
            />
          </Field>
          <Field label="Country">
            <input
              value={form.supplierCountry}
              onChange={(e) =>
                setForm((f) => ({ ...f, supplierCountry: e.target.value }))
              }
              className="w-full rounded-xl border px-3 py-2 text-sm"
            />
          </Field>
          <Field label="Supplier description" className="sm:col-span-2">
            <input
              value={form.supplierDescription}
              onChange={(e) =>
                setForm((f) => ({ ...f, supplierDescription: e.target.value }))
              }
              className="w-full rounded-xl border px-3 py-2 text-sm"
            />
          </Field>
          <Field label="Preferred">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={form.preferred}
                onChange={(e) =>
                  setForm((f) => ({ ...f, preferred: e.target.checked }))
                }
              />
              Mark as preferred source
            </label>
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
