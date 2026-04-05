import { useState } from "react";
import {
  CONFIGURATIONS,
  CYLINDER_COUNTS,
  ENGINE_MODELS,
} from "../../lib/masterValuesClient.js";
import { resolveMaterialLookup } from "../../lib/materialApi.js";
import { Field, ErrorBanner } from "../../components/master/MasterUi.jsx";

export default function ResolveMaterial() {
  const [form, setForm] = useState({
    spn: "",
    brand: "",
    engineModel: "",
    configuration: "",
    cylinderCount: "",
    esn: "",
  });
  const [items, setItems] = useState([]);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);

  async function run(e) {
    e.preventDefault();
    setErr("");
    setLoading(true);
    setItems([]);
    setSearched(false);
    try {
      const body = {
        spn: form.spn.trim(),
        brand: form.brand.trim(),
        engineModel: form.engineModel.trim(),
        configuration: form.configuration.trim(),
        cylinderCount: form.cylinderCount.trim(),
        esn:
          form.esn === "" || form.esn == null
            ? undefined
            : Number(form.esn),
      };
      const res = await resolveMaterialLookup(body);
      setItems(Array.isArray(res.items) ? res.items : []);
    } catch (e2) {
      setErr(e2.message || "Resolve failed");
    } finally {
      setLoading(false);
      setSearched(true);
    }
  }

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border bg-white p-6">
        <h1 className="text-xl font-semibold">Resolve material</h1>
        <p className="mt-1 text-gray-600">
          Enter SPN plus brand and engine application; returns matching materials with articles and supplier offers.
        </p>
        <ErrorBanner message={err} />
      </div>

      <div className="rounded-2xl border bg-white p-6">
        <form onSubmit={run} className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
          <Field label="SPN *">
            <input
              required
              value={form.spn}
              onChange={(e) => setForm((f) => ({ ...f, spn: e.target.value }))}
              className="w-full rounded-xl border px-3 py-2 text-sm font-mono"
            />
          </Field>
          <Field label="Brand *">
            <input
              required
              value={form.brand}
              onChange={(e) => setForm((f) => ({ ...f, brand: e.target.value }))}
              className="w-full rounded-xl border px-3 py-2 text-sm"
              placeholder="Must exist under material vertical"
            />
          </Field>
          <Field label="Engine model *">
            <input
              required
              list="res-dl-eng"
              value={form.engineModel}
              onChange={(e) =>
                setForm((f) => ({ ...f, engineModel: e.target.value }))
              }
              className="w-full rounded-xl border px-3 py-2 text-sm"
            />
            <datalist id="res-dl-eng">
              {ENGINE_MODELS.map((x) => (
                <option key={x} value={x} />
              ))}
            </datalist>
          </Field>
          <Field label="Configuration *">
            <input
              required
              list="res-dl-cfg"
              value={form.configuration}
              onChange={(e) =>
                setForm((f) => ({ ...f, configuration: e.target.value }))
              }
              className="w-full rounded-xl border px-3 py-2 text-sm"
            />
            <datalist id="res-dl-cfg">
              {CONFIGURATIONS.map((x) => (
                <option key={x} value={x} />
              ))}
            </datalist>
          </Field>
          <Field label="Cylinder count *">
            <input
              required
              list="res-dl-cyl"
              value={form.cylinderCount}
              onChange={(e) =>
                setForm((f) => ({ ...f, cylinderCount: e.target.value }))
              }
              className="w-full rounded-xl border px-3 py-2 text-sm"
            />
            <datalist id="res-dl-cyl">
              {CYLINDER_COUNTS.map((x) => (
                <option key={x} value={x} />
              ))}
            </datalist>
          </Field>
          <Field label="ESN (optional)">
            <input
              type="number"
              value={form.esn}
              onChange={(e) => setForm((f) => ({ ...f, esn: e.target.value }))}
              className="w-full rounded-xl border px-3 py-2 text-sm"
            />
          </Field>
          <div className="flex items-end md:col-span-2 lg:col-span-3">
            <button
              type="submit"
              disabled={loading}
              className="rounded-xl bg-gray-900 px-6 py-2 text-sm text-white disabled:opacity-50"
            >
              {loading ? "Searching…" : "Resolve"}
            </button>
          </div>
        </form>
      </div>

      {items.length > 0 && (
        <div className="space-y-4">
          {items.map((m) => (
            <div
              key={m.materialCode}
              className="rounded-2xl border bg-white p-6 shadow-sm"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2 border-b pb-3">
                <div>
                  <span className="font-mono text-lg font-semibold">
                    {m.materialCode}
                  </span>
                  <span className="ml-2 text-sm text-gray-500">SPN {m.spn}</span>
                </div>
                <span className="text-sm text-gray-600">{m.status}</span>
              </div>
              <p className="mt-2 text-sm text-gray-800">{m.shortDescription}</p>
              <p className="text-xs text-gray-500">
                {m.itemType} · {m.unit}
              </p>

              <div className="mt-4 grid gap-4 lg:grid-cols-2">
                <div>
                  <h3 className="text-sm font-semibold text-gray-700">Articles</h3>
                  <ul className="mt-2 space-y-2 text-sm">
                    {(m.articles || []).length === 0 && (
                      <li className="text-gray-500">None</li>
                    )}
                    {(m.articles || []).map((a) => (
                      <li
                        key={a.articleNo}
                        className="rounded-lg border border-gray-100 bg-gray-50 px-3 py-2"
                      >
                        <span className="font-mono text-xs">{a.articleNo}</span>
                        <div className="text-gray-800">{a.description}</div>
                      </li>
                    ))}
                  </ul>
                </div>
                <div>
                  <h3 className="text-sm font-semibold text-gray-700">Suppliers</h3>
                  <ul className="mt-2 space-y-2 text-sm">
                    {(m.suppliers || []).length === 0 && (
                      <li className="text-gray-500">None</li>
                    )}
                    {(m.suppliers || []).map((s, i) => (
                      <li
                        key={`${s.supplierName}-${i}`}
                        className="rounded-lg border border-gray-100 bg-gray-50 px-3 py-2"
                      >
                        <div className="font-medium">{s.supplierName}</div>
                        <div className="text-xs text-gray-600">
                          {s.currency} {s.price ?? s.purchasePrice ?? "—"}
                          {s.preferred ? " · preferred" : ""}
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {searched && !loading && items.length === 0 && !err && (
        <p className="text-center text-sm text-gray-500">
          No matching materials for this combination.
        </p>
      )}
    </div>
  );
}
