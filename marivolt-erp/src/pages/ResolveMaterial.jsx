import { useState } from "react";
import {
  ENGINE_MAKES,
  ENGINE_MODELS,
  CONFIGURATIONS,
  CYLINDER_COUNTS,
} from "../lib/masterValuesClient.js";
import { resolveMaterial } from "../lib/materialApi.js";

export default function ResolveMaterialPage() {
  const [form, setForm] = useState({
    spn: "",
    engineMake: "",
    engineModel: "",
    configuration: "",
    cylinderCount: "",
    esn: "",
  });
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState([]);

  function onChange(e) {
    const { name, value } = e.target;
    setForm((p) => ({ ...p, [name]: value }));
  }

  async function onSubmit(e) {
    e.preventDefault();
    setErr("");
    setLoading(true);
    setResults([]);
    try {
      const payload = {
        spn: form.spn,
        engineMake: form.engineMake,
        engineModel: form.engineModel,
        configuration: form.configuration,
        cylinderCount: form.cylinderCount,
        esn: form.esn || undefined,
      };
      const data = await resolveMaterial(payload);
      setResults(data.items || []);
      if (!data.items || data.items.length === 0) {
        setErr("No matching materials found for the given combination.");
      }
    } catch (e2) {
      setErr(e2.message || "Failed to resolve material");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border bg-white p-6">
        <h1 className="text-xl font-semibold">Resolve Material</h1>
        <p className="mt-1 text-gray-600">
          Resolve correct material code, article and suppliers for a given SPN
          and engine configuration.
        </p>
        {err && (
          <div className="mt-3 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">
            {err}
          </div>
        )}
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="rounded-2xl border bg-white p-6">
          <h2 className="text-base font-semibold">Search parameters</h2>
          <form onSubmit={onSubmit} className="mt-4 space-y-3">
            <div>
              <label className="text-sm text-gray-600">SPN *</label>
              <input
                name="spn"
                value={form.spn}
                onChange={onChange}
                className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
                placeholder="e.g. SPN-1001"
              />
            </div>
            <div>
              <label className="text-sm text-gray-600">Engine make *</label>
              <select
                name="engineMake"
                value={form.engineMake}
                onChange={onChange}
                className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
              >
                <option value="">Select make...</option>
                {ENGINE_MAKES.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-sm text-gray-600">Engine model *</label>
              <select
                name="engineModel"
                value={form.engineModel}
                onChange={onChange}
                className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
              >
                <option value="">Select model...</option>
                {ENGINE_MODELS.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-sm text-gray-600">Configuration *</label>
                <select
                  name="configuration"
                  value={form.configuration}
                  onChange={onChange}
                  className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
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
                <label className="text-sm text-gray-600">Cylinder count *</label>
                <select
                  name="cylinderCount"
                  value={form.cylinderCount}
                  onChange={onChange}
                  className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
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
            <div>
              <label className="text-sm text-gray-600">
                ESN (optional, numeric)
              </label>
              <input
                name="esn"
                value={form.esn}
                onChange={onChange}
                className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
                placeholder="e.g. 12345"
              />
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full rounded-xl bg-gray-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
            >
              {loading ? "Resolving..." : "Resolve material"}
            </button>
          </form>
        </div>

        <div className="rounded-2xl border bg-white p-6 lg:col-span-2">
          <h2 className="text-base font-semibold">Results</h2>
          {loading && (
            <div className="mt-3 text-sm text-gray-600">Resolving...</div>
          )}
          {!loading && results.length === 0 && (
            <div className="mt-3 text-sm text-gray-500">
              No results yet. Enter SPN and engine combination and click Resolve.
            </div>
          )}
          {results.length > 0 && (
            <div className="mt-4 space-y-4">
              {results.map((r) => (
                <div
                  key={r.materialCode}
                  className="rounded-xl border border-gray-200 p-4"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <div className="text-sm font-semibold">
                        Material: {r.materialCode}
                      </div>
                      <div className="text-xs text-gray-600">
                        SPN: {r.spn} • {r.shortDescription}
                      </div>
                      <div className="text-xs text-gray-500">
                        Type: {r.itemType} • Unit: {r.unit}
                      </div>
                    </div>
                  </div>

                  {r.articles && r.articles.length > 0 && (
                    <div className="mt-3">
                      <h3 className="text-xs font-semibold text-gray-600">
                        Articles
                      </h3>
                      <div className="mt-1 overflow-x-auto">
                        <table className="w-full text-left text-xs">
                          <thead className="border-b text-gray-600">
                            <tr>
                              <th className="py-1 pr-2">Article</th>
                              <th className="py-1 pr-2">Description</th>
                              <th className="py-1 pr-2">Drawing</th>
                              <th className="py-1 pr-2">Maker</th>
                              <th className="py-1 pr-2">Brand</th>
                              <th className="py-1 pr-2">Unit</th>
                              <th className="py-1 pr-2">Weight</th>
                            </tr>
                          </thead>
                          <tbody>
                            {r.articles.map((a) => (
                              <tr key={a.articleNo} className="border-b last:border-b-0">
                                <td className="py-1 pr-2 font-medium">
                                  {a.articleNo}
                                </td>
                                <td className="py-1 pr-2">{a.description}</td>
                                <td className="py-1 pr-2">
                                  {a.drawingNo || "-"}
                                </td>
                                <td className="py-1 pr-2">{a.maker || "-"}</td>
                                <td className="py-1 pr-2">{a.brand || "-"}</td>
                                <td className="py-1 pr-2">{a.unit || "-"}</td>
                                <td className="py-1 pr-2">
                                  {a.weight ?? 0}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}

                  {r.suppliers && r.suppliers.length > 0 && (
                    <div className="mt-3">
                      <h3 className="text-xs font-semibold text-gray-600">
                        Supplier options
                      </h3>
                      <div className="mt-1 overflow-x-auto">
                        <table className="w-full text-left text-xs">
                          <thead className="border-b text-gray-600">
                            <tr>
                              <th className="py-1 pr-2">Supplier</th>
                              <th className="py-1 pr-2">Supplier Article</th>
                              <th className="py-1 pr-2">Description</th>
                              <th className="py-1 pr-2">Currency</th>
                              <th className="py-1 pr-2">Purchase price</th>
                              <th className="py-1 pr-2">Lead time (days)</th>
                              <th className="py-1 pr-2">MOQ</th>
                              <th className="py-1 pr-2">Country</th>
                              <th className="py-1 pr-2">Preferred</th>
                            </tr>
                          </thead>
                          <tbody>
                            {r.suppliers.map((s) => (
                              <tr
                                key={`${s.supplierName}-${s.supplierArticleNo}`}
                                className="border-b last:border-b-0"
                              >
                                <td className="py-1 pr-2">
                                  {s.supplierName}
                                </td>
                                <td className="py-1 pr-2">
                                  {s.supplierArticleNo || "-"}
                                </td>
                                <td className="py-1 pr-2">
                                  {s.supplierDescription || "-"}
                                </td>
                                <td className="py-1 pr-2">
                                  {s.currency || "-"}
                                </td>
                                <td className="py-1 pr-2">
                                  {s.purchasePrice ?? ""}
                                </td>
                                <td className="py-1 pr-2">
                                  {s.leadTimeDays ?? ""}
                                </td>
                                <td className="py-1 pr-2">{s.moq ?? ""}</td>
                                <td className="py-1 pr-2">
                                  {s.supplierCountry || "-"}
                                </td>
                                <td className="py-1 pr-2">
                                  {s.preferred ? "Yes" : ""}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

