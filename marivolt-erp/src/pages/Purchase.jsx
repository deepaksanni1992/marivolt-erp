import { useEffect, useMemo, useState } from "react";
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import * as XLSX from "xlsx";
import { apiDelete, apiGet, apiGetWithQuery, apiPost } from "../lib/api.js";

let headerImagePromise;

const TOP_MARGIN_MM = 38.1; // 1.5"
const TOP_LINE_HEIGHT_MM = 4;
const TOP_LINE_COUNT = 3;
const EXTRA_TOP_SPACE_MM = TOP_LINE_HEIGHT_MM * TOP_LINE_COUNT;
const HEADER_MARGIN_X = 14;
const HEADER_TOP_Y = 6;
const FOOTER_MARGIN_MM = 38.1; // 1.5"
const FOOTER_SAFE_GAP_MM = 6;

async function getHeaderImage() {
  if (!headerImagePromise) {
    headerImagePromise = fetch("/marivolt-header.png")
      .then((res) => res.blob())
      .then(
        (blob) =>
          new Promise((resolve) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => resolve(null);
            reader.readAsDataURL(blob);
          })
      )
      .then(
        (dataUrl) =>
          new Promise((resolve) => {
            if (!dataUrl) return resolve(null);
            const img = new Image();
            img.onload = () =>
              resolve({
                dataUrl,
                width: img.naturalWidth,
                height: img.naturalHeight,
              });
            img.onerror = () => resolve(null);
            img.src = dataUrl;
          })
      )
      .catch(() => null);
  }
  return headerImagePromise;
}

function getHeaderLayout(header, pageWidth) {
  if (!header) return null;
  const targetW = pageWidth - HEADER_MARGIN_X * 2;
  const targetH = (targetW * header.height) / header.width;
  return {
    x: HEADER_MARGIN_X,
    y: HEADER_TOP_Y,
    w: targetW,
    h: targetH,
  };
}

function getContentStartY(doc, header) {
  const pageWidth = doc.internal.pageSize.getWidth();
  const layout = getHeaderLayout(header, pageWidth);
  const headerBottom = layout ? layout.y + layout.h : 0;
  return Math.max(TOP_MARGIN_MM, headerBottom) + EXTRA_TOP_SPACE_MM;
}

function addPdfHeader(doc, header) {
  if (!header) return;
  const pageCount = doc.internal.getNumberOfPages();
  const pageWidth = doc.internal.pageSize.getWidth();
  const layout = getHeaderLayout(header, pageWidth);
  if (!layout) return;
  for (let i = 1; i <= pageCount; i += 1) {
    doc.setPage(i);
    doc.addImage(
      header.dataUrl,
      "PNG",
      layout.x,
      layout.y,
      layout.w,
      layout.h
    );
  }
}

function addPdfFooter(doc) {
  const pageCount = doc.internal.getNumberOfPages();
  const leftLines = ["Marivolt FZE", "LV09B"];
  const centerLines = ["Hamriyah freezone phase 2, Sharjah, UAE"];
  const rightLines = [
    "Mob: +971-543053047",
    "Email: sales@marivolt.co",
    "Web: www.marivolt.co",
  ];
  doc.setFontSize(8);
  const maxLines = Math.max(
    leftLines.length,
    centerLines.length,
    rightLines.length
  );
  for (let i = 1; i <= pageCount; i += 1) {
    doc.setPage(i);
    const pageHeight = doc.internal.pageSize.getHeight();
    const pageWidth = doc.internal.pageSize.getWidth();
    const leftX = 14;
    const centerX = pageWidth / 2;
    const rightX = pageWidth - 14;
    const bottomMargin = FOOTER_MARGIN_MM;
    const baseY = pageHeight - bottomMargin - (maxLines - 1) * 4;
    const lineY = baseY + maxLines * 4 + 1.5;
    doc.setDrawColor(255, 173, 20);
    doc.setLineWidth(1.2);
    doc.line(leftX, lineY, rightX, lineY);
    doc.setTextColor(255, 173, 20);
    leftLines.forEach((line, idx) => {
      doc.text(line, leftX, baseY + idx * 4, { align: "left" });
    });
    centerLines.forEach((line, idx) => {
      doc.text(line, centerX, baseY + idx * 4, { align: "center" });
    });
    rightLines.forEach((line, idx) => {
      doc.text(line, rightX, baseY + idx * 4, { align: "right" });
    });
    doc.setTextColor(0, 0, 0);
  }
}

export default function Purchase() {
  const [activeSub, setActiveSub] = useState("Purchase Order");
  const [items, setItems] = useState([]);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(true);
  const [suppliers, setSuppliers] = useState([]);
  const [supplierErr, setSupplierErr] = useState("");
  const [supplierLoading, setSupplierLoading] = useState(false);
  const [supplierQuery, setSupplierQuery] = useState("");
  const [supplierForm, setSupplierForm] = useState({
    name: "",
    contactName: "",
    phone: "",
    email: "",
    address: "",
    gstNo: "",
    panNo: "",
    notes: "",
  });
  const [poForm, setPoForm] = useState({
    supplierId: "",
    supplierName: "",
    supplierAddress: "",
    supplierPhone: "",
    supplierEmail: "",
    contactPerson: "",
    ref: "",
    intRef: "",
    offerDate: "",
    orderDate: "",
    currency: "USD",
    delivery: "Ex-Works",
    insurance: "On buyers account",
    packing: "Inclusive",
    freight: "On buyers account",
    taxes: "N.A.",
    payment: "100% against delivery",
    specialRemarks: "",
    termsAndConditions:
      "Terms & Conditions- The Supplier’s terms of business shall not apply. By accepting this Purchase Order, the Supplier agrees that only the Buyer’s (Marivolt FZE) terms and conditions govern this transaction. All documents, data, drawings, and information shared by the Buyer with the Supplier, including this Purchase Order, are strictly confidential. The Supplier shall not disclose such information to any third party without the prior written consent of the Buyer or any unauthorized party. Any unauthorized disclosure shall be deemed a breach of contract and may result in legal action, including claims for damages and recovery of costs. Breach of contract will trigger UAE legal action and Middle East supplier ban. The customer also reserves the right to take legal action in supplier's respective country of operation. The Supplier warrants that all goods supplied shall be free from defects in material, workmanship, and design, and shall conform to agreed specifications. The warranty period shall be on minimum 18 months from the date of supply. During this period, the Supplier shall, at its own cost and without delay, repair or replace any defective goods and pay for all damages caused as a result of the failure. This warranty is in addition to, and does not limit, any other rights or remedies available to the Buyer under applicable law. The Supplier shall deliver the goods strictly within the agreed timelines. Any failure to supply on time may result in cancellation of the order or the imposition of penalties for delay, at the discretion of the Buyer, without prejudice to any other rights or remedies available under law. Any reference to engine manufacturers' product codes, part numbers, or IMO numbers is strictly for descriptive or reference purposes only. Such references do not imply that the parts originate from the engine manufacturer. If required, confirmation of origin will be provided separately.",
    closingNote:
      "Kindly send us the Order Acknowledgement and Proforma Invoice, with current status of delivery.",
  });
  const [poItems, setPoItems] = useState([
    {
      articleNo: "",
      description: "",
      partNo: "",
      qty: 1,
      uom: "PCS",
      unitRate: "",
      remark: "",
    },
  ]);
  const [poList, setPoList] = useState([]);
  const [poLoading, setPoLoading] = useState(false);
  const [poErr, setPoErr] = useState("");
  const [selectedPoId, setSelectedPoId] = useState("");
  const [poStatementFilters, setPoStatementFilters] = useState({
    from: "",
    to: "",
    supplier: "",
    status: "ALL",
    q: "",
  });
  const [history, setHistory] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyErr, setHistoryErr] = useState("");
  const [historyFilters, setHistoryFilters] = useState({
    from: "",
    to: "",
    sku: "",
    supplier: "",
    q: "",
  });

  const [form, setForm] = useState({
    sku: "",
    qty: 1,
    supplier: "",
    poNo: "",
    note: "",
  });

  async function loadItems() {
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
    loadItems();
  }, []);

  useEffect(() => {
    if (activeSub === "Supplier") {
      loadSuppliers();
    }
    if (activeSub === "Purchase Order") {
      loadSuppliers();
      loadItems();
      loadPurchaseOrders();
      setPoForm((p) => ({
        ...p,
        orderDate: p.orderDate || getTodayDisplay(),
      }));
    }
    if (activeSub === "Purchase Order Statement") {
      loadPurchaseOrders();
    }
  }, [activeSub]);

  const selectedItem = useMemo(
    () => items.find((x) => x.sku === form.sku) || null,
    [items, form.sku]
  );

  function onChange(e) {
    const { name, value } = e.target;
    setForm((p) => ({ ...p, [name]: value }));
  }

  function onSupplierChange(e) {
    const { name, value } = e.target;
    setSupplierForm((p) => ({ ...p, [name]: value }));
  }

  function onPoChange(e) {
    const { name, value } = e.target;
    setPoForm((p) => ({ ...p, [name]: value }));
  }

  function onPoStatementChange(e) {
    const { name, value } = e.target;
    setPoStatementFilters((p) => ({ ...p, [name]: value }));
  }

  function getTodayDisplay() {
    const d = new Date();
    const dd = String(d.getDate()).padStart(2, "0");
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const yyyy = d.getFullYear();
    return `${dd}/${mm}/${yyyy}`;
  }

  function onPoItemChange(index, field, value) {
    setPoItems((prev) =>
      prev.map((row, i) => {
        if (i !== index) return row;
        return { ...row, [field]: value };
      })
    );
  }

  function addPoItem() {
    setPoItems((prev) => [
      ...prev,
      {
        articleNo: "",
        description: "",
        partNo: "",
        qty: 1,
        uom: "PCS",
        unitRate: "",
        remark: "",
      },
    ]);
  }

  function removePoItem(index) {
    setPoItems((prev) => prev.filter((_, i) => i !== index));
  }

  function onHistoryChange(e) {
    const { name, value } = e.target;
    setHistoryFilters((p) => ({ ...p, [name]: value }));
  }

  async function loadHistory() {
    setHistoryErr("");
    setHistoryLoading(true);
    try {
      const data = await apiGetWithQuery("/stock-txns", {
        type: "IN",
        sku: historyFilters.sku.trim() || undefined,
        supplier: historyFilters.supplier.trim() || undefined,
        from: historyFilters.from || undefined,
        to: historyFilters.to || undefined,
      });
      setHistory(data);
    } catch (e) {
      setHistoryErr(e.message || "Failed to load purchase history");
    } finally {
      setHistoryLoading(false);
    }
  }

  async function loadSuppliers() {
    setSupplierErr("");
    setSupplierLoading(true);
    try {
      const data = await apiGet("/suppliers");
      setSuppliers(data);
    } catch (e) {
      setSupplierErr(e.message || "Failed to load suppliers");
    } finally {
      setSupplierLoading(false);
    }
  }

  async function loadPurchaseOrders() {
    setPoErr("");
    setPoLoading(true);
    try {
      const data = await apiGet("/purchase/po");
      setPoList(data);
    } catch (e) {
      setPoErr(e.message || "Failed to load purchase orders");
    } finally {
      setPoLoading(false);
    }
  }

  function applyPurchaseOrder(po) {
    if (!po) return;
    setSelectedPoId(po._id);
    setPoForm({
      supplierId: po.supplierId || "",
      supplierName: po.supplierName || "",
      supplierAddress: po.supplierAddress || "",
      supplierPhone: po.supplierPhone || "",
      supplierEmail: po.supplierEmail || "",
      contactPerson: po.contactPerson || "",
      ref: po.ref || "",
      intRef: po.intRef || "",
      offerDate: po.offerDate || "",
      orderDate: po.orderDate || "",
      currency: po.currency || "USD",
      delivery: po.delivery || "",
      insurance: po.insurance || "",
      packing: po.packing || "",
      freight: po.freight || "",
      taxes: po.taxes || "",
      payment: po.payment || "",
      specialRemarks: po.specialRemarks || "",
      termsAndConditions: po.termsAndConditions || "",
      closingNote: po.closingNote || "",
    });
    setPoItems(
      (po.items || []).map((row) => ({
        articleNo: row.articleNo || "",
        description: row.description || "",
        partNo: row.partNo || "",
        qty: row.qty || 0,
        uom: row.uom || "",
        unitRate: row.unitRate || 0,
        remark: row.remark || "",
      }))
    );
  }

  async function savePurchaseOrder() {
    setPoErr("");
    if (!poForm.supplierName.trim()) {
      setPoErr("Supplier name is required.");
      return;
    }
    if (!poItems.length) {
      setPoErr("At least one item is required.");
      return;
    }

    const itemsPayload = poItems.map((row) => {
      const qty = Number(row.qty) || 0;
      const unitRate = Number(row.unitRate) || 0;
      return {
        sku: "",
        articleNo: row.articleNo || "",
        description: row.description || "",
        partNo: row.partNo || "",
        qty,
        uom: row.uom || "",
        unitRate,
        remark: row.remark || "",
        total: qty * unitRate,
      };
    });

    const payload = {
      ...poForm,
      intRef: poForm.intRef || intRefPreview,
      items: itemsPayload,
      subTotal: poTotals.subTotal,
      grandTotal: poTotals.grandTotal,
    };

    try {
      const created = await apiPost("/purchase/po", payload);
      setPoList((prev) => [created, ...prev]);
      setSelectedPoId(created._id);
      alert("Purchase Order saved ✅");
    } catch (e) {
      setPoErr(e.message || "Failed to save purchase order");
    }
  }

  async function addSupplier(e) {
    e.preventDefault();
    setSupplierErr("");

    if (!supplierForm.name.trim()) {
      setSupplierErr("Supplier name is required.");
      return;
    }

    try {
      const created = await apiPost("/suppliers", {
        ...supplierForm,
        name: supplierForm.name.trim(),
      });
      setSuppliers((prev) => [created, ...prev]);
      setSupplierForm({
        name: "",
        contactName: "",
        phone: "",
        email: "",
        address: "",
        gstNo: "",
        panNo: "",
        notes: "",
      });
    } catch (e2) {
      setSupplierErr(e2.message || "Failed to add supplier");
    }
  }

  async function deleteSupplier(id) {
    const ok = confirm("Delete this supplier?");
    if (!ok) return;
    setSupplierErr("");
    try {
      await apiDelete(`/suppliers/${id}`);
      setSuppliers((prev) => prev.filter((s) => s._id !== id));
    } catch (e) {
      setSupplierErr(e.message || "Failed to delete supplier");
    }
  }

  async function addPurchase(e) {
    e.preventDefault();
    setErr("");

    if (!form.sku) return setErr("Select an item.");
    const qty = Number(form.qty);
    if (!qty || qty <= 0) return setErr("Qty must be > 0.");

    const ref = form.poNo.trim() ? `PO:${form.poNo.trim()}` : "PURCHASE";
    const supplier = form.supplier.trim();

    try {
      await apiPost("/stock-txns", {
        sku: form.sku,
        type: "IN",
        qty,
        ref,
        supplier,
        note: `${form.supplier ? `Supplier: ${form.supplier}. ` : ""}${form.note}`.trim(),
      });

      setForm({ sku: "", qty: 1, supplier: "", poNo: "", note: "" });
      alert("Purchase saved → Stock IN added to DB ✅");
      loadHistory();
    } catch (e2) {
      setErr(e2.message || "Failed to save purchase");
    }
  }

  const historyFiltered = useMemo(() => {
    const query = historyFilters.q.trim().toLowerCase();
    if (!query) return history;
    return history.filter((tx) => {
      const parts = [tx.sku, tx.ref, tx.note, tx.supplier]
        .filter(Boolean)
        .map((v) => String(v).toLowerCase());
      return parts.some((v) => v.includes(query));
    });
  }, [history, historyFilters.q]);

  function getSupplier(tx) {
    if (tx.supplier) return tx.supplier;
    const match = String(tx.note || "").match(/supplier:\s*([^\.]+)/i);
    return match ? match[1].trim() : "";
  }

  const historySummary = useMemo(() => {
    const bySupplier = new Map();
    let totalQty = 0;
    historyFiltered.forEach((tx) => {
      totalQty += Number(tx.qty) || 0;
      const supplier = getSupplier(tx) || "Unknown";
      const entry = bySupplier.get(supplier) || {
        supplier,
        qty: 0,
        count: 0,
      };
      entry.qty += Number(tx.qty) || 0;
      entry.count += 1;
      bySupplier.set(supplier, entry);
    });
    return {
      totalQty,
      totalRows: historyFiltered.length,
      rows: Array.from(bySupplier.values()).sort((a, b) =>
        a.supplier.localeCompare(b.supplier)
      ),
    };
  }, [historyFiltered]);

  const filteredSuppliers = useMemo(() => {
    const q = supplierQuery.trim().toLowerCase();
    if (!q) return suppliers;
    return suppliers.filter((s) =>
      [s.name, s.contactName, s.phone, s.email, s.gstNo, s.panNo, s.address]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(q))
    );
  }, [suppliers, supplierQuery]);

  const poTotals = useMemo(() => {
    const subTotal = poItems.reduce((sum, row) => {
      const qty = Number(row.qty) || 0;
      const rate = Number(row.unitRate) || 0;
      return sum + qty * rate;
    }, 0);
    return {
      subTotal,
      grandTotal: subTotal,
    };
  }, [poItems]);

  function parseOrderDate(value) {
    if (!value) return null;
    const parts = String(value).split("/");
    if (parts.length === 3) {
      const [dd, mm, yyyy] = parts.map((v) => Number(v));
      if (dd && mm && yyyy) return new Date(yyyy, mm - 1, dd);
    }
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  const filteredPoList = useMemo(() => {
    const from = poStatementFilters.from
      ? new Date(poStatementFilters.from)
      : null;
    const to = poStatementFilters.to
      ? new Date(poStatementFilters.to)
      : null;
    const supplierQ = poStatementFilters.supplier.trim().toLowerCase();
    const q = poStatementFilters.q.trim().toLowerCase();

    return poList.filter((po) => {
      const poDate = parseOrderDate(po.orderDate);
      if (from && poDate && poDate < from) return false;
      if (to && poDate && poDate > to) return false;
      if (
        supplierQ &&
        !String(po.supplierName || "").toLowerCase().includes(supplierQ)
      ) {
        return false;
      }
      if (poStatementFilters.status !== "ALL") {
        if (String(po.status || "DRAFT") !== poStatementFilters.status) {
          return false;
        }
      }
      if (q) {
        const hay = [
          po.poNo,
          po.intRef,
          po.supplierName,
          po.currency,
          po.status,
        ]
          .filter(Boolean)
          .map((v) => String(v).toLowerCase());
        if (!hay.some((v) => v.includes(q))) return false;
      }
      return true;
    });
  }, [poList, poStatementFilters]);

  const intRefPreview = useMemo(() => {
    const d = new Date();
    const yy = String(d.getFullYear()).slice(-2);
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    const dateKey = `${yy}${mm}${dd}`;
    const forDate = poList.filter(
      (po) => String(po.intRef || "").startsWith(`${dateKey}.`)
    );
    const nextSeq = String(forDate.length + 1).padStart(2, "0");
    return `${dateKey}.${nextSeq}`;
  }, [poList]);

  const poPreviewPages = useMemo(() => {
    const rowsPerPage = 20;
    return Math.max(1, Math.ceil(poItems.length / rowsPerPage));
  }, [poItems.length]);

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

  function exportHistoryCsv() {
    const rows = [
      ["Date", "Supplier", "SKU", "Qty", "Ref", "Note"],
      ...historyFiltered.map((tx) => [
        new Date(tx.createdAt).toLocaleDateString(),
        getSupplier(tx) || "-",
        tx.sku,
        tx.qty,
        tx.ref || "",
        tx.note || "",
      ]),
    ];
    downloadCsv("purchase-history.csv", rows);
  }

  function exportReportCsv() {
    const rows = [
      ["Supplier", "Total Qty", "Entries"],
      ...historySummary.rows.map((row) => [
        row.supplier,
        row.qty,
        row.count,
      ]),
    ];
    downloadCsv("purchase-report-supplier.csv", rows);
  }

  async function exportPdf(title, headers, body, filename) {
    const doc = new jsPDF({ format: "a4", unit: "mm" });
    doc.setTextColor(0, 0, 0);
    const header = await getHeaderImage();
    const contentStartY = getContentStartY(doc, header);
    doc.text(title, 14, contentStartY);
    autoTable(doc, {
      startY: contentStartY + 6,
      margin: { bottom: FOOTER_MARGIN_MM + FOOTER_SAFE_GAP_MM },
      head: [headers],
      body,
      styles: { fontSize: 9 },
    });
    addPdfHeader(doc, header);
    addPdfFooter(doc);
    doc.save(filename);
  }

  async function exportHistoryPdf() {
    const body = historyFiltered.map((tx) => [
      new Date(tx.createdAt).toLocaleDateString(),
      getSupplier(tx) || "-",
      tx.sku,
      String(tx.qty),
      tx.ref || "",
      tx.note || "",
    ]);
    await exportPdf(
      "Purchase History",
      ["Date", "Supplier", "SKU", "Qty", "Ref", "Note"],
      body,
      "purchase-history.pdf"
    );
  }

  async function exportReportPdf() {
    const body = historySummary.rows.map((row) => [
      row.supplier,
      String(row.qty),
      String(row.count),
    ]);
    await exportPdf(
      "Purchase Report (Supplier)",
      ["Supplier", "Total Qty", "Entries"],
      body,
      "purchase-report-supplier.pdf"
    );
  }

  function applySupplierToPo(supplierId) {
    if (!supplierId) {
      setPoForm((p) => ({
        ...p,
        supplierId: "",
        supplierName: "",
        supplierAddress: "",
        supplierPhone: "",
        supplierEmail: "",
        contactPerson: "",
      }));
      return;
    }
    const supplier = suppliers.find((s) => s._id === supplierId);
    if (!supplier) return;
    setPoForm((p) => ({
      ...p,
      supplierId,
      supplierName: supplier.name || "",
      supplierAddress: supplier.address || "",
      supplierPhone: supplier.phone || "",
      supplierEmail: supplier.email || "",
      contactPerson: supplier.contactName || "",
    }));
  }

  function exportPurchaseOrderCsv() {
    if (!poForm.supplierName.trim()) {
      alert("Supplier name is required for Purchase Order.");
      return;
    }
    const rows = [
      [
        "Pos",
        "Article Nr",
        "Description",
        "Part Nr",
        "Qty",
        "UOM",
        "Unit Rate",
        "Total Amount",
        "Remark",
      ],
      ...poItems.map((row, idx) => {
        const qty = Number(row.qty) || 0;
        const rate = Number(row.unitRate) || 0;
        return [
          String(idx + 1),
          row.articleNo || "",
          row.description || "",
          row.partNo || "",
          String(qty || 0),
          row.uom || "",
          rate ? rate.toFixed(2) : "0.00",
          (qty * rate).toFixed(2),
          row.remark || "",
        ];
      }),
      ["", "", "", "", "", "", "Sub Total", poTotals.subTotal.toFixed(2)],
      [
        "",
        "",
        "",
        "",
        "",
        "",
        "Grand Total",
        poTotals.grandTotal.toFixed(2),
      ],
    ];
    downloadCsv(
      `purchase-order-${poForm.supplierName
        .trim()
        .replace(/\s+/g, "-")
        .toLowerCase()}.csv`,
      rows
    );
  }

  async function handlePoExcelImport(file) {
    if (!file) return;
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
        const articleNo =
          row.articlenr || row.article || row.articleno || row.articlenumber || "";
        const description =
          row.description || row.desc || row.name || row.itemname || "";
        const partNo =
          row.partnr || row.partno || row.part || row.partnumber || "";
        const qty = row.qty || row.quantity || row.q || 0;
        const uom = row.uom || row.unit || row.units || "PCS";
        const unitRate = row.unitrate || row.rate || row.price || row.unitprice || 0;
        const remark = row.remark || row.remarks || row.note || "";

      return {
          articleNo: String(articleNo || "").trim(),
          description: String(description || "").trim(),
          partNo: String(partNo || "").trim(),
          qty: Number(qty) || 0,
          uom: String(uom || "").trim(),
          unitRate: Number(unitRate) || 0,
          remark: String(remark || "").trim(),
        };
      });

      const filtered = itemsFromExcel.filter(
        (row) =>
          row.articleNo ||
          row.description ||
          row.partNo ||
          row.qty
      );
      if (!filtered.length) {
        setPoErr("Excel import has no valid rows.");
        return;
      }
      setPoItems(filtered);
    } catch (e) {
      setPoErr(e.message || "Failed to import Excel file.");
    }
  }

  async function exportPurchaseOrderPdf() {
    if (!poForm.supplierName.trim()) {
      alert("Supplier name is required for Purchase Order.");
      return;
    }

    const doc = new jsPDF({ format: "a4", unit: "mm" });
    doc.setTextColor(0, 0, 0);
    const header = await getHeaderImage();
    const contentStartY = getContentStartY(doc, header);
    doc.setFontSize(16);
    doc.text("Purchase Order", 150, contentStartY, { align: "right" });

    const supplierInfo = [
      [poForm.supplierName],
      [poForm.supplierAddress || "-"],
      [`Tel: ${poForm.supplierPhone || "-"}`],
      [`E-mail: ${poForm.supplierEmail || "-"}`],
    ];
    autoTable(doc, {
      startY: contentStartY + 6,
      theme: "grid",
      body: supplierInfo,
      styles: { fontSize: 10, cellPadding: 1 },
      tableWidth: 90,
    });

    const orderInfo = [
      ["Ref", poForm.ref || "-"],
      ["Date", poForm.orderDate || "-"],
      ["Int Ref", poForm.intRef || "-"],
      ["Contact Person", poForm.contactPerson || "-"],
      ["Supplier Ref", poForm.supplierEmail || "-"],
      ["Offer Date", poForm.offerDate || "-"],
      ["Currency", poForm.currency || "-"],
      ["Order Value", poTotals.grandTotal.toFixed(2)],
      ["Nr of Pages", "auto"],
    ];
    let nrPagesCell = null;
    autoTable(doc, {
      startY: contentStartY + 6,
      margin: { left: 110 },
      body: orderInfo,
      styles: { fontSize: 10, cellPadding: 1 },
      tableWidth: 90,
      didDrawCell: (data) => {
        if (
          data.section === "body" &&
          data.row.index === 8 &&
          data.column.index === 1
        ) {
          nrPagesCell = {
            x: data.cell.x,
            y: data.cell.y,
            w: data.cell.width,
            h: data.cell.height,
            pageNumber: doc.internal.getCurrentPageInfo().pageNumber,
          };
        }
      },
    });

    doc.setFontSize(10);

    const itemRows = poItems.map((row, idx) => {
      const qty = Number(row.qty) || 0;
      const rate = Number(row.unitRate) || 0;
      const total = qty * rate;
      return [
        String(idx + 1),
        row.articleNo || "-",
        row.description || "-",
        row.partNo || "-",
        String(qty || 0),
        row.uom || "-",
        rate ? rate.toFixed(2) : "0.00",
        total.toFixed(2),
        row.remark || "",
      ];
    });
    autoTable(doc, {
      startY: doc.lastAutoTable.finalY + 6,
      margin: { bottom: FOOTER_MARGIN_MM + FOOTER_SAFE_GAP_MM },
      theme: "grid",
      head: [
        [
          "Pos",
          "Article Nr",
          "Description",
          "Part Nr",
          "Qty",
          "UOM",
          "Unit Rate",
          "Total Amount",
          "Remark",
        ],
      ],
      body: itemRows,
      styles: { fontSize: 10 },
      headStyles: { fillColor: [230, 230, 230], textColor: 20 },
    });

    const afterTableY = doc.lastAutoTable.finalY + 4;
    autoTable(doc, {
      startY: afterTableY,
      margin: {
        left: 130,
        bottom: FOOTER_MARGIN_MM + FOOTER_SAFE_GAP_MM,
      },
      theme: "grid",
      body: [
        ["Sub Total", poTotals.subTotal.toFixed(2)],
        ["Grand Total", poTotals.grandTotal.toFixed(2)],
      ],
      styles: { fontSize: 10 },
      tableWidth: 60,
    });

    const terms = [
      ["Delivery", poForm.delivery || "-"],
      ["Insurance", poForm.insurance || "-"],
      ["Packing", poForm.packing || "-"],
      ["Freight", poForm.freight || "-"],
      ["Taxes", poForm.taxes || "-"],
      ["Payment", poForm.payment || "-"],
      ["Special Remarks", poForm.specialRemarks || "-"],
    ];
    autoTable(doc, {
      startY: doc.lastAutoTable.finalY + 6,
      margin: { bottom: FOOTER_MARGIN_MM + FOOTER_SAFE_GAP_MM },
      theme: "grid",
      body: terms,
      styles: { fontSize: 10, cellPadding: 1 },
      tableWidth: 120,
    });

    const termsText = poForm.termsAndConditions || "";
    if (termsText) {
      doc.setFontSize(8);
      const wrapped = doc.splitTextToSize(termsText, 180);
      doc.text(wrapped, 14, doc.lastAutoTable.finalY + 8);
    }

    if (poForm.closingNote) {
      doc.setFontSize(9);
      const y = doc.lastAutoTable.finalY + (termsText ? 28 : 10);
      doc.text(poForm.closingNote || "", 14, y);
    }

    const pageCount = doc.internal.getNumberOfPages();
    if (nrPagesCell) {
      doc.setPage(nrPagesCell.pageNumber);
      doc.setFontSize(9);
      doc.text(
        String(pageCount),
        nrPagesCell.x + 1,
        nrPagesCell.y + nrPagesCell.h - 2
      );
    }
    addPdfHeader(doc, header);
    addPdfFooter(doc);
    doc.save(
      `purchase-order-${poForm.supplierName
        .trim()
        .replace(/\s+/g, "-")
        .toLowerCase()}.pdf`
    );
  }

  function exportStatementCsv() {
    const rows = [
      ["PO No", "Int Ref", "Date", "Supplier", "Currency", "Total", "Status"],
      ...filteredPoList.map((po) => [
        po.poNo || "",
        po.intRef || "",
        po.orderDate || "",
        po.supplierName || "",
        po.currency || "",
        Number(po.grandTotal || 0).toFixed(2),
        po.status || "DRAFT",
      ]),
    ];
    downloadCsv("purchase-order-statement.csv", rows);
  }

  async function exportStatementPdf() {
    const body = filteredPoList.map((po) => [
      po.poNo || "",
      po.intRef || "",
      po.orderDate || "",
      po.supplierName || "",
      po.currency || "",
      Number(po.grandTotal || 0).toFixed(2),
      po.status || "DRAFT",
    ]);
    await exportPdf(
      "Purchase Order Statement",
      ["PO No", "Int Ref", "Date", "Supplier", "Currency", "Total", "Status"],
      body,
      "purchase-order-statement.pdf"
    );
  }

  const subModules = [
    "Supplier",
    "Purchase Order",
    "Purchase Return",
    "Purchase Order Statement",
  ];

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border bg-white p-3">
        <div className="flex flex-wrap gap-2">
          {subModules.map((label) => (
            <button
              key={label}
              onClick={() => setActiveSub(label)}
              className={[
                "rounded-xl px-3 py-2 text-sm border",
                activeSub === label
                  ? "bg-gray-900 text-white border-gray-900"
                  : "bg-white text-gray-700 hover:bg-gray-50",
              ].join(" ")}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {activeSub === "Supplier" && (
        <div className="space-y-6">
          <div className="rounded-2xl border bg-white p-6">
            <h2 className="text-base font-semibold">Supplier Master</h2>
            <p className="mt-1 text-sm text-gray-600">
              Manage suppliers used in purchase transactions.
            </p>
            {supplierErr && (
              <div className="mt-3 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">
                {supplierErr}
              </div>
            )}
          </div>

          <div className="grid gap-6 lg:grid-cols-3">
            <div className="rounded-2xl border bg-white p-6">
              <h3 className="text-base font-semibold">Add Supplier</h3>
              <form onSubmit={addSupplier} className="mt-4 space-y-3">
                <div>
                  <label className="text-sm text-gray-600">Name *</label>
                  <input
                    name="name"
                    value={supplierForm.name}
                    onChange={onSupplierChange}
                    className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
                  />
                </div>
                <div>
                  <label className="text-sm text-gray-600">Contact Name</label>
                  <input
                    name="contactName"
                    value={supplierForm.contactName}
                    onChange={onSupplierChange}
                    className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
                  />
                </div>
                <div>
                  <label className="text-sm text-gray-600">Phone</label>
                  <input
                    name="phone"
                    value={supplierForm.phone}
                    onChange={onSupplierChange}
                    className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
                  />
                </div>
                <div>
                  <label className="text-sm text-gray-600">Email</label>
                  <input
                    name="email"
                    value={supplierForm.email}
                    onChange={onSupplierChange}
                    className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
                  />
                </div>
                <div>
                  <label className="text-sm text-gray-600">GST No</label>
                  <input
                    name="gstNo"
                    value={supplierForm.gstNo}
                    onChange={onSupplierChange}
                    className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
                  />
                </div>
                <div>
                  <label className="text-sm text-gray-600">PAN No</label>
                  <input
                    name="panNo"
                    value={supplierForm.panNo}
                    onChange={onSupplierChange}
                    className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
                  />
                </div>
                <div>
                  <label className="text-sm text-gray-600">Address</label>
                  <input
                    name="address"
                    value={supplierForm.address}
                    onChange={onSupplierChange}
                    className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
                  />
                </div>
                <div>
                  <label className="text-sm text-gray-600">Notes</label>
                  <input
                    name="notes"
                    value={supplierForm.notes}
                    onChange={onSupplierChange}
                    className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
                  />
                </div>
                <button className="w-full rounded-xl bg-gray-900 px-4 py-2 text-sm font-semibold text-white">
                  + Add Supplier
                </button>
              </form>
            </div>

            <div className="rounded-2xl border bg-white p-6 lg:col-span-2">
              <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                <h3 className="text-base font-semibold">Suppliers</h3>
                <div className="flex gap-2">
                  <input
                    value={supplierQuery}
                    onChange={(e) => setSupplierQuery(e.target.value)}
                    className="w-full md:w-80 rounded-xl border px-3 py-2 text-sm"
                    placeholder="Search suppliers..."
                  />
                  <button
                    onClick={loadSuppliers}
                    className="rounded-xl border px-3 py-2 text-sm hover:bg-gray-50"
                  >
                    Refresh
                  </button>
                </div>
              </div>

              <div className="mt-4">
                {supplierLoading ? (
                  <div className="text-sm text-gray-600">Loading...</div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-sm">
                      <thead className="border-b text-gray-600">
                        <tr>
                          <th className="py-2 pr-3">Name</th>
                          <th className="py-2 pr-3">Contact</th>
                          <th className="py-2 pr-3">Phone</th>
                          <th className="py-2 pr-3">Email</th>
                          <th className="py-2 pr-3">GST</th>
                          <th className="py-2 pr-3">PAN</th>
                          <th className="py-2 pr-3">Address</th>
                          <th className="py-2"></th>
                        </tr>
                      </thead>
                      <tbody>
                        {filteredSuppliers.length === 0 ? (
                          <tr>
                            <td className="py-6 text-gray-500" colSpan={8}>
                              No suppliers yet.
                            </td>
                          </tr>
                        ) : (
                          filteredSuppliers.map((s) => (
                            <tr key={s._id} className="border-b last:border-b-0">
                              <td className="py-2 pr-3 font-medium">
                                {s.name}
                              </td>
                              <td className="py-2 pr-3">
                                {s.contactName || "-"}
                              </td>
                              <td className="py-2 pr-3">{s.phone || "-"}</td>
                              <td className="py-2 pr-3">{s.email || "-"}</td>
                              <td className="py-2 pr-3">{s.gstNo || "-"}</td>
                              <td className="py-2 pr-3">{s.panNo || "-"}</td>
                              <td className="py-2 pr-3">{s.address || "-"}</td>
                              <td className="py-2 text-right">
                                <button
                                  onClick={() => deleteSupplier(s._id)}
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
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {activeSub === "Purchase Return" && (
        <div className="rounded-2xl border bg-white p-6">
          <h2 className="text-base font-semibold">Purchase Return</h2>
          <p className="mt-1 text-sm text-gray-600">
            Purchase return workflow will be added here.
          </p>
        </div>
      )}

      {activeSub === "Purchase Order Statement" && (
        <div className="rounded-2xl border bg-white p-6">
          <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
            <div>
              <h2 className="text-base font-semibold">
                Purchase Order Statement
              </h2>
              <p className="mt-1 text-sm text-gray-600">
                All saved purchase orders.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                onClick={loadPurchaseOrders}
                className="rounded-xl border px-3 py-2 text-sm hover:bg-gray-50"
              >
                Refresh
              </button>
              <button
                onClick={exportStatementCsv}
                className="rounded-xl border px-3 py-2 text-sm hover:bg-gray-50"
              >
                Export CSV
              </button>
              <button
                onClick={exportStatementPdf}
                className="rounded-xl border px-3 py-2 text-sm hover:bg-gray-50"
              >
                Export PDF
              </button>
            </div>
          </div>

          <div className="mt-4 grid gap-3 md:grid-cols-5">
            <div>
              <label className="text-sm text-gray-600">From</label>
              <input
                type="date"
                name="from"
                value={poStatementFilters.from}
                onChange={onPoStatementChange}
                className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="text-sm text-gray-600">To</label>
              <input
                type="date"
                name="to"
                value={poStatementFilters.to}
                onChange={onPoStatementChange}
                className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="text-sm text-gray-600">Supplier</label>
              <input
                name="supplier"
                value={poStatementFilters.supplier}
                onChange={onPoStatementChange}
                className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
                placeholder="Supplier name"
              />
            </div>
            <div>
              <label className="text-sm text-gray-600">Status</label>
              <select
                name="status"
                value={poStatementFilters.status}
                onChange={onPoStatementChange}
                className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
              >
                <option value="ALL">All</option>
                <option value="DRAFT">DRAFT</option>
                <option value="SENT">SENT</option>
                <option value="PARTIAL">PARTIAL</option>
                <option value="CLOSED">CLOSED</option>
              </select>
            </div>
            <div>
              <label className="text-sm text-gray-600">Search</label>
              <input
                name="q"
                value={poStatementFilters.q}
                onChange={onPoStatementChange}
                className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
                placeholder="po / int ref / status"
              />
            </div>
          </div>

          <div className="mt-4">
            {poLoading ? (
              <div className="text-sm text-gray-600">Loading...</div>
            ) : filteredPoList.length === 0 ? (
              <div className="text-sm text-gray-500">No purchase orders.</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="border-b text-gray-600">
                    <tr>
                      <th className="py-2 pr-3">PO No</th>
                      <th className="py-2 pr-3">Int Ref</th>
                      <th className="py-2 pr-3">Date</th>
                      <th className="py-2 pr-3">Supplier</th>
                      <th className="py-2 pr-3">Currency</th>
                      <th className="py-2 pr-3">Total</th>
                      <th className="py-2 pr-3">Status</th>
                      <th className="py-2"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredPoList.map((po) => (
                      <tr key={po._id} className="border-b last:border-b-0">
                        <td className="py-2 pr-3 font-medium">{po.poNo}</td>
                        <td className="py-2 pr-3">{po.intRef || "-"}</td>
                        <td className="py-2 pr-3">{po.orderDate || "-"}</td>
                        <td className="py-2 pr-3">{po.supplierName}</td>
                        <td className="py-2 pr-3">{po.currency || "USD"}</td>
                        <td className="py-2 pr-3">
                          {Number(po.grandTotal || 0).toFixed(2)}
                        </td>
                        <td className="py-2 pr-3">{po.status || "DRAFT"}</td>
                        <td className="py-2 text-right">
                          <button
                            onClick={() => applyPurchaseOrder(po)}
                            className="rounded-lg border px-3 py-1 text-xs hover:bg-gray-50"
                          >
                            View
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {activeSub === "Purchase Order" && (
        <>
      <div className="rounded-2xl border bg-white p-6">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div>
            <h1 className="text-xl font-semibold">Purchase Order</h1>
            <p className="mt-1 text-gray-600">
              Create, save, and export PO in the required format.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={savePurchaseOrder}
              className="rounded-xl border px-3 py-2 text-sm hover:bg-gray-50"
            >
              Save PO
            </button>
            <button
              onClick={exportPurchaseOrderPdf}
              className="rounded-xl border px-3 py-2 text-sm hover:bg-gray-50"
            >
              Download PDF
            </button>
            <button
              onClick={exportPurchaseOrderCsv}
              className="rounded-xl border px-3 py-2 text-sm hover:bg-gray-50"
            >
              Download CSV
            </button>
          </div>
        </div>
        {poErr && (
          <div className="mt-3 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">
            {poErr}
          </div>
        )}

        <div className="mt-4 grid gap-4 lg:grid-cols-3">
          <div className="lg:col-span-2 space-y-4">
            <div className="rounded-xl border p-4">
              <h3 className="text-sm font-semibold text-gray-700">
                Supplier Details
              </h3>
              <div className="mt-3 grid gap-3 md:grid-cols-2">
                <div>
                  <label className="text-sm text-gray-600">
                    Supplier (from master)
                  </label>
                  <select
                    value={poForm.supplierId}
                    onChange={(e) => applySupplierToPo(e.target.value)}
                    className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
                  >
                    <option value="">Select supplier...</option>
                    {suppliers.map((s) => (
                      <option key={s._id} value={s._id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="text-sm text-gray-600">Supplier Name *</label>
                  <input
                    name="supplierName"
                    value={poForm.supplierName}
                    onChange={onPoChange}
                    className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
                  />
                </div>
                <div>
                  <label className="text-sm text-gray-600">Address</label>
                  <input
                    name="supplierAddress"
                    value={poForm.supplierAddress}
                    onChange={onPoChange}
                    className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
                  />
                </div>
                <div>
                  <label className="text-sm text-gray-600">Contact Person</label>
                  <input
                    name="contactPerson"
                    value={poForm.contactPerson}
                    onChange={onPoChange}
                    className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
                  />
                </div>
                <div>
                  <label className="text-sm text-gray-600">Phone</label>
                  <input
                    name="supplierPhone"
                    value={poForm.supplierPhone}
                    onChange={onPoChange}
                    className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
                  />
                </div>
                <div>
                  <label className="text-sm text-gray-600">Email</label>
                  <input
                    name="supplierEmail"
                    value={poForm.supplierEmail}
                    onChange={onPoChange}
                    className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
                  />
                </div>
              </div>
            </div>

            <div className="rounded-xl border p-4">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-gray-700">
                  PO Line Items
                </h3>
                <button
                  onClick={addPoItem}
                  className="rounded-lg border px-3 py-1 text-xs hover:bg-gray-50"
                >
                  + Add Line
                </button>
              </div>
              <div className="mt-3 flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
                <label className="text-xs text-gray-600">
                  Import Excel (Article Nr, Description, Part Nr, Qty, UOM,
                  Unit Rate, Remark)
                </label>
                <input
                  type="file"
                  accept=".xlsx,.xls,.csv"
                  onChange={(e) => handlePoExcelImport(e.target.files?.[0])}
                  className="text-xs"
                />
              </div>
              <div className="mt-3 overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="border-b text-gray-600">
                    <tr>
                      <th className="py-2 pr-3">Article Nr</th>
                      <th className="py-2 pr-3">Description</th>
                      <th className="py-2 pr-3">Part Nr</th>
                      <th className="py-2 pr-3">Qty</th>
                      <th className="py-2 pr-3">UOM</th>
                      <th className="py-2 pr-3">Unit Rate</th>
                      <th className="py-2 pr-3">Remark</th>
                      <th className="py-2"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {poItems.map((row, idx) => (
                      <tr key={idx} className="border-b last:border-b-0">
                        <td className="py-2 pr-3">
                          <input
                            value={row.articleNo}
                            onChange={(e) =>
                              onPoItemChange(idx, "articleNo", e.target.value)
                            }
                            className="w-28 rounded-lg border px-2 py-1 text-xs"
                          />
                        </td>
                        <td className="py-2 pr-3">
                          <input
                            value={row.description}
                            onChange={(e) =>
                              onPoItemChange(idx, "description", e.target.value)
                            }
                            className="w-40 rounded-lg border px-2 py-1 text-xs"
                          />
                        </td>
                        <td className="py-2 pr-3">
                          <input
                            value={row.partNo}
                            onChange={(e) =>
                              onPoItemChange(idx, "partNo", e.target.value)
                            }
                            className="w-32 rounded-lg border px-2 py-1 text-xs"
                          />
                        </td>
                        <td className="py-2 pr-3">
                          <input
                            type="number"
                            min="0"
                            value={row.qty}
                            onChange={(e) =>
                              onPoItemChange(idx, "qty", e.target.value)
                            }
                            className="w-20 rounded-lg border px-2 py-1 text-xs"
                          />
                        </td>
                        <td className="py-2 pr-3">
                          <input
                            value={row.uom}
                            onChange={(e) =>
                              onPoItemChange(idx, "uom", e.target.value)
                            }
                            className="w-20 rounded-lg border px-2 py-1 text-xs"
                          />
                        </td>
                        <td className="py-2 pr-3">
                          <input
                            type="number"
                            min="0"
                            value={row.unitRate}
                            onChange={(e) =>
                              onPoItemChange(idx, "unitRate", e.target.value)
                            }
                            className="w-24 rounded-lg border px-2 py-1 text-xs"
                          />
                        </td>
                        <td className="py-2 pr-3">
                          <input
                            value={row.remark}
                            onChange={(e) =>
                              onPoItemChange(idx, "remark", e.target.value)
                            }
                            className="w-28 rounded-lg border px-2 py-1 text-xs"
                          />
                        </td>
                        <td className="py-2 text-right">
                          {poItems.length > 1 && (
                            <button
                              onClick={() => removePoItem(idx)}
                              className="rounded-lg border px-2 py-1 text-[11px] hover:bg-gray-50"
                            >
                              Remove
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="mt-3 text-xs text-gray-600">
                Sub Total: {poTotals.subTotal.toFixed(2)} • Grand Total:{" "}
                {poTotals.grandTotal.toFixed(2)}
              </div>
            </div>

            <div className="rounded-xl border bg-white p-4 font-[Calibri,Arial,sans-serif] text-[10px] text-black">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-gray-700">
                  PO Preview
                </h3>
                <span className="text-[11px] text-gray-500">
                  Layout aligned with the PDF format
                </span>
              </div>

              <div className="mt-4 flex items-start justify-between">
                <div className="text-sm font-semibold">Marivoltz ERP</div>
                <div className="text-base font-semibold tracking-wide">
                  Purchase Order
                </div>
              </div>

              <div className="mt-4 grid gap-4 lg:grid-cols-2">
                <div className="text-xs leading-5">
                  <div className="text-sm font-semibold">
                    {poForm.supplierName || "-"}
                  </div>
                  <div className="text-xs text-gray-600">
                    {poForm.supplierAddress || "-"}
                  </div>
                  <div className="mt-2 text-xs text-gray-600">
                    Tel: {poForm.supplierPhone || "-"}
                  </div>
                  <div className="text-xs text-gray-600">
                    E-mail: {poForm.supplierEmail || "-"}
                  </div>
                </div>

                <div className="text-[11px]">
                  <div className="grid grid-cols-2 border border-gray-300">
                    <div className="border-b border-r border-gray-300 p-2 font-semibold">
                      Ref
                    </div>
                    <div className="border-b border-gray-300 p-2">
                      {poForm.ref || "-"}
                    </div>
                    <div className="border-b border-r border-gray-300 p-2 font-semibold">
                      Date
                    </div>
                    <div className="border-b border-gray-300 p-2">
                      {poForm.orderDate || "-"}
                    </div>
                    <div className="border-b border-r border-gray-300 p-2 font-semibold">
                      Int Ref
                    </div>
                    <div className="border-b border-gray-300 p-2">
                      {poForm.intRef || "-"}
                    </div>
                    <div className="border-b border-r border-gray-300 p-2 font-semibold">
                      Contact Person
                    </div>
                    <div className="border-b border-gray-300 p-2">
                      {poForm.contactPerson || "-"}
                    </div>
                    <div className="border-b border-r border-gray-300 p-2 font-semibold">
                      Supplier Ref
                    </div>
                    <div className="border-b border-gray-300 p-2">
                      {poForm.supplierEmail || "-"}
                    </div>
                    <div className="border-b border-r border-gray-300 p-2 font-semibold">
                      Offer Date
                    </div>
                    <div className="border-b border-gray-300 p-2">
                      {poForm.offerDate || "-"}
                    </div>
                    <div className="border-b border-r border-gray-300 p-2 font-semibold">
                      Currency
                    </div>
                    <div className="border-b border-gray-300 p-2">
                      {poForm.currency || "-"}
                    </div>
                    <div className="border-b border-r border-gray-300 p-2 font-semibold">
                      Order Value
                    </div>
                    <div className="border-b border-gray-300 p-2">
                      {poTotals.grandTotal.toFixed(2)}
                    </div>
                    <div className="border-r border-gray-300 p-2 font-semibold">
                      Nr of Pages
                    </div>
                    <div className="p-2">{poPreviewPages}</div>
                  </div>
                </div>
              </div>

              <div className="mt-3 overflow-x-auto">
                <table className="w-full text-left text-xs border border-gray-300">
                  <thead className="border-b border-gray-300 text-gray-700">
                    <tr className="bg-gray-100">
                      <th className="py-2 pr-3">Pos</th>
                      <th className="py-2 pr-3">Article Nr</th>
                      <th className="py-2 pr-3">Description</th>
                      <th className="py-2 pr-3">Part Nr</th>
                      <th className="py-2 pr-3">Qty</th>
                      <th className="py-2 pr-3">UOM</th>
                      <th className="py-2 pr-3">Unit Rate</th>
                      <th className="py-2 pr-3">Total Amount</th>
                      <th className="py-2 pr-3">Remark</th>
                    </tr>
                  </thead>
                  <tbody>
                    {poItems.length === 0 ? (
                      <tr>
                        <td className="py-3 text-gray-500" colSpan={9}>
                          No items.
                        </td>
                      </tr>
                    ) : (
                      poItems.map((row, idx) => {
                        const qty = Number(row.qty) || 0;
                        const rate = Number(row.unitRate) || 0;
                        return (
                          <tr
                            key={idx}
                            className="border-b border-gray-200 last:border-b-0"
                          >
                            <td className="py-2 pr-3">{idx + 1}</td>
                            <td className="py-2 pr-3">{row.articleNo || "-"}</td>
                            <td className="py-2 pr-3">{row.description || "-"}</td>
                            <td className="py-2 pr-3">{row.partNo || "-"}</td>
                            <td className="py-2 pr-3">{qty || 0}</td>
                            <td className="py-2 pr-3">{row.uom || "-"}</td>
                            <td className="py-2 pr-3">
                              {rate ? rate.toFixed(2) : "0.00"}
                            </td>
                            <td className="py-2 pr-3">
                              {(qty * rate).toFixed(2)}
                            </td>
                            <td className="py-2 pr-3">{row.remark || ""}</td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>

              <div className="mt-3 flex justify-end text-xs">
                <div className="w-48">
                  <div className="flex justify-between border-b py-1">
                    <span>Sub Total</span>
                    <span>{poTotals.subTotal.toFixed(2)}</span>
                  </div>
                  <div className="flex justify-between py-1 font-semibold">
                    <span>Grand Total</span>
                    <span>{poTotals.grandTotal.toFixed(2)}</span>
                  </div>
                </div>
              </div>

              <div className="mt-4 grid gap-2 text-xs">
                <div>
                  <span className="font-semibold">Delivery:</span>{" "}
                  {poForm.delivery || "-"}
                </div>
                <div>
                  <span className="font-semibold">Insurance:</span>{" "}
                  {poForm.insurance || "-"}
                </div>
                <div>
                  <span className="font-semibold">Packing:</span>{" "}
                  {poForm.packing || "-"}
                </div>
                <div>
                  <span className="font-semibold">Freight:</span>{" "}
                  {poForm.freight || "-"}
                </div>
                <div>
                  <span className="font-semibold">Taxes:</span>{" "}
                  {poForm.taxes || "-"}
                </div>
                <div>
                  <span className="font-semibold">Payment:</span>{" "}
                  {poForm.payment || "-"}
                </div>
                <div>
                  <span className="font-semibold">Special Remarks:</span>{" "}
                  {poForm.specialRemarks || "-"}
                </div>
              </div>

              {poForm.termsAndConditions && (
                <div className="mt-4 text-[11px] leading-5 text-gray-700">
                  {poForm.termsAndConditions}
                </div>
              )}

              {poForm.closingNote && (
                <div className="mt-3 text-xs text-gray-700">
                  {poForm.closingNote}
                </div>
              )}
            </div>
          </div>

          <div className="space-y-4">
            <div className="rounded-xl border p-4">
              <h3 className="text-sm font-semibold text-gray-700">
                Order Details
              </h3>
              <div className="mt-3 space-y-3">
                <input
                  name="ref"
                  value={poForm.ref}
                  onChange={onPoChange}
                  placeholder="Ref"
                  className="w-full rounded-xl border px-3 py-2 text-sm"
                />
                <input
                  name="orderDate"
                  value={poForm.orderDate}
                  readOnly
                  placeholder="Date (auto)"
                  className="w-full rounded-xl border px-3 py-2 text-sm"
                />
                <input
                  name="intRef"
                  value={poForm.intRef || intRefPreview}
                  readOnly
                  placeholder="Int Ref (auto)"
                  className="w-full rounded-xl border px-3 py-2 text-sm"
                />
                <input
                  name="offerDate"
                  value={poForm.offerDate}
                  onChange={onPoChange}
                  placeholder="Offer Date"
                  className="w-full rounded-xl border px-3 py-2 text-sm"
                />
                <select
                  name="currency"
                  value={poForm.currency}
                  onChange={onPoChange}
                  className="w-full rounded-xl border px-3 py-2 text-sm"
                >
                  <option value="USD">USD</option>
                  <option value="EUR">EUR</option>
                  <option value="INR">INR</option>
                  <option value="GBP">GBP</option>
                  <option value="JPY">JPY</option>
                </select>
              </div>
            </div>

            <div className="rounded-xl border p-4">
              <h3 className="text-sm font-semibold text-gray-700">Terms</h3>
              <div className="mt-3 space-y-3">
                <input
                  name="delivery"
                  value={poForm.delivery}
                  onChange={onPoChange}
                  placeholder="Delivery"
                  className="w-full rounded-xl border px-3 py-2 text-sm"
                />
                <input
                  name="insurance"
                  value={poForm.insurance}
                  onChange={onPoChange}
                  placeholder="Insurance"
                  className="w-full rounded-xl border px-3 py-2 text-sm"
                />
                <input
                  name="packing"
                  value={poForm.packing}
                  onChange={onPoChange}
                  placeholder="Packing"
                  className="w-full rounded-xl border px-3 py-2 text-sm"
                />
                <input
                  name="freight"
                  value={poForm.freight}
                  onChange={onPoChange}
                  placeholder="Freight"
                  className="w-full rounded-xl border px-3 py-2 text-sm"
                />
                <input
                  name="taxes"
                  value={poForm.taxes}
                  onChange={onPoChange}
                  placeholder="Taxes"
                  className="w-full rounded-xl border px-3 py-2 text-sm"
                />
                <input
                  name="payment"
                  value={poForm.payment}
                  onChange={onPoChange}
                  placeholder="Payment"
                  className="w-full rounded-xl border px-3 py-2 text-sm"
                />
                <input
                  name="specialRemarks"
                  value={poForm.specialRemarks}
                  onChange={onPoChange}
                  placeholder="Special Remarks"
                  className="w-full rounded-xl border px-3 py-2 text-sm"
                />
                <textarea
                  name="termsAndConditions"
                  value={poForm.termsAndConditions}
                  onChange={onPoChange}
                  rows={6}
                  className="w-full rounded-xl border px-3 py-2 text-sm"
                />
                <textarea
                  name="closingNote"
                  value={poForm.closingNote}
                  onChange={onPoChange}
                  rows={3}
                  className="w-full rounded-xl border px-3 py-2 text-sm"
                />
              </div>
            </div>

            <div className="rounded-xl border p-4">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-gray-700">
                  Saved Purchase Orders
                </h3>
                <button
                  onClick={loadPurchaseOrders}
                  className="rounded-lg border px-2 py-1 text-xs hover:bg-gray-50"
                >
                  Refresh
                </button>
              </div>
              <div className="mt-3">
                {poLoading ? (
                  <div className="text-xs text-gray-600">Loading...</div>
                ) : poList.length === 0 ? (
                  <div className="text-xs text-gray-500">No POs yet.</div>
                ) : (
                  <div className="space-y-2 max-h-56 overflow-y-auto">
                    {poList.map((po) => (
                      <button
                        key={po._id}
                        onClick={() => applyPurchaseOrder(po)}
                        className={[
                          "w-full text-left rounded-lg border px-3 py-2 text-xs hover:bg-gray-50",
                          selectedPoId === po._id
                            ? "border-gray-900 bg-gray-50"
                            : "border-gray-200",
                        ].join(" ")}
                      >
                        <div className="font-semibold">
                          {po.supplierName} • {po.poNo}
                        </div>
                        <div className="text-[11px] text-gray-600">
                          {po.orderDate || "-"} • {po.currency || "USD"} •{" "}
                          {Number(po.grandTotal || 0).toFixed(2)}
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="rounded-2xl border bg-white p-6">
        <h1 className="text-xl font-semibold">Purchase</h1>
        <p className="mt-1 text-gray-600">
          Saves directly to MongoDB ✅ (creates Stock <b>IN</b> transaction)
        </p>

        {err && (
          <div className="mt-3 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">
            {err}
          </div>
        )}
      </div>

      <div className="rounded-2xl border bg-white p-6 max-w-2xl">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold">New Purchase</h2>
          <button
            onClick={loadItems}
            className="rounded-xl border px-3 py-2 text-sm hover:bg-gray-50"
          >
            Refresh Items
          </button>
        </div>

        {loading ? (
          <div className="mt-4 text-sm text-gray-600">Loading items...</div>
        ) : (
          <form onSubmit={addPurchase} className="mt-4 space-y-3">
            <div>
              <label className="text-sm text-gray-600">Item *</label>
              <select
                name="sku"
                value={form.sku}
                onChange={onChange}
                className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
              >
                <option value="">Select item...</option>
                {items.map((it) => (
                  <option key={it._id} value={it.sku}>
                    {it.sku} — {it.name}
                  </option>
                ))}
              </select>

              {selectedItem && (
                <div className="mt-2 text-xs text-gray-600">
                  Selected: <b>{selectedItem.name}</b>
                </div>
              )}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-sm text-gray-600">Qty *</label>
                <input
                  name="qty"
                  type="number"
                  min="1"
                  value={form.qty}
                  onChange={onChange}
                  className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
                />
              </div>

              <div>
                <label className="text-sm text-gray-600">PO No</label>
                <input
                  name="poNo"
                  value={form.poNo}
                  onChange={onChange}
                  className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
                  placeholder="e.g. PO-001"
                />
              </div>
            </div>

            <div>
              <label className="text-sm text-gray-600">Supplier</label>
              <input
                name="supplier"
                value={form.supplier}
                onChange={onChange}
                className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
                placeholder="Supplier name"
              />
            </div>

            <div>
              <label className="text-sm text-gray-600">Note</label>
              <input
                name="note"
                value={form.note}
                onChange={onChange}
                className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
              />
            </div>

            <button className="w-full rounded-xl bg-gray-900 px-4 py-2 text-sm font-semibold text-white">
              Save Purchase (DB Stock IN)
            </button>

            <p className="text-xs text-gray-500">
              Go to Inventory → Refresh → stock should increase.
            </p>
          </form>
        )}
      </div>

      <div className="rounded-2xl border bg-white p-6">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div>
            <h2 className="text-base font-semibold">Purchase History</h2>
            <p className="text-sm text-gray-500">
              Stock IN transactions (latest 500)
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={loadHistory}
              className="rounded-xl border px-3 py-2 text-sm hover:bg-gray-50"
            >
              Load History
            </button>
            <button
              onClick={exportHistoryCsv}
              className="rounded-xl border px-3 py-2 text-sm hover:bg-gray-50"
            >
              Export CSV
            </button>
            <button
              onClick={exportHistoryPdf}
              className="rounded-xl border px-3 py-2 text-sm hover:bg-gray-50"
            >
              Export PDF
            </button>
          </div>
        </div>

        <div className="mt-4 grid gap-3 md:grid-cols-5">
          <div>
            <label className="text-sm text-gray-600">From</label>
            <input
              type="date"
              name="from"
              value={historyFilters.from}
              onChange={onHistoryChange}
              className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="text-sm text-gray-600">To</label>
            <input
              type="date"
              name="to"
              value={historyFilters.to}
              onChange={onHistoryChange}
              className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="text-sm text-gray-600">SKU</label>
            <input
              name="sku"
              value={historyFilters.sku}
              onChange={onHistoryChange}
              className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
              placeholder="e.g. 034.12.001"
            />
          </div>
          <div>
            <label className="text-sm text-gray-600">Supplier</label>
            <input
              name="supplier"
              value={historyFilters.supplier}
              onChange={onHistoryChange}
              className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
              placeholder="Supplier name"
            />
          </div>
          <div>
            <label className="text-sm text-gray-600">Search</label>
            <input
              name="q"
              value={historyFilters.q}
              onChange={onHistoryChange}
              className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
              placeholder="ref / note / sku"
            />
          </div>
        </div>

        {historyErr && (
          <div className="mt-3 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">
            {historyErr}
          </div>
        )}

        <div className="mt-4">
          {historyLoading ? (
            <div className="text-sm text-gray-600">Loading history...</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="border-b text-gray-600">
                  <tr>
                    <th className="py-2 pr-3">Date</th>
                    <th className="py-2 pr-3">Supplier</th>
                    <th className="py-2 pr-3">SKU</th>
                    <th className="py-2 pr-3">Qty</th>
                    <th className="py-2 pr-3">Ref</th>
                    <th className="py-2 pr-3">Note</th>
                  </tr>
                </thead>
                <tbody>
                  {historyFiltered.length === 0 ? (
                    <tr>
                      <td className="py-6 text-gray-500" colSpan={6}>
                        No purchases yet.
                      </td>
                    </tr>
                  ) : (
                    historyFiltered.map((tx) => (
                      <tr key={tx._id} className="border-b last:border-b-0">
                        <td className="py-2 pr-3">
                          {new Date(tx.createdAt).toLocaleDateString()}
                        </td>
                        <td className="py-2 pr-3">{getSupplier(tx) || "-"}</td>
                        <td className="py-2 pr-3 font-medium">{tx.sku}</td>
                        <td className="py-2 pr-3">{tx.qty}</td>
                        <td className="py-2 pr-3">{tx.ref || "-"}</td>
                        <td className="py-2 pr-3">{tx.note || "-"}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>

              <div className="mt-3 text-xs text-gray-500">
                Total rows: {historySummary.totalRows} • Total qty:{" "}
                {historySummary.totalQty}
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="rounded-2xl border bg-white p-6">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div>
            <h2 className="text-base font-semibold">
              Purchase Report (Supplier)
            </h2>
            <div className="text-xs text-gray-500">
              Based on current history filter
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={exportReportCsv}
              className="rounded-xl border px-3 py-2 text-sm hover:bg-gray-50"
            >
              Export CSV
            </button>
            <button
              onClick={exportReportPdf}
              className="rounded-xl border px-3 py-2 text-sm hover:bg-gray-50"
            >
              Export PDF
            </button>
          </div>
        </div>

        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b text-gray-600">
              <tr>
                <th className="py-2 pr-3">Supplier</th>
                <th className="py-2 pr-3">Total Qty</th>
                <th className="py-2 pr-3">Entries</th>
              </tr>
            </thead>
            <tbody>
              {historySummary.rows.length === 0 ? (
                <tr>
                  <td className="py-6 text-gray-500" colSpan={3}>
                    No data for report.
                  </td>
                </tr>
              ) : (
                historySummary.rows.map((row) => (
                  <tr key={row.supplier} className="border-b last:border-b-0">
                    <td className="py-2 pr-3 font-medium">{row.supplier}</td>
                    <td className="py-2 pr-3">{row.qty}</td>
                    <td className="py-2 pr-3">{row.count}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
        </>
      )}
    </div>
  );
}
