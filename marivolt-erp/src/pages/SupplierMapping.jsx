import { useEffect, useState } from "react";
import {
  fetchMaterialSupplierList,
  createMaterialSupplier,
  updateMaterialSupplier,
  deleteMaterialSupplier,
  importMaterialSuppliers,
  fetchMaterialList,
} from "../lib/materialApi.js";
import { STATUSES } from "../lib/masterValuesClient.js";

export default function SupplierMappingPage() {
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
    materialCode: "",
    supplierName: "",
    supplierArticleNo: "",
    supplierDescription: "",
    currency: "",
    purchasePrice: "",
    leadTimeDays: "",
    moq: "",
    supplierCountry: "",
    preferred: false,
    status: "Active",
    remarks: "",
  });

  async function load(page = 1) {
    setErr("");
    setLoading(true);
    try {
      const data = await fetchMaterialSupplierList({
        page,
        search,
        materialCode: materialFilter,
        status: statusFilter,
      });
      setItems(data.items || []);
      setPagination(data.pagination || { page, limit: 20, total: 0 });
    } catch (e) {
      setErr(e.message || "Failed to load supplier mappings");
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
    const { name, value, type, checked } = e.target;
    setForm((p) => ({
      ...p,
      [name]: type === "checkbox" ? checked : value,
    }));
  }

  function startCreate() {
    setEditing(null);
    setForm({
      materialCode: "",
      supplierName: "",
      supplierArticleNo: "",
      supplierDescription: "",
      currency: "",
      purchasePrice: "",
      leadTimeDays: "",
      moq: "",
      supplierCountry: "",
      preferred: false,
      status: "Active",
      remarks: "",
    });
  }

  function startEdit(it) {
    setEditing(it);
    setForm({
      materialCode: it.materialCode || "",
      supplierName: it.supplierName || "",
      supplierArticleNo: it.supplierArticleNo || "",
      supplierDescription: it.supplierDescription || "",
      currency: it.currency || "",
      purchasePrice: it.purchasePrice ?? "",
      leadTimeDays: it.leadTimeDays ?? "",
      moq: it.moq ?? "",
      supplierCountry: it.supplierCountry || "",
      preferred: !!it.preferred,
      status: it.status || "Active",
      remarks: it.remarks || "",
    });
  }

  async function onSubmit(e) {
    e.preventDefault();
    setErr("");
    try {
      const payload = {
        ...form,
        purchasePrice:
          form.purchasePrice === "" ? "" : Number(form.purchasePrice),
        leadTimeDays:
          form.leadTimeDays === "" ? "" : Number(form.leadTimeDays),
        moq: form.moq === "" ? "" : Number(form.moq),
      };
      if (editing) {
        await updateMaterialSupplier(editing._id, payload);
      } else {
        await createMaterialSupplier(payload);
      }
      await load(pagination.page);
      if (!editing) startCreate();
    } catch (e2) {
      setErr(e2.message || "Failed to save supplier mapping");
    }
  }

  async function onDelete(id) {
    if (!window.confirm("Delete this mapping?")) return;
    setErr("");
    try {
      await deleteMaterialSupplier(id);
      await load(pagination.page);
      if (editing && editing._id === id) startCreate();
    } catch (e) {
      setErr(e.message || "Failed to delete mapping");
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
      const result = await importMaterialSuppliers(rows);
      setErr(
        `Imported: ${result.successRows}, Failed: ${result.failedRows}, Duplicates: ${result.duplicateRows}`
      );
      await load(1);
    } catch (e) {
      setErr(e.message || "Failed to import supplier mappings");
    }
  }

  function downloadTemplate() {
    const headers = [
      "materialCode",
      "supplierName",
      "supplierArticleNo",
      "supplierDescription",
      "currency",
      "purchasePrice",
      "leadTimeDays",
      "moq",
      "supplierCountry",
      "preferred",
      "status",
      "remarks",
    ];
    const example = [
      "MAT-1001",
      "Default Supplier",
      "SUP-ART-1001",
      "Exhaust valve OEM - W32",
      "EUR",
      "500",
      "30",
      "2",
      "FI",
      "true",
      "Active",
      "",
    ];
    const csv =
      [headers.join(","), example.map((c) => `"${c}"`).join(",")].join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = "supplier-mapping-template.csv";
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
        <h1 className="text-xl font-semibold">Supplier Mapping</h1>
        <p className="mt-1 text-gray-600">
          Map materials to suppliers with purchase price, lead time and MOQs.
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
              {editing ? "Edit Mapping" : "Add Mapping"}
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
              <select
                name="materialCode"
                value={form.materialCode}
                onChange={onChange}
                className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
              >
                <option value="">Select material...</option>
                {materialOptions.map((m) => (
                  <option key={m._id} value={m.materialCode}>
                    {m.materialCode}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-sm text-gray-600">Supplier name *</label>
              <input
                name="supplierName"
                value={form.supplierName}
                onChange={onChange}
                className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="text-sm text-gray-600">
                Supplier article no
              </label>
              <input
                name="supplierArticleNo"
                value={form.supplierArticleNo}
                onChange={onChange}
                className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="text-sm text-gray-600">
                Supplier description
              </label>
              <input
                name="supplierDescription"
                value={form.supplierDescription}
                onChange={onChange}
                className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-sm text-gray-600">Currency</label>
                <input
                  name="currency"
                  value={form.currency}
                  onChange={onChange}
                  className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
                  placeholder="EUR, USD..."
                />
              </div>
              <div>
                <label className="text-sm text-gray-600">Purchase price</label>
                <input
                  name="purchasePrice"
                  value={form.purchasePrice}
                  onChange={onChange}
                  className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-sm text-gray-600">
                  Lead time (days)
                </label>
                <input
                  name="leadTimeDays"
                  value={form.leadTimeDays}
                  onChange={onChange}
                  className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="text-sm text-gray-600">MOQ</label>
                <input
                  name="moq"
                  value={form.moq}
                  onChange={onChange}
                  className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-sm text-gray-600">Supplier country</label>
                <input
                  name="supplierCountry"
                  value={form.supplierCountry}
                  onChange={onChange}
                  className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
                  placeholder="e.g. FI"
                />
              </div>
              <div className="flex items-end gap-2">
                <input
                  id="preferred"
                  type="checkbox"
                  name="preferred"
                  checked={form.preferred}
                  onChange={onChange}
                  className="mb-1 h-4 w-4 rounded border-gray-300"
                />
                <label
                  htmlFor="preferred"
                  className="text-sm text-gray-600 mb-1"
                >
                  Preferred
                </label>
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
              {editing ? "Update Mapping" : "Add Mapping"}
            </button>
          </form>
        </div>

        <div className="rounded-2xl border bg-white p-6 lg:col-span-2">
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <h2 className="text-base font-semibold">Supplier mappings</h2>
            <div className="flex flex-wrap gap-2">
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-full rounded-xl border px-3 py-2 text-sm md:w-64"
                placeholder="Search supplier / article..."
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
                      <th className="py-2 pr-3">Material code</th>
                      <th className="py-2 pr-3">Supplier</th>
                      <th className="py-2 pr-3">Supplier article</th>
                      <th className="py-2 pr-3">Description</th>
                      <th className="py-2 pr-3">Currency</th>
                      <th className="py-2 pr-3">Price</th>
                      <th className="py-2 pr-3">Lead time</th>
                      <th className="py-2 pr-3">MOQ</th>
                      <th className="py-2 pr-3">Country</th>
                      <th className="py-2 pr-3">Preferred</th>
                      <th className="py-2 pr-3">Status</th>
                      <th className="py-2 pr-3"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.length === 0 ? (
                      <tr>
                        <td
                          className="py-6 text-center text-gray-500"
                          colSpan={12}
                        >
                          No mappings.
                        </td>
                      </tr>
                    ) : (
                      items.map((it) => (
                        <tr key={it._id} className="border-b last:border-b-0">
                          <td className="py-2 pr-3">{it.materialCode}</td>
                          <td className="py-2 pr-3">{it.supplierName}</td>
                          <td className="py-2 pr-3">
                            {it.supplierArticleNo || "-"}
                          </td>
                          <td className="py-2 pr-3">
                            {it.supplierDescription || "-"}
                          </td>
                          <td className="py-2 pr-3">{it.currency || "-"}</td>
                          <td className="py-2 pr-3">
                            {it.purchasePrice ?? ""}
                          </td>
                          <td className="py-2 pr-3">
                            {it.leadTimeDays ?? ""}
                          </td>
                          <td className="py-2 pr-3">{it.moq ?? ""}</td>
                          <td className="py-2 pr-3">
                            {it.supplierCountry || "-"}
                          </td>
                          <td className="py-2 pr-3">
                            {it.preferred ? "Yes" : ""}
                          </td>
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

