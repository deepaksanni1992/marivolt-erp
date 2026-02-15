import { useEffect, useMemo, useState } from "react";
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import * as XLSX from "xlsx";
import { apiDelete, apiGet, apiPost, apiPut } from "../lib/api.js";

const SUB_TABS = ["Items", "BOM", "Kitting", "De-Kitting"];

export default function ItemMaster() {
  const [activeSub, setActiveSub] = useState("Items");
  const [items, setItems] = useState([]);
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const columnFilterKeys = [
    "vendor", "engine", "model", "config", "cCode", "article", "mpn", "description", "name", "spn",
    "materialCode", "drawingNumber", "rev", "formula", "qty", "oeRemarks", "internalRemarks", "oeMarking", "oeQty",
    "supplier1", "supplier2", "supplier3", "sku", "uom", "unitWeight", "category", "minStock", "location",
  ];
  const [columnFilters, setColumnFilters] = useState(() =>
    Object.fromEntries(columnFilterKeys.map((k) => [k, ""]))
  );

  const [form, setForm] = useState({
    sku: "",
    name: "",
    vendor: "",
    engine: "",
    model: "",
    config: "",
    cCode: "",
    article: "",
    mpn: "",
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

  const getCellValue = (it, key) => {
    if (key === "supplier1") return `${it.supplier1 || ""} ${it.supplier1Spn || ""}`.trim();
    if (key === "supplier2") return `${it.supplier2 || ""} ${it.supplier2Spn || ""}`.trim();
    if (key === "supplier3") return `${it.supplier3 || ""} ${it.supplier3Pw || ""} ${it.supplier3OePrice || ""}`.trim();
    const v = it[key];
    return v === undefined || v === null ? "" : String(v);
  };

  const filtered = useMemo(() => {
    let result = items;
    const query = q.trim().toLowerCase();
    if (query) {
      result = result.filter((it) =>
        columnFilterKeys.some((key) => getCellValue(it, key).toLowerCase().includes(query))
      );
    }
    columnFilterKeys.forEach((key) => {
      const f = (columnFilters[key] || "").trim().toLowerCase();
      if (!f) return;
      result = result.filter((it) => getCellValue(it, key).toLowerCase().includes(f));
    });
    return result;
  }, [items, q, columnFilters]);

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
        "Vertical",
        "Model",
        "Model",
        "Config",
        "C",
        "Article",
        "MPN",
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
        it.mpn || "",
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
          "Vertical",
          "Model",
          "Model",
          "Config",
          "C",
          "Article",
          "MPN",
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
        it.mpn || "",
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
        mpn: form.mpn.trim(),
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
        mpn: "",
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
          mpn: String(row.mpn || "").trim(),
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

        <div className="mt-4 flex gap-2 border-b border-gray-200">
          {SUB_TABS.map((tab) => (
            <button
              key={tab}
              type="button"
              onClick={() => setActiveSub(tab)}
              className={`rounded-t-lg border px-4 py-2 text-sm font-medium ${
                activeSub === tab
                  ? "border-b-0 border-gray-300 bg-white text-gray-900 -mb-px"
                  : "border-transparent bg-transparent text-gray-600 hover:bg-gray-100"
              }`}
            >
              {tab}
            </button>
          ))}
        </div>
      </div>

      {activeSub === "Items" && (
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
              <label className="text-sm text-gray-600">Vertical</label>
              <input
                name="vendor"
                value={form.vendor}
                onChange={onChange}
                className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-sm text-gray-600">Model</label>
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
              <label className="text-sm text-gray-600">MPN</label>
              <input
                name="mpn"
                value={form.mpn}
                onChange={onChange}
                className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
                placeholder="Manufacturer Part Number"
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

          <div className="mt-4">
            {loading ? (
              <div className="text-sm text-gray-600">Loading...</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="border-b text-gray-600">
                    <tr>
                      <th className="py-2 pr-3">Vertical</th>
                      <th className="py-2 pr-3">Model</th>
                      <th className="py-2 pr-3">Model</th>
                      <th className="py-2 pr-3">Config</th>
                      <th className="py-2 pr-3">C</th>
                      <th className="py-2 pr-3">Article</th>
                      <th className="py-2 pr-3">MPN</th>
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
                    <tr className="bg-gray-50">
                      {columnFilterKeys.map((key) => (
                        <th key={key} className="p-1">
                          <input
                            type="text"
                            value={columnFilters[key]}
                            onChange={(e) =>
                              setColumnFilters((p) => ({ ...p, [key]: e.target.value }))
                            }
                            placeholder="Filter..."
                            className="w-full min-w-0 rounded border border-gray-200 px-1.5 py-0.5 text-xs"
                          />
                        </th>
                      ))}
                      <th className="p-1 w-12"></th>
                    </tr>
                  </thead>

                  <tbody>
                    {filtered.length === 0 ? (
                      <tr>
                        <td className="py-6 text-gray-500" colSpan={29}>
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
                          <td className="py-2 pr-3">{it.mpn || "-"}</td>
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
                  Showing {filtered.length} of {items.length} items
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
      )}

      {activeSub === "BOM" && (
        <BOMView items={items} loadItems={load} onError={setErr} />
      )}
      {activeSub === "Kitting" && (
        <KittingView items={items} onError={setErr} />
      )}
      {activeSub === "De-Kitting" && (
        <DeKittingView items={items} onError={setErr} />
      )}
    </div>
  );
}

// --- BOM sub-view ---
function BOMView({ items, loadItems, onError }) {
  const [boms, setBoms] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState(null);
  const [parentVertical, setParentVertical] = useState("");
  const [parentModel, setParentModel] = useState("");
  const [parentItemId, setParentItemId] = useState("");
  const [bomName, setBomName] = useState("");
  const [lines, setLines] = useState([{ vertical: "", model: "", itemId: "", qty: 1 }]);

  const verticals = useMemo(() => [...new Set(items.map((i) => i.vendor).filter(Boolean))].sort(), [items]);
  const parentModels = useMemo(
    () => (parentVertical ? [...new Set(items.filter((i) => i.vendor === parentVertical).map((i) => i.model).filter(Boolean))].sort() : []),
    [items, parentVertical]
  );
  const parentArticles = useMemo(
    () =>
      parentVertical && parentModel
        ? items.filter((i) => i.vendor === parentVertical && i.model === parentModel)
        : [],
    [items, parentVertical, parentModel]
  );

  async function loadBoms() {
    setLoading(true);
    try {
      const data = await apiGet("/bom");
      setBoms(data);
    } catch (e) {
      onError(e.message || "Failed to load BOMs");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadBoms();
  }, []);

  function addLine() {
    setLines((p) => [...p, { vertical: "", model: "", itemId: "", qty: 1 }]);
  }
  function removeLine(i) {
    setLines((p) => p.filter((_, idx) => idx !== i));
  }
  function setLine(i, field, value) {
    setLines((p) =>
      p.map((row, idx) => {
        if (idx !== i) return row;
        const next = { ...row, [field]: value };
        if (field === "vertical") next.model = "";
        if (field === "vertical" || field === "model") next.itemId = "";
        return next;
      })
    );
  }

  async function saveBom() {
    if (!parentItemId) {
      onError("Select a parent item");
      return;
    }
    const validLines = lines.filter((l) => l.itemId && Number(l.qty) > 0);
    if (!validLines.length) {
      onError("Add at least one component with qty > 0");
      return;
    }
    onError("");
    try {
      if (editingId) {
        await apiPut(`/bom/${editingId}`, {
          parentItemId,
          name: bomName,
          lines: validLines.map((l) => ({ itemId: l.itemId, qty: Number(l.qty) })),
        });
        setEditingId(null);
      } else {
        await apiPost("/bom", {
          parentItemId,
          name: bomName,
          lines: validLines.map((l) => ({ itemId: l.itemId, qty: Number(l.qty) })),
        });
      }
      setParentVertical("");
      setParentModel("");
      setParentItemId("");
      setBomName("");
      setLines([{ vertical: "", model: "", itemId: "", qty: 1 }]);
      await loadBoms();
      if (items.length === 0) loadItems();
    } catch (e) {
      onError(e.message || "Failed to save BOM");
    }
  }

  function editBom(bom) {
    setEditingId(bom._id);
    const parent = bom.parentItemId || {};
    const pItem = typeof parent === "object" ? parent : items.find((i) => i._id === parent);
    setParentVertical(pItem?.vendor ?? "");
    setParentModel(pItem?.model ?? "");
    setParentItemId(bom.parentItemId?._id || bom.parentItemId);
    setBomName(bom.name || "");
    setLines(
      (bom.lines && bom.lines.length)
        ? bom.lines.map((l) => {
            const lit = l.itemId && (typeof l.itemId === "object" ? l.itemId : items.find((i) => i._id === l.itemId));
            return {
              vertical: lit?.vendor ?? "",
              model: lit?.model ?? "",
              itemId: (l.itemId && l.itemId._id) || l.itemId,
              qty: l.qty ?? 1,
            };
          })
        : [{ vertical: "", model: "", itemId: "", qty: 1 }]
    );
  }

  async function deleteBom(id) {
    if (!confirm("Delete this BOM?")) return;
    try {
      await apiDelete(`/bom/${id}`);
      await loadBoms();
    } catch (e) {
      onError(e.message || "Failed to delete BOM");
    }
  }

  function exportBomExcel() {
    const headers = [
      "BOM Name", "Parent Vertical", "Parent Model", "Parent Article", "Parent Description", "Parent SPN", "Parent Unit Weight",
      "Comp Vertical", "Comp Model", "Comp Article", "Comp Description", "Comp SPN", "Comp Unit Wt", "Qty", "Total Wt",
    ];
    const rows = [];
    boms.forEach((bom) => {
      const parent = bom.parentItemId || {};
      const pV = parent.vendor ?? "";
      const pArt = bom.parentArticle || parent.article || "";
      const pDesc = bom.parentDescription || parent.description || "";
      const pSpn = bom.parentSpn || parent.spn || "";
      const pUw = bom.parentUnitWeight ?? parent.unitWeight ?? 0;
      const pM = parent.model ?? "";
      if (!bom.lines || bom.lines.length === 0) {
        rows.push([bom.name || "", pV, pM, pArt, pDesc, pSpn, pUw, "", "", "", "", "", "", "", "", ""]);
      } else {
        bom.lines.forEach((l) => {
          const compItem = l.itemId && typeof l.itemId === "object" ? l.itemId : items.find((i) => i._id === l.itemId);
          const cV = compItem?.vendor ?? "";
          const cM = compItem?.model ?? "";
          const lUw = l.unitWeight ?? 0;
          const lQty = l.qty ?? 0;
          rows.push([
            bom.name || "", pV, pM, pArt, pDesc, pSpn, pUw,
            cV, cM, l.article || "", l.description || "", l.spn || "", lUw, lQty, (lUw * lQty).toFixed(3),
          ]);
        });
      }
    });
    const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "BOM");
    const wbout = XLSX.write(wb, { bookType: "xlsx", type: "array" });
    const blob = new Blob([wbout], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = "bom-export.xlsx";
    link.click();
    URL.revokeObjectURL(link.href);
  }

  async function handleBomImport(file) {
    if (!file) return;
    onError("");
    try {
      const buffer = await file.arrayBuffer();
      const wb = XLSX.read(buffer, { type: "array" });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });
      const normalize = (row) => {
        const e = {};
        Object.entries(row).forEach(([k, v]) => {
          e[String(k).toLowerCase().replace(/\s+/g, "")] = v;
        });
        return e;
      };
      const normalized = rows.map(normalize);
      const key = (r) => `${(r.bomname || "").trim()}|${(r.parentvertical || "").trim()}|${(r.parentmodel || "").trim()}|${(r.parentarticle || "").trim()}`;
      const groups = {};
      normalized.forEach((r) => {
        const k = key(r);
        if (!groups[k]) groups[k] = [];
        groups[k].push(r);
      });
      let created = 0;
      let failed = 0;
      for (const group of Object.values(groups)) {
        if (!group.length) continue;
        const first = group[0];
        const parentVertical = String(first.parentvertical ?? "").trim();
        const parentModel = String(first.parentmodel ?? "").trim();
        const parentArticle = String(first.parentarticle ?? "").trim();
        const bomName = String(first.bomname ?? "").trim();
        const parentItem = items.find((i) => i.vendor === parentVertical && i.model === parentModel && (i.article || "").trim() === parentArticle);
        if (!parentItem) {
          failed++;
          continue;
        }
        const lineItems = [];
        for (const r of group) {
          const cV = String(r.compvertical ?? r.cv ?? "").trim();
          const cM = String(r.compmodel ?? r.cm ?? "").trim();
          const cArt = String(r.comparticle ?? r.comp ?? "").trim();
          const qty = Number(r.qty ?? 1) || 0;
          if (!cV && !cM && !cArt) continue;
          const compItem = items.find((i) => i.vendor === cV && i.model === cM && (i.article || "").trim() === cArt);
          if (compItem && compItem._id !== parentItem._id) lineItems.push({ itemId: compItem._id, qty });
        }
        if (lineItems.length === 0) continue;
        try {
          await apiPost("/bom", { parentItemId: parentItem._id, name: bomName, lines: lineItems });
          created++;
        } catch {
          failed++;
        }
      }
      onError(created ? `Imported ${created} BOM(s). ${failed} failed.` : failed ? `Import failed for all rows (check Vertical/Model/Article).` : "No valid BOM rows.");
      await loadBoms();
    } catch (e) {
      onError(e.message || "Failed to import BOM from Excel.");
    }
  }

  return (
    <div className="rounded-2xl border bg-white p-6">
      <h2 className="text-base font-semibold">Bill of Materials (BOM)</h2>
      <p className="mt-1 text-sm text-gray-600">
        Define parent item and component lines by Article. Parent and components need Article for Kitting/De-Kitting.
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" onClick={exportBomExcel} className="rounded-xl border border-gray-300 bg-white px-3 py-2 text-sm hover:bg-gray-50">Export Excel</button>
        <label className="inline-flex cursor-pointer items-center rounded-xl border border-gray-300 bg-white px-3 py-2 text-sm hover:bg-gray-50">
          <span>Import Excel</span>
          <input type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={(e) => handleBomImport(e.target.files?.[0])} />
        </label>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div>
              <label className="text-sm text-gray-600">Vertical *</label>
              <select
                value={parentVertical}
                onChange={(e) => {
                  setParentVertical(e.target.value);
                  setParentModel("");
                  setParentItemId("");
                }}
                className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
              >
                <option value="">Select Vertical...</option>
                {verticals.map((v) => (
                  <option key={v} value={v}>{v}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-sm text-gray-600">Model *</label>
              <select
                value={parentModel}
                onChange={(e) => {
                  setParentModel(e.target.value);
                  setParentItemId("");
                }}
                className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
                disabled={!parentVertical}
              >
                <option value="">Select Model...</option>
                {parentModels.map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-sm text-gray-600">Article (Parent) *</label>
              <select
                value={parentItemId}
                onChange={(e) => setParentItemId(e.target.value)}
                className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
                disabled={!parentVertical || !parentModel}
              >
                <option value="">Select Article...</option>
                {parentArticles.map((it) => (
                  <option key={it._id} value={it._id}>
                    {it.article || "—"} {it.description ? ` – ${it.description}` : ""} {it.spn ? ` (${it.spn})` : ""} {it.unitWeight != null ? ` · ${it.unitWeight} kg` : ""}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div>
            <label className="text-sm text-gray-600">BOM name (optional)</label>
            <input
              value={bomName}
              onChange={(e) => setBomName(e.target.value)}
              className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
              placeholder="e.g. v1"
            />
          </div>
          <div>
            <div className="flex items-center justify-between">
              <label className="text-sm text-gray-600">Components (Article, Description, SPN, Unit weight, Qty, Total weight)</label>
              <button
                type="button"
                onClick={addLine}
                className="text-sm text-gray-600 hover:underline"
              >
                + Add line
              </button>
            </div>
            <div className="mt-2 overflow-x-auto">
              <table className="w-full text-left text-sm border rounded-lg">
                <thead className="bg-gray-50 border-b">
                  <tr>
                    <th className="p-2">Vertical</th>
                    <th className="p-2">Model</th>
                    <th className="p-2">Article</th>
                    <th className="p-2">Description</th>
                    <th className="p-2">SPN</th>
                    <th className="p-2">Unit Wt</th>
                    <th className="p-2">Qty</th>
                    <th className="p-2">Total Wt</th>
                    <th className="p-2 w-20"></th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((line, i) => {
                    const lineModels = line.vertical ? [...new Set(items.filter((x) => x.vendor === line.vertical).map((x) => x.model).filter(Boolean))].sort() : [];
                    const lineArticles = line.vertical && line.model
                      ? items.filter((x) => x.vendor === line.vertical && x.model === line.model && x._id !== parentItemId)
                      : [];
                    const it = items.find((x) => x._id === line.itemId);
                    const uwt = it ? (Number(it.unitWeight) || 0) : 0;
                    const totalWt = uwt * (Number(line.qty) || 0);
                    return (
                      <tr key={i} className="border-b last:border-b-0">
                        <td className="p-2">
                          <select
                            value={line.vertical}
                            onChange={(e) => setLine(i, "vertical", e.target.value)}
                            className="w-full min-w-[100px] rounded border px-2 py-1 text-sm"
                          >
                            <option value="">Vertical...</option>
                            {verticals.map((v) => (
                              <option key={v} value={v}>{v}</option>
                            ))}
                          </select>
                        </td>
                        <td className="p-2">
                          <select
                            value={line.model}
                            onChange={(e) => setLine(i, "model", e.target.value)}
                            className="w-full min-w-[100px] rounded border px-2 py-1 text-sm"
                            disabled={!line.vertical}
                          >
                            <option value="">Model...</option>
                            {lineModels.map((m) => (
                              <option key={m} value={m}>{m}</option>
                            ))}
                          </select>
                        </td>
                        <td className="p-2">
                          <select
                            value={line.itemId}
                            onChange={(e) => setLine(i, "itemId", e.target.value)}
                            className="w-full min-w-[120px] rounded border px-2 py-1 text-sm"
                            disabled={!line.vertical || !line.model}
                          >
                            <option value="">Article...</option>
                            {lineArticles.map((item) => (
                              <option key={item._id} value={item._id}>
                                {item.article || "—"}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td className="p-2 text-gray-600">{it ? (it.description || "—") : "—"}</td>
                        <td className="p-2 text-gray-600">{it ? (it.spn || "—") : "—"}</td>
                        <td className="p-2">{it ? (Number(it.unitWeight) || 0) : "—"}</td>
                        <td className="p-2">
                          <input
                            type="number"
                            min="0.001"
                            step="any"
                            value={line.qty}
                            onChange={(e) => setLine(i, "qty", e.target.value)}
                            className="w-20 rounded border px-2 py-1 text-sm"
                          />
                        </td>
                        <td className="p-2 font-medium">{totalWt > 0 ? totalWt.toFixed(3) : "—"}</td>
                        <td className="p-2">
                          <button
                            type="button"
                            onClick={() => removeLine(i)}
                            className="rounded border px-2 py-0.5 text-xs hover:bg-gray-50"
                          >
                            Remove
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={saveBom}
              className="rounded-xl bg-gray-900 px-4 py-2 text-sm font-semibold text-white"
            >
              {editingId ? "Update BOM" : "Save BOM"}
            </button>
            {editingId && (
              <button
                type="button"
                onClick={() => {
                  setEditingId(null);
                  setParentVertical("");
                  setParentModel("");
                  setParentItemId("");
                  setBomName("");
                  setLines([{ vertical: "", model: "", itemId: "", qty: 1 }]);
                }}
                className="rounded-xl border px-4 py-2 text-sm"
              >
                Cancel
              </button>
            )}
          </div>
        </div>

        <div>
          <h3 className="text-sm font-medium text-gray-700">Saved BOMs</h3>
          {loading ? (
            <p className="mt-2 text-sm text-gray-500">Loading...</p>
          ) : boms.length === 0 ? (
            <p className="mt-2 text-sm text-gray-500">No BOMs yet. Create one on the left.</p>
          ) : (
            <ul className="mt-2 space-y-3">
              {boms.map((bom) => {
                const parent = bom.parentItemId || {};
                const parentArticle = bom.parentArticle || parent.article || "—";
                const parentDesc = bom.parentDescription || parent.description || "";
                const parentSpn = bom.parentSpn || parent.spn || "";
                const parentUw = bom.parentUnitWeight ?? parent.unitWeight ?? 0;
                const linesTotalWt = (bom.lines || []).reduce((s, l) => s + ((l.unitWeight ?? 0) * (l.qty ?? 0)), 0);
                return (
                  <li key={bom._id} className="rounded-xl border p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <span className="font-medium">{parentArticle}</span>
                        {parentDesc && <span className="ml-2 text-gray-600">{parentDesc}</span>}
                        {parentSpn && <span className="ml-2 text-gray-500">({parentSpn})</span>}
                        <span className="ml-2 text-gray-400 text-xs">Unit wt: {parentUw} kg</span>
                        {bom.name && <span className="ml-2 text-gray-500">· {bom.name}</span>}
                        <span className="ml-2 text-gray-400 text-xs">{bom.lines?.length ?? 0} line(s)</span>
                      </div>
                      <div className="flex gap-2">
                        <button type="button" onClick={() => editBom(bom)} className="rounded-lg border px-2 py-1 text-xs hover:bg-gray-50">Edit</button>
                        <button type="button" onClick={() => deleteBom(bom._id)} className="rounded-lg border px-2 py-1 text-xs text-red-600 hover:bg-red-50">Delete</button>
                      </div>
                    </div>
                    {(bom.lines && bom.lines.length) > 0 && (
                      <div className="mt-2 overflow-x-auto">
                        <table className="w-full text-xs border rounded">
                          <thead className="bg-gray-50">
                            <tr>
                              <th className="p-1.5 text-left">Article</th>
                              <th className="p-1.5 text-left">Description</th>
                              <th className="p-1.5 text-left">SPN</th>
                              <th className="p-1.5 text-right">Unit Wt</th>
                              <th className="p-1.5 text-right">Qty</th>
                              <th className="p-1.5 text-right">Total Wt</th>
                            </tr>
                          </thead>
                          <tbody>
                            {bom.lines.map((l, idx) => {
                              const lUw = l.unitWeight ?? 0;
                              const lQty = l.qty ?? 0;
                              const lTotal = lUw * lQty;
                              return (
                                <tr key={idx} className="border-t">
                                  <td className="p-1.5">{l.article || "—"}</td>
                                  <td className="p-1.5 text-gray-600">{l.description || "—"}</td>
                                  <td className="p-1.5 text-gray-600">{l.spn || "—"}</td>
                                  <td className="p-1.5 text-right">{lUw}</td>
                                  <td className="p-1.5 text-right">{lQty}</td>
                                  <td className="p-1.5 text-right font-medium">{lTotal.toFixed(3)}</td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                        <p className="mt-1 text-xs text-gray-500">Components total weight: {linesTotalWt.toFixed(3)} kg</p>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

// --- Kitting: consume components, add parent (by Article) ---
function KittingView({ items, onError }) {
  const [boms, setBoms] = useState([]);
  const [selectedBomId, setSelectedBomId] = useState("");
  const [qty, setQty] = useState(1);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const data = await apiGet("/bom");
        if (!cancelled) setBoms(data);
      } catch (e) {
        if (!cancelled) onError(e.message || "Failed to load BOMs");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  async function performKitting() {
    if (!selectedBomId) {
      onError("Select a BOM");
      return;
    }
    const num = Number(qty);
    if (!num || num <= 0) {
      onError("Enter a valid quantity");
      return;
    }
    onError("");
    setBusy(true);
    try {
      const res = await apiPost(`/bom/${selectedBomId}/kit`, { qty: num });
      onError(res.message || "Kitting completed.");
    } catch (e) {
      onError(e.message || "Kitting failed");
    } finally {
      setBusy(false);
    }
  }

  const selectedBom = boms.find((b) => b._id === selectedBomId);
  const parent = selectedBom?.parentItemId || {};
  const parentArticle = selectedBom?.parentArticle || parent.article || "—";
  const parentDesc = selectedBom?.parentDescription || parent.description || "";
  const parentSpn = selectedBom?.parentSpn || parent.spn || "";
  const parentUw = selectedBom?.parentUnitWeight ?? parent.unitWeight ?? 0;
  const kitTotalWt = selectedBom ? (parentUw * (Number(qty) || 0)) : 0;

  function exportKittingExcel() {
    const headers = ["Parent Article", "BOM Name", "Quantity"];
    const rows = boms.map((bom) => {
      const p = bom.parentItemId || {};
      const art = bom.parentArticle || p.article || "—";
      return [art, bom.name || "", 0];
    });
    const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Kitting");
    const wbout = XLSX.write(wb, { bookType: "xlsx", type: "array" });
    const blob = new Blob([wbout], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = "kitting-template.xlsx";
    link.click();
    URL.revokeObjectURL(link.href);
  }

  async function handleKittingImport(file) {
    if (!file) return;
    onError("");
    try {
      const buffer = await file.arrayBuffer();
      const wb = XLSX.read(buffer, { type: "array" });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });
      const normalize = (row) => {
        const e = {};
        Object.entries(row).forEach(([k, v]) => {
          e[String(k).toLowerCase().replace(/\s+/g, "")] = v;
        });
        return e;
      };
      let done = 0;
      let failed = 0;
      for (const r of rows.map(normalize)) {
        const qty = Number(r.quantity ?? r.qty ?? 0) || 0;
        if (qty <= 0) continue;
        const parentArticle = String(r.parentarticle ?? r.article ?? "").trim();
        const bomName = String(r.bomname ?? r.bom ?? "").trim();
        const bom = boms.find((b) => {
          const p = b.parentItemId || {};
          const art = (b.parentArticle || p.article || "").trim();
          const name = (b.name || "").trim();
          return (parentArticle && art === parentArticle) || (bomName && name === bomName);
        });
        if (!bom) {
          failed++;
          continue;
        }
        try {
          await apiPost(`/bom/${bom._id}/kit`, { qty });
          done++;
        } catch {
          failed++;
        }
      }
      onError(done ? `Kitting: ${done} run(s) completed. ${failed} failed.` : failed ? "All rows failed (check Parent Article/BOM Name and Quantity)." : "No valid rows with quantity > 0.");
    } catch (e) {
      onError(e.message || "Failed to import kitting from Excel.");
    }
  }

  return (
    <div className="rounded-2xl border bg-white p-6">
      <h2 className="text-base font-semibold">Kitting</h2>
      <p className="mt-1 text-sm text-gray-600">
        Consume component stock (OUT) and add parent/kit stock (IN) by Article per selected BOM.
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" onClick={exportKittingExcel} className="rounded-xl border border-gray-300 bg-white px-3 py-2 text-sm hover:bg-gray-50">Export Excel</button>
        <label className="inline-flex cursor-pointer items-center rounded-xl border border-gray-300 bg-white px-3 py-2 text-sm hover:bg-gray-50">
          <span>Import Excel</span>
          <input type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={(e) => handleKittingImport(e.target.files?.[0])} />
        </label>
      </div>
      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <div className="space-y-4">
          <div>
            <label className="text-sm text-gray-600">BOM (Parent Article)</label>
            <select
              value={selectedBomId}
              onChange={(e) => setSelectedBomId(e.target.value)}
              className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
              disabled={loading}
            >
              <option value="">Select BOM...</option>
              {boms.map((bom) => {
                const p = bom.parentItemId || {};
                const art = bom.parentArticle || p.article || "—";
                const desc = bom.parentDescription || p.description || "";
                const spn = bom.parentSpn || p.spn || "";
                return (
                  <option key={bom._id} value={bom._id}>
                    {art} {desc ? ` – ${desc}` : ""} {spn ? ` (${spn})` : ""} {bom.name ? ` · ${bom.name}` : ""}
                  </option>
                );
              })}
            </select>
          </div>
          <div>
            <label className="text-sm text-gray-600">Quantity</label>
            <input
              type="number"
              min="1"
              value={qty}
              onChange={(e) => setQty(e.target.value)}
              className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
            />
          </div>
          <button
            type="button"
            onClick={performKitting}
            disabled={busy || !selectedBomId}
            className="rounded-xl bg-gray-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
          >
            {busy ? "Processing..." : "Perform Kitting"}
          </button>
        </div>
        {selectedBom && (
          <div className="rounded-xl border p-4 bg-gray-50">
            <h3 className="text-sm font-medium text-gray-700">Parent (Kit)</h3>
            <p className="mt-1 text-sm"><span className="font-medium">Article:</span> {parentArticle}</p>
            {parentDesc && <p className="text-sm text-gray-600">Description: {parentDesc}</p>}
            {parentSpn && <p className="text-sm text-gray-600">SPN: {parentSpn}</p>}
            <p className="text-sm">Unit weight: {parentUw} kg · Qty: {qty} → Total weight: {kitTotalWt.toFixed(3)} kg</p>
            {(selectedBom.lines && selectedBom.lines.length) > 0 && (
              <>
                <h3 className="mt-3 text-sm font-medium text-gray-700">Components (consumed)</h3>
                <div className="mt-1 overflow-x-auto">
                  <table className="w-full text-xs border rounded">
                    <thead className="bg-white"><tr><th className="p-1.5 text-left">Article</th><th className="p-1.5 text-left">Description</th><th className="p-1.5 text-left">SPN</th><th className="p-1.5 text-right">Unit Wt</th><th className="p-1.5 text-right">Qty</th><th className="p-1.5 text-right">Total Wt</th></tr></thead>
                    <tbody>
                      {selectedBom.lines.map((l, idx) => {
                        const u = l.unitWeight ?? 0;
                        const q = (l.qty ?? 0) * (Number(qty) || 0);
                        return (
                          <tr key={idx} className="border-t"><td className="p-1.5">{l.article || "—"}</td><td className="p-1.5 text-gray-600">{l.description || "—"}</td><td className="p-1.5">{l.spn || "—"}</td><td className="p-1.5 text-right">{u}</td><td className="p-1.5 text-right">{q}</td><td className="p-1.5 text-right">{(u * q).toFixed(3)}</td></tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// --- De-Kitting: reduce parent, add components (by Article) ---
function DeKittingView({ items, onError }) {
  const [boms, setBoms] = useState([]);
  const [selectedBomId, setSelectedBomId] = useState("");
  const [qty, setQty] = useState(1);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const data = await apiGet("/bom");
        if (!cancelled) setBoms(data);
      } catch (e) {
        if (!cancelled) onError(e.message || "Failed to load BOMs");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  async function performDeKitting() {
    if (!selectedBomId) {
      onError("Select a BOM");
      return;
    }
    const num = Number(qty);
    if (!num || num <= 0) {
      onError("Enter a valid quantity");
      return;
    }
    onError("");
    setBusy(true);
    try {
      const res = await apiPost(`/bom/${selectedBomId}/dekit`, { qty: num });
      onError(res.message || "De-kitting completed.");
    } catch (e) {
      onError(e.message || "De-kitting failed");
    } finally {
      setBusy(false);
    }
  }

  const selectedBom = boms.find((b) => b._id === selectedBomId);
  const parent = selectedBom?.parentItemId || {};
  const parentArticle = selectedBom?.parentArticle || parent.article || "—";
  const parentDesc = selectedBom?.parentDescription || parent.description || "";
  const parentSpn = selectedBom?.parentSpn || parent.spn || "";
  const parentUw = selectedBom?.parentUnitWeight ?? parent.unitWeight ?? 0;
  const dekitTotalWt = selectedBom ? (parentUw * (Number(qty) || 0)) : 0;

  function exportDeKittingExcel() {
    const headers = ["Parent Article", "BOM Name", "Quantity"];
    const rows = boms.map((bom) => {
      const p = bom.parentItemId || {};
      const art = bom.parentArticle || p.article || "—";
      return [art, bom.name || "", 0];
    });
    const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "De-Kitting");
    const wbout = XLSX.write(wb, { bookType: "xlsx", type: "array" });
    const blob = new Blob([wbout], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = "dekitting-template.xlsx";
    link.click();
    URL.revokeObjectURL(link.href);
  }

  async function handleDeKittingImport(file) {
    if (!file) return;
    onError("");
    try {
      const buffer = await file.arrayBuffer();
      const wb = XLSX.read(buffer, { type: "array" });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });
      const normalize = (row) => {
        const e = {};
        Object.entries(row).forEach(([k, v]) => {
          e[String(k).toLowerCase().replace(/\s+/g, "")] = v;
        });
        return e;
      };
      let done = 0;
      let failed = 0;
      for (const r of rows.map(normalize)) {
        const qty = Number(r.quantity ?? r.qty ?? 0) || 0;
        if (qty <= 0) continue;
        const parentArticle = String(r.parentarticle ?? r.article ?? "").trim();
        const bomName = String(r.bomname ?? r.bom ?? "").trim();
        const bom = boms.find((b) => {
          const p = b.parentItemId || {};
          const art = (b.parentArticle || p.article || "").trim();
          const name = (b.name || "").trim();
          return (parentArticle && art === parentArticle) || (bomName && name === bomName);
        });
        if (!bom) {
          failed++;
          continue;
        }
        try {
          await apiPost(`/bom/${bom._id}/dekit`, { qty });
          done++;
        } catch {
          failed++;
        }
      }
      onError(done ? `De-kitting: ${done} run(s) completed. ${failed} failed.` : failed ? "All rows failed (check Parent Article/BOM Name and Quantity)." : "No valid rows with quantity > 0.");
    } catch (e) {
      onError(e.message || "Failed to import de-kitting from Excel.");
    }
  }

  return (
    <div className="rounded-2xl border bg-white p-6">
      <h2 className="text-base font-semibold">De-Kitting</h2>
      <p className="mt-1 text-sm text-gray-600">
        Reduce parent/kit stock (OUT) and add component stock (IN) by Article per selected BOM.
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" onClick={exportDeKittingExcel} className="rounded-xl border border-gray-300 bg-white px-3 py-2 text-sm hover:bg-gray-50">Export Excel</button>
        <label className="inline-flex cursor-pointer items-center rounded-xl border border-gray-300 bg-white px-3 py-2 text-sm hover:bg-gray-50">
          <span>Import Excel</span>
          <input type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={(e) => handleDeKittingImport(e.target.files?.[0])} />
        </label>
      </div>
      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <div className="space-y-4">
          <div>
            <label className="text-sm text-gray-600">BOM (Parent Article)</label>
            <select
              value={selectedBomId}
              onChange={(e) => setSelectedBomId(e.target.value)}
              className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
              disabled={loading}
            >
              <option value="">Select BOM...</option>
              {boms.map((bom) => {
                const p = bom.parentItemId || {};
                const art = bom.parentArticle || p.article || "—";
                const desc = bom.parentDescription || p.description || "";
                const spn = bom.parentSpn || p.spn || "";
                return (
                  <option key={bom._id} value={bom._id}>
                    {art} {desc ? ` – ${desc}` : ""} {spn ? ` (${spn})` : ""} {bom.name ? ` · ${bom.name}` : ""}
                  </option>
                );
              })}
            </select>
          </div>
          <div>
            <label className="text-sm text-gray-600">Quantity</label>
            <input
              type="number"
              min="1"
              value={qty}
              onChange={(e) => setQty(e.target.value)}
              className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
            />
          </div>
          <button
            type="button"
            onClick={performDeKitting}
            disabled={busy || !selectedBomId}
            className="rounded-xl bg-gray-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
          >
            {busy ? "Processing..." : "Perform De-Kitting"}
          </button>
        </div>
        {selectedBom && (
          <div className="rounded-xl border p-4 bg-gray-50">
            <h3 className="text-sm font-medium text-gray-700">Parent (Kit) – to reduce</h3>
            <p className="mt-1 text-sm"><span className="font-medium">Article:</span> {parentArticle}</p>
            {parentDesc && <p className="text-sm text-gray-600">Description: {parentDesc}</p>}
            {parentSpn && <p className="text-sm text-gray-600">SPN: {parentSpn}</p>}
            <p className="text-sm">Unit weight: {parentUw} kg · Qty: {qty} → Total weight: {dekitTotalWt.toFixed(3)} kg</p>
            {(selectedBom.lines && selectedBom.lines.length) > 0 && (
              <>
                <h3 className="mt-3 text-sm font-medium text-gray-700">Components (added back)</h3>
                <div className="mt-1 overflow-x-auto">
                  <table className="w-full text-xs border rounded">
                    <thead className="bg-white"><tr><th className="p-1.5 text-left">Article</th><th className="p-1.5 text-left">Description</th><th className="p-1.5 text-left">SPN</th><th className="p-1.5 text-right">Unit Wt</th><th className="p-1.5 text-right">Qty</th><th className="p-1.5 text-right">Total Wt</th></tr></thead>
                    <tbody>
                      {selectedBom.lines.map((l, idx) => {
                        const u = l.unitWeight ?? 0;
                        const q = (l.qty ?? 0) * (Number(qty) || 0);
                        return (
                          <tr key={idx} className="border-t"><td className="p-1.5">{l.article || "—"}</td><td className="p-1.5 text-gray-600">{l.description || "—"}</td><td className="p-1.5">{l.spn || "—"}</td><td className="p-1.5 text-right">{u}</td><td className="p-1.5 text-right">{q}</td><td className="p-1.5 text-right">{(u * q).toFixed(3)}</td></tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
