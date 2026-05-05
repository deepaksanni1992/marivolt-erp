import { useRef, useState } from "react";
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
  materialCode: "",
  drawingNumber: "",
  dimension: "",
  oeMarkings: "",
  extRemarks: "",
  internalRemarks: "",
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
  { key: "Eng no", header: "Eng no" },
  { key: "Model", header: "Model" },
  { key: "Config", header: "Config" },
  { key: "SPN", header: "SPN" },
  { key: "Material Code", header: "Material Code" },
  { key: "Drawing Number", header: "Drawing Number" },
  { key: "Dimension", header: "Dimension" },
  { key: "OE Markings", header: "OE Markings" },
  { key: "Suppliers", header: "Suppliers" },
  { key: "Status", header: "Status" },
];

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
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [vertical, setVertical] = useState("");
  const [engine, setEngine] = useState("");
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [tab, setTab] = useState("basic");
  const [selectedArticle, setSelectedArticle] = useState("");
  const [error, setError] = useState("");
  const [item, setItem] = useState(emptyItem);
  const [technical, setTechnical] = useState(emptyTechnical);
  const [supplierDraft, setSupplierDraft] = useState(emptySupplier);
  const [editingSupplierId, setEditingSupplierId] = useState("");

  const { data: listData, isLoading } = useQuery({
    queryKey: ["items", page, search, vertical, engine],
    queryFn: () =>
      apiGetWithQuery("/items", {
        page,
        limit: 25,
        search: search || undefined,
        vertical: vertical || undefined,
        engine: engine || undefined,
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
    mutationFn: () => apiPut(`/items/${selectedArticle}/technical`, technical),
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
    setTechnical({ ...emptyTechnical, ...(full.technical || {}) });
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
        <div className="grid gap-3 md:grid-cols-4">
          <Field label="Vertical">
            <select className="rounded-lg border px-3 py-2" value={vertical} onChange={(e) => setVertical(e.target.value)}>
              <option value="">All</option>
              {(facets?.verticals || []).map((v) => <option key={v} value={v}>{v}</option>)}
            </select>
          </Field>
          <Field label="Engine">
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
          <div className="flex items-end">
            <button onClick={() => { setPage(1); qc.invalidateQueries({ queryKey: ["items"] }); }} className="rounded-xl bg-slate-900 px-4 py-2 text-sm text-white">Apply</button>
          </div>
        </div>
      </div>

      {error ? <div className="rounded-xl border border-rose-300 bg-rose-50 p-3 text-sm text-rose-700">{error}</div> : null}

      <div className="overflow-hidden rounded-2xl border bg-white">
        <div className="max-h-[62vh] overflow-auto">
          <table className="min-w-[2800px] w-full text-sm">
            <thead className="sticky top-0 bg-slate-100">
              <tr className="text-left">
                <th className="px-3 py-3">Vertical</th>
                <th className="px-3 py-3">Eng no</th>
                <th className="px-3 py-3">Model</th>
                <th className="px-3 py-3">Config</th>
                <th className="px-3 py-3">Article</th>
                <th className="px-3 py-3">Description</th>
                <th className="px-3 py-3">ITEM NAME</th>
                <th className="px-3 py-3">SPN</th>
                <th className="px-3 py-3">Material Code</th>
                <th className="px-3 py-3">Drawing Number</th>
                <th className="px-3 py-3">QTY</th>
                <th className="px-3 py-3">Ext Remarks</th>
                <th className="px-3 py-3">Internal Remarks</th>
                <th className="px-3 py-3">OE Markings</th>
                <th className="px-3 py-3">Dimension</th>
                <th className="px-3 py-3">Supplier 1</th>
                <th className="px-3 py-3">Supplier 1 P/N</th>
                <th className="px-3 py-3">Supplier 2</th>
                <th className="px-3 py-3">Supplier 2 P/N</th>
                <th className="px-3 py-3">Status</th>
                <th className="px-3 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? <tr><td className="px-3 py-8" colSpan={20}>Loading...</td></tr> : list.map((row) => (
                <tr key={row._id} className="border-t">
                  <td className="px-3 py-2">{row.vertical || "-"}</td>
                  <td className="px-3 py-2">{row.engine || "-"}</td>
                  <td className="px-3 py-2">{row.model || "-"}</td>
                  <td className="px-3 py-2">{row.config || "-"}</td>
                  <td className="px-3 py-2 font-mono">{row.article}</td>
                  <td className="px-3 py-2">{row.description || "-"}</td>
                  <td className="px-3 py-2">{row.itemName || "-"}</td>
                  <td className="px-3 py-2">{row.spn || "-"}</td>
                  <td className="px-3 py-2">{row.materialCode || "-"}</td>
                  <td className="px-3 py-2">{row.drawingNumber || "-"}</td>
                  <td className="px-3 py-2">{Number(row.qty || 0)}</td>
                  <td className="px-3 py-2">{row.extRemarks || "-"}</td>
                  <td className="px-3 py-2">{row.internalRemarks || "-"}</td>
                  <td className="px-3 py-2">{row.oeMarkings || "-"}</td>
                  <td className="px-3 py-2">{row.dimension || "-"}</td>
                  <td className="px-3 py-2">{row.supplier1 || "-"}</td>
                  <td className="px-3 py-2">{row.supplier1PartNumber || "-"}</td>
                  <td className="px-3 py-2">{row.supplier2 || "-"}</td>
                  <td className="px-3 py-2">{row.supplier2PartNumber || "-"}</td>
                  <td className="px-3 py-2"><StatusBadge status={row.status} /></td>
                  <td className="px-3 py-2">
                    <div className="flex justify-end gap-2">
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
                  <Field label="Engine"><input className="rounded-lg border px-3 py-2" value={item.engine} onChange={(e) => setItem((v) => ({ ...v, engine: e.target.value }))} /></Field>
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
                <div className="grid gap-3 md:grid-cols-2">
                  <Field label="SPN"><input className="rounded-lg border px-3 py-2" value={technical.spn} onChange={(e) => setTechnical((v) => ({ ...v, spn: e.target.value }))} /></Field>
                  <Field label="Material Code"><input className="rounded-lg border px-3 py-2" value={technical.materialCode} onChange={(e) => setTechnical((v) => ({ ...v, materialCode: e.target.value }))} /></Field>
                  <Field label="Drawing Number"><input className="rounded-lg border px-3 py-2" value={technical.drawingNumber} onChange={(e) => setTechnical((v) => ({ ...v, drawingNumber: e.target.value }))} /></Field>
                  <Field label="Dimension"><input className="rounded-lg border px-3 py-2" value={technical.dimension} onChange={(e) => setTechnical((v) => ({ ...v, dimension: e.target.value }))} /></Field>
                  <Field label="OE Markings"><input className="rounded-lg border px-3 py-2" value={technical.oeMarkings} onChange={(e) => setTechnical((v) => ({ ...v, oeMarkings: e.target.value }))} /></Field>
                  <Field label="Ext Remarks"><input className="rounded-lg border px-3 py-2" value={technical.extRemarks} onChange={(e) => setTechnical((v) => ({ ...v, extRemarks: e.target.value }))} /></Field>
                  <Field label="Internal Remarks"><input className="rounded-lg border px-3 py-2" value={technical.internalRemarks} onChange={(e) => setTechnical((v) => ({ ...v, internalRemarks: e.target.value }))} /></Field>
                </div>
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
