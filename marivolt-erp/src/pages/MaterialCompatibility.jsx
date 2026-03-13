import { useEffect, useState } from "react";
import {
  fetchMaterialCompatList,
  importMaterialCompat,
} from "../lib/materialApi.js";
import {
  ENGINE_MAKES,
  ENGINE_MODELS,
  CONFIGURATIONS,
  CYLINDER_COUNTS,
  STATUSES,
} from "../lib/masterValuesClient.js";

export default function MaterialCompatibilityPage() {
  const [items, setItems] = useState([]);
  const [pagination, setPagination] = useState({ page: 1, limit: 50, total: 0 });
  const [materialCodeFilter, setMaterialCodeFilter] = useState("");
  const [engineMakeFilter, setEngineMakeFilter] = useState("");
  const [engineModelFilter, setEngineModelFilter] = useState("");
  const [configurationFilter, setConfigurationFilter] = useState("");
  const [cylinderFilter, setCylinderFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");

  async function load(page = 1) {
    setErr("");
    setLoading(true);
    try {
      const data = await fetchMaterialCompatList({
        page,
        materialCode: materialCodeFilter,
        engineMake: engineMakeFilter,
        engineModel: engineModelFilter,
        configuration: configurationFilter,
        cylinderCount: cylinderFilter,
        status: statusFilter,
      });
      setItems(data.items || []);
      setPagination(data.pagination || { page, limit: 50, total: 0 });
    } catch (e) {
      setErr(e.message || "Failed to load material compatibility");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
      const result = await importMaterialCompat(rows);
      setErr(
        `Imported: ${result.successRows}, Failed: ${result.failedRows}, Duplicates: ${result.duplicateRows}`
      );
      await load(1);
    } catch (e) {
      setErr(e.message || "Failed to import compatibility");
    }
  }

  function downloadTemplate() {
    const headers = [
      "materialCode",
      "engineMake",
      "engineModel",
      "configuration",
      "cylinderCount",
      "esnFrom",
      "esnTo",
      "applicabilityRemarks",
      "status",
    ];
    const example = [
      "MAT-1001",
      "Wärtsilä",
      "W32",
      "Inline",
      "6L",
      "",
      "",
      "Common for inline engines",
      "Active",
    ];
    const csv =
      [headers.join(","), example.map((c) => `"${c}"`).join(",")].join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = "material-compatibility-template.csv";
    link.click();
    URL.revokeObjectURL(link.href);
  }

  const totalPages = Math.max(
    1,
    Math.ceil((pagination.total || 0) / (pagination.limit || 50))
  );

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border bg-white p-6">
        <h1 className="text-xl font-semibold">Material Compatibility</h1>
        <p className="mt-1 text-gray-600">
          Vertical mapping for material codes to engine make, model,
          configuration, cylinder count and optional ESN ranges.
        </p>
        {err && (
          <div className="mt-3 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">
            {err}
          </div>
        )}
      </div>

      <div className="rounded-2xl border bg-white p-6">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div className="space-y-2">
            <h2 className="text-base font-semibold">Compatibility rows</h2>
            <div className="flex flex-wrap gap-2 text-xs text-gray-600">
              <input
                value={materialCodeFilter}
                onChange={(e) => setMaterialCodeFilter(e.target.value)}
                className="rounded-xl border px-2 py-1 text-xs"
                placeholder="Material code"
              />
              <select
                value={engineMakeFilter}
                onChange={(e) => setEngineMakeFilter(e.target.value)}
                className="rounded-xl border px-2 py-1 text-xs"
              >
                <option value="">Make</option>
                {ENGINE_MAKES.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
              <select
                value={engineModelFilter}
                onChange={(e) => setEngineModelFilter(e.target.value)}
                className="rounded-xl border px-2 py-1 text-xs"
              >
                <option value="">Model</option>
                {ENGINE_MODELS.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
              <select
                value={configurationFilter}
                onChange={(e) => setConfigurationFilter(e.target.value)}
                className="rounded-xl border px-2 py-1 text-xs"
              >
                <option value="">Cfg</option>
                {CONFIGURATIONS.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
              <select
                value={cylinderFilter}
                onChange={(e) => setCylinderFilter(e.target.value)}
                className="rounded-xl border px-2 py-1 text-xs"
              >
                <option value="">Cyl</option>
                {CYLINDER_COUNTS.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
                className="rounded-xl border px-2 py-1 text-xs"
              >
                <option value="">Status</option>
                {STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => load(1)}
                className="rounded-xl border px-2 py-1 text-xs hover:bg-gray-50"
              >
                Apply
              </button>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
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
                    <th className="py-2 pr-3">Engine make</th>
                    <th className="py-2 pr-3">Engine model</th>
                    <th className="py-2 pr-3">Configuration</th>
                    <th className="py-2 pr-3">Cylinder count</th>
                    <th className="py-2 pr-3">ESN from</th>
                    <th className="py-2 pr-3">ESN to</th>
                    <th className="py-2 pr-3">Remarks</th>
                    <th className="py-2 pr-3">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {items.length === 0 ? (
                    <tr>
                      <td
                        className="py-6 text-center text-gray-500"
                        colSpan={9}
                      >
                        No compatibility rows.
                      </td>
                    </tr>
                  ) : (
                    items.map((r) => (
                      <tr key={r._id} className="border-b last:border-b-0">
                        <td className="py-2 pr-3">{r.materialCode}</td>
                        <td className="py-2 pr-3">{r.engineMake}</td>
                        <td className="py-2 pr-3">{r.engineModel}</td>
                        <td className="py-2 pr-3">{r.configuration}</td>
                        <td className="py-2 pr-3">{r.cylinderCount}</td>
                        <td className="py-2 pr-3">
                          {r.esnFrom != null ? r.esnFrom : ""}
                        </td>
                        <td className="py-2 pr-3">
                          {r.esnTo != null ? r.esnTo : ""}
                        </td>
                        <td className="py-2 pr-3">
                          {r.applicabilityRemarks || "-"}
                        </td>
                        <td className="py-2 pr-3">{r.status}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          )}

          <div className="mt-3 flex items-center justify-between text-xs text-gray-600">
            <div>
              Page {pagination.page} of {totalPages} • {pagination.total} row(s)
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
  );
}

