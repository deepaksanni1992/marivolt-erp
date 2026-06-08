import { useRef, useState, useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, FileUp, Pencil, Plus, Search, Trash2 } from "lucide-react";
import { apiDelete, apiGet, apiGetWithQuery, apiPost, apiPostFormData, apiPut } from "../lib/api.js";
import { downloadCsv, downloadPdfTable } from "../lib/purchaseExport.js";

const emptyItem = {
  article: "",
  itemName: "",
  description: "",
  vertical: "",
  engine: "",
  model: "",
  config: "",
  uom: "PCS",
  status: "Active",
};

const emptyTechnical = {
  spn: "",
  esn: "",
  materialCode: "",
  drawingNumber: "",
  dimension: "",
  oeMarkings: "",
  extRemarks: "",
  internalRemarks: "",
  modelMappingsText: "",
  configurationMappingsText: "",
  oemCrossReferencesText: "",
  supplierReferencesText: "",
  technicalSpecificationsText: "",
  interchangeablePartsText: "",
};

const emptySupplier = {
  supplierName: "",
  supplierPartNumber: "",
  currency: "USD",
  price: 0,
  leadTime: "",
  remarks: "",
};

const EXPORT_COLUMNS = [
  { key: "Article", header: "Article" },
  { key: "ITEM NAME", header: "ITEM NAME" },
  { key: "Description", header: "Description" },
  { key: "Vertical", header: "Vertical" },
  { key: "Brand", header: "Brand" },
  { key: "Model", header: "Model" },
  { key: "Config", header: "Config" },
  { key: "SPN", header: "SPN" },
  { key: "ESN", header: "ESN" },
  { key: "Material Code", header: "Material Code" },
  { key: "Drawing Number", header: "Drawing Number" },
  { key: "Dimension", header: "Dimension" },
  { key: "OE Markings", header: "OE Markings" },
  { key: "Model Mappings", header: "Model Mappings" },
  { key: "Configuration Mappings", header: "Configuration Mappings" },
  { key: "OEM Cross References", header: "OEM Cross References" },
  { key: "Interchangeable Parts", header: "Interchangeable Parts" },
  { key: "Suppliers", header: "Suppliers" },
  { key: "Status", header: "Status" },
];

function parseTextRows(value, keys) {
  return String(value || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split("|").map((x) => x.trim());
      const out = {};
      keys.forEach((key, i) => {
        out[key] = parts[i] || "";
      });
      return out;
    });
}

function formatTextRows(rows, keys) {
  if (!Array.isArray(rows) || !rows.length) return "";
  return rows
    .map((row) => keys.map((k) => String(row?.[k] ?? "").trim()).join(" | ").replace(/\s+\|\s+$/, ""))
    .join("\n");
}

function technicalToPayload(technical) {
  return {
    spn: technical.spn,
    esn: technical.esn,
    materialCode: technical.materialCode,
    drawingNumber: technical.drawingNumber,
    dimension: technical.dimension,
    oeMarkings: technical.oeMarkings,
    extRemarks: technical.extRemarks,
    internalRemarks: technical.internalRemarks,
    modelMappings: parseTextRows(technical.modelMappingsText, ["modelCode", "modelName", "variant", "notes"]),
    configurationMappings: parseTextRows(technical.configurationMappingsText, [
      "configurationCode",
      "configurationName",
      "applicability",
      "notes",
    ]),
    oemCrossReferences: parseTextRows(technical.oemCrossReferencesText, [
      "oemName",
      "oemPartNumber",
      "oemDescription",
      "notes",
    ]),
    supplierReferences: parseTextRows(technical.supplierReferencesText, [
      "supplierName",
      "supplierPartNumber",
      "preferred",
      "notes",
    ]).map((row) => ({ ...row, preferred: String(row.preferred).toLowerCase() === "true" })),
    technicalSpecifications: parseTextRows(technical.technicalSpecificationsText, [
      "specName",
      "specValue",
      "specUnit",
      "notes",
    ]),
    interchangeableParts: parseTextRows(technical.interchangeablePartsText, [
      "article",
      "partNumber",
      "description",
      "interchangeType",
      "replacementPriority",
      "replacementNotes",
      "notes",
    ]).map((row) => ({ ...row, replacementPriority: Number(row.replacementPriority) || 0 })),
  };
}

function StatusBadge({ status }) {
  const active = status === "Active";
  return (
    <span className={active ? "rounded-full bg-emerald-100 px-2 py-0.5 text-xs text-emerald-800" : "rounded-full bg-rose-100 px-2 py-0.5 text-xs text-rose-800"}>
      {status}
    </span>
  );
}

function Field({ label, children }) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="text-slate-600">{label}</span>
      {children}
    </label>
  );
}

export default function ItemMaster() {
  const qc = useQueryClient();
  const importRef = useRef(null);
  const lookupImportRef = useRef(null);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [searchParams] = useSearchParams();

  useEffect(() => {
    const q = searchParams.get("q") || searchParams.get("search");
    const article = searchParams.get("articleNumber");
    if (q) setSearch(q);
    else if (article) setSearch(article);
  }, [searchParams]);

  const [vertical, setVertical] = useState("");
  const [engine, setEngine] = useState("");
  const [engineModel, setEngineModel] = useState("");
  const [configuration, setConfiguration] = useState("");
  const [esn, setEsn] = useState("");
  const [spnFilter, setSpnFilter] = useState("");
  const [cylinderCount, setCylinderCount] = useState("");
  const [oemReference, setOemReference] = useState("");
  const [supplierReference, setSupplierReference] = useState("");
  const [materialCodeFilter, setMaterialCodeFilter] = useState("");
  const [drawingNumberFilter, setDrawingNumberFilter] = useState("");
  const [advancedSearchOpen, setAdvancedSearchOpen] = useState(false);
  const [compatibilityArticle, setCompatibilityArticle] = useState("");
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [tab, setTab] = useState("basic");
  const [selectedArticle, setSelectedArticle] = useState("");
  const [error, setError] = useState("");
  const [lookupRows, setLookupRows] = useState([]);
  const [item, setItem] = useState(emptyItem);
  const [technical, setTechnical] = useState(emptyTechnical);
  const [supplierDraft, setSupplierDraft] = useState(emptySupplier);
  const [editingSupplierId, setEditingSupplierId] = useState("");

  const { data: listData, isLoading } = useQuery({
    queryKey: [
      "items",
      page,
      search,
      vertical,
      engine,
      engineModel,
      configuration,
      esn,
      spnFilter,
      cylinderCount,
      oemReference,
      supplierReference,
      materialCodeFilter,
      drawingNumberFilter,
    ],
    queryFn: () =>
      apiGetWithQuery("/items", {
        page,
        limit: 25,
        search: search || undefined,
        vertical: vertical || undefined,
        engineBrand: engine || undefined,
        engineModel: engineModel || undefined,
        configuration: configuration || undefined,
        esn: esn || undefined,
        spn: spnFilter || undefined,
        cylinderCount: cylinderCount || undefined,
        oemReference: oemReference || undefined,
        supplierReference: supplierReference || undefined,
        materialCode: materialCodeFilter || undefined,
        drawingNumber: drawingNumberFilter || undefined,
      }),
  });

  const { data: facets } = useQuery({
    queryKey: ["item-facets"],
    queryFn: () => apiGet("/items/facets"),
  });

  const { data: details } = useQuery({
    queryKey: ["item-details", selectedArticle],
    enabled: Boolean(selectedArticle),
    queryFn: () => apiGet(`/items/${encodeURIComponent(selectedArticle)}`),
  });

  const { data: compatibilityData } = useQuery({
    queryKey: ["item-compatibility", compatibilityArticle],
    enabled: Boolean(compatibilityArticle),
    queryFn: () => apiGet(`/items/${encodeURIComponent(compatibilityArticle)}/compatibility`),
  });

  const saveItem = useMutation({
    mutationFn: () => (selectedArticle ? apiPut(`/items/${selectedArticle}`, item) : apiPost("/items", item)),
    onSuccess: async (row) => {
      const article = row.article || item.article;
      setSelectedArticle(article);
      await qc.invalidateQueries({ queryKey: ["items"] });
      await qc.invalidateQueries({ queryKey: ["item-details", article] });
      setTab("technical");
      setError("");
    },
    onError: (e) => setError(e.message),
  });

  const saveTechnical = useMutation({
    mutationFn: () => apiPut(`/items/${selectedArticle}/technical`, technicalToPayload(technical)),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["item-details", selectedArticle] });
      setError("");
    },
    onError: (e) => setError(e.message),
  });

  const saveSupplier = useMutation({
    mutationFn: () =>
      editingSupplierId
        ? apiPut(`/items/${selectedArticle}/suppliers/${editingSupplierId}`, supplierDraft)
        : apiPost(`/items/${selectedArticle}/suppliers`, supplierDraft),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["item-details", selectedArticle] });
      setSupplierDraft(emptySupplier);
      setEditingSupplierId("");
      setError("");
    },
    onError: (e) => setError(e.message),
  });

  const removeSupplier = useMutation({
    mutationFn: (id) => apiDelete(`/items/${selectedArticle}/suppliers/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["item-details", selectedArticle] }),
  });

  const removeItem = useMutation({
    mutationFn: (article) => apiDelete(`/items/${article}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["items"] }),
  });

  const bulkLookupImport = useMutation({
    mutationFn: (file) => {
      const fd = new FormData();
      fd.append("file", file);
      return apiPostFormData("/items/resolve/bulk-import", fd);
    },
    onSuccess: (data) => {
      setLookupRows(data?.items || []);
      setError("");
    },
    onError: (e) => setError(e.message),
  });

  const manualOverride = useMutation({
    mutationFn: ({ selectedArticle, row }) =>
      apiPost("/items/resolve/override", {
        source: "MANUAL_REVIEW",
        selectedArticle,
        input: row?.input || {},
        alternatives: row?.alternatives || [],
      }),
    onSuccess: (_, vars) => {
      setLookupRows((prev) =>
        prev.map((r) =>
          r.row === vars.row.row
            ? {
                ...r,
                matchedArticle: vars.selectedArticle,
                confidence: "MANUAL_OVERRIDE",
                reason: `Manual override selected ${vars.selectedArticle}`,
              }
            : r
        )
      );
    },
    onError: (e) => setError(e.message),
  });

  const importMutation = useMutation({
    mutationFn: (file) => {
      const fd = new FormData();
      fd.append("file", file);
      return apiPostFormData("/items/import", fd);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["items"] }),
    onError: (e) => setError(e.message),
  });

  const list = listData?.items || [];
  const total = listData?.total || 0;
  const pages = Math.max(1, Math.ceil(total / 25));
  const suppliers = details?.suppliers || [];

  function openCreate() {
    setSelectedArticle("");
    setItem(emptyItem);
    setTechnical(emptyTechnical);
    setSupplierDraft(emptySupplier);
    setEditingSupplierId("");
    setTab("basic");
    setDrawerOpen(true);
    setError("");
  }

  async function openEdit(row) {
    setSelectedArticle(row.article);
    setItem({
      article: row.article,
      itemName: row.itemName || "",
      description: row.description || "",
      vertical: row.vertical || "",
      engine: row.engine || "",
      model: row.model || "",
      config: row.config || "",
      uom: row.uom || "PCS",
      status: row.status || "Active",
    });
    const full = await apiGet(`/items/${encodeURIComponent(row.article)}`);
    const t = full.technical || {};
    setTechnical({
      ...emptyTechnical,
      ...t,
      modelMappingsText: formatTextRows(t.modelMappings, ["modelCode", "modelName", "variant", "notes"]),
      configurationMappingsText: formatTextRows(t.configurationMappings, [
        "configurationCode",
        "configurationName",
        "applicability",
        "notes",
      ]),
      oemCrossReferencesText: formatTextRows(t.oemCrossReferences, [
        "oemName",
        "oemPartNumber",
        "oemDescription",
        "notes",
      ]),
      supplierReferencesText: formatTextRows(
        (t.supplierReferences || []).map((row) => ({ ...row, preferred: row.preferred ? "true" : "false" })),
        ["supplierName", "supplierPartNumber", "preferred", "notes"]
      ),
      technicalSpecificationsText: formatTextRows(t.technicalSpecifications, [
        "specName",
        "specValue",
        "specUnit",
        "notes",
      ]),
      interchangeablePartsText: formatTextRows(t.interchangeableParts, [
        "article",
        "partNumber",
        "description",
        "interchangeType",
        "replacementPriority",
        "replacementNotes",
        "notes",
      ]),
    });
    setDrawerOpen(true);
    setTab("basic");
    setError("");
  }

  async function runExport(kind) {
    const data = await apiGet("/items/export");
    const rows = data.items || [];
    if (kind === "csv") {
      downloadCsv("item-master-export.csv", EXPORT_COLUMNS, rows);
      return;
    }
    downloadPdfTable("Item Master Export", "", EXPORT_COLUMNS, rows, "item-master-export");
  }

  function exportLookupResults(kind) {
    const rows = lookupRows.map((r) => ({
      Row: r.row,
      ESN: r.input?.ESN || r.input?.esn || "",
      SPN: r.input?.SPN || r.input?.spn || "",
      "Material Code": r.input?.["Material Code"] || r.input?.materialCode || "",
      "Drawing No": r.input?.["Drawing Number"] || r.input?.drawingNumber || "",
      "OEM Ref": r.input?.["OEM Ref"] || r.input?.oemReference || "",
      "Matched Article": r.matchedArticle || "",
      Confidence: r.confidence || "",
      Reason: r.reason || "",
      "Possible Duplicate Mapping": r.duplicateWarning ? "YES" : "NO",
      Alternatives: (r.alternatives || []).map((a) => `${a.article}:${a.confidence}`).join("; "),
    }));
    const columns = Object.keys(rows[0] || {}).map((k) => ({ key: k, header: k }));
    if (kind === "csv") {
      downloadCsv("technical-lookup-resolution.csv", columns, rows);
      return;
    }
    downloadPdfTable("Technical Lookup Resolution Results", "", columns, rows, "technical-lookup-resolution");
  }

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border bg-white p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold">Item Master</h1>
            <p className="text-sm text-slate-600">Marine spare parts ERP item registry</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <input ref={importRef} type="file" className="hidden" accept=".csv,.xlsx,.xls" onChange={(e) => e.target.files?.[0] && importMutation.mutate(e.target.files[0])} />
            <button onClick={() => importRef.current?.click()} className="inline-flex items-center gap-2 rounded-xl border px-3 py-2 text-sm"><FileUp size={16} />Import</button>
            <button onClick={() => runExport("csv")} className="inline-flex items-center gap-2 rounded-xl border px-3 py-2 text-sm"><Download size={16} />Export CSV</button>
            <button onClick={() => runExport("pdf")} className="inline-flex items-center gap-2 rounded-xl border px-3 py-2 text-sm"><Download size={16} />Export PDF</button>
            <button onClick={openCreate} className="inline-flex items-center gap-2 rounded-xl bg-slate-900 px-3 py-2 text-sm text-white"><Plus size={16} />New Item</button>
          </div>
        </div>
      </div>

      <div className="rounded-2xl border bg-white p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-lg font-semibold">Technical Lookup Import</h2>
            <p className="text-sm text-slate-600">Upload ESN/SPN/material/drawing/OEM sheet to resolve matched articles automatically.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <input
              ref={lookupImportRef}
              type="file"
              className="hidden"
              accept=".csv,.xlsx,.xls"
              onChange={(e) => e.target.files?.[0] && bulkLookupImport.mutate(e.target.files[0])}
            />
            <button onClick={() => lookupImportRef.current?.click()} className="inline-flex items-center gap-2 rounded-xl border px-3 py-2 text-sm">
              <FileUp size={16} />Upload Lookup File
            </button>
            <button disabled={!lookupRows.length} onClick={() => exportLookupResults("csv")} className="inline-flex items-center gap-2 rounded-xl border px-3 py-2 text-sm disabled:opacity-50">
              <Download size={16} />Export CSV
            </button>
            <button disabled={!lookupRows.length} onClick={() => exportLookupResults("pdf")} className="inline-flex items-center gap-2 rounded-xl border px-3 py-2 text-sm disabled:opacity-50">
              <Download size={16} />Export PDF
            </button>
          </div>
        </div>
        <div className="overflow-auto rounded-xl border">
          <table className="min-w-[1300px] w-full text-sm">
            <thead className="bg-slate-100">
              <tr>
                {["Row", "ESN", "SPN", "Material", "Drawing", "OEM Ref", "Matched Article", "Confidence", "Reason", "Alternatives", "Actions"].map((h) => (
                  <th key={h} className="px-2 py-2 text-left text-xs font-semibold uppercase tracking-wide text-slate-600">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {lookupRows.length === 0 ? (
                <tr><td colSpan={11} className="px-2 py-6 text-center text-sm text-slate-500">No lookup results yet.</td></tr>
              ) : (
                lookupRows.map((r) => {
                  const tone =
                    r.confidence === "HIGH"
                      ? "bg-emerald-50"
                      : r.confidence === "MEDIUM"
                        ? "bg-amber-50"
                        : r.confidence === "LOW"
                          ? "bg-rose-50"
                          : "";
                  return (
                    <tr key={r.row} className={`border-t ${tone}`}>
                      <td className="px-2 py-1">{r.row}</td>
                      <td className="px-2 py-1">{r.input?.ESN || r.input?.esn || "-"}</td>
                      <td className="px-2 py-1">{r.input?.SPN || r.input?.spn || "-"}</td>
                      <td className="px-2 py-1">{r.input?.["Material Code"] || r.input?.materialCode || "-"}</td>
                      <td className="px-2 py-1">{r.input?.["Drawing Number"] || r.input?.drawingNumber || "-"}</td>
                      <td className="px-2 py-1">{r.input?.["OEM Ref"] || r.input?.oemReference || "-"}</td>
                      <td className="px-2 py-1 font-mono">{r.matchedArticle || "—"}</td>
                      <td className="px-2 py-1">
                        <span className={`rounded-full px-2 py-0.5 text-xs ${
                          r.confidence === "HIGH"
                            ? "bg-emerald-100 text-emerald-800"
                            : r.confidence === "MEDIUM"
                              ? "bg-amber-100 text-amber-800"
                              : r.confidence === "LOW"
                                ? "bg-rose-100 text-rose-800"
                                : "bg-slate-100 text-slate-800"
                        }`}>
                          {r.confidence}
                        </span>
                      </td>
                      <td className="px-2 py-1 text-xs">
                        {r.reason || "-"}
                        {r.duplicateWarning ? (
                          <div className="mt-1 rounded bg-rose-100 px-2 py-0.5 text-[10px] text-rose-800">Possible duplicate mapping</div>
                        ) : null}
                      </td>
                      <td className="px-2 py-1 text-xs">
                        {(r.alternatives || []).slice(0, 3).map((a) => (
                          <div key={`${r.row}-${a.article}`} className="mb-1 rounded border px-1 py-0.5">
                            {a.article} ({a.confidence})
                          </div>
                        ))}
                      </td>
                      <td className="px-2 py-1">
                        {(r.alternatives || []).slice(0, 2).map((a) => (
                          <button
                            key={`${r.row}-${a.article}-act`}
                            type="button"
                            className="mb-1 mr-1 rounded border px-2 py-1 text-[10px]"
                            onClick={() => manualOverride.mutate({ selectedArticle: a.article, row: r })}
                          >
                            Accept {a.article}
                          </button>
                        ))}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="rounded-2xl border bg-white p-4">
        <div className="grid gap-3 md:grid-cols-5">
          <Field label="Vertical">
            <select className="rounded-lg border px-3 py-2" value={vertical} onChange={(e) => setVertical(e.target.value)}>
              <option value="">All</option>
              {(facets?.verticals || []).map((v) => <option key={v} value={v}>{v}</option>)}
            </select>
          </Field>
          <Field label="Brand">
            <select className="rounded-lg border px-3 py-2" value={engine} onChange={(e) => setEngine(e.target.value)}>
              <option value="">All</option>
              {(facets?.engines || []).map((v) => <option key={v} value={v}>{v}</option>)}
            </select>
          </Field>
          <Field label="Global Search">
            <div className="flex items-center rounded-lg border px-3">
              <Search size={16} className="text-slate-400" />
              <input className="w-full px-2 py-2 outline-none" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Article, SPN, Material, Supplier..." />
            </div>
          </Field>
          <Field label="ESN">
            <input className="rounded-lg border px-3 py-2" value={esn} onChange={(e) => setEsn(e.target.value)} placeholder="Filter by ESN" />
          </Field>
          <div className="flex items-end">
            <div className="flex gap-2">
              <button onClick={() => setAdvancedSearchOpen((v) => !v)} className="rounded-xl border px-4 py-2 text-sm">
                Advanced Filters
              </button>
              <button onClick={() => { setPage(1); qc.invalidateQueries({ queryKey: ["items"] }); }} className="rounded-xl bg-slate-900 px-4 py-2 text-sm text-white">Apply</button>
            </div>
          </div>
        </div>
        {advancedSearchOpen ? (
          <div className="mt-3 grid gap-3 rounded-xl border bg-slate-50 p-3 md:grid-cols-5">
            <Field label="SPN"><input className="rounded-lg border px-3 py-2" value={spnFilter} onChange={(e) => setSpnFilter(e.target.value)} /></Field>
            <Field label="Engine Model"><input className="rounded-lg border px-3 py-2" value={engineModel} onChange={(e) => setEngineModel(e.target.value)} /></Field>
            <Field label="Configuration"><input className="rounded-lg border px-3 py-2" value={configuration} onChange={(e) => setConfiguration(e.target.value)} /></Field>
            <Field label="Cylinder Count"><input className="rounded-lg border px-3 py-2" type="number" value={cylinderCount} onChange={(e) => setCylinderCount(e.target.value)} /></Field>
            <Field label="OEM Reference"><input className="rounded-lg border px-3 py-2" value={oemReference} onChange={(e) => setOemReference(e.target.value)} /></Field>
            <Field label="Supplier Reference"><input className="rounded-lg border px-3 py-2" value={supplierReference} onChange={(e) => setSupplierReference(e.target.value)} /></Field>
            <Field label="Material Code"><input className="rounded-lg border px-3 py-2" value={materialCodeFilter} onChange={(e) => setMaterialCodeFilter(e.target.value)} /></Field>
            <Field label="Drawing Number"><input className="rounded-lg border px-3 py-2" value={drawingNumberFilter} onChange={(e) => setDrawingNumberFilter(e.target.value)} /></Field>
          </div>
        ) : null}
      </div>

      {error ? <div className="rounded-xl border border-rose-300 bg-rose-50 p-3 text-sm text-rose-700">{error}</div> : null}

      <div className="overflow-hidden rounded-2xl border bg-white">
        <div className="max-h-[62vh] overflow-auto">
          <table className="min-w-[2800px] w-full text-sm">
            <thead className="sticky top-0 bg-slate-100">
              <tr className="text-left">
                <th className="px-3 py-3">Vertical</th>
                <th className="px-3 py-3">Brand</th>
                <th className="px-3 py-3">Model</th>
                <th className="px-3 py-3">Config</th>
                <th className="px-3 py-3">Article</th>
                <th className="px-3 py-3">Description</th>
                <th className="px-3 py-3">ITEM NAME</th>
                <th className="px-3 py-3">SPN</th>
                <th className="px-3 py-3">ESN</th>
                <th className="px-3 py-3">Material Code</th>
                <th className="px-3 py-3">Drawing Number</th>
                <th className="px-3 py-3">QTY</th>
                <th className="px-3 py-3">Ext Remarks</th>
                <th className="px-3 py-3">Internal Remarks</th>
                <th className="px-3 py-3">OE Markings</th>
                <th className="px-3 py-3">Dimension</th>
                <th className="px-3 py-3">Model Maps</th>
                <th className="px-3 py-3">Config Maps</th>
                <th className="px-3 py-3">OEM XRef</th>
                <th className="px-3 py-3">Interchange</th>
                <th className="px-3 py-3">Supplier 1</th>
                <th className="px-3 py-3">Supplier 1 P/N</th>
                <th className="px-3 py-3">Supplier 2</th>
                <th className="px-3 py-3">Supplier 2 P/N</th>
                <th className="px-3 py-3">Status</th>
                <th className="px-3 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? <tr><td className="px-3 py-8" colSpan={26}>Loading...</td></tr> : list.map((row) => (
                <tr key={row._id} className="border-t">
                  <td className="px-3 py-2">{row.vertical || "-"}</td>
                  <td className="px-3 py-2">{row.engine || "-"}</td>
                  <td className="px-3 py-2">{row.model || "-"}</td>
                  <td className="px-3 py-2">{row.config || "-"}</td>
                  <td className="px-3 py-2 font-mono">{row.article}</td>
                  <td className="px-3 py-2">{row.description || "-"}</td>
                  <td className="px-3 py-2">{row.itemName || "-"}</td>
                  <td className="px-3 py-2">{row.spn || "-"}</td>
                  <td className="px-3 py-2">{row.esn || "-"}</td>
                  <td className="px-3 py-2">{row.materialCode || "-"}</td>
                  <td className="px-3 py-2">{row.drawingNumber || "-"}</td>
                  <td className="px-3 py-2">{Number(row.qty || 0)}</td>
                  <td className="px-3 py-2">{row.extRemarks || "-"}</td>
                  <td className="px-3 py-2">{row.internalRemarks || "-"}</td>
                  <td className="px-3 py-2">{row.oeMarkings || "-"}</td>
                  <td className="px-3 py-2">{row.dimension || "-"}</td>
                  <td className="px-3 py-2">{Number(row.modelMapCount || 0)}</td>
                  <td className="px-3 py-2">{Number(row.configMapCount || 0)}</td>
                  <td className="px-3 py-2">{Number(row.oemRefCount || 0)}</td>
                  <td className="px-3 py-2">{Number(row.interchangeCount || 0)}</td>
                  <td className="px-3 py-2">{row.supplier1 || "-"}</td>
                  <td className="px-3 py-2">{row.supplier1PartNumber || "-"}</td>
                  <td className="px-3 py-2">{row.supplier2 || "-"}</td>
                  <td className="px-3 py-2">{row.supplier2PartNumber || "-"}</td>
                  <td className="px-3 py-2"><StatusBadge status={row.status} /></td>
                  <td className="px-3 py-2">
                    <div className="flex justify-end gap-2">
                      <button onClick={() => setCompatibilityArticle(row.article)} className="inline-flex items-center gap-1 rounded-lg border px-2 py-1 text-xs">Compatibility</button>
                      <button onClick={() => openEdit(row)} className="inline-flex items-center gap-1 rounded-lg border px-2 py-1 text-xs"><Pencil size={14} />View / Edit</button>
                      <button onClick={() => window.confirm(`Delete ${row.article}?`) && removeItem.mutate(row.article)} className="inline-flex items-center gap-1 rounded-lg border border-rose-200 px-2 py-1 text-xs text-rose-700"><Trash2 size={14} />Delete</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="flex items-center justify-between border-t px-4 py-3 text-sm">
          <span>Page {page} / {pages} ({total} items)</span>
          <div className="flex gap-2">
            <button disabled={page <= 1} onClick={() => setPage((p) => p - 1)} className="rounded border px-2 py-1 disabled:opacity-50">Prev</button>
            <button disabled={page >= pages} onClick={() => setPage((p) => p + 1)} className="rounded border px-2 py-1 disabled:opacity-50">Next</button>
          </div>
        </div>
      </div>

      {compatibilityArticle ? (
        <div className="fixed inset-0 z-40 bg-black/30">
          <div className="absolute left-1/2 top-10 w-[95vw] max-w-4xl -translate-x-1/2 rounded-2xl bg-white p-4 shadow-xl">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-lg font-semibold">Compatibility — {compatibilityArticle}</h3>
              <button onClick={() => setCompatibilityArticle("")} className="rounded border px-3 py-1 text-sm">Close</button>
            </div>
            <div className="grid gap-3 md:grid-cols-2 text-sm">
              <div className="rounded-xl border p-3">
                <div className="mb-2 font-semibold">Engine Models</div>
                {(compatibilityData?.compatibleEngineModels || []).map((x, i) => (
                  <div key={`${x.modelCode}-${i}`} className="border-b py-1">{x.modelCode} {x.modelName ? `- ${x.modelName}` : ""} {x.variant ? `(${x.variant})` : ""}</div>
                ))}
              </div>
              <div className="rounded-xl border p-3">
                <div className="mb-2 font-semibold">Configurations</div>
                {(compatibilityData?.compatibleConfigs || []).map((x, i) => (
                  <div key={`${x.configurationCode}-${i}`} className="border-b py-1">{x.configurationCode} {x.configurationName ? `- ${x.configurationName}` : ""}</div>
                ))}
              </div>
              <div className="rounded-xl border p-3">
                <div className="mb-2 font-semibold">ESNs</div>
                {(compatibilityData?.esns || []).map((x, i) => <div key={`${x}-${i}`} className="border-b py-1">{x}</div>)}
              </div>
              <div className="rounded-xl border p-3">
                <div className="mb-2 font-semibold">OEM References</div>
                {(compatibilityData?.oemRefs || []).map((x, i) => <div key={`${x.oemPartNumber}-${i}`} className="border-b py-1">{x.oemName ? `${x.oemName}: ` : ""}{x.oemPartNumber}</div>)}
              </div>
              <div className="rounded-xl border p-3">
                <div className="mb-2 font-semibold">Supplier References</div>
                {(compatibilityData?.supplierRefs || []).map((x, i) => <div key={`${x.supplierName}-${x.supplierPartNumber}-${i}`} className="border-b py-1">{x.supplierName}: {x.supplierPartNumber}</div>)}
              </div>
              <div className="rounded-xl border p-3">
                <div className="mb-2 font-semibold">Interchangeable Parts</div>
                {(compatibilityData?.interchangeableParts || []).map((x, i) => (
                  <div key={`${x.article}-${x.partNumber}-${i}`} className="border-b py-1">
                    {x.article || x.partNumber} - {x.interchangeType} (Priority {Number(x.replacementPriority || 0)})
                    {x.replacementNotes ? ` | ${x.replacementNotes}` : ""}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {drawerOpen ? (
        <div className="fixed inset-0 z-40 bg-black/30">
          <div className="absolute right-0 top-0 h-full w-full max-w-5xl overflow-auto bg-white p-5 shadow-xl">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-xl font-semibold">{selectedArticle ? `Edit ${selectedArticle}` : "Create Item"}</h2>
              <button onClick={() => setDrawerOpen(false)} className="rounded border px-3 py-1">Close</button>
            </div>
            <div className="mb-4 flex gap-2 border-b pb-3">
              {["basic", "technical", "suppliers"].map((id) => (
                <button key={id} onClick={() => setTab(id)} className={tab === id ? "rounded-lg bg-slate-900 px-3 py-1 text-sm text-white" : "rounded-lg border px-3 py-1 text-sm"}>{id === "basic" ? "Basic Info" : id === "technical" ? "Technical Details" : "Suppliers"}</button>
              ))}
            </div>

            {tab === "basic" ? (
              <div className="space-y-4">
                <div className="grid gap-3 md:grid-cols-2">
                  <Field label="Vertical"><input className="rounded-lg border px-3 py-2" value={item.vertical} onChange={(e) => setItem((v) => ({ ...v, vertical: e.target.value }))} /></Field>
                  <Field label="Brand"><input className="rounded-lg border px-3 py-2" value={item.engine} onChange={(e) => setItem((v) => ({ ...v, engine: e.target.value }))} /></Field>
                  <Field label="Model"><input className="rounded-lg border px-3 py-2" value={item.model} onChange={(e) => setItem((v) => ({ ...v, model: e.target.value }))} /></Field>
                  <Field label="Config"><input className="rounded-lg border px-3 py-2" value={item.config} onChange={(e) => setItem((v) => ({ ...v, config: e.target.value }))} /></Field>
                  <Field label="Article"><input disabled={Boolean(selectedArticle)} className="rounded-lg border px-3 py-2 disabled:bg-slate-100" value={item.article} onChange={(e) => setItem((v) => ({ ...v, article: e.target.value.toUpperCase() }))} /></Field>
                  <Field label="Item Name"><input className="rounded-lg border px-3 py-2" value={item.itemName} onChange={(e) => setItem((v) => ({ ...v, itemName: e.target.value }))} /></Field>
                  <Field label="Description"><input className="rounded-lg border px-3 py-2" value={item.description} onChange={(e) => setItem((v) => ({ ...v, description: e.target.value }))} /></Field>
                  <Field label="UOM"><select className="rounded-lg border px-3 py-2" value={item.uom} onChange={(e) => setItem((v) => ({ ...v, uom: e.target.value }))}><option>PCS</option><option>SET</option><option>KG</option><option>NOS</option><option>MTR</option></select></Field>
                  <Field label="Status"><select className="rounded-lg border px-3 py-2" value={item.status} onChange={(e) => setItem((v) => ({ ...v, status: e.target.value }))}><option>Active</option><option>Inactive</option></select></Field>
                </div>
                <button onClick={() => saveItem.mutate()} className="rounded-xl bg-slate-900 px-4 py-2 text-sm text-white">Save Basic Info</button>
              </div>
            ) : null}

            {tab === "technical" ? (
              <div className="space-y-4">
                <details open className="rounded-xl border p-3">
                  <summary className="cursor-pointer text-sm font-semibold">Core Technical Fields</summary>
                  <div className="mt-3 grid gap-3 md:grid-cols-2">
                    <Field label="SPN"><input className="rounded-lg border px-3 py-2" value={technical.spn} onChange={(e) => setTechnical((v) => ({ ...v, spn: e.target.value }))} /></Field>
                    <Field label="ESN"><input className="rounded-lg border px-3 py-2" value={technical.esn} onChange={(e) => setTechnical((v) => ({ ...v, esn: e.target.value }))} /></Field>
                    <Field label="Material Code"><input className="rounded-lg border px-3 py-2" value={technical.materialCode} onChange={(e) => setTechnical((v) => ({ ...v, materialCode: e.target.value }))} /></Field>
                    <Field label="Drawing Number"><input className="rounded-lg border px-3 py-2" value={technical.drawingNumber} onChange={(e) => setTechnical((v) => ({ ...v, drawingNumber: e.target.value }))} /></Field>
                    <Field label="Dimension"><input className="rounded-lg border px-3 py-2" value={technical.dimension} onChange={(e) => setTechnical((v) => ({ ...v, dimension: e.target.value }))} /></Field>
                    <Field label="Cylinder Count"><input className="rounded-lg border px-3 py-2" type="number" value={technical.cylinderCount || ""} onChange={(e) => setTechnical((v) => ({ ...v, cylinderCount: e.target.value }))} /></Field>
                    <Field label="Weight"><input className="rounded-lg border px-3 py-2" value={technical.specWeight || ""} onChange={(e) => setTechnical((v) => ({ ...v, specWeight: e.target.value }))} /></Field>
                    <Field label="Material"><input className="rounded-lg border px-3 py-2" value={technical.specMaterial || ""} onChange={(e) => setTechnical((v) => ({ ...v, specMaterial: e.target.value }))} /></Field>
                    <Field label="Tolerances"><input className="rounded-lg border px-3 py-2" value={technical.specTolerances || ""} onChange={(e) => setTechnical((v) => ({ ...v, specTolerances: e.target.value }))} /></Field>
                    <Field label="Markings"><input className="rounded-lg border px-3 py-2" value={technical.specMarkings || ""} onChange={(e) => setTechnical((v) => ({ ...v, specMarkings: e.target.value }))} /></Field>
                    <Field label="Revision No"><input className="rounded-lg border px-3 py-2" value={technical.revisionNo || ""} onChange={(e) => setTechnical((v) => ({ ...v, revisionNo: e.target.value }))} /></Field>
                    <Field label="OE Markings"><input className="rounded-lg border px-3 py-2" value={technical.oeMarkings} onChange={(e) => setTechnical((v) => ({ ...v, oeMarkings: e.target.value }))} /></Field>
                    <Field label="Ext Remarks"><input className="rounded-lg border px-3 py-2" value={technical.extRemarks} onChange={(e) => setTechnical((v) => ({ ...v, extRemarks: e.target.value }))} /></Field>
                    <Field label="Internal Remarks"><input className="rounded-lg border px-3 py-2" value={technical.internalRemarks} onChange={(e) => setTechnical((v) => ({ ...v, internalRemarks: e.target.value }))} /></Field>
                  </div>
                </details>
                <div className="rounded-xl border bg-slate-50 p-3 text-xs text-slate-600">
                  Multi-row mapping format uses one record per line, fields separated by <code>|</code>.
                </div>
                <details open className="rounded-xl border p-3">
                  <summary className="cursor-pointer text-sm font-semibold">Mappings and Interchangeability</summary>
                  <div className="mt-3 grid gap-3 md:grid-cols-2">
                  <Field label="Model Mapping (modelCode | modelName | variant | notes)">
                    <textarea className="min-h-24 rounded-lg border px-3 py-2" value={technical.modelMappingsText} onChange={(e) => setTechnical((v) => ({ ...v, modelMappingsText: e.target.value }))} />
                  </Field>
                  <Field label="Configuration Mapping (configCode | configName | applicability | notes)">
                    <textarea className="min-h-24 rounded-lg border px-3 py-2" value={technical.configurationMappingsText} onChange={(e) => setTechnical((v) => ({ ...v, configurationMappingsText: e.target.value }))} />
                  </Field>
                  <Field label="OEM Cross Reference (oemName | oemPartNo | description | notes)">
                    <textarea className="min-h-24 rounded-lg border px-3 py-2" value={technical.oemCrossReferencesText} onChange={(e) => setTechnical((v) => ({ ...v, oemCrossReferencesText: e.target.value }))} />
                  </Field>
                  <Field label="Supplier Reference (supplierName | supplierPartNo | preferred(true/false) | notes)">
                    <textarea className="min-h-24 rounded-lg border px-3 py-2" value={technical.supplierReferencesText} onChange={(e) => setTechnical((v) => ({ ...v, supplierReferencesText: e.target.value }))} />
                  </Field>
                  <Field label="Technical Specifications (specName | specValue | unit | notes)">
                    <textarea className="min-h-24 rounded-lg border px-3 py-2" value={technical.technicalSpecificationsText} onChange={(e) => setTechnical((v) => ({ ...v, technicalSpecificationsText: e.target.value }))} />
                  </Field>
                  <Field label="Interchangeable Parts (article | partNo | description | type | replacementPriority | replacementNotes | notes)">
                    <textarea className="min-h-24 rounded-lg border px-3 py-2" value={technical.interchangeablePartsText} onChange={(e) => setTechnical((v) => ({ ...v, interchangeablePartsText: e.target.value }))} />
                  </Field>
                  </div>
                </details>
                <button disabled={!selectedArticle} onClick={() => saveTechnical.mutate()} className="rounded-xl bg-slate-900 px-4 py-2 text-sm text-white disabled:opacity-50">Save Technical</button>
              </div>
            ) : null}

            {tab === "suppliers" ? (
              <div className="space-y-4">
                <div className="overflow-auto rounded-xl border">
                  <table className="w-full text-sm">
                    <thead className="bg-slate-100"><tr><th className="px-3 py-2 text-left">Supplier Name</th><th className="px-3 py-2 text-left">Supplier Part Number</th><th className="px-3 py-2 text-left">Currency</th><th className="px-3 py-2 text-right">Price</th><th className="px-3 py-2 text-left">Lead Time</th><th className="px-3 py-2 text-left">Remarks</th><th className="px-3 py-2 text-right">Actions</th></tr></thead>
                    <tbody>
                      {suppliers.map((s) => (
                        <tr key={s._id} className="border-t">
                          <td className="px-3 py-2">{s.supplierName}</td><td className="px-3 py-2">{s.supplierPartNumber || "-"}</td><td className="px-3 py-2">{s.currency}</td><td className="px-3 py-2 text-right">{Number(s.price || 0).toFixed(2)}</td><td className="px-3 py-2">{s.leadTime || "-"}</td><td className="px-3 py-2">{s.remarks || "-"}</td>
                          <td className="px-3 py-2"><div className="flex justify-end gap-2"><button onClick={() => { setEditingSupplierId(s._id); setSupplierDraft({ supplierName: s.supplierName, supplierPartNumber: s.supplierPartNumber, currency: s.currency, price: s.price, leadTime: s.leadTime, remarks: s.remarks }); }} className="rounded border px-2 py-1 text-xs">Edit</button><button onClick={() => removeSupplier.mutate(s._id)} className="rounded border border-rose-200 px-2 py-1 text-xs text-rose-700">Delete</button></div></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="grid gap-3 md:grid-cols-3">
                  <Field label="Supplier Name"><input className="rounded-lg border px-3 py-2" value={supplierDraft.supplierName} onChange={(e) => setSupplierDraft((v) => ({ ...v, supplierName: e.target.value }))} /></Field>
                  <Field label="Supplier Part Number"><input className="rounded-lg border px-3 py-2" value={supplierDraft.supplierPartNumber} onChange={(e) => setSupplierDraft((v) => ({ ...v, supplierPartNumber: e.target.value }))} /></Field>
                  <Field label="Currency"><input className="rounded-lg border px-3 py-2" value={supplierDraft.currency} onChange={(e) => setSupplierDraft((v) => ({ ...v, currency: e.target.value }))} /></Field>
                  <Field label="Price"><input type="number" className="rounded-lg border px-3 py-2" value={supplierDraft.price} onChange={(e) => setSupplierDraft((v) => ({ ...v, price: Number(e.target.value) }))} /></Field>
                  <Field label="Lead Time"><input className="rounded-lg border px-3 py-2" value={supplierDraft.leadTime} onChange={(e) => setSupplierDraft((v) => ({ ...v, leadTime: e.target.value }))} /></Field>
                  <Field label="Remarks"><input className="rounded-lg border px-3 py-2" value={supplierDraft.remarks} onChange={(e) => setSupplierDraft((v) => ({ ...v, remarks: e.target.value }))} /></Field>
                </div>
                <button disabled={!selectedArticle} onClick={() => saveSupplier.mutate()} className="rounded-xl bg-slate-900 px-4 py-2 text-sm text-white disabled:opacity-50">{editingSupplierId ? "Update Supplier" : "+ Add Supplier"}</button>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
