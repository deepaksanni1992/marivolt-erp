import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Papa from "papaparse";
import PageHeader from "../components/erp/PageHeader.jsx";
import Modal from "../components/erp/Modal.jsx";
import { FormField, SelectInput, TextInput } from "../components/erp/FormField.jsx";
import { apiDelete, apiGetWithQuery, apiPost, apiPostFormData, apiPut } from "../lib/api.js";
import { downloadCsv, downloadPdfTable } from "../lib/purchaseExport.js";

const emptyItem = {
  itemCode: "",
  description: "",
  uom: "PCS",
  vertical: "",
  brand: "",
  modelName: "",
  makerPartNo: "",
  hsnCode: "",
  category: "",
  supplierName: "",
  supplierPartNo: "",
  supplierLeadTimeDays: 0,
  purchasePrice: 0,
  salePrice: 0,
  currency: "USD",
  weightKg: 0,
  coo: "",
  reorderLevel: 0,
  remarks: "",
  isActive: true,
};

function csvRowToItem(row) {
  const r = row || {};
  const itemCode = String(
    r.itemCode || r.article || r.Article || r.ARTICLE || r.code || r.Code || ""
  )
    .trim()
    .toUpperCase();
  if (!itemCode) return null;
  return {
    itemCode,
    description: String(r.description || r.Description || "").trim(),
    uom: String(r.uom || r.UOM || r.unit || "PCS").trim() || "PCS",
    vertical: String(r.vertical || r.Vertical || "").trim(),
    brand: String(r.brand || r.Brand || "").trim(),
    modelName: String(r.modelName || r.model || r.Model || "").trim(),
    makerPartNo: String(r.makerPartNo || r.mpn || r.MPN || "").trim(),
    hsnCode: String(r.hsnCode || r.HSN || "").trim(),
    category: String(r.category || r.Category || "").trim(),
    supplierName: String(r.supplierName || r.supplier || r.Supplier || "").trim(),
    supplierPartNo: String(
      r.supplierPartNo || r.partNumber || r.part_no || r["Part number"] || r["Part Number"] || ""
    ).trim(),
    supplierLeadTimeDays: Number(r.supplierLeadTimeDays || r.leadTimeDays) || 0,
    purchasePrice: Number(r.purchasePrice || r.purchase) || 0,
    salePrice: Number(r.salePrice || r.sale) || 0,
    currency: String(r.currency || r.Currency || "USD").trim() || "USD",
    weightKg: Number(r.weightKg || r.weight) || 0,
    reorderLevel: Number(r.reorderLevel) || 0,
    remarks: String(r.remarks || r.Remarks || "").trim(),
    isActive: String(r.isActive || r.active || "")
      .toLowerCase()
      .match(/^(0|false|no|n)$/)
      ? false
      : true,
  };
}

const EXPORT_COLUMNS = [
  { key: "article", header: "Article" },
  { key: "mpn", header: "MPN" },
  { key: "description", header: "Description" },
  { key: "partNumber", header: "Part number" },
  { key: "vertical", header: "Vertical" },
  { key: "brand", header: "Brand" },
  { key: "model", header: "Model" },
  { key: "uom", header: "UOM" },
  { key: "supplier", header: "Supplier" },
  { key: "sale", header: "Sale price" },
  { key: "currency", header: "Currency" },
  { key: "active", header: "Active" },
];

function mapItemToExportRow(r) {
  return {
    article: r.itemCode ?? "",
    mpn: r.makerPartNo ?? "",
    description: r.description ?? "",
    partNumber: r.supplierPartNo ?? "",
    vertical: r.vertical ?? "",
    brand: r.brand ?? "",
    model: r.modelName ?? "",
    uom: r.uom ?? "",
    supplier: r.supplierName ?? "",
    sale: r.salePrice != null ? Number(r.salePrice).toFixed(2) : "",
    currency: r.currency ?? "",
    active: r.isActive ? "Yes" : "No",
  };
}

const EXCEL_KIND = {
  items: { path: "/import/items", label: "Item master (Excel)" },
  mappings: { path: "/import/mappings", label: "Item mappings (Excel)" },
  suppliers: { path: "/import/suppliers", label: "Item suppliers (Excel)" },
};

export default function ItemMaster() {
  const qc = useQueryClient();
  const csvInputRef = useRef(null);
  const excelItemsRef = useRef(null);
  const excelMappingsRef = useRef(null);
  const excelSuppliersRef = useRef(null);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [filterVertical, setFilterVertical] = useState("");
  const [filterBrand, setFilterBrand] = useState("");
  const [filterModel, setFilterModel] = useState("");
  const [modalOpen, setModalOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState("");
  const [form, setForm] = useState(emptyItem);
  const [editingId, setEditingId] = useState(null);
  const [formError, setFormError] = useState("");
  const [exportBusy, setExportBusy] = useState(false);
  /** @type {null | { label: string; total: number; inserted: number; failed: { row: number; reason: string }[] }} */
  const [excelImportResult, setExcelImportResult] = useState(null);

  const limit = 25;
  const listParams = {
    page,
    limit,
    search: search.trim() || undefined,
    vertical: filterVertical || undefined,
    brand: filterBrand || undefined,
    model: filterModel || undefined,
  };

  const { data, isLoading, error } = useQuery({
    queryKey: ["items", page, search, filterVertical, filterBrand, filterModel],
    queryFn: () => apiGetWithQuery("/items", listParams),
  });

  const { data: facets } = useQuery({
    queryKey: ["itemFacets"],
    queryFn: () => apiGetWithQuery("/items/facets", {}),
    staleTime: 30_000,
  });

  const saveMutation = useMutation({
    mutationFn: async () => {
      setFormError("");
      if (editingId) {
        return apiPut(`/items/${editingId}`, form);
      }
      return apiPost("/items", form);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["items"] });
      qc.invalidateQueries({ queryKey: ["itemFacets"] });
      setModalOpen(false);
      setForm(emptyItem);
      setEditingId(null);
    },
    onError: (e) => setFormError(e.message),
  });

  const deleteMutation = useMutation({
    mutationFn: (id) => apiDelete(`/items/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["items"] });
      qc.invalidateQueries({ queryKey: ["itemFacets"] });
    },
  });

  const importMutation = useMutation({
    mutationFn: async () => {
      let rows;
      try {
        rows = JSON.parse(importText);
      } catch {
        throw new Error("Paste valid JSON: an array of item objects");
      }
      if (!Array.isArray(rows)) throw new Error("JSON must be an array");
      return apiPost("/items/import", { items: rows });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["items"] });
      qc.invalidateQueries({ queryKey: ["itemFacets"] });
      setImportOpen(false);
      setImportText("");
    },
  });

  const importCsvMutation = useMutation({
    mutationFn: (items) => apiPost("/items/import", { items }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["items"] });
      qc.invalidateQueries({ queryKey: ["itemFacets"] });
      setFormError("");
    },
    onError: (e) => setFormError(e.message),
  });

  const excelImportMutation = useMutation({
    mutationFn: async ({ path, file, label }) => {
      const fd = new FormData();
      fd.append("file", file);
      const data = await apiPostFormData(path, fd);
      return { label, ...data };
    },
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["items"] });
      qc.invalidateQueries({ queryKey: ["itemFacets"] });
      setFormError("");
      setExcelImportResult({
        label: data.label,
        total: data.total ?? 0,
        inserted: data.inserted ?? 0,
        failed: Array.isArray(data.failed) ? data.failed : [],
      });
    },
    onError: (e) => setFormError(e.message || "Excel import failed"),
  });

  function onExcelFile(kind, e) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    const cfg = EXCEL_KIND[kind];
    excelImportMutation.mutate({ path: cfg.path, file, label: cfg.label });
  }

  function openCreate() {
    setEditingId(null);
    setForm(emptyItem);
    setFormError("");
    setModalOpen(true);
  }

  function openEdit(row) {
    setEditingId(row._id);
      setForm({
      ...emptyItem,
      ...row,
      coo: row.coo ?? "",
      supplierLeadTimeDays: row.supplierLeadTimeDays ?? 0,
      purchasePrice: row.purchasePrice ?? 0,
      salePrice: row.salePrice ?? 0,
      weightKg: row.weightKg ?? 0,
      reorderLevel: row.reorderLevel ?? 0,
    });
    setFormError("");
    setModalOpen(true);
  }

  async function runExport(kind) {
    setExportBusy(true);
    setFormError("");
    try {
      const data = await apiGetWithQuery("/items", {
        export: "1",
        limit: 10000,
        search: search.trim() || undefined,
        vertical: filterVertical || undefined,
        brand: filterBrand || undefined,
        model: filterModel || undefined,
      });
      const rows = (data.items ?? []).map(mapItemToExportRow);
      if (data.total != null && rows.length < data.total) {
        window.alert(
          `Exported ${rows.length} of ${data.total} matching items. Narrow filters or raise the export limit in the API if needed.`
        );
      }
      const parts = [];
      if (filterVertical) parts.push(`Vertical: ${filterVertical}`);
      if (filterBrand) parts.push(`Brand: ${filterBrand}`);
      if (filterModel) parts.push(`Model: ${filterModel}`);
      if (search.trim()) parts.push(`Search: ${search.trim()}`);
      const subtitle = parts.length ? parts.join(" · ") : "All items (current filter)";
      if (kind === "csv") {
        downloadCsv("item-master.csv", EXPORT_COLUMNS, rows);
      } else {
        downloadPdfTable("Item master", subtitle, EXPORT_COLUMNS, rows, "item-master");
      }
    } catch (e) {
      setFormError(e.message || "Export failed");
    } finally {
      setExportBusy(false);
    }
  }

  function onCsvFileChange(e) {
    const f = e.target.files?.[0];
    if (!f) return;
    setFormError("");
    Papa.parse(f, {
      header: true,
      skipEmptyLines: true,
      complete: (results) => {
        const items = (results.data || []).map(csvRowToItem).filter(Boolean);
        e.target.value = "";
        if (!items.length) {
          setFormError('No valid rows. Each row needs an article code (column itemCode, article, or code).');
          return;
        }
        importCsvMutation.mutate(items);
      },
      error: (err) => setFormError(err.message || "CSV parse error"),
    });
  }

  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / limit));

  return (
    <div>
      <PageHeader
        title="Item Master"
        subtitle="Spare-parts catalogue with vertical, brand, and model filters; article, MPN, and part numbers."
      >
        <input
          ref={csvInputRef}
          type="file"
          accept=".csv,text/csv"
          className="hidden"
          onChange={onCsvFileChange}
        />
        <input
          ref={excelItemsRef}
          type="file"
          accept=".xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
          className="hidden"
          onChange={(e) => onExcelFile("items", e)}
        />
        <input
          ref={excelMappingsRef}
          type="file"
          accept=".xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
          className="hidden"
          onChange={(e) => onExcelFile("mappings", e)}
        />
        <input
          ref={excelSuppliersRef}
          type="file"
          accept=".xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
          className="hidden"
          onChange={(e) => onExcelFile("suppliers", e)}
        />
        <button
          type="button"
          onClick={() => excelItemsRef.current?.click()}
          disabled={excelImportMutation.isPending}
          className="rounded-xl border border-indigo-200 bg-indigo-50 px-3 py-2 text-sm font-medium text-indigo-900 hover:bg-indigo-100 disabled:opacity-50"
        >
          {excelImportMutation.isPending ? "Excel…" : "Excel: Items"}
        </button>
        <button
          type="button"
          onClick={() => excelMappingsRef.current?.click()}
          disabled={excelImportMutation.isPending}
          className="rounded-xl border border-indigo-200 bg-indigo-50 px-3 py-2 text-sm font-medium text-indigo-900 hover:bg-indigo-100 disabled:opacity-50"
        >
          Excel: Mappings
        </button>
        <button
          type="button"
          onClick={() => excelSuppliersRef.current?.click()}
          disabled={excelImportMutation.isPending}
          className="rounded-xl border border-indigo-200 bg-indigo-50 px-3 py-2 text-sm font-medium text-indigo-900 hover:bg-indigo-100 disabled:opacity-50"
        >
          Excel: Suppliers
        </button>
        <button
          type="button"
          onClick={() => csvInputRef.current?.click()}
          className="rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm font-medium hover:bg-gray-50 disabled:opacity-50"
          disabled={importCsvMutation.isPending}
        >
          {importCsvMutation.isPending ? "Importing CSV…" : "Import CSV"}
        </button>
        <button
          type="button"
          onClick={() => setImportOpen(true)}
          className="rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm font-medium hover:bg-gray-50"
        >
          Import JSON
        </button>
        <button
          type="button"
          onClick={() => runExport("csv")}
          disabled={exportBusy || total === 0}
          className="rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm font-medium hover:bg-gray-50 disabled:opacity-50"
        >
          Export CSV
        </button>
        <button
          type="button"
          onClick={() => runExport("pdf")}
          disabled={exportBusy || total === 0}
          className="rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm font-medium hover:bg-gray-50 disabled:opacity-50"
        >
          Export PDF
        </button>
        <button
          type="button"
          onClick={openCreate}
          className="rounded-xl bg-gray-900 px-3 py-2 text-sm font-semibold text-white hover:bg-gray-800"
        >
          New item
        </button>
      </PageHeader>

      {error ? (
        <div className="mb-4 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {error.message}
        </div>
      ) : null}
      {formError && !modalOpen && !importOpen && !excelImportResult ? (
        <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          {formError}
        </div>
      ) : null}

      <div className="mb-4 space-y-3 rounded-2xl border bg-white p-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <FormField label="Vertical">
            <SelectInput
              value={filterVertical}
              onChange={(e) => setFilterVertical(e.target.value)}
            >
              <option value="">All verticals</option>
              {(facets?.verticals ?? []).map((x) => (
                <option key={x} value={x}>
                  {x}
                </option>
              ))}
            </SelectInput>
          </FormField>
          <FormField label="Brand">
            <SelectInput value={filterBrand} onChange={(e) => setFilterBrand(e.target.value)}>
              <option value="">All brands</option>
              {(facets?.brands ?? []).map((x) => (
                <option key={x} value={x}>
                  {x}
                </option>
              ))}
            </SelectInput>
          </FormField>
          <FormField label="Model">
            <SelectInput value={filterModel} onChange={(e) => setFilterModel(e.target.value)}>
              <option value="">All models</option>
              {(facets?.models ?? []).map((x) => (
                <option key={x} value={x}>
                  {x}
                </option>
              ))}
            </SelectInput>
          </FormField>
          <FormField label="Search">
            <TextInput
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Article, description, MPN, part no…"
            />
          </FormField>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="rounded-xl bg-gray-900 px-4 py-2 text-sm font-semibold text-white hover:bg-gray-800"
            onClick={() => {
              setPage(1);
              qc.invalidateQueries({ queryKey: ["items"] });
              qc.invalidateQueries({ queryKey: ["itemFacets"] });
            }}
          >
            Apply filters
          </button>
          <p className="text-xs text-gray-500">
            Dropdowns list values from your items (updates when you save new verticals, brands, or models).
          </p>
        </div>
      </div>

      <div className="overflow-hidden rounded-2xl border bg-white">
        <div className="overflow-x-auto">
          <table className="min-w-[1100px] w-full text-left text-sm">
            <thead className="border-b bg-gray-50 text-xs font-semibold text-gray-600">
              <tr>
                <th className="px-3 py-2 whitespace-nowrap">Article</th>
                <th className="px-3 py-2 whitespace-nowrap">MPN</th>
                <th className="px-3 py-2 min-w-[160px]">Description</th>
                <th className="px-3 py-2 whitespace-nowrap">Part number</th>
                <th className="px-3 py-2 whitespace-nowrap">Vertical</th>
                <th className="px-3 py-2 whitespace-nowrap">Brand</th>
                <th className="px-3 py-2 whitespace-nowrap">Model</th>
                <th className="px-3 py-2">UOM</th>
                <th className="px-3 py-2 text-right">Sale</th>
                <th className="px-3 py-2">Active</th>
                <th className="px-3 py-2 w-28" />
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr>
                  <td colSpan={11} className="px-3 py-8 text-center text-gray-500">
                    Loading…
                  </td>
                </tr>
              ) : items.length === 0 ? (
                <tr>
                  <td colSpan={11} className="px-3 py-8 text-center text-gray-500">
                    No items match these filters.
                  </td>
                </tr>
              ) : (
                items.map((row) => (
                  <tr key={row._id} className="border-b border-gray-100 hover:bg-gray-50/80">
                    <td className="px-3 py-2 font-mono text-xs font-medium">{row.itemCode}</td>
                    <td className="px-3 py-2 font-mono text-xs max-w-[120px] truncate" title={row.makerPartNo}>
                      {row.makerPartNo || "—"}
                    </td>
                    <td className="px-3 py-2 max-w-[220px] truncate" title={row.description}>
                      {row.description}
                    </td>
                    <td className="px-3 py-2 font-mono text-xs max-w-[120px] truncate" title={row.supplierPartNo}>
                      {row.supplierPartNo || "—"}
                    </td>
                    <td className="px-3 py-2 text-xs">{row.vertical || "—"}</td>
                    <td className="px-3 py-2 text-xs">{row.brand || "—"}</td>
                    <td className="px-3 py-2 text-xs max-w-[100px] truncate" title={row.modelName}>
                      {row.modelName || "—"}
                    </td>
                    <td className="px-3 py-2">{row.uom}</td>
                    <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap">
                      {row.currency} {Number(row.salePrice).toFixed(2)}
                    </td>
                    <td className="px-3 py-2">{row.isActive ? "Yes" : "No"}</td>
                    <td className="px-3 py-2">
                      <div className="flex gap-1">
                        <button
                          type="button"
                          className="rounded-lg border px-2 py-1 text-xs"
                          onClick={() => openEdit(row)}
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          className="rounded-lg border border-red-200 px-2 py-1 text-xs text-red-700"
                          onClick={() => {
                            if (confirm(`Delete ${row.itemCode}?`)) deleteMutation.mutate(row._id);
                          }}
                        >
                          Del
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <div className="flex items-center justify-between border-t px-3 py-2 text-sm text-gray-600">
          <span>
            Page {page} / {totalPages} · {total} items
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              className="rounded-lg border px-2 py-1 disabled:opacity-40"
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              Prev
            </button>
            <button
              type="button"
              className="rounded-lg border px-2 py-1 disabled:opacity-40"
              disabled={page >= totalPages}
              onClick={() => setPage((p) => p + 1)}
            >
              Next
            </button>
          </div>
        </div>
      </div>

      <Modal
        open={modalOpen}
        onClose={() => {
          setModalOpen(false);
          setEditingId(null);
        }}
        title={editingId ? "Edit item" : "New item"}
        wide
      >
        {formError ? (
          <div className="mb-3 rounded-lg border border-red-200 bg-red-50 p-2 text-sm text-red-700">
            {formError}
          </div>
        ) : null}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <FormField label="Article (item code) *">
            <TextInput
              value={form.itemCode}
              onChange={(e) => setForm((f) => ({ ...f, itemCode: e.target.value }))}
              disabled={!!editingId}
            />
          </FormField>
          <FormField label="UOM">
            <TextInput
              value={form.uom}
              onChange={(e) => setForm((f) => ({ ...f, uom: e.target.value }))}
            />
          </FormField>
          <FormField label="Description" className="sm:col-span-2">
            <TextInput
              value={form.description}
              onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
            />
          </FormField>
          <FormField label="Vertical (e.g. Engine, Turbocharger)">
            <TextInput
              value={form.vertical}
              onChange={(e) => setForm((f) => ({ ...f, vertical: e.target.value }))}
              placeholder="Engine"
            />
          </FormField>
          <FormField label="Brand (e.g. Wärtsilä, MAN)">
            <TextInput
              value={form.brand}
              onChange={(e) => setForm((f) => ({ ...f, brand: e.target.value }))}
            />
          </FormField>
          <FormField label="Model (e.g. W34DF, 32/40 CD)" className="sm:col-span-2">
            <TextInput
              value={form.modelName}
              onChange={(e) => setForm((f) => ({ ...f, modelName: e.target.value }))}
            />
          </FormField>
          <FormField label="MPN (maker part no)">
            <TextInput
              value={form.makerPartNo}
              onChange={(e) => setForm((f) => ({ ...f, makerPartNo: e.target.value }))}
            />
          </FormField>
          <FormField label="Part number (supplier)">
            <TextInput
              value={form.supplierPartNo}
              onChange={(e) => setForm((f) => ({ ...f, supplierPartNo: e.target.value }))}
            />
          </FormField>
          <FormField label="HSN">
            <TextInput
              value={form.hsnCode}
              onChange={(e) => setForm((f) => ({ ...f, hsnCode: e.target.value }))}
            />
          </FormField>
          <FormField label="Category (legacy)">
            <TextInput
              value={form.category}
              onChange={(e) => setForm((f) => ({ ...f, category: e.target.value }))}
            />
          </FormField>
          <FormField label="Supplier name">
            <TextInput
              value={form.supplierName}
              onChange={(e) => setForm((f) => ({ ...f, supplierName: e.target.value }))}
            />
          </FormField>
          <FormField label="Lead time (days)">
            <TextInput
              type="number"
              value={form.supplierLeadTimeDays}
              onChange={(e) =>
                setForm((f) => ({ ...f, supplierLeadTimeDays: Number(e.target.value) }))
              }
            />
          </FormField>
          <FormField label="Currency">
            <TextInput
              value={form.currency}
              onChange={(e) => setForm((f) => ({ ...f, currency: e.target.value }))}
            />
          </FormField>
          <FormField label="Purchase price">
            <TextInput
              type="number"
              step="0.01"
              value={form.purchasePrice}
              onChange={(e) =>
                setForm((f) => ({ ...f, purchasePrice: Number(e.target.value) }))
              }
            />
          </FormField>
          <FormField label="Sale price">
            <TextInput
              type="number"
              step="0.01"
              value={form.salePrice}
              onChange={(e) => setForm((f) => ({ ...f, salePrice: Number(e.target.value) }))}
            />
          </FormField>
          <FormField label="Weight (kg)">
            <TextInput
              type="number"
              step="0.001"
              value={form.weightKg}
              onChange={(e) => setForm((f) => ({ ...f, weightKg: Number(e.target.value) }))}
            />
          </FormField>
          <FormField label="COO (country of origin)">
            <TextInput
              value={form.coo}
              onChange={(e) => setForm((f) => ({ ...f, coo: e.target.value }))}
            />
          </FormField>
          <FormField label="Reorder level">
            <TextInput
              type="number"
              value={form.reorderLevel}
              onChange={(e) =>
                setForm((f) => ({ ...f, reorderLevel: Number(e.target.value) }))
              }
            />
          </FormField>
          <FormField label="Remarks" className="sm:col-span-2">
            <TextInput
              value={form.remarks}
              onChange={(e) => setForm((f) => ({ ...f, remarks: e.target.value }))}
            />
          </FormField>
          <label className="flex items-center gap-2 text-sm sm:col-span-2">
            <input
              type="checkbox"
              checked={form.isActive}
              onChange={(e) => setForm((f) => ({ ...f, isActive: e.target.checked }))}
            />
            Active
          </label>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            className="rounded-xl border px-4 py-2 text-sm"
            onClick={() => setModalOpen(false)}
          >
            Cancel
          </button>
          <button
            type="button"
            className="rounded-xl bg-gray-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
            disabled={saveMutation.isPending}
            onClick={() => saveMutation.mutate()}
          >
            {saveMutation.isPending ? "Saving…" : "Save"}
          </button>
        </div>
      </Modal>

      <Modal
        open={importOpen}
        onClose={() => setImportOpen(false)}
        title="Import items (JSON)"
        wide
      >
        <p className="mb-2 text-sm text-gray-600">
          POST body shape: <code className="rounded bg-gray-100 px-1">{"{ items: [...] }"}</code>.
          Each object should include at least <code className="rounded bg-gray-100 px-1">itemCode</code>.
          Optional fields: <code className="rounded bg-gray-100 px-1">vertical</code>,{" "}
          <code className="rounded bg-gray-100 px-1">brand</code>,{" "}
          <code className="rounded bg-gray-100 px-1">modelName</code>.
        </p>
        {importMutation.isError ? (
          <div className="mb-2 rounded-lg border border-red-200 bg-red-50 p-2 text-sm text-red-700">
            {importMutation.error.message}
          </div>
        ) : null}
        <textarea
          className="h-48 w-full rounded-xl border p-3 font-mono text-xs"
          value={importText}
          onChange={(e) => setImportText(e.target.value)}
          placeholder='[ { "itemCode": "ABC", "vertical": "Engine", "brand": "MAN", "modelName": "32/40 CD" } ]'
        />
        <div className="mt-3 flex justify-end gap-2">
          <button
            type="button"
            className="rounded-xl border px-4 py-2 text-sm"
            onClick={() => setImportOpen(false)}
          >
            Cancel
          </button>
          <button
            type="button"
            className="rounded-xl bg-gray-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
            disabled={importMutation.isPending}
            onClick={() => importMutation.mutate()}
          >
            {importMutation.isPending ? "Importing…" : "Import"}
          </button>
        </div>
      </Modal>

      <Modal
        open={!!excelImportResult}
        onClose={() => setExcelImportResult(null)}
        title={excelImportResult?.label ?? "Excel import result"}
        wide
      >
        {excelImportResult ? (
          <div className="space-y-3 text-sm text-gray-800">
            <p className="text-xs text-gray-600">
              Column layouts follow the three Excel templates (items / mappings / suppliers). Use the first
              worksheet; headers are matched case-insensitively.
            </p>
            <div className="rounded-lg bg-gray-50 px-3 py-2 text-sm tabular-nums">
              <span className="font-semibold">Total rows:</span> {excelImportResult.total}
              <span className="mx-2 text-gray-400">·</span>
              <span className="font-semibold text-emerald-800">Inserted:</span>{" "}
              {excelImportResult.inserted}
              <span className="mx-2 text-gray-400">·</span>
              <span className="font-semibold text-amber-900">Row issues:</span>{" "}
              {excelImportResult.failed.length}
            </div>
            {excelImportResult.failed.length > 0 ? (
              <div>
                <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-gray-500">
                  Failed / skipped rows
                </p>
                <div className="max-h-72 overflow-auto rounded-lg border border-gray-200">
                  <table className="w-full border-collapse text-xs">
                    <thead className="sticky top-0 bg-gray-100">
                      <tr>
                        <th className="border-b px-2 py-1.5 text-left">Row</th>
                        <th className="border-b px-2 py-1.5 text-left">Reason</th>
                      </tr>
                    </thead>
                    <tbody>
                      {excelImportResult.failed.map((f, i) => (
                        <tr key={i} className="border-b border-gray-100">
                          <td className="px-2 py-1.5 font-mono tabular-nums">{f.row}</td>
                          <td className="px-2 py-1.5 text-gray-700">{f.reason}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ) : (
              <p className="text-emerald-800">No failed or skipped rows reported for this file.</p>
            )}
            <div className="flex justify-end pt-2">
              <button
                type="button"
                className="rounded-xl bg-gray-900 px-4 py-2 text-sm font-semibold text-white"
                onClick={() => setExcelImportResult(null)}
              >
                Close
              </button>
            </div>
          </div>
        ) : null}
      </Modal>
    </div>
  );
}
