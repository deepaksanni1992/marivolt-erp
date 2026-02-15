import { useEffect, useMemo, useState } from "react";
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import * as XLSX from "xlsx";
import { apiDelete, apiGet, apiPost, apiPut } from "../lib/api.js";

let headerImagePromise;
const TOP_MARGIN_MM = 38.1;
const TOP_LINE_HEIGHT_MM = 4;
const TOP_LINE_COUNT = 3;
const EXTRA_TOP_SPACE_MM = TOP_LINE_HEIGHT_MM * TOP_LINE_COUNT;
const HEADER_MARGIN_X = 14;
const HEADER_TOP_Y = 6;
const FOOTER_MARGIN_MM = 38.1;
const FOOTER_SAFE_GAP_MM = 6;
const FOOTER_MAX_LINES = 3;
const FOOTER_TEXT_LINE_HEIGHT_MM = 4;
const FOOTER_TEXT_HEIGHT_MM = (FOOTER_MAX_LINES - 1) * FOOTER_TEXT_LINE_HEIGHT_MM;
const FOOTER_RESERVED_MM = FOOTER_MARGIN_MM + FOOTER_TEXT_HEIGHT_MM + FOOTER_SAFE_GAP_MM;

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
              resolve({ dataUrl, width: img.naturalWidth, height: img.naturalHeight });
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
  return { x: HEADER_MARGIN_X, y: HEADER_TOP_Y, w: targetW, h: targetH };
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
    doc.addImage(header.dataUrl, "PNG", layout.x, layout.y, layout.w, layout.h);
  }
}

function addPdfFooter(doc) {
  const pageCount = doc.internal.getNumberOfPages();
  const leftLines = ["Marivolt FZE", "LV09B"];
  const centerLines = ["Hamriyah freezone phase 2, Sharjah, UAE"];
  const rightLines = ["Mob: +971-543053047", "Email: sales@marivolt.co", "Web: www.marivolt.co"];
  doc.setFontSize(8);
  for (let i = 1; i <= pageCount; i += 1) {
    doc.setPage(i);
    const pageHeight = doc.internal.pageSize.getHeight();
    const pageWidth = doc.internal.pageSize.getWidth();
    const baseY = pageHeight - FOOTER_MARGIN_MM - (FOOTER_MAX_LINES - 1) * 4;
    doc.text(leftLines[0], 14, baseY);
    doc.text(centerLines[0], pageWidth / 2, baseY, { align: "center" });
    doc.text(rightLines[0], pageWidth - 14, baseY, { align: "right" });
  }
}

function getTableMargins(topY, extra) {
  return { top: topY, bottom: FOOTER_RESERVED_MM, ...(extra || {}) };
}

function drawWrappedText(doc, header, text, startY, options = {}) {
  const { fontSize = 9, lineHeight = 4, maxWidth = 180 } = options;
  doc.setFontSize(fontSize);
  const topY = getContentStartY(doc, header);
  const pageHeight = doc.internal.pageSize.getHeight();
  const bottomY = pageHeight - FOOTER_RESERVED_MM;
  let y = startY;
  const lines = doc.splitTextToSize(text || "", maxWidth);
  for (const line of lines) {
    if (y + lineHeight > bottomY) {
      doc.addPage();
      y = topY;
    }
    doc.text(line, 14, y);
    y += lineHeight;
  }
  return y;
}

export default function Sales() {
  const [activeSub, setActiveSub] = useState("Customer Master");
  const [customers, setCustomers] = useState([]);
  const [customerErr, setCustomerErr] = useState("");
  const [customerLoading, setCustomerLoading] = useState(false);
  const [customerQuery, setCustomerQuery] = useState("");
  const [customerForm, setCustomerForm] = useState({
    name: "",
    contactName: "",
    phone: "",
    email: "",
    address: "",
    paymentTerms: "CREDIT",
    notes: "",
  });

  const [items, setItems] = useState([]);
  const [quotationItems, setQuotationItems] = useState([
    { sku: "", description: "", uom: "", qty: 1, unitPrice: 0 },
  ]);
  const [quotationForm, setQuotationForm] = useState({
    customerId: "",
    customerName: "",
    paymentTerms: "CREDIT",
    notes: "",
  });
  const [salesErr, setSalesErr] = useState("");
  const [salesLoading, setSalesLoading] = useState(false);

  const [quotationList, setQuotationList] = useState([]);
  const [ocList, setOcList] = useState([]);
  const [piList, setPiList] = useState([]);
  const [ptgList, setPtgList] = useState([]);
  const [invoiceList, setInvoiceList] = useState([]);
  const [ciplList, setCiplList] = useState([]);
  const [itemFilters, setItemFilters] = useState({
    vertical: "",
    engine: "",
    model: "",
    config: "",
    article: "",
  });

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

  async function loadCustomers() {
    setCustomerErr("");
    setCustomerLoading(true);
    try {
      const data = await apiGet("/sales/customers");
      setCustomers(data);
    } catch (e) {
      setCustomerErr(e.message || "Failed to load customers");
    } finally {
      setCustomerLoading(false);
    }
  }

  async function loadItems() {
    try {
      const data = await apiGet("/items");
      setItems(data);
    } catch {
      // ignore
    }
  }

  async function loadDocs(type, setState) {
    setSalesErr("");
    setSalesLoading(true);
    try {
      const data = await apiGet(`/sales/docs?type=${type}`);
      setState(data);
    } catch (e) {
      setSalesErr(e.message || "Failed to load sales docs");
    } finally {
      setSalesLoading(false);
    }
  }

  useEffect(() => {
    loadCustomers();
    loadItems();
    loadDocs("QUOTATION", setQuotationList);
    loadDocs("ORDER_CONFIRMATION", setOcList);
    loadDocs("PROFORMA_INVOICE", setPiList);
    loadDocs("PTG", setPtgList);
    loadDocs("INVOICE", setInvoiceList);
    loadDocs("CIPL", setCiplList);
  }, []);

  function onCustomerChange(e) {
    const { name, value } = e.target;
    setCustomerForm((p) => ({ ...p, [name]: value }));
  }

  function applyCustomer(id) {
    const customer = customers.find((c) => c._id === id);
    if (!customer) {
      setQuotationForm((p) => ({
        ...p,
        customerId: "",
        customerName: "",
        paymentTerms: "CREDIT",
      }));
      return;
    }
    setQuotationForm((p) => ({
      ...p,
      customerId: customer._id,
      customerName: customer.name,
      paymentTerms: customer.paymentTerms || "CREDIT",
    }));
  }

  function onQuotationChange(e) {
    const { name, value } = e.target;
    setQuotationForm((p) => ({ ...p, [name]: value }));
  }

  function onQuotationItemChange(index, field, value) {
    setQuotationItems((prev) =>
      prev.map((row, i) => {
        if (i !== index) return row;
        if (field === "sku") {
          const item = items.find((it) => it.sku === value);
          return {
            ...row,
            sku: value,
            description: item?.name || row.description,
            uom: item?.uom || row.uom,
          };
        }
        return { ...row, [field]: value };
      })
    );
  }

  function addQuotationItem() {
    setQuotationItems((prev) => [
      ...prev,
      { sku: "", description: "", uom: "", qty: 1, unitPrice: 0 },
    ]);
  }

  function removeQuotationItem(index) {
    setQuotationItems((prev) => prev.filter((_, i) => i !== index));
  }

  const quotationTotals = useMemo(() => {
    const subTotal = quotationItems.reduce((sum, row) => {
      const qty = Number(row.qty) || 0;
      const rate = Number(row.unitPrice) || 0;
      return sum + qty * rate;
    }, 0);
    return { subTotal, grandTotal: subTotal };
  }, [quotationItems]);

  function getItemCompatibilityStr(it) {
    if (!it) return "";
    const comp = it.compatibility?.length ? it.compatibility : (it.model != null || it.config != null ? [{ engine: it.engine, model: it.model, config: it.config }] : []);
    return comp.map((c) => [c.engine, c.model, c.config].filter(Boolean).join(" / ")).filter(Boolean).join("; ") || "";
  }

  const itemMatchesCompatibility = (it, model, config) => {
    const comp =
      it.compatibility?.length
        ? it.compatibility
        : it.model != null || it.config != null
          ? [{ model: it.model, config: it.config }]
          : [];
    if (model && !comp.some((c) => (c.model || "").trim() === model)) return false;
    if (config && !comp.some((c) => (c.config || "").trim() === config)) return false;
    return true;
  };
  const filteredItemsForFilters = useMemo(() => {
    return items.filter((it) => {
      if (itemFilters.vertical && (it.category || "") !== itemFilters.vertical) {
        return false;
      }
      if (itemFilters.engine && (it.engine || "") !== itemFilters.engine) {
        return false;
      }
      if (itemFilters.model && !itemMatchesCompatibility(it, itemFilters.model, null)) {
        return false;
      }
      if (itemFilters.config && !itemMatchesCompatibility(it, itemFilters.model, itemFilters.config)) {
        return false;
      }
      if (itemFilters.article && (it.article || "") !== itemFilters.article) {
        return false;
      }
      return true;
    });
  }, [items, itemFilters]);

  function uniqueSorted(values) {
    return Array.from(new Set(values.filter(Boolean))).sort();
  }

  const verticalOptions = useMemo(
    () => uniqueSorted(items.map((it) => it.category)),
    [items]
  );

  const engineOptions = useMemo(() => {
    const base = itemFilters.vertical
      ? items.filter((it) => (it.category || "") === itemFilters.vertical)
      : items;
    return uniqueSorted(base.map((it) => it.engine));
  }, [items, itemFilters.vertical]);

  const modelOptions = useMemo(() => {
    const base = items.filter((it) => {
      if (itemFilters.vertical && (it.category || "") !== itemFilters.vertical) {
        return false;
      }
      if (itemFilters.engine && (it.engine || "") !== itemFilters.engine) {
        return false;
      }
      return true;
    });
    return uniqueSorted(
      base.flatMap((it) => {
        const comp = it.compatibility?.length ? it.compatibility : it.model != null || it.config != null ? [{ model: it.model }] : [];
        return comp.map((c) => c.model);
      })
    );
  }, [items, itemFilters.vertical, itemFilters.engine]);

  const configOptions = useMemo(() => {
    const base = items.filter((it) => {
      if (itemFilters.vertical && (it.category || "") !== itemFilters.vertical) {
        return false;
      }
      if (itemFilters.engine && (it.engine || "") !== itemFilters.engine) {
        return false;
      }
      if (itemFilters.model && !itemMatchesCompatibility(it, itemFilters.model, null)) {
        return false;
      }
      return true;
    });
    return uniqueSorted(
      base.flatMap((it) => {
        const comp = it.compatibility?.length ? it.compatibility : it.model != null || it.config != null ? [{ model: it.model, config: it.config }] : [];
        return comp.filter((c) => (c.model || "").trim() === itemFilters.model).map((c) => c.config);
      })
    );
  }, [items, itemFilters.vertical, itemFilters.engine, itemFilters.model]);

  const articleOptions = useMemo(() => {
    const base = items.filter((it) => {
      if (itemFilters.vertical && (it.category || "") !== itemFilters.vertical) {
        return false;
      }
      if (itemFilters.engine && (it.engine || "") !== itemFilters.engine) {
        return false;
      }
      if (!itemMatchesCompatibility(it, itemFilters.model, itemFilters.config)) {
        return false;
      }
      return true;
    });
    return uniqueSorted(base.map((it) => it.article));
  }, [
    items,
    itemFilters.vertical,
    itemFilters.engine,
    itemFilters.model,
    itemFilters.config,
  ]);

  const filteredItemsForSku = useMemo(() => {
    if (
      !itemFilters.vertical &&
      !itemFilters.engine &&
      !itemFilters.model &&
      !itemFilters.config &&
      !itemFilters.article
    ) {
      return items;
    }
    return filteredItemsForFilters;
  }, [items, filteredItemsForFilters, itemFilters]);

  async function addCustomer(e) {
    e.preventDefault();
    setCustomerErr("");
    if (!customerForm.name.trim()) {
      setCustomerErr("Customer name is required.");
      return;
    }
    try {
      const created = await apiPost("/sales/customers", {
        ...customerForm,
        name: customerForm.name.trim(),
      });
      setCustomers((prev) => [created, ...prev]);
      setCustomerForm({
        name: "",
        contactName: "",
        phone: "",
        email: "",
        address: "",
        paymentTerms: "CREDIT",
        notes: "",
      });
    } catch (e2) {
      setCustomerErr(e2.message || "Failed to add customer");
    }
  }

  async function deleteCustomer(id) {
    const ok = confirm("Delete this customer?");
    if (!ok) return;
    setCustomerErr("");
    try {
      await apiDelete(`/sales/customers/${id}`);
      setCustomers((prev) => prev.filter((c) => c._id !== id));
    } catch (e) {
      setCustomerErr(e.message || "Failed to delete customer");
    }
  }

  async function createQuotation(saveStatus) {
    setSalesErr("");
    if (!quotationForm.customerName.trim()) {
      setSalesErr("Customer is required.");
      return;
    }
    if (!quotationItems.length) {
      setSalesErr("At least one item is required.");
      return;
    }
    const status = saveStatus === "FINAL" ? "FINAL" : "DRAFT";
    const itemsPayload = quotationItems.map((row) => ({
      sku: row.sku || "",
      description: row.description || "",
      uom: row.uom || "",
      qty: Number(row.qty) || 0,
      unitPrice: Number(row.unitPrice) || 0,
    }));
    try {
      const created = await apiPost("/sales/quotation", {
        ...quotationForm,
        status,
        items: itemsPayload,
        subTotal: quotationTotals.subTotal,
        grandTotal: quotationTotals.grandTotal,
      });
      setQuotationList((prev) => [created, ...prev]);
      setQuotationItems([{ sku: "", description: "", uom: "", qty: 1, unitPrice: 0 }]);
      setQuotationForm((p) => ({ ...p, notes: "" }));
      alert(`Quotation saved as ${status} ✅`);
    } catch (e) {
      setSalesErr(e.message || "Failed to create quotation");
    }
  }

  async function updateQuotationStatus(doc, newStatus) {
    setSalesErr("");
    try {
      const updated = await apiPut(`/sales/docs/${doc._id}`, { status: newStatus });
      setQuotationList((prev) =>
        prev.map((d) => (d._id === doc._id ? updated : d))
      );
      alert(`Quotation marked as ${newStatus} ✅`);
    } catch (e) {
      setSalesErr(e.message || "Failed to update status");
    }
  }

  async function printQuotationPdf(doc) {
    const header = await getHeaderImage();
    const pdf = new jsPDF({ format: "a4", unit: "mm" });
    pdf.setTextColor(0, 0, 0);
    const contentStartY = getContentStartY(pdf, header);
    pdf.setFontSize(16);
    pdf.text("Quotation", 150, contentStartY, { align: "right" });

    const customerInfo = [
      [doc.customerName || "-"],
      [`Payment Terms: ${doc.paymentTerms || "CREDIT"}`],
    ];
    autoTable(pdf, {
      startY: contentStartY + 6,
      margin: getTableMargins(contentStartY + 6),
      theme: "grid",
      body: customerInfo,
      styles: { fontSize: 10, cellPadding: 1 },
      tableWidth: 90,
    });

    const docInfo = [
      ["Doc No", doc.docNo || "-"],
      ["Date", doc.createdAt ? new Date(doc.createdAt).toLocaleDateString() : "-"],
      ["Status", doc.status || "DRAFT"],
    ];
    autoTable(pdf, {
      startY: contentStartY + 6,
      margin: getTableMargins(contentStartY + 6, { left: 110 }),
      body: docInfo,
      styles: { fontSize: 10, cellPadding: 1 },
      tableWidth: 80,
    });

    const itemRows = (doc.items || []).map((it, idx) => {
      const qty = Number(it.qty) || 0;
      const rate = Number(it.unitPrice) || 0;
      const total = (it.total != null ? Number(it.total) : qty * rate);
      const fullItem = items.find((i) => i.sku === it.sku);
      const compatStr = getItemCompatibilityStr(fullItem);
      return [
        String(idx + 1),
        it.sku || "-",
        compatStr || "-",
        it.description || "-",
        it.uom || "-",
        String(qty),
        rate ? rate.toFixed(2) : "0.00",
        total.toFixed(2),
      ];
    });
    autoTable(pdf, {
      startY: pdf.lastAutoTable.finalY + 6,
      margin: getTableMargins(contentStartY + 6),
      theme: "grid",
      head: [["Pos", "Article", "Compatibility", "Description", "UOM", "Qty", "Unit Price", "Total"]],
      body: itemRows,
      styles: { fontSize: 10 },
      headStyles: { fillColor: [230, 230, 230], textColor: 20 },
    });

    const subTotal = Number(doc.subTotal) || 0;
    const grandTotal = Number(doc.grandTotal) || 0;
    autoTable(pdf, {
      startY: pdf.lastAutoTable.finalY + 4,
      margin: getTableMargins(contentStartY + 6, { left: 130 }),
      theme: "grid",
      body: [
        ["Sub Total", subTotal.toFixed(2)],
        ["Grand Total", grandTotal.toFixed(2)],
      ],
      styles: { fontSize: 10 },
      tableWidth: 60,
    });

    if (doc.notes && String(doc.notes).trim()) {
      let notesY = pdf.lastAutoTable.finalY + 8;
      notesY = drawWrappedText(pdf, header, `Notes: ${doc.notes}`, notesY, {
        fontSize: 9,
        lineHeight: 4,
        maxWidth: 180,
      });
    }

    addPdfHeader(pdf, header);
    addPdfFooter(pdf);
    const safeName = (doc.customerName || "quotation").trim().replace(/\s+/g, "-").toLowerCase();
    pdf.save(`quotation-${doc.docNo || safeName}.pdf`);
  }

  async function convertDoc(doc, targetType) {
    setSalesErr("");
    try {
      const converted = await apiPost(`/sales/convert/${doc._id}`, {
        targetType,
      });
      if (targetType === "ORDER_CONFIRMATION") {
        setOcList((prev) => [converted, ...prev]);
      }
      if (targetType === "PROFORMA_INVOICE") {
        setPiList((prev) => [converted, ...prev]);
      }
      if (targetType === "PTG") {
        setPtgList((prev) => [converted, ...prev]);
      }
      if (targetType === "INVOICE") {
        setInvoiceList((prev) => [converted, ...prev]);
      }
      if (targetType === "CIPL") {
        setCiplList((prev) => [converted, ...prev]);
      }
      alert(`${targetType.replace(/_/g, " ")} created ✅`);
    } catch (e) {
      setSalesErr(e.message || "Failed to convert");
    }
  }

  const filteredCustomers = useMemo(() => {
    const q = customerQuery.trim().toLowerCase();
    if (!q) return customers;
    return customers.filter((c) =>
      [c.name, c.contactName, c.phone, c.email, c.address]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(q))
    );
  }, [customers, customerQuery]);

  function onItemFilterChange(field, value) {
    setItemFilters((prev) => {
      const next = { ...prev, [field]: value };
      if (field === "vertical") {
        next.engine = "";
        next.model = "";
        next.config = "";
        next.article = "";
      } else if (field === "engine") {
        next.model = "";
        next.config = "";
        next.article = "";
      } else if (field === "model") {
        next.config = "";
        next.article = "";
      } else if (field === "config") {
        next.article = "";
      }
      return next;
    });
  }

  function exportQuotationItemsCsv() {
    const rows = [
      ["SKU", "Description", "UOM", "Qty", "Unit Price"],
      ...quotationItems.map((row) => [
        row.sku || "",
        row.description || "",
        row.uom || "",
        Number(row.qty) || 0,
        Number(row.unitPrice) || 0,
      ]),
    ];
    downloadCsv("quotation-items.csv", rows);
  }

  async function handleQuotationExcelImport(file) {
    if (!file) return;
    setSalesErr("");
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
        const rawSku =
          row.sku ||
          row.partno ||
          row.partnumber ||
          row.article ||
          row.articleno ||
          "";
        const matchedItem = items.find((it) => it.sku === String(rawSku || "").trim());
        const description =
          row.description ||
          row.itemname ||
          row.name ||
          matchedItem?.description ||
          matchedItem?.name ||
          "";
        const uom = row.uom || row.unit || matchedItem?.uom || "";
        const qty = row.qty || row.quantity || row.q || 1;
        const unitPrice = row.unitprice || row.rate || row.price || 0;

        return {
          sku: String(rawSku || "").trim(),
          description: String(description || "").trim(),
          uom: String(uom || "").trim(),
          qty: Number(qty) || 0,
          unitPrice: Number(unitPrice) || 0,
        };
      });

      const filtered = itemsFromExcel.filter(
        (row) => row.sku || row.description || row.qty
      );
      if (!filtered.length) {
        setSalesErr("Excel import has no valid quotation item rows.");
        return;
      }

      setQuotationItems(filtered);
    } catch (e) {
      setSalesErr(e.message || "Failed to import quotation Excel file.");
    }
  }

  function exportQuotationsCsv(options = { pendingOnly: false }) {
    const rows = [
      ["Doc No", "Date", "Customer", "Terms", "Total", "Status", "Notes"],
      ...quotationList
        .filter((doc) => {
          if (!options.pendingOnly) return true;
          const status = doc.status || "OPEN";
          // Pending = saved quotations which are not yet converted
          // Include legacy OPEN and new FINAL, exclude DRAFT and CONVERTED
          return status === "OPEN" || status === "FINAL";
        })
        .map((doc) => [
          doc.docNo || "",
          doc.createdAt
            ? new Date(doc.createdAt).toLocaleDateString()
            : "",
          doc.customerName || "",
          doc.paymentTerms || "",
          Number(doc.grandTotal || 0).toFixed(2),
          doc.status || "OPEN",
          doc.notes || "",
        ]),
    ];
    const filename = options.pendingOnly
      ? "pending-quotations.csv"
      : "quotations.csv";
    downloadCsv(filename, rows);
  }

  function exportCustomersCsv() {
    const rows = [
      [
        "Name",
        "Contact Name",
        "Phone",
        "Email",
        "Address",
        "Payment Terms",
        "Notes",
      ],
      ...filteredCustomers.map((c) => [
        c.name || "",
        c.contactName || "",
        c.phone || "",
        c.email || "",
        c.address || "",
        c.paymentTerms || "",
        c.notes || "",
      ]),
    ];
    downloadCsv("customers.csv", rows);
  }

  async function handleCustomerImport(file) {
    if (!file) return;
    setCustomerErr("");
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

      const customersFromExcel = normalized.map((row) => {
        const name =
          row.name || row.customer || row.customername || row.company || "";
        const contactName =
          row.contactname || row.contactperson || row.contact || "";
        const phone = row.phone || row.mobile || row.tel || "";
        const email = row.email || "";
        const address = row.address || "";
        const rawTerms = String(row.paymentterms || row.terms || "").toUpperCase();
        const paymentTerms = rawTerms.includes("ADV") ? "ADVANCE" : "CREDIT";
        const notes = row.notes || row.note || "";

        return {
          name: String(name || "").trim(),
          contactName: String(contactName || "").trim(),
          phone: String(phone || "").trim(),
          email: String(email || "").trim(),
          address: String(address || "").trim(),
          paymentTerms,
          notes: String(notes || "").trim(),
        };
      });

      const filtered = customersFromExcel.filter((row) => row.name);
      if (!filtered.length) {
        setCustomerErr("Excel import has no valid customer rows.");
        return;
      }

      const results = await Promise.allSettled(
        filtered.map((row) => apiPost("/sales/customers", row))
      );
      const created = results.filter((r) => r.status === "fulfilled").length;
      const failed = results.length - created;
      if (failed) {
        setCustomerErr(
          `Imported ${created} customers. ${failed} failed (duplicates or invalid).`
        );
      } else {
        setCustomerErr(`Imported ${created} customers successfully.`);
      }
      await loadCustomers();
    } catch (e) {
      setCustomerErr(e.message || "Failed to import customers.");
    }
  }

  const subModules = [
    "Customer Master",
    "Quotation",
    "Order Confirmation",
    "Proforma Invoice",
    "PTG",
    "Invoice",
    "CIPL",
  ];

  function renderDocTable(rows, actions) {
    return (
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="border-b text-gray-600">
            <tr>
              <th className="py-2 pr-3">Doc No</th>
              <th className="py-2 pr-3">Customer</th>
              <th className="py-2 pr-3">Terms</th>
              <th className="py-2 pr-3">Total</th>
              <th className="py-2 pr-3">Status</th>
              <th className="py-2 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td className="py-6 text-gray-500" colSpan={6}>
                  No records.
                </td>
              </tr>
            ) : (
              rows.map((doc) => (
                <tr key={doc._id} className="border-b last:border-b-0">
                  <td className="py-2 pr-3 font-medium">{doc.docNo}</td>
                  <td className="py-2 pr-3">{doc.customerName}</td>
                  <td className="py-2 pr-3">{doc.paymentTerms || "-"}</td>
                  <td className="py-2 pr-3">
                    {Number(doc.grandTotal || 0).toFixed(2)}
                  </td>
                  <td className="py-2 pr-3">{doc.status || "OPEN"}</td>
                  <td className="py-2 text-right">
                    <div className="flex items-center justify-end gap-2">
                      {actions(doc)}
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    );
  }

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

      {customerErr && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {customerErr}
        </div>
      )}
      {salesErr && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {salesErr}
        </div>
      )}

      {activeSub === "Customer Master" && (
        <div className="grid gap-6 lg:grid-cols-3">
          <div className="rounded-2xl border bg-white p-6">
            <h3 className="text-base font-semibold">Add Customer</h3>
            <form onSubmit={addCustomer} className="mt-4 space-y-3">
              <div>
                <label className="text-sm text-gray-600">Name *</label>
                <input
                  name="name"
                  value={customerForm.name}
                  onChange={onCustomerChange}
                  className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="text-sm text-gray-600">Contact Name</label>
                <input
                  name="contactName"
                  value={customerForm.contactName}
                  onChange={onCustomerChange}
                  className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="text-sm text-gray-600">Phone</label>
                <input
                  name="phone"
                  value={customerForm.phone}
                  onChange={onCustomerChange}
                  className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="text-sm text-gray-600">Email</label>
                <input
                  name="email"
                  value={customerForm.email}
                  onChange={onCustomerChange}
                  className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="text-sm text-gray-600">Address</label>
                <input
                  name="address"
                  value={customerForm.address}
                  onChange={onCustomerChange}
                  className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="text-sm text-gray-600">Payment Terms</label>
                <select
                  name="paymentTerms"
                  value={customerForm.paymentTerms}
                  onChange={onCustomerChange}
                  className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
                >
                  <option value="CREDIT">Credit</option>
                  <option value="ADVANCE">Advance</option>
                </select>
              </div>
              <div>
                <label className="text-sm text-gray-600">Notes</label>
                <input
                  name="notes"
                  value={customerForm.notes}
                  onChange={onCustomerChange}
                  className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
                />
              </div>
              <button className="w-full rounded-xl bg-gray-900 px-4 py-2 text-sm font-semibold text-white">
                + Add Customer
              </button>
            </form>
          </div>

          <div className="rounded-2xl border bg-white p-6 lg:col-span-2">
            <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
              <h3 className="text-base font-semibold">Customers</h3>
              <div className="flex flex-col gap-2 md:flex-row md:items-center">
                <div className="flex gap-2">
                  <input
                    value={customerQuery}
                    onChange={(e) => setCustomerQuery(e.target.value)}
                    className="w-full md:w-80 rounded-xl border px-3 py-2 text-sm"
                    placeholder="Search customers..."
                  />
                  <button
                    onClick={loadCustomers}
                    className="rounded-xl border px-3 py-2 text-sm hover:bg-gray-50"
                  >
                    Refresh
                  </button>
                </div>
                <div className="flex gap-2 md:ml-2">
                  <button
                    onClick={exportCustomersCsv}
                    className="rounded-xl border px-3 py-2 text-sm hover:bg-gray-50"
                  >
                    Export
                  </button>
                  <label className="inline-flex cursor-pointer items-center rounded-xl border px-3 py-2 text-sm hover:bg-gray-50">
                    <span>Import Excel</span>
                    <input
                      type="file"
                      accept=".xlsx,.xls,.csv"
                      onChange={(e) => handleCustomerImport(e.target.files?.[0])}
                      className="hidden"
                    />
                  </label>
                </div>
              </div>
            </div>
            <div className="mt-4">
              {customerLoading ? (
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
                        <th className="py-2 pr-3">Terms</th>
                        <th className="py-2 pr-3">Address</th>
                        <th className="py-2"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredCustomers.length === 0 ? (
                        <tr>
                          <td className="py-6 text-gray-500" colSpan={7}>
                            No customers yet.
                          </td>
                        </tr>
                      ) : (
                        filteredCustomers.map((c) => (
                          <tr key={c._id} className="border-b last:border-b-0">
                            <td className="py-2 pr-3 font-medium">{c.name}</td>
                            <td className="py-2 pr-3">{c.contactName || "-"}</td>
                            <td className="py-2 pr-3">{c.phone || "-"}</td>
                            <td className="py-2 pr-3">{c.email || "-"}</td>
                            <td className="py-2 pr-3">{c.paymentTerms || "-"}</td>
                            <td className="py-2 pr-3">{c.address || "-"}</td>
                            <td className="py-2 text-right">
                              <button
                                onClick={() => deleteCustomer(c._id)}
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
      )}

      {activeSub === "Quotation" && (
        <div className="space-y-6">
          <div className="rounded-2xl border bg-white p-6">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold">Create Quotation</h2>
              <button
                onClick={() => loadDocs("QUOTATION", setQuotationList)}
                className="rounded-xl border px-3 py-2 text-sm hover:bg-gray-50"
              >
                Refresh
              </button>
            </div>
            <div className="mt-4 grid gap-4 lg:grid-cols-3">
              <div className="lg:col-span-1 space-y-3">
                <div>
                  <label className="text-sm text-gray-600">Customer</label>
                  <select
                    value={quotationForm.customerId}
                    onChange={(e) => applyCustomer(e.target.value)}
                    className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
                  >
                    <option value="">Select customer...</option>
                    {customers.map((c) => (
                      <option key={c._id} value={c._id}>
                        {c.name} • {c.paymentTerms}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="text-sm text-gray-600">Notes</label>
                  <textarea
                    name="notes"
                    value={quotationForm.notes}
                    onChange={onQuotationChange}
                    rows={3}
                    className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
                  />
                </div>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => createQuotation("DRAFT")}
                    className="flex-1 rounded-xl border border-gray-300 px-4 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50"
                  >
                    Save as Draft
                  </button>
                  <button
                    type="button"
                    onClick={() => createQuotation("FINAL")}
                    className="flex-1 rounded-xl bg-gray-900 px-4 py-2 text-sm font-semibold text-white"
                  >
                    Save as Final
                  </button>
                </div>
              </div>

              <div className="lg:col-span-2">
                <div className="mb-3 grid gap-2 md:grid-cols-4">
                  <div>
                    <label className="text-xs text-gray-600">Vertical</label>
                    <select
                      value={itemFilters.vertical}
                      onChange={(e) =>
                        onItemFilterChange("vertical", e.target.value)
                      }
                      className="mt-1 w-full rounded-lg border px-2 py-1 text-xs"
                    >
                      <option value="">All</option>
                      {verticalOptions.map((v) => (
                        <option key={v} value={v}>
                          {v}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="text-xs text-gray-600">Engine</label>
                    <select
                      value={itemFilters.engine}
                      onChange={(e) => onItemFilterChange("engine", e.target.value)}
                      className="mt-1 w-full rounded-lg border px-2 py-1 text-xs"
                    >
                      <option value="">All</option>
                      {engineOptions.map((v) => (
                        <option key={v} value={v}>
                          {v}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="text-xs text-gray-600">Model</label>
                    <select
                      value={itemFilters.model}
                      onChange={(e) => onItemFilterChange("model", e.target.value)}
                      className="mt-1 w-full rounded-lg border px-2 py-1 text-xs"
                    >
                      <option value="">All</option>
                      {modelOptions.map((v) => (
                        <option key={v} value={v}>
                          {v}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="text-xs text-gray-600">Config</label>
                    <select
                      value={itemFilters.config}
                      onChange={(e) => onItemFilterChange("config", e.target.value)}
                      className="mt-1 w-full rounded-lg border px-2 py-1 text-xs"
                    >
                      <option value="">All</option>
                      {configOptions.map((v) => (
                        <option key={v} value={v}>
                          {v}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
                <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
                  <h3 className="text-sm font-semibold text-gray-700">Items</h3>
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      onClick={addQuotationItem}
                      className="rounded-lg border px-3 py-1 text-xs hover:bg-gray-50"
                    >
                      + Add Line
                    </button>
                    <button
                      onClick={exportQuotationItemsCsv}
                      className="rounded-lg border px-3 py-1 text-xs hover:bg-gray-50"
                    >
                      Export Items
                    </button>
                    <label className="inline-flex cursor-pointer items-center rounded-lg border px-3 py-1 text-xs hover:bg-gray-50">
                      <span>Import Excel</span>
                      <input
                        type="file"
                        accept=".xlsx,.xls,.csv"
                        onChange={(e) =>
                          handleQuotationExcelImport(e.target.files?.[0])
                        }
                        className="hidden"
                      />
                    </label>
                  </div>
                </div>
                <div className="mt-3 overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead className="border-b text-gray-600">
                      <tr>
                        <th className="py-2 pr-3">Article</th>
                        <th className="py-2 pr-3">Compatibility</th>
                        <th className="py-2 pr-3">Description</th>
                        <th className="py-2 pr-3">UOM</th>
                        <th className="py-2 pr-3">Qty</th>
                        <th className="py-2 pr-3">Unit Price</th>
                        <th className="py-2 pr-3">Total</th>
                        <th className="py-2"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {quotationItems.map((row, idx) => {
                        const qty = Number(row.qty) || 0;
                        const rate = Number(row.unitPrice) || 0;
                        return (
                          <tr key={idx} className="border-b last:border-b-0">
                            <td className="py-2 pr-3">
                              <select
                                value={row.sku}
                                onChange={(e) =>
                                  onQuotationItemChange(idx, "sku", e.target.value)
                                }
                                className="w-32 rounded-lg border px-2 py-1 text-xs"
                              >
                                <option value="">Select article...</option>
                                {filteredItemsForSku.map((it) => (
                                  <option key={it._id} value={it.sku}>
                                    {it.article || it.sku}
                                  </option>
                                ))}
                              </select>
                            </td>
                            <td className="max-w-[280px] py-2 pr-3 text-gray-600" title={getItemCompatibilityStr(items.find((it) => it.sku === row.sku))}>
                              {getItemCompatibilityStr(items.find((it) => it.sku === row.sku)) || "-"}
                            </td>
                            <td className="py-2 pr-3">
                              <input
                                value={row.description}
                                onChange={(e) =>
                                  onQuotationItemChange(
                                    idx,
                                    "description",
                                    e.target.value
                                  )
                                }
                                className="w-40 rounded-lg border px-2 py-1 text-xs"
                              />
                            </td>
                            <td className="py-2 pr-3">
                              <input
                                value={row.uom}
                                onChange={(e) =>
                                  onQuotationItemChange(idx, "uom", e.target.value)
                                }
                                className="w-16 rounded-lg border px-2 py-1 text-xs"
                              />
                            </td>
                            <td className="py-2 pr-3">
                              <input
                                type="number"
                                min="0"
                                value={row.qty}
                                onChange={(e) =>
                                  onQuotationItemChange(idx, "qty", e.target.value)
                                }
                                className="w-20 rounded-lg border px-2 py-1 text-xs"
                              />
                            </td>
                            <td className="py-2 pr-3">
                              <input
                                type="number"
                                min="0"
                                value={row.unitPrice}
                                onChange={(e) =>
                                  onQuotationItemChange(
                                    idx,
                                    "unitPrice",
                                    e.target.value
                                  )
                                }
                                className="w-24 rounded-lg border px-2 py-1 text-xs"
                              />
                            </td>
                            <td className="py-2 pr-3">
                              {(qty * rate).toFixed(2)}
                            </td>
                            <td className="py-2 text-right">
                              {quotationItems.length > 1 && (
                                <button
                                  onClick={() => removeQuotationItem(idx)}
                                  className="rounded-lg border px-2 py-1 text-[11px] hover:bg-gray-50"
                                >
                                  Remove
                                </button>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <div className="mt-3 text-xs text-gray-600">
                  Sub Total: {quotationTotals.subTotal.toFixed(2)} • Grand Total:{" "}
                  {quotationTotals.grandTotal.toFixed(2)}
                </div>
              </div>
            </div>
          </div>

          <div className="rounded-2xl border bg-white p-6 space-y-3">
            <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
              <h2 className="text-base font-semibold">Quotations</h2>
              <div className="flex flex-wrap gap-2">
                <button
                  onClick={() => exportQuotationsCsv({ pendingOnly: false })}
                  className="rounded-xl border px-3 py-2 text-xs hover:bg-gray-50"
                >
                  Quotation Report
                </button>
                <button
                  onClick={() => exportQuotationsCsv({ pendingOnly: true })}
                  className="rounded-xl border px-3 py-2 text-xs hover:bg-gray-50"
                >
                  Pending Quotation Report
                </button>
              </div>
            </div>
            {renderDocTable(quotationList, (doc) => (
              <div className="flex items-center justify-end gap-2">
                <button
                  onClick={() => printQuotationPdf(doc)}
                  className="rounded-lg border px-3 py-1 text-xs hover:bg-gray-50"
                >
                  Print
                </button>
                {(doc.status || "DRAFT") === "DRAFT" && (
                  <button
                    onClick={() => updateQuotationStatus(doc, "FINAL")}
                    className="rounded-lg border px-3 py-1 text-xs hover:bg-gray-50"
                  >
                    Mark as Final
                  </button>
                )}
                <button
                  onClick={() => convertDoc(doc, "ORDER_CONFIRMATION")}
                  className="rounded-lg border px-3 py-1 text-xs hover:bg-gray-50"
                >
                  Order Confirmation
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {activeSub === "Order Confirmation" && (
        <div className="rounded-2xl border bg-white p-6 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold">Order Confirmations</h2>
            <button
              onClick={() => loadDocs("ORDER_CONFIRMATION", setOcList)}
              className="rounded-xl border px-3 py-2 text-sm hover:bg-gray-50"
            >
              Refresh
            </button>
          </div>
          {renderDocTable(ocList, (doc) =>
            doc.paymentTerms === "ADVANCE" ? (
              <button
                onClick={() => convertDoc(doc, "PROFORMA_INVOICE")}
                className="rounded-lg border px-3 py-1 text-xs hover:bg-gray-50"
              >
                Proforma Invoice
              </button>
            ) : (
              <button
                onClick={() => convertDoc(doc, "PTG")}
                className="rounded-lg border px-3 py-1 text-xs hover:bg-gray-50"
              >
                Send to PTG
              </button>
            )
          )}
        </div>
      )}

      {activeSub === "Proforma Invoice" && (
        <div className="rounded-2xl border bg-white p-6 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold">Proforma Invoices</h2>
            <button
              onClick={() => loadDocs("PROFORMA_INVOICE", setPiList)}
              className="rounded-xl border px-3 py-2 text-sm hover:bg-gray-50"
            >
              Refresh
            </button>
          </div>
          {renderDocTable(piList, (doc) => (
            <button
              onClick={() => convertDoc(doc, "PTG")}
              className="rounded-lg border px-3 py-1 text-xs hover:bg-gray-50"
            >
              Send to PTG
            </button>
          ))}
        </div>
      )}

      {activeSub === "PTG" && (
        <div className="rounded-2xl border bg-white p-6 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold">PTG</h2>
            <button
              onClick={() => loadDocs("PTG", setPtgList)}
              className="rounded-xl border px-3 py-2 text-sm hover:bg-gray-50"
            >
              Refresh
            </button>
          </div>
          {renderDocTable(ptgList, (doc) => (
            <button
              onClick={() => convertDoc(doc, "INVOICE")}
              className="rounded-lg border px-3 py-1 text-xs hover:bg-gray-50"
            >
              Create Invoice
            </button>
          ))}
          <div className="text-xs text-gray-500">
            PTG packing dimensions are managed in Store → PTG.
          </div>
        </div>
      )}

      {activeSub === "Invoice" && (
        <div className="rounded-2xl border bg-white p-6 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold">Invoices</h2>
            <button
              onClick={() => loadDocs("INVOICE", setInvoiceList)}
              className="rounded-xl border px-3 py-2 text-sm hover:bg-gray-50"
            >
              Refresh
            </button>
          </div>
          {renderDocTable(invoiceList, (doc) => (
            <button
              onClick={() => convertDoc(doc, "CIPL")}
              className="rounded-lg border px-3 py-1 text-xs hover:bg-gray-50"
            >
              Create CIPL
            </button>
          ))}
        </div>
      )}

      {activeSub === "CIPL" && (
        <div className="rounded-2xl border bg-white p-6 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold">CIPL</h2>
            <button
              onClick={() => loadDocs("CIPL", setCiplList)}
              className="rounded-xl border px-3 py-2 text-sm hover:bg-gray-50"
            >
              Refresh
            </button>
          </div>
          {renderDocTable(ciplList, () => null)}
        </div>
      )}

      {salesLoading && (
        <div className="text-sm text-gray-500">Loading...</div>
      )}
    </div>
  );
}
