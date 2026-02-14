import { useEffect, useMemo, useState } from "react";
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import * as XLSX from "xlsx";
import { apiDelete, apiGet, apiPost } from "../lib/api.js";

export default function ItemMaster() {
  const [items, setItems] = useState([]);
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [filters, setFilters] = useState({
    vendor: "",
    engine: "",
    model: "",
    config: "",
    article: "",
    category: "",
  });

  const [form, setForm] = useState({
    sku: "",
    name: "",
    vendor: "",
    engine: "",
    model: "",
    config: "",
    cCode: "",
    article: "",
    description: "",
    spn: "",
    materialCode: "",
    drawingNumber: "",
    rev: "",
    formula: "",
    qty: "",
    oeRemarks: "",
    internalRemarks: "",
    oeMarking: "",
    oeQty: "",
    supplier1: "",
    supplier1Spn: "",
    supplier2: "",
    supplier2Spn: "",
    supplier3: "",
    supplier3Pw: "",
    supplier3OePrice: "",
    uom: "pcs",
    unitWeight: "",
    category: "General",
    minStock: "",
    location: "",
  });

  async function load() {
    setErr("");
    setLoading(true);
    try {
      const data = await apiGet("/items");
      setItems(data);
    } catch (e) {
      setErr(e.message || "Failed to load items");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  function uniqueSorted(values) {
    return Array.from(new Set(values.map((v) => String(v ?? "").trim()).filter(Boolean))).sort();
  }

  const filterOptions = useMemo(() => ({
    vendor: uniqueSorted(items.map((it) => it.vendor)),
    engine: uniqueSorted(items.map((it) => it.engine)),
    model: uniqueSorted(items.map((it) => it.model)),
    config: uniqueSorted(items.map((it) => it.config)),
    article: uniqueSorted(items.map((it) => it.article)),
    category: uniqueSorted(items.map((it) => it.category)),
  }), [items]);

  const filtered = useMemo(() => {
    let result = items;
    const query = q.trim().toLowerCase();
    if (query) {
      result = result.filter((it) =>
        [
          it.sku,
          it.name,
          it.vendor,
          it.engine,
          it.model,
          it.config,
          it.cCode,
          it.article,
          it.description,
          it.spn,
          it.materialCode,
          it.drawingNumber,
          it.rev,
          it.formula,
          it.oeRemarks,
          it.internalRemarks,
          it.oeMarking,
          it.supplier1,
          it.supplier1Spn,
          it.supplier2,
          it.supplier2Spn,
          it.supplier3,
          it.supplier3Pw,
          it.supplier3OePrice,
          it.category,
          it.uom,
          it.unitWeight,
          it.location,
        ]
          .filter(Boolean)
          .some((v) => String(v).toLowerCase().includes(query))
      );
    }
    if (filters.vendor) result = result.filter((it) => (it.vendor || "").trim() === filters.vendor);
    if (filters.engine) result = result.filter((it) => (it.engine || "").trim() === filters.engine);
    if (filters.model) result = result.filter((it) => (it.model || "").trim() === filters.model);
    if (filters.config) result = result.filter((it) => (it.config || "").trim() === filters.config);
    if (filters.article) result = result.filter((it) => (it.article || "").trim() === filters.article);
    if (filters.category) result = result.filter((it) => (it.category || "").trim() === filters.category);
    return result;
  }, [items, q, filters]);

  function downloadCsv(filename, rows) {
    const csv = rows
      .map((row) =>
        row
          .map((cell) =>
            `"${String(cell ?? "")
              .replace(/"/g, '""')
              .replace(/\r?\n/g, " ")}"`
          )
          .join(",")
      )
      .join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    link.click();
    URL.revokeObjectURL(link.href);
  }

  function exportItemsCsv() {
    const rows = [
      [
        "Vendor",
        "Engine",
        "Model",
        "Config",
        "C",
        "Article",
        "Description",
        "Item Name",
        "SPN",
        "Material Code",
        "Drawing Number",
        "Rev",
        "Formula",
        "QTY",
        "OE Remarks",
        "Internal Remarks",
        "OE Marking",
        "OE QTY",
        "Supplier 1",
        "Supplier 1 SPN",
        "Supplier 2",
        "Supplier 2 SPN",
        "Supplier 3",
        "Supplier 3 PW",
        "Supplier 3 OE Price",
        "Part No",
        "UOM",
        "Unit Weight",
        "Category",
        "Min",
        "Location",
      ],
      ...filtered.map((it) => [
        it.vendor || "",
        it.engine || "",
        it.model || "",
        it.config || "",
        it.cCode || "",
        it.article || "",
        it.description || "",
        it.name || "",
        it.spn || "",
        it.materialCode || "",
        it.drawingNumber || "",
        it.rev || "",
        it.formula || "",
        it.qty ?? 0,
        it.oeRemarks || "",
        it.internalRemarks || "",
        it.oeMarking || "",
        it.oeQty ?? 0,
        it.supplier1 || "",
        it.supplier1Spn || "",
        it.supplier2 || "",
        it.supplier2Spn || "",
        it.supplier3 || "",
        it.supplier3Pw || "",
        it.supplier3OePrice || "",
        it.sku || "",
        it.uom || "",
        it.unitWeight ?? 0,
        it.category || "",
        it.minStock ?? 0,
        it.location || "",
      ]),
    ];
    downloadCsv("item-master.csv", rows);
  }

  function exportItemsPdf() {
    const doc = new jsPDF({ orientation: "landscape" });
    doc.text("Item Master", 14, 16);
    autoTable(doc, {
      startY: 22,
      head: [
        [
          "Vendor",
          "Engine",
          "Model",
          "Config",
          "C",
          "Article",
          "Description",
          "Item Name",
          "SPN",
          "Material Code",
          "Drawing Number",
          "Rev",
          "Formula",
          "QTY",
          "OE Remarks",
          "Internal Remarks",
          "OE Marking",
          "OE QTY",
          "Supplier 1",
          "Supplier 1 SPN",
          "Supplier 2",
          "Supplier 2 SPN",
          "Supplier 3",
          "Supplier 3 PW",
          "Supplier 3 OE Price",
          "Part No",
          "UOM",
          "Unit Weight",
          "Category",
          "Min",
          "Location",
        ],
      ],
      body: filtered.map((it) => [
        it.vendor || "",
        it.engine || "",
        it.model || "",
        it.config || "",
        it.cCode || "",
        it.article || "",
        it.description || "",
        it.name || "",
        it.spn || "",
        it.materialCode || "",
        it.drawingNumber || "",
        it.rev || "",
        it.formula || "",
        String(it.qty ?? 0),
        it.oeRemarks || "",
        it.internalRemarks || "",
        it.oeMarking || "",
        String(it.oeQty ?? 0),
        it.supplier1 || "",
        it.supplier1Spn || "",
        it.supplier2 || "",
        it.supplier2Spn || "",
        it.supplier3 || "",
        it.supplier3Pw || "",
        it.supplier3OePrice || "",
        it.sku || "",
        it.uom || "",
        String(it.unitWeight ?? 0),
        it.category || "",
        String(it.minStock ?? 0),
        it.location || "",
      ]),
      styles: { fontSize: 7 },
      headStyles: { fillColor: [30, 41, 59] },
      margin: { left: 8, right: 8 },
    });
    doc.save("item-master.pdf");
  }

  function onChange(e) {
    setForm((p) => ({ ...p, [e.target.name]: e.target.value }));
  }

  async function addItem(e) {
    e.preventDefault();
    setErr("");

    const name = form.name.trim();
    if (!name) {
      setErr("Item Name is required.");
      return;
    }

    try {
      const created = await apiPost("/items", {
        sku: form.sku.trim(),
        name,
        vendor: form.vendor.trim(),
        engine: form.engine.trim(),
        model: form.model.trim(),
        config: form.config.trim(),
        cCode: form.cCode.trim(),
        article: form.article.trim(),
        description: form.description.trim(),
        spn: form.spn.trim(),
        materialCode: form.materialCode.trim(),
        drawingNumber: form.drawingNumber.trim(),
        rev: form.rev.trim(),
        formula: form.formula.trim(),
        qty: form.qty ? Number(form.qty) : 0,
        oeRemarks: form.oeRemarks.trim(),
        internalRemarks: form.internalRemarks.trim(),
        oeMarking: form.oeMarking.trim(),
        oeQty: form.oeQty ? Number(form.oeQty) : 0,
        supplier1: form.supplier1.trim(),
        supplier1Spn: form.supplier1Spn.trim(),
        supplier2: form.supplier2.trim(),
        supplier2Spn: form.supplier2Spn.trim(),
        supplier3: form.supplier3.trim(),
        supplier3Pw: form.supplier3Pw.trim(),
        supplier3OePrice: form.supplier3OePrice.trim(),
        uom: form.uom,
        unitWeight: form.unitWeight ? Number(form.unitWeight) : 0,
        category: form.category.trim() || "General",
        minStock: form.minStock ? Number(form.minStock) : 0,
        location: form.location.trim(),
      });
      setItems((prev) => [created, ...prev]);
      setForm({
        sku: "",
        name: "",
        vendor: "",
        engine: "",
        model: "",
        config: "",
        cCode: "",
        article: "",
        description: "",
        spn: "",
        materialCode: "",
        drawingNumber: "",
        rev: "",
        formula: "",
        qty: "",
        oeRemarks: "",
        internalRemarks: "",
        oeMarking: "",
        oeQty: "",
        supplier1: "",
        supplier1Spn: "",
        supplier2: "",
        supplier2Spn: "",
        supplier3: "",
        supplier3Pw: "",
        supplier3OePrice: "",
        uom: "pcs",
        unitWeight: "",
        category: "General",
        minStock: "",
        location: "",
      });
    } catch (e2) {
      setErr(e2.message || "Failed to add item");
    }
  }

  async function removeItem(id) {
    const ok = confirm("Delete this item?");
    if (!ok) return;

    setErr("");
    try {
      await apiDelete(`/items/${id}`);
      setItems((prev) => prev.filter((x) => x._id !== id));
    } catch (e) {
      setErr(e.message || "Failed to delete item");
    }
  }

  async function handleItemImport(file) {
    if (!file) return;
    setErr("");
    try {
      const buffer = await file.arrayBuffer();
      const wb = XLSX.read(buffer, { type: "array" });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });

      const normalized = rows.map((row) => {
        const entry = {};
        Object.entries(row).forEach(([k, v]) => {
          const key = String(k).toLowerCase().replace(/\s+/g, "");
          entry[key] = v;
        });
        return entry;
      });

      const itemsFromExcel = normalized.map((row) => {
        const sku = row.sku || row.partno || row.partnumber || row.articleno || "";
        const name = row.itemname || row.name || row.description || row.article || "";
        return {
          sku: String(sku || "").trim(),
          name: String(name || "").trim(),
          vendor: String(row.vendor || "").trim(),
          engine: String(row.engine || "").trim(),
          model: String(row.model || "").trim(),
          config: String(row.config || "").trim(),
          cCode: String(row.ccode || row.c || "").trim(),
          article: String(row.article || row.articleno || "").trim(),
          description: String(row.description || row.desc || "").trim(),
          spn: String(row.spn || "").trim(),
          materialCode: String(row.materialcode || row.material || "").trim(),
          drawingNumber: String(row.drawingnumber || row.drawingno || "").trim(),
          rev: String(row.rev || row.revision || "").trim(),
          formula: String(row.formula || "").trim(),
          qty: Number(row.qty || row.quantity || row.q || 0) || 0,
          oeRemarks: String(row.oeremarks || row.remarks || "").trim(),
          internalRemarks: String(row.internalremarks || "").trim(),
          oeMarking: String(row.oemarking || "").trim(),
          oeQty: Number(row.oeqty || 0) || 0,
          supplier1: String(row.supplier1 || "").trim(),
          supplier1Spn: String(row.supplier1spn || "").trim(),
          supplier2: String(row.supplier2 || "").trim(),
          supplier2Spn: String(row.supplier2spn || "").trim(),
          supplier3: String(row.supplier3 || "").trim(),
          supplier3Pw: String(row.supplier3pw || "").trim(),
          supplier3OePrice: String(row.supplier3oeprice || "").trim(),
          uom: String(row.uom || row.unit || "pcs").trim() || "pcs",
          unitWeight: Number(row.unitweight || row.weight || row.unitweight || 0) || 0,
          category: String(row.category || row.vertical || "General").trim() || "General",
          minStock: Number(row.minstock || row.min || 0) || 0,
          location: String(row.location || "").trim(),
        };
      });

      const filtered = itemsFromExcel.filter((row) => row.name);
      if (!filtered.length) {
        setErr("Excel has no valid rows (each row needs Item Name).");
        return;
      }

      const results = await Promise.allSettled(
        filtered.map((row) => apiPost("/items", row))
      );
      const created = results.filter((r) => r.status === "fulfilled").length;
      const failed = results.length - created;
      if (failed) {
        setErr(
          `Imported ${created} items. ${failed} failed (invalid or duplicate).`
        );
      } else {
        setErr(`Imported ${created} items successfully.`);
      }
      await load();
    } catch (e) {
      setErr(e.message || "Failed to import items from Excel.");
    }
  }

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border bg-white p-6">
        <h1 className="text-xl font-semibold">Item Master</h1>
        <p className="mt-1 text-gray-600">
          Now connected to MongoDB ✅
        </p>

        {err && (
          <div className="mt-3 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">
            {err}
          </div>
        )}
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="rounded-2xl border bg-white p-6">
          <h2 className="text-base font-semibold">Add Item</h2>

          <form onSubmit={addItem} className="mt-4 space-y-3">
            <div>
              <label className="text-sm text-gray-600">SKU / Part No</label>
              <input
                name="sku"
                value={form.sku}
                onChange={onChange}
                className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
                placeholder="e.g. 034.12.001"
              />
            </div>

            <div>
              <label className="text-sm text-gray-600">Item Name *</label>
              <input
                name="name"
                value={form.name}
                onChange={onChange}
                className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
                placeholder="e.g. Piston Pin"
              />
            </div>
            <div>
              <label className="text-sm text-gray-600">Vendor</label>
              <input
                name="vendor"
                value={form.vendor}
                onChange={onChange}
                className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-sm text-gray-600">Engine</label>
                <input
                  name="engine"
                  value={form.engine}
                  onChange={onChange}
                  className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="text-sm text-gray-600">Model</label>
                <input
                  name="model"
                  value={form.model}
                  onChange={onChange}
                  className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-sm text-gray-600">Config</label>
                <input
                  name="config"
                  value={form.config}
                  onChange={onChange}
                  className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="text-sm text-gray-600">C</label>
                <input
                  name="cCode"
                  value={form.cCode}
                  onChange={onChange}
                  className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
                />
              </div>
            </div>
            <div>
              <label className="text-sm text-gray-600">Article</label>
              <input
                name="article"
                value={form.article}
                onChange={onChange}
                className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="text-sm text-gray-600">Description</label>
              <input
                name="description"
                value={form.description}
                onChange={onChange}
                className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-sm text-gray-600">SPN</label>
                <input
                  name="spn"
                  value={form.spn}
                  onChange={onChange}
                  className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="text-sm text-gray-600">Material Code</label>
                <input
                  name="materialCode"
                  value={form.materialCode}
                  onChange={onChange}
                  className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-sm text-gray-600">Drawing Number</label>
                <input
                  name="drawingNumber"
                  value={form.drawingNumber}
                  onChange={onChange}
                  className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="text-sm text-gray-600">Rev</label>
                <input
                  name="rev"
                  value={form.rev}
                  onChange={onChange}
                  className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
                />
              </div>
            </div>
            <div>
              <label className="text-sm text-gray-600">Formula</label>
              <input
                name="formula"
                value={form.formula}
                onChange={onChange}
                className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-sm text-gray-600">QTY</label>
                <input
                  name="qty"
                  type="number"
                  min="0"
                  value={form.qty}
                  onChange={onChange}
                  className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="text-sm text-gray-600">OE QTY</label>
                <input
                  name="oeQty"
                  type="number"
                  min="0"
                  value={form.oeQty}
                  onChange={onChange}
                  className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
                />
              </div>
            </div>
            <div>
              <label className="text-sm text-gray-600">OE Remarks</label>
              <input
                name="oeRemarks"
                value={form.oeRemarks}
                onChange={onChange}
                className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="text-sm text-gray-600">Internal Remarks</label>
              <input
                name="internalRemarks"
                value={form.internalRemarks}
                onChange={onChange}
                className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="text-sm text-gray-600">OE Marking</label>
              <input
                name="oeMarking"
                value={form.oeMarking}
                onChange={onChange}
                className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-sm text-gray-600">Supplier 1</label>
                <input
                  name="supplier1"
                  value={form.supplier1}
                  onChange={onChange}
                  className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="text-sm text-gray-600">Supplier 1 SPN</label>
                <input
                  name="supplier1Spn"
                  value={form.supplier1Spn}
                  onChange={onChange}
                  className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-sm text-gray-600">Supplier 2</label>
                <input
                  name="supplier2"
                  value={form.supplier2}
                  onChange={onChange}
                  className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="text-sm text-gray-600">Supplier 2 SPN</label>
                <input
                  name="supplier2Spn"
                  value={form.supplier2Spn}
                  onChange={onChange}
                  className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
                />
              </div>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="text-sm text-gray-600">Supplier 3</label>
                <input
                  name="supplier3"
                  value={form.supplier3}
                  onChange={onChange}
                  className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="text-sm text-gray-600">Supplier 3 PW</label>
                <input
                  name="supplier3Pw"
                  value={form.supplier3Pw}
                  onChange={onChange}
                  className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="text-sm text-gray-600">Supplier 3 OE Price</label>
                <input
                  name="supplier3OePrice"
                  value={form.supplier3OePrice}
                  onChange={onChange}
                  className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
                />
              </div>
            </div>

            <div>
              <label className="text-sm text-gray-600">UOM</label>
              <select
                name="uom"
                value={form.uom}
                onChange={onChange}
                className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
              >
                <option value="pcs">pcs</option>
                <option value="set">set</option>
                <option value="kg">kg</option>
                <option value="ltr">ltr</option>
                <option value="box">box</option>
              </select>
            </div>

            <div>
              <label className="text-sm text-gray-600">Unit Weight</label>
              <input
                name="unitWeight"
                value={form.unitWeight}
                onChange={onChange}
                type="number"
                min="0"
                step="any"
                className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
                placeholder="e.g. 0.5"
              />
            </div>

            <div>
              <label className="text-sm text-gray-600">Category</label>
              <input
                name="category"
                value={form.category}
                onChange={onChange}
                className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
              />
            </div>

            <div>
              <label className="text-sm text-gray-600">Min Stock</label>
              <input
                name="minStock"
                value={form.minStock}
                onChange={onChange}
                type="number"
                min="0"
                className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
              />
            </div>

            <div>
              <label className="text-sm text-gray-600">Location</label>
              <input
                name="location"
                value={form.location}
                onChange={onChange}
                className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
              />
            </div>

            <button
              type="submit"
              className="w-full rounded-xl bg-gray-900 px-4 py-2 text-sm font-semibold text-white"
            >
              + Add Item
            </button>
          </form>
        </div>

        <div className="rounded-2xl border bg-white p-6 lg:col-span-2">
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <h2 className="text-base font-semibold">Items</h2>

            <div className="flex flex-wrap gap-2">
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                className="w-full md:w-80 rounded-xl border px-3 py-2 text-sm"
                placeholder="Search..."
              />
              <button
                onClick={load}
                className="rounded-xl border px-3 py-2 text-sm hover:bg-gray-50"
              >
                Refresh
              </button>
              <button
                onClick={exportItemsCsv}
                className="rounded-xl border px-3 py-2 text-sm hover:bg-gray-50"
              >
                Export CSV
              </button>
              <button
                onClick={exportItemsPdf}
                className="rounded-xl border px-3 py-2 text-sm hover:bg-gray-50"
              >
                Export PDF
              </button>
              <label className="inline-flex cursor-pointer items-center rounded-xl border px-3 py-2 text-sm hover:bg-gray-50">
                <span>Import Excel</span>
                <input
                  type="file"
                  accept=".xlsx,.xls,.csv"
                  onChange={(e) => handleItemImport(e.target.files?.[0])}
                  className="hidden"
                />
              </label>
            </div>
          </div>

          <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
            <div>
              <label className="text-xs text-gray-600">Vendor</label>
              <select
                value={filters.vendor}
                onChange={(e) => setFilters((p) => ({ ...p, vendor: e.target.value }))}
                className="mt-0.5 w-full rounded-lg border px-2 py-1.5 text-sm"
              >
                <option value="">All</option>
                {filterOptions.vendor.map((v) => (
                  <option key={v} value={v}>{v}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-xs text-gray-600">Engine</label>
              <select
                value={filters.engine}
                onChange={(e) => setFilters((p) => ({ ...p, engine: e.target.value }))}
                className="mt-0.5 w-full rounded-lg border px-2 py-1.5 text-sm"
              >
                <option value="">All</option>
                {filterOptions.engine.map((v) => (
                  <option key={v} value={v}>{v}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-xs text-gray-600">Model</label>
              <select
                value={filters.model}
                onChange={(e) => setFilters((p) => ({ ...p, model: e.target.value }))}
                className="mt-0.5 w-full rounded-lg border px-2 py-1.5 text-sm"
              >
                <option value="">All</option>
                {filterOptions.model.map((v) => (
                  <option key={v} value={v}>{v}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-xs text-gray-600">Config</label>
              <select
                value={filters.config}
                onChange={(e) => setFilters((p) => ({ ...p, config: e.target.value }))}
                className="mt-0.5 w-full rounded-lg border px-2 py-1.5 text-sm"
              >
                <option value="">All</option>
                {filterOptions.config.map((v) => (
                  <option key={v} value={v}>{v}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-xs text-gray-600">Article</label>
              <select
                value={filters.article}
                onChange={(e) => setFilters((p) => ({ ...p, article: e.target.value }))}
                className="mt-0.5 w-full rounded-lg border px-2 py-1.5 text-sm"
              >
                <option value="">All</option>
                {filterOptions.article.map((v) => (
                  <option key={v} value={v}>{v}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-xs text-gray-600">Category</label>
              <select
                value={filters.category}
                onChange={(e) => setFilters((p) => ({ ...p, category: e.target.value }))}
                className="mt-0.5 w-full rounded-lg border px-2 py-1.5 text-sm"
              >
                <option value="">All</option>
                {filterOptions.category.map((v) => (
                  <option key={v} value={v}>{v}</option>
                ))}
              </select>
            </div>
          </div>
          <p className="mt-1 text-xs text-gray-500">
            {filtered.length} of {items.length} items
          </p>

          <div className="mt-4">
            {loading ? (
              <div className="text-sm text-gray-600">Loading...</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="border-b text-gray-600">
                    <tr>
                      <th className="py-2 pr-3">Vendor</th>
                      <th className="py-2 pr-3">Engine</th>
                      <th className="py-2 pr-3">Model</th>
                      <th className="py-2 pr-3">Config</th>
                      <th className="py-2 pr-3">C</th>
                      <th className="py-2 pr-3">Article</th>
                      <th className="py-2 pr-3">Description</th>
                      <th className="py-2 pr-3">Item Name</th>
                      <th className="py-2 pr-3">SPN</th>
                      <th className="py-2 pr-3">Material Code</th>
                      <th className="py-2 pr-3">Drawing Number</th>
                      <th className="py-2 pr-3">Rev</th>
                      <th className="py-2 pr-3">Formula</th>
                      <th className="py-2 pr-3">QTY</th>
                      <th className="py-2 pr-3">OE Remarks</th>
                      <th className="py-2 pr-3">Internal Remarks</th>
                      <th className="py-2 pr-3">OE Marking</th>
                      <th className="py-2 pr-3">OE QTY</th>
                      <th className="py-2 pr-3">Supplier 1 / SPN</th>
                      <th className="py-2 pr-3">Supplier 2 / SPN</th>
                      <th className="py-2 pr-3">Supplier 3 / PW / OE Price</th>
                      <th className="py-2 pr-3">Part No</th>
                      <th className="py-2 pr-3">UOM</th>
                      <th className="py-2 pr-3">Unit Weight</th>
                      <th className="py-2 pr-3">Category</th>
                      <th className="py-2 pr-3">Min</th>
                      <th className="py-2 pr-3">Location</th>
                      <th className="py-2"></th>
                    </tr>
                  </thead>

                  <tbody>
                    {filtered.length === 0 ? (
                      <tr>
                        <td className="py-6 text-gray-500" colSpan={28}>
                          No items yet.
                        </td>
                      </tr>
                    ) : (
                      filtered.map((it) => (
                        <tr key={it._id} className="border-b last:border-b-0">
                          <td className="py-2 pr-3">{it.vendor || "-"}</td>
                          <td className="py-2 pr-3">{it.engine || "-"}</td>
                          <td className="py-2 pr-3">{it.model || "-"}</td>
                          <td className="py-2 pr-3">{it.config || "-"}</td>
                          <td className="py-2 pr-3">{it.cCode || "-"}</td>
                          <td className="py-2 pr-3">{it.article || "-"}</td>
                          <td className="py-2 pr-3">{it.description || "-"}</td>
                          <td className="py-2 pr-3">{it.name}</td>
                          <td className="py-2 pr-3">{it.spn || "-"}</td>
                          <td className="py-2 pr-3">{it.materialCode || "-"}</td>
                          <td className="py-2 pr-3">{it.drawingNumber || "-"}</td>
                          <td className="py-2 pr-3">{it.rev || "-"}</td>
                          <td className="py-2 pr-3">{it.formula || "-"}</td>
                          <td className="py-2 pr-3">{it.qty ?? 0}</td>
                          <td className="py-2 pr-3">{it.oeRemarks || "-"}</td>
                          <td className="py-2 pr-3">{it.internalRemarks || "-"}</td>
                          <td className="py-2 pr-3">{it.oeMarking || "-"}</td>
                          <td className="py-2 pr-3">{it.oeQty ?? 0}</td>
                          <td className="py-2 pr-3">
                            {(it.supplier1 || "-") +
                              (it.supplier1Spn ? ` / ${it.supplier1Spn}` : "")}
                          </td>
                          <td className="py-2 pr-3">
                            {(it.supplier2 || "-") +
                              (it.supplier2Spn ? ` / ${it.supplier2Spn}` : "")}
                          </td>
                          <td className="py-2 pr-3">
                            {(it.supplier3 || "-") +
                              (it.supplier3Pw ? ` / ${it.supplier3Pw}` : "") +
                              (it.supplier3OePrice
                                ? ` / ${it.supplier3OePrice}`
                                : "")}
                          </td>
                          <td className="py-2 pr-3 font-medium">{it.sku || "-"}</td>
                          <td className="py-2 pr-3">{it.uom}</td>
                          <td className="py-2 pr-3">{it.unitWeight ?? 0}</td>
                          <td className="py-2 pr-3">{it.category}</td>
                          <td className="py-2 pr-3">{it.minStock ?? 0}</td>
                          <td className="py-2 pr-3">{it.location || "-"}</td>
                          <td className="py-2 text-right">
                            <button
                              onClick={() => removeItem(it._id)}
                              className="rounded-lg border px-3 py-1 text-xs hover:bg-gray-50"
                            >
                              Delete
                            </button>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>

                <div className="mt-3 text-xs text-gray-500">
                  Total items: {items.length}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
