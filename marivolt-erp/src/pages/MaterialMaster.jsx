import { useEffect, useState } from "react";
import {
  fetchMaterialList,
  createMaterial,
  updateMaterial,
  deleteMaterial,
  importMaterials,
  fetchSpnList,
  fetchMaterialCompatList,
  createMaterialCompat,
  deleteMaterialCompat,
} from "../lib/materialApi.js";
import {
  ENGINE_MAKES,
  ENGINE_MODELS,
  CONFIGURATIONS,
  CYLINDER_COUNTS,
  ITEM_TYPES,
  STATUSES,
} from "../lib/masterValuesClient.js";

export default function MaterialMaster() {
  const [items, setItems] = useState([]);
  const [pagination, setPagination] = useState({ page: 1, limit: 20, total: 0 });
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [itemTypeFilter, setItemTypeFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [editing, setEditing] = useState(null);

  const [spnOptions, setSpnOptions] = useState([]);

  const [form, setForm] = useState({
    materialCode: "",
    spn: "",
    shortDescription: "",
    itemType: "OEM",
    unit: "pcs",
    status: "Active",
    remarks: "",
  });

  // Child: compatibility for selected material
  const [compatRows, setCompatRows] = useState([]);
  const [compatLoading, setCompatLoading] = useState(false);
  const [compatForm, setCompatForm] = useState({
    engineMake: "",
    engineModel: "",
    configuration: "",
    cylinderCount: "",
    esnFrom: "",
    esnTo: "",
    applicabilityRemarks: "",
    status: "Active",
  });

  async function load(page = 1) {
    setErr("");
    setLoading(true);
    try {
      const data = await fetchMaterialList({
        page,
        search,
        status: statusFilter,
        itemType: itemTypeFilter,
      });
      setItems(data.items || []);
      setPagination(data.pagination || { page, limit: 20, total: 0 });
    } catch (e) {
      setErr(e.message || "Failed to load Material Master");
    } finally {
      setLoading(false);
    }
  }

  async function loadSpns() {
    try {
      const data = await fetchSpnList({
        page: 1,
        limit: 500,
        status: "Active",
      });
      setSpnOptions(data.items || []);
    } catch {
      // ignore, just keep empty list
    }
  }

  useEffect(() => {
    load(1);
    loadSpns();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function onChange(e) {
    const { name, value } = e.target;
    setForm((p) => ({ ...p, [name]: value }));
  }

  function onCompatChange(e) {
    const { name, value } = e.target;
    setCompatForm((p) => ({ ...p, [name]: value }));
  }

  function startCreate() {
    setEditing(null);
    setForm({
      materialCode: "",
      spn: "",
      shortDescription: "",
      itemType: "OEM",
      unit: "pcs",
      status: "Active",
      remarks: "",
    });
    setCompatRows([]);
  }

  async function loadCompatForMaterial(materialCode) {
    if (!materialCode) {
      setCompatRows([]);
      return;
    }
    setCompatLoading(true);
    try {
      const data = await fetchMaterialCompatList({
        materialCode,
        page: 1,
        limit: 200,
      });
      setCompatRows(data.items || []);
    } catch (e) {
      setErr(e.message || "Failed to load compatibility rows");
    } finally {
      setCompatLoading(false);
    }
  }

  function startEdit(item) {
    setEditing(item);
    setForm({
      materialCode: item.materialCode || "",
      spn: item.spn || "",
      shortDescription: item.shortDescription || "",
      itemType: item.itemType || "OEM",
      unit: item.unit || "pcs",
      status: item.status || "Active",
      remarks: item.remarks || "",
    });
    loadCompatForMaterial(item.materialCode);
  }

  async function onSubmit(e) {
    e.preventDefault();
    setErr("");
    try {
      if (editing) {
        await updateMaterial(editing._id, form);
      } else {
        await createMaterial(form);
      }
      await load(pagination.page);
      if (!editing) {
        startCreate();
      }
    } catch (e2) {
      setErr(e2.message || "Failed to save material");
    }
  }

  async function onDelete(id) {
    if (!window.confirm("Delete this material?")) return;
    setErr("");
    try {
      await deleteMaterial(id);
      await load(pagination.page);
      if (editing && editing._id === id) startCreate();
    } catch (e) {
      setErr(e.message || "Failed to delete material");
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
      const result = await importMaterials(rows);
      setErr(
        `Imported: ${result.successRows}, Failed: ${result.failedRows}, Duplicates: ${result.duplicateRows}`
      );
      await load(1);
    } catch (e) {
      setErr(e.message || "Failed to import materials");
    }
  }

  function downloadTemplate() {
    const headers = [
      "materialCode",
      "spn",
      "shortDescription",
      "itemType",
      "unit",
      "status",
      "remarks",
    ];
    const example = [
      "MAT-1001",
      "SPN-1001",
      "Exhaust valve, W32 inline/Vee",
      "OEM",
      "pcs",
      "Active",
      "",
    ];
    const csv =
      [headers.join(","), example.map((c) => `"${c}"`).join(",")].join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = "material-master-template.csv";
    link.click();
    URL.revokeObjectURL(link.href);
  }

  async function addCompatRow(e) {
    e.preventDefault();
    if (!editing?.materialCode) {
      setErr("Save material first, then add compatibility rows.");
      return;
    }
    setErr("");
    try {
      await createMaterialCompat({
        materialCode: editing.materialCode,
        ...compatForm,
      });
      setCompatForm({
        engineMake: "",
        engineModel: "",
        configuration: "",
        cylinderCount: "",
        esnFrom: "",
        esnTo: "",
        applicabilityRemarks: "",
        status: "Active",
      });
      await loadCompatForMaterial(editing.materialCode);
    } catch (e2) {
      setErr(e2.message || "Failed to add compatibility row");
    }
  }

  async function removeCompatRow(id) {
    if (!window.confirm("Delete this compatibility row?")) return;
    setErr("");
    try {
      await deleteMaterialCompat(id);
      if (editing?.materialCode) await loadCompatForMaterial(editing.materialCode);
    } catch (e) {
      setErr(e.message || "Failed to delete compatibility row");
    }
  }

  const totalPages = Math.max(
    1,
    Math.ceil((pagination.total || 0) / (pagination.limit || 20))
  );

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border bg-white p-6">
        <h1 className="text-xl font-semibold">Material Master</h1>
        <p className="mt-1 text-gray-600">
          Define material codes linked to SPN with item type and unit. One
          material can later have many compatibility mappings and supplier
          options.
        </p>
        {err && (
          <div className="mt-3 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">
            {err}
          </div>
        )}
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        {/* Left: Material form + compatibility child */}
        <div className="space-y-6">
          <div className="rounded-2xl border bg-white p-6">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold">
                {editing ? "Edit Material" : "Add Material"}
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
                <label className="text-sm text-gray-600">Material code *</label>
                <input
                  name="materialCode"
                  value={form.materialCode}
                  onChange={onChange}
                  className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
                  placeholder="e.g. MAT-1001"
                />
              </div>
              <div>
                <label className="text-sm text-gray-600">SPN *</label>
                <select
                  name="spn"
                  value={form.spn}
                  onChange={onChange}
                  className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
                >
                  <option value="">Select SPN...</option>
                  {spnOptions.map((s) => (
                    <option key={s._id} value={s.spn}>
                      {s.spn} — {s.partName}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-sm text-gray-600">
                  Short description *
                </label>
                <input
                  name="shortDescription"
                  value={form.shortDescription}
                  onChange={onChange}
                  className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-sm text-gray-600">Item type *</label>
                  <select
                    name="itemType"
                    value={form.itemType}
                    onChange={onChange}
                    className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
                  >
                    {ITEM_TYPES.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="text-sm text-gray-600">Unit *</label>
                  <input
                    name="unit"
                    value={form.unit}
                    onChange={onChange}
                    className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
                    placeholder="e.g. pcs"
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
                {editing ? "Update Material" : "Add Material"}
              </button>
            </form>
          </div>

          {editing && (
            <div className="rounded-2xl border bg-white p-6">
              <h2 className="text-sm font-semibold">
                Compatibility for {editing.materialCode}
              </h2>
              <form onSubmit={addCompatRow} className="mt-3 space-y-3">
                <div>
                  <label className="text-xs text-gray-600">Engine make *</label>
                  <select
                    name="engineMake"
                    value={compatForm.engineMake}
                    onChange={onCompatChange}
                    className="mt-1 w-full rounded-xl border px-3 py-2 text-xs"
                  >
                    <option value="">Select...</option>
                    {ENGINE_MAKES.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="text-xs text-gray-600">Engine model *</label>
                  <select
                    name="engineModel"
                    value={compatForm.engineModel}
                    onChange={onCompatChange}
                    className="mt-1 w-full rounded-xl border px-3 py-2 text-xs"
                  >
                    <option value="">Select...</option>
                    {ENGINE_MODELS.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="text-xs text-gray-600">
                      Configuration *
                    </label>
                    <select
                      name="configuration"
                      value={compatForm.configuration}
                      onChange={onCompatChange}
                      className="mt-1 w-full rounded-xl border px-3 py-2 text-xs"
                    >
                      <option value="">Select...</option>
                      {CONFIGURATIONS.map((c) => (
                        <option key={c} value={c}>
                          {c}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="text-xs text-gray-600">
                      Cylinder count *
                    </label>
                    <select
                      name="cylinderCount"
                      value={compatForm.cylinderCount}
                      onChange={onCompatChange}
                      className="mt-1 w-full rounded-xl border px-3 py-2 text-xs"
                    >
                      <option value="">Select...</option>
                      {CYLINDER_COUNTS.map((c) => (
                        <option key={c} value={c}>
                          {c}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="text-xs text-gray-600">ESN from</label>
                    <input
                      name="esnFrom"
                      value={compatForm.esnFrom}
                      onChange={onCompatChange}
                      className="mt-1 w-full rounded-xl border px-3 py-2 text-xs"
                    />
                  </div>
                  <div>
                    <label className="text-xs text-gray-600">ESN to</label>
                    <input
                      name="esnTo"
                      value={compatForm.esnTo}
                      onChange={onCompatChange}
                      className="mt-1 w-full rounded-xl border px-3 py-2 text-xs"
                    />
                  </div>
                </div>
                <div>
                  <label className="text-xs text-gray-600">
                    Applicability remarks
                  </label>
                  <input
                    name="applicabilityRemarks"
                    value={compatForm.applicabilityRemarks}
                    onChange={onCompatChange}
                    className="mt-1 w-full rounded-xl border px-3 py-2 text-xs"
                  />
                </div>
                <button
                  type="submit"
                  className="w-full rounded-xl bg-gray-900 px-4 py-2 text-xs font-semibold text-white"
                >
                  + Add compatibility row
                </button>
              </form>

              <div className="mt-4 text-xs text-gray-600">
                Existing compatibility rows
              </div>
              <div className="mt-2 max-h-52 overflow-y-auto text-xs">
                {compatLoading ? (
                  <div className="text-gray-500">Loading...</div>
                ) : compatRows.length === 0 ? (
                  <div className="text-gray-500">No compatibility rows.</div>
                ) : (
                  <table className="w-full text-left text-[11px]">
                    <thead className="border-b text-gray-600">
                      <tr>
                        <th className="py-1 pr-2">Make</th>
                        <th className="py-1 pr-2">Model</th>
                        <th className="py-1 pr-2">Cfg</th>
                        <th className="py-1 pr-2">Cyl</th>
                        <th className="py-1 pr-2">ESN</th>
                        <th className="py-1 pr-2">Status</th>
                        <th className="py-1 pr-2"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {compatRows.map((r) => (
                        <tr key={r._id} className="border-b last:border-b-0">
                          <td className="py-1 pr-2">{r.engineMake}</td>
                          <td className="py-1 pr-2">{r.engineModel}</td>
                          <td className="py-1 pr-2">{r.configuration}</td>
                          <td className="py-1 pr-2">{r.cylinderCount}</td>
                          <td className="py-1 pr-2">
                            {r.esnFrom != null || r.esnTo != null
                              ? `${r.esnFrom ?? ""}–${r.esnTo ?? ""}`
                              : "-"}
                          </td>
                          <td className="py-1 pr-2">{r.status}</td>
                          <td className="py-1 pr-2 text-right">
                            <button
                              type="button"
                              onClick={() => removeCompatRow(r._id)}
                              className="rounded border px-2 py-0.5 text-[10px] text-red-600 hover:bg-red-50"
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
            </div>
          )}
        </div>

        {/* Right: material list */}
        <div className="rounded-2xl border bg-white p-6 lg:col-span-2">
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <h2 className="text-base font-semibold">Materials</h2>
            <div className="flex flex-wrap gap-2">
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-full rounded-xl border px-3 py-2 text-sm md:w-64"
                placeholder="Search material code / SPN / description..."
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
              <select
                value={itemTypeFilter}
                onChange={(e) => setItemTypeFilter(e.target.value)}
                className="rounded-xl border px-3 py-2 text-sm"
              >
                <option value="">All types</option>
                {ITEM_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
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
                      <th className="py-2 pr-3">Material code</th>
                      <th className="py-2 pr-3">SPN</th>
                      <th className="py-2 pr-3">Short description</th>
                      <th className="py-2 pr-3">Item type</th>
                      <th className="py-2 pr-3">Unit</th>
                      <th className="py-2 pr-3">Status</th>
                      <th className="py-2 pr-3">Compat count</th>
                      <th className="py-2 pr-3">Supplier count</th>
                      <th className="py-2 pr-3"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.length === 0 ? (
                      <tr>
                        <td
                          className="py-6 text-center text-gray-500"
                          colSpan={9}
                        >
                          No materials yet.
                        </td>
                      </tr>
                    ) : (
                      items.map((it) => (
                        <tr key={it._id} className="border-b last:border-b-0">
                          <td className="py-2 pr-3 font-medium">
                            {it.materialCode}
                          </td>
                          <td className="py-2 pr-3">{it.spn}</td>
                          <td className="py-2 pr-3">
                            {it.shortDescription || "-"}
                          </td>
                          <td className="py-2 pr-3">{it.itemType}</td>
                          <td className="py-2 pr-3">{it.unit}</td>
                          <td className="py-2 pr-3">{it.status}</td>
                          <td className="py-2 pr-3">
                            {it.compatibilityCount ?? 0}
                          </td>
                          <td className="py-2 pr-3">
                            {it.supplierCount ?? 0}
                          </td>
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

