import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Papa from "papaparse";
import PageHeader from "../components/erp/PageHeader.jsx";
import Modal from "../components/erp/Modal.jsx";
import { FormField, SelectInput, TextInput } from "../components/erp/FormField.jsx";
import {
  apiDelete,
  apiGet,
  apiGetWithQuery,
  apiPost,
  apiPostFormData,
  apiPut,
} from "../lib/api.js";
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

const emptyMapping = {
  model: "",
  esn: "",
  mpn: "",
  partNumber: "",
  materialCode: "",
  drawingNumber: "",
  description: "",
};

const emptySupplier = {
  supplierName: "",
  supplierPartNumber: "",
  unitPrice: 0,
  currency: "USD",
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

function MasterStatusBadge({ active }) {
  return (
    <span
      className={[
        "inline-flex rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ring-inset",
        active
          ? "bg-emerald-50 text-emerald-900 ring-emerald-200"
          : "bg-slate-100 text-slate-600 ring-slate-200",
      ].join(" ")}
    >
      {active ? "Active" : "Inactive"}
    </span>
  );
}

/** List API returns Mongo fields; master grid uses identity-only labels. */
function masterRowFromListItem(row) {
  return {
    article: row.itemCode ?? "",
    productName: row.description ?? "",
    brand: row.brand ?? "",
    vertical: row.vertical ?? "",
    uom: row.uom ?? "",
    active: !!row.isActive,
  };
}

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
  const [modalOpen, setModalOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState("");
  const [form, setForm] = useState(emptyItem);
  const [editingId, setEditingId] = useState(null);
  const [formError, setFormError] = useState("");
  const [exportBusy, setExportBusy] = useState(false);
  const [excelImportResult, setExcelImportResult] = useState(null);

  const [expandedArticle, setExpandedArticle] = useState(null);
  const [detailTab, setDetailTab] = useState("technical");
  const [mapModalOpen, setMapModalOpen] = useState(false);
  const [supModalOpen, setSupModalOpen] = useState(false);
  const [mappingForm, setMappingForm] = useState(emptyMapping);
  const [supplierForm, setSupplierForm] = useState(emptySupplier);
  const [detailFormError, setDetailFormError] = useState("");

  const limit = 25;
  const listParams = {
    page,
    limit,
    search: search.trim() || undefined,
    vertical: filterVertical || undefined,
    brand: filterBrand || undefined,
  };

  const { data, isLoading, error } = useQuery({
    queryKey: ["items", page, search, filterVertical, filterBrand],
    queryFn: () => apiGetWithQuery("/items", listParams),
  });

  const { data: facets } = useQuery({
    queryKey: ["itemFacets"],
    queryFn: () => apiGetWithQuery("/items/facets", {}),
    staleTime: 30_000,
  });

  const { data: fullDetail, isLoading: fullLoading, isFetching: fullFetching } = useQuery({
    queryKey: ["itemFull", expandedArticle],
    queryFn: () => apiGet(`/items/full/${encodeURIComponent(expandedArticle)}`),
    enabled: !!expandedArticle,
    staleTime: 0,
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
      setExpandedArticle(null);
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

  const addMappingMutation = useMutation({
    mutationFn: (body) => apiPost("/items/mappings", body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["itemFull", expandedArticle] });
      setMapModalOpen(false);
      setMappingForm(emptyMapping);
      setDetailFormError("");
    },
    onError: (e) => setDetailFormError(e.message),
  });

  const addSupplierMutation = useMutation({
    mutationFn: (body) => apiPost("/items/supplier-offers", body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["itemFull", expandedArticle] });
      setSupModalOpen(false);
      setSupplierForm(emptySupplier);
      setDetailFormError("");
    },
    onError: (e) => setDetailFormError(e.message),
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

  function toggleRow(articleCode) {
    setExpandedArticle((prev) => {
      const next = prev === articleCode ? null : articleCode;
      if (next) setDetailTab("technical");
      return next;
    });
  }

  async function runExport(kind) {
    setExportBusy(true);
    setFormError("");
    try {
      const exportData = await apiGetWithQuery("/items", {
        export: "1",
        limit: 10000,
        search: search.trim() || undefined,
        vertical: filterVertical || undefined,
        brand: filterBrand || undefined,
      });
      const rows = (exportData.items ?? []).map(mapItemToExportRow);
      if (exportData.total != null && rows.length < exportData.total) {
        window.alert(
          `Exported ${rows.length} of ${exportData.total} matching items. Narrow filters or raise the export limit in the API if needed.`
        );
      }
      const parts = [];
      if (filterVertical) parts.push(`Vertical: ${filterVertical}`);
      if (filterBrand) parts.push(`Brand: ${filterBrand}`);
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
          setFormError(
            "No valid rows. Each row needs an article code (column itemCode, article, or code)."
          );
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
    <div className="min-h-[60vh]">
      <PageHeader
        title="Item Master"
        subtitle="Master list — open a row for technical mappings and supplier offers."
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

      <div className="mb-4 space-y-3 rounded-2xl border border-slate-200/80 bg-white p-4 shadow-sm">
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
          <FormField label="Search" className="sm:col-span-2 lg:col-span-2">
            <TextInput
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Article, description, MPN, part number (includes mapping & supplier data)"
            />
          </FormField>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800"
            onClick={() => {
              setPage(1);
              qc.invalidateQueries({ queryKey: ["items"] });
              qc.invalidateQueries({ queryKey: ["itemFacets"] });
            }}
          >
            Apply filters
          </button>
          <p className="text-xs text-slate-500">
            Search matches item fields and linked mapping / supplier-part numbers.
          </p>
        </div>
      </div>

      <div className="overflow-hidden rounded-2xl border border-slate-200/80 bg-white shadow-sm">
        <div className="overflow-x-auto">
          <table className="min-w-[860px] w-full text-left text-sm">
            <thead className="border-b border-slate-100 bg-slate-50/90 text-xs font-semibold uppercase tracking-wide text-slate-600">
              <tr>
                <th className="px-3 py-3">Article</th>
                <th className="px-3 py-3">ProductName</th>
                <th className="px-3 py-3">Brand</th>
                <th className="px-3 py-3">Vertical</th>
                <th className="px-3 py-3">UOM</th>
                <th className="px-3 py-3">Status</th>
                <th className="px-3 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr>
                  <td colSpan={7} className="px-3 py-12 text-center text-slate-500">
                    Loading…
                  </td>
                </tr>
              ) : items.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-3 py-12 text-center text-slate-500">
                    No items match these filters.
                  </td>
                </tr>
              ) : (
                items.flatMap((row) => {
                  const m = masterRowFromListItem(row);
                  const open = expandedArticle === m.article;
                  const mainRow = (
                    <tr
                      key={row._id}
                      className={[
                        "border-b border-slate-100 transition-colors",
                        open ? "bg-slate-50/90" : "hover:bg-slate-50/50",
                      ].join(" ")}
                    >
                      <td className="px-3 py-2.5 align-middle">
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-slate-200/80 bg-white text-slate-600 shadow-sm hover:bg-slate-100"
                            aria-expanded={open}
                            aria-label={open ? "Collapse details" : "Expand details"}
                            onClick={() => toggleRow(m.article)}
                          >
                            <span className="text-xs">{open ? "▼" : "▶"}</span>
                          </button>
                          <button
                            type="button"
                            className="text-left font-mono text-xs font-semibold text-slate-900 hover:underline"
                            onClick={() => toggleRow(m.article)}
                          >
                            {m.article}
                          </button>
                        </div>
                      </td>
                      <td className="max-w-[240px] px-3 py-2.5 align-middle">
                        <span className="line-clamp-2 text-slate-700" title={m.productName}>
                          {m.productName || "—"}
                        </span>
                      </td>
                      <td className="px-3 py-2.5 align-middle text-slate-700">{m.brand || "—"}</td>
                      <td className="px-3 py-2.5 align-middle text-slate-700">{m.vertical || "—"}</td>
                      <td className="px-3 py-2.5 align-middle text-slate-700">{m.uom || "—"}</td>
                      <td className="px-3 py-2.5 align-middle">
                        <MasterStatusBadge active={m.active} />
                      </td>
                      <td className="px-3 py-2.5 align-middle text-right">
                        <div className="flex flex-wrap justify-end gap-1.5">
                          <Link
                            to={`/items/item/${encodeURIComponent(m.article)}`}
                            className="rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
                            onClick={(e) => e.stopPropagation()}
                          >
                            View
                          </Link>
                          <button
                            type="button"
                            className="rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs font-medium hover:bg-slate-50"
                            onClick={(e) => {
                              e.stopPropagation();
                              openEdit(row);
                            }}
                          >
                            Edit
                          </button>
                          <button
                            type="button"
                            className="rounded-lg border border-red-200 bg-white px-2 py-1 text-xs text-red-700 hover:bg-red-50"
                            onClick={(e) => {
                              e.stopPropagation();
                              if (confirm(`Delete ${m.article}?`)) deleteMutation.mutate(row._id);
                            }}
                          >
                            Del
                          </button>
                        </div>
                      </td>
                    </tr>
                  );

                  if (!open) return [mainRow];

                  const item = fullDetail?.item;
                  const mappings = fullDetail?.mappings ?? [];
                  const suppliers = fullDetail?.suppliers ?? [];

                  const detailRow = (
                    <tr key={`${row._id}-detail`} className="bg-slate-50/80">
                      <td colSpan={7} className="border-b border-slate-100 p-0">
                        <div className="border-t border-slate-200 px-4 py-5 sm:px-6">
                          <div className="rounded-2xl border border-slate-200/90 bg-slate-50/95 p-4 shadow-sm sm:p-5">
                            {(fullLoading || fullFetching) && !item ? (
                              <p className="text-sm text-slate-500">Loading article details…</p>
                            ) : (
                              <>
                                <p className="mb-3 text-xs font-medium uppercase tracking-wide text-slate-500">
                                  {item?.description || m.productName || m.article}
                                </p>
                                <div className="mb-4 flex flex-wrap gap-2 border-b border-slate-200/80 pb-3">
                                  {[
                                    { id: "technical", label: "Technical (Mapping)" },
                                    { id: "suppliers", label: "Suppliers" },
                                  ].map((t) => (
                                    <button
                                      key={t.id}
                                      type="button"
                                      className={[
                                        "rounded-lg px-4 py-2 text-sm font-medium transition-colors",
                                        detailTab === t.id
                                          ? "bg-slate-900 text-white shadow-sm"
                                          : "bg-white text-slate-600 ring-1 ring-slate-200 hover:bg-slate-100",
                                      ].join(" ")}
                                      onClick={() => setDetailTab(t.id)}
                                    >
                                      {t.label}
                                    </button>
                                  ))}
                                </div>

                                {detailTab === "technical" && (
                                  <div className="space-y-4">
                                    <div className="flex flex-wrap items-center justify-between gap-2">
                                      <p className="text-xs text-slate-500">
                                        Technical mapping lines (model, ESN, MPN, part no., drawing)
                                      </p>
                                      <button
                                        type="button"
                                        className="rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-800"
                                        onClick={() => {
                                          setDetailFormError("");
                                          setMappingForm(emptyMapping);
                                          setMapModalOpen(true);
                                        }}
                                      >
                                        Add mapping
                                      </button>
                                    </div>
                                    <div className="rounded-xl border border-white bg-white p-4 shadow-sm ring-1 ring-slate-100">
                                      {mappings.length === 0 ? (
                                        <p className="text-sm text-slate-500">No mapping lines yet.</p>
                                      ) : (
                                        <div className="overflow-x-auto">
                                          <table className="min-w-full text-xs">
                                            <thead className="text-slate-500">
                                              <tr>
                                                <th className="pb-2 pr-3 text-left font-medium">Model</th>
                                                <th className="pb-2 pr-3 text-left font-medium">ESN</th>
                                                <th className="pb-2 pr-3 text-left font-medium">MPN</th>
                                                <th className="pb-2 pr-3 text-left font-medium">Part Number</th>
                                                <th className="pb-2 text-left font-medium">Drawing Number</th>
                                              </tr>
                                            </thead>
                                            <tbody>
                                              {mappings.map((mapRow) => (
                                                <tr key={mapRow._id} className="border-t border-slate-100">
                                                  <td className="py-2 pr-3">{mapRow.model || "—"}</td>
                                                  <td className="py-2 pr-3 font-mono">{mapRow.esn || "—"}</td>
                                                  <td className="py-2 pr-3 font-mono">{mapRow.mpn || "—"}</td>
                                                  <td className="py-2 pr-3 font-mono">{mapRow.partNumber || "—"}</td>
                                                  <td className="py-2 font-mono">{mapRow.drawingNumber || "—"}</td>
                                                </tr>
                                              ))}
                                            </tbody>
                                          </table>
                                        </div>
                                      )}
                                    </div>
                                  </div>
                                )}

                                {detailTab === "suppliers" && (
                                  <div className="space-y-4">
                                    <div className="flex flex-wrap items-center justify-between gap-2">
                                      <p className="text-xs text-slate-500">
                                        Supplier comparison for this article
                                      </p>
                                      <button
                                        type="button"
                                        className="rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-800"
                                        onClick={() => {
                                          setDetailFormError("");
                                          setSupplierForm(emptySupplier);
                                          setSupModalOpen(true);
                                        }}
                                      >
                                        Add supplier
                                      </button>
                                    </div>
                                    <div className="rounded-xl border border-white bg-white p-4 shadow-sm ring-1 ring-slate-100">
                                      {suppliers.length === 0 ? (
                                        <p className="text-sm text-slate-500">No supplier offers yet.</p>
                                      ) : (
                                        <div className="overflow-x-auto">
                                          <table className="min-w-full text-xs">
                                            <thead className="text-slate-500">
                                              <tr>
                                                <th className="pb-2 pr-3 text-left font-medium">Supplier Name</th>
                                                <th className="pb-2 pr-3 text-left font-medium">
                                                  Supplier Part Number
                                                </th>
                                                <th className="pb-2 pr-3 text-right font-medium">Unit Price</th>
                                                <th className="pb-2 text-left font-medium">Currency</th>
                                              </tr>
                                            </thead>
                                            <tbody>
                                              {suppliers.map((sup) => (
                                                <tr key={sup._id} className="border-t border-slate-100">
                                                  <td className="py-2 pr-3 font-medium">{sup.supplierName}</td>
                                                  <td className="py-2 pr-3 font-mono">
                                                    {sup.supplierPartNumber || "—"}
                                                  </td>
                                                  <td className="py-2 pr-3 text-right tabular-nums">
                                                    {Number(sup.unitPrice || 0).toFixed(2)}
                                                  </td>
                                                  <td className="py-2">{sup.currency || "—"}</td>
                                                </tr>
                                              ))}
                                            </tbody>
                                          </table>
                                        </div>
                                      )}
                                    </div>
                                  </div>
                                )}
                              </>
                            )}
                          </div>
                        </div>
                      </td>
                    </tr>
                  );

                  return [mainRow, detailRow];
                })
              )}
            </tbody>
          </table>
        </div>
        <div className="flex items-center justify-between border-t border-slate-100 px-4 py-3 text-sm text-slate-600">
          <span>
            Page {page} / {totalPages} · {total} items
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              className="rounded-lg border border-slate-200 bg-white px-2 py-1 text-sm disabled:opacity-40"
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              Prev
            </button>
            <button
              type="button"
              className="rounded-lg border border-slate-200 bg-white px-2 py-1 text-sm disabled:opacity-40"
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
          <FormField label="Product name / description" className="sm:col-span-2">
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
        open={mapModalOpen}
        onClose={() => {
          setMapModalOpen(false);
          setDetailFormError("");
        }}
        title="Add mapping"
        wide
      >
        {detailFormError ? (
          <div className="mb-3 rounded-lg border border-red-200 bg-red-50 p-2 text-sm text-red-700">
            {detailFormError}
          </div>
        ) : null}
        <p className="mb-3 text-xs text-slate-500">
          Article <span className="font-mono font-semibold">{expandedArticle}</span>
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label="Model">
            <TextInput
              value={mappingForm.model}
              onChange={(e) => setMappingForm((f) => ({ ...f, model: e.target.value }))}
            />
          </FormField>
          <FormField label="ESN">
            <TextInput
              value={mappingForm.esn}
              onChange={(e) => setMappingForm((f) => ({ ...f, esn: e.target.value }))}
            />
          </FormField>
          <FormField label="MPN">
            <TextInput
              value={mappingForm.mpn}
              onChange={(e) => setMappingForm((f) => ({ ...f, mpn: e.target.value }))}
            />
          </FormField>
          <FormField label="Part number">
            <TextInput
              value={mappingForm.partNumber}
              onChange={(e) => setMappingForm((f) => ({ ...f, partNumber: e.target.value }))}
            />
          </FormField>
          <FormField label="Material code">
            <TextInput
              value={mappingForm.materialCode}
              onChange={(e) => setMappingForm((f) => ({ ...f, materialCode: e.target.value }))}
            />
          </FormField>
          <FormField label="Drawing number">
            <TextInput
              value={mappingForm.drawingNumber}
              onChange={(e) => setMappingForm((f) => ({ ...f, drawingNumber: e.target.value }))}
            />
          </FormField>
          <FormField label="Description" className="sm:col-span-2">
            <TextInput
              value={mappingForm.description}
              onChange={(e) => setMappingForm((f) => ({ ...f, description: e.target.value }))}
            />
          </FormField>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            className="rounded-xl border px-4 py-2 text-sm"
            onClick={() => setMapModalOpen(false)}
          >
            Cancel
          </button>
          <button
            type="button"
            className="rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
            disabled={addMappingMutation.isPending || !expandedArticle}
            onClick={() =>
              addMappingMutation.mutate({
                article: expandedArticle,
                ...mappingForm,
              })
            }
          >
            {addMappingMutation.isPending ? "Saving…" : "Save mapping"}
          </button>
        </div>
      </Modal>

      <Modal
        open={supModalOpen}
        onClose={() => {
          setSupModalOpen(false);
          setDetailFormError("");
        }}
        title="Add supplier offer"
      >
        {detailFormError ? (
          <div className="mb-3 rounded-lg border border-red-200 bg-red-50 p-2 text-sm text-red-700">
            {detailFormError}
          </div>
        ) : null}
        <p className="mb-3 text-xs text-slate-500">
          Article <span className="font-mono font-semibold">{expandedArticle}</span>
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label="Supplier name *" className="sm:col-span-2">
            <TextInput
              value={supplierForm.supplierName}
              onChange={(e) => setSupplierForm((f) => ({ ...f, supplierName: e.target.value }))}
            />
          </FormField>
          <FormField label="Supplier part number" className="sm:col-span-2">
            <TextInput
              value={supplierForm.supplierPartNumber}
              onChange={(e) =>
                setSupplierForm((f) => ({ ...f, supplierPartNumber: e.target.value }))
              }
            />
          </FormField>
          <FormField label="Unit price">
            <TextInput
              type="number"
              step="0.01"
              min={0}
              value={supplierForm.unitPrice}
              onChange={(e) =>
                setSupplierForm((f) => ({ ...f, unitPrice: Number(e.target.value) }))
              }
            />
          </FormField>
          <FormField label="Currency">
            <TextInput
              value={supplierForm.currency}
              onChange={(e) => setSupplierForm((f) => ({ ...f, currency: e.target.value }))}
            />
          </FormField>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            className="rounded-xl border px-4 py-2 text-sm"
            onClick={() => setSupModalOpen(false)}
          >
            Cancel
          </button>
          <button
            type="button"
            className="rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
            disabled={addSupplierMutation.isPending || !expandedArticle}
            onClick={() =>
              addSupplierMutation.mutate({
                article: expandedArticle,
                ...supplierForm,
              })
            }
          >
            {addSupplierMutation.isPending ? "Saving…" : "Save supplier"}
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
