import { useCallback, useEffect, useState } from "react";
import {
  createMaterialCompat,
  deleteMaterialCompat,
  fetchBrandList,
  fetchMaterialCompatList,
  fetchMaterialList,
  importMaterialCompat,
  updateMaterialCompat,
} from "../../lib/materialApi.js";
import {
  CONFIGURATIONS,
  CYLINDER_COUNTS,
  ENGINE_MODELS,
  STATUSES,
} from "../../lib/masterValuesClient.js";
import {
  Modal,
  PaginationBar,
  Field,
  ErrorBanner,
} from "../../components/master/MasterUi.jsx";
import ImportPanel from "../../components/master/ImportPanel.jsx";
import { refId } from "../../utils/refId.js";

const LIMIT = 30;

export default function MaterialCompatMaster() {
  const [materials, setMaterials] = useState([]);
  const [brandOptions, setBrandOptions] = useState([]);
  const [matVertical, setMatVertical] = useState("");
  const [items, setItems] = useState([]);
  const [pagination, setPagination] = useState({ page: 1, limit: LIMIT, total: 0 });
  const [filterMaterial, setFilterMaterial] = useState("");
  const [filterBrand, setFilterBrand] = useState("");
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");

  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [saveErr, setSaveErr] = useState("");
  const [form, setForm] = useState({
    materialCode: "",
    brand: "",
    engineModel: "",
    configuration: "",
    cylinderCount: "",
    esnFrom: "",
    esnTo: "",
    remarks: "",
    status: "Active",
  });

  useEffect(() => {
    fetchMaterialList({ limit: 500 })
      .then((r) => setMaterials(r.items || []))
      .catch(() => setMaterials([]));
  }, []);

  const loadBrands = useCallback(async (verticalId) => {
    if (!verticalId) {
      setBrandOptions([]);
      return;
    }
    try {
      const r = await fetchBrandList({ vertical: verticalId, limit: 500 });
      setBrandOptions(r.items || []);
    } catch {
      setBrandOptions([]);
    }
  }, []);

  const load = useCallback(async () => {
    setErr("");
    setLoading(true);
    try {
      const r = await fetchMaterialCompatList({
        page: pagination.page,
        limit: pagination.limit,
        materialCode: filterMaterial || undefined,
        brand: filterBrand || undefined,
      });
      setItems(r.items || []);
      setPagination((p) => ({ ...p, ...(r.pagination || {}), limit: LIMIT }));
    } catch (e) {
      setErr(e.message || "Failed to load compatibility rows");
    } finally {
      setLoading(false);
    }
  }, [pagination.page, pagination.limit, filterMaterial, filterBrand]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (modalOpen && matVertical) {
      loadBrands(matVertical);
    }
  }, [modalOpen, matVertical, loadBrands]);

  function syncVerticalForMaterial(code) {
    const m = materials.find((x) => x.materialCode === code);
    const vid = m ? refId(m.vertical) : "";
    setMatVertical(vid);
    loadBrands(vid);
  }

  function openCreate() {
    setEditing(null);
    setSaveErr("");
    setMatVertical("");
    setBrandOptions([]);
    setForm({
      materialCode: filterMaterial || "",
      brand: "",
      engineModel: "",
      configuration: "",
      cylinderCount: "",
      esnFrom: "",
      esnTo: "",
      remarks: "",
      status: "Active",
    });
    setModalOpen(true);
    if (filterMaterial) syncVerticalForMaterial(filterMaterial);
  }

  function openEdit(row) {
    setEditing(row);
    setSaveErr("");
    setForm({
      materialCode: row.materialCode || "",
      brand: row.brand || "",
      engineModel: row.engineModel || "",
      configuration: row.configuration || "",
      cylinderCount: row.cylinderCount || "",
      esnFrom: row.esnFrom ?? "",
      esnTo: row.esnTo ?? "",
      remarks: row.remarks || "",
      status: row.status || "Active",
    });
    setModalOpen(true);
    syncVerticalForMaterial(row.materialCode);
  }

  async function save(e) {
    e.preventDefault();
    setSaveErr("");
    const payload = {
      ...form,
      esnFrom: form.esnFrom === "" ? null : Number(form.esnFrom),
      esnTo: form.esnTo === "" ? null : Number(form.esnTo),
    };
    try {
      if (editing) {
        await updateMaterialCompat(editing._id, payload);
      } else {
        await createMaterialCompat(payload);
      }
      setModalOpen(false);
      await load();
    } catch (e2) {
      setSaveErr(e2.message || "Save failed");
    }
  }

  async function remove(row) {
    if (!window.confirm("Delete this compatibility row?")) return;
    setErr("");
    try {
      await deleteMaterialCompat(row._id);
      await load();
    } catch (e2) {
      setErr(e2.message || "Delete failed");
    }
  }

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border bg-white p-6">
        <h1 className="text-xl font-semibold">Material compatibility</h1>
        <p className="mt-1 text-gray-600">
          Maps a material to brand + engine context. Brand must exist under the material’s vertical.
        </p>
        <ErrorBanner message={err} />
      </div>

      <div className="rounded-2xl border bg-white p-6">
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
          <Field label="Material code">
            <input
              value={filterMaterial}
              onChange={(e) => setFilterMaterial(e.target.value)}
              className="w-full rounded-xl border px-3 py-2 text-sm font-mono"
            />
          </Field>
          <Field label="Brand">
            <input
              value={filterBrand}
              onChange={(e) => setFilterBrand(e.target.value)}
              className="w-full rounded-xl border px-3 py-2 text-sm"
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
              Add row
            </button>
          </div>
        </div>

        <div className="mt-4 overflow-x-auto">
          {loading ? (
            <p className="text-sm text-gray-500">Loading…</p>
          ) : (
            <table className="w-full min-w-[960px] border-collapse text-sm">
              <thead>
                <tr className="border-b text-left text-gray-600">
                  <th className="py-2 pr-2">Material</th>
                  <th className="py-2 pr-2">Brand</th>
                  <th className="py-2 pr-2">Engine model</th>
                  <th className="py-2 pr-2">Config</th>
                  <th className="py-2 pr-2">Cylinders</th>
                  <th className="py-2 pr-2">ESN</th>
                  <th className="py-2 pr-2">Status</th>
                  <th className="py-2">Actions</th>
                </tr>
              </thead>
              <tbody>
                {items.map((row) => (
                  <tr key={row._id} className="border-b border-gray-100">
                    <td className="py-2 pr-2 font-mono text-xs">{row.materialCode}</td>
                    <td className="py-2 pr-2">{row.brand}</td>
                    <td className="py-2 pr-2">{row.engineModel}</td>
                    <td className="py-2 pr-2">{row.configuration}</td>
                    <td className="py-2 pr-2">{row.cylinderCount}</td>
                    <td className="py-2 pr-2 text-xs text-gray-600">
                      {row.esnFrom != null || row.esnTo != null
                        ? `${row.esnFrom ?? "—"} – ${row.esnTo ?? "—"}`
                        : "—"}
                    </td>
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
        hint="Use columns: materialCode, brand, engineModel, configuration, cylinderCount, esnFrom, esnTo, remarks, status. (Same shape as MATERIAL_COMPATIBILITY template.)"
        onImport={(rows) => importMaterialCompat(rows)}
      />

      <Modal
        open={modalOpen}
        title={editing ? "Edit compatibility" : "New compatibility row"}
        onClose={() => setModalOpen(false)}
        wide
      >
        <form onSubmit={save} className="grid gap-3 sm:grid-cols-2">
          <Field label="Material code *" className="sm:col-span-2">
            <select
              required
              value={form.materialCode}
              onChange={(e) => {
                const code = e.target.value;
                const m = materials.find((x) => x.materialCode === code);
                const vid = m ? refId(m.vertical) : "";
                setMatVertical(vid);
                loadBrands(vid);
                setForm((f) => ({ ...f, materialCode: code, brand: "" }));
              }}
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
          {!matVertical && form.materialCode && (
            <p className="sm:col-span-2 text-sm text-amber-700">
              Selected material has no vertical in cache — refresh the page or pick another material.
            </p>
          )}
          <Field label="Brand *" className="sm:col-span-2">
            <select
              required
              value={form.brand}
              onChange={(e) => setForm((f) => ({ ...f, brand: e.target.value }))}
              className="w-full rounded-xl border px-3 py-2 text-sm"
            >
              <option value="">
                {brandOptions.length ? "Select brand…" : "Choose material first"}
              </option>
              {brandOptions.map((b) => (
                <option key={b._id} value={b.name}>
                  {b.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Engine model *">
            <input
              required
              list="dl-engine-models"
              value={form.engineModel}
              onChange={(e) => setForm((f) => ({ ...f, engineModel: e.target.value }))}
              className="w-full rounded-xl border px-3 py-2 text-sm"
            />
            <datalist id="dl-engine-models">
              {ENGINE_MODELS.map((x) => (
                <option key={x} value={x} />
              ))}
            </datalist>
          </Field>
          <Field label="Configuration *">
            <input
              required
              list="dl-config"
              value={form.configuration}
              onChange={(e) =>
                setForm((f) => ({ ...f, configuration: e.target.value }))
              }
              className="w-full rounded-xl border px-3 py-2 text-sm"
            />
            <datalist id="dl-config">
              {CONFIGURATIONS.map((x) => (
                <option key={x} value={x} />
              ))}
            </datalist>
          </Field>
          <Field label="Cylinder count *">
            <input
              required
              list="dl-cyl"
              value={form.cylinderCount}
              onChange={(e) =>
                setForm((f) => ({ ...f, cylinderCount: e.target.value }))
              }
              className="w-full rounded-xl border px-3 py-2 text-sm"
            />
            <datalist id="dl-cyl">
              {CYLINDER_COUNTS.map((x) => (
                <option key={x} value={x} />
              ))}
            </datalist>
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
          <Field label="ESN from">
            <input
              type="number"
              value={form.esnFrom}
              onChange={(e) => setForm((f) => ({ ...f, esnFrom: e.target.value }))}
              className="w-full rounded-xl border px-3 py-2 text-sm"
            />
          </Field>
          <Field label="ESN to">
            <input
              type="number"
              value={form.esnTo}
              onChange={(e) => setForm((f) => ({ ...f, esnTo: e.target.value }))}
              className="w-full rounded-xl border px-3 py-2 text-sm"
            />
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
